import { test } from "node:test";
import assert from "node:assert/strict";
import { HW, setup } from "./helpers.js";
import { CapacityGovernor } from "../src/capacity/governor.js";
import { extractJson } from "../src/orchestrator/json.js";
import { pickAgent, recordOutcome } from "../src/orchestrator/scoring.js";
import { claudePermissionArgs } from "../src/adapters/claudeCode.js";
import { codexSandboxArgs } from "../src/adapters/codex.js";
import { inbox } from "../src/adapters/mcp.js";

test("goal -> plan -> delegate -> judge -> summary", async () => {
  const { store, orch, room } = setup();
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const tasks = store.listTasks({ goalId: goal.id });
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((t) => t.status === "done" && t.judgment && t.assignee));
  assert.ok(goal.summary?.length);
  const all = store.listMessages(room.id);
  const plan = all.find((m) => m.text.startsWith("Work contract v1"));
  assert.ok(plan?.quiet, "plan is logged quietly, not posted to the conversation");
  assert.ok(all.filter((m) => m.text.includes(" owns ")).every((m) => m.quiet), "routing is quiet");
  assert.ok(all.some((m) => !m.quiet && m.author.kind === "agent" && m.text === goal.summary), "summary is posted by the orchestrating agent");
  assert.ok(!all.some((m) => !m.quiet && m.author.kind === "orchestrator"), "the orchestrator never speaks in the conversation");
  assert.ok(store.listScores().length >= 2, "scores were learned");
});

test("judge never grades its own worker when another judge exists", async () => {
  const { store, orch, room } = setup();
  const goal = await orch.runGoal(room.id, "anything");
  for (const t of store.listTasks({ goalId: goal.id })) assert.notEqual(t.judgment!.judgeAgentId, t.assignee);
});

test("low quality work is sent back, replanned, routed around, then the owner is asked", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) { a.settings.quality = 0.3; store.saveAgent(a); }
  store.setSettings({ ...store.getSettings(), maxAttempts: 2 });
  const goal = await orch.runGoal(room.id, "hard goal");
  assert.equal(goal.status, "paused", "a goal that can't finish stops and asks; it doesn't end quietly");
  assert.ok(goal.state?.waitingOnOwner, "with a question for the owner");
  assert.equal(goal.state?.progress?.goalReplans, 2, "after trying two other routes");
  const tasks = store.listTasks({ goalId: goal.id });
  const first = tasks.find((t) => t.title === "Research the topic")!, second = tasks.find((t) => t.title === "Write the summary")!;
  assert.equal(first.status, "failed");
  assert.equal(first.replans, 1, "two failures trigger a task replan before the goal-level recovery");
  assert.ok(first.history?.some((h) => h.outcome === "replan"));
  assert.equal(first.attempts, 2);
  assert.ok(first.recovered, "the failure was routed around");
  assert.ok(tasks.some((t) => t.origin === "recovery"), "with replacement tasks");
  assert.notEqual(second.status, "done", "work that needed the failed task never pretends to be done");
  assert.ok(store.listMessages(room.id).some((m) => !m.quiet && m.text.startsWith("I need a decision from you")));
});

test("orchestrator keeps shared memory from agent MEMORY lines", async () => {
  const { store, orch, room } = setup();
  await orch.runGoal(room.id, "remember things");
  await new Promise((r) => setTimeout(r, 50));
  const shared = store.listShared(room.id);
  assert.ok(shared.length > 0);
  assert.ok(store.listProposals().every((p) => p.status !== "pending"));
  assert.ok(store.listPrivate("claude").length + store.listPrivate("codex").length + store.listPrivate("hermes").length > 0);
});

test("owner @mention goes straight to the agent", async () => {
  const { store, orch, room } = setup();
  await orch.handleOwnerMessage(room.id, "@codex what do you think?");
  await new Promise((r) => setTimeout(r, 50));
  const last = store.listMessages(room.id).at(-1)!;
  assert.equal(last.author.id, "codex");
  assert.equal(store.listGoals(room.id).length, 0, "no goal created");
});

test("owner notes during a goal are recorded as overrides", async () => {
  const { store, orch, room } = setup();
  orch.setPaused(room.id, true);
  const p = orch.runGoal(room.id, "first goal");
  await new Promise((r) => setTimeout(r, 50));
  await orch.handleOwnerMessage(room.id, "Keep it under 100 words");
  orch.setPaused(room.id, false);
  await p;
  assert.ok(store.listMessages(room.id).some((m) => m.quiet && m.text.includes("amended the work contract")));
  const g = store.listGoals(room.id)[0];
  assert.equal(g.contract?.version, 2, "contract version bumped");
  assert.equal(g.contract?.amendments[0].text, "Keep it under 100 words");
});

test("pause stops new tasks from starting; resume continues", async () => {
  const { store, orch, room } = setup();
  orch.setPaused(room.id, true);
  const p = orch.runGoal(room.id, "paused goal");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(store.listTasks({ roomId: room.id }).every((t) => t.status === "pending"));
  orch.setPaused(room.id, false);
  const g = await p;
  assert.equal(g.status, "done");
});

test("approvals block until the owner decides", async () => {
  const { approvals, store } = setup();
  const pending = approvals.request({ agentId: "claude", tool: "gmail", action: "send", detail: "to x" });
  const a = store.listApprovals("pending")[0];
  approvals.decide(a.id, "approved");
  assert.equal((await pending).status, "approved");
  const expired = await approvals.request({ agentId: "claude", tool: "slack", action: "post", detail: "" });
  assert.equal(expired.status, "expired");
});

