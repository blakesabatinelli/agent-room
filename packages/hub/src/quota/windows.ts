import type { QuotaSettings, QuotaWindowId, QuotaWindowStatus, Subscription } from "@agent-room/shared";
import type { QuotaLedger } from "./ledger.js";

/**
 * 1.6 Windows. A subscription has a 5-hour and a weekly window. Usage is counted in the window as the Room sent it.
 *
 * Without an anchor the window rolls: it counts the last 5 hours (7 days) and "resets" when its oldest run ages out,
 * which is how Claude's sessions behave (a window starts at the first message). With an anchor (the owner's, or one
 * taken from a reset time a CLI printed) the window is fixed: it starts at the anchor plus a whole number of windows.
 */
export const WINDOW_MS: Record<QuotaWindowId, number> = { fiveHour: 5 * 3600_000, weekly: 7 * 86_400_000 };
/** Capacity only counts as "about to expire" this close to the reset: the last 5 hours of a 5-hour window, the last day of a week. */
export const EXPIRY_HORIZON_MS: Record<QuotaWindowId, number> = { fiveHour: 5 * 3600_000, weekly: 86_400_000 };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const startKey = (w: QuotaWindowId) => (w === "fiveHour" ? "fiveHourStart" : "weekStart") as "fiveHourStart" | "weekStart";

export function windowAnchor(sub: Subscription, w: QuotaWindowId): number | undefined {
  return sub.resetAnchor?.[startKey(w)] ?? sub.learned?.anchors?.[startKey(w)];
}

/** The limit in force for a window: the owner's if set, else what the hub learned from rate limits. */
export function effectiveLimit(sub: Subscription, w: QuotaWindowId): { tokens?: number; runs?: number; source?: "owner" | "learned" } {
  const own = sub.windows?.[w], learned = sub.learned?.[w];
  const tokens = own?.limitTokens ?? learned?.tokens, runs = own?.limitRuns ?? learned?.runs;
  const source = own?.limitTokens !== undefined || own?.limitRuns !== undefined ? "owner" : tokens !== undefined || runs !== undefined ? "learned" : undefined;
  return { ...(tokens !== undefined ? { tokens } : {}), ...(runs !== undefined ? { runs } : {}), ...(source ? { source } : {}) };
}

/** Successful runs inside the window and where it starts and ends. Rate-limited attempts used nothing, so they aren't counted. */
export function windowUsage(sub: Subscription, w: QuotaWindowId, ledger: Pick<QuotaLedger, "since">, now: number) {
  const len = WINDOW_MS[w];
  const anchor = windowAnchor(sub, w);
  let countFrom: number, start: number;
  if (anchor !== undefined) { start = anchor + Math.floor((now - anchor) / len) * len; countFrom = start - 1; }
  else countFrom = now - len;
  const rows = ledger.since(sub.id, countFrom, now).filter((r) => !r.rateLimited);
  if (anchor === undefined) start = rows[0]?.at ?? now;
  return { rows, start: start!, end: start! + len, tokens: rows.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0), runs: rows.reduce((n, r) => n + r.runs, 0) };
}

export function windowStatus(sub: Subscription, w: QuotaWindowId, ledger: Pick<QuotaLedger, "since">, now: number): QuotaWindowStatus {
  const u = windowUsage(sub, w, ledger, now);
  const lim = effectiveLimit(sub, w);
  const parts: number[] = [];
  if (lim.tokens) parts.push(1 - u.tokens / lim.tokens);
  if (lim.runs) parts.push(1 - u.runs / lim.runs);
  const headroom = parts.length ? clamp01(Math.min(...parts)) : undefined;
  const urgency = clamp01(1 - (u.end - now) / EXPIRY_HORIZON_MS[w]);
  return {
    window: w, usedTokens: u.tokens, usedRuns: u.runs,
    ...(lim.tokens ? { limitTokens: lim.tokens } : {}), ...(lim.runs ? { limitRuns: lim.runs } : {}), ...(lim.source ? { limitSource: lim.source } : {}),
    ...(headroom !== undefined ? { headroom } : {}),
    expiresSoon: headroom === undefined ? 0 : headroom * urgency,
    start: u.start, resetsAt: u.end,
  };
}

/** Unused share of the tightest window, 0..1, or undefined while no limit is known ("learning"). Local models have no window. */
export function headroom(sub: Subscription, ledger: Pick<QuotaLedger, "since">, now: number): number | undefined {
  if (sub.kind === "local") return undefined;
  const hs = (["fiveHour", "weekly"] as const).map((w) => windowStatus(sub, w, ledger, now).headroom).filter((h): h is number => h !== undefined);
  return hs.length ? Math.min(...hs) : undefined;
}

/**
 * Share of this subscription's capacity that will be lost at its next reset: the unused part of a window, weighted by
 * how close the reset is (0 with a full window ahead, 0.9 with 30 minutes left of five hours). It can't exceed the
 * tightest window's headroom, since that's all that can still be used before then.
 */
export function expiresSoon(sub: Subscription, ledger: Pick<QuotaLedger, "since">, now: number): number {
  if (sub.kind === "local") return 0;
  const ws = (["fiveHour", "weekly"] as const).map((w) => windowStatus(sub, w, ledger, now));
  const tight = headroom(sub, ledger, now);
  return tight === undefined ? 0 : Math.min(tight, Math.max(...ws.map((w) => w.expiresSoon)));
}

export interface LimitPrediction { limited: boolean; until?: number; reason?: "reported" | "estimated"; window?: QuotaWindowId }

/** Will a run on this subscription be rate limited? Yes if a CLI said so and the reset hasn't passed, or a window with a known limit is used up. */
export function predictLimited(sub: Subscription, ledger: Pick<QuotaLedger, "since">, now: number, settings: Pick<QuotaSettings, "nearLimit">): LimitPrediction {
  if (sub.kind === "local") return { limited: false };
  const lu = sub.learned?.limitedUntil;
  if (lu !== undefined && lu > now) return { limited: true, until: lu, reason: "reported", window: sub.learned?.limitedWindow };
  let worst: LimitPrediction = { limited: false };
  for (const w of ["fiveHour", "weekly"] as const) {
    const s = windowStatus(sub, w, ledger, now);
    if (s.headroom !== undefined && s.headroom <= 1 - settings.nearLimit + 1e-9 && (!worst.limited || s.resetsAt > (worst.until ?? 0))) worst = { limited: true, until: s.resetsAt, reason: "estimated", window: w };
  }
  return worst;
}
