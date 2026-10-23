/**
 * 2.7 Local-time helpers for the attention gate: which local day a moment is in, when a "HH:MM" next comes round, quiet hours.
 * Everything is computed with Intl in the owner's IANA time zone, so a daylight-saving change moves the digest with the wall clock.
 */

const parts = (ms: number, tz: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)])) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return p;
};

/** Is this a time zone Intl knows? */
export function validZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Milliseconds the zone is ahead of UTC at this moment. */
function offsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day, "YYYY-MM-DD". */
export function dayKey(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes since local midnight. */
export function minuteOfDay(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return p.hour * 60 + p.minute;
}

/** "HH:MM" to minutes, or undefined when it isn't one. */
export function parseClock(s: string | undefined): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? "").trim());
  if (!m) return undefined;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : undefined;
}

/** The moment a local wall-clock time ("YYYY-MM-DD" and minutes since midnight) happens in the zone. */
export function localToEpoch(day: string, minutes: number, tz: string): number {
  const [y, mo, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, minutes);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz); // once more: the offset can differ at the other side of a daylight-saving change
  return t;
}

/** The day before a "YYYY-MM-DD". */
export function prevDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Start (inclusive) and end (exclusive) of a local day. */
export function dayBounds(day: string, tz: string): { start: number; end: number } {
  return { start: localToEpoch(day, 0, tz), end: localToEpoch(nextDay(day), 0, tz) };
}

/** The most recent time at or before `now` that the local clock read `minutes` (the last time a daily 18:00 came due). */
export function lastOccurrence(now: number, minutes: number, tz: string): number {
  const today = dayKey(now, tz);
  const t = localToEpoch(today, minutes, tz);
  return t <= now ? t : localToEpoch(prevDay(today), minutes, tz);
}

/** Is the local time inside quiet hours? A window that ends before it starts runs across midnight. Equal ends: never quiet. */
export function inQuiet(now: number, tz: string, from: number | undefined, to: number | undefined): boolean {
  if (from === undefined || to === undefined || from === to) return false;
  const m = minuteOfDay(now, tz);
  return from < to ? m >= from && m < to : m >= from || m < to;
}
