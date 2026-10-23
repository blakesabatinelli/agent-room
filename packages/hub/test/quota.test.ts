import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, Profile, QuotaReport, RoutingRecord, Subscription, SubscriptionStatus } from "@agent-room/shared";
import { setup } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { recordOutcome } from "../src/orchestrator/scoring.js";
import { quotaFor } from "../src/quota/index.js";
import { classifyRateLimit, parseResetTime } from "../src/quota/limits.js";
import { learnLimit } from "../src/quota/learn.js";
import { quotaAdjust, quotaDecide } from "../src/quota/router.js";

const H = 3600_000, MIN = 60_000, DAY = 24 * H;
const T0 = Date.UTC(2026, 9, 23, 12, 0);
type Ctx = ReturnType<typeof setup>;

/** Fake usage: n successful runs of 100 tokens in, 50 out, one per `every` ms starting at `from`. */
function use(ctx: Ctx, subId: string, agentId: string, n: number, from: number, every = MIN) {
  const q = quotaFor(ctx.store);
  for (let i = 0; i < n; i++) q.ledger.record({ agentId, subscriptionId: subId, at: from + i * every, tokensIn: 100, tokensOut: 50, runs: 1, rateLimited: false, source: "task" });
}
/** Owner edits one subscription's windows. */
function limits(ctx: Ctx, subId: string, patch: Partial<Subscription>) {
  const q = quotaFor(ctx.store);
  q.saveSubscriptions(q.subscriptions().map((s) => (s.id === subId ? { ...s, ...patch } : s)));
}
const agent = (ctx: Ctx, id: string) => ctx.store.getAgent(id)!;
const rows = (ctx: Ctx, sub: string) => quotaFor(ctx.store).ledger.since(sub, 0);
const fail = (error: string): { ok: false; text: string; durationMs: number; error: string } => ({ ok: false, text: "", durationMs: 1, error });
const ok = (model?: string, usage = { inputTokens: 100, outputTokens: 50 }) => ({ ok: true, text: "done", durationMs: 1, usage, ...(model ? { model } : {}) });

// ---------- seeded subscriptions

test("quota: default subscriptions are seeded from the agents, Hermes with a free local one and a MiniMax fallback", () => {
  const ctx = setup();
  const subs = quotaFor(ctx.store).subscriptions();
  assert.deepEqual(subs.map((s) => s.id), ["claude", "codex", "hermes-local", "hermes-minimax"], "demo has no Muse, so no Meta entry yet");
  const by = Object.fromEntries(subs.map((s) => [s.id, s]));
  assert.equal(by.claude.label, "Claude (subscription)");
  assert.equal(by.codex.label, "ChatGPT/Codex (subscription)");
  assert.equal(by["hermes-local"].kind, "local");
  assert.equal(by["hermes-minimax"].label, "MiniMax (fallback, subscription)");
  assert.equal(by["hermes-minimax"].kind, "subscription");
  // Muse joins later: its entry is added without touching the owner's edits.
  limits(ctx, "claude", { plan: "Max 5x" });
  ctx.store.saveAgent({ id: "muse", name: "Muse", provider: "muse", adapter: "mcp", enabled: true, color: "#E01E5A", settings: {}, tools: {} } as AgentConfig);
  const after = quotaFor(ctx.store).subscriptions();
  assert.equal(after.find((s) => s.agentIds.includes("muse"))!.label, "Meta (subscription)");
  assert.equal(after.find((s) => s.id === "claude")!.plan, "Max 5x");
});

// ---------- AC1: tracking per subscription and window

