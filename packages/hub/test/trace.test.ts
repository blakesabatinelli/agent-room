import { test } from "node:test";
import assert from "node:assert/strict";
import type { Approval, AgentConfig, Goal, GoalTrace, Message, RoutingRecord, Task, TraceEvent } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { buildTrace, EVENT_CAP, type TraceInput } from "../src/trace/index.js";
import type { ReplyTurn } from "../src/turns/turns.js";
import { setup } from "./helpers.js";

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 10_000) => { for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20); };

const names: Record<string, string> = { claude: "Claude", codex: "Codex", hermes: "Hermes", owner: "You" };
const agentName = (id: string) => names[id] ?? id;
const goal = (o: Partial<Goal> = {}): Goal => ({ id: "g1", roomId: "r1", text: "Summarize the venue TV market", status: "done", createdAt: T0, ...o });
const task = (id: string, o: Partial<Task> = {}): Task => ({ id, roomId: "r1", goalId: "g1", title: `Task ${id}`, description: "", taskType: "research", acceptance: "", dependsOn: [], status: "done", attempts: 1, createdAt: T0 + 1, updatedAt: T0 + 1, ...o });
let n = 0;
const rec = (taskId: string, o: Partial<RoutingRecord> = {}): RoutingRecord => ({
  id: `rt${++n}`, at: T0 + MIN, roomId: "r1", goalId: "g1", goalText: "g", taskId, taskTitle: taskId, taskType: "research", kind: "task", attempt: 1, revision: false,
  reason: "learned", epsilon: 0, candidates: [], chosen: "codex", pChosen: 1, outcome: "accepted", ...o,
});
const approval = (id: string, agentId: string, o: Partial<Approval> = {}): Approval => ({ id, agentId, roomId: "r1", tool: "gmail", action: "send", detail: "", status: "approved", createdAt: T0 + MIN, ...o });
const turn = (id: string, agentId: string, o: Partial<ReplyTurn> = {}): ReplyTurn => ({ id, roomId: "r1", agentId, kind: "tag", status: "answered", dropped: 0, startedAt: T0 + MIN, ...o });
const msg = (id: string, taskId: string | undefined, at: number, o: Partial<Message> = {}): Message =>
  ({ id, roomId: "r1", type: "agent", author: { kind: "agent", id: "codex", name: "Codex" }, text: `post ${id}`, mentions: [], createdAt: at, ...(taskId ? { taskId } : {}), ...o });
const input = (o: Partial<TraceInput> = {}): TraceInput => ({ goal: goal(), tasks: [], routing: [], messages: [], approvals: [], turns: [], lessons: [], agentName, now: T0 + 60 * MIN, ...o });
const events = (t: GoalTrace, taskId: string, attempt: number) => t.tasks.find((x) => x.id === taskId)!.attempts[attempt - 1].events;
const kinds = (evs: TraceEvent[]) => evs.map((e) => e.kind);

// ---------- the tree

test("trace: tasks come out in plan order with dependencies first, and cancelled work stays visible", () => {
  const tasks = [
    task("c", { createdAt: T0 + 3, dependsOn: ["b"], title: "Review" }),
    task("a", { createdAt: T0 + 1, title: "Research" }),
    task("b", { createdAt: T0 + 2, dependsOn: ["a"], title: "Write" }),
    task("x", { createdAt: T0 + 2, status: "cancelled", title: "Dropped" }),
  ];
  const t = buildTrace(input({ tasks }));
  assert.deepEqual(t.tasks.map((x) => x.title), ["Research", "Write", "Dropped", "Review"]);
  assert.equal(t.tasks[2].status, "cancelled");
  // created out of order (the table does not keep order), but a task never comes before what it depends on
  const flipped = buildTrace(input({ tasks: [task("b", { createdAt: T0 + 1, dependsOn: ["a"], title: "Write" }), task("a", { createdAt: T0 + 1, title: "Research" })] }));
  assert.deepEqual(flipped.tasks.map((x) => x.title), ["Research", "Write"]);
});

