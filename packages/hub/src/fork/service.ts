import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentConfig, Author, Fork, ForkSideId, ForkSideRef, ForkSideView, ForkView, Goal, Room, ServerEvent, Task } from "@agent-room/shared";
import { SETTING_DEFAULTS } from "@agent-room/shared";
import type { RunResult } from "../adapters/types.js";
import type { Store } from "../db/store.js";
import { localModelsFor } from "../discovery/usage.js";
import type { FileBroker } from "../files/broker.js";
import { branchFor, type GoalSources } from "../files/goalSource.js";
import { familyOf } from "../jury/family.js";
import type { Library } from "../library/library.js";
import { readDocument } from "../library/frontmatter.js";
import { goalFolder } from "../orchestrator/workspace.js";
import { copyGrantedTree, type TaskWorkspaces } from "../orchestrator/worktree.js";
import type { RoomRules } from "../rooms/rules.js";
import { id, now } from "../util.js";
import { compareSides, type Dossier } from "./compare.js";
import { folderDeliverables, folderDeltas, gitDeliverables, type GitFn } from "./files.js";
import { mergeBranch, mergeIntoFolder, mergeProposal, type MergeOutcome } from "./merge.js";
import { defaultSplit, parseForkLine, resolveRoster, scrubber, sideBranch } from "./model.js";
import { getFork, listForks, recordForkOutcome, saveFork } from "./records.js";

/**
 * 4.4 Fork a goal: two rosters work the same goal, side by side, and the owner merges the better one.
 *
 * A fork is two ordinary goals in two lanes. A lane is a hidden room whose roster is the side's roster, so planning, routing, judging
 * (RoomRules.judgePool keeps the worker's own model family out), the agents a task may tag and the helpers it may spawn all stay inside
 * the side with the machinery 4.3 already has. Each lane works in its own base folder (a copy of the shared start), or in its own branch
 * of the owner's repository, so one side's files never reach the other.
 *
 * The orchestrator calls into this class in four places (see `forkHost()` there): the `/fork` command, `stopRoom`, `recover`, and the
 * roster override it installs on RoomRules. Everything else is observed from the goal events the store already emits.
 */

const SYS: Author = { kind: "system", id: "system", name: "System" };
const TERMINAL = new Set<Goal["status"]>(["done", "failed", "superseded"]);
const ACTIVE = new Set<Goal["status"]>(["planning", "awaiting_approval", "running", "paused"]);
const SIDES: ForkSideId[] = ["a", "b"];

export interface ForkHost {
  store: Store;
  dataDir: string;
  rooms: RoomRules;
  files: FileBroker;
  goalSources: GoalSources;
  library: Library;
  workspaces: TaskWorkspaces;
  /** Ready agents of a room (its roster, when it has one). */
  readyAgents(roomId?: string): Promise<AgentConfig[]>;
  /** Agents on probation take no real work. */
  realAgents(agents: AgentConfig[]): AgentConfig[];
  barred(agents: AgentConfig[]): Set<string>;
  advance(goalId: string): Promise<unknown>;
  stopGoal(goalId: string, summary?: string): boolean;
  decidePlan(goalId: string, decision: "approve" | "revise" | "cancel", text?: string): { ok: boolean; why?: string };
  /** Remove every worktree, clone and branch a goal still holds (it is idempotent). */
  cleanWorkspaces(goalId: string): Promise<void>;
  call(agent: AgentConfig, prompt: string, o?: { jsonOnly?: boolean; roomId?: string; signal?: AbortSignal }): Promise<RunResult>;
  quotaLimited(agentId: string): boolean;
  notify(p: { title: string; body: string; roomId: string; key: string }): void;
  rand: () => number;
}

export type StartInput = { roomId: string; text?: string; goalId?: string; rosterA?: string[]; rosterB?: string[]; folderGrantId?: string };
export type Failure = { ok: false; error: string; status: number };
const fail = (error: string, status = 400): Failure => ({ ok: false, error, status });

/** What RoomRules asks about a lane. */
export interface Lane { roster: string[]; parent: string; family(agentId: string): string[] }

