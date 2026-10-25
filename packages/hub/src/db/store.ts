import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import type {
  AgentConfig, AgentScore, VersionScore, Approval, AuditEntry, Goal, LibraryDoc, MemoryEntry, MemoryProposal,
  Message, OrchestratorSettings, Room, RoomDeleteCounts, RoutingRecord, ServerEvent, Task,
} from "@agent-room/shared";
import { SETTING_DEFAULTS } from "@agent-room/shared";
import { id, now } from "../util.js";
import { ensureProvenance, isLive, ttlSetting, type Bare } from "../memory/model.js"; // 2.5

/**
 * Single SQLite store. Each row keeps its full object as JSON in `data`, with a few
 * indexed columns for lookups. Every write emits a ServerEvent for live clients.
 */
export class Store extends EventEmitter {
  db: Database.Database;

  constructor(file: string) {
    super();
    this.setMaxListeners(100);
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL"); // safe with WAL; far fewer fsyncs on every save
    this.db.pragma("temp_store = MEMORY");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room_id TEXT, created_at INTEGER, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, created_at);
      CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, room_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, room_id TEXT, goal_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, scope TEXT, owner TEXT, room_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, status TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scores (agent_id TEXT, task_type TEXT, data TEXT NOT NULL, PRIMARY KEY(agent_id, task_type));
      CREATE TABLE IF NOT EXISTS version_scores (agent_id TEXT, task_type TEXT, model_version TEXT, data TEXT NOT NULL, PRIMARY KEY(agent_id, task_type, model_version));
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, status TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (token TEXT PRIMARY KEY, name TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS routing (id TEXT PRIMARY KEY, at INTEGER, goal_id TEXT, task_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS routing_at ON routing(at);
      CREATE INDEX IF NOT EXISTS routing_goal ON routing(goal_id);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, room_id TEXT, goal_id TEXT, path TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_room ON documents(room_id);
      CREATE INDEX IF NOT EXISTS documents_path ON documents(path);
      CREATE INDEX IF NOT EXISTS tasks_goal ON tasks(goal_id);
      CREATE INDEX IF NOT EXISTS tasks_room ON tasks(room_id);
      CREATE INDEX IF NOT EXISTS goals_room ON goals(room_id);
      CREATE INDEX IF NOT EXISTS memory_scope ON memory(scope, owner, room_id);
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
      CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status);
    `);
  }

  private emitEvent(e: ServerEvent) { this.emit("event", e); }
  // Prepared once per distinct SQL string; the orchestrator polls the same few queries constantly.
  private stmts = new Map<string, Database.Statement>();
  private stmt(sql: string) {
    let st = this.stmts.get(sql);
    if (!st) { st = this.db.prepare(sql); this.stmts.set(sql, st); }
    return st;
  }
  private put(table: string, cols: Record<string, unknown>) {
    const keys = Object.keys(cols);
    this.stmt(
      `INSERT OR REPLACE INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    ).run(...(keys.map((k) => cols[k]) as never[]));
  }
  private all<T>(sql: string, ...args: unknown[]): T[] {
    return (this.stmt(sql).all(...(args as never[])) as { data: string }[]).map((r) => JSON.parse(r.data));
  }
  private one<T>(sql: string, ...args: unknown[]): T | undefined {
    const r = this.stmt(sql).get(...(args as never[])) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }

  // ---- key/value settings
  getKV<T>(k: string, fallback: T): T {
    const r = this.stmt("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined;
    return r ? JSON.parse(r.v) : fallback;
  }
  setKV(k: string, v: unknown) { this.put("kv", { k, v: JSON.stringify(v) }); }

  getSettings(): OrchestratorSettings {
    const base: OrchestratorSettings = {
      orchestratorAgentId: "claude",
      judgeRotation: ["claude", "codex"],
      explorationRate: 0.15,
      maxAttempts: 3,
      calibrationSampleRate: 0.1,
      ...SETTING_DEFAULTS,
    };
    return { ...base, ...this.getKV<Partial<OrchestratorSettings>>("orchestrator", {}) };
  }
  setSettings(s: OrchestratorSettings) { this.setKV("orchestrator", s); }

  // ---- devices (paired clients)
  addDevice(token: string, name: string) { this.put("devices", { token, name, created_at: now() }); }
  hasDevice(token: string) { return !!this.stmt("SELECT 1 FROM devices WHERE token=?").get(token); }
  listDevices() { return this.stmt("SELECT name, created_at FROM devices").all(); }

  // ---- rooms
  createRoom(name: string, extra: { dmAgentId?: string; topic?: string } = {}): Room {
    const room: Room = { id: id("room"), name, paused: false, createdAt: now(), ...extra };
    this.saveRoom(room); return room;
  }
  saveRoom(room: Room) { this.put("rooms", { id: room.id, data: JSON.stringify(room) }); this.emitEvent({ type: "room", room }); }
  getRoom(roomId: string) { return this.one<Room>("SELECT data FROM rooms WHERE id=?", roomId); }
  listRooms() { return this.all<Room>("SELECT data FROM rooms").sort((a, b) => a.createdAt - b.createdAt); }
  dmRoom(agentId: string, name: string) {
    return this.listRooms().find((r) => r.dmAgentId === agentId) ?? this.createRoom(name, { dmAgentId: agentId });
  }
  /**
   * Remove a room and everything scoped to it: its goals, tasks, messages, routing rows, approvals, documents, memory and memory proposals,
   * and, for the tables other modules create on first use, goal steps, reply turns, forks and night-shift sources. The room's fork lanes go with it.
   * One transaction. Touches only the database: nothing on disk, and the usage ledger, scores, lessons, juries and two-key records (history about
   * agents, not about the room) stay. Returns what was removed.
   */
  deleteRoom(roomId: string): RoomDeleteCounts {
    const has = (t: string) => !!this.stmt("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const run = (sql: string, ...args: unknown[]) => this.stmt(sql).run(...(args as never[])).changes;
    const goals = "SELECT id FROM goals WHERE room_id=?";
    return this.db.transaction((): RoomDeleteCounts => {
      const c: RoomDeleteCounts = { goals: 0, tasks: 0, messages: 0, routing: 0, approvals: 0, documents: 0, replyTurns: 0, goalSteps: 0, memory: 0, proposals: 0, forks: 0, writeProposals: 0, rooms: 0 };
      for (const lane of this.listRooms().filter((r) => r.forkOf === roomId)) for (const [k, n] of Object.entries(this.deleteRoom(lane.id))) c[k as keyof RoomDeleteCounts] += n;
      if (has("goal_steps")) c.goalSteps += run(`DELETE FROM goal_steps WHERE goal_id IN (${goals})`, roomId);
      if (has("nightshift_sources")) run(`DELETE FROM nightshift_sources WHERE goal_id IN (${goals})`, roomId);
      c.routing += run(`DELETE FROM routing WHERE goal_id IN (${goals}) OR json_extract(data,'$.roomId')=?`, roomId, roomId);
      c.approvals += run("DELETE FROM approvals WHERE json_extract(data,'$.roomId')=?", roomId);
      c.proposals += run("DELETE FROM proposals WHERE json_extract(data,'$.roomId')=?", roomId);
      c.memory += run("DELETE FROM memory WHERE room_id=?", roomId);
      c.documents += run("DELETE FROM documents WHERE room_id=?", roomId);
      c.tasks += run("DELETE FROM tasks WHERE room_id=?", roomId);
      c.goals += run("DELETE FROM goals WHERE room_id=?", roomId);
      c.messages += run("DELETE FROM messages WHERE room_id=?", roomId);
      if (has("reply_turns")) c.replyTurns += run("DELETE FROM reply_turns WHERE room_id=?", roomId);
      if (has("forks")) c.forks += run("DELETE FROM forks WHERE room_id=?", roomId);
      const wp = this.getKV<{ roomId?: string }[]>("write_proposals", []); // pending file write-backs asked for in this room
      const mine = wp.filter((p) => p.roomId === roomId);
      if (mine.length) { this.setKV("write_proposals", wp.filter((p) => p.roomId !== roomId)); c.writeProposals += mine.length; }
      const marks = this.getKV<Record<string, number>>("read_marks", {});
      if (roomId in marks) { delete marks[roomId]; this.setKV("read_marks", marks); }
      c.rooms += run("DELETE FROM rooms WHERE id=?", roomId);
      return c;
    })();
  }

  // ---- agents
  saveAgent(a: AgentConfig) { this.put("agents", { id: a.id, data: JSON.stringify(a) }); this.emitEvent({ type: "agent", agent: a }); }
  getAgent(agentId: string) { return this.one<AgentConfig>("SELECT data FROM agents WHERE id=?", agentId); }
  listAgents() { return this.all<AgentConfig>("SELECT data FROM agents"); }
  deleteAgent(agentId: string) { this.stmt("DELETE FROM agents WHERE id=?").run(agentId); }

  // ---- messages
  addMessage(m: Omit<Message, "id" | "createdAt">): Message {
    const msg: Message = { ...m, id: id("msg"), createdAt: now() };
    this.put("messages", { id: msg.id, room_id: msg.roomId, created_at: msg.createdAt, data: JSON.stringify(msg) });
    this.emitEvent({ type: "message", message: msg });
    return msg;
  }
  listMessages(roomId: string, limit = 200, since = 0) {
    return this.all<Message>(
      "SELECT data FROM (SELECT data, created_at, rowid r FROM messages WHERE room_id=? AND created_at>? ORDER BY created_at DESC, r DESC LIMIT ?) ORDER BY created_at ASC, r ASC",
      roomId, since, limit,
    );
  }

  // ---- goals & tasks
  saveGoal(g: Goal) { this.put("goals", { id: g.id, room_id: g.roomId, data: JSON.stringify(g) }); this.emitEvent({ type: "goal", goal: g }); }
  getGoal(goalId: string) { return this.one<Goal>("SELECT data FROM goals WHERE id=?", goalId); }
  listGoals(roomId: string) { return this.all<Goal>("SELECT data FROM goals WHERE room_id=?", roomId); }
  saveTask(t: Task) {
    t.updatedAt = now();
    this.put("tasks", { id: t.id, room_id: t.roomId, goal_id: t.goalId, data: JSON.stringify(t) });
    this.emitEvent({ type: "task", task: t });
  }
  deleteTask(taskId: string) { this.stmt("DELETE FROM tasks WHERE id=?").run(taskId); }
  getTask(taskId: string) { return this.one<Task>("SELECT data FROM tasks WHERE id=?", taskId); }
  /** 3.3: subagents (helpers) are tasks too, but the plan, ledger, budget and judging only ever see planned tasks, so they are left out unless `subagents` is set. */
  listTasks(filter: { roomId?: string; goalId?: string; subagents?: boolean }) {
    const rows = filter.goalId ? this.all<Task>("SELECT data FROM tasks WHERE goal_id=?", filter.goalId) : this.all<Task>("SELECT data FROM tasks WHERE room_id=?", filter.roomId);
    return filter.subagents ? rows : rows.filter((t) => t.kind !== "subagent");
  }

  // ---- memory. Shared rows are written only by the Orchestrator (the keeper).
  // 2.5: every row has a source and an expiry (filled in here when a caller leaves them out). Expired rows stay until
  // the keeper prunes them but never reach prompts, tools or context. A "memory" event tells the keeper to update the files.
  saveMemory(e: Bare): MemoryEntry {
    const row = ensureProvenance(e, { at: now(), ttl: ttlSetting(this.getSettings()) });
    this.put("memory", { id: row.id, scope: row.scope, owner: row.ownerAgentId ?? null, room_id: row.roomId ?? null, data: JSON.stringify(row) });
    this.emit("memory", { entry: row });
    return row;
  }
  deleteMemory(memId: string) {
    const prev = this.getMemory(memId);
    this.stmt("DELETE FROM memory WHERE id=?").run(memId);
    if (prev) this.emit("memory", { entry: prev, deleted: true });
  }
  getMemory(memId: string) { return this.one<MemoryEntry>("SELECT data FROM memory WHERE id=?", memId); }
  /** Every memory row, expired ones included (for the keeper, the files and the owner's "expired" view). */
  allMemory() { return this.all<MemoryEntry>("SELECT data FROM memory"); }
  listShared(roomId?: string, at = now()) {
    return this.all<MemoryEntry>(
      "SELECT data FROM memory WHERE scope='shared' AND (room_id IS NULL OR room_id=?)", roomId ?? null,
    ).filter((e) => isLive(e, at));
  }
  listPrivate(agentId: string, at = now()) { return this.all<MemoryEntry>("SELECT data FROM memory WHERE scope='private' AND owner=?", agentId).filter((e) => isLive(e, at)); }

  saveProposal(p: MemoryProposal) {
    this.put("proposals", { id: p.id, status: p.status, data: JSON.stringify(p) });
    this.emitEvent({ type: "proposal", proposal: p });
  }
  getProposal(pid: string) { return this.one<MemoryProposal>("SELECT data FROM proposals WHERE id=?", pid); }
  listProposals(status?: string) {
    return status
      ? this.all<MemoryProposal>("SELECT data FROM proposals WHERE status=?", status)
      : this.all<MemoryProposal>("SELECT data FROM proposals");
  }

  // ---- scores
  getScore(agentId: string, taskType: string): AgentScore {
    return this.one<AgentScore>("SELECT data FROM scores WHERE agent_id=? AND task_type=?", agentId, taskType)
      ?? { agentId, taskType, runs: 0, quality: 0, avgSeconds: 0, revisions: 0, failures: 0 };
  }
  saveScore(s: AgentScore) { this.put("scores", { agent_id: s.agentId, task_type: s.taskType, data: JSON.stringify(s) }); }
  listScores() { return this.all<AgentScore>("SELECT data FROM scores"); }

  // ---- 2.4 scores per model version (the `scores` table stays the agent-level roll-up)
  getVersionScore(agentId: string, taskType: string, modelVersion: string): VersionScore | undefined {
    return this.one<VersionScore>("SELECT data FROM version_scores WHERE agent_id=? AND task_type=? AND model_version=?", agentId, taskType, modelVersion);
  }
  saveVersionScore(s: VersionScore) {
    this.put("version_scores", { agent_id: s.agentId, task_type: s.taskType, model_version: s.modelVersion, data: JSON.stringify(s) });
  }
  listVersionScores(agentId?: string, taskType?: string): VersionScore[] {
    const where = [agentId ? "agent_id=?" : "", taskType ? "task_type=?" : ""].filter(Boolean).join(" AND ");
    return this.all<VersionScore>(`SELECT data FROM version_scores${where ? ` WHERE ${where}` : ""}`, ...[agentId, taskType].filter((x): x is string => !!x));
  }

  // ---- approvals
  saveApproval(a: Approval) {
    this.put("approvals", { id: a.id, status: a.status, data: JSON.stringify(a) });
    this.emitEvent({ type: "approval", approval: a });
  }
  getApproval(aid: string) { return this.one<Approval>("SELECT data FROM approvals WHERE id=?", aid); }
  listApprovals(status?: string) {
    return status
      ? this.all<Approval>("SELECT data FROM approvals WHERE status=?", status)
      : this.all<Approval>("SELECT data FROM approvals");
  }

  // ---- documents (the Library index; the files on disk are the source of truth)
  saveDocument(d: LibraryDoc) {
    this.put("documents", { id: d.id, room_id: d.roomId, goal_id: d.goalId ?? null, path: d.path, data: JSON.stringify(d) });
  }
  getDocument(docId: string) { return this.one<LibraryDoc>("SELECT data FROM documents WHERE id=?", docId); }
  listDocuments(filter: { roomId?: string; goalId?: string } = {}) {
    if (filter.goalId && filter.roomId) return this.all<LibraryDoc>("SELECT data FROM documents WHERE room_id=? AND goal_id=?", filter.roomId, filter.goalId);
    if (filter.goalId) return this.all<LibraryDoc>("SELECT data FROM documents WHERE goal_id=?", filter.goalId);
    if (filter.roomId) return this.all<LibraryDoc>("SELECT data FROM documents WHERE room_id=?", filter.roomId);
    return this.all<LibraryDoc>("SELECT data FROM documents");
  }
  findDocumentByPath(path: string) { return this.one<LibraryDoc>("SELECT data FROM documents WHERE path=?", path); }

  // ---- routing decision log (0.2). Append-only: records are completed in place, never deleted.
  saveRouting(r: RoutingRecord) { this.put("routing", { id: r.id, at: r.at, goal_id: r.goalId, task_id: r.taskId, data: JSON.stringify(r) }); }
  getRouting(rid: string) { return this.one<RoutingRecord>("SELECT data FROM routing WHERE id=?", rid); }
  listRouting(filter: { goalId?: string; taskId?: string; since?: number; limit?: number } = {}) {
    const limit = filter.limit ?? 100_000;
    if (filter.goalId) return this.all<RoutingRecord>("SELECT data FROM routing WHERE goal_id=? ORDER BY at ASC, rowid ASC LIMIT ?", filter.goalId, limit);
    if (filter.taskId) return this.all<RoutingRecord>("SELECT data FROM routing WHERE task_id=? ORDER BY at ASC, rowid ASC LIMIT ?", filter.taskId, limit);
    return this.all<RoutingRecord>("SELECT data FROM routing WHERE at>=? ORDER BY at ASC, rowid ASC LIMIT ?", filter.since ?? 0, limit);
  }

  // ---- audit
  audit(actor: string, action: string, detail: string) {
    const e: AuditEntry = { id: id("aud"), at: now(), actor, action, detail };
    this.put("audit", { id: e.id, at: e.at, data: JSON.stringify(e) });
  }
  listAudit(limit = 500) { return this.all<AuditEntry>("SELECT data FROM audit ORDER BY at DESC LIMIT ?", limit); }
}