test("trace: an attempt carries agent, model, times, tokens, cost, outcome, failure tag and reason, judge and score, and whether it was accepted or sent back", () => {
  const t1 = task("t1", {
    routingId: "r-ok", judgment: { score: 0.9, verdict: "accept", feedback: "Meets the criteria.", judgeAgentId: "codex,hermes" },
    history: [
      { at: T0 + MIN + 61_500, agentId: "codex", outcome: "blocked", note: "Blocked. /tmp/x cannot be created in this environment" },
      { at: T0 + 4 * MIN, agentId: "claude", outcome: "fail", note: "Too thin, add detail." },
      { at: T0 + 6 * MIN, agentId: "claude", outcome: "ok", note: "90/100" },
    ],
  });
  const routing = [
    rec("t1", { id: "r-block", at: T0 + MIN, completedAt: T0 + MIN + 61_000, seconds: 60, chosen: "codex", modelVersion: "gpt-5.1", usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.0123 }, outcome: "blocked", failureTag: "placement", failureNote: "blocked by its environment: Blocked. /tmp/x cannot be created in this environment" }),
    rec("t1", { id: "r-back", at: T0 + 3 * MIN, completedAt: T0 + 4 * MIN, seconds: 45.5, chosen: "claude", modelRequested: "claude-sonnet", outcome: "revise", judgment: { score: 0.4, verdict: "revise", judgeAgentId: "codex" }, failureTag: "verification", failureNote: "claimed PASS on AC2: Too thin" }),
    rec("t1", { id: "r-ok", at: T0 + 5 * MIN, completedAt: T0 + 6 * MIN, chosen: "claude", revision: true, reason: "revision", outcome: "accepted", judgment: { score: 0.9, verdict: "accept", judgeAgentId: "codex,hermes" } }),
  ];
  const t = buildTrace(input({ tasks: [t1], routing }));
  const [a1, a2, a3] = t.tasks[0].attempts;
  assert.deepEqual(t.tasks[0].attempts.map((a) => a.n), [1, 2, 3]);

  assert.equal(a1.agentName, "Codex");
  assert.equal(a1.model, "gpt-5.1");
  assert.equal(a1.state, "failed");
  assert.equal(a1.seconds, 60);
  assert.equal(a1.tokens, 1500);
  assert.equal(a1.usage?.costUsd, 0.0123);
  assert.equal(a1.failure?.tag, "placement");
  assert.match(a1.failure!.reason, /cannot be created in this environment/);
  assert.match(a1.note!, /cannot be created/, "the task's own log line for the attempt");
  assert.equal(a1.accepted, false);
  assert.equal(a1.judge, undefined, "work that was never judged has no judge");

  assert.equal(a2.state, "sent_back");
  assert.equal(a2.sentBack, "revise");
  assert.equal(a2.model, "claude-sonnet", "the model asked for, when the CLI did not say which ran");
  assert.deepEqual(a2.judge, { agentIds: ["codex"], names: ["Codex"], score: 0.4, verdict: "revise" });
  assert.equal(a2.failure?.tag, "verification");
  assert.equal(a2.tokens, undefined, "no tokens were reported, none are made up");
  assert.equal(a2.usage, undefined);

  assert.equal(a3.state, "ok");
  assert.equal(a3.accepted, true);
  assert.equal(a3.revision, true);
  assert.equal(a3.seconds, 60, "from the start and end when the run's own seconds were not kept");
  assert.deepEqual(a3.judge?.names, ["Codex", "Hermes"], "a jury lists every judge");
  assert.equal(a3.judge?.feedback, "Meets the criteria.");
  assert.equal(a3.note, "90/100");
});

