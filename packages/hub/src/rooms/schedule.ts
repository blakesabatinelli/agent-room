import type { Goal, Room } from "@agent-room/shared";
import type { Attention } from "../attention/index.js";
import type { ControlFolder } from "../control/folder.js";
import type { Store } from "../db/store.js";
import { firesBetween, nextFire, parseCron, type Cron } from "./cron.js";
import { describeInstant, validZone } from "./zone.js";

/**
 * 4.3 The calendar trigger. A room whose ROOM.md has `schedule` (a 5-field cron) and `standing_goal` starts a goal in that room
 * on schedule, as the owner ("Scheduled: <the goal>"). Rules:
 *
 *  - The time zone is the room's `timezone`, else USER.md's, else the hub's.
 *  - The last slot handled for each room is saved before anything starts, so a restart never runs a slot twice.
 *  - If the room's previous scheduled goal is still going (including one waiting for the owner to approve its plan), this run is
 *    skipped and the room gets a quiet note.
 *  - If the hub was asleep at a scheduled time it catches up ONCE (however many slots passed), when the latest missed slot is within
 *    `catch_up_hours` (the room's, else the hub setting `standingCatchUpHours`, default 12). Older than that: skipped, and the digest says so.
 *  - A schedule that was just added or changed has nothing overdue: it starts from now.
 */

export const DEFAULT_CATCH_UP_HOURS = 12;
/** A run this much later than its slot counts as a catch-up (a busy hub can be a few minutes behind without having slept). */
const ON_TIME_MS = 5 * 60_000;
const HOUR = 3_600_000;
const ACTIVE: Goal["status"][] = ["planning", "awaiting_approval", "running", "paused"];
const KEY = "standing_rooms";
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

export interface StandingHost {
  store: Store;
  control: () => ControlFolder | undefined;
  /** Where goals and digest notes go. */
  attention: Pick<Attention, "notify">;
  /** Start a goal (Orchestrator.runGoal). The goal is saved before the first await, so the trigger can find it straight away. */
  runGoal(roomId: string, text: string, opts: { scheduled: NonNullable<Goal["scheduled"]> }): Promise<Goal>;
  /** A note for the room's work log that doesn't interrupt the conversation. */
  note(roomId: string, text: string): void;
  /** The zone to use when neither the room nor USER.md names one. */
  fallbackZone(): string;
  /** The owner's name for the message the trigger posts. */
  ownerName(): string;
}

/** What the trigger knows about one room. Saved in KV `standing_rooms`, keyed by room id. */
export interface StandingState {
  cron: string;
  zone: string;
  /** The latest slot handled (run, skipped or missed). Nothing at or before it is ever run again. */
  handled: number;
  lastSlot?: number;
  lastGoalId?: string;
  lastRunAt?: number;
  /** The last thing worth telling the owner: a skip, a catch-up, a miss. */
  note?: string;
}

export interface RoomSchedule {
  cron: Cron;
  expr: string;
  zone: string;
  goal: string;
  catchUpHours: number;
}

export type TickOutcome =
  | { roomId: string; kind: "started"; slot: number; goalId: string; catchUp: boolean; skippedEarlier: number }
  | { roomId: string; kind: "busy" | "paused" | "missed" | "init"; slot?: number; note?: string };

