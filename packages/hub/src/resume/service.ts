import type { AgentResume, ProbationStatus, RoutingRecord } from "@agent-room/shared";
import type { ControlFolder } from "../control/folder.js";
import type { Store } from "../db/store.js";
import { buildResume, noteOwnerRating } from "./build.js";
import { renderResume } from "./file.js";
import { countRuns, endProbation, onProbation, probationAgentIds, probationRuns, probationState, probationStatus, startProbation } from "./probation.js";

/**
 * 2.3 The orchestrator's résumé keeper. It:
 *  - rewrites `agents/<id>/RESUME.md` after graded runs, at most once a minute per agent (a run inside the minute is
 *    picked up by one trailing write), and always at the end of a goal;
 *  - keeps the latest résumé of each agent in the database (KV `resume.latest`), so everything works with no control folder;
 *  - ends probation when an agent has enough graded runs, with one line in the room and an audit entry;
 *  - lets the owner end or restart probation.
 * It listens for the store's "graded" event (orchestrator/routing.ts closeRecord), so the orchestrator itself needs no
 * call after each run.
 */

export interface ResumesOptions {
  store: Store;
  control: () => ControlFolder | undefined;
  /** One visible line in a room (the graduation line). */
  say: (roomId: string | undefined, text: string) => void;
  now?: () => number;
  /** Minimum time between two writes of one agent's RESUME.md. Default one minute. */
  debounceMs?: number;
}

const LATEST = "resume.latest";
const today = (at: number) => new Date(at).toISOString().slice(0, 10);

export class Resumes {
  private store: Store;
  /** Clock and debounce, public so tests can drive them. */
  now: () => number;
  debounceMs: number;
  private last = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  private chain: Promise<unknown> = Promise.resolve();
  /** How many RESUME.md writes happened (tests count commits through the control folder's history instead; this is for diagnostics). */
  writes = 0;

  constructor(private o: ResumesOptions) {
    this.store = o.store;
    this.now = o.now ?? Date.now;
    this.debounceMs = o.debounceMs ?? 60_000;
    this.store.on("graded", (r: RoutingRecord) => { try { this.onGraded(r); } catch (e) { this.store.audit("orchestrator", "resume.failed", String((e as Error)?.message ?? e).slice(0, 300)); } });
  }

  // ---------- reading

  /** The résumé as it stands now, from the record. */
  live(agentId: string): AgentResume { return buildResume(this.store, agentId, this.now()); }
  /** The last one written (database copy), if any. */
  latest(agentId: string): AgentResume | undefined { return this.store.getKV<Record<string, AgentResume>>(LATEST, {})[agentId]; }

  // ---------- after a graded run

  /** A run was graded: end probation if that was the last one it needed, then schedule the RESUME.md write. */
  onGraded(r: RoutingRecord) {
    if (!r.chosen || !this.store.getAgent(r.chosen)) return;
    this.graduate(r.chosen, r.roomId);
    this.schedule(r.chosen);
  }

  /** The owner rated a judged task: it is evidence about the agent too (judges against the owner). */
  noteRating(agentId: string, judgeScore: number, ownerScore: number) {
    noteOwnerRating(this.store, agentId, judgeScore, ownerScore);
    this.schedule(agentId);
  }

  /** Probation ends the moment an agent has the runs it needs. */
  graduate(agentId: string, roomId?: string): ProbationStatus | undefined {
    const st = probationState(this.store, agentId);
    if (!st?.on) return undefined;
    const c = countRuns(this.store, agentId, st.since);
    if (c.graded < probationRuns(this.store)) return undefined;
    const ended = endProbation(this.store, agentId, "threshold", this.now());
    if (!ended) return undefined;
    const name = this.store.getAgent(agentId)?.name ?? agentId;
    const what = c.shadowRuns === c.graded ? "shadow tasks" : c.shadowRuns ? "graded tasks, some of them shadow tasks" : "graded tasks";
    this.o.say(roomId ?? this.generalRoom(), `${name} finished probation: ${(c.mean ?? 0).toFixed(2)} over ${c.graded} ${what}`);
    this.schedule(agentId, true);
    return ended;
  }

  private generalRoom() { const rooms = this.store.listRooms(); return (rooms.find((r) => r.name === "general") ?? rooms[0])?.id; }

  // ---------- the owner's switch