test("quota: 5-hour and weekly windows roll (fake clock)", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  limits(ctx, "claude", { windows: { fiveHour: { limitRuns: 10 }, weekly: { limitRuns: 100 } } });
  use(ctx, "claude", "claude", 4, T0, 1000);          // four runs at the start
  use(ctx, "claude", "claude", 2, T0 + 2 * H, 1000);  // two more two hours later
  const sub = () => q.subscriptions().find((s) => s.id === "claude")!;

  const mid = q.status(sub(), T0 + 3 * H);
  assert.equal(mid.windows.fiveHour.usedRuns, 6);
  assert.equal(mid.windows.fiveHour.usedTokens, 6 * 150);
  assert.ok(Math.abs(mid.windows.fiveHour.headroom! - 0.4) < 1e-9);
  assert.equal(mid.windows.fiveHour.resetsAt, T0 + 5 * H, "the window resets when its oldest run ages out");
  assert.equal(mid.windows.weekly.usedRuns, 6);
  assert.ok(Math.abs(q.headroom(sub(), T0 + 3 * H)! - 0.4) < 1e-9, "headroom is the tightest window's");

  const later = q.status(sub(), T0 + 5 * H + 3001);
  assert.equal(later.windows.fiveHour.usedRuns, 2, "the first four aged out of the 5-hour window");
  assert.ok(Math.abs(later.windows.fiveHour.headroom! - 0.8) < 1e-9);
  assert.equal(later.windows.weekly.usedRuns, 6, "but still count for the week");

  const nextWeek = q.status(sub(), T0 + 7 * DAY + 2 * H + 3001);
  assert.equal(nextWeek.windows.weekly.usedRuns, 0, "everything has left the weekly window");
  assert.equal(nextWeek.windows.weekly.headroom, 1);
});

test("quota: an anchored window is fixed, and token limits count tokens", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  limits(ctx, "codex", { windows: { fiveHour: { limitTokens: 1000 } }, resetAnchor: { fiveHourStart: T0 - H } });
  use(ctx, "codex", "codex", 4, T0, 1000);
  const sub = () => q.subscriptions().find((s) => s.id === "codex")!;
  const a = q.status(sub(), T0 + H);
  assert.equal(a.windows.fiveHour.resetsAt, T0 + 4 * H, "windows start at the anchor and last five hours");
  assert.equal(a.windows.fiveHour.usedTokens, 600);
  assert.ok(Math.abs(a.windows.fiveHour.headroom! - 0.4) < 1e-9);
  const b = q.status(sub(), T0 + 4 * H + MIN);
  assert.equal(b.windows.fiveHour.usedTokens, 0, "a new window starts on the boundary, whatever rolled before");
  assert.equal(b.windows.fiveHour.start, T0 + 4 * H);
});

test("quota: an unknown limit is 'learning', and local models have no window at all", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  use(ctx, "claude", "claude", 50, T0, 1000);
  use(ctx, "hermes-local", "hermes", 500, T0, 100);
  const claude = q.subscriptions().find((s) => s.id === "claude")!, local = q.subscriptions().find((s) => s.id === "hermes-local")!;
  assert.equal(q.headroom(claude, T0 + H), undefined);
  assert.equal(q.predictLimited(claude, T0 + H).limited, false, "no limit known, nothing to predict");
  assert.equal(q.headroom(local, T0 + H), undefined);
  assert.equal(q.predictLimited(local, T0 + H).limited, false);
  assert.equal(q.expiresSoon(local, T0 + 4 * H), 0);
  assert.equal(q.status(local, T0 + H).free, true);
});

test("quota: Hermes runs land on MiniMax when the model says so, and on the free local model otherwise", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  const hermes = agent(ctx, "hermes");
  q.recordRun(hermes, ok("MiniMax-M2.5"), {}, T0);
  q.recordRun(hermes, ok("minimax-m2"), {}, T0 + 1);
  q.recordRun(hermes, ok("bonsai-8b"), {}, T0 + 2);
  q.recordRun(hermes, ok(), {}, T0 + 3);   // no model reported: the default entry
  q.recordRun(agent(ctx, "claude"), ok("claude-opus-5"), {}, T0 + 4);
  assert.equal(rows(ctx, "hermes-minimax").length, 2);
  assert.equal(rows(ctx, "hermes-local").length, 2);
  assert.equal(rows(ctx, "claude").length, 1);
  assert.ok(rows(ctx, "hermes-minimax").every((r) => r.model && /minimax/i.test(r.model) && r.tokensIn === 100 && r.tokensOut === 50));
  // A MiniMax rate limit marks MiniMax, not Hermes's free local model.
  q.recordRun(hermes, { ...fail("usage limit reached, resets in 2 hours"), model: "MiniMax-M2.5" }, {}, T0 + 10);
  assert.equal(q.predictLimited(q.subscriptions().find((s) => s.id === "hermes-minimax")!, T0 + 11).limited, true);
  assert.equal(q.predictLimited(q.subscriptions().find((s) => s.id === "hermes-local")!, T0 + 11).limited, false);
  assert.equal(q.agentLimited("hermes", T0 + 11), false, "Hermes can still run on Bonsai");
});

