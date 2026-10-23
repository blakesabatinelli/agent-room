import type { AgentConfig, Goal, Judgment, Profile, RoutingOutcome, Task } from "@agent-room/shared";
import type { ControlFolder } from "../control/folder.js";
import type { Store } from "../db/store.js";
import type { RunResult } from "../adapters/types.js";
import type { TaskWorkspace, TaskWorkspaces, GoalRef } from "../orchestrator/worktree.js";
import { needsGate } from "../discovery/routing.js";
import { parseReport, pickProfile } from "../orchestrator/contract.js";
import { classifyFailure } from "../orchestrator/failures.js";
import { isTransient } from "../orchestrator/ledger.js";
import { taskPrompt } from "../orchestrator/prompts.js";
import { closeRecord, fixedDecision, openRecord } from "../orchestrator/routing.js";
import { recordOutcome } from "../orchestrator/scoring.js";
import { changedFiles, outsideScope, runCheck, snapshot } from "../orchestrator/workspace.js";
import { readDeliverables } from "../orchestrator/ledger.js";
import { isRateLimit } from "../quota/limits.js";
import { quotaLimited } from "../quota/router.js";
import { learnedBlock } from "../retro/index.js";
import { now } from "../util.js";
import { barredSet, onProbation, probationAgentIds } from "./probation.js";

/**
 * 2.3 Shadow tasks (PRODUCT.md 6.9: "A new agent starts on probation with shadow tasks").
 *
 * When a real task starts, every agent on probation that is idle and admissible (enabled, connected, not out of quota,
 * allowed by the capacity governor, able to reach the data the task needs) gets a SHADOW COPY of it: the same task, the
 * same prompt, in its own worktree cut from the goal's base at that moment. The copy is judged exactly like real work
 * (jury when one can be formed) and its score is recorded on the agent: the `scores` roll-up and a routing record of
 * kind "shadow" with `shadow: true`. Then the worktree is thrown away.
 *
 * A shadow run can never touch anything real:
 *  - its worktree is always discarded and never merged into the goal's folder (no `accept` call exists in this file);
 *  - the task exists only in memory here, not in the database, so it isn't in the room, the ledger or the plan;
 *  - the run is flagged (`shadow` on the MCP grant): approvals are never requested (every request is refused),
 *    it can't post or ask other agents, save documents, propose memory or propose file writes;
 *  - nothing is said in the room except one quiet log line, written by the orchestrator when the copy was judged.
 * The agent isn't told it is practising: a different prompt would make the practice score mean something else.
 */

export const SHADOW_TUNING = {
  /** Once the real goal's work is done, how long it waits for copies still running before dropping them. */
  graceMs: 2 * 60_000,
};

/** What the shadow runner needs from the orchestrator (kept narrow so it can be driven with fakes). */
export interface ShadowHost {
  store: Store;
  control?: ControlFolder;
  workspaces: TaskWorkspaces;
  /** The goal's work folder reference (granted folder included), as real tasks use. */
  ref(goal: Goal): GoalRef;
  readyAgents(): Promise<AgentConfig[]>;
  /** Is the agent holding a task or answering chat? With `set`, mark it busy or free. */
  busy(agentId: string, set?: boolean): boolean;
  governor: { admit(a: AgentConfig): boolean; start(key: string, a: AgentConfig): void; release(key: string): void };
  /** One run through the adapter, flagged as a shadow run (no approvals, no posting). */
  run(agent: AgentConfig, prompt: string, o: { roomId: string; taskId: string; signal: AbortSignal; profile: Profile; cwd: string }): Promise<RunResult>;
  /** Judge exactly as a real task is judged (jury when it can be formed). */
  judge(task: Task, worker: AgentConfig, goal: Goal, signal: AbortSignal, changed: string[], files: string): Promise<Judgment>;
  beforeRun(ws: TaskWorkspace, agentId: string): Promise<void>;
  notes(goalId: string): string[];
  decisions(goal: Goal): string[];
  ledger(goal: Goal): string;
  /** Runnable checks may run (the plan was approved, or the owner allows it). */
  checksAllowed(goal: Goal): boolean;
  /** One quiet line for the work log. */
  log(roomId: string, text: string, taskId?: string): void;
  /** Time source, for tests. */
  now?: () => number;
}

