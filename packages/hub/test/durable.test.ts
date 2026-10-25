import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GoalStep, GoalStepKind, Task } from "@agent-room/shared";
import { HW, setup } from "./helpers.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { CapacityGovernor } from "../src/capacity/governor.js";
import { Approvals } from "../src/orchestrator/approvals.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { appendStep, currentRound, listSteps, planResume } from "../src/durable/index.js";

/**
 * Durable goals. A restart is simulated the way a dying hub leaves things: the first orchestrator is stopped dead at a chosen step (the step has been
 * written, nothing after it has happened), and a second Orchestrator is built on the same Store and data folder and recover()s. Mock agents only.
 */

type Env = ReturnType<typeof setup>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20); };

const RESEARCH = "Research the topic", SUMMARY = "Write the summary";

class Crash extends Error {}
/** Stop `orch` right after it writes the first step that matches: the step is on disk, the change it describes is as far as it got. Resolves with the step. */
function crashAfter(orch: Orchestrator, match: (s: GoalStep, tasks: Map<string, string>) => boolean, env: Env): Promise<GoalStep> {
  return new Promise((resolve) => {
    orch.durable.afterStep = (s) => {
      const titles = new Map(env.store.listTasks({ roomId: env.room.id }).map((t) => [t.id, t.title]));
      if (!match(s, titles)) return;
      orch.durable.afterStep = undefined;
      resolve(s);
      throw new Crash(s.kind);
    };
  });
}
const at = (kind: GoalStepKind, title?: string) => (s: GoalStep, titles: Map<string, string>) => s.kind === kind && (!title || titles.get(s.taskId ?? "") === title);
/** Start a goal on `orch`; its loop dies with the crash. */
const start = (env: Env, orch: Orchestrator = env.orch) => orch.runGoal(env.room.id, "Summarize the venue TV market").catch((e) => { if (!(e instanceof Crash)) throw e; });
/** The process is gone: nothing the old orchestrator had running goes on. */
const die = async (orch: Orchestrator) => { (orch as unknown as { running: Map<string, AbortController> }).running.forEach((c) => c.abort()); await sleep(60); };
/** What main.ts does on start: a new orchestrator on the same store and data folder, prune, recover. */
async function restart(env: Env) {
  const next = new Orchestrator(env.store, new Approvals(env.store, 2000), { dataDir: env.dir, mcpUrl: () => undefined, rand: () => 0.99, retryDelayMs: 1, libraryDir: join(env.dir, "Library"), governor: new CapacityGovernor(env.store, HW.large) });
  await next.pruneWorktrees();
  return next;
}

