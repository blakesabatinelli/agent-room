import type { NightShiftNight, TournamentRun } from "@agent-room/shared";
import type { Store } from "../db/store.js";

/**
 * 4.5 What the night shift keeps. Both tables are created on first use, here, so this item adds nothing to db/store.ts.
 *  - `nightshift_sources`: where each real task started and what it handed back, written by the orchestrator's two hooks
 *    (opened, accepted). A re-run needs the starting commit; the judges need to see the original's files as they were
 *    when the task was accepted, because the goal's folder has moved on since.
 *  - `tournaments`: one row per re-run that was judged. Append-only.
 * The nights (a running count and the digest line) live in the key/value table.
 */

/** Longest deliverable text kept per task (the judges are shown at most this much anyway). */
const FILES_CAP = 16_000;

export interface TaskSource {
  taskId: string;
  goalId: string;
  /** The commit the task's worktree was cut from. */
  baseCommit: string;
  /** plain = the hub's own goal folder; granted-git = the hub's clone of a granted repo. */
  mode: "plain" | "granted-git";
  /** Who did the accepted attempt. */
  agentId: string;
  /** Files the accepted attempt changed, and their contents as the judge saw them. Set when the task was accepted. */
  changed?: string[];
  files?: string;
  openedAt: number;
  acceptedAt?: number;
}

const ready = new WeakSet<object>();
function tables(store: Store) {
  if (!ready.has(store)) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS nightshift_sources (task_id TEXT PRIMARY KEY, goal_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS nightshift_sources_goal ON nightshift_sources(goal_id);
      CREATE TABLE IF NOT EXISTS tournaments (id TEXT PRIMARY KEY, at INTEGER, night TEXT, task_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tournaments_at ON tournaments(at);
      CREATE INDEX IF NOT EXISTS tournaments_task ON tournaments(task_id);
      CREATE INDEX IF NOT EXISTS tournaments_night ON tournaments(night);
    `);
    ready.add(store);
  }
  return store.db;
}

/** Reads leave a database that never ran the night shift exactly as it was (the kill-review command reads a database it must not change). */
const absent = (store: Store, table: string) => !ready.has(store) && !store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

export function getSource(store: Store, taskId: string): TaskSource | undefined {
  if (absent(store, "nightshift_sources")) return undefined;
  const r = tables(store).prepare("SELECT data FROM nightshift_sources WHERE task_id=?").get(taskId) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : undefined;
}
export function saveSource(store: Store, s: TaskSource) {
  tables(store).prepare("INSERT OR REPLACE INTO nightshift_sources (task_id, goal_id, data) VALUES (?,?,?)").run(s.taskId, s.goalId, JSON.stringify({ ...s, ...(s.files !== undefined ? { files: s.files.slice(0, FILES_CAP) } : {}) }));
}

export function saveTournament(store: Store, t: TournamentRun) {
  tables(store).prepare("INSERT OR REPLACE INTO tournaments (id, at, night, task_id, data) VALUES (?,?,?,?,?)").run(t.id, t.at, t.night, t.taskId, JSON.stringify(t));
}
export function listTournaments(store: Store, f: { since?: number; until?: number; night?: string; taskId?: string; limit?: number } = {}): TournamentRun[] {
  if (absent(store, "tournaments")) return [];
  const db = tables(store);
  const limit = f.limit ?? 10_000;
  const rows = (f.taskId
    ? db.prepare("SELECT data FROM tournaments WHERE task_id=? ORDER BY at ASC, rowid ASC LIMIT ?").all(f.taskId, limit)
    : f.night
      ? db.prepare("SELECT data FROM tournaments WHERE night=? ORDER BY at ASC, rowid ASC LIMIT ?").all(f.night, limit)
      : db.prepare("SELECT data FROM tournaments WHERE at>=? AND at<? ORDER BY at ASC, rowid ASC LIMIT ?").all(f.since ?? 0, f.until ?? Number.MAX_SAFE_INTEGER, limit)) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data));
}

const KV_NIGHTS = "nightshift_nights";
const KEEP_NIGHTS = 120;
export const emptyNight = (night: string, at: number): NightShiftNight => ({ night, runs: 0, reported: false, skipped: {}, startedAt: at, lastRunAt: at });
export function listNights(store: Store): NightShiftNight[] {
  return Object.values(store.getKV<Record<string, NightShiftNight>>(KV_NIGHTS, {})).sort((a, b) => b.night.localeCompare(a.night));
}
export function getNight(store: Store, night: string): NightShiftNight | undefined {
  return store.getKV<Record<string, NightShiftNight>>(KV_NIGHTS, {})[night];
}
export function saveNight(store: Store, n: NightShiftNight) {
  const all = store.getKV<Record<string, NightShiftNight>>(KV_NIGHTS, {});
  all[n.night] = n;
  for (const k of Object.keys(all).sort().slice(0, Math.max(0, Object.keys(all).length - KEEP_NIGHTS))) delete all[k];
  store.setKV(KV_NIGHTS, all);
}
