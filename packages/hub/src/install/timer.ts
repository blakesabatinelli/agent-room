// 1.7 The setup timer: how long from the app's first launch to the first finished goal.
// KV keys (milliseconds since the epoch): setup.started, setup.first_goal_done.
import type { SetupTimer } from "@agent-room/shared";
import type { Store } from "../db/store.js";

export const KV_STARTED = "setup.started";
export const KV_FIRST_GOAL_DONE = "setup.first_goal_done";
export const KV_FIRST_GOAL_PRACTICE = "setup.first_goal_practice";

/** First launch: write the start time once. Later launches leave it alone. */
export function markSetupStarted(store: Store, now = Date.now()): number {
  const had = store.getKV<number | null>(KV_STARTED, null);
  if (had) return had;
  store.setKV(KV_STARTED, now);
  store.audit("hub", "setup.started", new Date(now).toISOString());
  return now;
}

/** The first goal to finish ends the timer. Does nothing if the timer never started or already stopped. */
export function markFirstGoalDone(store: Store, now = Date.now()): number | undefined {
  const started = store.getKV<number | null>(KV_STARTED, null);
  if (!started || store.getKV<number | null>(KV_FIRST_GOAL_DONE, null)) return undefined;
  store.setKV(KV_FIRST_GOAL_DONE, now);
  const practice = store.getKV<boolean>("practice_mode", false);
  store.setKV(KV_FIRST_GOAL_PRACTICE, practice);
  store.audit("hub", "setup.first_goal_done", `${Math.max(0, Math.round((now - started) / 1000))}s after first launch${practice ? " (practice agents)" : ""}`);
  return now;
}

export function setupTimer(store: Store, now = Date.now()): SetupTimer {
  const startedAt = store.getKV<number | null>(KV_STARTED, null) ?? undefined;
  const firstGoalDoneAt = store.getKV<number | null>(KV_FIRST_GOAL_DONE, null) ?? undefined;
  if (!startedAt) return { done: false };
  return {
    startedAt, firstGoalDoneAt, done: !!firstGoalDoneAt,
    elapsedSeconds: Math.max(0, Math.round(((firstGoalDoneAt ?? now) - startedAt) / 1000)),
    ...(firstGoalDoneAt ? { firstGoalPractice: store.getKV<boolean>(KV_FIRST_GOAL_PRACTICE, false) } : {}),
  };
}