test("trace: approvals, reply turns and posts land in the attempt that was running, in time order", () => {
  const tasks = [task("t1", { routingId: "r2" })];
  const routing = [
    rec("t1", { id: "r1", at: T0 + MIN, completedAt: T0 + 3 * MIN, chosen: "codex", outcome: "revise" }),
    rec("t1", { id: "r2", at: T0 + 4 * MIN, completedAt: T0 + 8 * MIN, chosen: "codex", outcome: "accepted" }),
  ];
  const t = buildTrace(input({
    tasks, routing,
    approvals: [
      approval("a-late", "codex", { createdAt: T0 + 6 * MIN, decidedAt: T0 + 7 * MIN }),
      approval("a-early", "codex", { createdAt: T0 + 2 * MIN, decidedAt: T0 + 2 * MIN + 30_000 }),
      approval("a-auto", "codex", { createdAt: T0 + 5 * MIN, decidedAt: T0 + 5 * MIN, auto: true }),
      approval("a-other-agent", "hermes", { createdAt: T0 + 2 * MIN }),
      approval("a-other-room", "codex", { createdAt: T0 + 2 * MIN, roomId: "r2" }),
    ],
    turns: [turn("turn1", "codex", { startedAt: T0 + 5 * MIN + 10_000, endedAt: T0 + 5 * MIN + 20_000, via: "post", dropped: 1 }), turn("turn-elsewhere", "claude", { startedAt: T0 + 5 * MIN })],
    messages: [
      msg("m-run", "t1", T0 + 2 * MIN + 5_000),
      msg("m-judge-note", "t1", T0 + 3 * MIN + 400, { quiet: true, type: "task_update", author: { kind: "orchestrator", id: "orchestrator", name: "Orchestrator" }, text: "Checked: 40/100, revise." }),
      msg("m-second", "t1", T0 + 7 * MIN),
      msg("m-no-task", undefined, T0 + 2 * MIN),
      msg("m-other-task", "zz", T0 + 2 * MIN),
    ],
  }));
  assert.deepEqual(events(t, "t1", 1).map((e) => e.kind === "approval" ? e.id : e.kind === "post" ? e.id : e.id), ["a-early", "m-run", "m-judge-note"]);
  assert.deepEqual(events(t, "t1", 2).map((e) => e.id), ["a-auto", "turn1", "a-late", "m-second"]);
  const late = events(t, "t1", 2).find((e) => e.id === "a-late");
  assert.equal(late?.kind === "approval" && late.waitSeconds, 60, "how long the owner took");
  const auto = events(t, "t1", 2).find((e) => e.id === "a-auto");
  assert.ok(auto?.kind === "approval" && auto.auto);
  const tn = events(t, "t1", 2).find((e) => e.id === "turn1");
  assert.ok(tn?.kind === "turn" && tn.dropped === 1 && tn.via === "post");
  const note = events(t, "t1", 1).find((e) => e.id === "m-judge-note");
  assert.ok(note?.kind === "post" && note.quiet && note.author === "Orchestrator", "the judge's line after the run belongs to the attempt it judged");
  const all = [...events(t, "t1", 1), ...events(t, "t1", 2), ...t.loose].map((e) => e.id);
  for (const stray of ["a-other-agent", "a-other-room", "turn-elsewhere", "m-no-task", "m-other-task"]) assert.ok(!all.includes(stray), `${stray} is not part of this goal's trace`);
  for (const a of t.tasks[0].attempts) assert.deepEqual([...a.events].sort((x, y) => x.at - y.at), a.events);
});

test("trace: an approval or reply with no running attempt still shows, in the goal's own list, when the agent works on this goal", () => {
  const routing = [rec("t1", { at: T0 + MIN, completedAt: T0 + 2 * MIN, chosen: "codex" })];
  const t = buildTrace(input({ goal: goal({ status: "running" }), tasks: [task("t1")], routing, approvals: [approval("a-gap", "codex", { createdAt: T0 + 30 * MIN })], turns: [turn("tg", "codex", { startedAt: T0 + 20 * MIN })] }));
  assert.deepEqual(t.loose.map((e) => e.id), ["tg", "a-gap"]);
  assert.equal(t.summary.approvals.total, 1);
});

