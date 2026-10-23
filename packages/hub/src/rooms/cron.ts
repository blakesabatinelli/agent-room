import { addDays, validZone, wall, wallToEpoch } from "./zone.js";

/**
 * 4.3 A small 5-field cron (minute hour day-of-month month day-of-week), evaluated on the wall clock of a time zone.
 *
 *   field        values            also
 *   minute       0-59              star, comma lists, ranges, steps (0,30   9-17   every 15 as star-slash-15   10-40/10)
 *   hour         0-23
 *   day of month 1-31
 *   month        1-12              JAN-DEC
 *   day of week  0-7 (0 and 7 are Sunday)   SUN-SAT
 *   macros       @hourly @daily @midnight @weekly @monthly @yearly @annually
 *
 * As in cron, when both day-of-month and day-of-week are restricted a day matches if EITHER does.
 *
 * Daylight saving: a time that does not exist (02:30 when clocks jump from 02:00 to 03:00) runs at the moment the gap ends;
 * a time that happens twice (01:30 when clocks go back) runs the first time only. Every wall time runs at most once.
 */

export interface Cron {
  minute: number[]; hour: number[]; dom: number[]; month: number[]; dow: number[];
  domStar: boolean; dowStar: boolean;
  source: string;
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *",
};
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface Spec { name: string; min: number; max: number; names?: string[]; nameBase?: number }
const SPECS: Spec[] = [
  { name: "minute", min: 0, max: 59 }, { name: "hour", min: 0, max: 23 }, { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 }, { name: "day of week", min: 0, max: 7, names: DAYS, nameBase: 0 },
];

class CronError extends Error {}

function value(tok: string, s: Spec): number {
  if (/^\d+$/.test(tok)) {
    const n = Number(tok);
    if (n < s.min || n > s.max) throw new CronError(`${s.name} ${n} is outside ${s.min} to ${s.max}`);
    return n;
  }
  const i = s.names?.indexOf(tok.toUpperCase()) ?? -1;
  if (i < 0) throw new CronError(`"${tok}" isn't a valid ${s.name}`);
  return i + (s.nameBase ?? 0);
}

function field(text: string, s: Spec): { values: number[]; star: boolean } {
  const out = new Set<number>();
  const star = text.startsWith("*") || text.startsWith("?");
  for (const part of text.split(",")) {
    if (!part) throw new CronError(`${s.name} has an empty entry`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new CronError(`${s.name}: "${part}" has two steps`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`${s.name}: the step in "${part}" must be a whole number of 1 or more`);
      step = Number(stepText);
    }
    let lo: number, hi: number;
    if (range === "*" || range === "?") { lo = s.min; hi = s.name === "day of week" ? 6 : s.max; }
    else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || !a || !b) throw new CronError(`${s.name}: "${range}" isn't a range`);
      lo = value(a, s); hi = value(b, s);
      if (lo > hi) throw new CronError(`${s.name}: the range "${range}" runs backwards`);
    } else { lo = value(range, s); hi = stepText !== undefined ? s.max : lo; }
    for (let v = lo; v <= hi; v += step) out.add(s.name === "day of week" && v === 7 ? 0 : v);
  }
  return { values: [...out].sort((a, b) => a - b), star };
}

export type CronParse = { ok: true; cron: Cron } | { ok: false; error: string };

/** Parse a 5-field cron expression (or a macro). Never throws. */
export function parseCron(expr: string): CronParse {
  const raw = (expr ?? "").trim().replace(/\s+/g, " ");
  const text = MACROS[raw.toLowerCase()] ?? raw;
  const parts = text.split(" ");
  if (!raw) return { ok: false, error: "the schedule is empty" };
  if (parts.length !== 5) return { ok: false, error: `a schedule needs 5 fields (minute hour day-of-month month day-of-week), but "${raw}" has ${parts.length}` };
  try {
    const f = parts.map((p, i) => field(p, SPECS[i]));
    const [minute, hour, dom, month, dow] = f;
    return { ok: true, cron: { minute: minute.values, hour: hour.values, dom: dom.values, month: month.values, dow: dow.values, domStar: dom.star, dowStar: dow.star, source: raw } };
  } catch (e) {
    if (e instanceof CronError) return { ok: false, error: e.message };
    throw e;
  }
}

function dayMatches(c: Cron, year: number, month: number, day: number): boolean {
  if (!c.month.includes(month)) return false;
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const d = c.dom.includes(day), w = c.dow.includes(dow);
  return c.domStar || c.dowStar ? d && w : d || w;
}

/** How far ahead nextFire looks (a 29 February schedule needs up to 8 years; a typo like "0 0 31 2 *" never matches). */
const HORIZON_DAYS = 366 * 8;

/** The first scheduled instant strictly after `after`, on the wall clock of `tz`. undefined when the schedule never fires. */
export function nextFire(c: Cron, after: number, tz: string): number | undefined {
  if (!validZone(tz)) return undefined;
  const start = wall(after, tz);
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = addDays(start.year, start.month, start.day, i);
    if (!dayMatches(c, d.year, d.month, d.day)) continue;
    // Wall times only move forward through the day, so the first one after `after` is the answer. On the first day skip the hours already gone.
    const firstHour = i === 0 ? Math.max(0, start.hour - 1) : 0;
    for (const h of c.hour) {
      if (h < firstHour) continue;
      for (const m of c.minute) {
        const t = wallToEpoch(d.year, d.month, d.day, h, m, tz).epoch;
        if (t > after) return t;
      }
    }
  }
  return undefined;
}

/**
 * Every scheduled instant after `after` up to and including `upTo`, oldest first. At most `limit` are returned (the newest ones
 * are kept, with `total` counting all of them) so a minutely schedule after a week asleep stays cheap.
 */
export function firesBetween(c: Cron, after: number, upTo: number, tz: string, limit = 500): { slots: number[]; total: number } {
  const slots: number[] = [];
  let total = 0, t = after;
  for (let i = 0; i < 20_000; i++) {
    const n = nextFire(c, t, tz);
    if (n === undefined || n > upTo) break;
    total++; slots.push(n); if (slots.length > limit) slots.shift();
    t = n;
  }
  return { slots, total };
}
