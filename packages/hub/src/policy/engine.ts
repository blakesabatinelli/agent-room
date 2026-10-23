import { randomBytes } from "node:crypto";
import { TOOLS, type AgentConfig, type Approval, type LeaseView, type PolicyRuleView, type PolicyState, type ServerEvent } from "@agent-room/shared";
import type { Attention } from "../attention/gate.js";
import { dayKey } from "../attention/time.js";
import type { ControlFolder } from "../control/folder.js";
import { checkFile } from "../control/lint.js";
import { scopeApplies } from "../control/permissions.js";
import { expiryMs, isRealDate, isRealInstant, type PolicyRule } from "../control/schema.js";
import type { Store } from "../db/store.js";
import type { Approvals } from "../orchestrator/approvals.js";
import type { RoomRules } from "../rooms/rules.js";
import { id, now } from "../util.js";
import { POLICY_SOFT_CAP, addRules, describeRule, lineFor, patchRule, removeRules, type RuleOut } from "./file.js";
import { FORGET_DAYS, LEARN_DEFAULTS, describeProposal, learn, type LearnConfig, type Proposal } from "./learn.js";
import { couldHideBehindCut, matches, parseMatch } from "./match.js";
import { desiredLevel } from "../control/storemap.js";
import { parsedInput } from "../twokey/classify.js";
import { shapeOf, twoKeyClass, verbOf } from "./shape.js";

/**
 * 4.2 The learned approval policy and permission leases.
 *
 *  - `policyDecision` answers, for one request, what the owner's accepted rules in POLICY.md say: allow, ask, deny, or none.
 *    Rules are read from the loaded file at the moment of the request, so an edit in an editor changes the next answer.
 *  - `gate` is the one call the approval path makes (Orchestrator.requestApproval). A deny refuses (audited), an allow is recorded like
 *    an auto-approval, an ask shows the card even for an agent that runs without asking, and none leaves things as they were. Layers
 *    only tighten: an allow is ignored when the agent's tool switch is off, when ROOM.md says off or ask, or when the action is one the
 *    two-key check (4.1) owns and that check has not passed.
 *  - Learning: the owner's own approvals and rejections become proposed rules (learn.ts), written unaccepted, at most one batch a day.
 *  - Leases: allow rules with a UTC `expires` and, optionally, a goal. A timer and the goal's end remove them.
 */

export type Effect = "allow" | "ask" | "deny" | "none";
export interface Decision { effect: Effect; rule?: PolicyRule; /** An allow for an action the two-key check owns. */ twoKey?: boolean }

export interface PolicyHost {
  store: Store;
  approvals: Pick<Approvals, "auto" | "request" | "onDecided">;
  control: () => ControlFolder | undefined;
  rooms: Pick<RoomRules, "says" | "level">;
  attention: Pick<Attention, "notify" | "settings">;
}

/** What the hub remembers about a lease (KV `policy_leases`, the mirror of its rule in POLICY.md). */
export interface Lease {
  id: string;
  agentId: string;
  tool: string;
  action: string;
  match: string;
  scope: string;
  roomId?: string;
  goalId?: string;
  createdAt: number;
  expiresAt: number;
  /** A goal-only lease has no time of its own; it gets this ceiling so it can never outlive its goal by much. */
  capped?: boolean;
  switchedOn?: boolean;
  /** A lease that switched a tool on does not apply until the switch is seen to have stuck (the control folder may turn it straight back off). */
  pending?: boolean;
  by: string;
}

/** `noRoom`: the lease is for requests that have no room (granted from an approval that had none); without it, no room means any room. */
export interface LeaseInput { agentId: string; tool: string; minutes?: number; goalId?: string; roomId?: string; noRoom?: boolean; action?: string; by?: string }
export type Fail = { ok: false; status: number; error: string };
export type LeaseResult = { ok: true; lease: LeaseView; notes: string[] } | Fail;

const LEASES_KEY = "policy_leases";
const LEARN_KEY = "policy_learn";
export const MAX_LEASE_MINUTES = 7 * 24 * 60;
/** A lease for "this goal" lasts until the goal ends, and never more than this. */
export const GOAL_LEASE_CEILING_MS = 24 * 3_600_000;
const MAX_BATCH = 5;
const MAX_PENDING = 10;
const ENDED = new Set(["done", "failed", "superseded"]);
const fail = (status: number, error: string): Fail => ({ ok: false, status, error });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

interface LearnState {
  /** The local day of the last batch that proposed anything. */
  lastBatch?: string;
  /** Every rule the hub proposed that is still in POLICY.md: id -> when it was proposed. */
  known: Record<string, number>;
  /** Proposals the owner turned down (deleted): id -> when they may be proposed again. */
  forgotten: Record<string, number>;
}

export class PolicyEngine {
  /** The time. Tests swap it for a fake clock. */
  clock: () => number = () => Date.now();
  config: LearnConfig = { ...LEARN_DEFAULTS };
  private chain: Promise<unknown> = Promise.resolve();
  private watching?: ControlFolder;
  private unwatch?: () => void;
  private started = false;
  private sweepTimer?: NodeJS.Timeout;
  private learnTimer?: NodeJS.Timeout;
  private soon?: NodeJS.Timeout;

