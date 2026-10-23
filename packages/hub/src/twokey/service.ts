import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, Approval, OrchestratorSettings, Profile, TwoKeyCard, TwoKeyDraft, TwoKeyKind, TwoKeyRecord, TwoKeySide, TwoKeyVerdict } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { RunResult } from "../adapters/types.js";
import type { Approvals } from "../orchestrator/approvals.js";
import { pickProfile } from "../orchestrator/contract.js";
import { familyOf, isLocalAgent } from "../jury/family.js";
import { id, now } from "../util.js";
import { isTwoKey, parsedInput, type TwoKeyClass } from "./classify.js";
import { brief, clip, draftFromRequest, parseReply, redact, safeDraft, targetsOf, type Reply, type RequestDraft } from "./draft.js";
import { compareDrafts, draftKey, type Comparison } from "./match.js";
import { pickSecond } from "./pick.js";
import { twoKeyPrompt, type Brief } from "./prompt.js";
import { getTwoKey, listTwoKey, saveTwoKey } from "./records.js";

/**
 * 4.1 Two-key actions (PRODUCT.md 6.11). To send email, write to a CRM or delete anything, two agents from different model families draft the
 * action independently. It runs only if the drafts match; otherwise the owner decides.
 *
 *  1. `gate` is called by Orchestrator.requestApproval for every route to a sensitive action (MCP request_approval, Claude Code's approval_prompt,
 *     an ACP agent's permission request, a subagent's request). `checkDeletes` is called by the file broker before it asks the owner to approve a
 *     proposal that deletes files. Nothing else needs to know.
 *  2. The hub picks a second agent of another family (room roster, quota, capacity), gives it the work and not the first draft, and reads its reply.
 *  3. Match: the action goes on to the usual approval rules (an owner rule that says "always ask" still asks; the pair only stands in for the owner
 *     where the policy lets the action run without asking). Mismatch, "no action" or no second key: one card for the owner with both drafts and
 *     what differs. Run draft A, run draft B, or run neither. It is sent through the attention gate as a disagreement. Nothing runs until they pick.
 *  4. Every check is a row in the `twokey` table and in the audit log (secrets removed, email bodies cut short).
 */

export const TWOKEY_DEFAULTS = { enabled: true, threshold: 0.85 };
export function twoKeySettings(s: Pick<OrchestratorSettings, "twoKey">): { enabled: boolean; threshold: number } {
  const t = s.twoKey ?? {};
  const th = typeof t.threshold === "number" && Number.isFinite(t.threshold) ? Math.min(1, Math.max(0.5, t.threshold)) : TWOKEY_DEFAULTS.threshold;
  return { enabled: t.enabled ?? TWOKEY_DEFAULTS.enabled, threshold: th };
}

/** What the service needs from the orchestrator. Narrow, so tests can drive it with fakes. */
export interface TwoKeyHost {
  store: Store;
  approvals: Approvals;
  /** Agents that are on and signed in. With a room, only that room's roster (4.3). */
  readyAgents(roomId?: string): Promise<AgentConfig[]>;
  /** A JSON-only run of an agent, through the orchestrator's usual call (quota ledger, capacity, audit). */
  call(agent: AgentConfig, prompt: string, o: { jsonOnly: true; roomId?: string; taskId?: string; signal?: AbortSignal; profile?: Profile }): Promise<RunResult>;
  quotaLimited(agentId: string): boolean;
  governor?: { admit(a: AgentConfig): boolean; start(key: string, a: AgentConfig): void; release(key: string): void };
  /** Not agents on probation. */
  realAgents?(agents: AgentConfig[]): AgentConfig[];
  localModels?(): string[];
  /** How long the second agent has to answer. */
  timeoutMs?: number;
}

export interface RunRequest {
  kind: TwoKeyKind;
  tool: string;
  action: string;
  /** Why this is two-key, for the record. */
  why: string;
  agentId: string;
  roomId?: string;
  taskId?: string;
  goalId?: string;
  /** The first agent's draft, read from its request. */
  a: RequestDraft;
  /** Resolves delete targets. */
  cwd?: string;
  /** Relevant inputs for the second agent (a folder listing). Never the first draft. */
  inputs?: string;
  /** How long the owner's card waits. */
  ttlMs?: number;
  /** The file proposal the card is about (so an app can show its diff). */
  proposalId?: string;
  /** Told the card's approval id as soon as it exists. */
  onCard?: (approvalId: string) => void;
}

