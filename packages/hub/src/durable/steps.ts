import type { GoalStep, GoalStepKind } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { now } from "../util.js";

/**
 * Durable goals: the `goal_steps` table. Created on first use, here, so db/store.ts is untouched (the same way the forks and juries tables are made).
 *
 * One row per orchestrator step that changes a goal. Rows are only ever appended, in `seq` order, and written synchronously (SQLite, same
 * connection as the goal and task rows), before the change they describe is treated as done.
 *
 * A task's runs are numbered `round` 1, 2, ... (one per `run_started`). Steps that belong to one run of one task (`run_finished`, `accepted`,
 * `merged`, ...) are unique per (task, kind, round): writing the same step twice is refused, which is what makes a replay safe to repeat.
 * Steps with no such identity (a plan, an assignment, a judgment) are unique per occurrence.
 */

const ready = new WeakSet<object>();
function db(store: Store) {
  if (!ready.has(store)) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_steps (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL,
        round INTEGER, uniq TEXT NOT NULL UNIQUE, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS goal_steps_goal ON goal_steps(goal_id, seq);
      CREATE INDEX IF NOT EXISTS goal_steps_task ON goal_steps(task_id, seq);
    `);
    ready.add(store);
  }
  return store.db;
}

/** Steps written at most once per run of a task. */
const ONCE_PER_ROUND = new Set<GoalStepKind>(["run_started", "run_finished", "run_failed", "needs_input", "accepted", "merged", "sent_back", "task_failed", "interrupted"]);

type Row = { seq: number; goal_id: string; task_id: string | null; kind: GoalStepKind; at: number; round: number | null; data: string };
const toStep = (r: Row): GoalStep => ({ seq: r.seq, goalId: r.goal_id, ...(r.task_id ? { taskId: r.task_id } : {}), kind: r.kind, at: r.at, ...(r.round !== null ? { round: r.round } : {}), data: JSON.parse(r.data) });

/** A goal's steps, oldest first. With `taskId`, only that task's. */
export function listSteps(store: Store, goalId: string, taskId?: string): GoalStep[] {
  const rows = (taskId
    ? db(store).prepare("SELECT * FROM goal_steps WHERE goal_id=? AND task_id=? ORDER BY seq ASC").all(goalId, taskId)
    : db(store).prepare("SELECT * FROM goal_steps WHERE goal_id=? ORDER BY seq ASC").all(goalId)) as Row[];
  return rows.map(toStep);
}

/** How many runs of this task have started (the round the task is in, 0 before its first run). */
export function currentRound(store: Store, taskId: string): number {
  const r = db(store).prepare("SELECT COUNT(*) AS n FROM goal_steps WHERE task_id=? AND kind='run_started'").get(taskId) as { n: number };
  return r.n;
}

/**
 * Append one step. Returns it, or undefined when it was already written (same task, kind and round). Never throws for a repeat.
 * `round` defaults to the task's current round; a `run_started` always opens the next one.
 */
export function appendStep(store: Store, s: { goalId: string; taskId?: string; kind: GoalStepKind; data?: Record<string, unknown>; round?: number }): GoalStep | undefined {
  const d = db(store);
  const round = s.taskId ? (s.round ?? (s.kind === "run_started" ? currentRound(store, s.taskId) + 1 : currentRound(store, s.taskId))) : undefined;
  let uniq: string;
  if (s.taskId && ONCE_PER_ROUND.has(s.kind)) uniq = `${s.goalId}|${s.taskId}|${s.kind}|r${round}`;
  else {
    const n = (d.prepare("SELECT COUNT(*) AS n FROM goal_steps WHERE goal_id=? AND IFNULL(task_id,'')=? AND kind=?").get(s.goalId, s.taskId ?? "", s.kind) as { n: number }).n;
    uniq = `${s.goalId}|${s.taskId ?? ""}|${s.kind}|n${n + 1}`;
  }
  const at = now();
  const data = JSON.stringify(s.data ?? {});
  const r = d.prepare("INSERT OR IGNORE INTO goal_steps (goal_id, task_id, kind, at, round, uniq, data) VALUES (?,?,?,?,?,?,?)").run(s.goalId, s.taskId ?? null, s.kind, at, round ?? null, uniq, data);
  if (!r.changes) return undefined;
  return { seq: Number(r.lastInsertRowid), goalId: s.goalId, ...(s.taskId ? { taskId: s.taskId } : {}), kind: s.kind, at, ...(round !== undefined ? { round } : {}), data: JSON.parse(data) };
}