test("trace: helpers sit under their parent task and the parent's attempt, with their own attempts and events", () => {
  const parent = task("p", { routingId: "rp2" });
  const helper = task("h1", { kind: "subagent", parentTaskId: "p", spawnedBy: "codex", depth: 1, readOnly: true, createdAt: T0 + 5 * MIN, title: "Look up sources" });
  const native = task("h2", { kind: "subagent", native: true, parentTaskId: "p", spawnedBy: "codex", depth: 1, createdAt: T0 + 6 * MIN, title: "Built-in search" });
  const grand = task("h3", { kind: "subagent", parentTaskId: "h1", spawnedBy: "hermes", depth: 2, createdAt: T0 + 5 * MIN + 10_000, title: "Check one page" });
  const routing = [
    rec("p", { id: "rp1", at: T0 + MIN, completedAt: T0 + 3 * MIN, outcome: "revise" }),
    rec("p", { id: "rp2", at: T0 + 4 * MIN, completedAt: T0 + 9 * MIN }),
    rec("h1", { id: "rh1", kind: "subagent", reason: "subagent", at: T0 + 5 * MIN, completedAt: T0 + 6 * MIN, chosen: "hermes", outcome: "answered" }),
    rec("h3", { id: "rh3", kind: "subagent", reason: "subagent", at: T0 + 5 * MIN + 10_000, completedAt: T0 + 5 * MIN + 40_000, chosen: "claude", outcome: "answered" }),
  ];
  const t = buildTrace(input({ tasks: [grand, native, parent, helper], routing, approvals: [approval("ah", "hermes", { createdAt: T0 + 5 * MIN + 20_000 })] }));
  assert.equal(t.tasks.length, 1, "helpers are not planned tasks");
  const p = t.tasks[0];
  assert.deepEqual(p.helpers.map((h) => h.title), ["Look up sources", "Built-in search"]);
  assert.deepEqual(p.helpers.map((h) => h.parentAttempt), [2, 2], "started during the parent's second attempt");
  assert.equal(p.helpers[0].helper, true);
  assert.equal(p.helpers[0].readOnly, true);
  assert.equal(p.helpers[0].assigneeName, "Codex", "who launched it, when nobody was assigned");
  assert.equal(p.helpers[1].native, true);
  assert.equal(p.helpers[1].attempts.length, 0, "a built-in helper has no routing record");
  assert.equal(p.helpers[0].helpers[0].title, "Check one page");
  assert.equal(p.helpers[0].attempts[0].agentName, "Hermes");
  assert.deepEqual(p.helpers[0].attempts[0].events.map((e) => e.id), ["ah"], "an approval goes to the helper's attempt, the innermost one");
  assert.equal(t.summary.helpers, 3);
  assert.equal(t.summary.attempts, 2, "helpers' runs are not counted as the task's attempts");
  assert.equal(t.summary.tasksTotal, 1);
});