test("owner calibration nudges learned score", async () => {
  const { store, orch, room } = setup();
  const g = await orch.runGoal(room.id, "x");
  const t = store.listTasks({ goalId: g.id })[0];
  const before = store.getScore(t.assignee!, t.taskType).quality;
  orch.rateJudgment(t.id, 0);
  assert.ok(store.getScore(t.assignee!, t.taskType).quality < before);
});

test("routing prefers the best learned agent, explores with epsilon", () => {
  const { store } = setup();
  const agents = store.listAgents();
  recordOutcome(store, "codex", "coding", { judgment: { score: 0.95, verdict: "accept", feedback: "", judgeAgentId: "claude" }, seconds: 1, failed: false, revision: false });
  recordOutcome(store, "claude", "coding", { judgment: { score: 0.4, verdict: "revise", feedback: "", judgeAgentId: "codex" }, seconds: 1, failed: false, revision: false });
  recordOutcome(store, "hermes", "coding", { seconds: 1, failed: true, revision: false });
  assert.equal(pickAgent(store, agents, "coding", 0)!.id, "codex");
  const explored = pickAgent(store, agents, "coding", 1, [], () => 0.0);
  assert.ok(explored);
});

test("JSON extraction survives fences and prose", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":{"b":"}"}}\n```'), { a: { b: "}" } });
  assert.equal(extractJson("no json"), null);
});

test("permission mapping for Claude Code and Codex", () => {
  const p = claudePermissionArgs({ web: true, filesystem: false, shell: true, gmail: false, slack: true, drive: false, salesforce: false });
  assert.ok(p.allowed.includes("WebFetch"));
  assert.ok(p.disallowed.includes("Read"));
  assert.ok(!p.allowed.includes("Bash") && !p.disallowed.includes("Bash"), "sensitive+enabled goes to approval prompt");
  assert.ok(p.disallowed.includes("mcp__gmail"));
  assert.deepEqual(codexSandboxArgs({ filesystem: false, shell: false }), ["--sandbox", "read-only"]);
  assert.ok(codexSandboxArgs({ filesystem: true, web: true }).includes("sandbox_workspace_write.network_access=true"));
});

test("a simple question goes straight to one agent: no plan, judge or summary", async () => {
  const { store, orch, room } = setup();
  const goal = await orch.runGoal(room.id, "What is a good name for a bar?");
  assert.equal(goal.status, "done");
  const tasks = store.listTasks({ goalId: goal.id });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].judgment, undefined);
  const visible = store.listMessages(room.id).filter((m) => !m.quiet);
  assert.deepEqual(visible.map((m) => m.author.kind), ["agent"], "only the agent's reply is visible");
});

test("with one connected agent there is no planning round trip", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) if (a.id !== "claude") store.saveAgent({ ...a, enabled: false });
  const goal = await orch.runGoal(room.id, "Write a long multi-part report");
  assert.equal(store.listTasks({ goalId: goal.id }).length, 1);
  assert.ok(!store.listMessages(room.id).some((m) => m.text.startsWith("Plan:")));
  assert.equal(store.listMessages(room.id).filter((m) => !m.quiet).at(-1)?.author.id, "claude");
});

test("agents that aren't connected are never routed work", async () => {
  const { store, orch, room } = setup();
  store.setKV("practice_mode", false);
  // Hermes joins over MCP but hasn't connected; Claude and Codex stay as practice agents.
  const h = store.getAgent("hermes")!; store.saveAgent({ ...h, adapter: "mcp" });
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  assert.ok(store.listTasks({ goalId: goal.id }).every((t) => t.assignee !== "hermes"));
});

test("an MCP agent pulls its assignment and submits the result", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) store.saveAgent({ ...a, enabled: a.id === "hermes", adapter: a.id === "hermes" ? "mcp" : a.adapter });
  inbox.seen("hermes");
  const p = orch.runGoal(room.id, "Draft a tagline");
  const a = await inbox.next("hermes", 2000);
  assert.ok(a?.instructions.includes("Draft a tagline"));
  assert.ok(inbox.submit("hermes", a!.id, "Hermes says: TV that works the room."));
  const goal = await p;
  assert.equal(goal.status, "done");
  assert.ok(store.listMessages(room.id).some((m) => m.author.id === "hermes" && m.text.includes("works the room")));
});

test("quick asks skip planning even with several agents connected", async () => {
  const { store, orch, room } = setup();
  const goal = await orch.runGoal(room.id, "hey, can you give me three bar names");
  assert.equal(store.listTasks({ goalId: goal.id }).length, 1);
  assert.ok(!store.listMessages(room.id).some((m) => m.text.startsWith("Plan:")));
});

test("a direct-message room goes straight to its agent", async () => {
  const { store, orch } = setup();
  const dm = store.dmRoom("codex", "Codex");
  assert.equal(store.dmRoom("codex", "Codex").id, dm.id, "one DM room per agent");
  await orch.handleOwnerMessage(dm.id, "Write a long multi-part report on venue TV");
  for (let i = 0; i < 50 && !store.listMessages(dm.id).some((m) => m.author.id === "codex"); i++) await new Promise((r) => setTimeout(r, 10));
  const visible = store.listMessages(dm.id).filter((m) => !m.quiet);
  assert.deepEqual(visible.map((m) => m.author.id), ["owner", "codex"]);
  assert.equal(store.listGoals(dm.id).length, 0, "no goal or plan is created");
});

test("owner follow-ups during a goal are logged quietly", async () => {
  const { store, orch, room } = setup();
  const p = orch.runGoal(room.id, "Summarize the venue TV market");
  await orch.handleOwnerMessage(room.id, "Keep it under 100 words");
  await p;
  assert.ok(!store.listMessages(room.id).some((m) => !m.quiet && m.author.kind === "orchestrator"));
});

