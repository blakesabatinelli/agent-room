import type { TwoKeyRecord } from "@agent-room/shared";
import type { Store } from "../db/store.js";

/**
 * 4.1 The `twokey` table: every two-key check, its drafts, its verdict and who decided. Created on first use, here, so this item adds
 * nothing to db/store.ts. A row is completed in place when the owner decides, never deleted. Drafts are stored with secrets removed.
 */
const ready = new WeakSet<object>();
function table(store: Store) {
  if (!ready.has(store)) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS twokey (id TEXT PRIMARY KEY, at INTEGER, task_id TEXT, agent_id TEXT, verdict TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS twokey_at ON twokey(at);
      CREATE INDEX IF NOT EXISTS twokey_task ON twokey(task_id);
    `);
    ready.add(store);
  }
  return store.db;
}

export function saveTwoKey(store: Store, r: TwoKeyRecord) {
  table(store).prepare("INSERT OR REPLACE INTO twokey (id, at, task_id, agent_id, verdict, data) VALUES (?,?,?,?,?,?)").run(r.id, r.at, r.taskId ?? null, r.agentA, r.verdict, JSON.stringify(r));
}
export function getTwoKey(store: Store, id: string): TwoKeyRecord | undefined {
  const r = table(store).prepare("SELECT data FROM twokey WHERE id=?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : undefined;
}
export function listTwoKey(store: Store, f: { taskId?: string; verdict?: string; limit?: number } = {}): TwoKeyRecord[] {
  const db = table(store);
  const limit = Math.min(f.limit ?? 200, 1000);
  const where = [f.taskId ? "task_id=?" : "", f.verdict ? "verdict=?" : ""].filter(Boolean);
  const args = [f.taskId, f.verdict].filter((x): x is string => !!x);
  const rows = db.prepare(`SELECT data FROM twokey ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, rowid DESC LIMIT ?`).all(...args, limit) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data));
}