const firstLine = (e?: string) => (e ?? "unknown error").split("\n").find((l) => l.trim())?.slice(0, 300) ?? "unknown error";

export class ShadowRunner {
  /** Shadow tasks in flight, by id. They exist only here. */
  private tasks = new Map<string, Task>();
  private flights = new Map<string, Set<Promise<void>>>();
  private ctrls = new Map<string, Set<AbortController>>();
  constructor(private host: ShadowHost, private graceMs = SHADOW_TUNING.graceMs) {}

  /** The in-memory task behind a shadow id (the control folder's context hook looks it up). */
  task(id: string): Task | undefined { return this.tasks.get(id); }
  isShadow(taskId: string | undefined): boolean { return !!taskId && this.tasks.has(taskId); }

  /**
   * A real task is starting on `realAgentId`. Copies it for every free probation agent, in the background.
   * Never throws and never waits: the real task must not be slowed by practice.
   */
  begin(goal: Goal, task: Task, realAgentId: string, goalSignal: AbortSignal): void {
    if (!probationAgentIds(this.host.store).length) return;
    const p: Promise<void> = this.start(goal, task, realAgentId, goalSignal)
      .catch((e) => { try { this.host.store.audit("orchestrator", "shadow.failed", `${task.id}: ${firstLine(String(e?.message ?? e))}`); } catch { /* nothing more to do */ } })
      .finally(() => { this.flights.get(goal.id)?.delete(p); });
    const set = this.flights.get(goal.id) ?? new Set();
    set.add(p); this.flights.set(goal.id, set);
  }

