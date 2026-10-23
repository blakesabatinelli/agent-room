import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, AgentResume, FailureTag, RoutingOutcome, Task } from "@agent-room/shared";
import { MockAdapter } from "../src/adapters/mock.js";
import { buildServer } from "../src/api/server.js";
import { ControlFolder } from "../src/control/folder.js";
import { applyDiscovery } from "../src/discovery/apply.js";
import { defaultEnv, discover } from "../src/discovery/index.js";
import { Store } from "../src/db/store.js";
import { planPrompt } from "../src/orchestrator/prompts.js";
import { closeRecord, fixedDecision, openRecord } from "../src/orchestrator/routing.js";
import { recordOutcome } from "../src/orchestrator/scoring.js";
import { RESUME_CAP, barredSet, buildResume, endProbation, onProbation, planNotes, probationStatus, renderResume } from "../src/resume/index.js";
import { setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;

// ---------------------------------------------------------------- helpers

const TOOLS_OFF = { web: true, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false };
const museConfig = (settings: Record<string, unknown> = {}): AgentConfig =>
  ({ id: "muse", name: "Muse", provider: "muse", adapter: "mock", enabled: true, color: "#E01E5A", settings: { quality: 0.9, ...settings }, tools: { ...TOOLS_OFF } });

async function withControl(ctx: Ctx) {
  const root = join(ctx.dir, "Agent Room");
  const control = new ControlFolder(root, ctx.store, { debounceMs: 40, ownerName: "Blake", watch: false });
  await control.init();
  control.start();
  ctx.orch.control = control;
  return { control, root };
}
const allQuality = (ctx: Ctx, q: number) => { for (const a of ctx.store.listAgents()) { a.settings = { ...a.settings, quality: q }; ctx.store.saveAgent(a); } };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const taskCalls = (agentId?: string) => MockAdapter.calls.filter((c) => c.kind === "TASK" && (!agentId || c.agentId === agentId));

/** A graded run in the routing log, the way the orchestrator leaves one (closeRecord with a judgment emits "graded"). */
let seq = 0;
interface G { taskId?: string; at?: number; kind?: "task" | "shadow"; attempt?: number; outcome?: RoutingOutcome; model?: string; tag?: FailureTag }
function graded(store: Store, agentId: string, taskType: string, score: number, o: G = {}) {
  const agent = store.getAgent(agentId)!;
  const taskId = o.taskId ?? `syn${++seq}`;
  const attempt = o.attempt ?? 1;
  const t = { id: taskId, roomId: store.listRooms()[0].id, goalId: "goal-syn", title: `Task ${taskId}`, taskType, attempts: attempt - 1, status: attempt > 1 ? "revising" : "pending" } as unknown as Task;
  const rec = openRecord(store, fixedDecision(store, agent, [], taskType, "planned_owner", 0), t, "synthetic goal", o.kind ?? "task");
  store.saveRouting({ ...rec, at: o.at ?? rec.at });
  const accepted = score >= 0.7;
  closeRecord(store, rec.id, {
    outcome: o.outcome ?? (accepted ? "accepted" : "revise"), ...(o.model ? { modelVersion: o.model } : {}), ...(o.tag ? { failureTag: o.tag } : {}),
    ...(o.kind === "shadow" ? { shadow: true } : {}), judgment: { score, verdict: accepted ? "accept" : "revise", judgeAgentId: "claude" },
  });
  return rec.id;
}
const T0 = Date.UTC(2026, 9, 1);

// ---------------------------------------------------------------- the résumé itself

test("résumé: strengths and weaknesses are short lines with their numbers, and the thresholds decide", () => {
  const { store } = setup();
  // coding: 4 tasks, each accepted first time at 0.9 -> strong
  for (let i = 0; i < 4; i++) graded(store, "codex", "coding", 0.9, { taskId: `c${i}`, at: T0 + i });
  // writing: 4 tasks, each sent back once for verification, then accepted -> weak (sent back 4 of 4)
  for (let i = 0; i < 4; i++) {
    graded(store, "codex", "writing", 0.4, { taskId: `w${i}`, at: T0 + 10 + i, tag: "verification" });
    graded(store, "codex", "writing", 0.85, { taskId: `w${i}`, attempt: 2, at: T0 + 20 + i });
  }
  // research: only 2 runs, too few to say anything
  for (let i = 0; i < 2; i++) graded(store, "codex", "research", 0.95, { taskId: `r${i}`, at: T0 + 30 + i });

  const r = buildResume(store, "codex");
  assert.deepEqual(r.strengths, ["Strong on coding: 0.90 over 4 runs, 100% first-pass"]);
  assert.deepEqual(r.weaknesses, ["Weak on writing: sent back 4 of 4 for verification (0.63 over 8 runs)"]);
  assert.equal(r.runs, 14);
  assert.equal(r.byType.find((t) => t.taskType === "research")?.runs, 2, "listed in the table, but no line: too few runs");
  assert.ok(![...r.strengths, ...r.weaknesses].some((l) => l.includes("research")));
  assert.equal(r.firstPass, 0.6, "6 of 10 tasks were accepted on the first attempt");
  assert.equal(r.revisionsPerTask, 0.4, "4 send-back revisions over 10 tasks");
  assert.equal(r.failureMix.verification, 4);
  assert.match(r.markdown, /^---\n/, "the text that would be written starts with front matter");
  assert.match(r.markdown, /- Strong on coding: 0\.90 over 4 runs, 100% first-pass/);
  assert.match(r.markdown, /\| writing \| 8 \| 0\.63 \| 0% \| 4 of 4 \| 0 \|/);
});

test("résumé: version-aware. Once the current model has enough runs of its own, the lines are about it alone", () => {
  const { store } = setup();
  for (let i = 0; i < 3; i++) graded(store, "claude", "coding", 0.5, { taskId: `old${i}`, at: T0 + i, model: "m-old" });
  for (let i = 0; i < 2; i++) graded(store, "claude", "coding", 0.9, { taskId: `new${i}`, at: T0 + 10 + i, model: "m-new" });
  let r = buildResume(store, "claude");
  assert.equal(r.currentVersion, "m-new");
  assert.ok(r.weaknesses.some((l) => l.startsWith("Weak on coding")), "two runs of the new model are too few: the older ones still count");
  assert.deepEqual(r.strengths, []);

  graded(store, "claude", "coding", 0.9, { taskId: "new2", at: T0 + 12, model: "m-new" });
  r = buildResume(store, "claude");
  assert.deepEqual(r.strengths, ["Strong on coding: 0.90 over 3 runs, 100% first-pass (m-new)"]);
  assert.deepEqual(r.weaknesses, []);
  assert.equal(r.byType[0].currentVersionOnly, true);
  assert.deepEqual(r.modelVersions, ["m-new", "m-old"], "current first");
});

test("résumé: shadow runs count as graded runs and say so; direct answers don't count", () => {
  const { store } = setup();
  store.saveAgent(museConfig());
  for (let i = 0; i < 3; i++) graded(store, "muse", "research", 0.9, { taskId: `s${i}`, at: T0 + i, kind: "shadow" });
  const r = buildResume(store, "muse");
  assert.equal(r.runs, 3);
  assert.equal(r.shadowRuns, 3);
  assert.equal(r.byType[0].shadowRuns, 3);
  assert.match(r.markdown, /Graded runs: 3 \(3 shadow\)/);
  assert.ok(store.listRouting().filter((x) => x.chosen === "muse").every((x) => x.kind === "shadow"));
});

test("résumé: the file keeps the owner's notes, stays under 8 KB, and condenses from 80% of the cap", () => {
  const { store } = setup();
  for (let k = 0; k < 20; k++) for (let i = 0; i < 3; i++) graded(store, "codex", `type${String(k).padStart(2, "0")}`, 0.9, { taskId: `k${k}-${i}`, at: T0 + k * 10 + i });
  const r = buildResume(store, "codex");
  const day = "2026-10-23";
  const first = renderResume(r, { today: day });
  assert.ok(first.bytes <= RESUME_CAP, `${first.bytes} bytes`);
  assert.equal(first.level, 0, "this one fits without condensing");
  assert.ok(r.byType.length === 20 && /20 more|8 more task types not listed/.test(first.text), "the table lists the first 12 types and says how many more");

  const withNotes = renderResume(r, { today: day, existing: `${first.text}\n\n## Owner notes\n\nKeep Codex off slides.\n` });
  assert.match(withNotes.text, /## Owner notes\n\nKeep Codex off slides\./, "what the owner wrote under Owner notes is carried over");

  const tight = renderResume(r, { today: day, capBytes: 2200 });
  assert.ok(tight.level > 0, "over 80% of a small cap: condensed");
  assert.ok(tight.bytes < first.bytes);
  assert.match(tight.text, /^runs: 60$/m, "the front matter the hub reads is never cut");
  assert.match(tight.text, /^strengths:/m);
});

test("résumé: planNotes gives the planner the lines, capped, and names who is on probation", () => {
  const ctx = setup();
  const { store, orch } = ctx;
  store.saveAgent(museConfig());
  orch.resumes.newAgent("muse");
  for (let i = 0; i < 3; i++) graded(store, "claude", "coding", 0.9, { taskId: `p${i}`, at: T0 + i });
  graded(store, "codex", "writing", 0.9, { taskId: "x1", at: T0 });
  const agents = store.listAgents().filter((a) => a.id !== "muse");
  const n = planNotes(store, orch.resumes, agents, store.listAgents());
  assert.deepEqual(n.lines.claude, ["Strong on coding: 0.90 over 3 runs, 100% first-pass"]);
  assert.deepEqual(n.lines.codex, ["no standout strengths or weaknesses yet (1 graded run, mean 0.90)"]);
  assert.deepEqual(n.lines.hermes, []);
  assert.ok(Object.values(n.lines).every((l) => l.join("; ").length <= 480));
  assert.equal(n.probation, "On probation (do not assign them anything; they practise on copies of real tasks): Muse (0 of 5 graded runs).");
  assert.ok(!/^- /m.test(n.probation!), "not mistaken for an agent line");
});

// ---------------------------------------------------------------- RESUME.md: written after graded runs, debounced

test("AC1: RESUME.md is written after graded runs with evidence-backed lines, once a minute at most, by the orchestrator", async (t) => {
  const ctx = setup();
  const { control } = await withControl(ctx);
  t.after(() => control.close());
  const { store, orch } = ctx;
  let clock = T0;
  orch.resumes.now = () => clock;
  orch.resumes.debounceMs = 60_000;
  const path = "agents/codex/RESUME.md";
  const commits = async () => (await control.history(path)).length;

  graded(store, "codex", "coding", 0.9, { taskId: "d0", at: clock });
  await orch.resumes.settle();
  assert.equal(await commits(), 1, "the first graded run writes at once");
  assert.ok(existsSync(join(ctx.dir, "Agent Room", path)));

  // two more inside the minute: nothing yet, then exactly one trailing write that has both
  clock += 1000; graded(store, "codex", "coding", 0.9, { taskId: "d1", at: clock });
  clock += 1000; graded(store, "codex", "coding", 0.9, { taskId: "d2", at: clock });
  await control.idle();
  assert.equal(await commits(), 1, "inside the minute: no new commit");
  await orch.resumes.settle();
  assert.equal(await commits(), 2, "one trailing write");
  const text = readFileSync(join(ctx.dir, "Agent Room", path), "utf8");
  assert.match(text, /^runs: 3$/m);
  assert.match(text, /- Strong on coding: 0\.90 over 3 runs, 100% first-pass/, "the line carries its evidence");
  assert.deepEqual(control.snapshot().agents.codex.resume?.fm.strengths, ["Strong on coding: 0.90 over 3 runs, 100% first-pass"], "the hub reads it back");

  // a run after the minute writes immediately
  clock += 61_000; graded(store, "codex", "coding", 0.9, { taskId: "d3", at: clock });
  await orch.resumes.settle();
  assert.equal(await commits(), 3);
  assert.deepEqual([...new Set((await control.history(path)).map((c) => c.author))], ["orchestrator"], "every write is the orchestrator's");
  assert.equal(control.lint().blocks.length, 0, "the file passes the control folder's own lint");

  // a database copy exists as well, for hubs with no control folder
  assert.equal(orch.resumes.latest("codex")?.runs, 4);
});

test("AC1: with no control folder the résumé still lives in the database", async () => {
  const { store, orch } = setup();
  graded(store, "codex", "coding", 0.9, { taskId: "n0" });
  await orch.resumes.settle();
  assert.equal(orch.resumes.latest("codex")?.runs, 1);
  assert.equal(orch.resumes.live("codex").runs, 1);
});

// ---------------------------------------------------------------- a full run: RESUME.md, the plan prompt and the agents' context

let shared: Promise<{ ctx: Ctx; control: ControlFolder; goals: string[] }> | undefined;
const closers: (() => Promise<void>)[] = [];
after(async () => { for (const c of closers) await c(); });
/** Four goals on the demo agents, with a control folder, so résumés build up from real graded runs. */
function fourGoals() {
  shared ??= (async () => {
    const ctx = setup();
    const { control } = await withControl(ctx);
    closers.push(() => control.close());
    allQuality(ctx, 0.9);
    MockAdapter.calls.length = 0;
    const goals: string[] = [];
    for (let i = 0; i < 4; i++) goals.push((await ctx.orch.runGoal(ctx.room.id, `Summarize the venue TV market, round ${i + 1}`)).id);
    await ctx.orch.resumes.settle();
    return { ctx, control, goals };
  })();
  return shared;
}

test("AC1: after real goals each worker has a RESUME.md written from its graded runs", async () => {
  const { ctx, control, goals } = await fourGoals();
  const done = goals.map((g) => ctx.store.getGoal(g)!.status);
  assert.deepEqual(done, ["done", "done", "done", "done"]);
  const codex = control.snapshot().agents.codex?.resume, hermes = control.snapshot().agents.hermes?.resume;
  assert.ok(codex && hermes, "both workers have a file");
  assert.equal(codex!.fm.runs, 4);
  assert.deepEqual(codex!.fm.strengths, ["Strong on research: 0.90 over 4 runs, 100% first-pass"]);
  assert.deepEqual(hermes!.fm.strengths, ["Strong on writing: 0.90 over 4 runs, 100% first-pass"]);
  const hist = await control.history("agents/codex/RESUME.md");
  assert.ok(hist.length >= 1 && hist.length <= 6, "debounced: not one commit per run and judge call");
  assert.ok(hist.every((c) => c.author === "orchestrator"));
  assert.equal(ctx.orch.resumes.latest("hermes")?.runs, 4);
});

test("planPrompt shows résumé lines and probation, not the raw score table", async () => {
  // the prompt itself
  const ctx = setup();
  const agents = ctx.store.listAgents();
  const scores = [{ agentId: "claude", taskType: "coding", runs: 7, quality: 0.83, avgSeconds: 4, revisions: 0, failures: 0 }];
  const notes = { lines: { claude: ["Strong on coding: 0.86 over 14 runs, 79% first-pass", "Weak on slides: sent back 3 of 4 (0.52 over 5 runs)"] }, probation: "On probation (do not assign them anything; they practise on copies of real tasks): Muse (2 of 5 graded runs)." };
  const p = planPrompt("Do a thing", agents, [], [], "", scores, "Claude", [], undefined, "", notes);
  assert.match(p, /track record: Strong on coding: 0\.86 over 14 runs, 79% first-pass; Weak on slides: sent back 3 of 4/);
  assert.match(p, /On probation .*Muse \(2 of 5 graded runs\)/);
  assert.ok(!/\d+\/100 over \d+/.test(p), "no raw score table");
  assert.ok(!p.includes("coding 83/100"), "the scores argument is not printed any more");
  assert.match(p, /- codex: .*no track record yet/);

  // and what the orchestrator really sent over four goals
  const real = await fourGoals();
  const plans = MockAdapter.calls.filter((c) => c.kind === "PLAN");
  assert.ok(plans.length >= 4);
  assert.ok(plans[0].prompt.includes("no track record yet"));
  assert.ok(plans.every((c) => !/\d+\/100 over \d+/.test(c.prompt)), "never the raw table");
  const last = plans.at(-1)!.prompt;
  assert.match(last, /- codex: .*track record: Strong on research: 0\.90 over 3 runs, 100% first-pass/);
  assert.match(last, /- hermes: .*track record: Strong on writing: 0\.90 over 3 runs, 100% first-pass/);
  assert.ok(real.ctx.store.listScores().length >= 2, "the scores table is still kept; the planner just isn't shown it");
});

test("RESUME.md never appears in an agent's task prompt or context file", async () => {
  const { ctx, control } = await fourGoals();
  assert.ok(control.snapshot().agents.codex?.resume, "the file exists, so the check below means something");
  const work = taskCalls();
  assert.ok(work.length >= 8);
  assert.ok(work.some((c) => c.context && c.context.length > 100), "tasks had a context file written into their worktree");
  const leak = /RESUME|résumé|resume\.md|Strong on|Weak on|probation|first-pass/i;
  for (const c of work) {
    assert.ok(!leak.test(c.prompt), `prompt for ${c.agentId} mentions a résumé`);
    if (c.context) assert.ok(!leak.test(c.context), `context file for ${c.agentId} mentions a résumé`);
  }
  const text = control.contextFor({ agentId: "codex", roomSlug: control.slugFor(ctx.room.id), taskType: "research", goal: { id: "g", text: "Summarize" }, task: { title: "Research", description: "Gather facts" } });
  assert.ok(!leak.test(text), "the layers a context file is built from never include it");
  // no MCP tool reads it either
  const tools = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  assert.ok(!/RESUME|resume\.md|\.resumes\b/i.test(tools.replace(/\/\/ 2\.3.*$/gm, "")), "the MCP server has no résumé tool");
});

// ---------------------------------------------------------------- AC2: probation and shadow tasks

let probe: Promise<{ ctx: Ctx; control: ControlFolder; first: ReturnType<typeof snapshotOf>; rest: string[] }> | undefined;
function snapshotOf(ctx: Ctx, goalId: string) {
  const goal = ctx.store.getGoal(goalId)!;
  return {
    goal,
    tasks: ctx.store.listTasks({ goalId }),
    calls: taskCalls("muse").map((c) => ({ cwd: c.cwd, prompt: c.prompt })),
    branches: git(goal.folder!, "branch", "--list", "--format=%(refname:short)", "ar/*"),
    tracked: git(goal.folder!, "ls-files"),
    files: readdirSync(goal.folder!),
    messages: ctx.store.listMessages(ctx.room.id),
    approvals: ctx.store.listApprovals(),
    routing: ctx.store.listRouting({ goalId }),
  };
}
/** Muse is new (on probation, 3 graded runs needed) and writes a stray file outside its scope in every copy. Goals run until it graduates. */
function probation() {
  probe ??= (async () => {
    const ctx = setup();
    const { control } = await withControl(ctx);
    closers.push(() => control.close());
    ctx.store.setSettings({ ...ctx.store.getSettings(), probationRuns: 3 });
    ctx.store.saveAgent(museConfig({ writeOutside: "muse-only.txt" }));
    ctx.orch.resumes.newAgent("muse");
    MockAdapter.calls.length = 0;
    const g1 = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
    const first = snapshotOf(ctx, g1.id);
    const rest: string[] = [];
    for (let i = 0; i < 4 && onProbation(ctx.store, "muse"); i++) rest.push((await ctx.orch.runGoal(ctx.room.id, `Summarize the venue TV market again, take ${i + 2}`)).id);
    await ctx.orch.resumes.settle();
    return { ctx, control, first, rest };
  })();
  return probe;
}

test("AC2: a probation agent gets shadow copies in its own worktree, which are discarded and never merged", async () => {
  const { ctx, first } = await probation();
  assert.equal(first.goal.status, "done");
  const mine = first.routing.filter((r) => r.chosen === "muse");
  assert.ok(mine.length >= 1, "it was given a copy of at least the first task");
  assert.ok(mine.every((r) => r.kind === "shadow" && r.shadow === true && r.reason === "shadow" && r.shadowOf && r.shadowOf !== r.taskId));
  assert.ok(first.calls.length >= 1);
  for (const c of first.calls) {
    assert.notEqual(c.cwd, first.goal.folder, "never the goal's own folder");
    assert.ok(!existsSync(c.cwd), "its worktree is gone");
    assert.ok(!taskCalls().filter((x) => x.agentId !== "muse").some((x) => x.cwd === c.cwd), "and was not shared with a real task");
    assert.match(c.prompt, /# Your task:/, "it got the real task's prompt");
  }
  assert.ok(!first.files.includes("muse-only.txt"), "what it wrote is not in the goal's folder");
  assert.ok(!first.tracked.includes("muse-only.txt"), "and not in its history");
  assert.ok(!first.branches.includes("shadow"), "no copy's branch is left");
  assert.ok(!git(first.goal.folder!, "log", "--all", "--format=%s").includes("muse"), "nothing of Muse's was committed anywhere");
  assert.ok(!existsSync(join(first.goal.folder!, "muse-only.txt")));
  // real tasks are the real agents' alone
  assert.ok(first.tasks.every((t) => t.assignee !== "muse" && t.owner !== "muse" && !t.id.includes("shadow")), "no task row for a copy");
  assert.ok(first.tasks.every((t) => t.status === "done"));
  // the practice is on its record: the scores roll-up and the routing log, judged by someone else
  assert.ok(ctx.store.listScores().some((s) => s.agentId === "muse" && s.runs >= 1), "scored on the agent's record");
  assert.ok(mine.some((r) => r.judgment && r.judgment.judgeAgentId !== "muse"), "judged like real work");
  assert.ok(mine.some((r) => r.judgment && r.outcome !== "pending"));
});

test("AC2: a shadow run says nothing in the room except one quiet log line, and never asks for approval", async () => {
  const { ctx, first } = await probation();
  assert.ok(first.messages.every((m) => m.author.id !== "muse"), "Muse never speaks");
  const lines = first.messages.filter((m) => /practised on a copy/.test(m.text));
  assert.ok(lines.length >= 1 && lines.every((m) => m.quiet === true), "only a quiet work-log line");
  assert.ok(first.messages.filter((m) => !m.quiet).every((m) => !/muse/i.test(m.text) || m.author.kind === "agent"), "nothing about it in the conversation");
  assert.equal(first.approvals.length, 0, "no approval was ever requested");
  assert.equal(ctx.store.listApprovals().length, 0);

  // and if a copy asks anyway, it is refused without a card, a post or a saved document
  const grant = { agentId: "muse", roomId: ctx.room.id, shadow: true };
  const before = ctx.store.listMessages(ctx.room.id).length;
  const res = await ctx.orch.requestApproval(grant, "shell", "run a command", "rm -rf nothing");
  assert.equal(res.status, "rejected");
  assert.equal(ctx.store.listApprovals().length, 0, "not even a stored one");
  assert.equal(ctx.orch.agentPost(grant, "hello").ok, false);
  assert.match(await ctx.orch.askAgent(grant, "codex", "can you help?", ctx.room.id), /Nobody can answer/);
  assert.equal(ctx.store.listMessages(ctx.room.id).length, before, "nothing was posted");
  assert.ok(ctx.store.listAudit().some((a) => a.action === "shadow.denied"), "the refusal is audited");
  // the same request from a real agent still goes the normal way
  const real = ctx.orch.requestApproval({ agentId: "codex", roomId: ctx.room.id }, "shell", "run", "ls");
  assert.equal(ctx.store.listApprovals("pending").length, 1);
  ctx.approvals.decide(ctx.store.listApprovals("pending")[0].id, "rejected");
  assert.equal((await real).status, "rejected");
});

test("AC2: a probation agent is never the planned owner and never given real work", async () => {
  const { ctx, first, rest } = await probation();
  const all = [first.goal.id, ...rest];
  const graduatedAt = ctx.store.listAudit().find((a) => a.action === "probation.ended" && a.detail.startsWith("muse"))?.at ?? Infinity;
  for (const id of all) {
    for (const t of ctx.store.listTasks({ goalId: id })) assert.notEqual(t.assignee, "muse", `${t.title} went to Muse`);
  }
  // the planner was told, and not offered Muse as an agent
  const plans = MockAdapter.calls.filter((c) => c.kind === "PLAN");
  assert.ok(plans.length >= 1);
  assert.match(plans[0].prompt, /On probation \(do not assign them anything; they practise on copies of real tasks\): Muse \(0 of 3 graded runs\)\./);
  assert.ok(!/^- muse: /m.test(plans[0].prompt), "Muse is not in the list of agents to plan with");
  assert.ok(graduatedAt < Infinity);
  // learned routing: Muse looks brilliant on paper, still never picked while on probation
  const other = setup();
  other.store.saveAgent(museConfig());
  other.orch.resumes.newAgent("muse");
  for (let i = 0; i < 12; i++) recordOutcome(other.store, "muse", "research", { judgment: { score: 1, verdict: "accept", feedback: "", judgeAgentId: "claude" }, seconds: 1, failed: false, revision: false });
  const planner = other.store.getAgent("claude")!; planner.settings = { ...planner.settings, noOwner: true }; other.store.saveAgent(planner); // the plan names no owners
  const g = await other.orch.runGoal(other.room.id, "Summarize the venue TV market");
  assert.equal(g.status, "done");
  const real = other.store.listTasks({ goalId: g.id });
  assert.ok(real.length >= 2 && real.every((t) => t.assignee && t.assignee !== "muse"), "routing by the learned score skipped it");
  assert.ok(other.store.listRouting({ goalId: g.id }).filter((r) => r.kind === "task").every((r) => r.chosen !== "muse" && r.candidates.every((c) => c.agentId !== "muse" || c.p === 0)));
  // the machine is all there is: when every connected agent is on probation, the owner's work still gets done
  const solo = setup();
  for (const a of solo.store.listAgents()) { if (a.id !== "claude") solo.store.saveAgent({ ...a, enabled: false }); }
  solo.orch.resumes.newAgent("claude");
  assert.ok(onProbation(solo.store, "claude"));
  assert.equal(barredSet(solo.store, solo.store.listAgents().filter((a) => a.enabled)).size, 0);
  assert.equal((await solo.orch.runGoal(solo.room.id, "Summarize the venue TV market")).status, "done");
});

test("AC2: the agent leaves probation at the threshold, with one line in the room, an audit entry and a fresh RESUME.md", async () => {
  const { ctx, control, first, rest } = await probation();
  const st = probationStatus(ctx.store, "muse");
  assert.equal(st.on, false);
  assert.equal(st.endedBy, "threshold");
  assert.equal(st.graded, 3, "it stopped at exactly the number it needed");
  const lines = ctx.store.listMessages(ctx.room.id).filter((m) => /finished probation/.test(m.text));
  assert.equal(lines.length, 1, "one line, once");
  assert.match(lines[0].text, /^Muse finished probation: \d\.\d\d over 3 shadow tasks$/);
  assert.equal(lines[0].quiet, undefined);
  assert.equal(lines[0].author.kind, "system");
  const ended = ctx.store.listAudit().filter((a) => a.action === "probation.ended" && a.detail.startsWith("muse"));
  assert.equal(ended.length, 1);
  assert.match(ended[0].detail, /reached the threshold after 3 graded runs, mean \d\.\d\d/);
  assert.ok(first.goal.id && rest.length >= 0);
  // RESUME.md says so
  await ctx.orch.resumes.settle();
  const file = readFileSync(join(ctx.dir, "Agent Room", "agents/muse/RESUME.md"), "utf8");
  assert.match(file, /^probation: false$/m);
  assert.match(file, /Probation ended \d{4}-\d\d-\d\d after 3 graded runs, mean \d\.\d\d/);
  assert.match(file, /Graded runs: 3 \(3 shadow\)/);
  assert.equal(control.snapshot().agents.muse?.resume?.fm.probation, false);
  // and from now on it is an ordinary agent: offered to the planner, and no more copies
  const before = taskCalls("muse").length;
  const g = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market, after probation");
  assert.equal(g.status, "done");
  assert.match(MockAdapter.calls.filter((c) => c.kind === "PLAN").at(-1)!.prompt, /^- muse: /m);
  assert.equal(ctx.store.listRouting({ goalId: g.id }).filter((r) => r.kind === "shadow").length, 0, "no more practice runs");
  assert.ok(taskCalls("muse").length >= before);
  assert.equal(ctx.store.listMessages(ctx.room.id).filter((m) => /finished probation/.test(m.text)).length, 1, "still one line");
});

// ---------------------------------------------------------------- the owner's switch, and who starts on probation

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await pr.json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, json: (await r.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { ...ctx, app, call };
}

test("the owner can end probation, and start it again; both are audited", async (t) => {
  const { app, call, store, orch } = await boot();
  t.after(() => app.close());
  const created = await call("POST", "/agents", { ...museConfig(), settings: {} });
  assert.equal(created.status, 200);
  let r = await call("GET", "/agents/muse/resume");
  assert.equal(r.status, 200);
  assert.equal(r.json.probation.on, true, "an agent added through POST /agents starts on probation");
  assert.equal(r.json.probation.needed, 5);
  assert.equal(r.json.probation.graded, 0);
  assert.deepEqual(barredSet(store, store.listAgents()), new Set(["muse"]));

  // two practice runs so far: 2 of 5
  for (let i = 0; i < 2; i++) graded(store, "muse", "research", 0.9, { taskId: `o${i}`, kind: "shadow" });
  assert.equal((await call("GET", "/agents/muse/resume")).json.probation.graded, 2);

  const end = await call("POST", "/agents/muse/probation", { on: false });
  assert.equal(end.status, 200);
  assert.equal(end.json.probation.on, false);
  assert.equal(end.json.probation.endedBy, "owner");
  assert.equal(onProbation(store, "muse"), false);
  assert.equal(barredSet(store, store.listAgents()).size, 0, "Muse can take real work now");
  assert.ok(store.listAudit().some((a) => a.action === "probation.ended" && a.actor === "owner" && a.detail.includes("ended by the owner")));
  assert.equal(store.listMessages(store.listRooms()[0].id).filter((m) => /finished probation/.test(m.text)).length, 0, "an owner's decision is not announced as a graduation");

  const again = await call("POST", "/agents/muse/probation", { on: true });
  assert.equal(again.json.probation.on, true);
  assert.equal(again.json.probation.startedBy, "owner");
  assert.equal(again.json.probation.graded, 0, "counts from the restart");
  assert.ok(store.listAudit().some((a) => a.action === "probation.started" && a.actor === "owner"));

  assert.equal((await call("POST", "/agents/nobody/probation", { on: true })).status, 404);
  assert.equal((await call("GET", "/agents/nobody/resume")).status, 404);
  assert.equal((await call("POST", "/agents/muse/probation", { on: "yes" })).status >= 400, true);
  await orch.resumes.settle();
});

test("who starts on probation: new agents do; the demo agents and agents with enough graded runs don't", async (t) => {
  const { app, call, store, orch } = await boot();
  t.after(() => app.close());
  for (const id of ["claude", "codex", "hermes"]) assert.equal((await call("GET", `/agents/${id}/resume`)).json.probation.on, false, `${id} is a seeded agent`);
  const all = await call("GET", "/resumes");
  assert.equal(all.json.length, 3);
  assert.ok(all.json.every((r: AgentResume) => r.probation.on === false && typeof r.markdown === "string"));

  // an agent that already has the runs it needs (here: 5 graded runs from before it was added again) isn't put on probation
  store.saveAgent({ ...museConfig(), id: "vet", name: "Vet" });
  for (let i = 0; i < 5; i++) graded(store, "vet", "coding", 0.8, { taskId: `v${i}`, at: T0 + i });
  orch.resumes.newAgent("vet");
  assert.equal(onProbation(store, "vet"), false);
  store.saveAgent({ ...museConfig(), id: "rookie", name: "Rookie" });
  for (let i = 0; i < 4; i++) graded(store, "rookie", "coding", 0.8, { taskId: `ro${i}`, at: T0 + i });
  orch.resumes.newAgent("rookie");
  assert.equal(onProbation(store, "rookie"), true, "4 runs is not 5");
  assert.equal(probationStatus(store, "rookie").graded, 4);

  // the number is a setting
  assert.equal((await call("PUT", "/settings", { ...store.getSettings(), probationRuns: 2 })).status, 200);
  assert.equal(probationStatus(store, "rookie").needed, 2);
  assert.equal((await call("PUT", "/settings", { ...store.getSettings(), probationRuns: 0 })).status >= 400, true, "at least 1");
});

test("discovery puts a newly found agent on probation; a re-run doesn't restart it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ar-home-"));
  const env = defaultEnv({
    home, vars: {},
    which: async (b) => (b === "claude" ? "/fake/bin/claude" : undefined),
    run: async () => ({ code: 127, stdout: "", stderr: "not found" }),
    fetchJson: async () => undefined,
  });
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ar-disc-")), "t.db"));
  const made = await applyDiscovery(store, await discover(env, 1000));
  assert.deepEqual(made.created, ["claude"]);
  assert.equal(onProbation(store, "claude"), true);
  assert.ok(store.listAudit().some((a) => a.action === "probation.started" && a.detail.startsWith("claude")));
  endProbation(store, "claude", "owner");
  await applyDiscovery(store, await discover(env, 1000));
  assert.equal(onProbation(store, "claude"), false, "the owner ended it; a re-run of discovery leaves that alone");
});

