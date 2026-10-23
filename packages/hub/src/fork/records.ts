import type { Fork, ForkPreference } from "@agent-room/shared";
import type { Store } from "../db/store.js";

/**
 * 4.4 The `forks` table. Created on first use, here, so this item adds nothing to db/store.ts (the same way the juries table is made).
 * A row is the whole Fork as JSON; it is rewritten in place as the sides finish, the comparison arrives and the owner merges.
 * The preferences a merge records live in KV `fork_preferences`.
 */

const ready = new WeakSet<object>();
function db(store: Store) {
  if (!ready.has(store)) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS forks (id TEXT PRIMARY KEY, room_id TEXT, created_at INTEGER, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS forks_room ON forks(room_id, created_at);
    `);
    ready.add(store);
  }
  return store.db;
}

export function saveFork(store: Store, f: Fork) {
  db(store).prepare("INSERT OR REPLACE INTO forks (id, room_id, created_at, data) VALUES (?,?,?,?)").run(f.id, f.roomId, f.createdAt, JSON.stringify(f));
}
export function getFork(store: Store, id: string): Fork | undefined {
  const r = db(store).prepare("SELECT data FROM forks WHERE id=?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : undefined;
}
export function listForks(store: Store, roomId?: string): Fork[] {
  const rows = (roomId
    ? db(store).prepare("SELECT data FROM forks WHERE room_id=? ORDER BY created_at ASC, rowid ASC").all(roomId)
    : db(store).prepare("SELECT data FROM forks ORDER BY created_at ASC, rowid ASC").all()) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data));
}

// ---------------------------------------------------------------- preferences

const KEY = "fork_preferences";
const pk = (agentId: string, taskType: string) => `${agentId}|${taskType}`;

export function listPreferences(store: Store, agentId?: string): ForkPreference[] {
  const all = Object.values(store.getKV<Record<string, ForkPreference>>(KEY, {}));
  return (agentId ? all.filter((p) => p.agentId === agentId) : all).sort((a, b) => a.agentId.localeCompare(b.agentId) || a.taskType.localeCompare(b.taskType));
}

/** What a merged fork says about an agent on a task type: wins and losses, and the net as a number between -1 and 1 (0 with no evidence). Never a judge score. */
export function forkPreference(store: Store, agentId: string, taskType: string): { wins: number; losses: number; net: number } {
  const p = store.getKV<Record<string, ForkPreference>>(KEY, {})[pk(agentId, taskType)];
  if (!p) return { wins: 0, losses: 0, net: 0 };
  return { wins: p.wins, losses: p.losses, net: (p.wins - p.losses) / (p.wins + p.losses + 1) };
}

/**
 * The owner merged one side: every agent on the winning roster gets a win, every agent only on the losing roster a loss, on each task type
 * either side worked on. An agent on both rosters gets nothing (it was on both sides of the choice).
 */
export function recordForkOutcome(store: Store, forkId: string, winners: string[], losers: string[], taskTypes: string[], at: number): ForkPreference[] {
  const all = store.getKV<Record<string, ForkPreference>>(KEY, {});
  const touched: ForkPreference[] = [];
  const bump = (agentId: string, taskType: string, won: boolean) => {
    const k = pk(agentId, taskType);
    const p = all[k] ?? { agentId, taskType, wins: 0, losses: 0, lastAt: at, forks: [] };
    if (won) p.wins += 1; else p.losses += 1;
    p.lastAt = at; p.forks = [...p.forks.filter((x) => x !== forkId), forkId].slice(-50);
    all[k] = p; touched.push(p);
  };
  const types = [...new Set(taskTypes.filter(Boolean))];
  for (const t of types) {
    for (const a of winners) if (!losers.includes(a)) bump(a, t, true);
    for (const a of losers) if (!winners.includes(a)) bump(a, t, false);
  }
  if (touched.length) store.setKV(KEY, all);
  return touched;
}