test("quota: every agent run is recorded through Orchestrator.call, planner and judge calls included", async () => {
  const ctx = setup();
  const hermes = agent(ctx, "hermes");
  const profile: Profile = { id: "minimax", label: "MiniMax", role: "worker", model: "MiniMax-M2", tier: 1 };
  await ctx.orch.call(hermes, "hello there", { profile });
  await ctx.orch.call(agent(ctx, "claude"), "[[MEMORY]]\nPROPOSAL:\nnoted", { jsonOnly: true });
  const mm = rows(ctx, "hermes-minimax");
  assert.equal(mm.length, 1);
  assert.equal(mm[0].source, "task");
  assert.ok(mm[0].tokensIn > 0 && mm[0].tokensOut > 0);
  const cl = rows(ctx, "claude");
  assert.equal(cl.length, 1);
  assert.equal(cl[0].source, "orchestrator", "planner and judge calls are tracked too");
  // Practice mode is not real usage.
  ctx.store.setKV("practice_mode", true);
  await ctx.orch.call(agent(ctx, "claude"), "hi", {});
  assert.equal(rows(ctx, "claude").length, 1);
});

// ---------- reading rate-limit text

test("quota: reset times are read from what the CLIs print, conservatively", () => {
  const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).getTime();
  const now = local(2026, 9, 23, 13, 0);
  assert.equal(parseResetTime("5-hour limit reached ∙ resets 3pm", now), local(2026, 9, 23, 15), "resets 3pm, later today");
  assert.equal(parseResetTime("5-hour limit reached ∙ resets 3pm", local(2026, 9, 23, 16, 0)), local(2026, 9, 24, 15), "3pm already passed: tomorrow");
  assert.equal(parseResetTime("Claude usage limit reached. Your limit will reset at 3:30 PM.", now), local(2026, 9, 23, 15, 30));
  assert.equal(parseResetTime("limit reached ∙ resets 3:30 PM", now), local(2026, 9, 23, 15, 30));
  assert.equal(parseResetTime("Weekly limit reached ∙ resets Oct 27, 9am", now), local(2026, 9, 27, 9));
  assert.equal(parseResetTime("Weekly limit reached ∙ resets Mon 9am", now), local(2026, 9, 26, 9), "Oct 23, 2026 is a Friday");
  assert.equal(parseResetTime("limit reached ∙ resets 3pm (America/New_York)", Date.UTC(2026, 9, 23, 12, 0)), Date.UTC(2026, 9, 23, 19, 0), "zone given: 3pm EDT is 19:00Z");
  assert.equal(parseResetTime("You've hit your usage limit. Try again in 3 hours 5 minutes.", now), now + 3 * H + 5 * MIN);
  assert.equal(parseResetTime("usage limit. You can try again in 2 days, 4 hours and 5 minutes", now), now + 2 * DAY + 4 * H + 5 * MIN);
  assert.equal(parseResetTime("usage limit reached, try again at Oct 25th, 2026 3:15 PM.", now), new Date("Oct 25, 2026 3:15 PM").getTime());
  assert.equal(parseResetTime("429 Too Many Requests. Retry-After: 120", now), now + 120_000);
  assert.equal(parseResetTime("limit reached ∙ resets soon", now), undefined, "no clock time: no guess");
  assert.equal(parseResetTime("usage limit reached, try again in 400 days", now), undefined, "more than 8 days out is treated as garbage");
  assert.equal(parseResetTime("resets 25pm", now), undefined);

  const c = classifyRateLimit("Claude AI usage limit reached | 5-hour limit reached ∙ resets 3pm", now)!;
  assert.deepEqual([c.kind, c.window, c.resetAt], ["quota", "fiveHour", local(2026, 9, 23, 15)]);
  assert.equal(classifyRateLimit("Weekly limit reached ∙ resets Oct 27, 9am", now)!.window, "weekly");
  assert.equal(classifyRateLimit("ERROR: You've hit your usage limit. Upgrade to Pro or try again in 3 hours.", now)!.kind, "quota", "Codex");
  assert.equal(classifyRateLimit("429 rate limit exceeded, try again later", now)!.kind, "burst", "a plain 429 says nothing about the window");
  assert.equal(classifyRateLimit("ECONNRESET", now), undefined);
  assert.equal(classifyRateLimit("API overloaded 529", now), undefined, "overload is retried on the same agent, not a quota event");
});

