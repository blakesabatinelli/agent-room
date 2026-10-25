import type { UsageLeftResponse } from "@agent-room/shared";

/**
 * Speed: the live usage strip polls GET /agents/usage, and computing it walks every agent's subscriptions and ledger
 * windows on the single hub thread. This caches the computed response for a short window (~15s) so repeated polls are
 * cheap, and lets a rate-limit/usage change invalidate it so the strip is never stale by more than the window.
 */
export class UsageCache {
  private cached?: UsageLeftResponse;
  private computedAt = -Infinity;
  constructor(private compute: (now: number) => UsageLeftResponse, private ttlMs = 15_000, private clock: () => number = Date.now) {}

  /** The cached response when it is within the window, else a fresh one (and it becomes the new cache). */
  get(now = this.clock()): UsageLeftResponse {
    if (this.cached && now - this.computedAt < this.ttlMs) return this.cached;
    this.cached = this.compute(now);
    this.computedAt = now;
    return this.cached;
  }

  /** Drop the cache so the next get() recomputes (a rate limit hit or lifted, a subscription edited). */
  invalidate(): void {
    this.cached = undefined;
    this.computedAt = -Infinity;
  }
}