// ---------- assignment, tagging, drift control

const until = async (fn: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 20 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };

test("each task goes to the owner the plan named, under a locked contract with a passing gate", async () => {
  const { store, orch, room } = setup();
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const tasks = store.listTasks({ goalId: goal.id }).sort((a, b) => a.createdAt - b.createdAt);
  assert.ok(tasks.every((t) => t.owner && t.assignee === t.owner), "planned owner did the work");
  assert.notEqual(tasks[0].assignee, tasks[1].assignee, "work is spread as planned");
  assert.equal(goal.contract?.objective, "A short, sourced summary.");
  assert.equal(goal.contract?.version, 1);
  assert.deepEqual(tasks[0].criteria?.map((c) => c.id), ["AC1", "AC2"]);
  assert.equal(goal.state?.gate?.passed, true);
  assert.equal(goal.state?.gate?.lines.length, 3);
  assert.match(goal.summary ?? "", /All 3 checks passed/);
  assert.ok(tasks.every((t) => t.report?.status === "done"));
  assert.ok(!store.listMessages(room.id).some((m) => m.text.includes("STATUS:")), "the status block stays out of the conversation");
});

test("an agent can't post into a room where it holds no work and wasn't tagged", async () => {
  const { orch, room, store } = setup();
  const denied = orch.agentPost({ agentId: "hermes" }, "I'll take this!", room.id);
  assert.equal(denied.ok, false);
  assert.match(denied.why!, /Not your turn/);
  orch.floor.give("hermes", room.id);
  assert.equal(orch.agentPost({ agentId: "hermes" }, "ok now", room.id).ok, true);
  assert.equal(store.listMessages(room.id).at(-1)!.text, "ok now");
});

test("an agent tagging another agent gets an answer from that agent", async () => {
  const { store, orch, room } = setup();
  const a = store.getAgent("claude")!; a.settings.tag = "codex"; store.saveAgent(a);
  await orch.handleOwnerMessage(room.id, "@claude what's the plan?");
  await until(() => store.listMessages(room.id).some((m) => m.author.id === "codex"));
  await orch.idle();
  const msgs = store.listMessages(room.id).filter((m) => !m.quiet);
  const answer = msgs.find((m) => m.author.id === "codex")!;
  assert.match(answer.text, /answer is 42/);
  assert.equal(answer.hop, 1);
  assert.equal(msgs.filter((m) => m.author.id === "claude").length, 1, "the answer doesn't bounce back to the asker");
});

test("agent-to-agent tagging stops at the hop limit and hands back to the owner", async () => {
  const { store, orch, room } = setup();
  store.setSettings({ ...store.getSettings(), maxAgentHops: 0 });
  const a = store.getAgent("claude")!; a.settings.tag = "codex"; store.saveAgent(a);
  await orch.handleOwnerMessage(room.id, "@claude go");
  await until(() => store.listMessages(room.id).some((m) => m.text.includes("Over to you")));
  await orch.idle();
  assert.ok(!store.listMessages(room.id).some((m) => m.author.id === "codex"));
});

test("ask_agent returns the other agent's answer to the asker", async () => {
  const { orch, room, store } = setup();
  orch.floor.give("claude", room.id);
  const ans = await orch.askAgent({ agentId: "claude", roomId: room.id }, "codex", "what's the number?");
  assert.match(ans, /answer is 42/);
  assert.ok(store.listMessages(room.id).some((m) => m.author.id === "claude" && m.text.startsWith("@codex")), "the question is visible in the room");
  assert.match(await orch.askAgent({ agentId: "claude", roomId: room.id }, "claude", "hi"), /can't ask yourself/);
});

test("work outside scope is flagged as drift and sent back", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) { a.settings.outOfScope = "also rewrote the other task"; store.saveAgent(a); }
  store.setSettings({ ...store.getSettings(), maxAttempts: 1 });
  const goal = await orch.runGoal(room.id, "drifty goal");
  const first = store.listTasks({ goalId: goal.id }).sort((a, b) => a.createdAt - b.createdAt)[0];
  assert.ok(first.drift?.some((d) => /outside scope/i.test(d)));
  assert.ok(first.history?.some((h) => h.outcome === "drift"));
  assert.notEqual(goal.status, "done", "drifting work never passes the gate");
});

test("a missing STATUS block alone doesn't fail work the judge verified", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) { a.settings.noReport = true; store.saveAgent(a); }
  const goal = await orch.runGoal(room.id, "Build the summary without blocks");
  assert.equal(goal.status, "done");
  const t = store.listTasks({ goalId: goal.id })[0];
  assert.ok(t.drift?.some((d) => d.startsWith("No STATUS block")), "but it is recorded");
});

test("needs_input pauses the task for the owner; the owner's reply restarts it", async () => {
  const { store, orch, room } = setup();
  const owner = (id: string) => { const a = store.getAgent(id)!; a.settings.status = "needs_input"; store.saveAgent(a); };
  ["claude", "codex", "hermes"].forEach(owner);
  const p = orch.runGoal(room.id, "needs input goal");
  await until(() => store.listTasks({ roomId: room.id }).some((t) => t.status === "waiting"));
  assert.ok(store.listMessages(room.id).some((m) => !m.quiet && /needs your input/.test(m.text)));
  ["claude", "codex", "hermes"].forEach((id) => { const a = store.getAgent(id)!; delete a.settings.status; store.saveAgent(a); });
  await orch.handleOwnerMessage(room.id, "The audience is bar owners.");
  const goal = await p;
  assert.equal(goal.status, "done");
  assert.ok(store.listTasks({ goalId: goal.id }).some((t) => t.history?.some((h) => h.outcome === "needs_input")));
});

