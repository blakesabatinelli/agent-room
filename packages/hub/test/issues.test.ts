import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig, Approval, Issue, IssuesResponse, RoutingRecord } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { DAY_MS, LONG_WAIT_MS, NEXT_STEP, detectIssues, nextStep, type IssueInput } from "../src/issues/index.js";
import type { ReplyTurn } from "../src/turns/turns.js";
import { setup } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const names: Record<string, string> = { claude: "Claude", codex: "Codex", hermes: "Hermes" };
let n = 0;
const rec = (o: Partial<RoutingRecord> = {}): RoutingRecord => ({
  id: `rt${++n}`, at: NOW - HOUR, completedAt: NOW - HOUR + 1000, roomId: "r1", goalId: "g1", goalText: "g", taskId: "t1", taskTitle: "Research", taskType: "research", kind: "task", attempt: 1, revision: false,
  reason: "learned", epsilon: 0, candidates: [], chosen: "codex", pChosen: 1, outcome: "blocked", failureTag: "placement", failureNote: "blocked by its environment: cannot be created", ...o,
});
const fail = (tag: RoutingRecord["failureTag"], o: Partial<RoutingRecord> = {}) => rec({ failureTag: tag, failureNote: `x: y`, outcome: "revise", ...o });
const turn = (o: Partial<ReplyTurn> = {}): ReplyTurn => ({ id: `turn${++n}`, roomId: "r1", agentId: "codex", kind: "tag", status: "failed", error: "Not signed in", dropped: 0, startedAt: NOW - HOUR, ...o });
const approval = (o: Partial<Approval> = {}): Approval => ({ id: `apr${++n}`, agentId: "claude", roomId: "r1", tool: "gmail", action: "send", detail: "", status: "pending", createdAt: NOW - 3 * HOUR, ...o });
const input = (o: Partial<IssueInput> = {}): IssueInput => ({
  now: NOW, routing: [], turns: [], approvals: [], dismissed: {}, agentName: (id) => names[id] ?? id,
  goalInfo: (id) => ({ text: `Goal ${id}`, roomId: "r1" }), taskInfo: (id) => ({ title: `Task ${id}`, goalId: "g1" }), ...o,
});
const one = (inp: IssueInput, id?: string): Issue => { const r = detectIssues(inp).issues; const x = id ? r.find((i) => i.id === id) : r[0]; assert.ok(x, `an issue ${id ?? ""} (got ${r.map((i) => i.id).join(", ")})`); return x; };

// ---------- grouping

test("issues: a placement block seen four times names the agent and counts, with first and last seen, goals, tasks and one next step", () => {
  const routing = [0, 1, 2, 3].map((i) => rec({ at: NOW - (5 - i) * DAY_MS / 2, completedAt: NOW - (5 - i) * DAY_MS / 2 + 1000, goalId: `g${i % 2}`, taskId: `t${i}` }));
  const i = one(input({ routing }));
  assert.equal(i.id, "placement:agent:codex");
  assert.equal(i.kind, "placement");
  assert.equal(i.title, "Codex blocked by its environment, 4 times this week");
  assert.equal(i.count, 4);
  assert.equal(i.firstSeen, routing[0].completedAt);
  assert.equal(i.lastSeen, routing[3].completedAt);
  assert.deepEqual(i.goals.map((g) => g.id), ["g0", "g1"], "each goal once");
  assert.deepEqual(i.tasks.map((t) => t.id), ["t0", "t1", "t2", "t3"]);
  assert.equal(i.goals[0].text, "Goal g0");
  assert.equal(i.next, "Route this kind of task to an agent on this Mac");
  assert.equal(i.agentId, "codex");
  assert.deepEqual(i.rooms, ["r1"]);
});

test("issues: one occurrence is not an issue; two is", () => {
  assert.deepEqual(detectIssues(input({ routing: [rec()] })).issues, []);
  assert.equal(detectIssues(input({ routing: [rec(), rec()] })).issues.length, 1);
});

test("issues: only the last 7 days count", () => {
  const old = rec({ at: NOW - 8 * DAY_MS, completedAt: NOW - 8 * DAY_MS + 1000 });
  assert.deepEqual(detectIssues(input({ routing: [old, rec()] })).issues, [], "one old and one new is one");
  const edge = rec({ at: NOW - 6.9 * DAY_MS, completedAt: NOW - 6.9 * DAY_MS + 1000 });
  assert.equal(one(input({ routing: [edge, rec()] })).count, 2);
});

