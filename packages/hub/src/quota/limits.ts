import type { QuotaWindowId } from "@agent-room/shared";

/**
 * 1.6 Reading rate-limit errors. Two kinds:
 *  - "quota": a plan's usage limit ("5-hour limit reached ∙ resets 3pm", Codex "You've hit your usage limit ... try again in 3 hours").
 *    The subscription is out until the reset, and the usage at that moment teaches the hub the real limit.
 *  - "burst": a plain 429 or "rate limit exceeded". Says nothing about the window, so no learning and only a short cooldown.
 * Reset times are only trusted when they parse cleanly and land within the next 8 days; anything else is ignored.
 */
export interface RateLimitInfo { kind: "quota" | "burst"; window?: QuotaWindowId; resetAt?: number }

export const BURST_COOLDOWN_MS = 2 * 60_000;
const MAX_AHEAD_MS = 8 * 86_400_000;

const RATE_LIMIT = /rate.?limit|\b429\b|usage limit|limit reached|reached your .{0,30}limit|hit your .{0,30}limit|too many requests|out of (?:extra )?usage|quota/i;
const QUOTA = /usage limit|limit reached|reached your .{0,30}limit|hit your .{0,30}limit|5.?hour|five.?hour|weekly|out of (?:extra )?usage|quota|\bresets?\b/i;

export function isRateLimit(error?: string): boolean { return RATE_LIMIT.test(error ?? ""); }

export function classifyRateLimit(error: string | undefined, now: number): RateLimitInfo | undefined {
  if (!error || !isRateLimit(error)) return undefined;
  const resetAt = parseResetTime(error, now);
  if (!QUOTA.test(error)) return { kind: "burst", ...(resetAt ? { resetAt } : {}) };
  return { kind: "quota", window: /week/i.test(error) ? "weekly" : "fiveHour", ...(resetAt ? { resetAt } : {}) };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3600_000, m: 60_000, s: 1000 };

/** Epoch ms for a wall-clock time in an IANA zone (or this machine's zone when none is given). */
function wallClock(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number | undefined {
  if (!tz) return new Date(y, mo, d, h, mi, 0, 0).getTime();
  try {
    const guess = Date.UTC(y, mo, d, h, mi);
    const offset = (t: number) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
        .formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t;
    };
    let t = guess - offset(guess);
    t = guess - offset(t);
    return t;
  } catch { return undefined; }
}

/** Today's date in a zone (or locally), as [year, month0, day]. */
function dateIn(now: number, tz?: string): [number, number, number] {
  if (!tz) { const d = new Date(now); return [d.getFullYear(), d.getMonth(), d.getDate()]; }
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(now)).map((x) => [x.type, Number(x.value)]));
    return [p.year, p.month - 1, p.day];
  } catch { const d = new Date(now); return [d.getFullYear(), d.getMonth(), d.getDate()]; }
}

/**
 * When a rate limit lifts, from what the CLI printed. Handles "resets 3pm", "resets at 3:30 PM (America/New_York)",
 * "resets Mon 9am", "resets Oct 27, 9am", "try again in 2 hours 15 minutes", "retry after 30 seconds", "Retry-After: 120"
 * and "try again at Oct 25th, 2026 3:15 PM". Returns undefined when nothing parses to a sensible future time.
 */
export function parseResetTime(text: string, now: number): number | undefined {
  const ok = (t: number | undefined) => (t !== undefined && Number.isFinite(t) && t > now && t <= now + MAX_AHEAD_MS ? t : undefined);

  const resets = /\bresets?\s+(?:at\s+|on\s+)?(.{1,70})/i.exec(text);
  if (resets) {
    const rest = resets[1];
    const dur = parseDuration(rest.replace(/^in\s+/i, ""));
    if (dur !== undefined) return ok(now + dur);
    const tz = /\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC|GMT)\)/.exec(rest)?.[1];
    const tm = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(rest) ?? /\b(\d{1,2}):(\d{2})()\b/.exec(rest);
    if (tm) {
      let h = Number(tm[1]); const mi = Number(tm[2] ?? 0); const ap = tm[3]?.toLowerCase();
      if (h > 23 || mi > 59 || (ap && (h < 1 || h > 12))) return undefined;
      if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
      let [y, mo, d] = dateIn(now, tz);
      const md = new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i").exec(rest);
      const wd = new RegExp(`\\b(${DAYS.join("|")})[a-z]*\\b`, "i").exec(rest.replace(md?.[0] ?? "", ""));
      if (md) {
        mo = MONTHS.indexOf(md[1].toLowerCase().slice(0, 3)); d = Number(md[2]);
        let t = wallClock(y, mo, d, h, mi, tz);
        if (t !== undefined && t <= now) t = wallClock(y + 1, mo, d, h, mi, tz);
        return ok(t);
      }
      if (wd) {
        const today = new Date(Date.UTC(y, mo, d)).getUTCDay();
        let ahead = (DAYS.indexOf(wd[1].toLowerCase().slice(0, 3)) - today + 7) % 7;
        let t = wallClock(y, mo, d + ahead, h, mi, tz);
        if (t !== undefined && t <= now) { ahead += 7; t = wallClock(y, mo, d + ahead, h, mi, tz); }
        return ok(t);
      }
      let t = wallClock(y, mo, d, h, mi, tz);
      if (t !== undefined && t <= now) t = wallClock(y, mo, d + 1, h, mi, tz);
      return ok(t);
    }
    return undefined;
  }

  const inDur = /(?:try again|retry|available again|come back)\s+(?:again\s+)?in\s+([^.\n]{1,60})/i.exec(text);
  if (inDur) { const d = parseDuration(inDur[1]); if (d !== undefined) return ok(now + d); }

  const at = /(?:try again|retry)\s+(?:again\s+)?(?:at|after)\s+([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}[^.\n]{0,25})/i.exec(text);
  if (at) { const t = Date.parse(at[1].replace(/(\d)(st|nd|rd|th)\b/i, "$1").replace(/\s+at\s+/i, " ")); if (!Number.isNaN(t)) return ok(t); }

  const ra = /retry[- ]after:?\s*(\d+)\s*(s|sec|seconds?|m|min|minutes?)?\b/i.exec(text);
  if (ra) return ok(now + Number(ra[1]) * (ra[2] && /^m/i.test(ra[2]) ? 60_000 : 1000));
  return undefined;
}

/** "2 hours 15 minutes", "45m", "3 days, 4 hours and 5 minutes" to ms. Undefined if no number+unit pair leads the text. */
function parseDuration(s: string): number | undefined {
  let total = 0, found = false, last = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
    if (m.index! - last > 6) break; // a gap means we've run into other text
    total += Number(m[1]) * UNIT_MS[m[2][0].toLowerCase()]; found = true; last = m.index! + m[0].length;
  }
  return found ? total : undefined;
}