  /** Owner: end probation now (on=false) or start it again, counting from now (on=true). */
  setProbation(agentId: string, on: boolean): ProbationStatus | undefined {
    if (!this.store.getAgent(agentId)) return undefined;
    if (on) startProbation(this.store, agentId, "owner", this.now());
    else endProbation(this.store, agentId, "owner", this.now());
    this.schedule(agentId, true);
    return probationStatus(this.store, agentId);
  }

  /** A new agent (POST /agents, discovery): on probation unless it already has the runs to show. */
  newAgent(agentId: string) {
    startProbation(this.store, agentId, "new", this.now());
    this.schedule(agentId, true);
  }

  // ---------- writing RESUME.md

  /** Write soon. At most one write a minute per agent: a request inside the minute becomes one write when it is up. `now` skips the wait. */
  schedule(agentId: string, now = false) {
    const t = this.now();
    const due = (this.last.get(agentId) ?? -Infinity) + this.debounceMs;
    if (this.timers.has(agentId)) { if (now) this.fire(agentId); return; }
    if (now || t >= due) { this.last.set(agentId, t); this.enqueue(agentId); return; }
    const timer = setTimeout(() => { this.timers.delete(agentId); this.last.set(agentId, this.now()); this.enqueue(agentId); }, Math.max(1, due - t));
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  private fire(agentId: string) {
    const timer = this.timers.get(agentId); if (timer) clearTimeout(timer);
    this.timers.delete(agentId); this.last.set(agentId, this.now()); this.enqueue(agentId);
  }

  private enqueue(agentId: string) {
    this.chain = this.chain.catch(() => undefined).then(() => this.write(agentId)).catch((e) => {
      try { this.store.audit("orchestrator", "resume.failed", `${agentId}: ${String((e as Error)?.message ?? e)}`.slice(0, 300)); } catch { /* nothing more to do */ }
    });
  }

  /** Rebuild one agent's résumé: the database copy, then RESUME.md through the control folder. */
  async write(agentId: string): Promise<"written" | "unchanged" | "skipped"> {
    if (!this.store.getAgent(agentId)) return "skipped";
    const at = this.now();
    const r = this.live(agentId);
    const all = this.store.getKV<Record<string, AgentResume>>(LATEST, {});
    all[agentId] = r; this.store.setKV(LATEST, all);
    const c = this.o.control();
    if (!c) return "skipped";
    const rel = `agents/${agentId}/RESUME.md`;
    const res = await c.writeManaged(rel, (cur) => renderResume(r, { today: today(at), existing: cur }).text,
      `Résumé: ${r.name}, ${r.runs} graded run${r.runs === 1 ? "" : "s"}`, "orchestrator");
    if (res === "written") this.writes += 1;
    return res;
  }

  /** The end of a goal: every agent that worked on it gets a fresh RESUME.md now, whatever the debounce says. */
  async goalEnded(goalId: string) {
    const ids = new Set(this.store.listRouting({ goalId }).filter((r) => r.kind !== "direct").map((r) => r.chosen));
    for (const id of ids) this.fire(id);
    await this.settle();
  }

  /** Wait for every write that is due or queued, trailing ones included (tests, shutdown). */
  async settle() {
    for (const id of [...this.timers.keys()]) this.fire(id);
    await this.chain;
    await this.o.control()?.idle();
  }

  /**
   * Hub start: a practice run that was in flight when the hub stopped can never finish; close its row. An agent that
   * reached its runs while the hub was off graduates now, and a RESUME.md that was deleted is written again.
   */
  sweep() {
    const rows = this.store.db.prepare("SELECT data FROM routing WHERE json_extract(data,'$.kind')='shadow' AND json_extract(data,'$.outcome')='pending'").all() as { data: string }[];
    for (const row of rows) {
      const r = JSON.parse(row.data) as RoutingRecord;
      this.store.saveRouting({ ...r, outcome: "interrupted", failureNote: "the hub stopped during this practice run", completedAt: this.now() });
    }
    for (const id of probationAgentIds(this.store)) this.graduate(id);
    const c = this.o.control();
    if (c) for (const a of this.store.listAgents()) {
      if (!c.snapshot().agents[a.id]?.resume && (this.live(a.id).runs > 0 || onProbation(this.store, a.id))) this.schedule(a.id, true);
    }
    return rows.length;
  }
}