test("trace: the summary counts tasks, attempts, failures by tag, time and approvals", () => {
  const tasks = [task("a", { createdAt: T0 + 1, status: "done" }), task("b", { createdAt: T0 + 2, status: "failed", dependsOn: ["a"] }), task("c", { createdAt: T0 + 3, status: "pending", dependsOn: ["b"] })];
  const routing = [
    rec("a", { at: T0 + MIN, completedAt: T0 + 2 * MIN, seconds: 50, outcome: "blocked", failureTag: "placement", failureNote: "x", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } }),
    rec("a", { at: T0 + 3 * MIN, completedAt: T0 + 4 * MIN, seconds: 40, outcome: "accepted", usage: { inputTokens: 20, outputTokens: 5, costUsd: 0.25 } }),
    rec("b", { at: T0 + 5 * MIN, completedAt: T0 + 6 * MIN, seconds: 30, outcome: "revise", failureTag: "spec", failureNote: "y" }),
    rec("b", { at: T0 + 7 * MIN, completedAt: T0 + 20 * MIN, seconds: 20, outcome: "reassign", failureTag: "spec", failureNote: "z" }),
    rec("b", { at: T0 + 21 * MIN, completedAt: T0 + 22 * MIN, seconds: 10, outcome: "run_failed", failureTag: "other", failureNote: "run error" }),
    rec("a", { kind: "shadow", shadow: true, at: T0 + 9 * MIN, completedAt: T0 + 10 * MIN, outcome: "accepted", seconds: 999 }),
  ];
  const t = buildTrace(input({ tasks, routing, approvals: [approval("p1", "codex", { createdAt: T0 + 5 * MIN + 5000, status: "pending" }), approval("p2", "codex", { createdAt: T0 + 3 * MIN + 5000, auto: true })] }));
  const s = t.summary;
  assert.deepEqual([s.tasksDone, s.tasksTotal], [1, 3]);
  assert.equal(s.attempts, 5, "practice runs by an agent on probation are left out");
  assert.equal(s.sentBack, 2);
  assert.deepEqual(s.failures, { placement: 1, spec: 2, other: 1 });
  assert.equal(s.failureTotal, 4);
  assert.equal(s.workSeconds, 150);
  assert.equal(s.elapsedSeconds, 22 * 60, "goal start to its last activity");
  assert.deepEqual(s.approvals, { total: 2, pending: 1, auto: 1 });
  assert.equal(s.tokens, 40);
  assert.equal(s.costUsd, 0.75);
  const live = buildTrace(input({ goal: goal({ status: "running" }), tasks, routing }));
  assert.equal(live.summary.elapsedSeconds, 60 * 60, "a goal still running counts to now");
});

test("trace: tokens and cost are left out when nothing recorded them", () => {
  const t = buildTrace(input({ tasks: [task("a")], routing: [rec("a", { seconds: 5 })] }));
  assert.equal("tokens" in t.summary, false);
  assert.equal("costUsd" in t.summary, false);
  assert.equal("tokens" in t.tasks[0].attempts[0], false);
});

test("trace: a run left open by a hub that stopped is shown as stopped, a live one as running", () => {
  const live = task("a", { status: "running", routingId: "open1" });
  const dead = task("b", { status: "failed", routingId: "other" });
  const t = buildTrace(input({ goal: goal({ status: "running" }), tasks: [live, dead], routing: [rec("a", { id: "open1", outcome: "pending" }), rec("b", { id: "open2", outcome: "pending" })] }));
  assert.equal(t.tasks[0].attempts[0].state, "running");
  assert.equal(t.tasks[1].attempts[0].state, "stopped");
  assert.equal(t.tasks[0].attempts[0].endedAt, undefined);
});

test("trace: the plan shows its version, who approved it and when, and what the owner changed", () => {
  const contract = { objective: "Do it", constraints: [], deliverables: [], outOfScope: [], version: 3, lockedAt: T0 + 1000, amendments: [{ at: T0 + 2000, text: "Make it three bullets" }],
    requirements: [{ id: "G1", text: "A summary", status: "met" as const }, { id: "G2", text: "Sources" }] };
  const state = { nextAction: "", decisions: [
    { at: T0 + 1000, text: "Plan written: 2 tasks for 2 requirements." }, { at: T0 + 1500, text: "Owner asked for plan changes: Make it three bullets" },
    { at: T0 + 3000, text: "Owner approved the plan." }, { at: T0 + 4000, text: "\"Research\" accepted from Codex." } ] };
  const approved = buildTrace(input({ goal: goal({ contract, state, approvedAt: T0 + 3000 }) })).plan;
  assert.equal(approved.version, 3);
  assert.deepEqual(approved.approval, { state: "approved", at: T0 + 3000 });
  assert.deepEqual(approved.amendments, [{ at: T0 + 2000, text: "Make it three bullets" }]);
  assert.deepEqual(approved.steps.map((s) => s.text.split(":")[0]), ["Plan written", "Owner asked for plan changes", "Owner approved the plan."], "only plan events");
  assert.deepEqual(approved.requirements.map((r) => [r.id, r.status]), [["G1", "met"], ["G2", "open"]]);
  assert.equal(buildTrace(input({ goal: goal({ contract, status: "awaiting_approval" }), tasks: [task("a")] })).plan.approval.state, "waiting");
  assert.equal(buildTrace(input({ goal: goal({ status: "planning" }) })).plan.approval.state, "planning");
  assert.equal(buildTrace(input({ goal: goal({ status: "failed", summary: "Plan cancelled by owner." }) })).plan.approval.state, "cancelled");
  assert.equal(buildTrace(input({ goal: goal({ contract }), tasks: [task("a")] })).plan.approval.state, "not_needed", "a small plan that needed no approval says so");
});