test("quota: a 429 with 'resets 3pm' marks the subscription limited until then and pins its window", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  const now = new Date(2026, 9, 23, 13, 0).getTime(), three = new Date(2026, 9, 23, 15, 0).getTime();
  use(ctx, "claude", "claude", 20, now - 2 * H, MIN);
  q.recordRun(agent(ctx, "claude"), fail("5-hour limit reached ∙ resets 3pm"), { taskId: "task_x" }, now);
  const sub = q.subscriptions().find((s) => s.id === "claude")!;
  assert.equal(sub.learned!.limitedUntil, three);
  assert.equal(sub.learned!.limitedWindow, "fiveHour");
  assert.equal(sub.learned!.anchors!.fiveHourStart, three - 5 * H, "the printed reset becomes the window boundary");
  assert.equal(sub.learned!.fiveHour!.runs, 20, "the usage when it hit is the learned limit");
  assert.equal(sub.learned!.fiveHour!.tokens, 20 * 150);
  assert.deepEqual([q.predictLimited(sub, now + MIN).limited, q.predictLimited(sub, now + MIN).until], [true, three]);
  assert.equal(q.predictLimited(sub, three + 1).limited, false, "lifted at the reset");
  assert.equal(q.status(sub, three + 1).windows.fiveHour.usedRuns, 0, "and usage from before the reset no longer counts");
  const failed = rows(ctx, "claude").filter((r) => r.rateLimited);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].resetAt, three);
  assert.ok(ctx.store.listAudit().some((a) => a.action === "quota.limited"), "audited");
});

test("quota: with no reset time the mark lasts to the window's end, and a plain 429 is only a short cooldown", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  use(ctx, "claude", "claude", 5, T0, MIN);
  q.recordRun(agent(ctx, "claude"), fail("usage limit reached"), {}, T0 + H);
  let s = q.subscriptions().find((x) => x.id === "claude")!;
  assert.equal(s.learned!.limitedUntil, T0 + 5 * H, "conservative default: the 5-hour window's end");
  q.recordRun(agent(ctx, "codex"), fail("429 rate limit exceeded"), {}, T0 + H);
  s = q.subscriptions().find((x) => x.id === "codex")!;
  assert.equal(s.learned!.limitedUntil, T0 + H + 2 * MIN);
  assert.equal(s.learned!.fiveHour, undefined, "nothing learned from a burst limit");
  // A run that starts after the mark and works clears it.
  q.recordRun(agent(ctx, "codex"), { ...ok(), durationMs: 10 }, {}, T0 + H + MIN);
  assert.equal(q.subscriptions().find((x) => x.id === "codex")!.learned!.limitedUntil, undefined);
});

test("quota: learned limits blend readings and ignore a limit hit at zero usage", () => {
  const a = learnLimit(undefined, { tokens: 1000, runs: 10 }, 1)!;
  assert.deepEqual([a.tokens, a.runs, a.samples], [1000, 10, 1]);
  const b = learnLimit(a, { tokens: 600, runs: 6 }, 2)!;
  assert.deepEqual([b.tokens, b.runs, b.samples], [800, 8, 2], "halfway to the new reading");
  assert.equal(learnLimit(b, { tokens: 0, runs: 0 }, 3), b);
  // The owner's own number beats the learned one.
  const ctx = setup();
  const q = quotaFor(ctx.store);
  use(ctx, "claude", "claude", 8, T0, MIN);
  q.recordRun(agent(ctx, "claude"), fail("usage limit reached ∙ try again in 1 hour"), {}, T0 + 10 * MIN);
  limits(ctx, "claude", { windows: { fiveHour: { limitRuns: 100 } } });
  const sub = q.subscriptions().find((s) => s.id === "claude")!;
  assert.equal(sub.learned!.fiveHour!.runs, 8, "an owner edit keeps what the hub learned");
  assert.equal(q.status(sub, T0 + 20 * MIN).windows.fiveHour.limitRuns, 100);
  assert.equal(q.status(sub, T0 + 20 * MIN).windows.fiveHour.limitSource, "owner");
});