  constructor(private host: PolicyHost) {
    host.store.on("event", this.onEvent);
    host.approvals.onDecided((a) => { if (this.started && !a.auto && !a.question && !a.proposalId && (a.status === "approved" || a.status === "rejected")) this.learnSoon(); });
  }

  private get store() { return this.host.store; }
  private today() { return new Date(this.clock()).toISOString().slice(0, 10); }
  private zone() { return this.host.attention.settings().timezone; }

  /** Run jobs one at a time, so file edits, lease changes and learning never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }
  /** Resolves when every queued job is done. */
  async idle(): Promise<void> {
    let q: Promise<unknown>;
    do { q = this.chain; await q; } while (q !== this.chain);
  }

  // ---------------------------------------------------------------- timers

  /** Begin the 30-second sweep for expired leases, the learning timer and learning after each answer. Call once, from main.ts. */
  start() {
    if (this.started) return;
    this.started = true;
    this.sweepTimer = setInterval(() => { void this.sweep().catch(() => undefined); }, 30_000);
    this.learnTimer = setInterval(() => { void this.learn().catch(() => undefined); }, 20 * 60_000);
    this.sweepTimer.unref(); this.learnTimer.unref();
    void this.sweep().catch(() => undefined);
    void this.learn().catch(() => undefined);
  }
  stop() {
    this.started = false;
    clearInterval(this.sweepTimer); clearInterval(this.learnTimer); clearTimeout(this.soon);
    this.unwatch?.(); this.unwatch = undefined; this.watching = undefined;
  }
  private learnSoon() {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => { void this.learn().catch(() => undefined); }, 1500);
    this.soon.unref?.();
  }

  // ---------------------------------------------------------------- reading the file

  /** Look at the control folder this engine is told about; notice rules that vanish from POLICY.md whenever it loads. */
  private control(): ControlFolder | undefined {
    const c = this.host.control();
    if (c && c !== this.watching) {
      this.unwatch?.();
      this.watching = c;
      this.unwatch = c.onLoad(() => this.noticeFileChanges());
      queueMicrotask(() => this.noticeFileChanges());
    }
    return c;
  }
  private fileRules(): PolicyRule[] { return this.control()?.snapshot().policy?.fm.rules ?? []; }
  private fileBody(): string { return this.control()?.snapshot().policy?.body ?? ""; }

  // ---------------------------------------------------------------- the decision

  /** What the owner's accepted rules say about one request. Never throws; a request nothing covers is "none". */
  evaluate(agentId: string, roomId: string | undefined, goalId: string | undefined, tool: string, action: string, detail: string, input?: unknown): Decision {
    const c = this.control();
    const rules = this.fileRules();
    if (!rules.length) return { effect: "none" };
    const slug = roomId ? c?.slugFor(roomId) : undefined;
    const shape = shapeOf(tool, action, detail, input);
    const t = this.clock();
    let allow: PolicyRule | undefined, ask: PolicyRule | undefined, deny: PolicyRule | undefined, maybe: PolicyRule | undefined;
    let pendingLeases: Set<string> | undefined; // leases waiting for their tool switch to be confirmed (read once, and only if a lease rule is met)
    for (const r of rules) {
      if (!r.accepted || (r.expires && t >= expiryMs(r.expires))) continue;
      if (r.tool !== tool && r.tool !== "*") continue;
      if (!scopeApplies(r.scope, agentId, slug, goalId, { id: roomId })) continue;
      if (r.id.startsWith("lease-") && (pendingLeases ??= new Set(this.kvLeases().filter((l) => l.pending).map((l) => l.id))).has(r.id)) continue;
      const pm = parseMatch(r.match);
      if (!pm.ok) continue;
      // A rule for the whole tool is the permission layers' business (POLICY.md levels, TOOLS.md, ROOM.md). Counting an allow here would
      // let it loosen what a narrower layer asked for. Only a rule tied to one goal (which those layers can't see) is read in full.
      if (r.effect === "allow" && pm.all && !/(^|\s)goal:/.test(r.scope)) continue;
      // A request cut short (and no whole input to read) may hide what a rule talks about: never allow it, and let a rule that would hold it back ask.
      if (r.effect === "allow" && shape.truncated) continue;
      if (!matches(pm, shape, action, r.effect === "allow")) { if (shape.truncated && r.effect !== "allow" && couldHideBehindCut(pm, shape, action)) maybe ??= r; continue; }
      if (r.effect === "deny") deny ??= r; else if (r.effect === "ask") ask ??= r; else if (!allow || (r.id.startsWith("lease-") && !allow.id.startsWith("lease-"))) allow = r; // a lease reaches further than a rule (see gate)
    }
    if (deny) return { effect: "deny", rule: deny };
    if (ask) return { effect: "ask", rule: ask };
    if (maybe) return { effect: "ask", rule: maybe }; // fail toward ask
    if (allow) return { effect: "allow", rule: allow, twoKey: twoKeyClass(tool, action, parsedInput(detail, input) ?? input ?? detail) };
    return { effect: "none" };
  }

  /** `allow | ask | deny | none` for one request, from the accepted rules (owner's and learned) that apply to this agent, room and goal. */
  policyDecision(agentId: string, roomId: string | undefined, goalId: string | undefined, tool: string, action: string, detail: string, input?: unknown): Effect {
    return this.evaluate(agentId, roomId, goalId, tool, action, detail, input).effect;
  }

  /**
   * The approval path's one call. Returns the answer when policy settles it (a refusal, an auto-approval, or a card the owner must see)
   * and undefined when it has nothing to say, so the caller carries on as before.
   * `twoKeyPassed`: the two-key check (4.1) has run for this action and the drafts matched; only then may an allow cover its classes.
   */
  gate(grant: { agentId: string; roomId?: string; taskId?: string }, agent: AgentConfig | undefined, p: { agentId: string; roomId?: string; tool: string; action: string; detail: string }, o: { twoKeyPassed?: boolean; input?: unknown } = {}): Promise<Approval> | undefined {
    let d: Decision;
    try { d = this.evaluate(grant.agentId, grant.roomId, grant.taskId ? this.store.getTask(grant.taskId)?.goalId : undefined, p.tool, p.action, p.detail, o.input); } catch { return undefined; }
    if (d.effect === "none") return undefined;
    const why = `${p.tool}: ${p.action}`.slice(0, 200);
    if (d.effect === "deny") {
      this.store.audit(p.agentId, "policy.denied", `${why} (rule ${d.rule!.id})`);
      return Promise.resolve({ id: id("apr"), ...p, detail: "", status: "rejected", createdAt: now(), decidedAt: now() });
    }
    if (d.effect === "ask") {
      if (agent?.tools?.[p.tool] && agent.autoApprove?.[p.tool]) this.store.audit(p.agentId, "policy.asked", `${why} (rule ${d.rule!.id}) asks first although ${agent.name} runs it without asking`);
      return this.host.approvals.request(p);
    }
    // allow: never wider than the layers above it
    const roomSays = this.host.rooms.says(grant.roomId, p.tool);
    if (agent?.tools?.[p.tool] !== true || (roomSays !== undefined && roomSays !== "on") || this.host.rooms.level(grant.agentId, grant.roomId, p.tool) === "off") return undefined;
    // An "ask" the owner wrote is never carved out by a rule: ask beats on (CONTROL.md section 3). Only the catalog's own default ask can be.
    // A lease is the owner saying "don't ask me for this, for a while": it may skip the agent's "asks first" (TOOLS.md room_allows, synced
    // from the app), the same way it may switch the tool on. A room's ROOM.md "ask" still wins over a lease.
    if (this.ownerAsks(grant.agentId, grant.roomId, p.tool, agent, d.rule!.id.startsWith("lease-"))) return undefined;
    if (d.twoKey && !o.twoKeyPassed) return undefined;
    const a = this.host.approvals.auto(p);
    this.store.audit(p.agentId, "policy.allowed", `${why} (rule ${d.rule!.id})`);
    return Promise.resolve(a);
  }

  /** Does ROOM.md or the agent's TOOLS.md (or, with no TOOLS.md yet, the owner's "asks first" in the app) say "ask" for this tool? */
  private ownerAsks(agentId: string, roomId: string | undefined, tool: string, agent: AgentConfig | undefined, roomOnly = false): boolean {
    const c = this.control(), snap = c?.snapshot();
    const slug = roomId ? c?.slugFor(roomId) : undefined;
    if (slug && snap?.rooms[slug]?.room?.fm.tools?.[tool] === "ask") return true;
    if (roomOnly) return false;
    const allows = snap?.agents[agentId]?.tools?.fm.room_allows?.[tool] ?? (agent ? desiredLevel(agent, tool) : undefined);
    return allows === "ask";
  }

  // ---------------------------------------------------------------- learning

  private learnState(): LearnState {
    const s = this.store.getKV<Partial<LearnState>>(LEARN_KEY, {});
    return { lastBatch: s.lastBatch, known: s.known ?? {}, forgotten: s.forgotten ?? {} };
  }
  private saveLearn(s: LearnState) { this.store.setKV(LEARN_KEY, s); }

  /** Rules the hub proposed that are no longer in the file were turned down by the owner: remember that, and end leases someone removed by hand. */
  private noticeFileChanges() {
    const c = this.host.control();
    const pol = c?.snapshot().policy;
    if (!c || !pol) return;
    const ids = new Set(pol.fm.rules.map((r) => r.id));
    const s = this.learnState();
    let changed = false;
    for (const k of Object.keys(s.known)) if (!ids.has(k)) { s.forgotten[k] = this.clock() + FORGET_DAYS * 86_400_000; delete s.known[k]; changed = true; }
    if (changed) this.saveLearn(s);
    const gone = this.kvLeases().filter((l) => !ids.has(l.id));
    if (gone.length) this.finishLeases(gone, "revoked", "its rule was removed from POLICY.md", "owner");
  }

  /**
   * Look at the approval history and write proposals for steady patterns into POLICY.md (unaccepted, `source: learned`, by `hub`),
   * with one plain line each. At most one batch a day, at most 5 rules, never more than 10 waiting. Returns what it proposed.
   */
  learn(o: { force?: boolean } = {}): Promise<{ proposed: string[]; skipped?: string }> {
    return this.serial(async () => {
      const c = this.control();
      if (!c || !c.snapshot().policy) return { proposed: [], skipped: "no POLICY.md" };
      const t = this.clock(), day = dayKey(t, this.zone());
      const st = this.learnState();
      if (!o.force && st.lastBatch === day) return { proposed: [], skipped: "already proposed today" };
      for (const [k, until] of Object.entries(st.forgotten)) if (until <= t) delete st.forgotten[k];
      const rules = this.fileRules();
      const waiting = rules.filter((r) => r.source === "learned" && !r.accepted).length;
      const room = Math.min(MAX_BATCH, MAX_PENDING - waiting);
      if (room <= 0) return { proposed: [], skipped: "rules are waiting for review" };
      const have = new Set(rules.map((r) => r.id));
      const fresh = learn(this.store.listApprovals(), t, this.config).filter((p) =>
        !have.has(p.id) && !st.forgotten[p.id] && !rules.some((r) => r.tool === p.tool && r.match === p.match && r.scope === p.scope));
      if (!fresh.length) return { proposed: [] };
      const zone = this.zone();
      const written: { p: Proposal; line: string }[] = [];
      let size = 0;
      const rel = "POLICY.md";
      await c.update((read) => {
        const text = read(rel);
        if (text === undefined || checkFile(rel, { kind: "policy" }, text).blocks.length) return { files: [] }; // the owner is told by the linter
        size = Buffer.byteLength(text);
        for (const p of fresh) {
          if (written.length >= room) break;
          const line = describeProposal(p, this.store.getAgent(p.agentId)?.name ?? p.agentId, zone);
          if (size + Buffer.byteLength(line) + 260 > POLICY_SOFT_CAP) break;
          size += Buffer.byteLength(line) + 260;
          written.push({ p, line });
        }
        if (!written.length) return { files: [] };
        const next = addRules(text, written.map(({ p, line }) => ({ rule: { id: p.id, effect: p.effect, tool: p.tool, match: p.match, scope: p.scope, source: "learned", accepted: false } satisfies RuleOut, line, section: "learned" as const })), "hub", this.today());
        return {
          files: [{ rel, text: next }],
          done: () => {
            const s = this.learnState();
            for (const { p } of written) s.known[p.id] = t;
            s.lastBatch = day;
            this.saveLearn(s);
          },
        };
      }, `Proposed ${Math.min(fresh.length, room)} approval rule${Math.min(fresh.length, room) === 1 ? "" : "s"} from your approvals`, "hub");
      if (!written.length) return { proposed: [] };
      const ids = written.map((w) => w.p.id);
      this.store.audit("hub", "policy.proposed", `${ids.length} learned rule${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`);
      this.host.attention.notify("decision", { title: `${ids.length} new approval rule${ids.length === 1 ? "" : "s"} to review`, body: clip(written.map((w) => w.line).join(" "), 280), key: `policy:${day}` });
      return { proposed: ids };
    });
  }

  // ---------------------------------------------------------------- the owner's edits (accept, edit, delete)

  /** Change POLICY.md under the queue. `build` returns the new text or a failure; the result says what happened. */
  private editFile(message: string, build: (text: string, rules: PolicyRule[]) => { text: string; done?: () => void } | Fail, writer = "owner"): Promise<{ ok: true } | Fail> {
    return this.serial(() => this.editFileNow(message, build, writer));
  }

  /** The same, for code that is already running in the queue. */
  private async editFileNow(message: string, build: (text: string, rules: PolicyRule[]) => { text: string; done?: () => void } | Fail, writer = "owner"): Promise<{ ok: true } | Fail> {
    const c = this.control();
    if (!c || !c.snapshot().policy) return fail(503, "POLICY.md isn't available on this hub.");
    const rel = "POLICY.md";
    let problem: Fail | undefined;
    await c.update((read) => {
      const text = read(rel);
      if (text === undefined) { problem = fail(404, "POLICY.md is missing."); return { files: [] }; }
      const f = checkFile(rel, { kind: "policy" }, text);
      if (f.blocks.length || !f.fm) { problem = fail(409, `POLICY.md has a problem (${f.blocks[0]?.message ?? "unreadable"}). Fix it, then try again.`); return { files: [] }; }
      const r = build(text, (f.fm as { rules: PolicyRule[] }).rules);
      if ("ok" in r) { problem = r; return { files: [] }; }
      if (r.text === text) { r.done?.(); return { files: [] }; }
      return { files: [{ rel, text: r.text }], done: r.done };
    }, message, writer);
    return problem ?? { ok: true as const };
  }

  accept(ruleId: string): Promise<{ ok: true } | Fail> {
    return this.editFile(`Accepted rule ${ruleId}`, (text, rules) => {
      const r = rules.find((x) => x.id === ruleId);
      if (!r) return fail(404, "That rule isn't in POLICY.md.");
      if (!parseMatch(r.match).ok) return fail(400, `The match "${r.match}" isn't one the hub can read. Edit it first.`);
      return { text: patchRule(text, ruleId, { accepted: true }, "owner", this.today()), done: () => this.store.audit("owner", "policy.accepted", `${ruleId}: ${describeRule(r)}`) };
    });
  }

  edit(ruleId: string, patch: { effect?: "allow" | "ask" | "deny"; match?: string; scope?: string; expires?: string | null; accepted?: boolean }): Promise<{ ok: true } | Fail> {
    if (patch.effect !== undefined && !["allow", "ask", "deny"].includes(patch.effect)) return Promise.resolve(fail(400, "effect must be allow, ask or deny."));
    if (patch.match !== undefined && !parseMatch(patch.match).ok) return Promise.resolve(fail(400, `match must be * or words like action:read path:/Board (${(parseMatch(patch.match) as { why?: string }).why}).`));
    if (patch.scope !== undefined && !(patch.scope.trim() === "*" || patch.scope.trim().split(/\s+/).every((t) => /^(agent|room|goal):[A-Za-z0-9_-]+$/.test(t)))) return Promise.resolve(fail(400, "scope must be * or words like agent:claude room:general."));
    if (typeof patch.expires === "string" && !(isRealDate(patch.expires) || isRealInstant(patch.expires))) return Promise.resolve(fail(400, "expires must be a date like 2026-12-31, or empty."));
    return this.editFile(`Edited rule ${ruleId}`, (text, rules) => {
      const r = rules.find((x) => x.id === ruleId);
      if (!r) return fail(404, "That rule isn't in POLICY.md.");
      const next = { ...r, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => k !== "expires" && v !== undefined)) } as PolicyRule;
      if (patch.expires !== undefined) { if (patch.expires === null || patch.expires === "") delete next.expires; else next.expires = patch.expires; }
      const section = ruleId.startsWith("lease-") ? "lease" as const : r.source === "learned" ? "learned" as const : undefined;
      const line = section ? `${describeRule(next, this.store.getAgent(/agent:([\w-]+)/.exec(next.scope)?.[1] ?? "")?.name, this.zone())} (edited)` : undefined;
      return {
        text: patchRule(text, ruleId, { effect: next.effect, match: next.match, scope: next.scope, accepted: next.accepted, expires: next.expires ?? null }, "owner", this.today(), section, line),
        done: () => this.store.audit("owner", "policy.edited", `${ruleId}: ${describeRule(next)}`),
      };
    });
  }

  /** Delete a rule. A learned one is remembered, so the same pattern isn't proposed again for 30 days. A lease is revoked. */
  remove(ruleId: string): Promise<{ ok: true } | Fail> {
    if (ruleId.startsWith("lease-")) return this.revoke(ruleId);
    return this.editFile(`Deleted rule ${ruleId}`, (text, rules) => {
      const r = rules.find((x) => x.id === ruleId);
      if (!r) return fail(404, "That rule isn't in POLICY.md.");
      if (r.id.startsWith("app-")) return fail(400, "The app manages this rule. Change the agent's setting instead.");
      return {
        text: removeRules(text, [ruleId], "owner", this.today()),
        done: () => {
          const s = this.learnState();
          if (r.source === "learned" || s.known[ruleId]) { s.forgotten[ruleId] = this.clock() + FORGET_DAYS * 86_400_000; delete s.known[ruleId]; this.saveLearn(s); }
          this.store.audit("owner", "policy.deleted", `${ruleId}: ${describeRule(r)}`);
        },
      };
    });
  }

  // ---------------------------------------------------------------- leases

  private kvLeases(): Lease[] { return this.store.getKV<Lease[]>(LEASES_KEY, []); }
  private saveLeases(l: Lease[]) { this.store.setKV(LEASES_KEY, l); }

  /** Every lease there is: the hub's own, plus any `lease-` rule with a UTC time that someone wrote into POLICY.md by hand. */
  private allLeases(): Lease[] {
    const kv = this.kvLeases();
    const have = new Set(kv.map((l) => l.id));
    const out = [...kv];
    for (const r of this.fileRules()) {
      if (!r.id.startsWith("lease-") || have.has(r.id) || !r.expires || !isRealInstant(r.expires)) continue;
      const tok = (k: string) => new RegExp(`(?:^|\\s)${k}:([\\w-]+)`).exec(r.scope)?.[1];
      const pm = parseMatch(r.match);
      out.push({ id: r.id, agentId: tok("agent") ?? "*", tool: r.tool, action: pm.ok && !pm.all ? pm.m.action ?? "*" : "*", match: r.match, scope: r.scope, goalId: tok("goal"), createdAt: 0, expiresAt: expiryMs(r.expires), by: "owner" });
    }
    return out;
  }

  private leaseText(l: Lease, name?: string): string {
    const rule = { effect: "allow" as const, tool: l.tool, match: l.match, scope: l.scope, expires: new Date(l.expiresAt).toISOString() };
    const how = l.goalId ? (l.capped ? "until the goal ends" : "until the goal ends or the time is up") : `for ${Math.max(1, Math.round((l.expiresAt - l.createdAt) / 60_000))} minutes`;
    return `${describeRule(rule, name ?? this.store.getAgent(l.agentId)?.name, this.zone())} (${how})`;
  }

  private view(l: Lease): LeaseView {
    const name = this.store.getAgent(l.agentId)?.name ?? l.agentId;
    return {
      id: l.id, agentId: l.agentId, agentName: name, tool: l.tool, action: l.action, ...(l.roomId ? { roomId: l.roomId } : {}), ...(l.goalId ? { goalId: l.goalId } : {}),
      createdAt: l.createdAt, expiresAt: l.expiresAt, goalOnly: !!l.goalId, ...(l.switchedOn ? { switchedOn: true } : {}),
      remainingMs: Math.max(0, l.expiresAt - this.clock()), text: this.leaseText(l, name),
    };
  }

  /** Active leases, soonest to end first. */
  leases(): LeaseView[] {
    const t = this.clock();
    return this.allLeases().filter((l) => !l.pending && l.expiresAt > t && !(l.goalId && this.goalOver(l.goalId))).sort((a, b) => a.expiresAt - b.expiresAt).map((l) => this.view(l));
  }

  private goalOver(goalId: string): boolean {
    const g = this.store.getGoal(goalId);
    return !g || ENDED.has(g.status);
  }

  /**
   * Grant a lease: an allow rule in POLICY.md that expires at a time (minutes) or when a goal ends, whichever comes first, mirrored in the
   * database. When the agent doesn't have the tool, the lease switches it on and the end of the lease switches it back off.
   */
  grant(input: LeaseInput): Promise<LeaseResult> {
    return this.serial(async () => {
      const c = this.control();
      if (!c || !c.snapshot().policy) return fail(503, "The control folder isn't available, so a lease can't be written to POLICY.md.");
      const agent = this.store.getAgent(input.agentId);
      if (!agent) return fail(404, "That agent doesn't exist.");
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(input.tool) || !(TOOLS.some((x) => x.id === input.tool) || input.tool in (agent.tools ?? {}))) return fail(400, "That isn't a tool this agent can have.");
      if (input.minutes !== undefined && !(Number.isInteger(input.minutes) && input.minutes >= 1 && input.minutes <= MAX_LEASE_MINUTES)) return fail(400, `minutes must be a whole number from 1 to ${MAX_LEASE_MINUTES}.`);
      if (input.minutes === undefined && !input.goalId) return fail(400, "Say how long (minutes) or which goal the lease is for.");
      const goal = input.goalId ? this.store.getGoal(input.goalId) : undefined;
      if (input.goalId && (!goal || ENDED.has(goal.status))) return fail(400, "That goal isn't running, so there is nothing to lease it for.");
      const action = (input.action ?? "*").trim().toLowerCase() || "*";
      if (!/^[a-z0-9_*?-]{1,60}$/.test(action)) return fail(400, "action must be a word like send or read (* and ? are allowed).");
      const roomId = input.roomId ?? goal?.roomId;
      if (roomId && !this.store.getRoom(roomId)) return fail(400, "That room doesn't exist.");
      const slug = roomId ? c.slugFor(roomId) : undefined; // a direct-message room has no folder name: the room's own id scopes the lease, so it still stays in that room
      const t = this.clock();
      const lease: Lease = {
        id: `lease-${randomBytes(3).toString("hex")}`, agentId: agent.id, tool: input.tool, action, match: `action:${action}`,
        scope: [`agent:${agent.id}`, ...(slug ? [`room:${slug}`] : []), ...(input.goalId ? [`goal:${input.goalId}`] : []), ...(roomId ? [`roomid:${roomId}`] : input.noRoom ? ["noroom"] : [])].join(" "),
        ...(roomId ? { roomId } : {}), ...(input.goalId ? { goalId: input.goalId } : {}), createdAt: t,
        expiresAt: input.minutes !== undefined ? t + input.minutes * 60_000 : t + GOAL_LEASE_CEILING_MS,
        ...(input.minutes === undefined ? { capped: true } : {}), by: input.by ?? "owner",
      };
      const needsSwitch = agent.tools?.[input.tool] !== true;
      if (needsSwitch) { lease.switchedOn = true; lease.pending = true; } // it applies once the tool is seen to stay on (below)
      const rule: RuleOut = { id: lease.id, effect: "allow", tool: lease.tool, match: lease.match, scope: lease.scope, expires: new Date(lease.expiresAt).toISOString(), source: "owner", accepted: true };
      const line = this.leaseText(lease, agent.name);
      const edited = await this.editFileNow(`Lease: ${clip(line, 120)}`, (text) => {
        if (Buffer.byteLength(text) > POLICY_SOFT_CAP) return fail(409, "POLICY.md is full. Delete rules you don't need, then try again.");
        return {
          text: addRules(text, [{ rule, line, section: "lease" }], "owner", this.today()),
          done: () => {
            this.saveLeases([...this.kvLeases(), lease]);
            if (needsSwitch) { const a = this.store.getAgent(agent.id); if (a) this.store.saveAgent({ ...a, tools: { ...a.tools, [lease.tool]: true } }); }
            this.store.audit(lease.by, "lease.granted", `${lease.id}: ${agent.name} ${lease.tool} ${action}${lease.goalId ? ` for goal ${lease.goalId}` : ""} until ${new Date(lease.expiresAt).toISOString()}${needsSwitch ? " (switched the tool on)" : ""}`);
          },
        };
      });
      if (!edited.ok) return edited;
      const notes: string[] = [];
      if (needsSwitch) {
        await c.idle().catch(() => undefined); // the tool switch is written to the agent's files; the files may say no (the lease stays pending until they have said yes)
        if (this.store.getAgent(agent.id)?.tools?.[lease.tool] !== true) {
          await this.endLeases([lease], "revoked", "the tool stays off", "hub");
          return fail(409, `${agent.name} can't have ${lease.tool}: POLICY.md or its platform keeps it off, and a lease can't widen that.`);
        }
        this.saveLeases(this.kvLeases().map((l) => (l.id === lease.id ? { ...l, pending: undefined } : l))); // the switch stuck: the lease applies now
        delete lease.pending;
        notes.push(`${lease.tool} was off for ${agent.name}. It is on until the lease ends.`);
      }
      if (twoKeyClass(lease.tool, action === "*" ? "delete" : action, "") || ["shell", "gmail", "salesforce"].includes(lease.tool)) notes.push("Sends, CRM writes and deletes still need the two-key check.");
      // An "ask first" the owner's files wrote (TOOLS.md, ROOM.md) is stronger than a lease: say so, so a lease that will not skip the card is not a surprise.
      const latest = this.store.getAgent(agent.id);
      if (this.ownerAsks(agent.id, roomId, lease.tool, latest, true)) notes.push(`This room's ROOM.md says to ask about ${lease.tool}, and a lease can't change that. The card will still come.`);
      return { ok: true, lease: this.view(lease), notes };
    });
  }

  /** Revoke a lease now. */
  revoke(leaseId: string): Promise<{ ok: true } | Fail> {
    return this.serial(async () => {
      const l = this.allLeases().find((x) => x.id === leaseId);
      if (!l) return fail(404, "That lease isn't active.");
      await this.endLeases([l], "revoked", "you revoked it", "owner");
      return { ok: true as const };
    });
  }

  /**
   * An approval card's "Allow for 30 minutes" / "Allow for this goal": a lease for what the card asked (the tool and its verb), for this
   * agent and room, and the pending approval is approved along with it.
   */
  leaseFromApproval(approval: Approval, o: { minutes?: number; forGoal?: boolean }, approve: (id: string) => Approval | undefined): Promise<LeaseResult> {
    if (approval.status !== "pending") return Promise.resolve(fail(409, "That request has already been answered."));
    if (approval.question || approval.proposalId) return Promise.resolve(fail(400, "This kind of card can't be turned into a lease."));
    // A two-key card asks the owner to pick a draft. Approving it for a lease would pick draft A without them choosing it.
    if (approval.twoKey) return Promise.resolve(fail(400, "A two-key card needs you to pick a draft. It can't be turned into a lease."));
    const verb = verbOf(approval.action);
    if (!verb) return Promise.resolve(fail(400, "The hub can't tell what to allow from this request. Approve it, or grant a lease from the Policy screen."));
    const goalId = o.forGoal ? this.goalForApproval(approval) : undefined;
    if (o.forGoal && !goalId) return Promise.resolve(fail(400, "No goal is running for this agent here, so there is no goal to lease it for."));
    return this.grant({ agentId: approval.agentId, tool: approval.tool, action: verb, roomId: approval.roomId, noRoom: !approval.roomId, goalId, minutes: o.forGoal ? undefined : o.minutes }).then((r) => {
      if (r.ok) approve(approval.id);
      return r;
    });
  }

  /** The goal an agent's pending approval belongs to: its running task in that room, else the room's one live goal. */
  private goalForApproval(a: Approval): string | undefined {
    if (!a.roomId) return undefined;
    const live = this.store.listGoals(a.roomId).filter((g) => !ENDED.has(g.status));
    const mine = this.store.listTasks({ roomId: a.roomId }).find((t) => t.assignee === a.agentId && (t.status === "running" || t.status === "revising") && live.some((g) => g.id === t.goalId));
    return mine?.goalId ?? (live.length === 1 ? live[0].id : undefined);
  }

  /** Remove leases whose time is up or whose goal has ended. Runs every 30 seconds once started, and when a goal ends. */
  sweep(): Promise<string[]> {
    return this.serial(async () => {
      const t = this.clock();
      const all = this.allLeases();
      const late = all.filter((l) => l.expiresAt <= t);
      const goalEnded = all.filter((l) => l.expiresAt > t && l.goalId && this.goalOver(l.goalId));
      await this.endLeases(late, "expired", "its time ran out", "hub");
      await this.endLeases(goalEnded, "expired", "its goal ended", "hub");
      return [...late, ...goalEnded].map((l) => l.id);
    });
  }

  private onEvent = (e: ServerEvent) => {
    try {
      if (e.type !== "goal" || !ENDED.has(e.goal.status)) return;
      const gid = e.goal.id;
      if (this.allLeases().some((l) => l.goalId === gid)) void this.sweep().catch(() => undefined);
    } catch { /* a lease check never breaks a goal's write */ }
  };

  /**
   * Take leases out of POLICY.md and the database, put the tool back as it was, and audit each as `lease.expired` (time or goal)
   * or `lease.revoked`. The file edit is skipped (and tried again at the next sweep) if POLICY.md has a problem, but the lease stops
   * applying at once either way: a rule past its time is never read, and the database copy is dropped.
   */
  private async endLeases(list: Lease[], kind: "expired" | "revoked", why: string, by: string): Promise<void> {
    if (!list.length) return;
    const ids = list.map((l) => l.id);
    let done = false;
    const finish = (only = list) => { if (!done) { done = true; this.finishLeases(only, kind, why, by); } };
    const c = this.control();
    if (!c?.snapshot().policy) { finish(); return; }
    const present = list.filter((l) => this.fileRules().some((r) => r.id === l.id));
    if (!present.length) { finish(); return; }
    await c.update((read) => {
      const text = read("POLICY.md");
      // A file the owner broke can't be edited now; the lease stops applying anyway, and a hand-written one is retried at the next sweep.
      if (text === undefined || checkFile("POLICY.md", { kind: "policy" }, text).blocks.length) { finish(list.filter((l) => l.createdAt !== 0)); return { files: [] }; }
      return { files: [{ rel: "POLICY.md", text: removeRules(text, ids, by, this.today()) }], done: () => finish() };
    }, `Lease ${kind === "revoked" ? "revoked" : "ended"}: ${ids.join(", ")}`, by === "owner" ? "owner" : "hub");
    finish();
  }

  /** The bookkeeping half of ending a lease (database, tool switch, audit). Safe to run twice: only leases still in the database count. */
  private finishLeases(list: Lease[], kind: "expired" | "revoked", why: string, by: string) {
    const kv = this.kvLeases();
    const mine = new Set(list.map((l) => l.id));
    const remaining = kv.filter((l) => !mine.has(l.id));
    const had = new Set(kv.map((l) => l.id));
    if (remaining.length !== kv.length) this.saveLeases(remaining);
    for (const l of list) {
      if (had.has(l.id) || l.createdAt === 0) {
        let restored = "";
        if (l.switchedOn && !remaining.some((o) => o.switchedOn && o.agentId === l.agentId && o.tool === l.tool)) {
          const a = this.store.getAgent(l.agentId);
          if (a?.tools?.[l.tool]) { this.store.saveAgent({ ...a, tools: { ...a.tools, [l.tool]: false } }); restored = `; ${l.tool} is off again`; }
        }
        this.store.audit(kind === "revoked" ? by : "hub", `lease.${kind}`, `${l.id}: ${this.store.getAgent(l.agentId)?.name ?? l.agentId} ${l.tool} ${l.action} (${why})${restored}`);
      }
    }
  }

  // ---------------------------------------------------------------- what the apps show

  state(): PolicyState {
    const c = this.control();
    const pol = c?.snapshot().policy;
    const at = this.clock();
    if (!c || !pol) {
      const block = c?.status().notices.find((n) => n.file === "POLICY.md" && n.level === "block");
      return { at, ok: false, problem: block ? block.message : "The control folder isn't available.", rules: [], leases: this.leases(), pending: 0, ...(c ? { path: `${c.root}/POLICY.md` } : {}) };
    }
    const zone = this.zone();
    const nameOf = (rule: PolicyRule) => { const a = /(?:^|\s)agent:([\w-]+)/.exec(rule.scope)?.[1]; return a ? { agentId: a, name: this.store.getAgent(a)?.name ?? a } : undefined; };
    const rules: PolicyRuleView[] = pol.fm.rules.map((r) => {
      const who = nameOf(r);
      return {
        id: r.id, kind: r.id.startsWith("lease-") ? "lease" : r.source === "learned" ? "learned" : "owner", effect: r.effect, tool: r.tool, match: r.match, scope: r.scope,
        ...(r.expires ? { expires: r.expires } : {}), accepted: r.accepted, text: lineFor(pol.body, r.id) ?? describeRule(r, who?.name, zone), ...(who ? { agentId: who.agentId } : {}),
      };
    });
    return { at, ok: true, path: `${c.root}/POLICY.md`, rules, leases: this.leases(), pending: pol.fm.rules.filter((r) => r.source === "learned" && !r.accepted).length };
  }

  /** The folder path of POLICY.md, for "Edit POLICY.md". */
  filePath(): string | undefined { const c = this.control(); return c ? `${c.root}/POLICY.md` : undefined; }
}