const goalOf = (e: Env) => e.store.listGoals(e.room.id)[0];
const taskOf = (e: Env, title: string): Task => e.store.listTasks({ goalId: goalOf(e).id }).find((t) => t.title === title)!;
const kinds = (e: Env, title: string) => listSteps(e.store, goalOf(e).id, taskOf(e, title).id).map((s) => s.kind);
const count = (xs: string[], k: string) => xs.filter((x) => x === k).length;
/** How many times an agent was asked to do this task / to judge it (MockAdapter keeps every call). */
const ran = (title: string) => MockAdapter.calls.filter((c) => c.prompt.includes(`# Your task: ${title}`)).length;
const judged = (title: string) => MockAdapter.calls.filter((c) => c.prompt.includes("[[JUDGE]]") && c.prompt.includes(title)).length;
const planned = () => MockAdapter.calls.filter((c) => c.prompt.includes("[[PLAN]]")).length;
const lines = (e: Env) => e.store.listMessages(e.room.id).filter((m) => m.text.startsWith("Picked up where it left off after a restart"));
const replies = (e: Env, title: string) => e.store.listMessages(e.room.id).filter((m) => m.taskId === taskOf(e, title).id && m.author.kind === "agent");
const slow = (e: Env, ms: number) => { for (const a of e.store.listAgents()) { a.settings.delayMs = ms; e.store.saveAgent(a); } };
/** Agents write real files and the plan carries runnable checks, so accepted work is merged into the goal folder for real. */
function withFiles(e: Env) {
  for (const a of e.store.listAgents()) { a.settings.checks = true; e.store.saveAgent(a); }
  e.store.setSettings({ ...e.store.getSettings(), planApproval: "never", autoRunChecks: true });
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
/** Commits on the goal folder that carry this task's work (one per accepted task; a second merge of it would show here or as a merge commit). */
const commitsFor = (e: Env, title: string) => git(goalOf(e).folder!, "log", "--format=%s").split("\n").filter((s) => s === `Task: ${title}` || s === `Merge task: ${title}`).length;
const mergeAudits = (e: Env, title: string) => e.store.listAudit().filter((a) => a.action === "worktree.merge" && a.detail.startsWith(`"${title}"`)).length;

/** Finish the goal on the restarted hub and check the things every restart must keep true. */
async function finish(e: Env, next: Orchestrator) {
  const goalId = goalOf(e).id;
  await until(() => e.store.getGoal(goalId)?.status === "done");
  await next.idle();
  assert.equal(e.store.getGoal(goalId)?.status, "done");
  for (const t of e.store.listTasks({ goalId })) assert.equal(t.status, "done");
  const log = listSteps(e.store, goalId);
  assert.equal(log.at(-1)?.kind === "goal_done" || log.some((s) => s.kind === "goal_done"), true, "the goal's end is logged");
  assert.equal(count(log.map((s) => s.kind), "goal_done"), 1);
}

test("the step log: every step of a goal that never restarts is written, in order, before it is done", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  withFiles(e);
  const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const all = listSteps(e.store, goal.id);
  assert.deepEqual(all.filter((s) => !s.taskId).map((s) => s.kind), ["plan_made", "goal_done"]);
  for (const title of [RESEARCH, SUMMARY]) assert.deepEqual(kinds(e, title), ["task_assigned", "run_started", "run_finished", "judged", "accepted", "merged"], title);
  assert.ok(all.every((s, i) => i === 0 || s.seq > all[i - 1].seq && s.at >= all[i - 1].at), "oldest first");
  const finished = all.find((s) => s.kind === "run_finished")!;
  assert.equal(typeof finished.data.text, "string", "the reply is kept, so a restart can judge it without asking again");
  assert.ok(Array.isArray(finished.data.changed));
  assert.equal(finished.round, 1);
  assert.equal(lines(e).length, 0, "no restart, no resume line");
});

test("replays: the same step of the same run is written once; the answer for a log is the same every time", () => {
  const e = setup();
  const g = "goal_x", t = "task_x";
  const first = appendStep(e.store, { goalId: g, taskId: t, kind: "run_started", data: { agentId: "claude" } });
  assert.equal(first?.round, 1);
  assert.ok(appendStep(e.store, { goalId: g, taskId: t, kind: "run_finished", data: { text: "x", changed: [] } }));
  assert.equal(appendStep(e.store, { goalId: g, taskId: t, kind: "run_finished", data: { text: "again" } }), undefined, "a step can't be applied twice");
  assert.equal(listSteps(e.store, g, t).filter((s) => s.kind === "run_finished").length, 1);
  assert.equal((listSteps(e.store, g, t).find((s) => s.kind === "run_finished")!.data as { text: string }).text, "x", "the first write stands");
  assert.equal(appendStep(e.store, { goalId: g, taskId: t, kind: "run_started" })?.round, 2, "a new run is a new round, so its steps are new too");
  assert.equal(currentRound(e.store, t), 2);
  assert.ok(appendStep(e.store, { goalId: g, taskId: t, kind: "run_finished", data: { text: "second run", changed: [] } }));
  // planResume only reads
  const steps = listSteps(e.store, g, t);
  const a = planResume(steps, { status: "review" }), b = planResume(steps, { status: "review" });
  assert.deepEqual(a, b);
  assert.equal(a?.action, "judge");
  assert.equal(planResume(steps, { status: "done" }), undefined, "accepted work is never touched");
  assert.equal(planResume(steps, { status: "revising" }), undefined);
  assert.equal(planResume(steps, { status: "running" })?.action, "interrupt", "a task whose row says it was still running was cut off mid-run");
});

test("restart after planning: the plan is kept, nothing is planned again, each task runs once", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  const crashed = crashAfter(e.orch, at("plan_made"), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  const g = goalOf(e);
  assert.equal(g.status, "running");
  assert.equal(e.store.listTasks({ goalId: g.id }).length, 2);
  assert.equal(ran(RESEARCH) + ran(SUMMARY), 0);

  const next = await restart(e);
  assert.equal(next.recover().length, 1);
  await finish(e, next);
  assert.equal(planned(), 1, "the plan was not asked for again");
  assert.equal(ran(RESEARCH), 1); assert.equal(ran(SUMMARY), 1);
  assert.equal(e.store.listTasks({ goalId: g.id }).length, 2, "no duplicate tasks");
  assert.equal(lines(e).length, 1);
  assert.match(lines(e)[0].text, /: 0 tasks done, 0 resumed\.$/);
  assert.equal(lines(e)[0].quiet, true, "a quiet line");
});

