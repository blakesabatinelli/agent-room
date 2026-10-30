import type { AgentConfig, Goal, Judgment, NightShiftNight, NightShiftSettings, NightShiftState, RoutingOutcome, RoutingRecord, Task, TournamentRun } from "@agent-room/shared";
import { TaintTracker } from "../security/taint.js"; // S12
import { attentionFor } from "../attention/index.js";
import type { Store } from "../db/store.js";
import { localModelsFor } from "../discovery/usage.js";
import { WORKSPACE_NEED, needsWorkspace, runsHere } from "../placement/index.js"; // a re-run of folder work goes only to agents on this Mac
import { resolveModelVersion } from "../orchestrator/versions.js";
import { recordOutcome } from "../orchestrator/scoring.js";
import type { GoalRef, TaskWorkspace, TaskWorkspaces } from "../orchestrator/worktree.js";
import { quotaFor } from "../quota/index.js";
import type { ShadowRunner } from "../resume/index.js";
import { id } from "../util.js";
import { evidenceCount, headToHead, nightLine } from "./headToHead.js";
import { judgePair, outsideBoth, type BlindHost, type PairEntry } from "./judge.js";
import { emptyNight, getNight, getSource, listNights, listTournaments, saveNight, saveSource, saveTournament } from "./records.js";
import { nightOf, nightSettings } from "./settings.js";

/**
 * 4.5 Night-shift tournaments (PRODUCT.md 6.9). Quota that would otherwise expire overnight re-runs the day's accepted tasks on the agents
 * that did not get them, and the two results are graded blind next to each other, for clean head-to-head data.
 *
 * Every ~15 minutes inside the owner's night window (`nightShift` in settings, off by default; the time zone is the attention gate's):
 *  1. For each subscription with a known limit whose current window would lose at least `minExpiringShare` of its capacity at the next reset
 *     (the quota tracker's `expiresSoon`), look at the tasks accepted in the last 24 hours. A task qualifies when its goal has ended, it needs no
 *     approvals or outside tools (a re-run is refused both), and the commit it started from is still in the goal's repository.
 *  2. Pick the (task, agent) pair the log knows least about: an agent that did not do the task, is idle, admitted by the capacity governor and
 *     not out of quota, on the task type and pair of agents with the fewest head-to-head runs so far.
 *  3. Re-run it through the shadow runner: the agent's own worktree cut from the task's starting commit, thrown away afterwards, never merged,
 *     nothing said in the room, every approval refused, and no look at the goal's later state (no progress ledger, no later decisions).
 *  4. Judge the original accepted result and the re-run blind (judge.ts), record a `tournaments` row, and feed the re-run to the challenger's
 *     scores (`recordOutcome`, by model version, at the configured weight). The original agent's scores are not touched: it was already
 *     graded for that work, and counting it again would be counting it twice.
 * Nothing reaches the owner during the night. When it is over, one line goes to the digest ("Night shift: 9 head-to-head runs on spare quota; ...").
 */

export const NIGHT_TUNING = {
  /** How often the hub looks, inside the window. */
  everyMs: 15 * 60_000,
  /** Accepted tasks from this long ago are re-run candidates. */
  lookbackMs: 24 * 3600_000,
  /** A running re-run is stopped when the window closes: checked this often. */
  pollMs: 15_000,
};
const DAY = 86_400_000;

/** What the night shift may use of the orchestrator. */
export interface NightHost extends BlindHost {
  workspaces: Pick<TaskWorkspaces, "hasCommit" | "git">;
  /** The goal's work folder reference (granted folder included), as real tasks use. */
  ref(goal: Goal): GoalRef;
  /** Is the agent holding a task or answering chat? With `set`, mark it busy or free. */
  busy(agentId: string, set?: boolean): boolean;
  governor: { admit(a: AgentConfig): boolean; start(key: string, a: AgentConfig): void; release(key: string): void };
  notes(goalId: string): string[];
}
export interface NightShiftDeps { store: Store; shadows: ShadowRunner; host: NightHost }

