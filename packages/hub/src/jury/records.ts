import type { Judgment, JuryCalibration, JuryRecord } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { now } from "../util.js";

/**
 * 2.2 The `juries` table and the running calibration. The table is created on first use, here, so this item
 * adds nothing to db/store.ts. Like the routing log it is append-only: a row is completed in place (the owner's
 * rating), never deleted.
 */

const ready = new WeakSet<object>();
function table(store: Store) {
  if (!ready.has(store)) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS juries (id TEXT PRIMARY KEY, at INTEGER, task_id TEXT, goal_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS juries_task ON juries(task_id);
      CREATE INDEX IF NOT EXISTS juries_goal ON juries(goal_id);
      CREATE INDEX IF NOT EXISTS juries_at ON juries(at);
    `);
    ready.add(store);
  }
  return store.db;
}

export function saveJury(store: Store, r: JuryRecord) {
  table(store).prepare("INSERT OR REPLACE INTO juries (id, at, task_id, goal_id, data) VALUES (?,?,?,?,?)").run(r.id, r.at, r.taskId, r.goalId, JSON.stringify(r));
}
export function getJury(store: Store, id: string): JuryRecord | undefined {
  const r = table(store).prepare("SELECT data FROM juries WHERE id=?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : undefined;
}
export function listJuries(store: Store, f: { taskId?: string; goalId?: string; since?: number; limit?: number } = {}): JuryRecord[] {
  const db = table(store);
  const limit = f.limit ?? 10_000;
  const rows = (f.taskId
    ? db.prepare("SELECT data FROM juries WHERE task_id=? ORDER BY at ASC, rowid ASC LIMIT ?").all(f.taskId, limit)
    : f.goalId
      ? db.prepare("SELECT data FROM juries WHERE goal_id=? ORDER BY at ASC, rowid ASC LIMIT ?").all(f.goalId, limit)
      : db.prepare("SELECT data FROM juries WHERE at>=? ORDER BY at ASC, rowid ASC LIMIT ?").all(f.since ?? 0, limit)) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data));
}

export const EMPTY_CALIBRATION: JuryCalibration = { n: 0, juryN: 0, juryAbsErr: 0, singleN: 0, singleAbsErr: 0, sameFamilyN: 0, sameFamilyAbsErr: 0, byFamily: {} };
export function calibrationOf(store: Store): JuryCalibration {
  const s = store.getKV<Partial<JuryCalibration>>("jury_calibration", {});
  return { ...EMPTY_CALIBRATION, ...s, byFamily: { ...(s.byFamily ?? {}) } };
}

const mean = (m: number, n: number, x: number) => m + (x - m) / n;
const round = (x: number) => Math.round(x * 10000) / 10000;

/**
 * The owner rated a judgment (2.2 AC3): record how far each judge and the jury were from the rating, in the jury
 * record, and keep the running means in KV `jury_calibration` (the data for the "juries are worse than the user" kill criterion).
 * A judgment without a jury record (the jury was switched off) is skipped.
 */
export function recordOwnerRating(store: Store, judgment: Pick<Judgment, "jury"> | undefined, ownerScore: number): JuryRecord | undefined {
  const rec = judgment?.jury ? getJury(store, judgment.jury.id) : undefined;
  if (!rec) return undefined;
  rec.judges = rec.judges.map((j) => ({ ...j, distance: round(Math.abs(j.score - ownerScore)) }));
  const juryDistance = round(Math.abs(rec.aggregate.score - ownerScore));
  rec.owner = { score: ownerScore, at: now(), juryDistance };
  saveJury(store, rec);

  const cal = calibrationOf(store);
  cal.n += 1;
  if (rec.kind === "jury") { cal.juryN += 1; cal.juryAbsErr = round(mean(cal.juryAbsErr, cal.juryN, juryDistance)); }
  else { cal.singleN += 1; cal.singleAbsErr = round(mean(cal.singleAbsErr, cal.singleN, juryDistance)); }
  for (const j of rec.judges) {
    const f = (cal.byFamily[j.family] ??= { n: 0, absErr: 0 });
    f.n += 1; f.absErr = round(mean(f.absErr, f.n, j.distance!));
    if (j.family === rec.workerFamily) { cal.sameFamilyN += 1; cal.sameFamilyAbsErr = round(mean(cal.sameFamilyAbsErr, cal.sameFamilyN, j.distance!)); }
  }
  store.setKV("jury_calibration", cal);
  return rec;
}