export class Forks {
  private lanes = new Map<string, Lane | null>();
  private flights = new Map<string, Promise<unknown>>();
  private checks = new Map<string, Promise<unknown>>();
  private comparing = new Set<string>();
  /** Forks being merged: stopping the other side must not start a comparison. */
  private merging = new Set<string>();

  constructor(private host: ForkHost) {
    host.rooms.fork = (roomId) => this.laneOf(roomId);
    host.store.on("event", (e: ServerEvent) => { if (e.type === "goal" && e.goal.fork) this.onGoal(e.goal); });
  }

  private get store() { return this.host.store; }
  private get dir() { return join(this.host.dataDir, "forks"); }
  startDir(forkId: string) { return join(this.dir, forkId, "start"); }
  resultDir(forkId: string) { return join(this.dir, forkId, "result"); }

  // ---------------------------------------------------------------- lanes

  laneOf(roomId: string): Lane | undefined {
    if (this.lanes.has(roomId)) return this.lanes.get(roomId) ?? undefined;
    const room = this.store.getRoom(roomId);
    if (!room) return undefined;
    let lane: Lane | null = null;
    if (room.forkId) {
      const f = getFork(this.store, room.forkId);
      const s = f?.sides.find((x) => x.roomId === roomId);
      if (f && s) lane = this.makeLane(s.roster, f.roomId);
    }
    this.lanes.set(roomId, lane);
    return lane ?? undefined;
  }
  private makeLane(roster: string[], parent: string): Lane {
    const store = this.store;
    return {
      roster, parent,
      // The agents that share this agent's model family: a judge for its work is never one of them.
      family: (agentId) => {
        const all = store.listAgents(), me = all.find((a) => a.id === agentId);
        if (!me) return [];
        const local = localModelsFor(store), fam = familyOf(me, local);
        return all.filter((a) => a.id !== agentId && familyOf(a, local) === fam).map((a) => a.id);
      },
    };
  }

  private say(roomId: string, text: string, forkId?: string) {
    this.store.addMessage({ roomId, author: SYS, type: "system", text, mentions: [], ...(forkId ? { forkId } : {}) });
  }
  private nameOf(agentId: string) { return this.store.getAgent(agentId)?.name ?? agentId; }
  private rosterText(ids: string[]) { return ids.map((x) => this.nameOf(x)).join(", "); }

  // ---------------------------------------------------------------- starting

  /** `/fork ...` typed in a room. Problems are answered in the room; nothing is thrown. */
  async fromCommand(roomId: string, line: string): Promise<void> {
    const p = parseForkLine(line);
    if (!p.ok) { this.say(roomId, p.error); return; }
    const r = await this.start({ roomId, ...p.req });
    if (!r.ok) this.say(roomId, r.error);
  }

  async start(i: StartInput): Promise<{ ok: true; fork: Fork } | Failure> {
    const { store, host } = this;
    const room = store.getRoom(i.roomId);
    if (!room) return fail("Room not found.", 404);
    if (room.dmAgentId) return fail("A fork needs a room with a team. Start it in a channel, not a direct message.");
    if (room.forkId) return fail("This is one side of a fork already. Start the new fork from the room it came from.");

    // The goal being forked: named, or the room's current or last goal.
    let source: Goal | undefined;
    if (i.goalId) {
      source = store.getGoal(i.goalId);
      if (!source) return fail("That goal doesn't exist.", 404);
      if (source.roomId !== room.id) return fail("That goal belongs to another room.");
      if (source.fork) return fail("That goal is one side of a fork already.");
    } else if (!i.text?.trim()) {
      const goals = store.listGoals(room.id).filter((g) => !g.fork);
      source = goals.find((g) => ACTIVE.has(g.status)) ?? goals.sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!source) return fail("There is no goal to fork yet. Give one: /fork <goal> | rosterA: claude,codex | rosterB: hermes,muse");
    }
    const text = (i.text?.trim() || source?.text || "").slice(0, 20000);
    if (!text) return fail("Say what to fork: a goal text or a goal.");

