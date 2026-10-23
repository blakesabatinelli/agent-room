import { isoWeek, weekStart } from "../retro/metrics.js";

/** 2.7 Weeks and months for the reports. Weeks are ISO weeks, Monday to Sunday, UTC (the same weeks first-pass acceptance uses). Months are UTC calendar months. */

export const DAY = 86_400_000;
export const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "2026-W43" to the Monday 00:00 UTC it starts on; undefined for anything that isn't a real ISO week. */
export function parseWeek(label: string): number | undefined {
  const m = /^(\d{4})-W(\d{2})$/.exec(label.trim());
  if (!m) return undefined;
  const start = weekStart(Date.UTC(Number(m[1]), 0, 4)) + (Number(m[2]) - 1) * 7 * DAY;
  return isoWeek(start) === `${m[1]}-W${m[2]}` ? start : undefined;
}

/** A week given as a label, or any moment in it, as its Monday. */
export function weekOf(week: string | number): number | undefined {
  return typeof week === "number" ? weekStart(week) : parseWeek(week);
}

/** "2026-10" to [start, end) in ms; undefined when it isn't a month. */
export function parseMonth(label: string): { start: number; end: number } | undefined {
  const m = /^(\d{4})-(\d{2})$/.exec(label.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return undefined;
  const y = Number(m[1]), mo = Number(m[2]);
  return { start: Date.UTC(y, mo - 1, 1), end: Date.UTC(y, mo, 1) };
}
export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
/** The month before "YYYY-MM". */
export function prevMonth(label: string): string {
  const r = parseMonth(label)!;
  return monthOf(r.start - 1);
}

export const money = (x: number) => `$${x < 100 ? x.toFixed(2) : Math.round(x).toLocaleString("en-US")}`;
export const pct = (x: number | null) => (x === null ? "none" : `${Math.round(x * 100)}%`);
export const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
