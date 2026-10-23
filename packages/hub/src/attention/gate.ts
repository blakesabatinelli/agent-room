import { ATTENTION_DEFAULTS, ATTENTION_DEFAULT_TIMEZONE } from "@agent-room/shared";
import type { Approval, AttentionDay, AttentionItem, AttentionKind, AttentionResult, AttentionSettings, AttentionState, Message, ServerEvent } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { pushNotify } from "../net.js";
import { id } from "../util.js";
import { digestPush, renderDigest, type DigestInput, type DigestNumbers } from "./digest.js";
import { dayBounds, dayKey, inQuiet, lastOccurrence, parseClock, validZone } from "./time.js";

/**
 * 2.7 The attention gate. Every alert meant for the owner goes through `notify(kind, payload)`.
 *
 *  - `decision` (a plan to approve, an approval, an agent that needs input, a question) and `disagreement` (the judges split)
 *    are interruptions: a push to the phone, counted per local day, up to `dailyInterruptCap`.
 *    Past the cap they wait for the evening digest, except an approval that blocks running work: that always goes through and is counted.
 *  - Quiet hours hold every push (blocking approvals too). What was held goes out as one push when quiet hours end.
 *  - Everything else (goal done, model shifts, retros, recovered failures, reports) is queued for the digest.
 *
 * The apps are not gated: an approval card, a plan card and every room post are in the app the moment they exist. What the gate
 * controls is the push to the phone, and which items are listed in the digest. Informational room posts are made quiet by their callers.
 */

export interface AttentionPayload {
  title: string;
  body?: string;
  roomId?: string;
  goalId?: string;
  taskId?: string;
  /** An approval that is holding up running work. Always pushed (outside quiet hours), counted, never queued for the cap. */
  blocking?: boolean;
  /** Same key twice is one alert (an approval seen twice, a restart that re-posts). */
  key?: string;
}

export type Push = (title: string, body: string) => void | Promise<unknown>;

const INTERRUPTS: ReadonlySet<AttentionKind> = new Set(["decision", "disagreement"]);
export const interrupts = (k: AttentionKind) => INTERRUPTS.has(k);

const MAX_QUEUE = 500;
const KEEP_DAYS = 120;
/** A digest later than this after its time is "late" (the hub was asleep). */
const LATE_MS = 15 * 60_000;
const emptyDay = (): AttentionDay => ({ interrupts: 0, overCap: 0, queued: 0, held: 0, goalsDone: 0, digests: 0 });
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const ORCH = { kind: "orchestrator", id: "orchestrator", name: "Orchestrator" } as const;

interface DigestMark { handledAt: number; sentAt?: number; day: string }

export class Attention {
  /** How a push reaches the phone (ntfy). Tests swap it. */
  push: Push = (t, b) => pushNotify(t, b);
  /** The time. Tests swap it for a fake clock. */
  clock: () => number = () => Date.now();
  /** The owner's time zone from USER.md, when a control folder is attached (the orchestrator sets this). */
  zoneHint: () => string | undefined = () => undefined;
  private timer?: NodeJS.Timeout;
  private recent: string[] = [];

  constructor(private store: Store) {
    store.on("event", this.onEvent);
  }

  // ---- settings
  settings(): AttentionSettings & { timezone: string } {
    const s = { ...ATTENTION_DEFAULTS, ...(this.store.getSettings().attention ?? {}) };
    const cap = Number.isFinite(s.dailyInterruptCap) ? Math.max(0, Math.floor(s.dailyInterruptCap)) : ATTENTION_DEFAULTS.dailyInterruptCap;
    const timezone = [s.timezone, this.zoneHint()].find(validZone) ?? ATTENTION_DEFAULT_TIMEZONE;
    return {
      dailyInterruptCap: cap,
      digestAt: parseClock(s.digestAt) === undefined ? ATTENTION_DEFAULTS.digestAt : s.digestAt,
      quietFrom: parseClock(s.quietFrom) === undefined ? ATTENTION_DEFAULTS.quietFrom : s.quietFrom,
      quietTo: parseClock(s.quietTo) === undefined ? ATTENTION_DEFAULTS.quietTo : s.quietTo,
      timezone,
    };
  }