    // Rosters: named, else split the room's ready agents so each side has different vendors where possible.
    const pool = host.realAgents(await host.readyAgents(room.id));
    const known = store.listAgents().filter((a) => a.enabled);
    const named = (names: string[] | undefined, label: string): { ids: string[] } | Failure => {
      if (!names?.length) return { ids: [] };
      const r = resolveRoster(names, known);
      if (r.unknown.length) return fail(`Roster ${label}: I don't know ${r.unknown.map((x) => `"${x}"`).join(", ")}. Agents that are on: ${known.map((a) => a.id).join(", ")}.`);
      const out = r.ids.filter((x) => !host.rooms.allows(room.id, x));
      if (out.length) return fail(`Roster ${label}: ${out.map((x) => this.nameOf(x)).join(", ")} ${out.length === 1 ? "isn't" : "aren't"} in this room. Change who is here in ROOM.md (or under room settings).`);
      return { ids: r.ids };
    };
    const ra = named(i.rosterA, "A"); if ("error" in ra) return ra;
    const rb = named(i.rosterB, "B"); if ("error" in rb) return rb;
    let rosterA = ra.ids, rosterB = rb.ids;
    if (!rosterA.length || !rosterB.length) {
      const local = localModelsFor(store);
      const rest = pool.filter((a) => !rosterA.includes(a.id) && !rosterB.includes(a.id));
      if (rosterA.length || rosterB.length) {
        // One roster was named: the other is whoever is left.
        const mine = rosterA.length ? rosterA : rosterB;
        const left = rest.map((a) => a.id);
        if (!left.length) return fail(`Roster ${rosterA.length ? "B" : "A"} would be empty: every ready agent is on the other roster. Name it yourself.`);
        if (rosterA.length) rosterB = left; else rosterA = left;
        void mine;
      } else {
        const split = defaultSplit(rest, (a) => familyOf(a, local));
        if ("error" in split) return fail(split.error);
        rosterA = split.a; rosterB = split.b;
      }
    }

    // The starting folder: the owner's granted folder (the forked goal's, or the one picked), else the forked goal's own folder.
    const grantId = i.folderGrantId ?? source?.sourceGrantId;
    const grant = grantId ? host.files.grant(grantId) : undefined;
    if (grantId) {
      const u = host.goalSources.usable(grantId, room.id);
      if (!u.ok) return fail(u.reason);
    }
    const fid = id("fork");
    const targetId = source?.id ?? fid;
    let kind: Fork["target"]["kind"] = "hub";
    let startSha: string | undefined;
    if (grant?.write) {
      const git = this.ownerGit(grant.path);
      const top = await git(["rev-parse", "--show-toplevel"]);
      let isRoot = false;
      try { isRoot = top.code === 0 && resolve(top.stdout.trim()) === resolve(grant.path); } catch { isRoot = false; }
      const head = isRoot ? await git(["rev-parse", "--verify", "-q", "HEAD"]) : undefined;
      if (head?.code === 0) { kind = "git"; startSha = head.stdout.trim(); } else kind = "copy";
    }

    // Folders: the start state is copied once (kept to compare against) and once per side. A git folder needs none: each side clones the repo.
    const start = this.startDir(fid);
    mkdirSync(start, { recursive: true });
    try {
      if (kind !== "git") {
        const from = grant ? grant.path : source?.folder && existsSync(source.folder) ? source.folder : undefined;
        if (from) copyGrantedTree(from, start);
      }
    } catch (e) { rmSync(join(this.dir, fid), { recursive: true, force: true }); return fail(e instanceof Error ? e.message : "The starting folder couldn't be copied."); }

