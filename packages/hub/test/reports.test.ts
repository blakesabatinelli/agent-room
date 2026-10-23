import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttentionItem, Approval, FailureTag, Goal, JuryRecord, RoutingOutcome, RoutingReason, RoutingRecord, RunUsage, Subscription } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { attentionFor, dayKey, lastOccurrence, localToEpoch } from "../src/attention/index.js";
import { saveJury } from "../src/jury/records.js";
import { quotaFor } from "../src/quota/index.js";
import { retroDb } from "../src/retro/index.js";
import { LEDGER_THRESHOLDS, advise, buildKillReview, buildLedger, buildScorecard, compareToSingleAgents, evaluateAlways, killReviewMain, reviewAttention, reviewJuries, reviewRouting, runDueReports } from "../src/report/index.js";
import { mulberry32, type LoggedDecision } from "../src/report/ope.js";
import { DAY, parseMonth, parseWeek } from "../src/report/periods.js";
import { setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;

// ---------------------------------------------------------------- helpers

/** Monday 2026-10-12 00:00 UTC: the first day of ISO week 2026-W42. */
const W42 = Date.UTC(2026, 9, 12);
const H = 3_600_000;
let n = 0;

interface RecIn {
  taskId: string; goalId: string; chosen: string; taskType: string; at: number; outcome: RoutingOutcome;
  score?: number; tag?: FailureTag; revision?: boolean; usage?: RunUsage; reason?: RoutingReason; probs?: Record<string, number>;
  goalText?: string; kind?: "task" | "direct"; model?: string;
}
/** A routing record as the orchestrator would have left it. */
function rec(store: Ctx["store"], o: RecIn): RoutingRecord {
  const probs = o.probs ?? { [o.chosen]: 1 };
  const r: RoutingRecord = {
    id: `rt_t${++n}`, at: o.at, roomId: "room", goalId: o.goalId, goalText: o.goalText ?? o.goalId, taskId: o.taskId, taskTitle: o.taskId, taskType: o.taskType,
    kind: o.kind ?? "task", attempt: 1, revision: !!o.revision, reason: o.reason ?? "learned", epsilon: 0.1,
    candidates: Object.entries(probs).map(([agentId, p]) => ({ agentId, expected: 0.5, runs: 0, p })), chosen: o.chosen, pChosen: probs[o.chosen] ?? 1,
    outcome: o.outcome, completedAt: o.at + 5000,
    ...(o.score !== undefined ? { judgment: { score: o.score, verdict: o.outcome === "accepted" ? "accept" as const : "revise" as const, judgeAgentId: "claude" } } : {}),
    ...(o.tag ? { failureTag: o.tag } : {}), ...(o.usage ? { usage: o.usage } : {}), ...(o.model ? { modelVersion: o.model } : {}),
  };
  store.saveRouting(r);
  return r;
}

function goal(ctx: Ctx, id: string, text: string, amendmentsAt: number[] = [], extra: Partial<Goal> = {}): Goal {
  const g: Goal = {
    id, roomId: ctx.room.id, text, status: "done", createdAt: W42,
    contract: { objective: text, constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: W42, amendments: amendmentsAt.map((at) => ({ at, text: "More detail" })) },
    ...extra,
  };
  ctx.store.saveGoal(g);
  return g;
}

function juryRec(ctx: Ctx, o: { id: string; kind: JuryRecord["kind"]; at: number; ownerAt: number; ownerDistance: number; workerFamily?: string; judges: { family: string; distance: number }[] }) {
  const r: JuryRecord = {
    id: o.id, taskId: `t_${o.id}`, goalId: "g1", at: o.at, kind: o.kind, worker: "claude", workerFamily: o.workerFamily ?? "anthropic", rewriter: "mechanical",
    judges: o.judges.map((j, i) => ({ agentId: `j${i}`, family: j.family, local: false, score: 0.5, verdict: "accept" as const, criteria: {}, distance: j.distance })),
    aggregate: { score: 0.5, verdict: "accept", criteria: {} }, agreement: { majority: 1, pairwise: 1, kappa: null, spread: 0 }, split: false,
    owner: { score: 0.5, at: o.ownerAt, juryDistance: o.ownerDistance },
  };
  saveJury(ctx.store, r);
}

// ================================================================ AC1: the weekly scorecard

/** A synthetic week (2026-W42) with known answers. */
function scorecardWeek(ctx: Ctx) {
  const { store } = ctx;
  const T = (d: number, h = 10) => W42 + d * DAY + h * H;
  goal(ctx, "g1", "Build the venue importer", [T(1), T(2)]);
  goal(ctx, "g2", "Write the board memo");
  const u = { inputTokens: 1000, outputTokens: 500, costUsd: 0.1 };
  // g1 / coding: claude's tA is sent back once (a spec failure) and then accepted; tB and tC pass first time; codex does tD.
  rec(store, { taskId: "tA", goalId: "g1", chosen: "claude", taskType: "coding", at: T(1), outcome: "revise", score: 0.6, tag: "spec", usage: u, goalText: "Build the venue importer" });
  rec(store, { taskId: "tA", goalId: "g1", chosen: "claude", taskType: "coding", at: T(1, 12), outcome: "accepted", score: 0.9, revision: true, reason: "revision", usage: u });
  rec(store, { taskId: "tB", goalId: "g1", chosen: "claude", taskType: "coding", at: T(2), outcome: "accepted", score: 0.9, usage: u });
  rec(store, { taskId: "tC", goalId: "g1", chosen: "claude", taskType: "coding", at: T(2, 12), outcome: "accepted", score: 0.8, usage: u });
  rec(store, { taskId: "tD", goalId: "g1", chosen: "codex", taskType: "coding", at: T(3), outcome: "accepted", score: 0.7, usage: u });
  // g2 / writing: claude is sent back twice, codex always passes. No usage was reported; one run left an estimate in the quota ledger.
  rec(store, { taskId: "w1", goalId: "g2", chosen: "claude", taskType: "writing", at: T(3), outcome: "revise", score: 0.5, tag: "other", goalText: "Write the board memo" });
  rec(store, { taskId: "w2", goalId: "g2", chosen: "claude", taskType: "writing", at: T(3, 11), outcome: "revise", score: 0.5, tag: "other" });
  rec(store, { taskId: "w3", goalId: "g2", chosen: "claude", taskType: "writing", at: T(3, 12), outcome: "accepted", score: 0.5 });
  rec(store, { taskId: "x1", goalId: "g2", chosen: "codex", taskType: "writing", at: T(4), outcome: "accepted", score: 0.8 });
  rec(store, { taskId: "x2", goalId: "g2", chosen: "codex", taskType: "writing", at: T(4, 11), outcome: "accepted", score: 0.9 });
  rec(store, { taskId: "x3", goalId: "g2", chosen: "codex", taskType: "writing", at: T(4, 12), outcome: "accepted", score: 0.7 });
  quotaFor(store).ledger.record({ agentId: "claude", subscriptionId: "claude", at: T(3) + 1000, tokensIn: 300, tokensOut: 200, runs: 1, rateLimited: false, source: "task", taskId: "w1", estimated: true });
  // Outside the week: ignored.
  rec(store, { taskId: "old", goalId: "g0", chosen: "claude", taskType: "coding", at: W42 - DAY, outcome: "accepted", score: 1, usage: u });
  rec(store, { taskId: "next", goalId: "g0", chosen: "claude", taskType: "coding", at: W42 + 7 * DAY + H, outcome: "accepted", score: 1, usage: u });
  // Judges: a jury and a single judge rated by the owner this week, and a rating from last week that must not count.
  juryRec(ctx, { id: "j1", kind: "jury", at: T(1), ownerAt: T(2), ownerDistance: 0.2, judges: [{ family: "anthropic", distance: 0.1 }, { family: "openai", distance: 0.3 }, { family: "local-bonsai", distance: 0.2 }] });
  juryRec(ctx, { id: "j2", kind: "fallback", at: T(2), ownerAt: T(3), ownerDistance: 0.4, judges: [{ family: "openai", distance: 0.4 }] });
  juryRec(ctx, { id: "j3", kind: "jury", at: W42 - 3 * DAY, ownerAt: W42 - 2 * DAY, ownerDistance: 0.9, judges: [{ family: "openai", distance: 0.9 }] });
  // Interruptions: counted per local day by the attention gate.
  store.setKV("attention_days", {
    "2026-10-13": { interrupts: 4, overCap: 0, queued: 1, held: 0, goalsDone: 1, digests: 1 },
    "2026-10-15": { interrupts: 2, overCap: 1, queued: 0, held: 0, goalsDone: 0, digests: 0 },
    "2026-10-20": { interrupts: 9, overCap: 0, queued: 0, held: 0, goalsDone: 0, digests: 0 },
  });
  retroDb(store).insert({ agentId: "claude", taskType: "coding", text: "Ask for the schema before writing the importer.", goalId: "g1", at: T(3), source: "orchestrator" });
  retroDb(store).insert({ agentId: "claude", taskType: "coding", text: "Last week's lesson.", goalId: "g0", at: W42 - DAY, source: "orchestrator" });
}

test("scorecard: numbers on a synthetic week (AC1)", () => {
  const ctx = setup();
  scorecardWeek(ctx);
  const sc = buildScorecard(ctx.store, "2026-W42", { now: W42 + 8 * DAY });
  assert.equal(sc.week, "2026-W42");
  assert.equal(sc.start, "2026-10-12"); assert.equal(sc.end, "2026-10-18");

  // totals: 10 tasks finished a first attempt, 7 of them accepted; 11 graded runs; 2 goals
  assert.deepEqual(sc.totals, { gradedRuns: 11, tasks: 10, accepted: 7, firstPass: 0.7, goals: 2 });

  // best agent per task type
  const coding = sc.bestByTaskType.find((t) => t.taskType === "coding")!;
  assert.equal(coding.best, "claude", "codex has one graded run, not enough to be called best");
  const claude = coding.agents.find((a) => a.agentId === "claude")!;
  assert.equal(claude.gradedRuns, 4); assert.equal(claude.meanQuality, 0.8);
  assert.equal(claude.firstPassTasks, 3); assert.equal(claude.firstPass, 0.667, "tA was sent back, tB and tC passed first time");
  assert.equal(coding.agents.find((a) => a.agentId === "codex")!.gradedRuns, 1);
  const writing = sc.bestByTaskType.find((t) => t.taskType === "writing")!;
  assert.equal(writing.best, "codex");
  assert.equal(writing.agents[0].agentId, "codex"); assert.equal(writing.agents[0].meanQuality, 0.8); assert.equal(writing.agents[0].firstPass, 1);
  assert.equal(writing.agents.find((a) => a.agentId === "claude")!.firstPass, 0.333);

  // vague goals: g1 had a spec failure, two clarifications from the owner and one send-back; g2 had neither
  assert.deepEqual(sc.vagueGoals.map((g) => [g.goalId, g.specFailures, g.clarifications, g.revisions]), [["g1", 1, 2, 1]]);
  assert.equal(sc.vagueGoals[0].goal, "Build the venue importer");

  // judge distance from the owner, this week's ratings only
  assert.equal(sc.judges.rated, 2);
  assert.deepEqual(sc.judges.jury, { n: 1, meanDistance: 0.2 });
  assert.deepEqual(sc.judges.single, { n: 1, meanDistance: 0.4 });
  assert.deepEqual(sc.judges.sameFamily, { n: 1, meanDistance: 0.1 });
  assert.deepEqual(sc.judges.crossFamily, { n: 3, meanDistance: 0.3 });
  assert.deepEqual(sc.judges.byFamily.map((f) => [f.family, f.n, f.meanDistance]), [["anthropic", 1, 0.1], ["local-bonsai", 1, 0.2], ["openai", 2, 0.35]]);

  // cost per goal: g1 reported 5 runs of 1.5k tokens and $0.10; g2 reported nothing, so the ledger's estimate stands in
  const g1 = sc.costPerGoal.find((g) => g.goalId === "g1")!;
  assert.equal(g1.runs, 5); assert.equal(g1.tokens, 7500); assert.equal(g1.estimated, false); assert.equal(g1.costUsd, 0.5);
  assert.equal(g1.accepted, 4); assert.equal(g1.costPerAccepted, 0.125);
  const g2 = sc.costPerGoal.find((g) => g.goalId === "g2")!;
  assert.equal(g2.tokens, 500); assert.equal(g2.estimated, true); assert.equal(g2.costUsd, null); assert.equal(g2.costPerAccepted, null);
  assert.equal(sc.cost.goals, 2); assert.equal(sc.cost.tokens, 8000); assert.equal(sc.cost.costUsd, 0.5);
  assert.equal(sc.cost.accepted, 8, "accepted tasks counted by task: tA once"); // g1 4 + g2 4 (w3, x1, x2, x3)

  // interruptions: the two days in the week, not the one after it
  assert.equal(sc.interruptions.total, 6); assert.equal(sc.interruptions.cap, 6); assert.equal(sc.interruptions.overCap, 1); assert.equal(sc.interruptions.queued, 1);
  assert.equal(sc.interruptions.days.length, 7);
  assert.deepEqual(sc.interruptions.days.filter((d) => d.interrupts).map((d) => [d.day, d.interrupts]), [["2026-10-13", 4], ["2026-10-15", 2]]);

  // lessons from this week only
  assert.deepEqual(sc.lessons.map((l) => l.text), ["Ask for the schema before writing the importer."]);

  // the Markdown says the same things
  assert.match(sc.markdown, /^# Scorecard, 2026-W42/);
  assert.match(sc.markdown, /\| writing \| yes \| codex \| 3 \| 0\.80 \|/);
  assert.match(sc.markdown, /Build the venue importer: 1 spec failure, 2 clarifications from you, 1 send-back\./);
  assert.match(sc.markdown, /6 this week \(daily cap 6\)/);
  assert.match(sc.markdown, /Ask for the schema before writing the importer\./);
  assert.match(sc.markdown, /\| Build the venue importer \| 5 \| 7,500 \| \$0\.50 \| 4 \| \$0\.13 \|/);
});

test("scorecard: an empty week, a bad week label, and week parsing", () => {
  const { store } = setup();
  const sc = buildScorecard(store, "2026-W10");
  assert.equal(sc.totals.tasks, 0); assert.equal(sc.totals.firstPass, null); assert.deepEqual(sc.bestByTaskType, []);
  assert.match(sc.markdown, /No graded work this week\./);
  assert.throws(() => buildScorecard(store, "2026-W99"), /Week must look like/);
  assert.equal(parseWeek("2026-W42"), W42);
  assert.equal(parseWeek("2026-W54"), undefined);
  assert.equal(parseWeek("2026-W1"), undefined);
  assert.equal(parseWeek("2027-W01"), Date.UTC(2027, 0, 4), "2027-01-04 is a Monday and week 1 contains it");
  assert.deepEqual(parseMonth("2026-10"), { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 10, 1) });
  assert.equal(parseMonth("2026-13"), undefined);
});

test("scorecard: an agent needs enough graded runs to be called best", () => {
  const ctx = setup();
  goal(ctx, "g1", "One goal");
  rec(ctx.store, { taskId: "a1", goalId: "g1", chosen: "claude", taskType: "slides", at: W42 + H, outcome: "accepted", score: 0.9 });
  rec(ctx.store, { taskId: "a2", goalId: "g1", chosen: "codex", taskType: "slides", at: W42 + 2 * H, outcome: "accepted", score: 0.8 });
  const t = buildScorecard(ctx.store, "2026-W42").bestByTaskType[0];
  assert.equal(t.best, undefined);
  assert.match(t.note!, /No agent has 3 graded runs yet \(most: 1\)/);
});

// ================================================================ AC2: the monthly return ledger

test("ledger: a local free plan, an api key and subscriptions, month by month (AC2)", () => {
  const ctx = setup();
  const { store } = ctx;
  const sub = (o: Partial<Subscription> & Pick<Subscription, "id" | "agentIds" | "kind" | "label">): Subscription => ({ provider: o.id, windows: {}, ...o });
  quotaFor(store).saveSubscriptions([
    sub({ id: "codex", label: "Codex (subscription)", agentIds: ["codex"], kind: "subscription", monthlyUsd: 20, plan: "Plus" }),
    sub({ id: "muse", label: "Muse (subscription)", agentIds: ["muse"], kind: "subscription", monthlyUsd: 20 }),
    sub({ id: "claude", label: "Claude (subscription)", agentIds: ["claude"], kind: "subscription", monthlyUsd: 20 }),
    sub({ id: "gemini", label: "Gemini (subscription)", agentIds: ["gemini"], kind: "subscription" }),
    sub({ id: "hermes-local", label: "Hermes on Bonsai (local)", agentIds: ["hermes"], kind: "local" }),
    sub({ id: "hermes-minimax", label: "MiniMax (subscription)", agentIds: ["hermes"], kind: "subscription", modelMatch: "minimax", monthlyUsd: 10 }),
    sub({ id: "openai-api", label: "OpenAI API key", agentIds: ["gpt-api"], kind: "api" }),
  ]);
  const oct = Date.UTC(2026, 9, 5);
  let k = 0;
  const accept = (agent: string, count: number, o: Partial<RecIn> = {}) => { for (let i = 0; i < count; i++) rec(store, { taskId: `${agent}-${o.model ?? ""}-${++k}`, goalId: "g", chosen: agent, taskType: "coding", at: oct + k * H, outcome: "accepted", score: 0.9, ...o }); };
  accept("codex", 41);
  accept("muse", 2);
  accept("claude", 3);
  accept("gemini", 5);
  accept("hermes", 6);                       // Bonsai: free
  accept("hermes", 2, { model: "MiniMax-M2" }); // its other plan
  accept("gpt-api", 4, { usage: { costUsd: 0.5 } });
  rec(store, { taskId: "gpt-fail", goalId: "g", chosen: "gpt-api", taskType: "coding", at: oct, outcome: "revise", score: 0.3, usage: { costUsd: 0.25 } }); // failures cost too
  // Not this month, and not accepted: neither counts.
  rec(store, { taskId: "sept", goalId: "g", chosen: "codex", taskType: "coding", at: Date.UTC(2026, 8, 30, 23), outcome: "accepted", score: 1 });
  rec(store, { taskId: "nope", goalId: "g", chosen: "muse", taskType: "coding", at: oct, outcome: "revise", score: 0.2 });

  const l = buildLedger(store, "2026-10", { now: Date.UTC(2026, 10, 1) });
  const row = (id: string) => l.rows.find((r) => r.subscriptionId === id)!;
  assert.equal(row("codex").accepted, 41); assert.equal(row("codex").costUsd, 20); assert.equal(row("codex").costPerAccepted, 0.4878);
  assert.equal(row("codex").line, "Codex: 41 accepted tasks for $20, $0.49 each. Keep.");
  assert.equal(row("codex").advice, "keep");
  assert.equal(row("muse").line, "Muse: 2 accepted for $20. Consider cancelling.");
  assert.equal(row("muse").advice, "cancel");
  assert.equal(row("claude").line, "Claude: 3 accepted tasks for $20, $6.67 each. Worth watching.");
  assert.equal(row("gemini").advice, "set_price"); assert.equal(row("gemini").costUsd, null); assert.equal(row("gemini").costBasis, "not set");
  assert.equal(row("hermes-local").costUsd, 0); assert.equal(row("hermes-local").accepted, 6); assert.equal(row("hermes-local").advice, "free");
  assert.match(row("hermes-local").line, /6 accepted tasks, free/);
  assert.equal(row("hermes-minimax").accepted, 2, "an agent's second plan is picked by the model it ran");
  assert.equal(row("openai-api").costBasis, "reported cost"); assert.equal(row("openai-api").costUsd, 2.25); assert.equal(row("openai-api").accepted, 4);
  assert.equal(row("openai-api").costPerAccepted, 0.5625); assert.equal(row("openai-api").advice, "keep");
  assert.equal(l.total.accepted, 41 + 2 + 3 + 5 + 6 + 2 + 4);
  assert.equal(l.total.costUsd, 20 + 20 + 20 + 0 + 10 + 2.25);
  assert.match(l.markdown, /^# Subscription return ledger, 2026-10/);
  assert.match(l.markdown, /- Codex: 41 accepted tasks for \$20, \$0\.49 each\. Keep\./);
  assert.match(l.markdown, /Keep: up to \$5 per accepted task\./);

  // the previous month has one accepted task on Codex
  const sept = buildLedger(store, "2026-09");
  assert.equal(sept.rows.find((r) => r.subscriptionId === "codex")!.accepted, 1);
  assert.throws(() => buildLedger(store, "October"), /Month must look like/);
});

test("ledger: the verdict thresholds", () => {
  const sub = { kind: "subscription" as const, label: "Codex (subscription)" };
  assert.equal(LEDGER_THRESHOLDS.keepUpToUsd, 5);
  assert.equal(advise(sub, 41, 20, 0).advice, "keep");
  assert.equal(advise(sub, 4, 20, 0).advice, "keep", "exactly $5 a task is still a keep");
  assert.equal(advise(sub, 3, 20, 0).advice, "watch", "$6.67 a task");
  assert.equal(advise(sub, 1, 20, 0).advice, "cancel", "fewer than 3 accepted tasks");
  assert.equal(advise(sub, 0, 20, 0).line, "Codex: 0 accepted for $20. Consider cancelling.");
  assert.equal(advise(sub, 1, 20, 0).advice, "cancel");
  assert.equal(advise(sub, 10, 200, 0).advice, "cancel", "$20 a task");
  assert.equal(advise(sub, 41, 20, 3).advice, "upgrade");
  assert.match(advise(sub, 41, 20, 3).line, /hit its limit 3 times; consider a bigger plan/);
  assert.equal(advise(sub, 41, 20, 2).advice, "keep");
  assert.equal(advise(sub, 5, null, 0).advice, "set_price");
  assert.equal(advise({ kind: "local", label: "Hermes on Bonsai (local)" }, 0, 0, 0).line, "Hermes on Bonsai: not used this month, free.");
  assert.equal(advise({ kind: "api", label: "OpenAI API key" }, 0, 0, 0).advice, "no_data");
});

// ================================================================ AC3: the attention gate and the evening digest

/** 10:00 on Wednesday 2026-10-14 in Chicago (CDT, UTC-5). */
const MORNING = Date.UTC(2026, 9, 14, 15, 0);
const at = (h: number, m = 0, day = 14) => localToEpoch(`2026-10-${String(day).padStart(2, "0")}`, h * 60 + m, "America/Chicago");

function gate(opts: { cap?: number; clock?: number; settings?: Record<string, unknown> } = {}) {
  const ctx = setup();
  const att = ctx.orch.attention;
  const pushes: { title: string; body: string }[] = [];
  att.push = (title, body) => { pushes.push({ title, body }); };
  let now = opts.clock ?? MORNING;
  att.clock = () => now;
  ctx.store.setSettings({ ...ctx.store.getSettings(), attention: { dailyInterruptCap: opts.cap ?? 3, ...(opts.settings ?? {}) } });
  const general = ctx.room;
  return { ...ctx, att, pushes, general, setNow: (t: number) => { now = t; }, queue: (): AttentionItem[] => att.state().queue };
}
const digests = (c: ReturnType<typeof gate>) => c.store.listMessages(c.general.id).filter((m) => m.text.startsWith("Evening digest"));
const pendingApproval = (c: ReturnType<typeof gate>, o: Partial<Approval> = {}) => {
  const a: Approval = { id: `apr_t${++n}`, agentId: "claude", tool: "gmail", action: "send the update", detail: "", status: "pending", createdAt: MORNING, ...o };
  c.store.saveApproval(a);
  return a;
};

test("attention: decisions interrupt until the daily cap, then queue for the digest (AC3)", () => {
  const c = gate({ cap: 3 });
  const results = [1, 2, 3, 4, 5].map((i) => c.att.notify("decision", { title: `Decision ${i}`, body: "Pick one" }));
  assert.deepEqual(results.map((r) => r.action), ["pushed", "pushed", "pushed", "queued", "queued"]);
  assert.deepEqual(results.slice(0, 3).map((r) => r.used), [1, 2, 3]);
  assert.equal(results[3].reason, "cap");
  assert.deepEqual(c.pushes.map((p) => p.title), ["Decision 1", "Decision 2", "Decision 3"]);
  assert.equal(c.att.state().day.interrupts, 3);
  assert.deepEqual(c.queue().map((i) => [i.title, i.why]), [["Decision 4", "cap"], ["Decision 5", "cap"]]);
  // a disagreement counts against the same cap
  assert.equal(c.att.notify("disagreement", { title: "The judges disagree" }).action, "queued");
  // the next local day starts again at zero
  c.setNow(at(10, 0, 15));
  assert.equal(c.att.notify("decision", { title: "Fresh day" }).action, "pushed");
  assert.equal(c.att.state().day.interrupts, 1);
  assert.equal(c.att.state().today, "2026-10-15");
});

test("attention: an approval that blocks running work always goes through, and is counted", () => {
  const c = gate({ cap: 2 });
  c.att.notify("decision", { title: "One" }); c.att.notify("decision", { title: "Two" });
  assert.equal(c.att.notify("decision", { title: "Three" }).action, "queued");
  // a real approval card: the store event reaches the gate, the card is pending in the app as before
  const blocking = pendingApproval(c);
  assert.deepEqual(c.pushes.map((p) => p.title), ["One", "Two", "Approval needed"], "pushed although the cap is used");
  assert.match(c.pushes[2].body, /claude wants to use gmail: send the update/);
  assert.equal(c.att.state().day.interrupts, 3, "counted");
  assert.equal(c.att.state().day.overCap, 1);
  assert.ok(c.store.listApprovals("pending").some((a) => a.id === blocking.id), "still shown in the apps");
  // a memory question does not block anything: it waits like any other decision
  pendingApproval(c, { tool: "memory", action: "Which is right?", question: { kind: "memory", oldId: "m1", proposalId: "p1", choices: [] } });
  assert.equal(c.pushes.length, 3);
  assert.deepEqual(c.queue().map((i) => i.title), ["Three", "A question for you"]);
  // the same approval seen twice is one alert
  c.store.emit("event", { type: "approval", approval: blocking });
  assert.equal(c.pushes.length, 3);
  // an approval that was decided or expired is not an alert
  pendingApproval(c, { status: "approved", decidedAt: MORNING });
  assert.equal(c.pushes.length, 3);
});

test("attention: a jury split is a disagreement and interrupts; informational items never do", () => {
  const c = gate({ cap: 6 });
  c.store.emit("event", { type: "jury_split", at: MORNING, taskId: "tx", goalId: "g1", juryId: "jur_1", verdict: "revise", judges: [{ agentId: "claude", family: "anthropic", verdict: "accept", score: 0.9 }, { agentId: "codex", family: "openai", verdict: "revise", score: 0.4 }] });
  assert.equal(c.pushes.length, 1);
  assert.equal(c.pushes[0].title, "The judges disagree");
  assert.match(c.pushes[0].body, /anthropic accept, openai revise/);
  assert.equal(c.att.state().day.interrupts, 1);

  for (const kind of ["goal_done", "goal_failed", "model_shift", "retro", "failure", "report", "info"] as const) {
    assert.equal(c.att.notify(kind, { title: `A ${kind}` }).action, "queued");
  }
  assert.equal(c.pushes.length, 1, "nothing but the split was pushed");
  assert.equal(c.att.state().day.interrupts, 1);
  assert.equal(c.queue().length, 7);
  assert.ok(c.queue().every((i) => i.why === "digest"));
  // and an informational item is not stopped by an exhausted cap, nor does it use any of it
  const full = gate({ cap: 0 });
  assert.equal(full.att.notify("decision", { title: "Late" }).action, "queued");
  assert.equal(full.att.notify("goal_done", { title: "Done" }).reason, "digest");
});

test("attention: quiet hours hold every push, then one push when they end", () => {
  const c = gate({ cap: 6, clock: at(23, 30) });
  const open = pendingApproval(c);                      // blocking, but it is the middle of the night
  const gone = pendingApproval(c, { action: "other" });
  c.store.saveGoal({ id: "g9", roomId: c.general.id, text: "Plan me", status: "awaiting_approval", createdAt: MORNING } as Goal);
  c.att.notify("decision", { title: "A plan is ready", key: "plan:g9:1" });
  assert.equal(c.pushes.length, 0);
  assert.equal(c.att.state().day.held, 3);
  assert.equal(c.queue().filter((i) => i.held).length, 3);
  // one is decided while the owner sleeps
  c.approvals.decide(gone.id, "rejected");
  c.setNow(at(6, 59, 15)); assert.equal(c.att.tick().released, undefined, "still quiet at 06:59");
  c.setNow(at(7, 0, 15));
  const t = c.att.tick();
  assert.equal(t.released, 2);
  assert.equal(c.pushes.length, 1);
  assert.equal(c.pushes[0].title, "2 things need you");
  assert.match(c.pushes[0].body, /Approval needed/);
  assert.equal(c.att.state().day.interrupts, 1, "one interruption for the lot, on the day it went out");
  assert.equal(c.queue().length, 0);
  assert.ok(c.store.listApprovals("pending").some((a) => a.id === open.id));
});

test("attention: the digest goes out once at the configured time, with what waited, and clears the queue", () => {
  const c = gate({ cap: 1, clock: MORNING, settings: { digestAt: "18:00" } });
  c.store.saveGoal({ id: "g1", roomId: c.general.id, text: "Redo the board deck", status: "done", createdAt: MORNING } as Goal);
  c.att.notify("decision", { title: "Approve the deck plan" });                                   // pushed (the 1 of 1)
  c.att.notify("decision", { title: "Pick a template", goalId: "g1" });                           // over the cap
  c.att.notify("retro", { title: "3 lessons written" });                                         // no goal
  c.att.goalEnded("g1");
  assert.equal(c.pushes.length, 1);
  rec(c.store, { taskId: "d1", goalId: "g1", chosen: "claude", taskType: "slides", at: at(11), outcome: "accepted", score: 0.9, usage: { costUsd: 0.4 } });
  rec(c.store, { taskId: "d2", goalId: "g1", chosen: "codex", taskType: "slides", at: at(12), outcome: "accepted", score: 0.8, usage: { costUsd: 0.2 } });
  pendingApproval(c, { createdAt: at(9) });                                                       // still waiting on the owner at 18:00 (it was pushed? cap used: blocking so yes)
  const before = c.pushes.length;

  c.setNow(at(17, 59)); assert.deepEqual(c.att.tick(), {}); assert.equal(digests(c).length, 0);
  c.setNow(at(18, 0));
  const out = c.att.tick();
  assert.ok(out.digest);
  const posted = digests(c);
  assert.equal(posted.length, 1, "one digest message, in the general room");
  assert.equal(posted[0].quiet, undefined, "a real post, not log noise");
  const text = posted[0].text;
  assert.match(text, /^Evening digest, Wed, Oct 14\n/);
  assert.match(text, /Today: 1 goal done, 2 tasks accepted, \$0\.60 API-equivalent spend, 2 interruptions \(cap 1; 1 went through past it because work was blocked\)\./);
  assert.match(text, /Still needs you:\n- Approval: claude wants to use gmail: send the update/);
  assert.match(text, /Waited for the digest \(3\):/);
  assert.match(text, /\nRedo the board deck\n- Pick a template \(past the daily cap\)\n- Done: Redo the board deck\n/, "grouped under the goal");
  assert.match(text, /General\n- 3 lessons written/);
  assert.ok(!text.includes("—"), "no em dashes");
  assert.equal(c.pushes.length, before + 1, "and one push for the digest");
  assert.equal(c.pushes.at(-1)!.title, "Evening digest");
  assert.equal(c.queue().length, 0, "the queue is cleared");
  assert.equal(c.att.state().lastDigestAt, at(18, 0));
  assert.equal(c.att.state().day.digests, 1);

  // again, a minute later and an hour later: nothing
  c.setNow(at(18, 1)); assert.deepEqual(c.att.tick(), {});
  c.setNow(at(23, 0)); assert.deepEqual(c.att.tick(), {});
  assert.equal(digests(c).length, 1);
  assert.equal(c.pushes.length, before + 1);
});

test("attention: a quiet day sends no digest; a day with activity but nothing queued sends one", () => {
  const c = gate({ clock: MORNING });
  c.att.tick();
  c.setNow(at(18, 5));
  assert.deepEqual(c.att.tick(), {}, "nothing happened");
  c.setNow(at(8, 0, 15));
  rec(c.store, { taskId: "q1", goalId: "g", chosen: "claude", taskType: "x", at: at(9, 0, 15), outcome: "accepted", score: 1 });
  c.setNow(at(18, 5, 15));
  assert.ok(c.att.tick().digest, "a task was accepted today");
  assert.match(digests(c)[0].text, /Nothing else waited for the digest\./);
});

test("attention: a digest missed while the hub slept goes out at the next start, once", () => {
  const c = gate({ clock: MORNING });
  c.att.notify("goal_done", { title: "Done: weekly report" });
  c.att.notify("model_shift", { title: "Codex changed models" });
  c.att.tick();                                                // the hub ran this morning...
  c.setNow(at(9, 30, 15));                                     // ...and was asleep at 18:00; the owner opens the Mac the next morning
  c.att.start(3_600_000);                                      // what main.ts does at start
  c.att.stop();
  const posted = digests(c);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /Sent late: the hub wasn't running at 18:00\./);
  assert.match(posted[0].text, /Done: weekly report/);
  assert.match(posted[0].text, /Evening digest, Wed, Oct 14/, "it is yesterday's digest");
  assert.equal(c.queue().length, 0);
  c.att.tick(); c.att.tick(); c.setNow(at(9, 31, 15)); c.att.tick();
  assert.equal(digests(c).length, 1, "once");
  // and it was not "missed" for a time before the gate first ran
  const fresh = gate({ clock: at(20, 0) });
  assert.deepEqual(fresh.att.tick(), {}, "a new install has no earlier 18:00 to catch up on");
});

test("attention: /digest posts it now, in the room it was typed in, and does not start a goal", async () => {
  const c = gate({ cap: 1 });
  c.att.notify("decision", { title: "First", goalId: "g1" });
  c.att.notify("decision", { title: "Second" });
  c.att.notify("goal_done", { title: "Done: the thing" });
  const other = c.store.createRoom("ops");
  await c.orch.handleOwnerMessage(other.id, "/digest");
  await c.orch.idle();
  const msgs = c.store.listMessages(other.id);
  assert.equal(msgs.length, 2, "the owner's /digest and the digest");
  assert.match(msgs[1].text, /^Evening digest, Wed, Oct 14/);
  assert.match(msgs[1].text, /Second \(past the daily cap\)/);
  assert.match(msgs[1].text, /Done: the thing/);
  assert.equal(c.store.listGoals(other.id).length, 0, "not sent to the planner as a goal");
  assert.equal(c.queue().length, 0);
  assert.equal(c.pushes.length, 1, "no push for a digest the owner asked for");
  await c.orch.handleOwnerMessage(other.id, "/digest");
  assert.match(c.store.listMessages(other.id).at(-1)!.text, /Nothing else waited for the digest\./, "with nothing queued it says so");
});

test("attention: time zone and settings", () => {
  const c = gate({ settings: { timezone: undefined } });
  assert.equal(c.att.settings().timezone, "America/Chicago", "the default");
  c.att.zoneHint = () => "Asia/Tokyo";
  assert.equal(c.att.settings().timezone, "Asia/Tokyo", "USER.md's");
  c.store.setSettings({ ...c.store.getSettings(), attention: { timezone: "Europe/Paris" } });
  assert.equal(c.att.settings().timezone, "Europe/Paris", "the owner's setting wins");
  c.store.setSettings({ ...c.store.getSettings(), attention: { timezone: "Not/AZone", digestAt: "25:99" } });
  assert.equal(c.att.settings().timezone, "Asia/Tokyo");
  assert.equal(c.att.settings().digestAt, "18:00");
  assert.equal(c.att.settings().dailyInterruptCap, 6, "default cap");
  // local days and times
  assert.equal(dayKey(Date.UTC(2026, 9, 14, 4, 59), "America/Chicago"), "2026-10-13");
  assert.equal(localToEpoch("2026-10-14", 18 * 60, "America/Chicago"), Date.UTC(2026, 9, 14, 23, 0));
  assert.equal(localToEpoch("2026-11-02", 18 * 60, "America/Chicago"), Date.UTC(2026, 10, 3, 0, 0), "after the clocks went back");
  assert.equal(lastOccurrence(Date.UTC(2026, 9, 14, 15, 0), 18 * 60, "America/Chicago"), Date.UTC(2026, 9, 13, 23, 0));
});

// ================================================================ saving the reports

test("reports: the scorecard is saved to the Library each Monday and the ledger each month, once", () => {
  const ctx = setup();
  scorecardWeek(ctx);
  rec(ctx.store, { taskId: "ledger1", goalId: "g1", chosen: "codex", taskType: "coding", at: Date.UTC(2026, 9, 6), outcome: "accepted", score: 0.9 });
  ctx.orch.attention.push = () => undefined;
  const monday = Date.UTC(2026, 9, 19, 8);
  const first = runDueReports(ctx.store, ctx.orch.library, monday);
  assert.ok(first.scorecard);
  assert.equal(first.ledger, undefined, "September had no work");
  assert.equal(first.scorecard!.frontMatter.status, "final");
  assert.equal(first.scorecard!.frontMatter.title, "Weekly scorecard 2026-W42");
  assert.equal(first.scorecard!.roomId, ctx.room.id);
  assert.match(readFileSync(first.scorecard!.path, "utf8"), /# Scorecard, 2026-W42/);
  assert.equal(runDueReports(ctx.store, ctx.orch.library, monday + H).scorecard, undefined, "not twice");
  assert.equal(ctx.orch.library.list().length, 1);
  assert.ok(ctx.orch.attention.state().queue.some((i) => i.kind === "report"), "and the digest says where it went");

  const nov = runDueReports(ctx.store, ctx.orch.library, Date.UTC(2026, 10, 2, 8));
  assert.ok(nov.ledger);
  assert.equal(nov.ledger!.frontMatter.title, "Subscription return ledger 2026-10");
  assert.equal(nov.scorecard, undefined, "the week that ended had no work, so nothing is saved");
  assert.match(readFileSync(nov.ledger!.path, "utf8"), /Subscription return ledger, 2026-10/);
  assert.equal(runDueReports(ctx.store, ctx.orch.library, Date.UTC(2026, 10, 3)).ledger, undefined);
});

// ================================================================ the kill-criteria review

/** Draw the log a policy would leave: each decision's candidates, probabilities and a pass or fail from the true pass rates. */
function simulate(count: number, truth: Record<string, Record<string, number>>, policy: Record<string, Record<string, number>>, seed: number): LoggedDecision[] {
  const rand = mulberry32(seed);
  const contexts = Object.keys(truth);
  const out: LoggedDecision[] = [];
  for (let i = 0; i < count; i++) {
    const context = contexts[i % contexts.length];
    const probs = policy[context];
    let u = rand(), chosen = Object.keys(probs)[0];
    for (const [a, p] of Object.entries(probs)) { if (u < p) { chosen = a; break; } u -= p; }
    out.push({ context, chosen, p: probs[chosen], probs, reward: rand() < truth[context][chosen] ? 1 : 0 });
  }
  return out;
}
const TRUTH = { code: { A: 0.8, B: 0.5 }, docs: { A: 0.4, B: 0.9 } };
const POLICY = { code: { A: 0.7, B: 0.3 }, docs: { A: 0.3, B: 0.7 } };

test("IPS: a tiny log with the answer worked out by hand", () => {
  const both = { A: 0.5, B: 0.5 };
  const rows: LoggedDecision[] = [
    { context: "x", chosen: "A", p: 0.5, probs: both, reward: 1 }, { context: "x", chosen: "A", p: 0.5, probs: both, reward: 0 },
    { context: "x", chosen: "B", p: 0.5, probs: both, reward: 1 }, { context: "x", chosen: "B", p: 0.5, probs: both, reward: 1 },
  ];
  const a = evaluateAlways(rows, "A"), b = evaluateAlways(rows, "B");
  assert.equal(a.n, 4); assert.equal(a.picked, 2);
  assert.equal(a.ips, 0.5); assert.equal(a.snips, 0.5);       // (2*1 + 2*0) / 4;  (2*1 + 2*0) / (2+2)
  assert.equal(b.ips, 1); assert.equal(b.snips, 1);
  assert.equal(a.logged, 0.75);
  assert.equal(a.ess, 2);
  // a candidate with probability 0 on a decision says nothing about it, so the decision is left out
  const withZero = [...rows, { context: "x", chosen: "A", p: 1, probs: { A: 1, B: 0 }, reward: 1 }];
  assert.equal(evaluateAlways(withZero, "B").n, 4);
  assert.equal(evaluateAlways(withZero, "B").coverage, 0.8);
  assert.equal(evaluateAlways(rows, "nobody").ips, null);
});

test("IPS: on a synthetic log where the answer is known it recovers the true value", () => {
  const rows = simulate(40_000, TRUTH, POLICY, 42);
  // the truth: contexts are half and half. Always A = (0.8 + 0.4) / 2, always B = (0.5 + 0.9) / 2, the policy = (0.71 + 0.75) / 2
  const trueA = 0.6, trueB = 0.7, truePolicy = 0.73;
  const a = evaluateAlways(rows, "A"), b = evaluateAlways(rows, "B");
  assert.ok(Math.abs(a.logged! - truePolicy) < 0.01, `policy value ${a.logged}`);
  for (const [name, est, truth] of [["A", a, trueA], ["B", b, trueB]] as const) {
    assert.ok(Math.abs(est.ips! - truth) < 0.02, `ips ${name} ${est.ips} vs ${truth}`);
    assert.ok(Math.abs(est.snips! - truth) < 0.015, `snips ${name} ${est.snips} vs ${truth}`);
    assert.ok(Math.abs(est.dr! - truth) < 0.015, `dr ${name} ${est.dr} vs ${truth}`);
  }
  // the naive answer (what the agent scored on the tasks it happened to get) is badly off, which is why the weights matter
  const naiveA = rows.filter((r) => r.chosen === "A").reduce((s, r) => s + r.reward, 0) / rows.filter((r) => r.chosen === "A").length;
  assert.ok(Math.abs(naiveA - trueA) > 0.05, `naive ${naiveA}`);

  const cmp = compareToSingleAgents(rows);
  assert.equal(cmp.best!.target, "B", "the best single agent");
  assert.ok(Math.abs(cmp.gap! - 0.03) < 0.015, `gap ${cmp.gap}`);
  assert.ok(cmp.gap! < 0.05, "under the 5 point threshold");
  assert.ok(cmp.interval && cmp.interval.lo < cmp.gap! && cmp.gap! < cmp.interval.hi);
  assert.deepEqual(compareToSingleAgents(rows).interval, cmp.interval, "the same every time it is run");
});

/** Put a simulated log into the routing log as graded tasks spread over the last `days` days. */
function storeLog(ctx: Ctx, rows: LoggedDecision[], now: number, days = 20) {
  rows.forEach((r, i) => rec(ctx.store, {
    taskId: `sim${i}`, goalId: `simg${i % 20}`, chosen: r.chosen, taskType: r.context, at: now - Math.floor((i / (rows.length - 1)) * days * DAY), outcome: r.reward ? "accepted" : "revise",
    score: r.reward ? 0.9 : 0.3, probs: r.probs, reason: i % 5 === 0 ? "explore" : "learned",
  }));
}

test("kill review (a): under 200 graded tasks it says not enough data, with the date it will have 200", () => {
  const ctx = setup();
  const now = Date.UTC(2026, 11, 1);
  storeLog(ctx, simulate(50, TRUTH, POLICY, 1), now, 10);
  const r = reviewRouting(ctx.store.listRouting(), now);
  assert.equal(r.status, "not enough data");
  assert.equal(r.gradedTasks, 50);
  assert.match(r.detail, /^not enough data: 50 of 200 graded tasks\./);
  assert.equal(r.perDay, 5.0);
  assert.equal(r.reachesAt, new Date(now + 30 * DAY).toISOString().slice(0, 10), "150 more at 5 a day");
  assert.match(r.detail, new RegExp(r.reachesAt!));
  assert.equal(r.overall, undefined, "no estimates until there is enough to say anything");
  // with nothing recent there is no date to give
  assert.match(reviewRouting(ctx.store.listRouting(), now + 90 * DAY).detail, /no date to estimate/);
  // --force shows preliminary numbers, and says they are
  const forced = reviewRouting(ctx.store.listRouting(), now, { force: true });
  assert.match(forced.detail, /^Preliminary \(forced\): 50 of 200/);
  assert.equal(forced.status, "not enough data");
});

test("kill review (a): with 200 graded tasks it replays the log and applies the 5 point threshold", () => {
  // Learned routing barely beats the best single agent: triggered.
  const a = setup();
  const now = Date.UTC(2026, 11, 1);
  storeLog(a, simulate(2000, TRUTH, POLICY, 42), now, 28);
  const r = reviewRouting(a.store.listRouting(), now);
  assert.equal(r.status, "triggered");
  assert.equal(r.overall!.best!.target, "B");
  assert.match(r.detail, /"always B" is estimated at 7\d%/);
  assert.match(r.detail, /Learned routing wins by [0-4]\.\d points \(threshold 5\)/);
  assert.equal(r.byTaskType.length, 2);
  assert.deepEqual(r.byTaskType.map((t) => t.cmp.best?.target), ["A", "B"], "the best single agent differs by task type");

  // Learned routing picks the right agent for each kind of work: not triggered.
  const sharp = { code: { A: 0.9, B: 0.1 }, docs: { A: 0.1, B: 0.9 } };
  const b = setup();
  storeLog(b, simulate(2000, { code: { A: 0.9, B: 0.3 }, docs: { A: 0.3, B: 0.9 } }, sharp, 7), now, 28);
  const r2 = reviewRouting(b.store.listRouting(), now);
  assert.equal(r2.status, "not triggered");
  assert.ok(r2.overall!.gap! > 0.2);
  // Revisions and fixed picks have no choice to replay and are left out.
  const c = setup();
  rec(c.store, { taskId: "fx", goalId: "g", chosen: "claude", taskType: "code", at: now, outcome: "accepted", score: 1, reason: "planned_owner", probs: { claude: 1, codex: 0 } });
  assert.equal(reviewRouting(c.store.listRouting(), now).decisions, 0);
});

test("kill review (b): cross-vendor judges against same-vendor judges", () => {
  const ctx = setup();
  assert.match(reviewJuries(ctx.store).detail, /^not enough owner ratings: 0 judge scores from the worker's own family and 0 from other families, 20 of each needed/);
  assert.equal(reviewJuries(ctx.store).status, "not enough data");
  // 25 rated juries: the same-family judge is always close, the other families a little further, but only sometimes past 0.2
  for (let i = 0; i < 25; i++) juryRec(ctx, { id: `jb${i}`, kind: "jury", at: W42, ownerAt: W42 + H, ownerDistance: 0.1, judges: [{ family: "anthropic", distance: 0.05 }, { family: "openai", distance: i % 5 === 0 ? 0.4 : 0.1 }] });
  const worse = reviewJuries(ctx.store);
  assert.equal(worse.status, "triggered");
  assert.equal(worse.sameVendor.n, 25); assert.equal(worse.crossVendor.n, 25);
  assert.equal(worse.sameVendor.disagreeRate, 0); assert.equal(worse.crossVendor.disagreeRate, 0.2);
  assert.equal(worse.jury.n, 25);
  assert.match(worse.detail, /Other-family judges were more than 0\.2 away from your rating 20% of the time \(25 scores/);

  const other = setup();
  for (let i = 0; i < 25; i++) juryRec(other, { id: `jc${i}`, kind: "jury", at: W42, ownerAt: W42 + H, ownerDistance: 0.1, judges: [{ family: "anthropic", distance: i % 2 ? 0.5 : 0.05 }, { family: "openai", distance: 0.05 }] });
  assert.equal(reviewJuries(other.store).status, "not triggered", "the worker's own family is the one that drifts");
});

test("kill review (c): minutes spent on approvals against minutes saved", () => {
  const ctx = setup();
  const t0 = Date.UTC(2026, 9, 13, 12);
  const approval = (minutes: number, o: Partial<Approval> = {}) => ctx.store.saveApproval({ id: `apr_k${++n}`, agentId: "claude", tool: "gmail", action: "send", detail: "", status: "approved", createdAt: t0, decidedAt: t0 + minutes * 60_000, ...o });
  approval(2); approval(3); approval(240);                          // the last one sat overnight: capped at 5 minutes
  approval(1, { auto: true }); approval(9, { status: "expired" });  // not the owner's attention
  for (let i = 0; i < 4; i++) rec(ctx.store, { taskId: `k${i}`, goalId: "g", chosen: "claude", taskType: "x", at: t0 + i * H, outcome: "accepted", score: 1 });

  const none = reviewAttention(ctx.store, ctx.store.listRouting());
  assert.equal(none.spent, 10, "2 + 3 + 5");
  assert.equal(none.items, 3);
  assert.equal(none.status, "needs input", "no estimate of minutes saved yet");
  assert.match(none.detail, /Enter how many minutes an accepted task saves you/);

  ctx.store.setSettings({ ...ctx.store.getSettings(), minutesSavedPerTask: 2 });          // 4 tasks x 2 = 8 saved, 10 spent
  const costly = reviewAttention(ctx.store, ctx.store.listRouting());
  assert.equal(costly.saved, 8); assert.equal(costly.status, "triggered");
  assert.equal(costly.weeks[0].week, "2026-W42");
  ctx.store.setSettings({ ...ctx.store.getSettings(), minutesSavedPerTask: 15 });
  assert.equal(reviewAttention(ctx.store, ctx.store.listRouting()).status, "not triggered");
});

test("kill review: the report, the Library copy and the pnpm review:kill script", async () => {
  const ctx = setup();
  quotaFor(ctx.store).subscriptions();
  const now = Date.UTC(2026, 11, 1);
  storeLog(ctx, simulate(30, TRUTH, POLICY, 3), now, 10);
  const review = buildKillReview(ctx.store, { now });
  assert.match(review.markdown, /^# Kill-criteria review, 2026-12-01/);
  for (const h of ["## 1. Routing doesn't pay", "## 2. Juries are worse than the user", "## 3. Costs more attention than it saves", "## 4. Subscriptions close"]) assert.ok(review.markdown.includes(h), h);
  assert.match(review.markdown, /not enough data: 30 of 200 graded tasks/);
  assert.match(review.markdown, /\| Subscriptions close \| Check by hand \|/);
  assert.match(review.markdown, /- \[ \] For each provider above/);
  assert.match(review.markdown, /\| Claude \(subscription\) \| anthropic \| subscription \|/);

  // the script: reads the database file, prints Markdown, saves to the Library
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (s: string) => { out.push(String(s)); }; console.error = (s: string) => { err.push(String(s)); };
  try {
    const libDir = join(ctx.dir, "ReviewLibrary");
    const code = await killReviewMain([join(ctx.dir, "t.db"), "--library", libDir]);
    assert.equal(code, 0);
    assert.match(out.join("\n"), /# Kill-criteria review, /);
    const saved = err.join("\n").match(/Saved to the Library: (.+)/)?.[1];
    assert.ok(saved && existsSync(saved), "saved");
    assert.match(readFileSync(saved!, "utf8"), /status: final/);
    assert.match(saved!, /general/);
    assert.equal(await killReviewMain([join(ctx.dir, "nope.db")]), 2);
    assert.equal(await killReviewMain([join(ctx.dir, "t.db"), "--bogus"]), 2);
  } finally { console.log = log; console.error = error; }
});

// ================================================================ HTTP and settings

test("HTTP: the reports, the attention state, and the settings that drive them", async () => {
  const ctx = setup();
  scorecardWeek(ctx);
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const code = (app as unknown as { pairingCode: () => string }).pairingCode();
    const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/reports/scorecard`)).status, 401);

    const sc = (await (await fetch(`${base}/reports/scorecard?week=2026-W42`, { headers: h })).json()) as { week: string; totals: { tasks: number }; markdown: string };
    assert.equal(sc.week, "2026-W42"); assert.equal(sc.totals.tasks, 10); assert.match(sc.markdown, /^# Scorecard, 2026-W42/);
    const md = await fetch(`${base}/reports/scorecard?week=2026-W42&format=md`, { headers: h });
    assert.match(md.headers.get("content-type")!, /text\/markdown/);
    assert.match(await md.text(), /^# Scorecard, 2026-W42/);
    assert.equal((await fetch(`${base}/reports/scorecard?week=nonsense`, { headers: h })).status, 400);
    assert.equal(((await (await fetch(`${base}/reports/scorecard`, { headers: h })).json()) as { week: string }).week.length, 8, "this week by default");

    // the owner prices a plan; the ledger sees it
    const subs = (await (await fetch(`${base}/quota/subscriptions`, { headers: h })).json()) as { subscription: Subscription }[];
    const edited = subs.map((s) => (s.subscription.id === "codex" ? { ...s.subscription, monthlyUsd: 20 } : s.subscription));
    const put = await fetch(`${base}/quota/subscriptions`, { method: "PUT", headers: h, body: JSON.stringify(edited) });
    assert.equal(put.status, 200);
    assert.equal(quotaFor(ctx.store).subscriptions().find((s) => s.id === "codex")!.monthlyUsd, 20);
    const bad = await fetch(`${base}/quota/subscriptions`, { method: "PUT", headers: h, body: JSON.stringify(edited.map((s) => ({ ...s, monthlyUsd: -5 }))) });
    assert.notEqual(bad.status, 200, "a negative price is refused");
    const ledger = (await (await fetch(`${base}/reports/ledger?month=2026-10`, { headers: h })).json()) as { rows: { subscriptionId: string; costUsd: number; accepted: number }[]; markdown: string };
    const codex = ledger.rows.find((r) => r.subscriptionId === "codex")!;
    assert.equal(codex.costUsd, 20); assert.equal(codex.accepted, 4);
    assert.equal((await fetch(`${base}/reports/ledger?month=13`, { headers: h })).status, 400);

    // settings: the cap, the digest time, quiet hours, the time zone and minutes saved
    const s = (await (await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ attention: { dailyInterruptCap: 4, digestAt: "19:30", timezone: "America/New_York", quietFrom: "23:00", quietTo: "06:30" }, minutesSavedPerTask: 12 }) })).json()) as { attention: { dailyInterruptCap: number }; minutesSavedPerTask: number };
    assert.equal(s.attention.dailyInterruptCap, 4); assert.equal(s.minutesSavedPerTask, 12);
    const state = (await (await fetch(`${base}/attention`, { headers: h })).json()) as { settings: { digestAt: string; timezone: string; dailyInterruptCap: number; quietFrom: string }; queue: unknown[]; day: { interrupts: number } };
    assert.deepEqual([state.settings.digestAt, state.settings.timezone, state.settings.dailyInterruptCap, state.settings.quietFrom], ["19:30", "America/New_York", 4, "23:00"]);
    assert.equal(state.day.interrupts, 0);
    assert.equal((await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ attention: { digestAt: "7pm" } }) })).status >= 400, true, "a digest time has to be HH:MM");
    assert.equal((await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ attention: { timezone: "Mars/Base" } }) })).status >= 400, true);

    const kill = (await (await fetch(`${base}/reports/kill-review`, { headers: h })).json()) as { routing: { status: string }; markdown: string };
    assert.equal(kill.routing.status, "not enough data");
  } finally { await app.close(); }
});

test("an approval is still pushed live through the hub's own event stream", async () => {
  const ctx = setup();
  const att = ctx.orch.attention;
  const pushes: string[] = [];
  att.push = (t) => { pushes.push(t); };
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  try {
    const seen: string[] = [];
    ctx.store.on("event", (e: { type: string }) => seen.push(e.type));
    const p = ctx.approvals.request({ agentId: "claude", tool: "gmail", action: "send", detail: "x" });
    assert.deepEqual(pushes, ["Approval needed"]);
    assert.ok(seen.includes("approval"), "the apps still get the card at once");
    ctx.approvals.decide(ctx.store.listApprovals("pending")[0].id, "approved");
    assert.equal((await p).status, "approved");
    assert.deepEqual(pushes, ["Approval needed"], "deciding it is not an alert");
  } finally { await app.close(); }
});

test("a goal that asks the owner a question, and a plan to approve, are decisions; a finished goal is for the digest", async () => {
  const ctx = setup();
  const att = ctx.orch.attention;
  const pushes: string[] = [];
  att.push = (t, b) => { pushes.push(`${t}: ${b}`); };
  ctx.store.setSettings({ ...ctx.store.getSettings(), planApproval: "always" });
  await ctx.orch.handleOwnerMessage(ctx.room.id, "Research the venue market, write the findings, and then review them for gaps and make a summary slide");
  for (let i = 0; i < 100 && !ctx.store.listGoals(ctx.room.id).some((g) => g.status === "awaiting_approval"); i++) await new Promise((r) => setTimeout(r, 30));
  const g = ctx.store.listGoals(ctx.room.id)[0];
  assert.equal(g.status, "awaiting_approval");
  assert.ok(pushes.some((p) => p.startsWith("A plan is ready for approval")), pushes.join("\n"));
  ctx.orch.decidePlan(g.id, "approve");
  for (let i = 0; i < 200 && ctx.store.getGoal(g.id)!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 30));
  await ctx.orch.idle();
  assert.equal(ctx.store.getGoal(g.id)!.status, "done");
  assert.equal(pushes.length, 1, "finishing the goal did not interrupt");
  const q = att.state().queue;
  assert.ok(q.some((i) => i.kind === "goal_done" && i.goalId === g.id), "it is waiting for the digest");
  assert.equal(att.state().day.goalsDone, 1);
});