  // ---- stored state
  private queue(): AttentionItem[] { return this.store.getKV<AttentionItem[]>("attention_queue", []); }
  private saveQueue(q: AttentionItem[]) { this.store.setKV("attention_queue", q.slice(-MAX_QUEUE)); }
  private days(): Record<string, AttentionDay> { return this.store.getKV<Record<string, AttentionDay>>("attention_days", {}); }
  private bump(day: string, f: (d: AttentionDay) => void): AttentionDay {
    const all = this.days();
    const d = { ...emptyDay(), ...(all[day] ?? {}) };
    f(d); all[day] = d;
    const keys = Object.keys(all).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete all[k];
    this.store.setKV("attention_days", all);
    return d;
  }
  /** Counts for one local day (default today). */
  day(day?: string): AttentionDay { return { ...emptyDay(), ...(this.days()[day ?? dayKey(this.clock(), this.settings().timezone)] ?? {}) }; }
  /** Counts for a range of local days, for the scorecard. */
  dayRange(first: string, last: string): { day: string; d: AttentionDay }[] {
    return Object.entries(this.days()).filter(([k]) => k >= first && k <= last).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ day: k, d: { ...emptyDay(), ...v } }));
  }
  /** When the gate first ran. A digest is never "missed" for a time before this (a fresh install has nothing to catch up on). */
  private since(): number {
    const v = this.store.getKV<number | null>("attention_since", null);
    if (typeof v === "number") return v;
    const at = this.clock(); this.store.setKV("attention_since", at); return at;
  }
  private mark(): DigestMark | null { return this.store.getKV<DigestMark | null>("attention_digest", null); }

  state(): AttentionState {
    const s = this.settings();
    return { settings: s, today: dayKey(this.clock(), s.timezone), day: this.day(), queue: this.queue(), lastDigestAt: this.mark()?.sentAt ?? null };
  }

  // ---- the gate
  notify(kind: AttentionKind, p: AttentionPayload): AttentionResult {
    const at = this.clock();
    this.since();
    if (p.key) {
      if (this.recent.includes(p.key) || this.queue().some((i) => i.key === p.key)) return { action: "duplicate" };
      this.recent = [...this.recent.slice(-199), p.key];
    }
    const s = this.settings();
    const day = dayKey(at, s.timezone);
    const item = (why: AttentionItem["why"], held?: boolean): AttentionItem => ({
      id: id("att"), at, kind, title: clip(p.title, 160), body: clip(p.body ?? "", 300), why, ...(held ? { held } : {}),
      ...(p.roomId ? { roomId: p.roomId } : {}), ...(p.goalId ? { goalId: p.goalId } : {}), ...(p.taskId ? { taskId: p.taskId } : {}), ...(p.key ? { key: p.key } : {}),
    });
    const enqueue = (i: AttentionItem) => this.saveQueue([...this.queue(), i]);

    if (!interrupts(kind)) { enqueue(item("digest")); return { action: "queued", reason: "digest" }; }

    if (inQuiet(at, s.timezone, parseClock(s.quietFrom), parseClock(s.quietTo))) {
      enqueue(item("quiet", true));
      this.bump(day, (d) => { d.held++; });
      return { action: "held", reason: "quiet" };
    }
    const used = this.day(day).interrupts;
    if (!p.blocking && used >= s.dailyInterruptCap) {
      enqueue(item("cap"));
      this.bump(day, (d) => { d.queued++; });
      if (used === s.dailyInterruptCap) this.store.audit("attention", "attention.cap", `${used} interruptions today (${day}); the rest wait for the digest`);
      return { action: "queued", reason: "cap", used, cap: s.dailyInterruptCap };
    }
    const d = this.bump(day, (x) => { x.interrupts++; if (used >= s.dailyInterruptCap) x.overCap++; });
    this.deliver(p.title, p.body ?? "");
    return { action: "pushed", used: d.interrupts, cap: s.dailyInterruptCap };
  }

  private deliver(title: string, body: string) {
    try { void Promise.resolve(this.push(title, body)).catch(() => undefined); } catch { /* a push is best effort */ }
  }

  // ---- what the store tells us about on its own
  private onEvent = (e: ServerEvent | { type: "jury_split"; taskId: string; goalId: string; juryId: string; judges: { family: string; verdict: string }[] }) => {
    try {
      if (e.type === "approval") {
        const a: Approval = e.approval;
        if (a.status !== "pending") return;
        if (a.twoKey) { // 4.1: the two agents' drafts differ (or there is no second key): the owner decides. Blocking work, so it is always pushed.
          this.notify(a.twoKey.verdict === "unavailable" ? "decision" : "disagreement", {
            title: a.twoKey.verdict === "unavailable" ? "Approval needed: no second key" : "Two agents disagree",
            body: `${a.agentId} wants to ${a.twoKey.kind === "email" ? "send an email" : a.twoKey.kind === "crm" ? "write to the CRM" : "delete something"}. ${a.twoKey.why}`, roomId: a.roomId, blocking: true, key: `approval:${a.id}`,
          });
          return;
        }
        this.notify("decision", a.question
          ? { title: "A question for you", body: a.action, roomId: a.roomId, key: `approval:${a.id}` }
          : { title: "Approval needed", body: `${a.agentId} wants to use ${a.tool}: ${a.action}`, roomId: a.roomId, blocking: true, key: `approval:${a.id}` });
      } else if (e.type === "jury_split") {
        const t = this.store.getTask(e.taskId);
        this.notify("disagreement", {
          title: "The judges disagree", body: `"${t?.title ?? "A task"}": ${e.judges.map((j) => `${j.family} ${j.verdict}`).join(", ")}`,
          roomId: t?.roomId, goalId: e.goalId, taskId: e.taskId, key: `jury:${e.juryId}`,
        });
      }
    } catch { /* an alert never breaks a write */ }
  };

  /** A goal ended. Done goals count in the day's numbers and wait for the digest; failed ones are listed too. */
  goalEnded(goalId: string) {
    const g = this.store.getGoal(goalId);
    if (!g || (g.status !== "done" && g.status !== "failed")) return;
    const tasks = this.store.listTasks({ goalId });
    const name = clip(g.contract?.objective ?? g.text, 100);
    const done = tasks.filter((t) => t.status === "done").length;
    if (g.status === "done") {
      this.bump(dayKey(this.clock(), this.settings().timezone), (d) => { d.goalsDone++; });
      this.notify("goal_done", { title: `Done: ${name}`, body: tasks.length ? `${done} of ${tasks.length} tasks finished.` : "", roomId: g.roomId, goalId, key: `goal_done:${goalId}` });
    } else {
      this.notify("goal_failed", { title: `Did not finish: ${name}`, body: clip(g.summary ?? "", 160), roomId: g.roomId, goalId, key: `goal_failed:${goalId}` });
    }
  }

  // ---- digest
  private generalRoom() { return this.store.listRooms().find((r) => r.name === "general") ?? this.store.listRooms()[0]; }

  /** Today's numbers for a local day, from the routing log and the day counters. */
  numbers(day: string): DigestNumbers {
    const s = this.settings();
    const { start, end } = dayBounds(day, s.timezone);
    let accepted = 0, spend = 0, reported = false;
    for (const r of this.store.listRouting({ since: start - 86_400_000 })) {
      const t = r.completedAt ?? r.at;
      if (t < start || t >= end) continue;
      if (r.kind === "task" && r.outcome === "accepted") accepted++;
      if (r.usage?.costUsd !== undefined) { spend += r.usage.costUsd; reported = true; }
    }
    const d = this.day(day);
    return { goalsDone: d.goalsDone, accepted, spendUsd: reported ? Math.round(spend * 100) / 100 : null, interruptions: d.interrupts, cap: s.dailyInterruptCap, overCap: d.overCap };
  }

  /** What is waiting on the owner right now: open approvals, plans to approve, goals that asked a question. */
  openItems(): string[] {
    const out: string[] = [];
    for (const a of this.store.listApprovals("pending")) out.push(a.question ? `Question: ${clip(a.action, 120)}` : `Approval: ${a.agentId} wants to use ${a.tool}: ${clip(a.action, 100)}`);
    for (const room of this.store.listRooms()) {
      for (const g of this.store.listGoals(room.id)) {
        if (g.status === "awaiting_approval") out.push(`Plan to approve: ${clip(g.contract?.objective ?? g.text, 100)}`);
        else if (g.status === "paused" && g.state?.waitingOnOwner) out.push(`Question on "${clip(g.contract?.objective ?? g.text, 60)}": ${clip(g.state.waitingOnOwner, 100)}`);
      }
    }
    return out;
  }

  private compose(day: string, items: AttentionItem[], late?: string): DigestInput {
    const s = this.settings();
    const goalNames: Record<string, string> = {};
    for (const it of items) if (it.goalId && !goalNames[it.goalId]) { const g = this.store.getGoal(it.goalId); goalNames[it.goalId] = g ? g.contract?.objective ?? g.text : "A goal"; }
    const dateLabel = new Date(dayBounds(day, s.timezone).start + 3_600_000).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: s.timezone });
    return { dateLabel, numbers: this.numbers(day), open: this.openItems(), items, goalNames, ...(late ? { late } : {}) };
  }

  /** The digest as it would read right now (nothing is posted or cleared). */
  preview(): string {
    return renderDigest(this.compose(dayKey(this.clock(), this.settings().timezone), this.queue()));
  }

  /** Post the digest and clear what it listed. `/digest` posts it to the room it was typed in; the scheduled one goes to general. */
  private send(roomId: string | undefined, day: string, o: { late?: string; push: boolean }): Message | undefined {
    const room = roomId ? this.store.getRoom(roomId) : this.generalRoom();
    if (!room) return undefined;
    const items = this.queue().filter((i) => !i.held);
    const input = this.compose(day, items, o.late);
    const msg = this.store.addMessage({ roomId: room.id, author: ORCH, type: "system", text: renderDigest(input), mentions: [] });
    this.saveQueue(this.queue().filter((i) => i.held)); // held items wait for quiet hours to end; they are not part of the digest
    const at = this.clock();
    this.store.setKV("attention_digest", { handledAt: at, sentAt: at, day } satisfies DigestMark);
    this.bump(day, (d) => { d.digests++; });
    this.store.audit("attention", "digest.sent", `${items.length} items in ${room.name}${o.late ? " (late)" : ""}`);
    if (o.push) { const p = digestPush(input); this.deliver(p.title, p.body); }
    return msg;
  }

  /** `/digest`: post it now, in this room. */
  digestNow(roomId: string): Message | undefined {
    return this.send(roomId, dayKey(this.clock(), this.settings().timezone), { push: false });
  }

  /**
   * Run what is due: the held pushes once quiet hours are over, and the evening digest once its time has come.
   * Safe to call as often as you like. A hub that was asleep at digest time sends it on its first tick, once.
   */
  tick(): { digest?: Message; released?: number } {
    const at = this.clock();
    const s = this.settings();
    const out: { digest?: Message; released?: number } = {};

    // 1. Quiet hours ended: one push for what was held and is still open.
    if (!inQuiet(at, s.timezone, parseClock(s.quietFrom), parseClock(s.quietTo))) {
      const held = this.queue().filter((i) => i.held);
      if (held.length) {
        this.saveQueue(this.queue().filter((i) => !i.held));
        const open = held.filter((i) => this.stillOpen(i));
        if (open.length) {
          this.bump(dayKey(at, s.timezone), (d) => { d.interrupts++; });
          this.deliver(open.length === 1 ? open[0].title : `${open.length} things need you`, open.length === 1 ? open[0].body : open.map((i) => i.title).join("; "));
        }
        out.released = open.length;
      }
    }

    // 2. The digest.
    const due = lastOccurrence(at, parseClock(s.digestAt)!, s.timezone);
    const mark = this.mark();
    if (due > Math.max(mark?.handledAt ?? 0, this.since())) {
      const day = dayKey(due, s.timezone);
      const queued = this.queue().filter((i) => !i.held).length;
      const n = this.numbers(day);
      const active = n.goalsDone + n.accepted + n.interruptions > 0;
      if (queued || (active && mark?.day !== day)) {
        out.digest = this.send(undefined, day, { push: true, late: at - due > LATE_MS ? `Sent late: the hub wasn't running at ${s.digestAt}.` : undefined });
      } else {
        this.store.setKV("attention_digest", { handledAt: at, ...(mark?.sentAt ? { sentAt: mark.sentAt } : {}), day } satisfies DigestMark);
      }
    }
    return out;
  }

  /** Is the thing a held alert was about still waiting on the owner? Keys that say nothing are assumed open. */
  private stillOpen(i: AttentionItem): boolean {
    const [kind, ref] = (i.key ?? "").split(":");
    if (kind === "approval") return this.store.getApproval(ref)?.status === "pending";
    if (kind === "plan") return this.store.getGoal(ref)?.status === "awaiting_approval";
    if (kind === "ask") return !!this.store.getGoal(ref)?.state?.waitingOnOwner;
    return true;
  }

  /** Check once a minute (and now, so a digest missed while the hub slept goes out at start). */
  start(everyMs = 60_000) {
    this.stop();
    this.tick();
    this.timer = setInterval(() => { try { this.tick(); } catch { /* try again next minute */ } }, everyMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  close() { this.stop(); this.store.off("event", this.onEvent); }
}

const cache = new WeakMap<Store, Attention>();
/** The attention gate for a store (created on first use, like the quota service). */
export function attentionFor(store: Store): Attention {
  let a = cache.get(store);
  if (!a) { a = new Attention(store); cache.set(store, a); }
  return a;
}
