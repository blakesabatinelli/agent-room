import { test } from "node:test";
import assert from "node:assert/strict";
import type { RoutingRecord } from "@agent-room/shared";
import { setup } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { pickAgent, recordOutcome } from "../src/orchestrator/scoring.js";
import { addUsage, closeRecord, decide, routingJsonl } from "../src/orchestrator/routing.js";
import { classifyFailure, parseFailureCategory } from "../src/orchestrator/failures.js";
import { claudeUsage } from "../src/adapters/claudeCode.js";
import { codexUsage } from "../src/adapters/codex.js";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;

// ---------- 0.2: the policy's probabilities

test("routing: epsilon-greedy probabilities are exact and match the pick", () => {
  const { store } = setup();
  const agents = store.listAgents();
  recordOutcome(store, "codex", "coding", { judgment: { score: 0.95, verdict: "accept", feedback: "", judgeAgentId: "claude" }, seconds: 10, failed: false, revision: false });
  recordOutcome(store, "claude", "coding", { judgment: { score: 0.5, verdict: "revise", feedback: "", judgeAgentId: "codex" }, seconds: 10, failed: false, revision: false });
  const d = decide(store, agents, "coding", 0.15, [], () => 0.99)!;
  assert.equal(d.agent.id, "codex");
  assert.equal(d.reason, "learned");
  assert.ok(close(sum(d.candidates.map((c) => c.p)), 1), "probabilities sum to 1");
  const n = agents.length;
  assert.ok(close(d.candidates.find((c) => c.agentId === "codex")!.p, 0.85 + 0.15 / n), "greedy pick gets 1-eps plus its share");
  for (const c of d.candidates.filter((c) => c.agentId !== "codex")) assert.ok(close(c.p, 0.15 / n), "everyone else gets eps/n");
  assert.equal(d.pChosen, d.candidates.find((c) => c.agentId === "codex")!.p);
  assert.equal(d.candidates.find((c) => c.agentId === "codex")!.runs, 1);

  // Same draws, same pick as the policy the hub always used.
  for (const seq of [[0.99], [0.01, 0.0], [0.01, 0.5], [0.01, 0.99]]) {
    const mk = () => { let i = 0; return () => seq[Math.min(i++, seq.length - 1)]; };
    assert.equal(decide(store, agents, "coding", 0.15, [], mk())!.agent.id, pickAgent(store, agents, "coding", 0.15, [], mk())!.id);
  }
  const explored = decide(store, agents, "coding", 1, [], () => 0)!;
  assert.equal(explored.reason, "explore");
  assert.ok(explored.candidates.every((c) => close(c.p, 1 / n)));

  const ex = decide(store, agents, "coding", 0.1, ["codex"], () => 0.99)!;
  assert.deepEqual(ex.excluded, ["codex"]);
  assert.ok(!ex.candidates.some((c) => c.agentId === "codex"));
  const one = decide(store, [agents[0]], "coding", 0.5, [], () => 0)!;
  assert.equal(one.reason, "only_candidate");
  assert.equal(one.pChosen, 1);
  assert.equal(decide(store, agents, "coding", 0.1, agents.map((a) => a.id)), undefined);
});

// ---------- 0.2: the write path, end to end

test("routing log: every task attempt is recorded with candidates, model, tokens, cost, time, outcome and score", async () => {
  const { store, orch, room } = setup();
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const tasks = store.listTasks({ goalId: goal.id });
  const log = store.listRouting({ goalId: goal.id });
  assert.equal(log.length, sum(tasks.map((t) => t.attempts)), "one record per attempt");
  for (const r of log) {
    const t = tasks.find((x) => x.id === r.taskId)!;
    assert.ok(t, "record points at a real task");
    assert.equal(r.goalId, goal.id);
    assert.equal(r.taskType, t.taskType);
    assert.equal(r.kind, "task");
    assert.equal(r.chosen, t.assignee);
    assert.ok(r.candidates.length >= 1 && r.candidates.some((c) => c.agentId === r.chosen));
    assert.ok(close(sum(r.candidates.map((c) => c.p)), 1), "candidate probabilities sum to 1");
    assert.ok(r.candidates.every((c) => typeof c.expected === "number" && c.p >= 0 && c.p <= 1));
    assert.equal(typeof r.epsilon, "number");
    assert.ok(["planned_owner", "learned", "explore", "revision", "only_candidate"].includes(r.reason));
    assert.ok(r.profileId, "profile recorded");
    assert.match(r.modelVersion ?? "", /^mock-/, "model version the CLI reported");
    assert.ok((r.usage?.inputTokens ?? 0) > 0 && (r.usage?.outputTokens ?? 0) > 0, "tokens recorded");
    assert.equal(r.usage?.costUsd, 0, "cost recorded");
    assert.equal(typeof r.seconds, "number");
    assert.equal(r.outcome, "accepted");
    assert.equal(typeof r.judgment?.score, "number");
    assert.ok(r.judgment?.judgeAgentId && r.judgment.judgeAgentId !== r.chosen);
    assert.ok(r.completedAt && r.completedAt >= r.at);
    assert.equal(r.failureTag, undefined);
  }
});