test("trace: a busy attempt keeps its approvals and replies, and drops the quiet work-log lines first", () => {
  const msgs = Array.from({ length: EVENT_CAP + 10 }, (_, i) => msg(`q${i}`, "a", T0 + MIN + 1000 + i, { quiet: true }));
  const t = buildTrace(input({ tasks: [task("a")], routing: [rec("a", { at: T0 + MIN, completedAt: T0 + 5 * MIN })], messages: [...msgs, msg("loud", "a", T0 + 2 * MIN)], approvals: [approval("ap", "codex", { createdAt: T0 + 2 * MIN })] }));
  const a = t.tasks[0].attempts[0];
  assert.equal(a.events.length, EVENT_CAP);
  assert.equal(a.hidden, 12);
  assert.ok(a.events.some((e) => e.id === "ap") && a.events.some((e) => e.id === "loud"));
  assert.ok(a.events.filter((e) => e.kind === "post" && e.quiet).length < EVENT_CAP - 1);
});

test("trace: long text is cut short and lessons from the retro are listed with agent names", () => {
  const t = buildTrace(input({ tasks: [task("a")], routing: [rec("a")], messages: [msg("long", "a", T0 + 2 * MIN, { text: `${"word ".repeat(200)}\n\nend` })], lessons: [{ id: "l1", agentId: "codex", taskType: "research", text: "Cite each fact.", at: T0 + 30 * MIN }] }));
  const p = events(t, "a", 1)[0];
  assert.ok(p.kind === "post" && p.text.length <= 240 && p.text.endsWith("…") && !p.text.includes("\n"));
  assert.deepEqual(t.lessons.map((l) => [l.agentName, l.text]), [["Codex", "Cite each fact."]]);
});

// ---------- the same thing from a real hub: mock agents, the HTTP route

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Phone" }) })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { ...ctx, app, base, h };
}
const keepOrder = (store: ReturnType<typeof setup>["store"]) => { for (const a of ["claude", "codex", "hermes"]) store.saveAgent(store.getAgent(a)!); };
const tune = (store: ReturnType<typeof setup>["store"], id: string, settings: Record<string, unknown>) => { const a = store.getAgent(id)!; store.saveAgent({ ...a, settings: { ...a.settings, ...settings } } as AgentConfig); keepOrder(store); };