test("issues: the same failure tag from the same agent groups; other tags and other agents are separate issues", () => {
  const routing = [fail("spec"), fail("spec"), fail("verification"), fail("verification"), fail("spec", { chosen: "claude", taskType: "writing" })];
  const r = detectIssues(input({ routing })).issues;
  assert.deepEqual(r.map((i) => i.id).sort(), ["failure:spec:agent:codex", "failure:verification:agent:codex"]);
  assert.equal(r.find((i) => i.id === "failure:spec:agent:codex")!.title, "Codex hit unclear instructions, 2 times this week");
  assert.equal(r.find((i) => i.id === "failure:verification:agent:codex")!.title, "Codex said done before it was, 2 times this week");
  assert.equal(r[0].next.length > 0, true);
});

test("issues: the same failure on one kind of task from two agents is an issue for that kind of task; one agent alone is its own issue only", () => {
  const two = detectIssues(input({ routing: [fail("misalignment", { chosen: "codex", taskType: "writing" }), fail("misalignment", { chosen: "claude", taskType: "writing" }), fail("misalignment", { chosen: "hermes", taskType: "coding" })] })).issues;
  assert.deepEqual(two.map((i) => i.id), ["failure:misalignment:type:writing"]);
  assert.equal(two[0].title, "Writing tasks drifted off task, 2 times this week");
  assert.equal(two[0].taskType, "writing");
  const alone = detectIssues(input({ routing: [fail("other", { taskType: "data" }), fail("other", { taskType: "data" })] })).issues;
  assert.deepEqual(alone.map((i) => i.id), ["failure:other:agent:codex"]);
});

test("issues: practice runs, helper runs and attempts that were only a question are not failures", () => {
  const routing = [fail("spec", { kind: "shadow", shadow: true }), fail("spec", { kind: "shadow", shadow: true }), rec({ kind: "subagent", failureTag: undefined, outcome: "run_failed" }), rec({ kind: "subagent", failureTag: undefined, outcome: "run_failed" }), rec({ kind: "direct", outcome: "answered", failureTag: undefined })];
  assert.deepEqual(detectIssues(input({ routing })).issues, []);
});

test("issues: repeated \"couldn't reply\" errors for an agent, from reply turns and from direct answers that failed", () => {
  const i = one(input({ turns: [turn(), turn({ agentId: "claude" })], routing: [rec({ kind: "direct", outcome: "run_failed", failureTag: "other", failureNote: "run error: x", goalId: "gd" })] }));
  assert.equal(i.id, "reply:agent:codex");
  assert.equal(i.title, "Codex couldn't reply, 2 times this week");
  assert.equal(i.next, "Check the agent's sign-in on the Agents page");
  assert.deepEqual(i.goals.map((g) => g.id), ["gd"]);
  assert.equal(detectIssues(input({ turns: [turn({ status: "answered" }), turn({ status: "skipped" })] })).issues.length, 0, "only failed turns");
});

test("issues: a reply turn points at the goal and task its agent was working on", () => {
  const routing = [rec({ id: "run", at: NOW - 2 * HOUR, completedAt: NOW - HOUR / 2, failureTag: undefined, outcome: "accepted", goalId: "gx", taskId: "tx" })];
  const i = one(input({ routing, turns: [turn({ startedAt: NOW - HOUR }), turn({ startedAt: NOW - 3 * DAY_MS })] }));
  assert.deepEqual(i.goals.map((g) => g.id), ["gx"]);
  assert.deepEqual(i.tasks.map((t) => t.id), ["tx"]);
});

test("issues: repeat posts kept out by reply turns count by post, per agent", () => {
  assert.equal(detectIssues(input({ turns: [turn({ status: "answered", dropped: 1 })] })).issues.length, 0, "one repeat is not a pattern");
  const i = one(input({ turns: [turn({ status: "answered", dropped: 2 }), turn({ status: "answered", dropped: 1 }), turn({ status: "answered", dropped: 1, agentId: "claude" })] }));
  assert.equal(i.id, "repeat_post:agent:codex");
  assert.equal(i.count, 3);
  assert.equal(i.title, "Repeat posts from Codex were kept out, 3 times this week");
  assert.equal(i.next, "Tell the agent to post its reply once and then stop");
});