// ---------- AC2: routing

test("routing: a subscription at its limit is left out, the task goes elsewhere, and the record says why", async () => {
  const ctx = setup({ rand: () => 0.99 });
  const lead = agent(ctx, "claude"); lead.settings.noOwner = true; ctx.store.saveAgent(lead);
  limits(ctx, "claude", { windows: { fiveHour: { limitRuns: 4 } } });
  use(ctx, "claude", "claude", 4, Date.now() - H, MIN);   // used up
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const log = ctx.store.listRouting({ goalId: goal.id }).filter((r) => r.kind === "task" && ["learned", "explore", "only_candidate"].includes(r.reason));
  assert.ok(log.length >= 2);
  for (const r of log) {
    assert.notEqual(r.chosen, "claude", "no work sent to an exhausted subscription");
    assert.ok(!r.candidates.some((c) => c.agentId === "claude"), "it isn't in the pool the probabilities describe");
    assert.deepEqual(r.quota!.excluded.map((e) => [e.agentId, e.subscriptionId, e.reason]), [["claude", "claude", "estimated"]]);
    assert.ok(Math.abs(r.candidates.reduce((n, c) => n + c.p, 0) - 1) < 1e-3, "probabilities still sum to one");
  }
});

test("routing: a subscription that hit a real limit stays out until the reset, then comes back", async () => {
  const ctx = setup({ rand: () => 0.99 });
  const q = quotaFor(ctx.store);
  const agents = ctx.store.listAgents();
  q.recordRun(agent(ctx, "codex"), fail("You've hit your usage limit. Try again in 3 hours."), {}, T0);
  const during = quotaAdjust(ctx.store, agents, "coding", T0 + H);
  assert.deepEqual(during.pool.map((a) => a.id), ["claude", "hermes"]);
  assert.deepEqual(during.note.excluded, [{ agentId: "codex", subscriptionId: "codex", reason: "reported", until: T0 + 3 * H }]);
  assert.deepEqual(quotaAdjust(ctx.store, agents, "coding", T0 + 3 * H + 1).pool.map((a) => a.id), ["claude", "codex", "hermes"]);
});

test("routing: when every candidate is limited, only the one that frees up first is kept", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  q.recordRun(agent(ctx, "claude"), fail("5-hour limit reached ∙ try again in 4 hours"), {}, T0);
  q.recordRun(agent(ctx, "codex"), fail("usage limit reached. try again in 1 hour"), {}, T0);
  const two = ctx.store.listAgents().filter((a) => a.id !== "hermes");
  const adj = quotaAdjust(ctx.store, two, "coding", T0 + MIN);
  assert.deepEqual(adj.pool.map((a) => a.id), ["codex"], "codex is back first");
  assert.deepEqual(adj.note.excluded.map((e) => e.agentId), ["claude"]);
  const d = quotaDecide(ctx.store, two, "coding", 0.15, [], () => 0.99, [], T0 + MIN)!;
  assert.equal(d.agent.id, "codex");
  assert.equal(d.reason, "only_candidate");
  assert.equal(d.pChosen, 1);
});

test("routing: if the only idle agent is limited and another with quota is busy, the task waits for it", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  q.recordRun(agent(ctx, "claude"), fail("5-hour limit reached ∙ try again in 4 hours"), {}, T0);
  const claude = [agent(ctx, "claude")], busy = [agent(ctx, "codex")];
  assert.equal(quotaDecide(ctx.store, claude, "coding", 0, [], () => 0.99, busy, T0 + MIN), undefined, "codex has quota and will be free soon");
  q.recordRun(agent(ctx, "codex"), fail("usage limit reached. try again in 1 hour"), {}, T0);
  assert.equal(quotaDecide(ctx.store, claude, "coding", 0, [], () => 0.99, busy, T0 + MIN)!.agent.id, "claude", "nobody has quota: send it anyway");
});