  /** Wait (up to the grace period) for this goal's copies to finish, then drop what is left. */
  async settle(goalId: string, graceMs = this.graceMs): Promise<void> {
    const set = this.flights.get(goalId);
    if (!set?.size) return;
    const all = Promise.allSettled([...set]);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); timer.unref?.(); });
    let finished = false;
    await Promise.race([all.then(() => { finished = true; }), late]);
    clearTimeout(timer);
    if (!finished) for (const c of this.ctrls.get(goalId) ?? []) c.abort(); // late: drop them (their records close as interrupted)
    await all;
  }

  /** Free probation agents that may take a copy of `task` now. */
  private async candidates(task: Task, realAgentId: string): Promise<AgentConfig[]> {
    const host = this.host, store = host.store;
    const ready = await host.readyAgents();
    const barred = barredSet(store, ready); // practice only where probation is really applied (not when every connected agent is new)
    return ready.filter((a) => a.enabled && a.id !== realAgentId && barred.has(a.id) && onProbation(store, a.id)
      && !host.busy(a.id) && host.governor.admit(a) && !quotaLimited(store, a.id)
      && !(needsGate(task, [a], host.control)?.ok.has(a.id) === false)); // a task that needs Salesforce isn't practice for an agent with none
  }

  private async start(goal: Goal, task: Task, realAgentId: string, goalSignal: AbortSignal) {
    const picked = (await this.candidates(task, realAgentId)).filter((a) => !this.host.busy(a.id));
    for (const a of picked) this.host.busy(a.id, true); // claimed in the same tick as the check, so two tasks never take one agent twice
    await Promise.allSettled(picked.map((a) => this.runOne(goal, task, a, goalSignal)));
  }

  private async runOne(goal: Goal, real: Task, agent: AgentConfig, goalSignal: AbortSignal) {
    const { host } = this;
    const store = host.store, clock = host.now ?? now;
    const sid = `${real.id}-shadow-${agent.id}`;
    const shadow: Task = {
      ...real, id: sid, owner: agent.id, assignee: agent.id, status: "running", attempts: 0, history: [], failures: undefined, replans: 0,
      triedBy: [], judgment: undefined, result: undefined, report: undefined, checks: [], drift: undefined, flagged: undefined,
      unsureRounds: 0, recovered: undefined, routingId: undefined, profileId: undefined, createdAt: clock(), updatedAt: clock(),
    };
    this.tasks.set(sid, shadow);
    host.governor.start(sid, agent);
    const ctrl = new AbortController();
    const onGoal = () => ctrl.abort();
    goalSignal.addEventListener("abort", onGoal);
    const set = this.ctrls.get(goal.id) ?? new Set(); set.add(ctrl); this.ctrls.set(goal.id, set);
    const fresh = store.getGoal(goal.id) ?? goal;
    const ref = host.ref(fresh);
    let rid: string | undefined;
    const close = (outcome: RoutingOutcome, extra: Parameters<typeof closeRecord>[2] = {}) => closeRecord(store, rid, { outcome, ...extra });
    try {
      const rec = openRecord(store, fixedDecision(store, agent, [], real.taskType, "shadow", 0), shadow, goal.text, "shadow");
      rid = shadow.routingId = rec.id;
      close("pending", { shadow: true, shadowOf: real.id });
      store.audit(agent.id, "shadow.started", `a copy of "${real.title}" (${real.id}); never merged`);

      const ws = await host.workspaces.open(ref, shadow, agent.id);
      const work = ws.path;
      await host.beforeRun(ws, agent.id);
      if (ctrl.signal.aborted) { close("interrupted"); return; }
      const profile = pickProfile(agent, shadow.role ?? "worker", real.minTier ?? 1);
      shadow.profileId = profile.id;
      close("pending", { profileId: profile.id, modelRequested: profile.model ?? ((agent.settings?.model as string | undefined) || undefined) });

      const before = snapshot(work);
      const deps = store.listTasks({ goalId: goal.id }).filter((t) => shadow.dependsOn.includes(t.id));
      const agents = store.listAgents().filter((a) => a.enabled);
      // The prompt is the real task's prompt, in this agent's own worktree. The progress ledger is the orchestrator's: it is shown, not pointed at.
      const prompt = taskPrompt(shadow, goal.text, fresh.contract, deps, store.listShared(goal.roomId), store.listPrivate(agent.id), host.notes(goal.id), agents, agent.id,
        undefined, { path: work, files: [...before.keys()] }, host.ledger(fresh), host.decisions(fresh), learnedBlock(store, host.control, agent, shadow.taskType));
      const t0 = clock();
      const res = await host.run(agent, prompt, { roomId: goal.roomId, taskId: sid, signal: ctrl.signal, profile, cwd: work });
      const seconds = Math.max(0, (clock() - t0) / 1000);
      const ranModel = res.model ?? profile.model;
      const usage = res.usage;
      if (ctrl.signal.aborted) { close("interrupted", { usage, seconds }); return; }

      if (!res.ok) {
        // A rate limit or timeout says nothing about the agent: not a graded run. A crash does: it scores 0, like a real failed run.
        if (isRateLimit(res.error) || isTransient(res.error)) { close("interrupted", { usage, seconds, failureNote: `transient: ${firstLine(res.error)}` }); return; }
        recordOutcome(store, agent.id, shadow.taskType, { seconds, failed: true, revision: false }, ranModel);
        const { tag, why } = classifyFailure({ kind: "run_error" });
        close("run_failed", { usage, seconds, ...(ranModel ? { modelVersion: ranModel } : {}), failureTag: tag, failureNote: `${why}: ${firstLine(res.error)}`.slice(0, 300),
          judgment: { score: 0, verdict: "reassign", judgeAgentId: "hub" } });
        this.say(goal, agent, shadow, 0);
        return;
      }

      const { body, report } = parseReport(res.text);
      shadow.result = body; shadow.report = report;
      const changed = changedFiles(before, snapshot(work));
      shadow.checks = [];
      if (host.checksAllowed(fresh)) for (const c of (shadow.criteria ?? []).filter((x) => x.check)) shadow.checks.push(await runCheck(c.id, c.check!, work));
      const failedChecks = shadow.checks.filter((r) => !r.ok);
      const fileDrift = outsideScope(changed, shadow.files);
      const judgment: Judgment = failedChecks.length
        ? { score: 0.3, verdict: "revise", judgeAgentId: "checks", criteria: {}, onTask: true,
            feedback: `These checks failed: ${failedChecks.map((r) => `${r.criterionId} \`${r.command}\` exited ${r.exitCode}`).join("; ")}.` }
        : await host.judge(shadow, agent, fresh, ctrl.signal, changed, readDeliverables(work, [...new Set([...changed, ...(shadow.files ?? []).filter((f) => !/[*?[]/.test(f))])], 16000));
      if (ctrl.signal.aborted) { close("interrupted", { usage, seconds }); return; }
      for (const r of shadow.checks) (judgment.criteria ??= {})[r.criterionId] = { verdict: r.ok ? "PASS" : "FAIL", evidence: r.ok ? `\`${r.command}\` passed` : `\`${r.command}\` exited ${r.exitCode}` };
      const drift = [...(fileDrift.length ? [`Changed files outside its scope: ${fileDrift.slice(0, 8).join(", ")}`] : []), ...(judgment.onTask === false || judgment.drift ? [`Judge: ${judgment.drift || "off task"}`] : [])];
      if (drift.length && judgment.verdict === "accept") { judgment.verdict = "revise"; judgment.feedback = `Stay on your task and in scope. ${drift.join(" ")} ${judgment.feedback}`.trim(); }
      shadow.judgment = judgment;

      recordOutcome(store, agent.id, shadow.taskType, { judgment, seconds, failed: false, revision: false }, ranModel);
      const accepted = judgment.verdict === "accept";
      const fail = accepted ? undefined : classifyFailure({ kind: "sent_back", report, judgment, drift, failedChecks: failedChecks.map((r) => r.criterionId) });
      close(accepted ? "accepted" : judgment.verdict === "reassign" ? "reassign" : "revise", {
        usage, seconds, ...(ranModel ? { modelVersion: ranModel } : {}),
        ...(fail ? { failureTag: fail.tag, failureNote: `${fail.why}: ${firstLine(judgment.feedback)}`.slice(0, 300) } : {}),
        ...(judgment.jury ? { juryId: judgment.jury.id } : {}),
        // Last: the judgment is what makes it a graded run (the résumé and probation listen for it).
        judgment: { score: judgment.score, verdict: judgment.verdict, judgeAgentId: judgment.judgeAgentId },
      });
      this.say(goal, agent, shadow, judgment.score);
    } catch (e) {
      if (rid) { try { close("interrupted", { failureNote: `shadow run failed: ${firstLine(String((e as Error)?.message ?? e))}` }); } catch { /* the log keeps the pending row */ } }
      store.audit(agent.id, "shadow.failed", `${real.id}: ${firstLine(String((e as Error)?.message ?? e))}`);
    } finally {
      // Always thrown away, never merged.
      await host.workspaces.discard(ref, sid).catch(() => undefined);
      this.tasks.delete(sid);
      host.governor.release(sid);
      host.busy(agent.id, false);
      goalSignal.removeEventListener("abort", onGoal);
      this.ctrls.get(goal.id)?.delete(ctrl);
    }
  }

  /** The one quiet line a shadow run leaves in the room's work log. */
  private say(goal: Goal, agent: AgentConfig, t: Task, score: number) {
    this.host.log(goal.roomId, `${agent.name} practised on a copy of "${t.title}" (${Math.round(score * 100)}/100). Nothing was kept.`, undefined);
  }
}