test("restart while the plan was still being written: it starts over, with no half-saved tasks left behind", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  // the planner had saved the tasks but the goal never left "planning"
  const crashed = crashAfter(e.orch, at("plan_made"), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  const g = e.store.getGoal(goalOf(e).id)!;
  e.store.saveGoal({ ...g, status: "planning" });
  const next = await restart(e);
  next.recover();
  await finish(e, next);
  assert.equal(e.store.listTasks({ goalId: g.id }).length, 2, "the orphaned tasks were dropped, not run next to the new ones");
  assert.equal(ran(RESEARCH), 1); assert.equal(ran(SUMMARY), 1);
});

test("restart mid-run: the run in flight is retried once, without counting as an attempt; finished tasks do not run again", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  withFiles(e);
  slow(e, 300);
  const run = start(e);
  await until(() => taskOf(e, SUMMARY)?.status === "running" && ran(SUMMARY) === 1); // research is accepted and merged; the summary is with its agent
  await die(e.orch); await run.catch(() => undefined);
  const before = taskOf(e, SUMMARY);
  assert.equal(before.status, "running", "what the database holds after a crash");
  assert.equal(taskOf(e, RESEARCH).status, "done");
  assert.equal(ran(RESEARCH), 1);
  slow(e, 0);

  const next = await restart(e);
  next.recover();
  await finish(e, next);
  assert.equal(ran(RESEARCH), 1, "accepted work is never run again");
  assert.equal(ran(SUMMARY), 2, "the interrupted run, and one retry");
  const t = taskOf(e, SUMMARY);
  assert.equal(t.attempts, 1, "the interrupted run did not count against the agent");
  assert.equal(t.assignee, before.assignee, "the same agent picks it up");
  assert.ok(t.history?.some((h) => h.note === "interrupted by restart"));
  assert.equal(count(kinds(e, SUMMARY), "interrupted"), 1);
  assert.equal(count(kinds(e, SUMMARY), "run_started"), 2);
  assert.equal(count(kinds(e, SUMMARY), "merged"), 1);
  assert.equal(count(kinds(e, RESEARCH), "merged"), 1);
  assert.equal(commitsFor(e, SUMMARY), 1); assert.equal(commitsFor(e, RESEARCH), 1);
  assert.ok(existsSync(join(goalOf(e).folder!, "summary.md")));
  assert.equal(goalOf(e).state?.progress?.runs, 2, "the interrupted run is not a run against the goal's budget");
  assert.equal(lines(e).length, 1);
  assert.match(lines(e)[0].text, /: 1 task done, 1 resumed\.$/);
  assert.equal(lines(e)[0].quiet, true);
});

test("restart right after a run was started, before the agent was even called: it runs once", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  const crashed = crashAfter(e.orch, at("run_started", RESEARCH), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  assert.equal(taskOf(e, RESEARCH).status, "running");
  assert.equal(ran(RESEARCH), 0);
  const next = await restart(e);
  next.recover();
  await finish(e, next);
  assert.equal(ran(RESEARCH), 1); assert.equal(ran(SUMMARY), 1);
  assert.equal(taskOf(e, RESEARCH).attempts, 1);
});

test("restart after a run finished but before it was judged: it goes straight to judging; the agent is not asked again", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  withFiles(e);
  const crashed = crashAfter(e.orch, at("run_finished", SUMMARY), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  const t = taskOf(e, SUMMARY);
  assert.equal(t.status, "review");
  assert.ok(t.result, "the reply was saved with the step");
  assert.equal(judged(SUMMARY), 0);
  assert.equal(replies(e, SUMMARY).length, 0, "the stop came before the reply was posted");

  const next = await restart(e);
  next.recover();
  await finish(e, next);
  assert.equal(ran(SUMMARY), 1, "its result was logged, so it is not run again");
  assert.equal(ran(RESEARCH), 1);
  assert.equal(judged(SUMMARY), 1);
  assert.equal(taskOf(e, SUMMARY).attempts, 1);
  assert.equal(replies(e, SUMMARY).length, 1, "the reply reaches the room once");
  assert.equal(count(kinds(e, SUMMARY), "run_started"), 1, "no second run");
  assert.deepEqual(kinds(e, SUMMARY).filter((k) => k !== "task_assigned"), ["run_started", "run_finished", "judged", "accepted", "merged"]);
  assert.equal(commitsFor(e, SUMMARY), 1);
  assert.match(lines(e)[0].text, /: 1 task done, 1 resumed\.$/);
});