export interface Outcome {
  record: TwoKeyRecord;
  /** The owner's decision card, when the owner had to decide. Its status and choice are final. */
  card?: Approval;
  choice?: "a" | "b" | "neither";
  /** The second agent's draft, when there was one. */
  b?: TwoKeyDraft | null;
  /** The owner had already picked exactly this draft before. */
  permitted?: boolean;
}
export type DeleteOutcome =
  | { go: "proceed"; note: string }
  | { go: "decided"; approval: Approval; choice: "a" | "b" | "neither"; /** absolute paths of draft B's targets */ b?: string[] };

const KIND_WORD: Record<TwoKeyKind, string> = { email: "email", crm: "CRM write", delete: "delete" };
const PERMIT_MS = 30 * 60_000;
const asObj = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);
type Who = { agentId: string; roomId?: string; taskId?: string };

export class TwoKey {
  /** Drafts the owner picked (draft B) that an agent has been told to run itself: one use each, for 30 minutes. */
  private permits = new Map<string, number>();

  constructor(private host: TwoKeyHost) {}

  settings() { return twoKeySettings(this.host.store.getSettings()); }
  list(f: { taskId?: string; verdict?: string; limit?: number } = {}) { return listTwoKey(this.host.store, f); }
  get(rid: string) { return getTwoKey(this.host.store, rid); }

  // ---- one-time permits (the owner picked the other agent's draft, and the agent must run it itself)

  /** A permit is for one agent, through one tool, in one room, for one task, for exactly one draft. */
  private permitKey(who: Who, tool: string, d: TwoKeyDraft) { return [who.agentId, tool, who.roomId ?? "", who.taskId ?? "", draftKey(d)].join("|"); }
  /** The owner picked this draft: the agent that asks for exactly it next, through the same tool, in the same room and task, goes through once. */
  permit(who: Who, tool: string, d: TwoKeyDraft) {
    const t = now();
    for (const [k, until] of this.permits) if (until < t) this.permits.delete(k);
    this.permits.set(this.permitKey(who, tool, d), t + PERMIT_MS);
  }
  private takePermit(who: Who, tool: string, d: TwoKeyDraft): boolean {
    const k = this.permitKey(who, tool, d), until = this.permits.get(k);
    if (until === undefined) return false;
    this.permits.delete(k);
    return until >= now();
  }

  // ---- draft B, whole

  /**
   * The owner picked draft B on an approval card. The card and the `twokey` table hold B with secrets removed and long text cut (for display and the
   * audit trail), and running that copy would send "[secret removed]" or a clipped body. So B as the second agent wrote it is kept here, in memory only,
   * keyed by the card's approval id: the tool input (`updatedInput`) and the one-use permit are made from it, and it is never written anywhere.
   */
  private picked = new Map<string, { draft: TwoKeyDraft; until: number }>();
  private rememberPicked(approvalId: string, draft: TwoKeyDraft) {
    const t = now();
    for (const [k, v] of this.picked) if (v.until < t) this.picked.delete(k);
    this.picked.set(approvalId, { draft, until: t + PERMIT_MS });
  }
  /** Draft B in full for the card the owner picked it on, once (the second call gets nothing), or undefined when the hub no longer has it. */
  takePicked(approvalId: string): TwoKeyDraft | undefined {
    const v = this.picked.get(approvalId);
    this.picked.delete(approvalId);
    return v && v.until >= now() ? v.draft : undefined;
  }

  // ---- the front doors

  /** Is the check on? (The owner can switch it off in settings.) */
  get enabled(): boolean { return this.settings().enabled; }

  /**
   * The one classification of a request, for every caller: the gate below, the policy layer, the learning loop and the agent's own auto-approval.
   * `input` is the tool's input when there is one; the text `detail` is read only when it is a JSON object.
   */
  classify(tool: string, action: string, detail: string, input?: unknown): TwoKeyClass { return isTwoKey(tool, action, parsedInput(detail, input) ?? input ?? detail); }

