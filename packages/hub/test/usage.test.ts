import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentUsageLeft, Subscription, UsageLeftResponse } from "@agent-room/shared";
import { setup, localPairHeaders } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { quotaFor } from "../src/quota/index.js";
import { usageLeft, untilText } from "../src/quota/usage.js";

const H = 3600_000, MIN = 60_000;
const T0 = Date.UTC(2026, 9, 23, 12, 0);
type Ctx = ReturnType<typeof setup>;

/** n successful runs of 100 tokens in, 50 out, one per `every` ms from `from`. */
function use(ctx: Ctx, subId: string, agentId: string, n: number, from: number, every = MIN) {
  const q = quotaFor(ctx.store);
  for (let i = 0; i < n; i++) q.ledger.record({ agentId, subscriptionId: subId, at: from + i * every, tokensIn: 100, tokensOut: 50, runs: 1, rateLimited: false, source: "task" });
}
function limits(ctx: Ctx, subId: string, patch: Partial<Subscription>) {
  const q = quotaFor(ctx.store);
  q.saveSubscriptions(q.subscriptions().map((s) => (s.id === subId ? { ...s, ...patch } : s)));
}
const agentOf = (r: UsageLeftResponse, id: string): AgentUsageLeft => r.agents.find((a) => a.agentId === id)!;
const fail = (error: string) => ({ ok: false as const, text: "", durationMs: 1, error });

test("usage: a known limit shows used, percent left and reset for both windows", () => {
  const ctx = setup();
  limits(ctx, "claude", { plan: "Max 5x", windows: { fiveHour: { limitRuns: 100 }, weekly: { limitRuns: 1000 } } });
  use(ctx, "claude", "claude", 20, T0, MIN);
  const now = T0 + 30 * MIN;
  const a = agentOf(usageLeft(ctx.store, quotaFor(ctx.store), now), "claude");
  const s = a.subscriptions[0];
  assert.equal(s.name, "Claude (subscription)");
  assert.equal(s.plan, "Max 5x");
  assert.equal(s.free, false);
  assert.equal(s.fiveHour.usedRuns, 20);
  assert.equal(s.fiveHour.usedTokens, 20 * 150);
  assert.equal(s.fiveHour.limitRuns, 100);
  assert.equal(s.fiveHour.limitSource, "owner");
  assert.equal(s.fiveHour.learning, false);
  assert.equal(s.fiveHour.percentLeft, 80);
  assert.equal(s.fiveHour.resetAt, T0 + 5 * H, "a rolling window resets when its oldest run ages out");
  assert.equal(s.weekly.percentLeft, 98);
  assert.equal(s.weekly.label, "weekly");
  assert.equal(s.percentLeft, 80, "the tightest window");
  assert.equal(s.status, "plenty");
  assert.equal(s.statusText, "plenty");
  assert.equal(a.status, "plenty");
  assert.equal(a.percentLeft, 80);
  assert.equal(a.free, false);
});

test("usage: status at the thresholds", () => {
  const cases: [number, string, string][] = [
    [50, "plenty", "plenty"], [59, "plenty", "plenty"],      // 41% left
    [60, "getting_low", "getting low"],                       // 40% left
    [84, "getting_low", "getting low"],                       // 16% left
    [85, "almost_out", "almost out"],                         // 15% left
    [94, "almost_out", "almost out"],                         // 6% left
    [95, "out", "out until"],                                 // 5% left: the router's own near-limit mark
  ];
  for (const [used, status, text] of cases) {
    const ctx = setup();
    limits(ctx, "claude", { windows: { fiveHour: { limitRuns: 100 } } });
    use(ctx, "claude", "claude", used, T0, 1000);
    const now = T0 + 10 * MIN;
    const s = agentOf(usageLeft(ctx.store, quotaFor(ctx.store), now), "claude").subscriptions[0];
    assert.equal(s.status, status, `${used} of 100 used`);
    assert.ok(s.statusText.startsWith(text), `${used}: ${s.statusText}`);
    assert.equal(s.percentLeft, 100 - used);
    if (status === "out") assert.equal(s.outUntil, T0 + 5 * H, "an estimated limit lifts when the window does");
    else assert.equal(s.outUntil, undefined);
  }
});

test("usage: the weekly window can be the tight one", () => {
  const ctx = setup();
  limits(ctx, "claude", { windows: { fiveHour: { limitRuns: 100 }, weekly: { limitRuns: 40 } } });
  use(ctx, "claude", "claude", 30, T0, 1000);
  const s = agentOf(usageLeft(ctx.store, quotaFor(ctx.store), T0 + MIN), "claude").subscriptions[0];
  assert.equal(s.fiveHour.percentLeft, 70);
  assert.equal(s.weekly.percentLeft, 25);
  assert.equal(s.percentLeft, 25);
  assert.equal(s.status, "getting_low");
});

test("usage: an unknown limit is learning, with no percentage", () => {
  const ctx = setup();
  use(ctx, "codex", "codex", 7, T0, 1000);
  const a = agentOf(usageLeft(ctx.store, quotaFor(ctx.store), T0 + MIN), "codex");
  const s = a.subscriptions[0];
  assert.equal(s.status, "learning");
  assert.equal(s.statusText, "learning your limits");
  assert.equal(s.fiveHour.learning, true);
  assert.equal(s.weekly.learning, true);
  assert.equal(s.fiveHour.percentLeft, undefined);
  assert.equal(s.weekly.percentLeft, undefined);
  assert.equal(s.percentLeft, undefined);
  assert.equal(s.fiveHour.usedRuns, 7, "what was used is still shown");
  assert.equal(s.fiveHour.limitRuns, undefined);
  assert.equal(a.status, "learning");
  assert.equal(a.percentLeft, undefined);
  assert.ok(!JSON.stringify(a).includes("NaN"));
});

