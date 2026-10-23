import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SETTING_DEFAULTS, type Goal, type ServerEvent, type Task } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { ClaudeCodeAdapter, claudeReadOnly } from "../src/adapters/claudeCode.js";
import { codexBaseArgs } from "../src/adapters/codex.js";
import { adapters } from "../src/adapters/index.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { ledgerMarkdown, newProgress } from "../src/orchestrator/ledger.js";
import type { McpGrant } from "../src/orchestrator/orchestrator.js";
import { goalFolder } from "../src/orchestrator/workspace.js";
import { NativeTracker, matchesVendor, subagentSettings, type NativeEvent } from "../src/subagents/index.js";
import { helperPrompt } from "../src/subagents/prompts.js";
import { id, now } from "../src/util.js";
import { setup } from "./helpers.js";

type Env = ReturnType<typeof setup>;
const here = dirname(fileURLToPath(import.meta.url));
const until = async (fn: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 20 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const tune = (e: Env, aid: string, settings: Record<string, unknown>) => { const a = e.store.getAgent(aid)!; Object.assign(a.settings, settings); e.store.saveAgent(a); };
const limits = (e: Env, subagents: Record<string, number>) => e.store.setSettings({ ...e.store.getSettings(), subagents });
const taskCalls = () => MockAdapter.calls.filter((c) => c.kind === "TASK");
const kids = (e: Env, goalId: string) => e.store.listTasks({ goalId, subagents: true }).filter((t) => t.kind === "subagent");

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { ...ctx, app, base };
}
async function mcp(base: string, token: string) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await c.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
  return { c, call };
}

/** A running goal with ONE running task held by `agent` (what a spawn_agent call needs), and optionally the task's own worktree. */
async function seedParent(e: Env, o: { depth?: number; withWs?: boolean; agent?: string; files?: Record<string, string>; hop?: number } = {}) {
  const goalId = id("goal"), taskId = id("task"), agentId = o.agent ?? "claude";
  const folder = goalFolder(e.dir, goalId);
  mkdirSync(folder, { recursive: true });
  for (const [f, body] of Object.entries(o.files ?? { "base.txt": "base\n" })) { mkdirSync(dirname(join(folder, f)), { recursive: true }); writeFileSync(join(folder, f), body); }
  const goal: Goal = {
    id: goalId, roomId: e.room.id, text: "Review the data pipeline", status: "running", createdAt: now(), approvedAt: now(), folder,
    contract: { objective: "Review the data pipeline", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: now(), amendments: [], requirements: [] },
    state: { decisions: [], nextAction: "", progress: newProgress() },
  };
  e.store.saveGoal(goal);
  const task: Task = {
    id: taskId, roomId: e.room.id, goalId, title: "Review the pipeline", description: "Review it carefully and report.", taskType: "analysis", acceptance: "AC1: Done.",
    dependsOn: [], owner: agentId, assignee: agentId, role: "worker", files: [], status: "running", attempts: 1, history: [], createdAt: now(), updatedAt: now(),
    ...(o.depth !== undefined ? { depth: o.depth } : {}),
  };
  e.store.saveTask(task);
  const ws = o.withWs ? await e.orch.workspaces.open(e.orch.goalSources.ref(goal, folder), task, agentId) : undefined;
  const grant: McpGrant = { agentId, roomId: e.room.id, taskId, hop: o.hop ?? 0, ...(ws ? { cwd: ws.path } : {}) };
  return { goal, task, grant, ws, folder };
}
const lines = (e: Env) => e.store.listMessages(e.room.id, 500).map((m) => m.text);

// ---------------------------------------------------------------------------------------------------------------------------------------------
test("AC1 AC2: spawn_agent over MCP starts a different vendor, which answers; the child is a saved task in the tree", async () => {
  const e = await boot();
  const { goal, task } = await seedParent(e);
  e.orch.grants.set("tok_parent", { agentId: "claude", roomId: e.room.id, taskId: task.id });
  const events: ServerEvent[] = [];
  e.store.on("event", (ev: ServerEvent) => events.push(ev));
  MockAdapter.calls.length = 0;
  const { c, call } = await mcp(e.base, "tok_parent");
  const tools = (await c.listTools()).tools.map((t) => t.name);
  for (const n of ["spawn_agent", "subagent_status", "accept_subagent", "discard_subagent"]) assert.ok(tools.includes(n), n);

  const out = await call("spawn_agent", { instructions: "Check the SQL in db/queries.sql and say what is wrong.", vendor: "openai", files: ["db/queries.sql"] });
  assert.match(out, /Codex \(read-only\) finished/);
  assert.match(out, /Codex finished the task/, "the helper's own answer is in the result");
  assert.doesNotMatch(out, /MEMORY:/, "memory lines are not handed to the parent");
  assert.match(out, /Report: Codex/, "a short report follows the answer");

  const [child] = kids(e, goal.id);
  assert.equal(child.kind, "subagent");
  assert.equal(child.parentTaskId, task.id);
  assert.equal(child.depth, 1);
  assert.equal(child.spawnedBy, "claude");
  assert.equal(child.readOnly, true);
  assert.equal(child.assignee, "codex", "a different vendor from the parent");
  assert.equal(child.status, "done");
  assert.ok(!e.store.listTasks({ goalId: goal.id }).some((t) => t.id === child.id), "helpers stay out of the plan lists by default");

  assert.ok(events.some((ev) => ev.type === "subagent" && ev.parentTaskId === task.id && ev.task.id === child.id), "a subagent event went out");
  assert.ok(lines(e).some((l) => /Claude started a helper: Codex \(read-only\): Check the SQL/.test(l)), "quiet start line");
  assert.ok(lines(e).some((l) => /Codex finished the helper task: Check the SQL/.test(l)), "quiet finish line");

  const rec = e.store.listRouting({ taskId: child.id });
  assert.equal(rec.length, 1);
  assert.equal(rec[0].kind, "subagent");
  assert.equal(rec[0].reason, "subagent", "the routing log says why");
  assert.equal(rec[0].outcome, "answered", "answered, never judged");
  assert.ok(e.store.listAudit().some((a) => a.action === "subagent.spawned" && a.detail.includes(child.id)));

  const run = taskCalls().find((x) => x.agentId === "codex")!;
  assert.equal(run.readOnly, true, "the adapter was told it is read-only");
  assert.match(run.prompt, /READ-ONLY job/);
  assert.match(run.prompt, /Start with: db\/queries.sql/);
  await c.close(); await e.app.close();
});

