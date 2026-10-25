import { test } from "node:test";
import assert from "node:assert/strict";
import type { UsageLeftResponse } from "@agent-room/shared";
import { UsageCache } from "../src/quota/usage-cache.js";

// Speed: the usage strip polls GET /agents/usage; the response is cached for ~15s and invalidated on a usage change.

const resp = (at: number): UsageLeftResponse => ({ at, agents: [] });

test("the cache returns the same computed value within the window and recomputes after it", () => {
  let now = 1000, computes = 0;
  const cache = new UsageCache((t) => { computes++; return resp(t); }, 15_000, () => now);
  const a = cache.get();
  assert.equal(a.at, 1000);
  assert.equal(computes, 1);
  now = 1000 + 14_999;
  assert.equal(cache.get().at, 1000, "still the cached response inside the 15s window");
  assert.equal(computes, 1, "no recompute inside the window");
  now = 1000 + 15_000;
  assert.equal(cache.get().at, 16_000, "recomputed after the window");
  assert.equal(computes, 2);
});

test("invalidate forces an immediate recompute even inside the window", () => {
  let now = 5000, computes = 0;
  const cache = new UsageCache((t) => { computes++; return resp(t); }, 15_000, () => now);
  cache.get();
  assert.equal(computes, 1);
  now = 5100;
  cache.invalidate(); // e.g. a rate-limit event
  assert.equal(cache.get().at, 5100, "recomputed at once after invalidation");
  assert.equal(computes, 2);
});