test("routing: capacity expiring in 30 minutes outranks capacity with a full window left", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  const lim = { windows: { fiveHour: { limitRuns: 100 } } };
  limits(ctx, "claude", lim); limits(ctx, "codex", lim);
  // Claude's window opened 4.5 hours ago and 40% of it is unused; Codex hasn't started a window.
  use(ctx, "claude", "claude", 60, T0 - 270 * MIN, 1000);
  const now = T0;
  const claude = q.subscriptions().find((s) => s.id === "claude")!, codex = q.subscriptions().find((s) => s.id === "codex")!;
  assert.ok(q.expiresSoon(claude, now) > 0.3, `expiring share ${q.expiresSoon(claude, now)}`);
  assert.equal(q.expiresSoon(codex, now), 0);
  const order = [agent(ctx, "codex"), agent(ctx, "claude")];   // Codex first: it would win a tie
  const d = quotaDecide(ctx.store, order, "coding", 0, [], () => 0.99, [], now)!;
  assert.equal(d.agent.id, "claude");
  assert.deepEqual(d.quota!.boosted.map((b) => [b.agentId, b.reason]), [["claude", "expiring"]]);
  assert.ok(d.quota!.boosted[0].bonus > 0 && d.quota!.boosted[0].bonus <= 0.05, "a small nudge, not an override");
  assert.equal(d.candidates.find((c) => c.agentId === "claude")!.expected, d.candidates.find((c) => c.agentId === "codex")!.expected, "expected scores are logged untouched");

  // The same unused share with 4 hours left is worth far less than with 30 minutes left.
  use(ctx, "codex", "codex", 60, T0 - 60 * MIN, 1000);
  assert.ok(q.expiresSoon(q.subscriptions().find((s) => s.id === "codex")!, now) < q.expiresSoon(claude, now) / 3, "urgency grows as the reset nears");
  // The nudge never overrides a clearly better agent.
  recordOutcome(ctx.store, "codex", "coding", { judgment: { score: 0.95, verdict: "accept", feedback: "", judgeAgentId: "claude" }, seconds: 1, failed: false, revision: false });
  recordOutcome(ctx.store, "claude", "coding", { judgment: { score: 0.5, verdict: "accept", feedback: "", judgeAgentId: "codex" }, seconds: 1, failed: false, revision: false });
  assert.equal(quotaDecide(ctx.store, order, "coding", 0, [], () => 0.99, [], now)!.agent.id, "codex");
});

test("routing: the local free tier wins within the quality margin and loses outside it", () => {
  const ctx = setup();
  const agents = ctx.store.listAgents();
  const grade = (id: string, score: number) => recordOutcome(ctx.store, id, "coding", { judgment: { score, verdict: "accept", feedback: "", judgeAgentId: "x" }, seconds: 1, failed: false, revision: false });
  grade("claude", 0.9); grade("codex", 0.7); grade("hermes", 0.86);   // 0.04 behind the best
  const within = quotaDecide(ctx.store, agents, "coding", 0, [], () => 0.99)!;
  assert.equal(within.agent.id, "hermes", "free and within 0.05 of the best");
  assert.deepEqual(within.quota!.boosted.map((b) => [b.agentId, b.reason]), [["hermes", "free_tier"]]);
  assert.ok(Math.abs(within.candidates.reduce((n, c) => n + c.p, 0) - 1) < 1e-3);

  ctx.store.saveScore({ ...ctx.store.getScore("hermes", "coding"), runs: 1, quality: 0.8 });   // 0.10 behind
  const outside = quotaDecide(ctx.store, agents, "coding", 0, [], () => 0.99)!;
  assert.equal(outside.agent.id, "claude");
  assert.equal(outside.quota, undefined, "no adjustment to explain");

  quotaFor(ctx.store).saveSettings({ freeMargin: 0.15 });   // the owner widens the margin
  assert.equal(quotaDecide(ctx.store, agents, "coding", 0, [], () => 0.99)!.agent.id, "hermes");
  quotaFor(ctx.store).saveSettings({ freeMargin: 0 });
  assert.equal(quotaDecide(ctx.store, agents, "coding", 0, [], () => 0.99)!.agent.id, "claude");
});

// ---------- rate limits reroute

