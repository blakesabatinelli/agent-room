// Reply turns: every time the hub asks an agent to answer in a room (a DM, a tag, a roll call, a question from another agent), that is one turn,
// logged from start to end. A turn has exactly one reply in the room. If the agent posts with the MCP tool during the turn, that post is the
// reply and its final answer is not posted again; a second post in the same turn is dropped and counted. The same message never opens two
// turns for the same agent, so one @all can't make an agent answer twice. The log is kept in the `reply_turns` table (GET /rooms/:id/turns).
import type { Store } from "../db/store.js";
import { id } from "../util.js";

export type TurnKind = "owner" | "tag" | "rollcall" | "ask" | "aside";
export type TurnStatus = "open" | "answered" | "failed" | "skipped";
export interface ReplyTurn {
  id: string; roomId: string; agentId: string; kind: TurnKind;
  /** The message that asked for this reply. */
  triggerId?: string;
  status: TurnStatus;
  /** The reply in the room, and how it got there: the agent's own post (MCP) or the hub posting its answer. */
  messageId?: string; via?: "post" | "answer";
  /** Posts after the reply that were not let into the room. */
  dropped: number;
  error?: string;
  startedAt: number; endedAt?: number;
}

export class ReplyTurns {
  private open = new Map<string, ReplyTurn>(); // `${agentId}|${roomId}`
  private seen = new Map<string, string>(); // `${triggerId}|${agentId}` -> turn id, so a message never asks the same agent twice
  constructor(private store: Store, private clock: () => number = Date.now) {
    store.db.exec("CREATE TABLE IF NOT EXISTS reply_turns (id TEXT PRIMARY KEY, room_id TEXT, agent_id TEXT, trigger_id TEXT, at INTEGER, data TEXT NOT NULL)");
  }

  /** Opens a turn, or returns undefined when this message already asked this agent (or the agent is already answering in this room). */
  start(roomId: string, agentId: string, kind: TurnKind, triggerId?: string): ReplyTurn | undefined {
    if (triggerId && (this.seen.has(`${triggerId}|${agentId}`) || this.fromTable(triggerId, agentId))) return undefined;
    if (this.open.has(`${agentId}|${roomId}`) && triggerId && this.open.get(`${agentId}|${roomId}`)!.triggerId === triggerId) return undefined;
    const t: ReplyTurn = { id: id("turn"), roomId, agentId, kind, ...(triggerId ? { triggerId } : {}), status: "open", dropped: 0, startedAt: this.clock() };
    this.open.set(`${agentId}|${roomId}`, t);
    if (triggerId) this.seen.set(`${triggerId}|${agentId}`, t.id);
    this.save(t);
    return t;
  }

  /** The agent's open turn in this room; with no room, its only open turn anywhere. */
  current(agentId: string, roomId?: string): ReplyTurn | undefined {
    if (roomId) return this.open.get(`${agentId}|${roomId}`);
    const mine = [...this.open.values()].filter((t) => t.agentId === agentId);
    return mine.length === 1 ? mine[0] : undefined;
  }

  /** The turn's reply is in the room. */
  replied(t: ReplyTurn, messageId: string, via: "post" | "answer") { t.messageId = messageId; t.via = via; t.status = "answered"; this.save(t); }
  /** A post after the reply was kept out of the room. */
  extra(t: ReplyTurn) { t.dropped++; this.save(t); }

  end(t: ReplyTurn, status: Exclude<TurnStatus, "open">, error?: string) {
    t.status = t.messageId ? "answered" : status;
    if (error && !t.messageId) t.error = error.slice(0, 300);
    t.endedAt = this.clock();
    if (this.open.get(`${t.agentId}|${t.roomId}`)?.id === t.id) this.open.delete(`${t.agentId}|${t.roomId}`);
    this.save(t);
  }

  list(roomId: string, limit = 100): ReplyTurn[] {
    return (this.store.db.prepare("SELECT data FROM reply_turns WHERE room_id = ? ORDER BY at DESC LIMIT ?").all(roomId, limit) as { data: string }[]).map((r) => JSON.parse(r.data) as ReplyTurn);
  }
  get(turnId: string): ReplyTurn | undefined {
    const r = this.store.db.prepare("SELECT data FROM reply_turns WHERE id = ?").get(turnId) as { data: string } | undefined;
    return r ? JSON.parse(r.data) as ReplyTurn : undefined;
  }

  private fromTable(triggerId: string, agentId: string) {
    return !!this.store.db.prepare("SELECT 1 FROM reply_turns WHERE trigger_id = ? AND agent_id = ? LIMIT 1").get(triggerId, agentId);
  }
  private save(t: ReplyTurn) {
    this.store.db.prepare("INSERT INTO reply_turns (id, room_id, agent_id, trigger_id, at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(t.id, t.roomId, t.agentId, t.triggerId ?? null, t.startedAt, JSON.stringify(t));
  }
}