test("restart after a reply was already posted: judging after the restart does not post it twice", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  const crashed = crashAfter(e.orch, at("run_finished", SUMMARY), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  const t = taskOf(e, SUMMARY);
  // the old hub got as far as posting the reply before it died
  e.store.addMessage({ roomId: e.room.id, author: { kind: "agent", id: t.assignee!, name: t.assignee! }, type: "agent", text: t.result!, mentions: [], taskId: t.id });
  assert.equal(replies(e, SUMMARY).length, 1);
  const next = await restart(e);
  next.recover();
  await finish(e, next);
  assert.equal(replies(e, SUMMARY).length, 1);
  assert.equal(ran(SUMMARY), 1);
});

test("restart after work was accepted but before it was merged: it is merged once and nothing runs or is judged again", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  withFiles(e);
  const crashed = crashAfter(e.orch, at("accepted", SUMMARY), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  const t = taskOf(e, SUMMARY);
  assert.equal(t.status, "review");
  assert.equal(count(kinds(e, SUMMARY), "merged"), 0);
  assert.equal(existsSync(join(goalOf(e).folder!, "summary.md")), false, "nothing was merged yet");
  assert.equal(judged(SUMMARY), 1);

  const next = await restart(e);
  next.recover();
  await finish(e, next);
  assert.equal(ran(SUMMARY), 1); assert.equal(ran(RESEARCH), 1);
  assert.equal(judged(SUMMARY), 1, "the verdict was logged, so it is not judged again");
  assert.equal(count(kinds(e, SUMMARY), "merged"), 1);
  assert.equal(commitsFor(e, SUMMARY), 1, "one merge");
  assert.equal(mergeAudits(e, SUMMARY), 1);
  assert.equal(readFileSync(join(goalOf(e).folder!, "summary.md"), "utf8").trim().split("\n").length, 1);
  assert.equal(taskOf(e, SUMMARY).judgment?.verdict, "accept");
  assert.ok(taskOf(e, SUMMARY).history?.some((h) => h.outcome === "ok"));
  assert.equal(lines(e).length, 1);
});

test("restart after the merge was logged but before the task was marked done: only the finishing is left", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  withFiles(e);
  const crashed = crashAfter(e.orch, at("merged", SUMMARY), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  assert.equal(taskOf(e, SUMMARY).status, "review");
  assert.equal(commitsFor(e, SUMMARY), 1, "the merge itself had happened");
  const next = await restart(e);
  next.recover();
  await finish(e, next);
  assert.equal(ran(SUMMARY), 1); assert.equal(judged(SUMMARY), 1);
  assert.equal(count(kinds(e, SUMMARY), "merged"), 1);
  assert.equal(commitsFor(e, SUMMARY), 1, "no second merge");
  assert.equal(mergeAudits(e, SUMMARY), 1);
});

test("restart after accept when the work folder is gone: there is nothing to merge, so the task runs again once", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  withFiles(e);
  const crashed = crashAfter(e.orch, at("accepted", SUMMARY), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  rmSync(e.orch.taskWorktree(taskOf(e, SUMMARY))!, { recursive: true, force: true });
  const next = await restart(e);
  next.recover();
  await finish(e, next);
  assert.equal(ran(SUMMARY), 2, "the original run, and the one retry");
  assert.equal(taskOf(e, SUMMARY).attempts, 1, "the retry is not an attempt against the agent");
  assert.equal(count(kinds(e, SUMMARY), "interrupted"), 1);
  assert.equal(count(kinds(e, SUMMARY), "merged"), 1);
  assert.equal(commitsFor(e, SUMMARY), 1);
  assert.ok(existsSync(join(goalOf(e).folder!, "summary.md")));
});

