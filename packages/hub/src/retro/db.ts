import type Database from "better-sqlite3";
import type { Lesson } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { id } from "../util.js";

/**
 * 2.1 The `lessons` and `playbooks` tables. The files in the control folder are what the owner edits; these tables are what
 * makes retros work without a control folder, and what remembers which lessons were retired or deleted.
 * Created here (like the quota ledger's table), so the Store's own schema doesn't change.
 */

export interface LessonRow extends Lesson {
  /** Last time a retro saw the same lesson again (a repeat keeps a lesson young when condensing). */
  confirmedAt: number;
  seen: number;
  /** Why it is inactive: merged, old (condensing), deleted (the owner took the line out of the file). */
  reason?: "merged" | "old" | "deleted";
  /** orchestrator (a retro) or owner (a line the owner wrote in the file). */
  source: "orchestrator" | "owner";
  evidence?: string;
}

export interface PlaybookRow { taskType: string; lines: string[]; retired: string[]; updatedAt: number; goalId?: string }

interface Raw { id: string; agent_id: string; task_type: string; text: string; goal_id: string; at: number; confirmed_at: number; seen: number; active: number; retired: number; reason: string | null; source: string; evidence: string | null }
const row = (r: Raw): LessonRow => ({
  id: r.id, agentId: r.agent_id, taskType: r.task_type, text: r.text, goalId: r.goal_id, at: r.at, confirmedAt: r.confirmed_at, seen: r.seen,
  active: !!r.active, retired: !!r.retired, ...(r.reason ? { reason: r.reason as LessonRow["reason"] } : {}), source: r.source as LessonRow["source"], ...(r.evidence ? { evidence: r.evidence } : {}),
});

export class RetroDb {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_type TEXT NOT NULL, text TEXT NOT NULL, goal_id TEXT NOT NULL, at INTEGER NOT NULL,
        confirmed_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, retired INTEGER NOT NULL DEFAULT 0,
        reason TEXT, source TEXT NOT NULL DEFAULT 'orchestrator', evidence TEXT
      );
      CREATE INDEX IF NOT EXISTS lessons_agent ON lessons(agent_id, task_type, active);
      CREATE INDEX IF NOT EXISTS lessons_goal ON lessons(goal_id);
      CREATE TABLE IF NOT EXISTS playbooks (task_type TEXT PRIMARY KEY, lines TEXT NOT NULL, retired TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL, goal_id TEXT);
    `);
  }

  /** Every lesson of an agent (all states), oldest first. */
  forAgent(agentId: string): LessonRow[] {
    return (this.db.prepare("SELECT * FROM lessons WHERE agent_id=? ORDER BY at ASC, rowid ASC").all(agentId) as Raw[]).map(row);
  }
  /** Lessons in use for one agent and task type, newest first. */
  active(agentId: string, taskType: string): LessonRow[] {
    return (this.db.prepare("SELECT * FROM lessons WHERE agent_id=? AND task_type=? AND active=1 ORDER BY at DESC, rowid DESC").all(agentId, taskType) as Raw[]).map(row);
  }
  list(filter: { agentId?: string; taskType?: string; goalId?: string; includeInactive?: boolean } = {}): LessonRow[] {
    const where = ["1=1"]; const args: unknown[] = [];
    if (filter.agentId) { where.push("agent_id=?"); args.push(filter.agentId); }
    if (filter.taskType) { where.push("task_type=?"); args.push(filter.taskType); }
    if (filter.goalId) { where.push("goal_id=?"); args.push(filter.goalId); }
    if (!filter.includeInactive) where.push("active=1");
    return (this.db.prepare(`SELECT * FROM lessons WHERE ${where.join(" AND ")} ORDER BY at ASC, rowid ASC`).all(...(args as never[])) as Raw[]).map(row);
  }
  agentsWithLessons(): string[] {
    return (this.db.prepare("SELECT DISTINCT agent_id FROM lessons").all() as { agent_id: string }[]).map((r) => r.agent_id);
  }

  insert(l: Omit<LessonRow, "id" | "active" | "retired" | "seen" | "confirmedAt"> & Partial<Pick<LessonRow, "id" | "active" | "retired" | "seen" | "confirmedAt">>): LessonRow {
    const r = { active: true, retired: false, seen: 1, confirmedAt: l.at, ...l, id: l.id ?? id("les") } as LessonRow;
    this.db.prepare("INSERT INTO lessons (id, agent_id, task_type, text, goal_id, at, confirmed_at, seen, active, retired, reason, source, evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(r.id, r.agentId, r.taskType, r.text, r.goalId, r.at, r.confirmedAt, r.seen, r.active ? 1 : 0, r.retired ? 1 : 0, r.reason ?? null, r.source, r.evidence ?? null);
    return r;
  }
  patch(rowId: string, p: Partial<Pick<LessonRow, "active" | "retired" | "reason" | "confirmedAt" | "seen" | "text" | "evidence">>) {
    const sets: string[] = []; const args: unknown[] = [];
    if (p.active !== undefined) { sets.push("active=?"); args.push(p.active ? 1 : 0); }
    if (p.retired !== undefined) { sets.push("retired=?"); args.push(p.retired ? 1 : 0); }
    if ("reason" in p) { sets.push("reason=?"); args.push(p.reason ?? null); }
    if (p.confirmedAt !== undefined) { sets.push("confirmed_at=?"); args.push(p.confirmedAt); }
    if (p.seen !== undefined) { sets.push("seen=?"); args.push(p.seen); }
    if (p.text !== undefined) { sets.push("text=?"); args.push(p.text); }
    if (p.evidence !== undefined) { sets.push("evidence=?"); args.push(p.evidence); }
    if (!sets.length) return;
    this.db.prepare(`UPDATE lessons SET ${sets.join(", ")} WHERE id=?`).run(...(args as never[]), rowId);
  }
  /** Run several changes as one transaction. */
  tx<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  playbook(taskType: string): PlaybookRow | undefined {
    const r = this.db.prepare("SELECT * FROM playbooks WHERE task_type=?").get(taskType) as { task_type: string; lines: string; retired: string; updated_at: number; goal_id: string | null } | undefined;
    return r ? { taskType: r.task_type, lines: JSON.parse(r.lines), retired: JSON.parse(r.retired), updatedAt: r.updated_at, ...(r.goal_id ? { goalId: r.goal_id } : {}) } : undefined;
  }
  playbooks(): PlaybookRow[] {
    return (this.db.prepare("SELECT task_type FROM playbooks ORDER BY task_type").all() as { task_type: string }[]).map((r) => this.playbook(r.task_type)!);
  }
  savePlaybook(p: PlaybookRow) {
    this.db.prepare("INSERT OR REPLACE INTO playbooks (task_type, lines, retired, updated_at, goal_id) VALUES (?,?,?,?,?)")
      .run(p.taskType, JSON.stringify(p.lines), JSON.stringify(p.retired.slice(-50)), p.updatedAt, p.goalId ?? null);
  }
}

const cache = new WeakMap<Store, RetroDb>();
/** The retro tables for a store (created on first use). */
export function retroDb(store: Store): RetroDb {
  let r = cache.get(store);
  if (!r) { r = new RetroDb(store.db); cache.set(store, r); }
  return r;
}