test("an MCP agent that never picks up its work loses it", async () => {
  const r = await inbox.enqueue("ghost", { instructions: "x" }, undefined, 60_000, 50);
  assert.equal(r.ok, false);
  assert.match(r.error!, /Didn't pick up/);
});

// ---------- steering while work is running

const slow = (store: ReturnType<typeof setup>["store"], ms = 400) => {
  for (const a of store.listAgents()) { a.settings.delayMs = ms; store.saveAgent(a); }
};
const running = (store: ReturnType<typeof setup>["store"], roomId: string) =>
  store.listTasks({ roomId }).find((t) => t.status === "running");

test("steer: an amendment reaches the agent mid-task through get_updates", async () => {
  const { store, orch, room } = setup();
  slow(store);
  const p = orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => !!running(store, room.id));
  const t = running(store, room.id)!;
  await orch.handleOwnerMessage(room.id, "Keep it under 100 words");
  await until(() => store.listMessages(room.id).some((m) => m.text.startsWith("↪ Passed to")));
  const update = orch.takeUpdates({ agentId: t.assignee!, taskId: t.id });
  assert.match(update, /Keep it under 100 words/);
  assert.match(orch.takeUpdates({ agentId: t.assignee!, taskId: t.id }), /No updates/, "delivered once");
  const goal = await p;
  assert.equal(goal.status, "done");
  assert.equal(goal.contract?.version, 2);
  assert.ok(!store.listTasks({ goalId: goal.id }).some((x) => x.history?.some((h) => h.outcome === "redirect")), "nothing restarted");
});

test("steer: a redirect restarts the running task with the change, without counting a failure", async () => {
  const { store, orch, room } = setup();
  slow(store);
  const p = orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => !!running(store, room.id));
  const t = running(store, room.id)!;
  await orch.handleOwnerMessage(room.id, "Actually, focus on sports bars only.");
  await until(() => store.listMessages(room.id).some((m) => m.text.startsWith("↪ Restarting")));
  const goal = await p;
  assert.equal(goal.status, "done");
  const after = store.getTask(t.id)!;
  assert.ok(after.history?.some((h) => h.outcome === "redirect"));
  assert.equal(after.assignee, t.assignee, "same agent picks it back up");
  assert.equal(after.attempts, 1, "the interrupted run doesn't count as an attempt");
  assert.equal(after.replans ?? 0, 0);
});

test("steer: a side question gets answered without touching the work", async () => {
  const { store, orch, room } = setup();
  slow(store);
  const p = orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => !!running(store, room.id));
  await orch.handleOwnerMessage(room.id, "How's it going?");
  const goal = await p;
  await orch.idle();
  assert.equal(goal.status, "done");
  assert.equal(goal.contract?.version, 1, "the contract wasn't amended");
  const ownerAt = store.listMessages(room.id).find((m) => m.text === "How's it going?")!.createdAt;
  assert.ok(store.listMessages(room.id).some((m) => m.author.kind === "agent" && m.createdAt >= ownerAt && !m.taskId), "someone answered");
});

test("steer: changing direction keeps finished work and replans the rest", async () => {
  const { store, orch, room } = setup();
  slow(store, 150);
  const first = orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => store.listTasks({ roomId: room.id }).some((t) => t.status === "done"));
  await orch.handleOwnerMessage(room.id, "Do a pricing comparison instead.");
  const old = await first;
  assert.equal(store.getGoal(old.id)!.status, "superseded");
  await until(() => store.listGoals(room.id).some((g) => g.id !== old.id && g.status === "done"), 8000);
  const next = store.listGoals(room.id).find((g) => g.id !== old.id)!;
  assert.match(next.text, /Owner changed direction: Do a pricing comparison instead/);
  assert.match(next.text, /Already finished/);
  assert.ok(store.listTasks({ goalId: old.id }).every((t) => t.status === "done" || t.status === "cancelled"));
});

test("steer: /redirect with nothing running says so instead of starting work", async () => {
  const { store, orch, room } = setup();
  await orch.handleOwnerMessage(room.id, "/redirect make it shorter");
  assert.match(store.listMessages(room.id).at(-1)!.text, /Nothing is running/);
  assert.equal(store.listGoals(room.id).length, 0);
});

// ---------- roles with model and effort, plan approval, runnable checks, resume

import { existsSync } from "node:fs";
import { join as pjoin } from "node:path";
import { SUGGESTED_PROFILES } from "@agent-room/shared";
import { MockAdapter } from "../src/adapters/mock.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { Approvals } from "../src/orchestrator/approvals.js";
import { pickProfile } from "../src/orchestrator/contract.js";

const withProfiles = (store: ReturnType<typeof setup>["store"]) => {
  for (const a of store.listAgents()) { a.profiles = SUGGESTED_PROFILES.anthropic; store.saveAgent(a); }
};

test("profiles: each kind of work runs on the profile its role calls for", async () => {
  const { store, orch, room } = setup();
  withProfiles(store);
  MockAdapter.calls.length = 0;
  await orch.runGoal(room.id, "Summarize the venue TV market");
  const calls = MockAdapter.calls;
  const tasks = calls.filter((c) => c.kind === "TASK");
  assert.deepEqual(tasks.map((c) => c.model), ["claude-haiku-5-5", "claude-sonnet-5-5"], "researcher on the cheap tier, worker on the standard tier");
  assert.equal(tasks[1].effort, "high");
  assert.ok(calls.filter((c) => c.kind === "JUDGE").every((c) => c.model === "claude-opus-5-5" && c.effort === "high"), "reviews use the reviewer profile");
  assert.ok(calls.filter((c) => c.kind === "PLAN").every((c) => c.model === "claude-opus-5-5" && c.effort === "medium"), "planning uses the strongest worker");
  assert.ok(calls.filter((c) => c.kind === "MEMORY").every((c) => c.model === "claude-haiku-5-5"), "housekeeping uses the cheapest");
});