test("restart while the plan waits for approval: it keeps waiting, nothing starts, the plan card is not posted again", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  e.store.setSettings({ ...e.store.getSettings(), planApproval: "always" });
  void e.orch.runGoal(e.room.id, "Summarize the venue TV market");
  await until(() => goalOf(e)?.status === "awaiting_approval");
  await die(e.orch);
  assert.equal(e.store.listMessages(e.room.id).filter((m) => m.planGoalId).length, 1);

  const next = await restart(e);
  next.recover();
  await sleep(150);
  assert.equal(goalOf(e).status, "awaiting_approval");
  assert.equal(ran(RESEARCH) + ran(SUMMARY), 0, "no work without the owner's yes");
  assert.equal(lines(e).length, 0, "nothing was picked up: it is still waiting");
  assert.equal(e.store.listMessages(e.room.id).filter((m) => m.planGoalId).length, 1);
  assert.equal(next.decidePlan(goalOf(e).id, "approve").ok, true);
  await finish(e, next);
  assert.equal(ran(RESEARCH), 1); assert.equal(ran(SUMMARY), 1);
  assert.equal(count(listSteps(e.store, goalOf(e).id).map((s) => s.kind), "plan_approved"), 1);
});

test("restart while a goal waits on the owner: it keeps waiting, and the owner's answer lets the finished work be judged", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  const crashed = crashAfter(e.orch, at("run_finished", SUMMARY), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  const g = goalOf(e);
  e.store.saveGoal({ ...g, status: "paused", state: { ...(g.state ?? { decisions: [], nextAction: "" }), waitingOnOwner: "Which audience is this for?" } });
  const next = await restart(e);
  next.recover();
  await sleep(150);
  assert.equal(goalOf(e).status, "paused");
  assert.equal(judged(SUMMARY), 0, "no work and no judging without the answer");
  assert.ok(e.store.listMessages(e.room.id).some((m) => m.text.startsWith("Still waiting on you")));
  assert.equal(lines(e).length, 0);
  await next.handleOwnerMessage(e.room.id, "The board");
  await finish(e, next);
  assert.equal(ran(SUMMARY), 1);
  assert.equal(judged(SUMMARY), 1);
});

test("resume is safe to run more than once, and a goal can be restarted again and again", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  withFiles(e);
  const crashed = crashAfter(e.orch, at("run_finished", SUMMARY), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);

  // the second hub stops too, one step later (the verdict is written, the merge has not started)
  const second = await restart(e);
  const crashedAgain = crashAfter(second, at("judged", SUMMARY), e);
  second.recover();
  second.recover(); // twice in a row: the goal is already being driven, so nothing is doubled
  await crashedAgain; await sleep(100); await die(second);
  assert.equal(lines(e).length, 1, "one line, one resume");
  assert.equal(count(listSteps(e.store, goalOf(e).id).map((s) => s.kind), "resumed"), 1);
  assert.equal(taskOf(e, SUMMARY).status, "review");

  // the third hub finishes it
  const third = await restart(e);
  third.recover();
  await finish(e, third);
  assert.equal(ran(SUMMARY), 1, "three hubs, one run");
  assert.equal(ran(RESEARCH), 1);
  assert.equal(count(kinds(e, SUMMARY), "run_started"), 1);
  assert.equal(count(kinds(e, SUMMARY), "merged"), 1);
  assert.equal(commitsFor(e, SUMMARY), 1); assert.equal(mergeAudits(e, SUMMARY), 1);
  assert.equal(lines(e).length, 2, "one line per resume of the goal");
  // recovering a finished goal changes nothing
  const before = JSON.stringify(listSteps(e.store, goalOf(e).id).map((s) => [s.kind, s.taskId, s.round]));
  assert.equal(third.recover().length, 0);
  assert.equal(JSON.stringify(listSteps(e.store, goalOf(e).id).map((s) => [s.kind, s.taskId, s.round])), before);
});

test("with auto-resume off, a restart still closes the goal out and logs it", async () => {
  const e = setup(); MockAdapter.calls.length = 0;
  const crashed = crashAfter(e.orch, at("run_started", RESEARCH), e);
  const run = start(e);
  await crashed; await run; await die(e.orch);
  e.store.setSettings({ ...e.store.getSettings(), autoResume: false });
  const next = await restart(e);
  next.recover();
  assert.equal(goalOf(e).status, "failed");
  assert.equal(ran(RESEARCH), 0);
  assert.ok(listSteps(e.store, goalOf(e).id).some((s) => s.kind === "goal_stopped"));
  assert.equal(lines(e).length, 0);
});