test("rate limit: the task moves to another agent at once, the subscription is marked, and the router stops using it", async () => {
  const ctx = setup({ rand: () => 0.99 });
  MockAdapter.transientSeen.clear();
  const codex = agent(ctx, "codex"); codex.settings.transient = 1; codex.settings.transientError = "5-hour limit reached ∙ resets 3pm"; ctx.store.saveAgent(codex);
  for (const id of ["claude", "codex", "hermes"]) ctx.store.saveAgent(agent(ctx, id));
  const before = Date.now();
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const tasks = ctx.store.listTasks({ goalId: goal.id });
  const research = tasks.find((t) => t.title === "Research the topic")!;
  assert.notEqual(research.assignee, "codex");
  assert.equal(research.attempts, 1, "no attempt spent");
  assert.deepEqual(research.triedBy, ["codex"]);
  const msgs = ctx.store.listMessages(ctx.room.id);
  assert.ok(msgs.some((m) => m.text.includes("moving it to another agent")));
  assert.ok(!msgs.some((m) => m.text.includes("temporary error")), "didn't wait and retry on the same agent");
  const sub = quotaFor(ctx.store).subscriptions().find((s) => s.id === "codex")!;
  assert.ok(sub.learned!.limitedUntil! > before, "marked limited until the printed reset");
  const log = ctx.store.listRouting({ goalId: goal.id });
  const bounced = log.find((r) => r.taskId === research.id && r.chosen === "codex")!;
  assert.equal(bounced.outcome, "run_failed");
  assert.equal(bounced.failureTag, "other");
  assert.match(bounced.failureNote!, /rate limit/);
  // codex's score isn't blamed for a quota problem
  assert.equal(ctx.store.getScore("codex", research.taskType).failures, 0);
});

test("rate limit: rerouting is bounded when every agent is out of quota", async () => {
  const ctx = setup({ rand: () => 0.99 });
  MockAdapter.transientSeen.clear();
  for (const id of ["claude", "codex", "hermes"]) { const a = agent(ctx, id); a.settings.transient = 99; ctx.store.saveAgent(a); }
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.ok(["paused", "failed"].includes(goal.status), `ends (${goal.status}) instead of bouncing forever`);
  assert.ok(ctx.store.listTasks({ goalId: goal.id }).some((t) => t.status === "failed"));
  const report = quotaFor(ctx.store).report(7);
  assert.ok(report.rateLimitFailures >= 3 && report.rateLimitFailures < 60, `${report.rateLimitFailures} failures`);
});

// ---------- AC3: the measurement

test("report: the 7-day report counts predicted and unpredicted rate-limit failures", () => {
  const ctx = setup();
  const q = quotaFor(ctx.store);
  const claude = agent(ctx, "claude"), codex = agent(ctx, "codex");
  // 1. Claude: limit unknown, 10 runs, then a limit hits. Nobody could have seen that coming.
  use(ctx, "claude", "claude", 10, T0, MIN);
  q.recordRun(claude, fail("5-hour limit reached ∙ try again in 2 hours"), {}, T0 + 30 * MIN);
  // 2. Claude again while the hub already knows it's out (a stray retry): predicted.
  q.recordRun(claude, fail("5-hour limit reached ∙ try again in 2 hours"), {}, T0 + 45 * MIN);
  // 3. Later the window turns over; usage climbs to the learned limit and another hit arrives: the estimate said "full", so it's predicted.
  use(ctx, "claude", "claude", 10, T0 + 3 * H, MIN);
  q.recordRun(claude, fail("5-hour limit reached ∙ try again in 2 hours"), {}, T0 + 3 * H + 20 * MIN);
  // 4. Codex: a burst 429 with a quiet window. Unpredicted.
  q.recordRun(codex, fail("429 rate limit exceeded"), {}, T0 + H);
  // 5. A failure from ten days ago is outside the report.
  q.ledger.record({ agentId: "codex", subscriptionId: "codex", at: T0 - 10 * DAY, tokensIn: 0, tokensOut: 0, runs: 1, rateLimited: true, predicted: false, source: "task" });
  // Successes are not failures.
  q.recordRun(codex, ok(), {}, T0 + 2 * H);

  const r = q.report(7, T0 + 4 * H);
  assert.equal(r.rateLimitFailures, 4);
  assert.equal(r.predicted, 2);
  assert.equal(r.unpredicted, 2);
  assert.deepEqual(r.bySubscription.claude, { label: "Claude (subscription)", rateLimitFailures: 3, predicted: 2, unpredicted: 1 });
  assert.deepEqual(r.bySubscription.codex, { label: "ChatGPT/Codex (subscription)", rateLimitFailures: 1, predicted: 0, unpredicted: 1 });
  assert.equal(q.report(30, T0 + 4 * H).rateLimitFailures, 5, "a wider window picks up the old one");
  assert.equal(q.report(1, T0 + 4 * H).rateLimitFailures, 4);
});