test("profiles: an agent without profiles keeps its single model", () => {
  const { store } = setup();
  const a = store.getAgent("codex")!; a.settings.model = "gpt-5.6-luna"; delete a.profiles;
  assert.equal(pickProfile(a, "reviewer").model, "gpt-5.6-luna");
  assert.equal(pickProfile({ ...a, profiles: SUGGESTED_PROFILES.openai }, "worker", 3).model, "gpt-5.6-sol");
});

test("profiles: after two failures the replan escalates the model a tier", async () => {
  const { store, orch, room } = setup();
  withProfiles(store);
  for (const a of store.listAgents()) { a.settings.quality = 0.3; store.saveAgent(a); }
  store.setSettings({ ...store.getSettings(), maxAttempts: 2 });
  MockAdapter.calls.length = 0;
  const goal = await orch.runGoal(room.id, "hard goal");
  const first = store.listTasks({ goalId: goal.id }).sort((a, b) => a.createdAt - b.createdAt)[0];
  assert.equal(first.minTier, 2);
  const i = MockAdapter.calls.findIndex((c) => c.kind === "REPLAN");
  const after = MockAdapter.calls.slice(i).filter((c) => c.kind === "TASK");
  const before = MockAdapter.calls.slice(0, i).filter((c) => c.kind === "TASK");
  assert.ok(before.every((c) => c.model === "claude-haiku-5-5"));
  assert.ok(after.length && after.every((c) => c.model !== "claude-haiku-5-5"), "next attempts run a tier up");
});

test("plan approval: work waits for the owner, who can change the plan and then approve it", async () => {
  const { store, orch, room } = setup();
  store.setSettings({ ...store.getSettings(), planApproval: "always" });
  const p = orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => store.listGoals(room.id)[0]?.status === "awaiting_approval");
  const card = store.listMessages(room.id).find((m) => m.planGoalId)!;
  assert.match(card.text, /Here's the plan/);
  assert.ok(store.listTasks({ roomId: room.id }).every((t) => t.status === "pending" && !t.assignee), "nothing started");

  await orch.handleOwnerMessage(room.id, "Make the summary three bullets");
  await until(() => store.listMessages(room.id).filter((m) => m.planGoalId).length === 2);
  const g = store.listGoals(room.id)[0];
  assert.equal(g.status, "awaiting_approval");
  assert.equal(g.contract?.amendments[0].text, "Make the summary three bullets");
  assert.equal(store.listTasks({ goalId: g.id }).length, 2, "old tasks replaced, not duplicated");

  await orch.handleOwnerMessage(room.id, "looks good");
  const goal = await p;
  assert.equal(goal.status, "done");
  assert.ok(goal.approvedAt);
});

test("plan approval: cancelling starts nothing", async () => {
  const { store, orch, room } = setup();
  store.setSettings({ ...store.getSettings(), planApproval: "always" });
  const p = orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => store.listGoals(room.id)[0]?.status === "awaiting_approval");
  assert.equal(orch.decidePlan(store.listGoals(room.id)[0].id, "cancel").ok, true);
  const goal = await p;
  assert.equal(goal.status, "failed");
  assert.ok(store.listTasks({ goalId: goal.id }).every((t) => t.status === "cancelled" && !t.attempts));
});

test("checks: an approved plan runs its commands in the shared folder, and files flow between tasks", async () => {
  const { store, orch, room } = setup();
  const lead = store.getAgent("claude")!; lead.settings.checks = true; store.saveAgent(lead);
  const p = orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => store.listGoals(room.id)[0]?.status === "awaiting_approval");
  assert.match(store.listMessages(room.id).find((m) => m.planGoalId)!.text, /test -s research.md/, "commands are shown before approval");
  orch.decidePlan(store.listGoals(room.id)[0].id, "approve");
  const goal = await p;
  assert.equal(goal.status, "done");
  assert.ok(existsSync(pjoin(goal.folder!, "research.md")) && existsSync(pjoin(goal.folder!, "summary.md")));
  const tasks = store.listTasks({ goalId: goal.id });
  assert.ok(tasks.every((t) => t.checks?.length && t.checks.every((r) => r.ok)));
  assert.ok(goal.state?.gate?.lines.every((l) => l.verdict === "PASS"));
});

test("checks: a failing command sends the work back without asking a model", async () => {
  const { store, orch, room } = setup();
  store.setSettings({ ...store.getSettings(), maxAttempts: 1, autoRunChecks: true, planApproval: "never", maxGoalReplans: 0 });
  const lead = store.getAgent("claude")!; lead.settings.checks = true; store.saveAgent(lead);
  for (const a of store.listAgents()) { a.settings.skipFiles = true; store.saveAgent(a); }
  MockAdapter.calls.length = 0;
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const first = store.listTasks({ goalId: goal.id }).find((t) => t.title === "Research the topic")!;
  assert.equal(first.status, "failed");
  assert.equal(first.checks?.[0].ok, false);
  assert.match(first.judgment!.feedback, /test -s research.md/);
  assert.equal(first.judgment!.judgeAgentId, "checks");
  assert.equal(MockAdapter.calls.filter((c) => c.kind === "JUDGE").length, 0, "no model call for a failed check");
});

