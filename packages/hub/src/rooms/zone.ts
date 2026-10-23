/**
 * 4.3 Wall-clock helpers for the calendar trigger. Everything is computed with Intl in an IANA zone, so a daylight-saving
 * change moves a "9:00" schedule with the wall clock. (attention/time.ts has the digest's version; this one also tells apart
 * a wall time that happens twice (clocks go back) or not at all (clocks go forward).)
 */

const DAY = 86_400_000;
const MIN = 60_000;

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formats.set(tz, f);
  }
  return f;
}

/** Is this a time zone Intl knows? */
export function validZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try { format(tz); return true; } catch { return false; }
}

export interface Wall { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** The wall clock of a zone at an instant. */
export function wall(ms: number, tz: string): Wall {
  const out: Record<string, number> = {};
  for (const p of format(tz).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Milliseconds the zone is ahead of UTC at this instant. */
export function offsetMs(ms: number, tz: string): number {
  const w = wall(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

export interface Resolved {
  epoch: number;
  /** exact: it happens once. ambiguous: clocks went back and it happens twice (the first is used). gap: clocks went forward and it never happens (the moment the gap ends is used). */
  kind: "exact" | "ambiguous" | "gap";
}

/** The instant a local wall time (to the minute) happens in the zone. */
export function wallToEpoch(year: number, month: number, day: number, hour: number, minute: number, tz: string): Resolved {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetMs(guess - DAY, tz), after = offsetMs(guess + DAY, tz);
  const reads = (t: number) => { const w = wall(t, tz); return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute; };
  const hits = [...new Set([before, after])].map((o) => guess - o).filter(reads).sort((a, b) => a - b);
  if (hits.length) return { epoch: hits[0], kind: hits.length > 1 ? "ambiguous" : "exact" };
  // A gap: the wall clock jumped over this time. Find the first minute the new offset applies.
  let lo = guess - Math.max(before, after), hi = guess - Math.min(before, after); // lo is before the change, hi is after it
  const target = offsetMs(hi, tz);
  lo = Math.floor(lo / MIN) * MIN; hi = Math.ceil(hi / MIN) * MIN;
  while (hi - lo > MIN) {
    const mid = lo + Math.floor((hi - lo) / MIN / 2) * MIN;
    if (offsetMs(mid, tz) === target) hi = mid; else lo = mid;
  }
  return { epoch: hi, kind: "gap" };
}

/** "YYYY-MM-DD" plus a number of days. */
export function addDays(y: number, m: number, d: number, n: number): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** "Mon 9:00 AM" style text for an instant in a zone. */
export function describeInstant(ms: number, tz: string): string {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString(); }
}
