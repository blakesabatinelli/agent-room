import type { FirstPassMetrics, FirstPassWeek, RoutingRecord } from "@agent-room/shared";
import type { Store } from "../db/store.js";

/**
 * 2.1 First-pass acceptance, per ISO week, from the routing log (0.2).
 * A task counts in the week its first completed attempt finished being routed; it is a first-pass success when that attempt
 * was accepted. Revisions per task count the send-backs that task needed afterwards.
 * Attempts that were interrupted (hub restarted, owner stopped it) or are still running don't count.
 */

export const PHASE_KEY = "phase2_started_at";
const DAY = 86_400_000;

/** When this phase started: the first time the hub ran with retros. Set once, then fixed. */
export function ensurePhaseStart(store: Store, now = Date.now()): number {
  const cur = store.getKV<number | null>(PHASE_KEY, null);
  if (typeof cur === "number" && Number.isFinite(cur)) return cur;
  store.setKV(PHASE_KEY, now);
  store.audit("hub", "retro.phase_started", new Date(now).toISOString());
  return now;
}

/** Monday 00:00 UTC of the week containing `ms`. */
export function weekStart(ms: number): number {
  const d = new Date(ms); d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
}

/** ISO 8601 week label, e.g. "2026-W43" (the week belongs to the year its Thursday is in). */
export function isoWeek(ms: number): string {
  const monday = weekStart(ms);
  const thursday = new Date(monday + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const round = (x: number) => Math.round(x * 1000) / 1000;
const DONE = new Set(["pending", "interrupted"]);

interface TaskFacts { at: number; agentId: string; taskType: string; accepted: boolean; revisions: number }

/** One entry per task that has a finished first attempt. */
function facts(records: RoutingRecord[]): TaskFacts[] {
  const byTask = new Map<string, RoutingRecord[]>();
  for (const r of records) if (r.kind === "task") byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const out: TaskFacts[] = [];
  for (const recs of byTask.values()) {
    recs.sort((a, b) => a.at - b.at);
    const first = recs.find((r) => !DONE.has(r.outcome));
    if (!first) continue;
    out.push({ at: first.at, agentId: first.chosen, taskType: first.taskType, accepted: first.outcome === "accepted", revisions: recs.filter((r) => r.revision).length });
  }
  return out;
}

function bucket(rows: TaskFacts[], weeks: number[], phaseWeek: number): FirstPassWeek[] {
  return weeks.map((start) => {
    const inWeek = rows.filter((r) => weekStart(r.at) === start);
    const accepted = inWeek.filter((r) => r.accepted).length;
    return {
      week: isoWeek(start), start: ymd(start), tasks: inWeek.length, accepted,
      rate: inWeek.length ? round(accepted / inWeek.length) : null,
      revisionsPerTask: inWeek.length ? round(inWeek.reduce((n, r) => n + r.revisions, 0) / inWeek.length) : null,
      sincePhase: start >= phaseWeek,
    };
  });
}

/** The weekly trend for the last `weeks` weeks (the current week included), overall, per agent and per task type. */
export function firstPassMetrics(store: Store, opts: { weeks?: number; now?: number } = {}): FirstPassMetrics {
  const now = opts.now ?? Date.now();
  const n = Math.min(104, Math.max(1, Math.floor(opts.weeks ?? 12)));
  const phaseStartedAt = ensurePhaseStart(store, now);
  const phaseWeek = weekStart(phaseStartedAt);
  const thisWeek = weekStart(now);
  const starts = Array.from({ length: n }, (_, i) => thisWeek - (n - 1 - i) * 7 * DAY);
  // Read a month back from the window so a task that started before it still shows its true first attempt.
  const rows = facts(store.listRouting({ since: starts[0] - 30 * DAY })).filter((r) => r.at >= starts[0] && weekStart(r.at) <= thisWeek);
  const agents = [...new Set(rows.map((r) => r.agentId))].sort();
  const types = [...new Set(rows.map((r) => r.taskType))].sort();
  const since = rows.filter((r) => weekStart(r.at) >= phaseWeek);
  const acc = since.filter((r) => r.accepted).length;
  return {
    weeks: n, phaseStartedAt, phaseStartWeek: isoWeek(phaseStartedAt),
    overall: bucket(rows, starts, phaseWeek),
    byAgent: Object.fromEntries(agents.map((a) => [a, bucket(rows.filter((r) => r.agentId === a), starts, phaseWeek)])),
    byTaskType: Object.fromEntries(types.map((t) => [t, bucket(rows.filter((r) => r.taskType === t), starts, phaseWeek)])),
    sincePhase: { tasks: since.length, accepted: acc, rate: since.length ? round(acc / since.length) : null, revisionsPerTask: since.length ? round(since.reduce((s, r) => s + r.revisions, 0) / since.length) : null },
  };
}