test("a hub that stopped mid-practice closes the unfinished row at start", async () => {
  const { store, orch } = setup();
  store.saveAgent(museConfig());
  orch.resumes.newAgent("muse");
  const agent = store.getAgent("muse")!;
  const t = { id: "tx-shadow-muse", roomId: store.listRooms()[0].id, goalId: "g", title: "Half done", taskType: "research", attempts: 0, status: "running" } as unknown as Task;
  const rec = openRecord(store, fixedDecision(store, agent, [], "research", "shadow", 0), t, "goal", "shadow");
  assert.equal(orch.resumes.sweep(), 1);
  assert.equal(store.getRouting(rec.id)?.outcome, "interrupted");
  assert.equal(probationStatus(store, "muse").graded, 0, "an interrupted copy is not a graded run");
});

// ---------------------------------------------------------------- the apps

test("both apps show the résumé and the probation switch; the phone view uses no inline styles", () => {
  const web = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(web, /data-nav="resumes"[^>]*>.*Résumés/, "a row under Settings");
  const block = web.slice(web.indexOf("function renderResumes"), web.indexOf("// 1.2: Tailscale status"));
  assert.ok(block.length > 500);
  assert.ok(!/style=|onclick=|<script/i.test(block), "strict CSP: no inline styles or scripts");
  assert.match(block, /\$\{pr\.graded\} of \$\{pr\.needed\} graded runs/, "progress reads 3 of 5");
  assert.match(block, /data-probation=/);
  assert.match(web, /\/agents\/\$\{t\.dataset\.probation\}\/probation/);
  const mac = readFileSync(new URL("../../app/src/components/Resume.tsx", import.meta.url), "utf8");
  assert.match(mac, /graded runs/);
  assert.match(mac, /End probation/);
  assert.match(readFileSync(new URL("../../app/src/screens/AgentsScreen.tsx", import.meta.url), "utf8"), /<Resume agentId=\{a\.id\}/);
});