test("routing log: learned picks record the policy's probabilities; planned owners record p = 1", async () => {
  const { store, orch, room } = setup({ rand: () => 0.99 });
  const lead = store.getAgent("claude")!; lead.settings.noOwner = true; store.saveAgent(lead);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const log = store.listRouting({ goalId: goal.id });
  assert.ok(log.length > 0 && log.every((r) => r.reason === "learned"), "no owner named: the learned policy picks");
  const eps = store.getSettings().explorationRate;
  for (const r of log) {
    const n = r.candidates.length;
    if (n > 1) assert.ok(close(r.pChosen, 1 - eps + eps / n), "the greedy pick's real probability, not 1");
    assert.ok(close(sum(r.candidates.map((c) => c.p)), 1));
  }
  const { store: s2, orch: o2, room: r2 } = setup();
  const g2 = await o2.runGoal(r2.id, "Summarize the venue TV market");
  const planned = s2.listRouting({ goalId: g2.id }).filter((r) => r.reason === "planned_owner");
  assert.ok(planned.length > 0);
  for (const r of planned) assert.equal(r.pChosen, 1);
});

test("routing log: a direct answer is recorded too", async () => {
  const { store, orch, room } = setup();
  const goal = await orch.runGoal(room.id, "what time is it?");
  const [r] = store.listRouting({ goalId: goal.id });
  assert.equal(r.kind, "direct");
  assert.equal(r.attempt, 1);
  assert.equal(r.outcome, "answered");
  assert.ok(close(sum(r.candidates.map((c) => c.p)), 1));
  assert.ok((r.usage?.outputTokens ?? 0) > 0);
});

test("routing log: sent-back work records the verdict and a failure tag", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) { a.settings.quality = 0.3; store.saveAgent(a); }
  store.setSettings({ ...store.getSettings(), maxAttempts: 2, maxGoalReplans: 0 });
  const goal = await orch.runGoal(room.id, "hard goal");
  const log = store.listRouting({ goalId: goal.id });
  const back = log.filter((r) => r.outcome === "revise" || r.outcome === "reassign");
  assert.ok(back.length > 0);
  for (const r of back) {
    assert.ok(r.failureTag, "every send-back is tagged");
    assert.ok(r.judgment && r.judgment.score < 0.6);
  }
  assert.ok(log.every((r) => r.outcome !== "pending"), "no record left open when the goal stops");
});

test("JSONL export round-trips and sits behind device auth", async () => {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal((await fetch(`${base}/routing/export.jsonl`)).status, 401);
  const res = await fetch(`${base}/routing/export.jsonl`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /ndjson/);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="agent-room-routing-/);
  const lines = (await res.text()).trim().split("\n");
  const rows = lines.map((l) => JSON.parse(l) as RoutingRecord);
  assert.equal(rows.length, ctx.store.listRouting().length);
  assert.ok(rows.every((r) => r.goalId === goal.id && r.taskId && r.chosen));
  const one = await (await fetch(`${base}/routing?goalId=${goal.id}&limit=1`, { headers: { authorization: `Bearer ${token}` } })).json() as RoutingRecord[];
  assert.equal(one.length, 1);
  assert.ok(ctx.store.listAudit().some((a) => a.action === "routing.exported"));
  assert.equal(routingJsonl([]), "");
  await app.close();
});

test("routing helpers: usage adds across retries; closing an unknown record is a no-op", () => {
  assert.deepEqual(addUsage({ inputTokens: 10, costUsd: 0.5 }, { inputTokens: 5, outputTokens: 2 }), { inputTokens: 15, outputTokens: 2, costUsd: 0.5 });
  assert.deepEqual(addUsage(undefined, { outputTokens: 1 }), { outputTokens: 1 });
  const { store } = setup();
  closeRecord(store, "rt_missing", { outcome: "accepted" });
  closeRecord(store, undefined, { outcome: "accepted" });
  assert.equal(store.listRouting().length, 0, "never invents a record");
});

test("adapters report tokens, cost and model from the CLIs' own output", () => {
  assert.deepEqual(claudeUsage({ usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, total_cost_usd: 0.0123 }),
    { inputTokens: 12, outputTokens: 34, cacheReadTokens: 100, cacheWriteTokens: 5, costUsd: 0.0123 });
  assert.equal(claudeUsage({}), undefined, "nothing reported, nothing guessed");
  assert.deepEqual(codexUsage({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }),
    { inputTokens: 600, outputTokens: 50, cacheReadTokens: 400 });
  assert.deepEqual(codexUsage({ msg: { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 3 } } } }),
    { inputTokens: 10, outputTokens: 3, cacheReadTokens: undefined });
  assert.equal(codexUsage({ type: "item.completed" }), undefined);
});

// ---------- 0.5: failure tags