test("checks: commands never run on a plan the owner hasn't approved", async () => {
  const { store, orch, room } = setup();
  store.setSettings({ ...store.getSettings(), planApproval: "never" });
  const lead = store.getAgent("claude")!; lead.settings.checks = true; store.saveAgent(lead);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  assert.ok(store.listTasks({ goalId: goal.id }).every((t) => !t.checks?.length), "judged instead");
  assert.equal(goal.status, "done");
});

test("files: changing a file outside the task's files is flagged as drift", async () => {
  const { store, orch, room } = setup();
  store.setSettings({ ...store.getSettings(), maxAttempts: 1, autoRunChecks: true, planApproval: "never" });
  const lead = store.getAgent("claude")!; lead.settings.checks = true; store.saveAgent(lead);
  store.setSettings({ ...store.getSettings(), maxGoalReplans: 0 });
  for (const a of store.listAgents()) { a.settings.writeOutside = "scratch/notes.txt"; store.saveAgent(a); }
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const first = store.listTasks({ goalId: goal.id }).find((t) => t.title === "Research the topic")!;
  assert.ok(first.drift?.some((d) => d.includes("scratch/notes.txt")));
  assert.notEqual(goal.status, "done");
});

const restart = (store: ReturnType<typeof setup>["store"], dir: string) =>
  new Orchestrator(store, new Approvals(store, 2000), { dataDir: dir, mcpUrl: () => undefined, rand: () => 0.99, governor: new CapacityGovernor(store, HW.large) });

test("resume: work running when the hub stopped is picked up and finished after a restart", async () => {
  const { store, orch, room, dir } = setup();
  slow(store, 300);
  void orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => !!running(store, room.id));
  const t = running(store, room.id)!;
  // simulate the process dying: stop the old orchestrator's loop without letting it tidy up
  (orch as unknown as { running: Map<string, AbortController> }).running.forEach((c) => c.abort());
  await new Promise((r) => setTimeout(r, 50));
  const goalId = t.goalId;
  store.saveTask({ ...store.getTask(t.id)!, status: "running" }); // what the DB holds after a crash

  const next = restart(store, dir);
  const resumed = next.recover();
  assert.equal(resumed.length, 1);
  assert.ok(store.listMessages(room.id).some((m) => /^Picked up where it left off after a restart: \d+ tasks? done, \d+ resumed/.test(m.text) && m.quiet === true));
  await until(() => store.getGoal(goalId)?.status === "done", 8000);
  const after = store.getTask(t.id)!;
  assert.equal(after.status, "done");
  assert.equal(after.assignee, t.assignee, "same agent finishes it");
  assert.ok(after.history?.some((h) => h.note === "interrupted by restart"));
  assert.equal(after.attempts, 1, "the interrupted run doesn't count");
});

test("resume: a plan waiting for approval still waits after a restart", async () => {
  const { store, orch, room, dir } = setup();
  store.setSettings({ ...store.getSettings(), planApproval: "always" });
  void orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => store.listGoals(room.id)[0]?.status === "awaiting_approval");
  (orch as unknown as { running: Map<string, AbortController> }).running.forEach((c) => c.abort());
  const next = restart(store, dir);
  next.recover();
  const g = store.listGoals(room.id)[0];
  assert.equal(g.status, "awaiting_approval");
  next.decidePlan(g.id, "approve");
  await until(() => store.getGoal(g.id)?.status === "done", 8000);
  assert.equal(store.getGoal(g.id)?.status, "done");
});

test("resume: with auto-resume off, interrupted work is closed out instead", async () => {
  const { store, orch, room, dir } = setup();
  slow(store, 300);
  void orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => !!running(store, room.id));
  (orch as unknown as { running: Map<string, AbortController> }).running.forEach((c) => c.abort());
  store.setSettings({ ...store.getSettings(), autoResume: false });
  restart(store, dir).recover();
  const g = store.listGoals(room.id)[0];
  assert.equal(g.status, "failed");
  assert.match(g.summary!, /restart/);
});

test("shell can be set to run without asking, per agent", async () => {
  const tools = { web: true, filesystem: true, shell: true, gmail: false, slack: false, drive: false, salesforce: false };
  assert.ok(!claudePermissionArgs(tools).allowed.includes("Bash"), "by default Bash goes to the approval prompt");
  assert.ok(claudePermissionArgs(tools, undefined, { shell: true }).allowed.includes("Bash"), "auto-approved Bash runs directly");
  const off = claudePermissionArgs({ ...tools, shell: false }, undefined, { shell: true });
  assert.ok(off.disallowed.includes("Bash") && !off.allowed.includes("Bash"), "switching shell off still wins");

  const { store, orch, room } = setup();
  const a = store.getAgent("claude")!;
  store.saveAgent({ ...a, tools: { ...a.tools, shell: true }, autoApprove: { shell: true } });
  const grant = { agentId: "claude", roomId: room.id, taskId: "t", hop: 0, expiresAt: Date.now() + 60_000 };
  const auto = await orch.requestApproval(grant, "shell", "Bash", '{"command":"ls"}');
  assert.equal(auto.status, "approved"); assert.equal(auto.auto, true);
  assert.ok(store.listAudit().some((e) => e.action === "approval.auto"), "auto-approvals are still logged");

  // Other agents, other tools, and a switched-off shell still ask.
  store.saveAgent({ ...store.getAgent("claude")!, tools: { ...a.tools, shell: false }, autoApprove: { shell: true } });
  const asked = orch.requestApproval(grant, "shell", "Bash", "{}");
  const pending = store.listApprovals("pending");
  assert.equal(pending.length, 1, "shell switched off: auto-approve doesn't apply");
  orch["approvals"].decide(pending[0].id, "rejected");
  assert.equal((await asked).status, "rejected");
});