    const created = now();
    const refs: ForkSideRef[] = [];
    const rooms: Room[] = [], goals: Goal[] = [];
    for (const side of SIDES) {
      const roster = side === "a" ? rosterA : rosterB;
      const roomId = id("room"), goalId = id("goal");
      const branch = kind === "git" ? sideBranch(targetId, side) : undefined;
      rooms.push({ id: roomId, name: `fork-${fid.slice(5, 11)}-${side}`, paused: false, createdAt: created, forkId: fid, forkSide: side, forkOf: room.id });
      goals.push({
        id: goalId, roomId, text, status: "planning", createdAt: created, fork: { id: fid, side },
        ...(kind === "git" && grant ? { sourceGrantId: grant.id, sourceBranch: branch, ...(source?.sourceGrantId === grant.id ? { sourceFrom: source.sourceBranch ?? branchFor(source.id) } : {}) } : {}),
      });
      refs.push({ side, roster, roomId, goalId, ...(branch ? { branch } : {}) });
    }
    const target: Fork["target"] = kind === "git"
      ? { kind, goalId: source?.id, grantId: grant!.id, branch: branchFor(targetId), startSha }
      : kind === "copy" ? { kind, goalId: source?.id, grantId: grant!.id }
      : { kind, goalId: source?.id, folder: source?.folder && !grant ? source.folder : this.resultDir(fid) };
    const reqs = (source?.contract?.requirements ?? []).map((r) => r.text).filter(Boolean).slice(0, 12);
    const fork: Fork = { id: fid, roomId: room.id, text, createdAt: created, ...(source ? { sourceGoalId: source.id } : {}), sides: refs, target, requirements: reqs };

    // The fork first, so a lane is known the moment its room exists.
    saveFork(store, fork);
    refs.forEach((s, k) => this.lanes.set(s.roomId, this.makeLane(s.roster, room.id)));
    for (const r of rooms) store.saveRoom(r);
    const half = Math.max(4, Math.floor((store.getSettings().maxTaskRuns ?? SETTING_DEFAULTS.maxTaskRuns) / 2));
    for (let k = 0; k < goals.length; k++) {
      if (kind !== "git") { try { copyGrantedTree(start, goalFolder(host.dataDir, goals[k].id)); } catch { /* an empty start is still a start */ } }
      goals[k].state = { decisions: [{ at: created, text: `Side ${SIDES[k].toUpperCase()} of a fork.` }], nextAction: "Planning.", progress: { runs: 0, stall: 0, goalReplans: 0, verifyRounds: 0, budget: half } }; // the run budget is split between the two sides
      store.saveGoal(goals[k]);
    }
    store.audit("owner", "fork.started", `${fid} in ${room.id}: A ${rosterA.join(",")} / B ${rosterB.join(",")} (${kind})`.slice(0, 400));
    this.say(room.id, `Forking "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}" into two lanes.\nSide A: ${this.rosterText(rosterA)}\nSide B: ${this.rosterText(rosterB)}\nBoth work on their own copy. When both are done they are compared without anyone knowing which team made which, and you choose which one to merge.`, fid);