export class StandingRooms {
  /** The time. Tests swap it for a fake clock. */
  clock: () => number = () => Date.now();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private d: StandingHost) {}

  // ---------------------------------------------------------------- reading ROOM.md

  /** The schedule a room's ROOM.md defines and is usable, or why not. */
  scheduleOf(roomId: string): { ok: true; schedule: RoomSchedule } | { ok: false; problem?: string } {
    const c = this.d.control();
    const slug = c?.slugFor(roomId);
    const fm = slug ? c?.snapshot().rooms[slug]?.room?.fm : undefined;
    if (!c || !fm || fm.schedule === undefined) return { ok: false };
    const p = parseCron(fm.schedule);
    if (!p.ok) return { ok: false, problem: `The schedule isn't valid: ${p.error}.` };
    const goal = fm.standing_goal?.trim();
    if (!goal) return { ok: false, problem: "There is a schedule but no standing_goal, so there is nothing to run." };
    const zone = [fm.timezone, c.timezone(), this.d.fallbackZone()].find(validZone) ?? "UTC";
    const hours = fm.catch_up_hours ?? this.catchUpDefault();
    return { ok: true, schedule: { cron: p.cron, expr: fm.schedule.trim(), zone, goal, catchUpHours: hours } };
  }

  private catchUpDefault(): number {
    const v = this.d.store.getSettings().standingCatchUpHours;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_CATCH_UP_HOURS;
  }

  // ---------------------------------------------------------------- saved state

  private states(): Record<string, StandingState> { return this.d.store.getKV<Record<string, StandingState>>(KEY, {}); }
  state(roomId: string): StandingState | undefined { return this.states()[roomId]; }
  private save(roomId: string, s: StandingState | undefined) {
    const all = this.states();
    if (s) all[roomId] = s; else delete all[roomId];
    this.d.store.setKV(KEY, all);
  }

  /** The next scheduled time after now, for the room's settings screen. */
  nextRun(roomId: string): number | undefined {
    const s = this.scheduleOf(roomId);
    return s.ok ? nextFire(s.schedule.cron, this.clock(), s.schedule.zone) : undefined;
  }

  /** Is the room's last scheduled goal still going? */
  running(roomId: string): boolean {
    const id = this.state(roomId)?.lastGoalId;
    const g = id ? this.d.store.getGoal(id) : undefined;
    return !!g && ACTIVE.includes(g.status);
  }

  // ---------------------------------------------------------------- the clock

  start(everyMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.d.store.audit("hub", "standing.error", String((e as Error).message).slice(0, 300)); } }, everyMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = undefined; }

  /** Look at every room once. Safe to call as often as you like: a slot is handled once. */
  tick(): TickOutcome[] {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const out: TickOutcome[] = [];
      const now = this.clock();
      for (const room of this.d.store.listRooms()) {
        if (room.dmAgentId || room.forkId) continue; // 4.4: a fork lane never runs a schedule
        const o = this.tickRoom(room, now);
        if (o) out.push(o);
      }
      return out;
    } finally { this.ticking = false; }
  }

  private tickRoom(room: Room, now: number): TickOutcome | undefined {
    const sched = this.scheduleOf(room.id);
    const st = this.state(room.id);
    if (!sched.ok) { if (st) this.save(room.id, undefined); return undefined; } // no usable schedule: nothing is overdue when there is one again
    const s = sched.schedule;
    if (!st || st.cron !== s.expr || st.zone !== s.zone) { // new, or changed: it starts from now
      this.save(room.id, { cron: s.expr, zone: s.zone, handled: now });
      return { roomId: room.id, kind: "init" };
    }
    const { slots, total } = firesBetween(s.cron, st.handled, now, s.zone);
    if (!slots.length) return undefined;
    const slot = slots[slots.length - 1];
    const earlier = total - 1;
    const next: StandingState = { ...st, handled: slot }; // written first: a crash or restart from here on never runs this slot again
    this.save(room.id, next);

    const when = describeInstant(slot, s.zone);
    const title = clip(s.goal, 80);
    const late = now - slot;
    const skippedWords = earlier > 0 ? ` ${earlier} earlier run${earlier === 1 ? " was" : "s were"} missed too.` : "";

    if (late > Math.max(s.catchUpHours * HOUR, ON_TIME_MS)) {
      const note = `Missed: "${title}" was due ${when}, but the hub wasn't running then and it is more than ${s.catchUpHours} hour${s.catchUpHours === 1 ? "" : "s"} ago, so it wasn't run.${skippedWords}`;
      this.save(room.id, { ...next, note });
      this.d.attention.notify("info", { title: `Missed: ${title}`, body: note, roomId: room.id, key: `standing:missed:${room.id}:${slot}` });
      this.d.store.audit("hub", "standing.missed", `${room.name}: ${when}`);
      return { roomId: room.id, kind: "missed", slot, note };
    }
    const prev = st.lastGoalId ? this.d.store.getGoal(st.lastGoalId) : undefined;
    if (prev && ACTIVE.includes(prev.status)) {
      const note = `Skipped the scheduled run for ${when}: the last one ("${clip(prev.contract?.objective ?? prev.text, 60)}") is still going.`;
      this.save(room.id, { ...next, note });
      this.d.note(room.id, note);
      this.d.store.audit("hub", "standing.skipped", `${room.name}: ${when}, last run still going`);
      return { roomId: room.id, kind: "busy", slot, note };
    }
    if (this.d.store.getRoom(room.id)?.paused) {
      const note = `Skipped the scheduled run for ${when}: the room is paused.`;
      this.save(room.id, { ...next, note });
      this.d.note(room.id, note);
      return { roomId: room.id, kind: "paused", slot, note };
    }

    const catchUp = late > ON_TIME_MS;
    this.d.store.addMessage({ roomId: room.id, author: { kind: "human", id: "owner", name: this.d.ownerName() }, text: `Scheduled: ${s.goal}`, type: "human", mentions: [] });
    const mark = { slot, ...(catchUp ? { catchUp: true } : {}) };
    void this.d.runGoal(room.id, s.goal, { scheduled: mark }).catch((e) => this.d.store.audit("hub", "standing.error", `${room.name}: ${String((e as Error).message).slice(0, 200)}`));
    const goal = this.d.store.listGoals(room.id).find((g) => g.scheduled?.slot === slot);
    const note = catchUp ? `Caught up: ran "${title}" for ${when}; the hub wasn't running then.${skippedWords}` : earlier > 0 ? `Ran "${title}" for ${when}.${skippedWords}` : undefined;
    this.save(room.id, { ...next, lastSlot: slot, lastGoalId: goal?.id, lastRunAt: now, ...(note ? { note } : {}) });
    this.d.store.audit("hub", catchUp ? "standing.caught_up" : "standing.fired", `${room.name}: ${when}${goal ? ` goal ${goal.id}` : ""}`);
    if (catchUp) {
      this.d.note(room.id, note!);
      this.d.attention.notify("info", { title: `Caught up: ${title}`, body: note!, roomId: room.id, goalId: goal?.id, key: `standing:caught-up:${room.id}:${slot}` });
    }
    return { roomId: room.id, kind: "started", slot, goalId: goal?.id ?? "", catchUp, skippedEarlier: earlier };
  }
}
