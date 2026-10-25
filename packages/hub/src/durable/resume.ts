import type { GoalStep, GoalStepKind, Judgment, RunUsage, Task } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { appendStep, listSteps } from "./steps.js";

/** What a run that finished before the hub stopped handed back: enough to judge it without asking the agent again. */
export interface FinishedRun { text: string; changed: string[]; usage?: RunUsage; ms: number; model?: string; /** the run was a revision of earlier work */ revision: boolean; /** when the run started, so a reply already posted to the room is recognised */ startedAt: number }

/** What to do with one task that was in flight when the hub stopped. */
export type ResumeAction =
  /** The agent was mid-run (or the log can't say better): run it again once, without spending an attempt. */
  | { action: "interrupt"; round: number }
  /** The run finished and its reply was logged, but the work was not judged to a verdict yet: judge it, never run it again. */
  | { action: "judge"; round: number; run: FinishedRun }
  /** The work was accepted: merge it (or, when the merge was already logged, only finish the task). Never run or judge again. */
  | { action: "merge"; round: number; run: FinishedRun; judgment: Judgment; merged: boolean; flagged?: string[]; drift?: string[] };

const asRun = (fin: GoalStep, start: GoalStep | undefined): FinishedRun => {
  const d = fin.data as { text?: string; changed?: string[]; usage?: RunUsage; ms?: number; model?: string; revision?: boolean };
  return { text: String(d.text ?? ""), changed: Array.isArray(d.changed) ? d.changed.map(String) : [], ...(d.usage ? { usage: d.usage } : {}), ms: Number(d.ms ?? 0), ...(d.model ? { model: d.model } : {}), revision: !!d.revision, startedAt: start?.at ?? fin.at };
};

/**
 * Read one task's log and say where it stands. Pure: the same log and the same task row always give the same answer, so the plan can be made
 * (and acted on) any number of times. Only a task that was running or in review needs one; every other status is left to the orchestrator's loop.
 */
export function planResume(steps: GoalStep[], task: Pick<Task, "status">): ResumeAction | undefined {
  if (task.status !== "running" && task.status !== "review") return undefined;
  const starts = steps.filter((s) => s.kind === "run_started");
  const round = starts.at(-1)?.round ?? 0;
  const mine = (k: GoalStepKind) => steps.find((s) => s.kind === k && (s.round ?? 0) === round);
  const start = starts.find((s) => s.round === round);
  const fin = mine("run_finished"), acc = mine("accepted"), merged = mine("merged");
  if (task.status === "review" && fin && !mine("interrupted")) {
    const run = asRun(fin, start);
    const a = acc?.data as { judgment?: Judgment; flagged?: string[]; drift?: string[] } | undefined;
    if (acc && a?.judgment) return { action: "merge", round, run, judgment: a.judgment, merged: !!merged, ...(a.flagged?.length ? { flagged: a.flagged } : {}), ...(a.drift?.length ? { drift: a.drift } : {}) };
    return { action: "judge", round, run };
  }
  return { action: "interrupt", round };
}

/**
 * The step log as the orchestrator uses it. Every call that changes a goal writes its step through `record`, in the same SQLite transaction as the
 * row it changes, so the log and the rows can never disagree about a step that was written. `plan` is what `recover()` asks after a restart.
 */
export class Durable {
  /** Called after a new step is committed. A test makes it throw to stop the orchestrator at that exact step, like a crash. */
  afterStep?: (s: GoalStep) => void;
  private resuming = new Map<string, ResumeAction>();
  constructor(private store: Store) {}

  /**
   * Write one step and run `apply` (the change it describes) in one transaction. `apply` runs whether or not the step is new, so a caller that
   * repeats a step still gets its change; the step itself is written once. Returns the step, or undefined when it was already there.
   */
  record(goalId: string, taskId: string | undefined, kind: GoalStepKind, data: Record<string, unknown> = {}, apply?: () => void): GoalStep | undefined {
    const s = this.store.db.transaction(() => { const w = appendStep(this.store, { goalId, taskId, kind, data }); apply?.(); return w; })();
    if (s) this.afterStep?.(s);
    return s;
  }

  steps(goalId: string, taskId?: string) { return listSteps(this.store, goalId, taskId); }

  /** Decide, for every task of a goal that was in flight, what to do. Safe to call twice: it only reads. */
  plan(goalId: string, tasks: Task[]): Map<string, ResumeAction> {
    const steps = this.steps(goalId);
    const out = new Map<string, ResumeAction>();
    for (const t of tasks) {
      const a = planResume(steps.filter((s) => s.taskId === t.id), t);
      if (a) out.set(t.id, a);
    }
    return out;
  }

  /** Remember that this task is to be judged or merged when its goal's loop next starts it. */
  expect(taskId: string, a: ResumeAction) { this.resuming.set(taskId, a); }
  /** Is this task waiting to be judged or merged from the log? */
  has(taskId: string) { return this.resuming.has(taskId); }
  /** The loop starts the task now: hand over its resume action, once. */
  take(taskId: string): ResumeAction | undefined { const a = this.resuming.get(taskId); this.resuming.delete(taskId); return a; }
  drop(taskId: string) { this.resuming.delete(taskId); }
}