  /**
   * Orchestrator.requestApproval calls this first. Returns undefined when the action is not two-key (or two-key is off): carry on as before.
   * Otherwise a promise of the final answer: `proceed` runs the usual approval rules (called when the drafts match), or the owner's own decision card.
   */
  gate(grant: { agentId: string; roomId?: string; taskId?: string; cwd?: string }, tool: string, action: string, detail: string, input: unknown, proceed: (note: string) => Promise<Approval>): Promise<Approval> | undefined {
    if (!this.settings().enabled) return undefined;
    const cls = this.classify(tool, action, detail, input);
    if (!cls.twoKey || !cls.kind) return undefined;
    const a = draftFromRequest(cls, tool, action, detail, parsedInput(detail, input) ?? input, grant.cwd);
    const task = grant.taskId ? this.host.store.getTask(grant.taskId) : undefined;
    return this.run({
      kind: cls.kind, tool, action, why: cls.why, agentId: grant.agentId, roomId: grant.roomId, taskId: grant.taskId, goalId: task?.goalId, a, cwd: grant.cwd,
      inputs: cls.kind === "delete" && grant.cwd ? listFolder(grant.cwd) : undefined,
    }).then(async (o): Promise<Approval> => {
      if (o.permitted) return this.host.approvals.auto({ agentId: grant.agentId, roomId: grant.roomId, tool, action, detail: "The owner picked this version on a two-key card." });
      if (!o.card) return proceed(this.note(o.record));
      return o.card;
    });
  }

  /**
   * The file broker calls this before it asks the owner to approve a proposal that deletes files (a task's write-back). `targets` are the files the
   * proposal deletes (relative to `base`, the folder's real path). Resolves with `proceed` (the drafts agree: ask the owner as usual) or the owner's
   * decision on the two-key card (the card replaces the plain approval).
   */
  async checkDeletes(q: { agentId: string; roomId?: string; goalId?: string; taskId?: string; title: string; targets: string[]; base: string; proposalId: string; ttlMs?: number; onCard?: (approvalId: string) => void }): Promise<DeleteOutcome> {
    if (!this.settings().enabled) return { go: "proceed", note: "" };
    const targets = targetsOf(q.targets, q.base);
    const o = await this.run({
      kind: "delete", tool: "filesystem", action: `delete ${targets.length} file${targets.length === 1 ? "" : "s"} from "${clip(q.title, 60)}"`, why: "the task deletes files in the owner's folder",
      agentId: q.agentId, roomId: q.roomId, taskId: q.taskId, goalId: q.goalId, a: { draft: { kind: "delete", targets }, raw: clip(redact(targets.join("\n")), 1500) },
      cwd: q.base, inputs: listFolder(q.base), ttlMs: q.ttlMs, proposalId: q.proposalId, onCard: q.onCard,
    });
    if (!o.card) return { go: "proceed", note: this.note(o.record) };
    const b = o.b && o.b.kind === "delete" ? o.b.targets : undefined;
    return { go: "decided", approval: o.card, choice: o.choice ?? "neither", b };
  }

  /** One line the usual approval card carries after the drafts matched. */
  private note(r: TwoKeyRecord): string {
    if (r.verdict !== "match") return "";
    return `\n\nTwo-key check passed: ${r.agentB ?? "a second agent"} (${r.familyB ?? "another family"}) drafted the same ${KIND_WORD[r.kind]} on its own${r.similarity !== undefined ? `, ${Math.round(r.similarity * 100)}% alike` : ""}.`;
  }

  // ---- the check