test("failure tags: mechanical evidence first, the judge's call only when it's silent", () => {
  assert.equal(classifyFailure({ kind: "run_error" }).tag, "other");
  assert.equal(classifyFailure({ kind: "blocked" }).tag, "spec");
  assert.equal(classifyFailure({ kind: "needs_input" }).tag, "spec");
  const judged = (extra: object) => ({ score: 0.3, verdict: "revise" as const, feedback: "", judgeAgentId: "x", ...extra });
  assert.equal(classifyFailure({ kind: "sent_back", drift: ["Changed files outside its scope: x"], judgment: judged({ failureCategory: "spec" }) }).tag, "misalignment", "drift beats the judge's label");
  assert.equal(classifyFailure({ kind: "sent_back", judgment: judged({ onTask: false }) }).tag, "misalignment");
  assert.equal(classifyFailure({ kind: "sent_back",
    report: { status: "done", criteria: { AC1: { verdict: "PASS", evidence: "" } }, outOfScope: "none" },
    judgment: judged({ criteria: { AC1: { verdict: "FAIL", evidence: "missing" } } }) }).tag, "verification", "claimed PASS, reviewer says FAIL");
  assert.equal(classifyFailure({ kind: "sent_back",
    report: { status: "done", criteria: { AC1: { verdict: "PASS", evidence: "" } }, outOfScope: "none" }, failedChecks: ["AC1"], judgment: judged({}) }).tag, "verification", "claimed PASS, a command says FAIL");
  assert.equal(classifyFailure({ kind: "sent_back", drift: ["No STATUS block: the agent didn't report against its criteria."], judgment: judged({}) }).tag, "verification", "skipped its self-check");
  assert.equal(classifyFailure({ kind: "sent_back",
    report: { status: "done", criteria: { AC1: { verdict: "FAIL", evidence: "" } }, outOfScope: "none" },
    judgment: judged({ criteria: { AC1: { verdict: "FAIL", evidence: "" } }, failureCategory: "spec" }) }).tag, "spec", "honest failure: the judge's category");
  assert.equal(classifyFailure({ kind: "sent_back", judgment: judged({}) }).tag, "other");
  assert.equal(parseFailureCategory("Verification"), "verification");
  assert.equal(parseFailureCategory("unclear spec"), "spec");
  assert.equal(parseFailureCategory("went out of scope"), "misalignment");
  assert.equal(parseFailureCategory("banana"), undefined);
});

test("failure tags: drift is tagged misalignment on the task, in the audit log and in the routing log", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) { a.settings.outOfScope = "also rewrote the other task"; store.saveAgent(a); }
  store.setSettings({ ...store.getSettings(), maxAttempts: 1, maxGoalReplans: 0 });
  const goal = await orch.runGoal(room.id, "drifty goal");
  const tagged = store.listTasks({ goalId: goal.id }).flatMap((t) => t.failures ?? []);
  assert.ok(tagged.some((f) => f.tag === "misalignment"));
  assert.ok(store.listAudit().some((a) => a.action === "task.failure" && a.detail.startsWith("[misalignment]")));
  assert.ok(store.listRouting({ goalId: goal.id }).some((r) => r.failureTag === "misalignment" && r.failureNote));
});

test("failure tags: blocked and needs-input work is tagged spec", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) { a.settings.status = "blocked"; store.saveAgent(a); }
  store.setSettings({ ...store.getSettings(), maxAttempts: 1, maxGoalReplans: 0 });
  const goal = await orch.runGoal(room.id, "blocked goal");
  const log = store.listRouting({ goalId: goal.id });
  assert.ok(log.some((r) => r.outcome === "blocked" && r.failureTag === "spec"));
  assert.ok(store.listAudit().some((a) => a.action === "task.failure" && a.detail.startsWith("[spec]")));
});

test("failure tags: claiming PASS on work a check fails is tagged verification", async () => {
  const { store, orch, room } = setup();
  store.setSettings({ ...store.getSettings(), maxAttempts: 1, autoRunChecks: true, planApproval: "never", maxGoalReplans: 0 });
  const lead = store.getAgent("claude")!; lead.settings.checks = true; store.saveAgent(lead);
  for (const a of store.listAgents()) { a.settings.skipFiles = true; store.saveAgent(a); }
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const first = store.listTasks({ goalId: goal.id }).find((t) => t.title === "Research the topic")!;
  assert.equal(first.failures?.[0]?.tag, "verification");
  assert.ok(store.listRouting({ taskId: first.id }).some((r) => r.failureTag === "verification"));
});

test("failure tags: an honest shortfall takes the judge's category", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) { a.settings.quality = 0.3; a.settings.failureCategory = "spec"; store.saveAgent(a); }
  store.setSettings({ ...store.getSettings(), maxAttempts: 1, maxGoalReplans: 0 });
  const goal = await orch.runGoal(room.id, "vague goal");
  const tags = store.listTasks({ goalId: goal.id }).flatMap((t) => t.failures ?? []).map((f) => f.tag);
  assert.ok(tags.includes("spec"), `got ${tags.join(",")}`);
});