test("issues: approvals left waiting more than an hour, however many", () => {
  const waiting = approval({ createdAt: NOW - 5 * HOUR });
  const one1 = one(input({ approvals: [waiting] }));
  assert.equal(one1.id, "approval_wait");
  assert.equal(one1.title, "An approval waited over an hour for you");
  assert.equal(one1.next, "Open Approvals and decide the ones waiting");
  const many = one(input({ approvals: [waiting, approval({ status: "expired", createdAt: NOW - 2 * DAY_MS, decidedAt: NOW - 2 * DAY_MS + 3 * HOUR }), approval({ status: "approved", createdAt: NOW - DAY_MS, decidedAt: NOW - DAY_MS + 2 * HOUR })] }));
  assert.equal(many.count, 3);
  assert.equal(many.title, "3 approvals waited over an hour for you this week");
  const fine = [approval({ createdAt: NOW - HOUR / 2 }), approval({ status: "approved", createdAt: NOW - 5 * HOUR, decidedAt: NOW - 5 * HOUR + 60_000 }), approval({ status: "approved", auto: true, createdAt: NOW - 5 * HOUR, decidedAt: NOW - 5 * HOUR }),
    approval({ status: "approved", createdAt: NOW - 20 * DAY_MS, decidedAt: NOW - 20 * DAY_MS + 2 * HOUR })];
  assert.deepEqual(detectIssues(input({ approvals: fine })).issues, [], "quick answers, auto approvals and old history are not issues");
  assert.equal(one(input({ approvals: [approval({ createdAt: NOW - 20 * DAY_MS })] })).count, 1, "a card still waiting counts however old it is");
  assert.equal(LONG_WAIT_MS, HOUR);
});

test("issues: a judge whose review could not be read, twice, says to add a second judge", () => {
  const bad = (o: Partial<RoutingRecord> = {}) => fail("other", { failureNote: "quality: The check couldn't be read; please resubmit with the STATUS block.", judgment: { score: 0.5, verdict: "revise", judgeAgentId: "claude" }, chosen: "codex", ...o });
  const r = detectIssues(input({ routing: [bad(), bad()] })).issues;
  assert.deepEqual(r.map((i) => i.id), ["judge:agent:claude"], "not counted against the agent whose work was being judged");
  assert.equal(r[0].title, "Claude's reviews could not be read, 2 times this week");
  assert.equal(r[0].next, "Add a second agent to the judge rotation");
});

test("issues: the next step comes from a small fixed table, in plain words with no em dashes", () => {
  assert.equal(nextStep("placement"), "Route this kind of task to an agent on this Mac");
  assert.equal(nextStep("reply"), "Check the agent's sign-in on the Agents page");
  assert.equal(nextStep("judge"), "Add a second agent to the judge rotation");
  assert.equal(nextStep("failure", "verification"), NEXT_STEP["failure:verification"]);
  assert.equal(nextStep("failure"), NEXT_STEP["failure:other"]);
  for (const [k, v] of Object.entries(NEXT_STEP)) { assert.ok(v.length > 10 && v.length < 110, k); assert.doesNotMatch(v, /—|–/, k); }
  assert.equal(Object.keys(NEXT_STEP).length, 10);
});

test("issues: the biggest comes first, then the most recent", () => {
  const routing = [rec(), rec(), rec(), fail("spec", { at: NOW - 60_000, completedAt: NOW - 30_000 }), fail("spec")];
  assert.deepEqual(detectIssues(input({ routing })).issues.map((i) => i.id), ["placement:agent:codex", "failure:spec:agent:codex"]);
});

test("issues: a room filter keeps only that room's problems", () => {
  const routing = [rec({ roomId: "r1" }), rec({ roomId: "r1" }), rec({ roomId: "r2" })];
  assert.equal(one(input({ routing })).count, 3);
  assert.equal(one(input({ routing, roomId: "r1" })).count, 2);
  assert.deepEqual(detectIssues(input({ routing, roomId: "r3" })).issues, []);
});

// ---------- dismissing