// ---------- orchestration layer: specification, shared state, progress ledger, recovery, verification

import { readFileSync } from "node:fs";
import { coverLeftovers, isTransient, repairDeps, sameFeedback, validatePlan } from "../src/orchestrator/ledger.js";

/** Saving an agent moves it to the end of the list; put the practice planner's order back (codex researches, hermes writes). */
const keepOrder = (store: ReturnType<typeof setup>["store"]) => { for (const id of ["claude", "codex", "hermes"]) store.saveAgent(store.getAgent(id)!); };
/** codex owns the research task; with checks on and no files written, it fails for good. */
const researchFailsForGood = (store: ReturnType<typeof setup>["store"]) => {
  store.setSettings({ ...store.getSettings(), maxAttempts: 1, autoRunChecks: true, planApproval: "never" });
  const lead = store.getAgent("claude")!; lead.settings.checks = true; store.saveAgent(lead);
  const codex = store.getAgent("codex")!; codex.settings.skipFiles = true; store.saveAgent(codex);
  keepOrder(store);
};

test("plan: requirements, shared decisions and the ledger reach every task", async () => {
  const { store, orch, room } = setup();
  MockAdapter.calls.length = 0;
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  assert.deepEqual(goal.contract?.requirements?.map((r) => r.id), ["G1", "G2"], "the request is expanded into numbered requirements");
  assert.ok(goal.contract?.requirements?.every((r) => r.status === "met"), "and the final check marks them met");
  assert.equal(goal.contract?.decisions?.length, 1, "shared choices are decided up front");
  const tasks = store.listTasks({ goalId: goal.id });
  assert.ok(tasks.every((t) => t.output && t.covers?.length), "every task says what it hands back and which requirement it serves");
  const ledger = readFileSync(pjoin(goal.folder!, "LEDGER.md"), "utf8");
  assert.match(ledger, /## Requirements/); assert.match(ledger, /G2 A summary under 200 words/); assert.match(ledger, /Facts are listed as bullets/);
  const work = MockAdapter.calls.filter((c) => c.kind === "TASK");
  assert.ok(work.every((c) => c.prompt.includes("# Where the whole goal stands right now")), "the ledger is recited in every task prompt");
  assert.ok(work.every((c) => c.prompt.indexOf("# Right now") > c.prompt.indexOf("# Rules")), "the current job is restated last, where attention is");
  assert.ok(work.every((c) => c.prompt.includes("Facts are listed as bullets with a source each")), "decisions reach every task");
  assert.equal(MockAdapter.calls.filter((c) => c.kind === "VERIFY").length, 1, "the whole goal is verified once before it's called done");
  assert.match(goal.summary ?? "", /✓ G1/);
});

test("plan: a plan that can't run is sent back to the planner and fixed before work starts", async () => {
  const { store, orch, room } = setup();
  const lead = store.getAgent("claude")!; lead.settings.badPlan = true; store.saveAgent(lead);
  MockAdapter.calls.length = 0;
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const plans = MockAdapter.calls.filter((c) => c.kind === "PLAN");
  assert.equal(plans.length, 2, "one repair round");
  assert.match(plans[1].prompt, /can't run as written/);
  assert.match(plans[1].prompt, /depends on "zz"/, "the planner is told exactly what's wrong");
  assert.equal(goal.status, "done");
});

test("plan checks: cycles, unknown inputs, shared files and uncovered requirements are caught", () => {
  const reqs = [{ id: "G1", text: "a" }, { id: "G2", text: "b" }];
  const ids = new Set(["claude"]);
  const base = (k: string, o: object = {}) => ({ key: k, title: k, description: "A self-contained description of the work.", output: "x.md", criteria: ["c"], covers: ["G1"], ...o });
  const e = validatePlan([base("a", { dependsOn: ["b"], files: ["x.md"] }), base("b", { dependsOn: ["a"], files: ["x.md"] }), base("c", { dependsOn: ["nope"], owner: "ghost", output: "" })], reqs, ids);
  const all = e.join("\n");
  assert.match(all, /circle/); assert.match(all, /both write x\.md/); assert.match(all, /depends on "nope"/);
  assert.match(all, /isn't one of the available agents/); assert.match(all, /doesn't say what it hands back/); assert.match(all, /No task delivers G2/);
  const tasks = [base("a", { dependsOn: ["b"] }), base("b", { dependsOn: ["a", "zz"] })];
  repairDeps(tasks); coverLeftovers(tasks, reqs);
  assert.deepEqual(validatePlan(tasks, reqs, ids), [], "mechanical repair leaves a runnable plan");
});

test("recovery: a task that fails for good is routed around and the goal still finishes", async () => {
  const { store, orch, room } = setup();
  researchFailsForGood(store);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const tasks = store.listTasks({ goalId: goal.id });
  const research = tasks.find((t) => t.title === "Research the topic")!;
  const fix = tasks.find((t) => t.origin === "recovery")!;
  const summary = tasks.find((t) => t.title === "Write the summary")!;
  assert.equal(research.status, "failed"); assert.ok(research.recovered);
  assert.equal(fix.status, "done"); assert.deepEqual(fix.covers, research.covers, "the replacement inherits what the failed task owed");
  assert.ok(summary.dependsOn.includes(fix.id), "dependents wait on the replacement instead of being cancelled");
  assert.equal(summary.status, "done");
  assert.equal(goal.status, "done");
  assert.equal(goal.state?.progress?.goalReplans, 1);
});

test("recovery: when only the owner can unblock it, the goal waits and the reply resumes it", async () => {
  const { store, orch, room } = setup();
  researchFailsForGood(store);
  const lead = store.getAgent("claude")!; lead.settings.recoverAsk = true; store.saveAgent(lead); keepOrder(store);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "paused");
  assert.match(goal.state?.waitingOnOwner ?? "", /Which audience/);
  assert.match(readFileSync(pjoin(goal.folder!, "LEDGER.md"), "utf8"), /Waiting on the owner/);
  lead.settings.recoverAsk = false; store.saveAgent(lead);
  await orch.handleOwnerMessage(room.id, "It's for venue owners");
  await until(() => store.getGoal(goal.id)?.status === "done", 8000);
  const g = store.getGoal(goal.id)!;
  assert.ok(g.contract?.amendments.some((a) => a.text.includes("venue owners")), "the answer becomes part of the contract");
  assert.equal(g.state?.waitingOnOwner, undefined);
});

test("verification: a gap between tasks becomes a fix task before the goal is called done", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) { a.settings.verifyGap = true; store.saveAgent(a); }
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const fix = store.listTasks({ goalId: goal.id }).find((t) => t.origin === "verify");
  assert.ok(fix, "the gap became a task");
  assert.equal(fix!.title, "State the word count"); assert.deepEqual(fix!.covers, ["G2"]); assert.equal(fix!.status, "done");
  assert.equal(goal.state?.progress?.verifyRounds, 2, "re-checked after the fix");
  assert.ok(goal.contract?.requirements?.every((r) => r.status === "met"));
  assert.equal(goal.status, "done");
});