    const runs = Promise.allSettled(goals.map((g) => host.advance(g.id)));
    this.flights.set(fid, runs);
    void runs.then(() => { this.schedule(fid); });
    return { ok: true, fork };
  }

  private ownerGit(repo: string): GitFn { return (args) => this.host.workspaces.git(repo, args, undefined, true); }

  // ---------------------------------------------------------------- watching the sides

  private onGoal(g: Goal) {
    const f = g.fork!;
    const p = g.state?.progress;
    if (p && p.budget === undefined) {
      // The plan resets a goal's progress; the side's share of the run budget goes back on it.
      const cur = this.store.getGoal(g.id);
      if (cur?.state?.progress && cur.state.progress.budget === undefined) {
        cur.state.progress.budget = Math.max(4, Math.floor((this.store.getSettings().maxTaskRuns ?? SETTING_DEFAULTS.maxTaskRuns) / 2));
        this.store.saveGoal(cur);
      }
    }
    if (TERMINAL.has(g.status)) this.schedule(f.id);
  }

  private schedule(forkId: string) {
    const prev = this.checks.get(forkId) ?? Promise.resolve();
    const p: Promise<unknown> = prev.then(() => this.check(forkId)).catch((e) => { this.store.audit("hub", "fork.error", `${forkId}: ${String(e).slice(0, 300)}`); }).finally(() => { if (this.checks.get(forkId) === p) this.checks.delete(forkId); });
    this.checks.set(forkId, p);
  }

  /** Both sides done and no comparison yet: compare. Also notes when each side finished. */
  private async check(forkId: string) {
    const f = getFork(this.store, forkId);
    if (!f || f.merged || this.merging.has(forkId)) return;
    let changed = false;
    for (const s of f.sides) {
      const g = this.store.getGoal(s.goalId);
      if (g && TERMINAL.has(g.status) && !s.endedAt) { s.endedAt = now(); changed = true; }
    }
    if (changed) saveFork(this.store, f);
    const both = f.sides.every((s) => { const g = this.store.getGoal(s.goalId); return !!g && TERMINAL.has(g.status); });
    if (!both || f.comparison || this.comparing.has(f.id)) return;
    await this.runCompare(f.id);
  }

  /** Re-run the comparison (the owner asked, or it failed before). */
  async recompare(forkId: string): Promise<{ ok: true } | Failure> {
    const f = getFork(this.store, forkId);
    if (!f) return fail("Fork not found.", 404);
    if (f.merged) return fail("This fork was already merged.", 409);
    if (!f.sides.every((s) => TERMINAL.has(this.store.getGoal(s.goalId)?.status ?? "failed"))) return fail("Both sides need to finish first.", 409);
    if (this.comparing.has(f.id)) return fail("The comparison is running.", 409);
    delete f.comparison; saveFork(this.store, f);
    await this.runCompare(f.id);
    return { ok: true };
  }

  private async runCompare(forkId: string) {
    const { store, host } = this;
    let f = getFork(store, forkId); if (!f) return;
    this.comparing.add(forkId);
    f.comparing = true; saveFork(store, f);
    try {
      const goals = f.sides.map((s) => store.getGoal(s.goalId)!);
      const requirements = this.requirementsOf(f, goals);
      const dossiers = await Promise.all(f.sides.map((s) => this.dossierOf(f!, s)));
      const everyone = [...new Set(f.sides.flatMap((s) => s.roster))].map((x) => store.getAgent(x)).filter((a): a is AgentConfig => !!a);
      const scrub = scrubber(store.listAgents());
      const empty = (d: Dossier) => !d.summary.trim() && !d.files.length && !d.docs.length;
      const cmp = empty(dossiers[0]) && empty(dossiers[1])
        ? { id: id("cmp"), at: now(), state: "failed" as const, preference: "unclear" as const, agreement: false, reasons: [], requirements: requirements.map((text) => ({ text, a: "UNSURE" as const, b: "UNSURE" as const })), passes: [], independence: "full" as const, note: "Neither side produced a result to compare." }
        : await compareSides({ store, readyAgents: () => host.readyAgents(), call: (a, p, o) => host.call(a, p, { ...o, roomId: f!.roomId }), quotaLimited: (x) => host.quotaLimited(x), rand: host.rand, barred: (a) => host.barred(a) },
          { goal: f.text, requirements, a: dossiers[0], b: dossiers[1], workers: everyone, scrub });
      f = getFork(store, forkId) ?? f;
      f.comparison = cmp; f.requirements = requirements; f.comparing = false;
      saveFork(store, f);
      store.audit("jury", "fork.compared", `${forkId}: ${cmp.state}, prefers ${cmp.preference}${cmp.agreement ? "" : " (orders disagree)"}`);
      const pref = cmp.preference === "a" || cmp.preference === "b" ? `The judges lean to side ${cmp.preference.toUpperCase()}` : cmp.preference === "tie" ? "The judges see no difference between them" : "The judges couldn't pick one";
      this.say(f.roomId, `Both sides of the fork are done. ${pref}${cmp.agreement && (cmp.preference === "a" || cmp.preference === "b") ? " (the same answer in both orders)" : ""}. Open the fork to compare them side by side and merge one. The pick is a suggestion; you choose.`, f.id);
      host.notify({ title: "A fork is ready to compare", body: f.text.slice(0, 160), roomId: f.roomId, key: `fork:${f.id}` });
    } finally {
      this.comparing.delete(forkId);
      const again = getFork(store, forkId);
      if (again?.comparing) { again.comparing = false; saveFork(store, again); }
    }
  }

  /** What both sides are checked against: the forked goal's contract, else the union of the two sides' contracts. */
  private requirementsOf(f: Fork, goals: Goal[]): string[] {
    if (f.requirements.length) return f.requirements;
    const seen = new Set<string>(), out: string[] = [];
    for (const g of goals) for (const r of g.contract?.requirements ?? []) {
      const k = r.text.trim().toLowerCase().replace(/\s+/g, " ");
      if (k && !seen.has(k)) { seen.add(k); out.push(r.text.trim()); }
    }
    return (out.length ? out : [f.text]).slice(0, 12);
  }

  private async deliverables(f: Fork, s: ForkSideRef): Promise<{ files: ForkSideView["deliverables"]["files"]; more: number }> {
    if (f.target.kind === "git" && s.branch && f.target.startSha && f.target.grantId) {
      const grant = this.host.files.grant(f.target.grantId);
      if (!grant) return { files: [], more: 0 };
      const d = await gitDeliverables(this.ownerGit(grant.path), f.target.startSha, s.branch);
      return d ? { files: d.files, more: d.more } : { files: [], more: 0 };
    }
    const folder = this.store.getGoal(s.goalId)?.folder;
    return folder && existsSync(folder) ? folderDeliverables(this.startDir(f.id), folder) : { files: [], more: 0 };
  }

  private docsOf(s: ForkSideRef) {
    return this.host.library.list({ goalId: s.goalId });
  }

  private async dossierOf(f: Fork, s: ForkSideRef): Promise<Dossier> {
    const g = this.store.getGoal(s.goalId);
    const d = await this.deliverables(f, s);
    const docs = this.docsOf(s).slice(0, 4).map((doc) => {
      let body = "";
      try { body = readDocument(readFileSync(doc.path, "utf8"))?.body ?? ""; } catch { /* gone */ }
      return { title: doc.frontMatter.title, body };
    });
    // The goal's own check lines (its self-reported "met" marks and the judging line) say how the side did; the judges read the work.
    const summary = (g?.summary ?? "").split(/\n\n(?=[✓⚠])/u)[0];
    return { summary, files: d.files.map((x) => ({ path: x.path, change: x.change, diff: x.diff, binary: x.binary })), docs };
  }

  // ---------------------------------------------------------------- the view

  list(roomId?: string): Fork[] { return listForks(this.store, roomId); }
  get(forkId: string): Fork | undefined { return getFork(this.store, forkId); }

  async view(forkId: string): Promise<ForkView | undefined> {
    const { store } = this;
    const f = getFork(store, forkId);
    if (!f) return undefined;
    const sides: ForkSideView[] = [];
    for (const s of f.sides) sides.push(await this.sideView(f, s));
    const finished = sides.map((x) => ["done", "failed", "superseded"].includes(x.status));
    const waiting = sides.some((x) => x.awaitingApproval || !!x.waitingOnOwner);
    const state: ForkView["state"] = f.merged ? "merged" : f.comparison ? "compared" : waiting ? "waiting" : "running";
    const grant = f.target.grantId ? this.host.files.grant(f.target.grantId) : undefined;
    return {
      id: f.id, roomId: f.roomId, text: f.text, state, createdAt: f.createdAt, ...(f.sourceGoalId ? { sourceGoalId: f.sourceGoalId } : {}),
      target: { kind: f.target.kind, ...(f.target.branch ? { branch: f.target.branch } : {}), label: f.target.kind === "hub" ? "the goal's folder in the hub" : grant ? (grant.label ?? basename(grant.path)) : undefined },
      sides, requirements: f.comparison?.requirements.map((r) => r.text) ?? f.requirements, ...(f.comparison ? { comparison: f.comparison } : {}), comparing: !!f.comparing || this.comparing.has(f.id),
      ...(f.merged ? { merged: f.merged } : {}),
      ...(f.merged ? { mergeBlocked: "This fork was already merged." } : !finished.some(Boolean) ? { mergeBlocked: "Wait for a side to finish before merging it." } : {}),
    };
  }

  private async sideView(f: Fork, s: ForkSideRef): Promise<ForkSideView> {
    const { store } = this;
    const g = store.getGoal(s.goalId);
    const tasks = store.listTasks({ goalId: s.goalId });
    const live = tasks.filter((t) => !(t.recovered && t.status !== "done"));
    const rec = store.listRouting({ goalId: s.goalId });
    const cost = rec.reduce((a, r) => ({ runs: a.runs + 1, inputTokens: a.inputTokens + (r.usage?.inputTokens ?? 0), outputTokens: a.outputTokens + (r.usage?.outputTokens ?? 0), costUsd: a.costUsd + (r.usage?.costUsd ?? 0) }), { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const d = await this.deliverables(f, s);
    const startedAt = g?.createdAt ?? f.createdAt;
    const accepted = live.filter((t) => t.status === "done").map((t: Task) => ({ id: t.id, title: t.title, ...(t.assignee ? { agentId: t.assignee, agentName: this.nameOf(t.assignee) } : {}), taskType: t.taskType, ...(t.judgment ? { score: t.judgment.score } : {}) }));
    return {
      side: s.side, roomId: s.roomId, goalId: s.goalId,
      roster: s.roster.map((x) => { const a = store.getAgent(x); return { id: x, name: a?.name ?? x, color: a?.color ?? "#5e6875" }; }),
      status: g?.status ?? "failed", ...(g?.summary ? { summary: g.summary } : {}), ...(g?.state?.waitingOnOwner ? { waitingOnOwner: g.state.waitingOnOwner } : {}),
      awaitingApproval: g?.status === "awaiting_approval", archived: !!s.archived,
      tasks: { total: live.length, done: live.filter((t) => t.status === "done").length },
      accepted,
      requirements: (g?.contract?.requirements ?? []).map((r) => ({ id: r.id, text: r.text, status: r.status ?? "open" as const })),
      deliverables: { files: d.files, docs: this.docsOf(s).map((x) => ({ id: x.id, title: x.frontMatter.title, status: x.frontMatter.status, relPath: x.relPath })), more: d.more },
      cost: { ...cost, costUsd: Math.round(cost.costUsd * 10000) / 10000 },
      time: { startedAt, ...(s.endedAt ? { endedAt: s.endedAt } : {}), seconds: Math.max(0, Math.round(((s.endedAt ?? now()) - startedAt) / 1000)) },
      ...(s.branch ? { branch: s.branch } : {}),
    };
  }

  // ---------------------------------------------------------------- the owner's controls

  /** Approve the plan of every side that is waiting for one (the owner's setting asked for approval). */
  approvePlans(forkId: string): { ok: true; approved: number } | Failure {
    const f = getFork(this.store, forkId);
    if (!f) return fail("Fork not found.", 404);
    let n = 0;
    for (const s of f.sides) if (this.store.getGoal(s.goalId)?.status === "awaiting_approval" && this.host.decidePlan(s.goalId, "approve").ok) n++;
    if (n) this.store.audit("owner", "fork.plans.approved", `${forkId}: ${n}`);
    return { ok: true, approved: n };
  }

  /** `/stop` in the room the fork came from stops both sides. */
  stopRoom(roomId: string) {
    for (const f of listForks(this.store, roomId)) if (!f.merged) for (const s of f.sides) if (ACTIVE.has(this.store.getGoal(s.goalId)?.status ?? "done")) this.host.stopGoal(s.goalId, "Stopped with the room.");
  }

  /** After a restart: lanes are known again, and any fork whose sides finished without a comparison gets one. */
  sweep() {
    for (const f of listForks(this.store)) if (!f.merged) this.schedule(f.id);
  }

  /** Wait for both sides and the comparison (tests, shutdown). */
  async settled(forkId: string) {
    await this.flights.get(forkId);
    for (let i = 0; i < 50 && this.checks.get(forkId); i++) await this.checks.get(forkId);
  }

  // ---------------------------------------------------------------- merge

  async merge(forkId: string, sideId: ForkSideId): Promise<{ ok: true; view: ForkView } | Failure> {
    if (this.merging.has(forkId)) return fail("A merge is already running.", 409);
    this.merging.add(forkId);
    try { return await this.mergeNow(forkId, sideId); } finally { this.merging.delete(forkId); }
  }

  private async mergeNow(forkId: string, sideId: ForkSideId): Promise<{ ok: true; view: ForkView } | Failure> {
    const { store, host } = this;
    const f = getFork(store, forkId);
    if (!f) return fail("Fork not found.", 404);
    if (f.merged) return fail("This fork was already merged.", 409);
    const side = f.sides.find((s) => s.side === sideId), rest = f.sides.find((s) => s.side !== sideId);
    if (!side || !rest) return fail("Choose side a or b.");
    const goal = store.getGoal(side.goalId);
    if (!goal || !TERMINAL.has(goal.status)) return fail(`Side ${sideId.toUpperCase()} is still working. Wait for it to finish, or merge the other side.`, 409);
    const src = f.target.goalId ? store.getGoal(f.target.goalId) : undefined;
    if (src && ACTIVE.has(src.status)) return fail("The goal this fork came from is still running. Stop it or let it finish before merging.", 409);

    let out: MergeOutcome;
    const sideFolder = goal.folder ?? goalFolder(host.dataDir, goal.id);
    if (f.target.kind === "git" || f.target.kind === "copy") {
      const grant = f.target.grantId ? host.files.grant(f.target.grantId) : undefined;
      if (!grant || !host.goalSources.usable(grant.id, f.roomId).ok) return fail("The folder this fork worked on is no longer open to it, so nothing can be merged into it.", 409);
      if (!grant.write) return fail("That folder isn't open for writing any more, so nothing can be merged into it.", 409);
      if (f.target.kind === "git") {
        if (!side.branch) return fail("That side has no branch to merge.", 409);
        out = await mergeBranch(this.ownerGit(grant.path), side.branch, f.target.branch!);
      } else {
        const lead = side.roster.find((x) => store.getAgent(x)) ?? "claude";
        out = mergeProposal(host.files, { grantId: grant.id, agentId: lead, roomId: f.roomId, goalId: f.target.goalId ?? goal.id, forkId: f.id, title: `Fork result, side ${sideId.toUpperCase()}: ${f.text.slice(0, 60)}`, startDir: this.startDir(f.id), sideFolder });
      }
    } else {
      out = mergeIntoFolder(this.startDir(f.id), sideFolder, f.target.folder ?? this.resultDir(f.id));
    }
    if (!out.ok) return out;

    // The other side is archived: stopped if it was still going, its work folders cleaned, its documents marked superseded. Its files stay for comparison.
    if (ACTIVE.has(store.getGoal(rest.goalId)?.status ?? "done")) host.stopGoal(rest.goalId, "The other side of the fork was merged.");
    await host.cleanWorkspaces(rest.goalId);
    await host.cleanWorkspaces(side.goalId);
    for (const doc of this.docsOf(rest)) host.library.setStatus(doc.id, "superseded");
    const fresh = getFork(store, forkId) ?? f;
    fresh.sides = fresh.sides.map((s) => (s.side === rest.side ? { ...s, archived: true } : s));
    fresh.merged = { side: sideId, at: now(), ...out.merge };
    saveFork(store, fresh);
    if (src && f.target.kind === "hub" && goal.summary) { src.summary = goal.summary; store.saveGoal(src); } // the goal's result is now the chosen side's

    // The outcome is a signal for routing: the winning roster on the task types either side worked on. It is a recorded preference, never a judge score.
    const types = f.sides.flatMap((s) => store.listTasks({ goalId: s.goalId }).filter((t) => t.status === "done").map((t) => t.taskType));
    recordForkOutcome(store, f.id, side.roster, rest.roster, types, now());
    store.audit("owner", "fork.merged", `${forkId}: side ${sideId} (${out.merge.how}) ${out.merge.detail}`.slice(0, 400));
    this.say(f.roomId, `Merged side ${sideId.toUpperCase()} (${this.rosterText(side.roster)}). ${out.merge.detail} Side ${rest.side.toUpperCase()} is archived; its results stay in the fork.`, f.id);
    return { ok: true, view: (await this.view(forkId))! };
  }
}