test("GET /goals/:id/trace: a real goal with mock agents, an approved plan, a placement failure, and an approval card", async () => {
  const { app, base, h, store, orch, approvals, room } = await boot();
  assert.equal((await fetch(`${base}/goals/nope/trace`)).status, 401, "needs a paired device");
  assert.equal((await fetch(`${base}/goals/nope/trace`, { headers: h })).status, 404);

  tune(store, "codex", { blockedText: "Blocked. /tmp/research cannot be created in this environment", delayMs: 150 }); // owns "Research the topic"
  tune(store, "claude", { delayMs: 150 });
  tune(store, "hermes", { delayMs: 150 });
  store.setSettings({ ...store.getSettings(), planApproval: "always" });
  const run = orch.runGoal(room.id, "Summarize the venue TV market");
  await until(() => store.listGoals(room.id)[0]?.status === "awaiting_approval");
  orch.decidePlan(store.listGoals(room.id)[0].id, "approve");
  // an agent asks the owner for something while its task runs
  await until(() => store.listTasks({ roomId: room.id }).some((t) => t.status === "running" && t.title === "Write the summary"));
  const writer = store.listTasks({ roomId: room.id }).find((t) => t.title === "Write the summary")!;
  const asked = approvals.request({ agentId: writer.assignee!, roomId: room.id, tool: "gmail", action: "send summary", detail: "to the team" });
  await sleep(30);
  approvals.decide(store.listApprovals("pending")[0].id, "approved");
  await asked;
  const done = await run;
  assert.equal(done.status, "done");

  const trace = (await (await fetch(`${base}/goals/${done.id}/trace`, { headers: h })).json()) as GoalTrace;
  assert.equal(trace.goal.id, done.id);
  assert.equal(trace.plan.approval.state, "approved");
  assert.deepEqual(trace.tasks.map((t) => t.title), ["Research the topic", "Write the summary"], "plan order");
  const [research, write] = trace.tasks;
  assert.equal(research.status, "done");
  assert.equal(research.attempts[0].agentId, "codex");
  assert.equal(research.attempts[0].state, "failed");
  assert.equal(research.attempts[0].failure?.tag, "placement");
  assert.match(research.attempts[0].failure!.reason, /cannot be created in this environment/);
  const last = research.attempts[research.attempts.length - 1];
  assert.equal(last.state, "ok");
  assert.notEqual(last.agentId, "codex", "the task moved to an agent that could do it");
  assert.ok(last.judge && last.judge.names.length && last.judge.score > 0, "judge and score");
  const card = write.attempts.flatMap((a) => a.events).find((e) => e.kind === "approval");
  assert.ok(card && card.kind === "approval" && card.status === "approved" && card.tool === "gmail", "the approval card is on the attempt that asked");
  assert.deepEqual(trace.summary.approvals, { total: 1, pending: 0, auto: 0 });
  assert.equal(trace.summary.tasksDone, 2);
  assert.equal(trace.summary.tasksTotal, 2);
  assert.equal(trace.summary.failures.placement, 1);
  assert.ok(trace.summary.attempts >= 3);
  assert.ok(trace.summary.elapsedSeconds >= 0);
  for (const t of trace.tasks) for (const a of t.attempts) assert.ok(a.events.every((e, i, all) => i === 0 || all[i - 1].at <= e.at), "ordered by time");
  assert.ok(trace.tasks.every((t) => t.attempts.every((a) => a.at > 0 && a.agentName)));
  await app.close();
});

test("GET /goals/:id/trace: a send-back shows as a send-back and the retry as accepted", async () => {
  const { app, base, h, store, orch, room } = await boot();
  // both possible judges can't verify anything: the first review sends the work back for evidence, then two reviewers who still can't tell accept it and flag it
  tune(store, "claude", { unsure: true });
  tune(store, "codex", { unsure: true });
  const done = await orch.runGoal(room.id, "Summarize the venue TV market");
  const trace = (await (await fetch(`${base}/goals/${done.id}/trace`, { headers: h })).json()) as GoalTrace;
  const sentBack = trace.tasks.flatMap((t) => t.attempts).filter((a) => a.state === "sent_back");
  assert.ok(sentBack.length >= 1, "at least one attempt was sent back");
  assert.ok(sentBack.every((a) => a.sentBack === "revise" && a.accepted === false && a.judge && a.judge.verdict === "revise"));
  for (const t of trace.tasks) {
    const acc = t.attempts[t.attempts.length - 1];
    assert.equal(acc.accepted, true, `${t.title} ends accepted`);
    assert.ok(t.attempts.length >= 2 && t.attempts[0].state === "sent_back", `${t.title} took a second attempt`);
    assert.equal(acc.revision, true, "the retry is a revision");
  }
  assert.equal(trace.summary.sentBack, sentBack.length);
  await app.close();
});