// 1.6 changed this rule: a rate limit used to be retried on the same agent (twice, after a wait); it now moves the task to another agent straight away.
test("retries: a rate limit moves the task to another agent without spending an attempt", async () => {
  const { store, orch, room } = setup();
  MockAdapter.transientSeen.clear();
  const codex = store.getAgent("codex")!; codex.settings.transient = 1; store.saveAgent(codex); keepOrder(store);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const research = store.listTasks({ goalId: goal.id }).find((t) => t.title === "Research the topic")!;
  assert.equal(goal.status, "done");
  assert.notEqual(research.assignee, "codex", "reassigned instead of waiting");
  assert.deepEqual(research.triedBy, ["codex"]);
  assert.equal(research.attempts, 1, "a CLI hiccup isn't a failed attempt");
  assert.ok(store.listMessages(room.id).some((m) => m.text.includes("moving it to another agent")));
});

test("reviews: criteria nobody can verify are escalated once, then flagged instead of looping", async () => {
  const { store, orch, room } = setup();
  for (const id of ["claude", "codex"]) { const a = store.getAgent(id)!; a.settings.unsure = true; store.saveAgent(a); }
  MockAdapter.calls.length = 0;
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const tasks = store.listTasks({ goalId: goal.id }).filter((t) => t.origin === "plan");
  assert.ok(tasks.every((t) => t.status === "done" && t.flagged?.length), "accepted, with the unverifiable criteria flagged");
  assert.ok(tasks.every((t) => t.attempts === 2), "one round asking for evidence, then a second reviewer, no more");
  assert.equal(goal.status, "done");
  assert.ok(goal.state?.gate?.lines.some((l) => l.flagged));
  assert.match(goal.summary ?? "", /couldn't be verified/);
  const firstBack = MockAdapter.calls.filter((c) => c.kind === "TASK")[1];
  assert.match(firstBack.prompt, /Show the evidence for AC1/, "the agent is told what evidence would settle it");
});

test("decisions: a choice one agent makes is passed to every later task", async () => {
  const { store, orch, room } = setup();
  const codex = store.getAgent("codex")!; codex.settings.decide = "Use US spelling; dates as YYYY-MM-DD"; store.saveAgent(codex); keepOrder(store);
  MockAdapter.calls.length = 0;
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  assert.deepEqual(goal.state?.shared?.map((d) => d.text), ["Use US spelling", "dates as YYYY-MM-DD"]);
  const later = MockAdapter.calls.filter((c) => c.kind === "TASK" && c.agentId === "hermes");
  assert.ok(later.length && later.every((c) => c.prompt.includes("Use US spelling (decided in \"Research the topic\")")));
});

test("loop and failure detection helpers", () => {
  assert.ok(sameFeedback("Too thin, add detail.", "too thin; add detail"));
  assert.ok(!sameFeedback("Too thin, add detail.", "Sources are missing for facts 2 and 3."));
  assert.ok(isTransient("Error: 429 rate limit exceeded"));
  assert.ok(isTransient("request timed out after 600s"));
  assert.ok(!isTransient("TypeError: cannot read properties of undefined"));
});

test("resume: a goal waiting on the owner keeps waiting after a restart", async () => {
  const { store, orch, room, dir } = setup();
  researchFailsForGood(store);
  const lead = store.getAgent("claude")!; lead.settings.recoverAsk = true; store.saveAgent(lead); keepOrder(store);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  assert.ok(goal.state?.waitingOnOwner);
  const again = restart(store, dir);
  again.recover();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.getGoal(goal.id)?.status, "paused", "no work runs without the answer");
  assert.ok(store.listMessages(room.id).some((m) => m.text.startsWith("Still waiting on you")));
});

test("agents' MEMORY: lines go to the orchestrator, not into the conversation", async () => {
  const { store, orch, room } = setup();
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");
  const visible = store.listMessages(room.id).filter((m) => !m.quiet && m.author.kind === "agent");
  assert.ok(visible.length);
  assert.ok(visible.every((m) => !/^\s*MEMORY:/im.test(m.text)), "no protocol lines in what the owner reads");
  assert.ok(store.listProposals().length + store.listShared(room.id).length > 0, "but the memory was still proposed");
  assert.equal(goal.status, "done");
});