  async run(r: RunRequest): Promise<Outcome> {
    const { store } = this.host;
    const s = this.settings();
    const first = store.getAgent(r.agentId);
    const localModels = this.host.localModels?.() ?? [];
    const familyA = first ? familyOf(first, localModels) : "unknown";
    const rec: TwoKeyRecord = {
      id: id("tk"), at: now(), kind: r.kind, tool: r.tool, action: clip(redact(r.action), 200), roomId: r.roomId, taskId: r.taskId, goalId: r.goalId,
      agentA: r.agentId, familyA, verdict: "unavailable", why: "", threshold: s.threshold, draftA: safeDraft(r.a.draft), draftB: null, diffs: [], outcome: "pending",
    };
    store.audit(r.agentId, "twokey.requested", `${r.kind} via ${r.tool} (${r.why}); first key ${brief(r.a.draft)}`);

    if (r.a.draft && this.takePermit({ agentId: r.agentId, roomId: r.roomId, taskId: r.taskId }, r.tool, r.a.draft)) {
      Object.assign(rec, { verdict: "match" as TwoKeyVerdict, why: "The owner already picked this version.", outcome: "permitted" as const, decidedAt: now() });
      saveTwoKey(store, rec);
      store.audit("owner", "twokey.permitted", `${r.kind} via ${r.tool}: ${brief(r.a.draft)}`);
      return { record: rec, permitted: true };
    }

    // ---- the second key
    let second: AgentConfig | undefined, reply: Reply | undefined, cmp: Comparison | undefined, why = "";
    try {
      const ready = this.host.realAgents ? this.host.realAgents(await this.host.readyAgents(r.roomId)) : await this.host.readyAgents(r.roomId);
      if (!first) why = `${r.agentId} is no longer set up, so no other family can be compared against it`;
      else {
        const pick = pickSecond({ ready, first, localModels, limited: (aid) => this.host.quotaLimited(aid), admit: (a) => this.host.governor?.admit(a) ?? true });
        if (!pick.agent) why = `No second key: ${pick.why}.`;
        else {
          second = pick.agent;
          const got = await this.askSecond(second, r, rec, localModels);
          if ("error" in got) why = `No second key: ${second.name} (${familyOf(second, localModels)}) gave no usable draft (${got.error}).`;
          else reply = got;
        }
      }
    } catch (e) { why = `No second key: ${clip(redact((e as Error).message ?? "the check failed"), 120)}.`; }

    let verdict: TwoKeyVerdict = "unavailable";
    let bDraft: TwoKeyDraft | null = null, noAction: string | undefined;
    if (second) { rec.agentB = second.id; rec.familyB = familyOf(second, localModels); }
    if (reply && "none" in reply) {
      verdict = "no_action"; noAction = reply.none;
      why = `${second!.name} says this action isn't called for: ${reply.none}`;
    } else if (reply && "draft" in reply) {
      bDraft = reply.draft;
      if (!r.a.draft) { verdict = "mismatch"; why = `${first?.name ?? r.agentId}'s request could not be read as a draft, so it can't be matched against ${second!.name}'s.`; }
      else {
        cmp = compareDrafts(r.a.draft, bDraft, s.threshold);
        verdict = cmp.match ? "match" : "mismatch";
        why = cmp.why;
      }
    }
    Object.assign(rec, { verdict, why: clip(why, 400), draftB: safeDraft(bDraft), diffs: cmp?.diffs ?? [], ...(cmp?.similarity !== undefined ? { similarity: cmp.similarity } : {}), ...(noAction !== undefined ? { noActionB: clip(redact(noAction), 300) } : {}) });
    store.audit(r.agentId, `twokey.${verdict}`, `${r.kind} via ${r.tool}: ${rec.why} A: ${brief(r.a.draft)}${second ? ` | B (${second.id}, ${rec.familyB}): ${noAction !== undefined ? `no action: ${clip(redact(noAction), 80)}` : brief(bDraft)}` : ""}`);

    if (verdict === "match") { rec.outcome = "proceeded"; saveTwoKey(store, rec); return { record: rec, b: bDraft }; }

    // ---- the owner decides
    const sideA: TwoKeySide = { agentId: r.agentId, name: first?.name ?? r.agentId, family: familyA, draft: safeDraft(r.a.draft), ...(r.a.draft ? {} : { raw: r.a.raw }) };
    const sideB: TwoKeySide | undefined = second ? { agentId: second.id, name: second.name, family: rec.familyB!, draft: safeDraft(bDraft), ...(noAction !== undefined ? { noAction: clip(redact(noAction), 300) } : {}) } : undefined;
    const choices: TwoKeyCard["choices"] = [{ id: "a", label: `Run ${sideA.name}'s draft` }];
    if (bDraft && sideB) choices.push({ id: "b", label: `Run ${sideB.name}'s draft` });
    choices.push({ id: "neither", label: "Run neither" });
    const words = cmp?.words && r.a.draft?.kind === "email" ? { a: cmp.words.a.slice(0, 600), b: cmp.words.b.slice(0, 600) } : undefined;
    const card: TwoKeyCard = { recordId: rec.id, kind: r.kind, verdict, why: rec.why, ...(rec.similarity !== undefined ? { similarity: rec.similarity } : {}), a: sideA, ...(sideB ? { b: sideB } : {}), diffs: rec.diffs, ...(words ? { words } : {}), choices };
    saveTwoKey(store, rec);
    const decision = this.host.approvals.request({
      agentId: r.agentId, roomId: r.roomId, tool: r.tool, action: clip(`two-key: ${rec.why}`, 240), detail: cardText(card), ...(r.proposalId ? { proposalId: r.proposalId } : {}), twoKey: card,
    }, r.ttlMs ? { ttlMs: r.ttlMs } : {});
    const apr = store.listApprovals("pending").find((x) => x.twoKey?.recordId === rec.id);
    if (apr) { rec.approvalId = apr.id; saveTwoKey(store, rec); r.onCard?.(apr.id); }
    const done = await decision;
    const pick = done.status === "approved" ? (done.choice === "b" && bDraft ? "b" : "a") : "neither";
    // Draft B as the second agent wrote it (not the redacted, cut copy the card and the table hold) is what runs when the owner picks it.
    if (pick === "b" && bDraft) this.rememberPicked(done.id, bDraft);
    rec.outcome = done.status === "expired" ? "expired" : pick === "a" ? "owner_a" : pick === "b" ? "owner_b" : "owner_neither";
    rec.decidedAt = now();
    saveTwoKey(store, rec);
    store.audit("owner", "twokey.decided", `${r.kind} via ${r.tool}: ${done.status === "expired" ? "no decision, treated as neither" : pick === "neither" ? "run neither" : `run draft ${pick.toUpperCase()}`}`);
    return { record: rec, card: done, choice: pick, b: bDraft };
  }

