/**
 * Durable goals. A step log per goal (`goal_steps`) so a hub restart mid-goal resumes from the last completed step instead of losing or redoing work.
 *   steps.ts   the table, append-only and idempotent per (task, kind, run)
 *   resume.ts  reading a task's log to decide what a restart does with it, and the `Durable` handle the orchestrator holds
 * The orchestrator writes steps (see `durable.record(...)` calls) and resumes in `recover()`.
 */
export { appendStep, currentRound, listSteps } from "./steps.js";
export { Durable, planResume, type FinishedRun, type ResumeAction } from "./resume.js";