test("AC2: GET /rooms/:id/tasks returns the children so the Mac app and the phone can draw the tree", async () => {
  const e = await boot();
  const { goal, task, grant } = await seedParent(e);
  await e.orch.subagents.spawn(grant, { instructions: "Look at the numbers once more.", agent: "codex" });
  const pair = await fetch(`${e.base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: (e.app as unknown as { pairingCode: () => string }).pairingCode(), deviceName: "Mac" }) });
  const { token } = (await pair.json()) as { token: string };
  const list = (await (await fetch(`${e.base}/rooms/${e.room.id}/tasks`, { headers: { authorization: `Bearer ${token}` } })).json()) as Task[];
  const child = list.find((t) => t.kind === "subagent")!;
  assert.ok(child, "the child is listed");
  assert.equal(child.parentTaskId, task.id);
  assert.ok(list.some((t) => t.id === task.id));
  assert.equal(kids(e, goal.id).length, 1);
  await e.app.close();
});

test("a helper is a real participant: its grant carries its own task, read-only and hop; it can post to the room, and its writes are refused", async () => {
  const e = await boot();
  (e.orch as unknown as { opts: { mcpUrl: () => string | undefined } }).opts.mcpUrl = () => e.base; // so a run gets a grant, as it does on a real hub
  const { task, grant } = await seedParent(e, { hop: 1 });
  tune(e, "codex", { delayMs: 600 });
  const started = e.orch.subagents.spawn(grant, { instructions: "Compare the two exports and tell me the difference.", agent: "codex", wait: false });
  assert.match(await started, /Started helper sub_/);
  await until(() => [...e.orch.grants.values()].some((g) => g.agentId === "codex" && g.taskId?.startsWith("sub_")));
  const [token, g] = [...e.orch.grants.entries()].find(([, x]) => x.agentId === "codex" && x.taskId?.startsWith("sub_"))!;
  assert.equal(g.readOnly, true);
  assert.equal(g.roomId, e.room.id);
  assert.equal(g.hop, 1, "the hop count carries on from its parent, so ask chains stay bounded");
  assert.notEqual(g.taskId, task.id);
  assert.equal(e.orch.subagents.readOnlyNow("codex"), true);

  const { c, call } = await mcp(e.base, token);
  assert.match(await call("post_message", { text: "Quick note from the helper: the second export has 12 more rows." }), /Posted/);
  assert.ok(lines(e).some((l) => l.includes("the second export has 12 more rows")), "it spoke in the room");
  const write = await call("propose_file_write", { path: "x.txt", content: "hello" });
  assert.match(write, /read-only helper/);
  assert.doesNotMatch(write, /proposalId/);
  assert.match(await call("save_document", { title: "Notes", body: "hello" }), /read-only|NOT SAVED|refus/i);
  const deny = JSON.parse(await call("approval_prompt", { tool_name: "Write", input: { file_path: "x.txt" } })) as { behavior: string };
  assert.equal(deny.behavior, "deny");
  assert.ok(e.store.listAudit().some((a) => a.action === "subagent.write.denied"), "denied writes are audited");
  await c.close();

  await until(() => !e.orch.subagents.readOnlyNow("codex"));
  assert.equal(e.orch.subagents.readOnlyNow("codex"), false, "the restriction ends with the helper");
  await e.app.close();
});

test("AC3: only an agent holding a task can spawn; MCP apps without a task and practice runs are refused and audited", async () => {
  const e = setup();
  const { task } = await seedParent(e);
  const noTask = await e.orch.subagents.spawn({ agentId: "claude", roomId: e.room.id }, { instructions: "Do a thing for me please." });
  assert.match(noTask, /^NOT STARTED\. Only an agent working on a task/);
  const shadow = await e.orch.subagents.spawn({ agentId: "claude", roomId: e.room.id, taskId: task.id, shadow: true }, { instructions: "Do a thing for me please." });
  assert.match(shadow, /^NOT STARTED\. Practice runs/);
  const stranger = await e.orch.subagents.spawn({ agentId: "codex", roomId: e.room.id, taskId: task.id }, { instructions: "Do a thing for me please." });
  assert.match(stranger, /only while you are working on your task/, "a task grant by an agent that does not hold the task is refused");
  assert.equal(e.store.listAudit().filter((a) => a.action === "subagent.refused").length, 3);
  assert.equal(e.store.listTasks({ subagents: true }).filter((t) => t.kind === "subagent").length, 0);
  assert.equal(await e.orch.subagents.accept({ agentId: "claude", roomId: e.room.id }, "sub_x"), "No helper sub_x of yours.");
});

test("AC3: helpers go at most two levels deep (a setting)", async () => {
  const e = setup();
  const deep = await seedParent(e, { depth: 2 });
  const refused = await e.orch.subagents.spawn(deep.grant, { instructions: "Look one level further down." });
  assert.match(refused, /^NOT STARTED\. Helpers can go 2 levels deep/);
  assert.equal(kids(e, deep.goal.id).length, 0);

  const mid = await seedParent(e, { depth: 1 });
  const ok = await e.orch.subagents.spawn(mid.grant, { instructions: "Look one level further down.", agent: "codex" });
  assert.match(ok, /finished/);
  assert.equal(kids(e, mid.goal.id)[0].depth, 2);

  limits(e, { maxDepth: 1 });
  const top = await seedParent(e, { depth: 1 });
  assert.match(await e.orch.subagents.spawn(top.grant, { instructions: "Look one level further down." }), /1 level deep/);
  assert.ok(e.store.listAudit().some((a) => a.action === "subagent.refused" && /deep/.test(a.detail)));
});

test("AC3: a goal's helper budget is enforced, counted in the goal's progress and shown in the ledger; the parent is never picked", async () => {
  const e = setup();
  limits(e, { budgetPerGoal: 3 });
  const { goal, grant } = await seedParent(e);
  const outs: string[] = [];
  for (let i = 0; i < 4; i++) outs.push(await e.orch.subagents.spawn(grant, { instructions: `Part ${i + 1}: read the file and summarise it.` }));
  assert.ok(outs.slice(0, 3).every((o) => /finished/.test(o)), outs.join("\n"));
  assert.match(outs[3], /^NOT STARTED\. This goal has used its budget of 3 helpers/);
  const g = e.store.getGoal(goal.id)!;
  assert.equal(g.state!.progress!.subagents!.spawned, 3);
  assert.equal(g.state!.progress!.runs, 3, "helper runs count in the goal's task-run budget");
  assert.ok(kids(e, goal.id).every((k) => k.assignee !== "claude"), "routing never hands a helper to the agent that asked");
  const md = ledgerMarkdown(g, e.store.listTasks({ goalId: goal.id }), e.store.listAgents(), 3);
  assert.match(md, /Helpers: 3 of 3 started/);
  assert.ok(!md.includes("Part 1: read the file"), "helpers are not plan tasks in the ledger");
  const rec = e.store.listRouting({ goalId: goal.id }).filter((r) => r.kind === "subagent");
  assert.equal(rec.length, 3);
  assert.ok(rec.every((r) => r.reason === "subagent"));
});

test("AC3: the goal's task-run budget also stops helpers, and a parent can run only three at once", async () => {
  const e = setup();
  const full = await seedParent(e);
  const g = e.store.getGoal(full.goal.id)!;
  g.state!.progress!.runs = e.store.getSettings().maxTaskRuns ?? SETTING_DEFAULTS.maxTaskRuns;
  e.store.saveGoal(g);
  assert.match(await e.orch.subagents.spawn(full.grant, { instructions: "One more helper please." }), /task runs, and helper runs count in it/);

  limits(e, { maxParallel: 1 });
  const p = await seedParent(e);
  tune(e, "codex", { delayMs: 500 });
  assert.match(await e.orch.subagents.spawn(p.grant, { instructions: "A slow helper.", agent: "codex", wait: false }), /Started helper/);
  const second = await e.orch.subagents.spawn(p.grant, { instructions: "A second helper.", agent: "hermes", wait: false });
  assert.match(second, /^NOT STARTED\. You already have 1 helpers running \(the limit is 1 at once\)/);
  const [kid] = kids(e, p.goal.id);
  await until(() => e.store.getTask(kid.id)!.status === "done");
  assert.match(e.orch.subagents.status(p.grant, kid.id), /finished/, "subagent_status returns the answer once it is done");
  assert.match(e.orch.subagents.status(p.grant), new RegExp(`${kid.id} \\| read-only \\| done \\| Codex`));
  assert.equal(subagentSettings(e.store).maxParallel, 1);
  assert.deepEqual(subagentSettings(setup().store), { maxDepth: 2, budgetPerGoal: 6, maxParallel: 3 }, "the documented defaults");
});

test("quota and capacity apply to the child like any run: a named agent that cannot take it is refused with a reason", async () => {
  const e = setup();
  const { grant } = await seedParent(e);
  e.orch.subagents["host"].busy("codex", true);
  assert.match(await e.orch.subagents.spawn(grant, { instructions: "Needs someone free.", agent: "codex" }), /Codex is busy/);
  assert.match(await e.orch.subagents.spawn(grant, { instructions: "Needs someone free.", agent: "claude" }), /That is you/);
  assert.match(await e.orch.subagents.spawn(grant, { instructions: "Needs someone free.", agent: "nobody" }), /No agent called "nobody"/);
  assert.match(await e.orch.subagents.spawn(grant, { instructions: "Needs someone free.", vendor: "openai" }), /No openai agent is free/);
  e.orch.subagents["host"].busy("codex", false);
  assert.equal(matchesVendor(e.store.getAgent("codex")!, "OpenAI"), true);
  assert.equal(matchesVendor(e.store.getAgent("claude")!, "anthropic"), true);
  assert.equal(matchesVendor(e.store.getAgent("claude")!, "codex"), false);
});

test("a helper that fails is reported as failed, counts against the budget and is logged as run_failed", async () => {
  const e = setup();
  tune(e, "codex", { transient: 1000 });
  const { goal, grant } = await seedParent(e);
  const out = await e.orch.subagents.spawn(grant, { instructions: "This one will fail.", agent: "codex" });
  assert.match(out, /failed: It could not finish: 429/);
  assert.equal(kids(e, goal.id)[0].status, "failed");
  assert.equal(e.store.getGoal(goal.id)!.state!.progress!.subagents!.spawned, 1);
  assert.equal(e.store.listRouting({ goalId: goal.id })[0].outcome, "run_failed");
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
test("AC4: a read-only child gets no write tools: Claude Code args deny Edit/Write/Bash, Codex gets --sandbox read-only", () => {
  const e = setup();
  const claude = e.store.getAgent("claude")!;
  const adapter = new ClaudeCodeAdapter();
  const flag = (args: string[], name: string) => (args[args.indexOf(name) + 1] ?? "").split(",");
  const base = { agent: claude, prompt: "x", cwd: "/tmp/w" };
  const normal = adapter.buildArgs(base);
  const ro = adapter.buildArgs({ ...base, readOnly: true });
  for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) {
    assert.ok(flag(ro, "--disallowedTools").includes(t), `${t} is denied`);
    assert.ok(!ro.slice(ro.indexOf("--allowedTools"), ro.indexOf("--disallowedTools")).some((a) => a === t || a.startsWith(`${t}(`)), `${t} is not allowed`);
  }
  assert.notDeepEqual(normal, ro);
  assert.deepEqual(claudeReadOnly({ allowed: ["Read", "Edit", "Bash(ls)"], disallowed: [] }), { allowed: ["Read"], disallowed: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"] });
  const codex = e.store.getAgent("codex")!;
  const cargs = codexBaseArgs({ agent: codex, cwd: "/tmp/w", readOnly: true }, "/tmp/out");
  assert.equal(cargs[cargs.indexOf("--sandbox") + 1], "read-only");
  assert.ok(!cargs.includes("workspace-write"));
  assert.ok(!codexBaseArgs({ agent: codex, cwd: "/tmp/w" }, "/tmp/out").includes("read-only") || codex.tools.files === false, "a normal run is not forced read-only");
  const prompt = helperPrompt({ parentName: "Claude", parentTitle: "T", title: "H", instructions: "do it please", files: [], readOnly: true, depth: 2, maxDepth: 2, others: [] });
  assert.match(prompt, /READ-ONLY/);
  assert.match(prompt, /cannot start further helpers/);
});

test("AC4: a writing child works in its OWN worktree cut from the parent's current state; nothing reaches the parent until accept_subagent, and never the goal base", async () => {
  const e = setup();
  const { goal, grant, ws, folder } = await seedParent(e, { withWs: true });
  assert.ok(ws && ws.kind === "git");
  writeFileSync(join(ws.path, "wip.txt"), "the parent's unfinished work\n"); // uncommitted: the child must start from it
  MockAdapter.calls.length = 0;
  const out = await e.orch.subagents.spawn(grant, { instructions: "Write the helper file for me.", agent: "codex", readOnly: false, files: ["helper.txt"] });
  assert.match(out, /Codex \(can write\) finished/);
  assert.match(out, /None of this is in your folder yet/);
  assert.match(out, /helper\.txt/);
  const [child] = kids(e, goal.id);
  assert.equal(child.status, "review");
  assert.equal(child.readOnly, false);
  assert.deepEqual(child.pendingMerge, { files: ["helper.txt"], conflictRounds: 0 });

  const run = taskCalls().find((c) => c.agentId === "codex")!;
  assert.notEqual(run.cwd, ws.path, "its own folder");
  assert.notEqual(run.cwd, folder);
  assert.equal(run.readOnly, undefined, "not read-only");
  assert.match(run.prompt, /You may create or change only: helper\.txt/);
  assert.equal(read(run.cwd, "wip.txt"), "the parent's unfinished work\n", "cut from the parent's current state, work in progress included");
  assert.ok(!existsSync(join(ws.path, "helper.txt")), "not in the parent's folder yet");
  assert.ok(!existsSync(join(folder, "helper.txt")), "not in the goal base");
  assert.equal(git(ws.path, "status", "--porcelain").includes("helper.txt"), false);

  const accepted = await e.orch.subagents.accept(grant, child.id);
  assert.match(accepted, /Merged into your folder: helper\.txt/);
  assert.equal(read(ws.path, "helper.txt"), "Codex wrote helper.txt\n", "in the PARENT's worktree");
  assert.equal(read(ws.path, "wip.txt"), "the parent's unfinished work\n", "the parent's own work is intact");
  assert.ok(!existsSync(join(folder, "helper.txt")), "the goal base only gets it when the parent's task is accepted");
  assert.equal(e.store.getTask(child.id)!.status, "done");
  assert.ok(!existsSync(run.cwd), "the child's worktree is gone");
  assert.equal(git(folder, "branch", "--list", "ar/sub_*"), "", "and its branch");
  assert.equal(git(folder, "for-each-ref", "refs/ar/snap"), "", "and its snapshot ref");
  assert.ok(e.store.listAudit().some((a) => a.action === "subagent.merged"));
  assert.ok(lines(e).some((l) => /took Codex's helper changes into its own folder/.test(l)));
  assert.match(await e.orch.subagents.accept(grant, child.id), /Nothing to accept/);
});

test("AC4: a writing helper needs a folder of the parent's to be cut from; without one it is refused", async () => {
  const e = setup();
  const { goal, grant } = await seedParent(e);
  const out = await e.orch.subagents.spawn(grant, { instructions: "Write something for me.", agent: "codex", readOnly: false });
  assert.match(out, /^NOT STARTED\. A helper can write only into a folder of yours/);
  assert.equal(kids(e, goal.id).length, 0);
});

test("AC4: discard_subagent drops a writing helper's work; settle drops what the parent never accepted when its run ends", async () => {
  const e = setup();
  const { goal, grant, ws, task } = await seedParent(e, { withWs: true });
  await e.orch.subagents.spawn(grant, { instructions: "Write the first file.", agent: "codex", readOnly: false, files: ["one.txt"] });
  await e.orch.subagents.spawn(grant, { instructions: "Write the second file.", agent: "hermes", readOnly: false, files: ["two.txt"] });
  const [a, b] = kids(e, goal.id);
  assert.deepEqual([a.status, b.status], ["review", "review"]);
  assert.match(await e.orch.subagents.discard(grant, a.id), /Nothing from it reached your folder/);
  assert.equal(e.store.getTask(a.id)!.status, "cancelled");
  await e.orch.subagents.settle(task.id);
  const after = e.store.getTask(b.id)!;
  assert.equal(after.status, "cancelled");
  assert.match(after.result!, /never accepted, so they were dropped/);
  assert.ok(!existsSync(join(ws!.path, "one.txt")) && !existsSync(join(ws!.path, "two.txt")), "nothing landed");
  assert.equal(e.orch.workspaces.find(goal.id, a.id), undefined);
  assert.equal(e.orch.workspaces.find(goal.id, b.id), undefined);
});

test("AC4: a clash with the parent's own work goes back to the child once, which fixes it; the merge then lands in the parent", async () => {
  const e = setup();
  tune(e, "codex", { shared: "f.txt" }); // the mock merges its line into f.txt and, like a careful agent, keeps both sides of conflict markers
  const { goal, grant, ws } = await seedParent(e, { withWs: true, files: { "f.txt": "one\n" } });
  const out = await e.orch.subagents.spawn(grant, { instructions: "Add your line to f.txt.", agent: "codex", readOnly: false, files: ["f.txt"] });
  assert.match(out, /f\.txt/);
  const [child] = kids(e, goal.id);
  writeFileSync(join(ws!.path, "f.txt"), "one\nthe parent's line\n"); // the parent edits the same place meanwhile
  MockAdapter.calls.length = 0;
  const res = await e.orch.subagents.accept(grant, child.id);
  assert.match(res, /Merged into your folder/, res);
  assert.equal(taskCalls().filter((c) => c.agentId === "codex").length, 1, "the child was asked to fix it exactly once");
  assert.match(taskCalls()[0].prompt, /merge fix/);
  const merged = read(ws!.path, "f.txt");
  assert.ok(merged.includes("the parent's line") && merged.includes("Codex wrote f.txt"), merged);
  assert.ok(!/<<<<<<<|>>>>>>>/.test(merged), "no markers left");
  assert.equal(e.store.getTask(child.id)!.status, "done");
  assert.ok(!existsSync(join(goal.folder!, "f.txt")) || read(goal.folder!, "f.txt") === "one\n", "the goal base is untouched");
});

test("AC4: when the child cannot fix a clash, the second clash puts the markers in the PARENT's folder (git and plain-folder workspaces)", async () => {
  for (const gitBin of [undefined, "/bin/false"]) {
    const e = setup({ gitBin });
    const { goal, grant, ws } = await seedParent(e, { withWs: true, files: { "f.txt": "one\ntwo\n" } });
    assert.equal(ws!.kind, gitBin ? "copy" : "git");
    const sp = e.orch.subagents.spaces;
    const child = await sp.open(goal.id, grant.taskId!, "sub_clash01", "codex");
    assert.ok(child && child.parentTaskId === grant.taskId);
    writeFileSync(join(child!.path, "f.txt"), "ONE\ntwo\n");
    await sp.finish(goal.id, "sub_clash01", "codex", "Edit f");
    writeFileSync(join(ws!.path, "f.txt"), "uno\ntwo\n");
    const meta = { childAgentId: "codex", parentAgentId: "claude", title: "Edit f" };
    const first = await sp.merge(goal.id, grant.taskId!, "sub_clash01", { ...meta, round: 0 });
    assert.deepEqual([first.ok, !first.ok && first.to, !first.ok && first.conflict], [false, "child", ["f.txt"]]);
    assert.equal(read(ws!.path, "f.txt"), "uno\ntwo\n", "the first clash leaves the parent exactly as it was");
    assert.match(read(child!.path, "f.txt"), /<<<<<<<|=======/, "the child's folder holds the parent's latest work, with markers");
    assert.equal((await sp.merge(goal.id, grant.taskId!, "sub_clash01", { ...meta, round: 0 })).ok, false, "markers still in the child: it cannot merge");
    // The child "fixed" it by restoring its own file; the parent has moved on again meanwhile: second clash goes to the parent.
    writeFileSync(join(child!.path, "f.txt"), "ONE\ntwo\n");
    await sp.finish(goal.id, "sub_clash01", "codex", "Edit f");
    writeFileSync(join(ws!.path, "f.txt"), "eins\ntwo\n");
    const second = await sp.merge(goal.id, grant.taskId!, "sub_clash01", { ...meta, round: 1 });
    assert.deepEqual([second.ok, !second.ok && second.to], [false, "parent"]);
    assert.match(read(ws!.path, "f.txt"), /<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/, "markers are in the parent's folder");
    await sp.discard(goal.id, "sub_clash01");
    assert.equal(e.orch.workspaces.find(goal.id, "sub_clash01"), undefined);
  }
});

test("a plain-folder (no git) workspace works too: the helper's change is copied into the parent's folder on accept", async () => {
  const e = setup({ gitBin: "/bin/false" });
  const { goal, grant, ws } = await seedParent(e, { withWs: true });
  assert.equal(ws!.kind, "copy");
  await e.orch.subagents.spawn(grant, { instructions: "Write the helper file for me.", agent: "codex", readOnly: false, files: ["helper.txt"] });
  const [child] = kids(e, goal.id);
  assert.equal(child.status, "review");
  assert.ok(!existsSync(join(ws!.path, "helper.txt")));
  assert.match(await e.orch.subagents.accept(grant, child.id), /Merged into your folder: helper\.txt/);
  assert.equal(read(ws!.path, "helper.txt"), "Codex wrote helper.txt\n");
  assert.ok(!existsSync(join(goal.folder!, "helper.txt")));
});

test("the child's output is not judged: no judge call, no scoring, and the parent's goal does not see a plan task", async () => {
  const e = setup();
  const { goal, grant } = await seedParent(e);
  MockAdapter.calls.length = 0;
  await e.orch.subagents.spawn(grant, { instructions: "A quick read of the exports.", agent: "codex" });
  assert.ok(!MockAdapter.calls.some((c) => c.kind === "JUDGE"), "nobody judged it");
  assert.equal(e.store.listTasks({ goalId: goal.id }).length, 1, "the plan still has its one task");
  assert.equal(kids(e, goal.id)[0].history!.at(-1)!.outcome, "ok");
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
test("AC5: Claude Code stream-json: Agent/Task launches become native children, running then done; results, errors and background launches are told apart", () => {
  const events: NativeEvent[] = [];
  const t = new NativeTracker((x) => events.push(x));
  for (const l of readFileSync(join(here, "fixtures", "claude-subagents.stream.jsonl"), "utf8").split("\n").filter(Boolean)) t.claude(JSON.parse(l));
  const brief = events.map((x) => `${x.phase}:${x.id}${x.phase === "end" ? `:${x.ok}` : ""}`);
  assert.deepEqual(brief, ["start:toolu_A1", "end:toolu_A1:true", "start:toolu_B2", "end:toolu_B2:false", "start:toolu_C3"], "a background launch stays open");
  assert.equal(events[0].description, "Check the SQL");
  assert.equal(events[0].subagentType, "code-reviewer");
  assert.match(events[0].prompt!, /db\/queries.sql/);
  assert.equal(events[1].result, "The join on line 3 is missing a key.");
  assert.ok(!events.some((x) => x.id === "toolu_in1"), "a subagent's own tool calls are not launches");
  t.finish(true);
  assert.deepEqual(events.at(-1), { phase: "end", id: "toolu_C3", description: "Watch the build", subagentType: "general-purpose", prompt: "Watch CI.", ok: true });
  // tolerant: junk never throws
  for (const junk of [null, 5, "x", [], {}, { type: "assistant" }, { type: "assistant", message: { content: "no" } }, { type: "user", message: { content: [{ type: "tool_result" }] } }]) t.claude(junk);
});

test("AC5: Codex collab_tool_call events become native children too (shape not checked against a live Codex)", () => {
  const events: NativeEvent[] = [];
  const t = new NativeTracker((x) => events.push(x));
  for (const l of readFileSync(join(here, "fixtures", "codex-subagents.events.jsonl"), "utf8").split("\n").filter(Boolean)) t.codex(JSON.parse(l));
  assert.deepEqual(events.map((x) => `${x.phase}:${x.id}`), ["start:th_sub1", "end:th_sub1"], "the started and completed copies of the same spawn are one subagent");
  assert.equal(events[1].result, "The join is missing a key.");
  for (const junk of [null, 1, {}, { item: 3 }, { item: { type: "collab_tool_call" } }, { item: { type: "collab_tool_call", tool: "spawn_agent", receiver_thread_ids: "no" } }]) t.codex(junk);
});

test("AC5: native subagents are saved as children of the running task, shown in the tree and the ledger, but never routed, judged or budgeted", () => {
  const e = setup();
  limits(e, { budgetPerGoal: 1 });
  return seedParent(e).then(async ({ goal: g, task: t, grant }) => {
    const events: ServerEvent[] = [];
    e.store.on("event", (ev: ServerEvent) => events.push(ev));
    const tracker = new NativeTracker((x) => e.orch.subagents.native(t.id, "claude", x));
    for (const l of readFileSync(join(here, "fixtures", "claude-subagents.stream.jsonl"), "utf8").split("\n").filter(Boolean)) tracker.claude(JSON.parse(l));
    tracker.finish(true);
    const nat = kids(e, g.id);
    assert.equal(nat.length, 3);
    assert.ok(nat.every((n) => n.native === true && n.kind === "subagent" && n.parentTaskId === t.id && n.depth === 1 && n.spawnedBy === "claude"));
    assert.deepEqual(nat.map((n) => n.status).sort(), ["done", "done", "failed"]);
    assert.ok(events.filter((x) => x.type === "subagent").length >= 6, "each start and end went out as a subagent event");
    const p = e.store.getGoal(g.id)!.state!.progress!;
    assert.deepEqual(p.subagents, { spawned: 0, native: 3 });
    assert.equal(p.runs, 0, "not counted as task runs");
    assert.equal(e.store.listRouting({ goalId: g.id }).length, 0, "not routed");
    assert.match(ledgerMarkdown(e.store.getGoal(g.id)!, [], e.store.listAgents(), 1), /Helpers: 0 of 1 started, 3 built-in \(not counted\)/);
    // the real budget is untouched: a room helper can still start
    assert.match(await e.orch.subagents.spawn(grant, { instructions: "A real helper, please.", agent: "codex" }), /finished/);
    assert.equal(e.orch.subagents.status(grant).split("\n").filter((l) => l.includes("| native |")).length, 3);
  });
});

test("AC5: the Claude Code adapter feeds a real stream into the tree (a stand-in claude binary prints the fixture)", async () => {
  const e = setup();
  const bin = join(mkdtempSync(join(tmpdir(), "fakeclaude-")), "claude");
  writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(require("node:fs").readFileSync(${JSON.stringify(join(here, "fixtures", "claude-subagents.stream.jsonl"))}, "utf8"));\n`);
  chmodSync(bin, 0o755);
  const agent = { ...e.store.getAgent("claude")!, adapter: "claude-code" as const, settings: { binary: bin } };
  const got: NativeEvent[] = [];
  const res = await new ClaudeCodeAdapter().run({ agent, prompt: "# Your task: x", cwd: mkdtempSync(join(tmpdir(), "cwd-")), onSubagent: (x) => got.push(x) });
  assert.equal(res.ok, true);
  assert.match(res.text, /Done\. The SQL join/);
  assert.deepEqual(got.filter((x) => x.phase === "start").map((x) => x.id), ["toolu_A1", "toolu_B2", "toolu_C3"]);
  assert.equal(got.at(-1)!.phase, "end", "the background one is closed when the run ends");
  const quiet = await new ClaudeCodeAdapter().run({ agent, prompt: "# Your task: x", cwd: mkdtempSync(join(tmpdir(), "cwd-")) });
  assert.equal(quiet.ok, true, "no callback, no tracker: nothing else changes");
});

test("native children are wired through the orchestrator call: only a task run (not a JSON call, a practice run or a chat) reports them", async () => {
  const e = setup();
  const { goal, task } = await seedParent(e);
  const orig = adapters.mock.run.bind(adapters.mock);
  let n = 0;
  adapters.mock.run = async (req) => { // a stand-in for an agent whose own tool launches a subagent
    if (req.onSubagent) { n++; req.onSubagent({ phase: "start", id: `x${n}`, description: "Look around" }); req.onSubagent({ phase: "end", id: `x${n}`, ok: true, result: "found it" }); }
    return orig(req);
  };
  try {
    const claude = e.store.getAgent("claude")!;
    await e.orch.call(claude, "# Your task: x", { roomId: e.room.id, taskId: task.id });
    const [native] = kids(e, goal.id);
    assert.equal(native.title, "Look around");
    assert.equal(native.status, "done");
    assert.equal(native.result, "found it");
    assert.equal(native.parentTaskId, task.id);
    await e.orch.call(claude, "[[PLAN]] x", { jsonOnly: true, roomId: e.room.id, taskId: task.id });
    await e.orch.call(claude, "# Your task: x", { roomId: e.room.id, taskId: task.id, shadow: true });
    await e.orch.call(claude, "# Your task: x", { roomId: e.room.id });
    assert.equal(n, 1, "the adapter was given the hook once, for the task run only");
    assert.equal(kids(e, goal.id).length, 1);
  } finally { adapters.mock.run = orig; }
  e.orch.subagents.native("task_missing", "claude", { phase: "start", id: "x9" }); // an unknown parent is ignored, not an error
  assert.equal(kids(e, goal.id).length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
test("helpers that were running when the hub stopped are cancelled on restart, not picked up again", async () => {
  const e = setup();
  const { goal, task } = await seedParent(e);
  const orphan: Task = { ...task, id: id("sub"), kind: "subagent", parentTaskId: task.id, depth: 1, spawnedBy: "claude", status: "running", readOnly: true, assignee: "codex", owner: "codex" };
  e.store.saveTask(orphan);
  assert.equal(e.orch.subagents.cancelOrphans(), 1);
  assert.equal(e.store.getTask(orphan.id)!.status, "cancelled");
  assert.equal(e.store.getTask(task.id)!.status, "running", "the parent is not touched here");
  assert.equal(e.store.listTasks({ goalId: goal.id }).length, 1);
});

test("stopping the parent's run stops its running helpers", async () => {
  const e = setup();
  tune(e, "codex", { delayMs: 5000 });
  const { goal, task, grant } = await seedParent(e);
  const ctrl = new AbortController();
  (e.orch as unknown as { taskRuns: Map<string, unknown> }).taskRuns.set(task.id, { ctrl });
  const started = await e.orch.subagents.spawn(grant, { instructions: "A slow helper that will be stopped.", agent: "codex", wait: false });
  assert.match(started, /Started helper/);
  const [kid] = kids(e, goal.id);
  ctrl.abort();
  await until(() => e.store.getTask(kid.id)!.status !== "running" && !e.orch.subagents.readOnlyNow("codex"));
  assert.equal(e.store.getTask(kid.id)!.status, "cancelled");
  assert.equal(e.store.listRouting({ taskId: kid.id })[0].outcome, "interrupted");
  assert.equal(e.orch.subagents.readOnlyNow("codex"), false);
});

test("settings: the subagents limits can be set through the API and are validated", async () => {
  const e = await boot();
  const pair = await fetch(`${e.base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: (e.app as unknown as { pairingCode: () => string }).pairingCode(), deviceName: "Mac" }) });
  const h = { authorization: `Bearer ${((await pair.json()) as { token: string }).token}`, "content-type": "application/json" };
  const ok = await fetch(`${e.base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ subagents: { maxDepth: 1, budgetPerGoal: 9 } }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(subagentSettings(e.store), { maxDepth: 1, budgetPerGoal: 9, maxParallel: 3 }, "unset fields keep their defaults");
  const bad = await fetch(`${e.base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ subagents: { maxDepth: 40 } }) });
  assert.ok(bad.status >= 400);
  assert.equal(subagentSettings(e.store).maxDepth, 1);
  await e.app.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
test("AC2: the phone has a Tasks sheet in the room header that draws helpers under their parent (no inline styles, colours by data-color)", () => {
  const web = join(here, "..", "web");
  const html = readFileSync(join(web, "index.html"), "utf8"), js = readFileSync(join(web, "app.js"), "utf8"), css = readFileSync(join(web, "app.css"), "utf8");
  assert.match(html, /<button id="tasksBtn" class="pill quiet" hidden>Tasks<\/button>/);
  assert.match(js, /\$\("#tasksBtn"\)\.hidden = st\.view !== "room"/, "only inside a room");
  assert.match(js, /case "task": case "subagent": upsertTask\(e\.task\)/, "it follows task and subagent events live");
  assert.match(js, /api\(`\/rooms\/\$\{st\.taskRoom\}\/tasks`\)/);
  assert.doesNotMatch(js.slice(js.indexOf("function renderTasks"), js.indexOf("function renderRooms")), /style=/, "strict CSP: no inline styles");
  assert.match(css, /\.trow\.d1 \{ padding-left/);
  // the tree order, run for real
  const src = js.slice(js.indexOf("function taskTree"), js.indexOf("async function openTasks"));
  const taskTree = new Function(`${src}; return taskTree;`)() as (l: Partial<Task>[]) => { task: { id: string }; depth: number }[];
  const rows = taskTree([
    { id: "c2", parentTaskId: "p1", createdAt: 5 }, { id: "p2", createdAt: 3 }, { id: "g1", parentTaskId: "c1", createdAt: 6 },
    { id: "p1", createdAt: 1 }, { id: "c1", parentTaskId: "p1", createdAt: 2 }, { id: "orphan", parentTaskId: "gone", createdAt: 9 },
  ]);
  assert.deepEqual(rows.map((r) => `${r.depth}:${r.task.id}`), ["0:p1", "1:c1", "2:g1", "1:c2", "0:p2", "0:orphan"]);
});

test("AC2: the Mac app lists helpers under their parent with a read-only / writes / built-in badge", () => {
  const app = join(here, "..", "..", "app", "src");
  const tree = readFileSync(join(app, "components", "SubagentTree.tsx"), "utf8");
  for (const f of ["components/TaskPanel.tsx", "screens/RoomScreen.tsx"]) {
    const s = readFileSync(join(app, f), "utf8");
    assert.match(s, /treeRows\(/, `${f} uses the tree`);
    assert.match(s, /<HelperBadge task=\{task\} \/>/, `${f} shows the badge`);
    assert.match(s, /marginLeft: depth \* space\(4\)/, `${f} indents children`);
  }
  assert.match(tree, /"built-in" : t\.readOnly === false \? "writes" : "read-only"/);
  assert.match(readFileSync(join(app, "state", "store.ts"), "utf8"), /case "subagent":/);
});