test("issues: a dismissed issue stays gone until it happens again, then comes back marked as back", () => {
  const routing = [rec({ completedAt: NOW - 3 * HOUR }), rec({ completedAt: NOW - 2 * HOUR })];
  const dismissedAt = NOW - HOUR;
  const r = detectIssues(input({ routing, dismissed: { "placement:agent:codex": dismissedAt } }));
  assert.deepEqual(r.issues, []);
  assert.equal(r.dismissed, 1);
  const again = detectIssues(input({ routing: [...routing, rec({ completedAt: NOW - 60_000 })], dismissed: { "placement:agent:codex": dismissedAt } }));
  assert.equal(again.issues.length, 1);
  assert.equal(again.issues[0].reappeared, true);
  assert.equal(again.issues[0].count, 3);
  assert.equal(again.dismissed, 0);
  assert.equal(detectIssues(input({ routing, dismissed: { "something:else": dismissedAt } })).issues[0].reappeared, undefined);
});

// ---------- the same thing from a real hub

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Phone" }) })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const issues = async (q = "") => (await (await fetch(`${base}/issues${q}`, { headers: h })).json()) as IssuesResponse;
  return { ...ctx, app, base, h, issues };
}

test("GET /issues and POST /issues/:id/dismiss: two real goals blocked by where Codex runs, dismissed, then back after a third", async () => {
  const { app, base, h, store, orch, room, issues } = await boot();
  assert.equal((await fetch(`${base}/issues`)).status, 401, "needs a paired device");
  assert.deepEqual(await issues().then((r) => r.issues), [], "nothing yet");
  assert.equal((await fetch(`${base}/issues?roomId=nope`, { headers: h })).status, 404);

  const codex = store.getAgent("codex")!;
  store.saveAgent({ ...codex, settings: { ...codex.settings, blockedText: "Blocked. /tmp/research cannot be created in this environment" } } as AgentConfig);
  for (const a of ["claude", "codex", "hermes"]) store.saveAgent(store.getAgent(a)!);
  const g1 = await orch.runGoal(room.id, "Summarize the venue TV market");
  assert.deepEqual((await issues()).issues, [], "one placement block is not yet a pattern");
  const g2 = await orch.runGoal(room.id, "Summarize the bar TV market");

  const r = await issues();
  const placement = r.issues.find((i) => i.id === "placement:agent:codex")!;
  assert.ok(placement, "the issue is there");
  assert.equal(placement.title, "Codex blocked by its environment, 2 times this week");
  assert.deepEqual(placement.goals.map((g) => g.id).sort(), [g1.id, g2.id].sort(), "links to both traces");
  assert.ok(placement.tasks.every((t) => t.title === "Research the topic"));
  assert.equal(placement.next, "Route this kind of task to an agent on this Mac");
  assert.ok(placement.firstSeen <= placement.lastSeen);
  assert.equal((await issues(`?roomId=${room.id}`)).issues.find((i) => i.id === "placement:agent:codex")!.count, 2);
  const other = store.createRoom("other");
  assert.deepEqual((await issues(`?roomId=${other.id}`)).issues, [], "another room has none");

  // the trace each issue links to is there
  assert.equal((await fetch(`${base}/goals/${placement.goals[0].id}/trace`, { headers: h })).status, 200);

  assert.equal((await fetch(`${base}/issues/${encodeURIComponent("nope:nope")}/dismiss`, { method: "POST", headers: h, body: "{}" })).status, 404);
  const dismiss = await fetch(`${base}/issues/${encodeURIComponent(placement.id)}/dismiss`, { method: "POST", headers: h, body: "{}" });
  assert.equal(dismiss.status, 200);
  assert.ok(store.listAudit().some((a) => a.action === "issue.dismissed" && a.detail === placement.id && a.actor === "owner"), "dismissing is audited");
  const after = await issues();
  assert.ok(!after.issues.some((i) => i.id === placement.id));
  assert.equal(after.dismissed, 1);
  assert.equal((await fetch(`${base}/issues/${encodeURIComponent(placement.id)}/dismiss`, { method: "POST", headers: h, body: "{}" })).status, 404, "already dismissed");

  await sleep(5);
  await orch.runGoal(room.id, "Summarize the pub TV market");
  const back = (await issues()).issues.find((i) => i.id === "placement:agent:codex")!;
  assert.ok(back, "it happened again");
  assert.equal(back.reappeared, true);
  assert.equal(back.count, 3);
  await app.close();
});