  /** Ask the second agent to draft. One retry when its reply is not a draft. */
  private async askSecond(agent: AgentConfig, r: RunRequest, rec: TwoKeyRecord, localModels: string[]): Promise<Reply> {
    const prompt = twoKeyPrompt(this.brief(r));
    const local = isLocalAgent(agent, localModels), gkey = `twokey:${rec.id}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.host.timeoutMs ?? 120_000);
    timer.unref?.();
    if (local) this.host.governor?.start(gkey, agent);
    let last = "no reply";
    try {
      for (let i = 0; i < 2; i++) {
        const res = await this.host.call(agent, i ? `${prompt}\n\nYour last reply was not a usable draft (${last}). Reply with the JSON object only.` : prompt, { jsonOnly: true, roomId: r.roomId, taskId: r.taskId, signal: ctrl.signal, profile: pickProfile(agent, "reviewer") });
        if (ctrl.signal.aborted) return { error: "it took too long" };
        if (!res.ok) { last = clip(res.error ?? "the call failed", 100); continue; }
        const p = parseReply(r.kind, res.text, r.cwd);
        if (!("error" in p)) return p;
        last = p.error;
      }
      return { error: last };
    } finally { clearTimeout(timer); if (local) this.host.governor?.release(gkey); }
  }

  /** The work, as the second agent sees it: never the first draft, nor the first agent's words for the action. */
  private brief(r: RunRequest): Brief {
    const { store } = this.host;
    const task = r.taskId ? store.getTask(r.taskId) : undefined;
    const goal = (task ? store.getGoal(task.goalId) : undefined) ?? (r.goalId ? store.getGoal(r.goalId) : undefined);
    const parent = task && (task as { parentTaskId?: string }).parentTaskId ? store.getTask((task as { parentTaskId?: string }).parentTaskId!) : undefined;
    const needles = needlesOf(r.a.draft);
    const mine = (author: { kind: string; id: string }) => author.kind === "agent" && author.id === r.agentId;
    // The second key hears the owner and the work, not the agent being checked: an agent can seed a paraphrase of what it means to do, in the room or in a
    // task update. So no message from the requesting agent, none from any agent since the task started (or at all, when the start is not known), and
    // none from the hub's own voices (they relay agents' output). Owner messages stay.
    const since = task ? Math.min(task.createdAt, task.claimedAt ?? task.createdAt) : undefined;
    const heard = (m: { author: { kind: string; id: string }; type: string; createdAt: number }) =>
      m.author.kind === "human" || (m.author.kind === "agent" && !mine(m.author) && m.type !== "task_update" && since !== undefined && m.createdAt < since);
    const conversation = r.roomId ? store.listMessages(r.roomId, 30).filter((m) => !m.quiet && m.text.trim() && heard(m)).map((m) => {
      const leaks = needles.some((n) => m.text.includes(n)) && (mine(m.author) || needles.some((n) => n.length >= 25 && m.text.includes(n)));
      return `${m.author.name}: ${leaks ? "(left out: it quotes the action being checked)" : clip(redact(m.text.replace(/\s+/g, " ").trim()), 600)}`;
    }) : [];
    return {
      kind: r.kind, tool: r.tool.length > 40 ? "tool" : r.tool,
      objective: goal?.contract?.objective ?? goal?.text, requirements: (goal?.contract?.requirements ?? []).map((q) => q.text), constraints: goal?.contract?.constraints ?? [],
      task: task ? { title: task.title, description: task.description, criteria: (task.criteria ?? []).map((c) => c.text), ...(parent ? { parent: parent.title } : {}) } : undefined,
      inputs: r.inputs, conversation,
    };
  }
}

/** Strings from the first draft that must not reach the second agent through the conversation. */
function needlesOf(d: TwoKeyDraft | null): string[] {
  if (!d) return [];
  const out: string[] = [];
  if (d.kind === "email") {
    if (d.subject.trim().length >= 6) out.push(d.subject.trim());
    for (const l of d.body.split("\n")) if (l.trim().length >= 20) out.push(l.trim());
    out.push(...d.to.filter((a) => a.includes("@")));
  } else if (d.kind === "crm") {
    for (const v of Object.values(d.fields)) if (typeof v === "string" && v.length >= 12) out.push(v);
    if (d.id) out.push(d.id);
  } else out.push(...d.targets.filter((t) => t.length >= 4));
  return out.slice(0, 40);
}

/** The card in words, for clients that don't draw a two-key card (and the audit trail of what the owner was shown). */
export function cardText(c: TwoKeyCard): string {
  const side = (s: TwoKeySide | undefined, label: string) => {
    if (!s) return `${label}: (none)`;
    if (s.noAction !== undefined) return `${label} (${s.name}, ${s.family}): no action. ${s.noAction}`;
    return `${label} (${s.name}, ${s.family}): ${s.draft ? brief(s.draft) : clip(s.raw ?? "(unreadable)", 300)}`;
  };
  return `${c.why}\n${side(c.a, "Draft A")}\n${side(c.b, "Draft B")}${c.diffs.length ? `\nDifferences: ${c.diffs.filter((d) => d.level !== "minor").map((d) => d.field).join(", ") || "wording only"}` : ""}`;
}

/** A bounded listing of a folder (two levels, no .git or node_modules): the "relevant inputs" for a delete. */
export function listFolder(dir: string, max = 150): string {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(join(dir, rel)).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= max) return;
      if (n === ".git" || n === "node_modules" || n === ".agent-room") continue;
      const p = rel ? `${rel}/${n}` : n;
      let dirLike = false;
      try { dirLike = statSync(join(dir, p)).isDirectory(); } catch { /* gone */ }
      out.push(dirLike ? `${p}/` : p);
      if (dirLike && depth < 2) walk(p, depth + 1);
    }
  };
  walk("", 0);
  return out.length ? `Files in the folder:\n${out.join("\n")}${out.length >= max ? "\n..." : ""}` : "";
}