interface Candidate { task: Task; goal: Goal; rec: RoutingRecord; commit: string; original: AgentConfig; challenger: AgentConfig; thin: number }

const GOAL_OVER: ReadonlySet<Goal["status"]> = new Set(["done", "failed"]);
const firstLine = (e?: string) => (e ?? "unknown error").split("\n").find((l) => l.trim())?.slice(0, 300) ?? "unknown error";

export class NightShift {
  /** The time. Tests swap it for a fake clock. */
  clock: () => number = () => Date.now();
  /** Randomness for the order the judges see the two results in. Tests swap it. */
  rand: () => number = Math.random;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = new AbortController();
  /** Pairs already tried tonight in this process (a run that was cut short is not retried the same night). */
  private tried = new Set<string>();

  constructor(private d: NightShiftDeps) {}

  private get store() { return this.d.store; }
  private zone() { return attentionFor(this.store).settings().timezone; }

  settings(): NightShiftSettings & { timezone: string } { return { ...nightSettings(this.store), timezone: this.zone() }; }

  // ---- the two hooks the orchestrator calls for every real task

  /** HOOK: a real task's worktree was just cut. Remembers the commit it started from (the starting state a re-run needs). Never throws. */
  async opened(task: Pick<Task, "id" | "goalId">, ws: TaskWorkspace & { reused: boolean }, agentId: string): Promise<void> {
    try {
      if (ws.reused || ws.kind !== "git") return; // a revision keeps its worktree (and the first commit); a folder copy has no commit to start from
      const r = await this.d.host.workspaces.git(ws.path, ["rev-parse", "HEAD"]);
      const head = r.code === 0 ? r.stdout.trim() : "";
      if (!/^[0-9a-f]{40,64}$/i.test(head)) return;
      saveSource(this.store, { taskId: task.id, goalId: task.goalId, baseCommit: head, mode: ws.mode === "granted-git" ? "granted-git" : "plain", agentId, openedAt: this.clock() });
    } catch { /* the night shift never breaks a task */ }
  }

  /** HOOK: the task was accepted and merged. Keeps what the accepted attempt handed back, as the judge saw it (the folder moves on). Never throws. */
  accepted(task: Pick<Task, "id">, agentId: string, changed: string[], files: string): void {
    try {
      const s = getSource(this.store, task.id);
      if (!s) return;
      saveSource(this.store, { ...s, agentId, changed: changed.slice(0, 200), files, acceptedAt: this.clock() });
    } catch { /* ditto */ }
  }

  // ---- the loop

  start(everyMs = NIGHT_TUNING.everyMs) {
    this.stop();
    this.stopped = new AbortController();
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, everyMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopped.abort();
  }

  /** Is `at` inside the night window? */
  private night(at: number, cfg: NightShiftSettings): string | undefined { return nightOf(at, this.zone(), cfg.from, cfg.to); }

  /**
   * One look. Hands the digest the line for a night that is over, and, inside the window, runs re-runs until nothing qualifies, the night's
   * cap is reached or the window closes. Safe to call as often as you like; two calls never overlap.
   */
  async tick(): Promise<{ started: number }> {
    if (this.ticking) return { started: 0 };
    this.ticking = true;
    try {
      const cfg = nightSettings(this.store);
      const night = this.night(this.clock(), cfg);
      this.reportFinished(night);
      if (!cfg.enabled || !night) return { started: 0 };
      const n = getNight(this.store, night) ?? emptyNight(night, this.clock());
      let started = 0;
      while (n.runs < cfg.maxRunsPerNight && !this.stopped.signal.aborted && this.night(this.clock(), cfg) === night) {
        const pick = await this.pick(this.clock(), cfg, n);
        saveNight(this.store, n);
        if (!pick) break;
        await this.run(pick, n, cfg);
        started++;
      }
      return { started };
    } finally { this.ticking = false; }
  }