// ---------- API and the apps

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await pr.json()) as { token: string };
  return { ...ctx, app, base, h: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

test("api: GET/PUT /quota/subscriptions, settings and GET /quota/report", async () => {
  const { app, base, h, store } = await boot();
  const list = (await (await fetch(`${base}/quota/subscriptions`, { headers: h })).json()) as SubscriptionStatus[];
  assert.deepEqual(list.map((s) => s.subscription.id), ["claude", "codex", "hermes-local", "hermes-minimax"]);
  assert.equal(list.find((s) => s.subscription.id === "hermes-local")!.free, true);
  assert.equal(list[0].windows.fiveHour.headroom, undefined, "limit unknown: the app shows 'learning'");

  quotaFor(store).recordRun(store.getAgent("claude")!, fail("usage limit reached ∙ try again in 2 hours"), {});
  const edited = list.map((s) => ({ ...s.subscription, ...(s.subscription.id === "claude" ? { plan: "Max 5x", windows: { fiveHour: { limitRuns: 50 }, weekly: { limitTokens: 5_000_000 } }, learned: { limitedUntil: 1 } } : {}) }));
  const put = await fetch(`${base}/quota/subscriptions`, { method: "PUT", headers: h, body: JSON.stringify(edited) });
  assert.equal(put.status, 200);
  const after = ((await put.json()) as SubscriptionStatus[]).find((s) => s.subscription.id === "claude")!;
  assert.equal(after.subscription.plan, "Max 5x");
  assert.equal(after.windows.fiveHour.limitRuns, 50);
  assert.equal(after.windows.weekly.limitTokens, 5_000_000);
  assert.ok(after.subscription.learned!.limitedUntil! > 1000, "the owner can't overwrite what the hub learned");
  assert.ok(store.listAudit().some((a) => a.action === "quota.subscriptions"));
  assert.equal((await fetch(`${base}/quota/subscriptions`, { method: "PUT", headers: h, body: JSON.stringify([{ id: "x" }]) })).status >= 400, true, "bad bodies are refused");

  const rep = (await (await fetch(`${base}/quota/report?days=7`, { headers: h })).json()) as QuotaReport;
  assert.deepEqual([rep.days, rep.rateLimitFailures, rep.predicted, rep.unpredicted], [7, 1, 0, 1]);
  assert.equal(rep.bySubscription.claude.rateLimitFailures, 1);

  const set = await fetch(`${base}/quota/settings`, { method: "PUT", headers: h, body: JSON.stringify({ freeMargin: 0.1 }) });
  assert.equal(((await set.json()) as { freeMargin: number }).freeMargin, 0.1);
  assert.equal(((await (await fetch(`${base}/quota/settings`, { headers: h })).json()) as { expiryBonus: number }).expiryBonus, 0.05);
  const forgot = (await (await fetch(`${base}/quota/subscriptions/claude/forget`, { method: "POST", headers: h })).json()) as SubscriptionStatus[];
  assert.equal(forgot.find((s) => s.subscription.id === "claude")!.subscription.learned, undefined);
  await app.close();
});

test("apps: Mac Settings and the phone web app both show the Subscriptions list", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const mac = readFileSync(join(here, "../../app/src/screens/SettingsScreen.tsx"), "utf8");
  assert.match(mac, /<Section title="Subscriptions"/);
  assert.match(readFileSync(join(here, "../../app/src/components/subscriptions.tsx"), "utf8"), /learning/);
  assert.match(readFileSync(join(here, "../../app/src/api/client.ts"), "utf8"), /\/quota\/subscriptions/);
  const js = readFileSync(join(here, "../web/app.js"), "utf8");
  assert.match(js, /\/quota\/subscriptions/);
  assert.match(js, /learning/);
  assert.match(js, /data-nav="subscriptions"/);
  const css = readFileSync(join(here, "../web/app.css"), "utf8");
  assert.match(css, /\.qbar/);
});
