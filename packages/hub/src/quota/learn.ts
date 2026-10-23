import type { LearnedLimit, QuotaWindowId, Subscription } from "@agent-room/shared";
import { WINDOW_MS } from "./windows.js";

/**
 * 1.6 Learning the real limit. Vendors don't publish what's left, so the hub watches for rate limits and notes how much
 * the Room had sent in that window when one hit. The Room only sees its own traffic (the owner may also use the plan
 * elsewhere), so each reading is a floor on the true limit and the estimate errs low, which keeps the router safe:
 * a new reading is averaged with the old one, so one odd day moves it halfway at most.
 */
export const LEARN_WEIGHT = 0.5;
/** When a limit hit gives no usable reset time, assume it lasts at least this long. */
export const MIN_LIMITED_MS = 15 * 60_000;

export function learnLimit(prev: LearnedLimit | undefined, used: { tokens: number; runs: number }, at: number): LearnedLimit | undefined {
  if (used.tokens <= 0 && used.runs <= 0) return prev; // a limit at zero usage means the quota went elsewhere; nothing to learn
  const blend = (old: number | undefined, seen: number) => (seen <= 0 ? old : old === undefined ? seen : Math.round(old * (1 - LEARN_WEIGHT) + seen * LEARN_WEIGHT));
  const tokens = blend(prev?.tokens, used.tokens), runs = blend(prev?.runs, used.runs);
  return { ...(tokens !== undefined ? { tokens } : {}), ...(runs !== undefined ? { runs } : {}), samples: (prev?.samples ?? 0) + 1, at };
}

/**
 * Apply one observed "usage limit" to a subscription: learn the limit for that window, remember when it lifts, and
 * pin the window to that reset so usage from before it stops counting afterwards. Returns a new object.
 */
export function applyQuotaHit(sub: Subscription, window: QuotaWindowId, used: { tokens: number; runs: number }, resetAt: number, now: number): Subscription {
  const learned = { ...(sub.learned ?? {}) };
  const l = learnLimit(learned[window], used, now);
  if (l) learned[window] = l;
  const key = window === "fiveHour" ? "fiveHourStart" : "weekStart";
  learned.anchors = { ...(learned.anchors ?? {}), [key]: resetAt - WINDOW_MS[window] };
  learned.limitedUntil = resetAt;
  learned.limitedAt = now;
  learned.limitedWindow = window;
  return { ...sub, learned };
}

/** A burst limit (plain 429): keep the subscription out briefly, learn nothing. */
export function applyBurst(sub: Subscription, until: number, now: number): Subscription {
  return { ...sub, learned: { ...(sub.learned ?? {}), limitedUntil: until, limitedAt: now } };
}