  /** The digest gets one line for every finished night that ran something. */
  private reportFinished(current: string | undefined) {
    for (const n of listNights(this.store)) {
      if (n.reported || n.night === current) continue;
      const line = nightLine(this.store, n.night);
      if (line) attentionFor(this.store).notify("report", { title: line, key: `nightshift:${n.night}` });
      saveNight(this.store, { ...n, reported: true, ...(line ? { line } : {}) });
    }
  }

  // ---- choosing

  /** The accepted real tasks of the last day, newest first: one record per task (the attempt that was accepted). */
  private acceptedRecords(now: number): RoutingRecord[] {
    const since = now - NIGHT_TUNING.lookbackMs;
    const byTask = new Map<string, RoutingRecord>();
    for (const r of this.store.listRouting({ since: since - 2 * DAY })) {
      const t = r.completedAt ?? r.at;
      if (r.kind !== "task" || r.outcome !== "accepted" || t < since || t > now) continue;
      const have = byTask.get(r.taskId);
      if (!have || (have.completedAt ?? have.at) < t) byTask.set(r.taskId, r);
    }
    return [...byTask.values()].sort((a, b) => (b.completedAt ?? b.at) - (a.completedAt ?? a.at));
  }

  /** Agents that already did this task, for real or as a copy or a re-run: they have nothing new to add. */
  private haveDone(now: number): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const add = (taskId: string, agentId: string) => { const s = out.get(taskId) ?? new Set(); s.add(agentId); out.set(taskId, s); };
    for (const r of this.store.listRouting({ since: now - 10 * DAY })) {
      if (r.kind === "task") add(r.taskId, r.chosen);
      else if (r.kind === "shadow" && r.shadowOf && r.outcome !== "interrupted" && r.outcome !== "pending") add(r.shadowOf, r.chosen);
    }
    for (const t of listTournaments(this.store, { since: now - 10 * DAY })) add(t.taskId, t.challenger.agentId);
    return out;
  }

  /** Did the agent that did this task ask for an approval, or a question answered, while it worked? Re-runs are refused both. */
  private askedApproval(rec: RoutingRecord, task: Task, now: number): boolean {
    const from = rec.at - 1000, to = (rec.completedAt ?? now) + 60_000;
    return this.store.listApprovals().some((a) => a.agentId === rec.chosen && (a.roomId ?? task.roomId) === task.roomId && a.createdAt >= from && a.createdAt <= to);
  }

  private async pick(now: number, cfg: NightShiftSettings, night: NightShiftNight): Promise<Candidate | undefined> {
    const { store, host } = this.d;
    const quota = quotaFor(store);
    const skipped: Record<string, number> = {};
    const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
    const localModels = localModelsFor(store);
    const limited = (agentId: string) => host.quotaLimited(agentId, now);
    // Spare capacity: one of the agent's own subscriptions has a known limit and will lose a good share of it at its next reset.
    const spare = (a: AgentConfig) => quota.subscriptionsOf(a.id).some((s) => s.kind !== "local" && !quota.predictLimited(s, now).limited && quota.expiresSoon(s, now) >= cfg.minExpiringShare);

    const done = this.haveDone(now);
    const past = listTournaments(store, { since: now - 90 * DAY });
    const readyBy = new Map<string | undefined, AgentConfig[]>();
    const ready = async (roomId?: string) => { if (!readyBy.has(roomId)) readyBy.set(roomId, await host.readyAgents(roomId)); return readyBy.get(roomId)!; };

    let best: Candidate | undefined;
    for (const rec of this.acceptedRecords(now)) {
      const task = store.getTask(rec.taskId), original = store.getAgent(rec.chosen);
      if (!task || task.status !== "done" || !original) continue;
      const goal = store.getGoal(task.goalId);
      if (!goal) continue;
      if (!GOAL_OVER.has(goal.status)) { skip("goal still active"); continue; }
      if (task.needs?.some((n) => n !== WORKSPACE_NEED) || this.askedApproval(rec, task, now)) { skip("needs approvals or outside tools"); continue; }
      // S12: a task that touched private data stays with the vendor that saw it, unless the owner allowed re-runs of such tasks.
      if (!cfg.allowLabeledData && TaintTracker.hasSensitiveData(new TaintTracker(store).labels({ agentId: original.id, taskId: task.id }))) { skip("touched private data"); continue; }
      const src = getSource(store, task.id);
      if (!src?.baseCommit) { skip("starting state not saved"); continue; }
      if (!(await host.workspaces.hasCommit(host.ref(goal), src.baseCommit))) { skip(src.mode === "granted-git" ? "needs the owner's files" : "starting state gone"); continue; }

      const roster = await ready(task.roomId), everyone = await ready();
      const taken = done.get(task.id) ?? new Set<string>();
      // a re-run of a task that works on the task folder happens in a copy of it, so only an agent that runs on this Mac may take it
      const others = roster.filter((a) => a.enabled && a.id !== original.id && !taken.has(a.id) && !this.tried.has(`${night.night}:${task.id}:${a.id}`) && (!needsWorkspace(task) || runsHere(a)));
      if (!others.length) { skip("every other agent has done it"); continue; }
      const free = others.filter((a) => !host.busy(a.id) && host.governor.admit(a) && !limited(a.id) && spare(a));
      if (!free.length) { skip("no agent with spare quota"); continue; }
      const options = free.filter((a) => outsideBoth(everyone, [original, a], localModels, limited).length > 0); // a re-run nobody outside both families can judge is no use
      if (!options.length) { skip("no judge outside both model families"); continue; }
      for (const a of options) {
        const c: Candidate = { task, goal, rec, commit: src.baseCommit, original, challenger: a, thin: evidenceCount(past, task.taskType, original.id, a.id) };
        if (!best || c.thin < best.thin) best = c; // the pair the log knows least about; on a tie, the newest task and the first agent in the roster
      }
    }
    night.skipped = skipped;
    return best;
  }

  // ---- running and judging

  private async run(c: Candidate, n: NightShiftNight, cfg: NightShiftSettings): Promise<void> {
    const { store, host, shadows } = this.d;
    const agent = c.challenger;
    this.tried.add(`${n.night}:${c.task.id}:${agent.id}`);
    n.runs++; n.lastRunAt = this.clock(); saveNight(store, n);
    host.busy(agent.id, true); // the shadow runner frees it when the copy is thrown away
    store.audit("nightshift", "nightshift.run", `${agent.name} re-runs "${c.task.title}" (accepted from ${c.original.name}); never merged`);

    const ctrl = new AbortController();
    const onStop = () => ctrl.abort();
    this.stopped.signal.addEventListener("abort", onStop);
    // A run still going when the morning comes is cut: real work needs the agent.
    const watch = setInterval(() => { if (this.night(this.clock(), cfg) !== n.night) ctrl.abort(); }, NIGHT_TUNING.pollMs);
    watch.unref?.();
    try {
      await shadows.runCopy(c.goal, c.task, agent, ctrl.signal, { label: "tournament", from: c.commit }, async (r) => {
        if (r.crashed) {
          // A crash overnight says little about the agent (a CLI that was signed out, a full disk): the run is logged, the scores stay as they were.
          r.close("run_failed", { usage: r.usage, seconds: r.seconds, ...(r.ranModel ? { modelVersion: r.ranModel } : {}), failureNote: `night-shift run failed: ${firstLine(r.error)}` });
          store.audit("nightshift", "nightshift.failed", `${agent.name} on "${c.task.title}": ${firstLine(r.error)}`);
          return;
        }
        const src = getSource(store, c.task.id);
        const entries: [PairEntry, PairEntry] = [
          { side: "original", agent: c.original, task: c.task, changed: src?.changed ?? [], files: src?.files ?? "" },
          { side: "challenger", agent, task: r.shadow, changed: r.changed, files: r.deliverables },
        ];
        const pair = await judgePair(host, { task: c.task, contract: c.goal.contract, notes: host.notes(c.goal.id), entries, signal: r.signal, rand: this.rand, now: this.clock() });
        if (r.signal.aborted) { r.close("interrupted", { usage: r.usage, seconds: r.seconds }); return; }
        if ("skip" in pair) {
          r.close("interrupted", { usage: r.usage, seconds: r.seconds, failureNote: `not judged: ${pair.skip}` });
          store.audit("nightshift", "nightshift.unjudged", `"${c.task.title}": ${pair.skip}`);
          return;
        }
        const mine = pair.sides.challenger, theirs = pair.sides.original;
        const judgment: Judgment = {
          score: mine.score, verdict: mine.verdict, feedback: mine.feedback, criteria: mine.criteria, onTask: mine.onTask,
          judgeAgentId: pair.judges.map((j) => j.agentId).join(",") || "checks",
        };
        const at = this.clock();
        // The challenger's own record: a graded run, by model version, marked as a tournament in the routing log. The original's scores are not touched.
        recordOutcome(store, agent.id, c.task.taskType, { judgment, seconds: r.seconds, failed: false, revision: false }, r.ranModel, at, cfg.weight);
        const outcome: RoutingOutcome = mine.verdict === "accept" ? "accepted" : mine.verdict === "reassign" ? "reassign" : "revise";
        r.close(outcome, {
          usage: r.usage, seconds: r.seconds, ...(r.ranModel ? { modelVersion: r.ranModel } : {}),
          judgment: { score: mine.score, verdict: mine.verdict, judgeAgentId: judgment.judgeAgentId }, // last: this is what makes it a graded run
        });
        const row: TournamentRun = {
          id: id("tour"), night: n.night, at, taskId: c.task.id, goalId: c.goal.id, roomId: c.task.roomId, taskTitle: c.task.title, taskType: c.task.taskType,
          original: { agentId: c.original.id, modelVersion: resolveModelVersion(c.rec.modelVersion, c.original.settings?.model), score: theirs.score, verdict: theirs.verdict },
          challenger: { agentId: agent.id, modelVersion: resolveModelVersion(r.ranModel, agent.settings?.model), score: mine.score, verdict: mine.verdict },
          preference: pair.preference, margin: pair.margin, judging: pair.judging, judges: pair.judges, order: pair.order,
          ...(r.rid ? { routingId: r.rid } : {}), weight: cfg.weight, seconds: r.seconds, ...(pair.note ? { note: pair.note } : {}),
        };
        saveTournament(store, row);
        store.audit("nightshift", "nightshift.result", `"${c.task.title}": ${agent.name} ${Math.round(mine.score * 100)} vs ${c.original.name} ${Math.round(theirs.score * 100)} (${pair.preference === "tie" ? "tie" : pair.preference === "challenger" ? `${agent.name} preferred` : `${c.original.name} preferred`}), judged by ${pair.judges.map((j) => j.family).join(", ")}`);
      });
    } finally {
      clearInterval(watch);
      this.stopped.signal.removeEventListener("abort", onStop);
      host.busy(agent.id, false);
    }
  }

  // ---- reading

  state(): NightShiftState {
    const cfg = this.settings(), now = this.clock();
    const tonight = this.night(now, cfg);
    return {
      settings: cfg, now, inWindow: !!tonight, ...(tonight ? { tonight } : {}),
      runsTonight: tonight ? getNight(this.store, tonight)?.runs ?? 0 : 0,
      nights: listNights(this.store).slice(0, 14),
      recent: listTournaments(this.store, { since: now - 30 * DAY }).slice(-30).reverse(),
      headToHead: headToHead(this.store),
    };
  }
}