test("usage: a limit the hub learned from a rate limit is used, and says where it came from", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  const now = T0 + 20 * MIN;
  use(ctx, "claude", "claude", 10, T0, MIN);
  // Not limited any more (the reset is long past), but the hub learned 40 runs from the last hit.
  const subs = q.subscriptions().map((s) => (s.id === "claude" ? { ...s, learned: { fiveHour: { runs: 40, samples: 1, at: T0 } } } : s));
  ctx.store.setKV("quota_subscriptions", subs);
  const s = agentOf(usageLeft(ctx.store, q, now), "claude").subscriptions[0];
  assert.equal(s.fiveHour.limitSource, "learned");
  assert.equal(s.fiveHour.limitRuns, 40);
  assert.equal(s.fiveHour.percentLeft, 75);
  assert.equal(s.weekly.learning, true, "the weekly limit is still unknown");
  assert.equal(s.status, "plenty");
});

test("usage: a local or free agent is unlimited", () => {
  const ctx = setup();
  use(ctx, "hermes-local", "hermes", 500, T0, 1000);
  const a = agentOf(usageLeft(ctx.store, quotaFor(ctx.store), T0 + 10 * MIN), "hermes");
  assert.equal(a.free, true);
  assert.equal(a.status, "unlimited");
  assert.equal(a.statusText, "unlimited");
  assert.equal(a.percentLeft, undefined);
  const local = a.subscriptions.find((s) => s.subscriptionId === "hermes-local")!;
  assert.equal(local.free, true);
  assert.equal(local.status, "unlimited");
  assert.equal(local.percentLeft, undefined);
  const minimax = a.subscriptions.find((s) => s.subscriptionId === "hermes-minimax")!;
  assert.equal(minimax.status, "learning", "its paid fallback is shown on its own");
  assert.equal(minimax.free, false);
});

test("usage: a rate-limited agent is out until the reset its CLI printed", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  const now = T0;
  q.recordRun(ctx.store.getAgent("claude")!, fail("5-hour limit reached ∙ resets in 2 hours 30 minutes"), {}, now);
  const a = agentOf(usageLeft(ctx.store, q, now + 5 * MIN), "claude");
  const s = a.subscriptions[0];
  assert.equal(s.status, "out");
  assert.equal(s.outUntil, now + 150 * MIN, "the parsed reset");
  assert.equal(s.statusText, `out until ${untilText(now + 150 * MIN, now + 5 * MIN)}`);
  assert.match(s.statusText, /^out until \d{1,2}:\d{2}\s?(AM|PM)$/);
  assert.equal(a.status, "out");
  assert.equal(a.outUntil, now + 150 * MIN);
  // After the reset it is no longer out.
  const later = agentOf(usageLeft(ctx.store, q, now + 3 * H), "claude");
  assert.notEqual(later.status, "out");
  assert.equal(later.outUntil, undefined);
});

test("usage: an agent is as available as its best subscription, and a far-off reset names the day", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  q.recordRun(ctx.store.getAgent("hermes")!, { ...fail("weekly limit reached, resets Mon 9am"), model: "MiniMax-M2" }, {}, T0);
  const a = agentOf(usageLeft(ctx.store, q, T0 + MIN), "hermes");
  const minimax = a.subscriptions.find((s) => s.subscriptionId === "hermes-minimax")!;
  assert.equal(minimax.status, "out");
  assert.match(minimax.statusText, /^out until \w{3} \d{1,2}:\d{2}\s?(AM|PM)$/, "more than a day away, so the day is named");
  assert.equal(a.status, "unlimited", "Hermes still has its local model");
  assert.equal(untilText(T0 + 30 * MIN, T0).includes(" "), true);
});

test("usage: only enabled agents are listed", () => {
  const ctx = setup();
  const codex = ctx.store.getAgent("codex")!;
  ctx.store.saveAgent({ ...codex, enabled: false });
  const r = usageLeft(ctx.store, quotaFor(ctx.store), T0);
  assert.ok(!r.agents.some((a) => a.agentId === "codex"));
  assert.deepEqual(r.agents.map((a) => a.agentId).sort(), ["claude", "hermes"]);
  assert.equal(r.at, T0);
});

test("usage: GET /agents/usage needs a sign-in and returns the same view", async () => {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${base}/agents/usage`)).status, 401);
    const pair = await fetch(`${base}/pair/local`, { method: "POST", headers: localPairHeaders(ctx.dir), body: JSON.stringify({ deviceName: "Mac" }) });
    const { token } = (await pair.json()) as { token: string };
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    limits(ctx, "claude", { windows: { fiveHour: { limitRuns: 10 } } });
    use(ctx, "claude", "claude", 3, Date.now() - 10 * MIN, MIN);
    const res = await fetch(`${base}/agents/usage`, { headers: h });
    assert.equal(res.status, 200);
    const body = (await res.json()) as UsageLeftResponse;
    assert.ok(typeof body.at === "number");
    const claude = agentOf(body, "claude");
    assert.equal(claude.subscriptions[0].fiveHour.percentLeft, 70);
    assert.equal(claude.status, "plenty");
    assert.equal(agentOf(body, "hermes").status, "unlimited");
    assert.equal(agentOf(body, "codex").status, "learning");
    // Same data the existing route has: nothing new is measured.
    const subs = (await (await fetch(`${base}/quota/subscriptions`, { headers: h })).json()) as { subscription: { id: string }; windows: { fiveHour: { headroom?: number } } }[];
    assert.equal(subs.find((s) => s.subscription.id === "claude")!.windows.fiveHour.headroom, 0.7);
  } finally { await app.close(); }
});
