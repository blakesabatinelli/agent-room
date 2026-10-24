import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentConfig, Goal, Task } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { presetAgent } from "../src/discovery/invite.js";
import { needsGate, needsMessage } from "../src/discovery/routing.js";
import { classifyFailure, isPlacementBlock } from "../src/orchestrator/failures.js";
import { newProgress, validatePlan, type RawPlanTask } from "../src/orchestrator/ledger.js";
import { planPrompt, recoverPrompt, taskPrompt, verifyPrompt } from "../src/orchestrator/prompts.js";
import { WORKSPACE_NEED, isLoopbackAddress, recordConnection, runsHere, taskNeedsWorkspace, withWorkspaceNeed } from "../src/placement/index.js";
import { WRITE_RULE, WRITE_RULE_PLAN, relativizeTask, taskWritePaths, writePathsIn } from "../src/placement/paths.js";
import { helperPrompt } from "../src/subagents/prompts.js";
import { id, now } from "../src/util.js";
import { localPairHeaders, setup } from "./helpers.js";

type Env = ReturnType<typeof setup>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20); };
const keepOrder = (store: Env["store"]) => { for (const a of ["claude", "codex", "hermes"]) store.saveAgent(store.getAgent(a)!); };
const tune = (e: Env, aid: string, patch: Partial<AgentConfig> & { settings?: Record<string, unknown> }) => {
  const a = e.store.getAgent(aid)!;
  e.store.saveAgent({ ...a, ...patch, settings: { ...a.settings, ...(patch.settings ?? {}) } });
  keepOrder(e.store);
};
const autoRun = (e: Env) => e.store.setSettings({ ...e.store.getSettings(), planApproval: "never", autoRunChecks: true });
const agent = (over: Partial<AgentConfig>): AgentConfig => ({ id: "x", name: "X", provider: "x", adapter: "mock", enabled: true, color: "#000", settings: {}, tools: { web: true, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false }, ...over });

// ---------------------------------------------------------------- 1. write paths

test("prompts: the planner and every task prompt say an agent writes only inside its task folder, with relative paths", () => {
  const agents = [agent({ id: "claude", name: "Claude" })];
  assert.match(planPrompt("Make a baseline copy", agents, [], []), /only inside their own task folder[^]*Never tell a task to write to \/tmp/);
  assert.ok(planPrompt("g", agents, [], []).includes(WRITE_RULE_PLAN));
  assert.ok(recoverPrompt("g", undefined, "", [], agents, "why").includes(WRITE_RULE_PLAN));
  assert.ok(verifyPrompt("g", undefined, [], "", agents, 0).includes(WRITE_RULE_PLAN));
  const task = { id: "t", title: "Do it", description: "Do the thing.", criteria: [{ id: "AC1", text: "done" }], dependsOn: [] } as unknown as Task;
  const withFolder = taskPrompt(task, "g", undefined, [], [], [], [], agents, "claude", undefined, { path: "/work/task", files: [] });
  assert.ok(withFolder.includes(WRITE_RULE));
  assert.match(withFolder, /never in \/tmp or at another absolute path/);
  const noFolder = taskPrompt(task, "g", undefined, [], [], [], [], agents, "muse");
  assert.doesNotMatch(noFolder, /# Shared folder/);
  assert.match(noFolder, /no task folder on your machine: hand your work back as text/);
  const helper = helperPrompt({ parentName: "Claude", parentTitle: "T", title: "H", instructions: "do", files: [], readOnly: false, depth: 1, maxDepth: 2, others: [] });
  assert.match(helper, /Write only inside that folder, with relative paths. Never write to \/tmp/);
});

test("write paths: what counts as a place to write, and what stays a read", () => {
  assert.deepEqual(writePathsIn("Make a baseline copy and write it to /tmp/vizio-cdp-baseline."), ["/tmp/vizio-cdp-baseline"]);
  assert.deepEqual(writePathsIn("git init in ~/work/baseline, then commit"), ["~/work/baseline"]);
  assert.deepEqual(writePathsIn("cp -r src /Users/blake/out && echo ok"), ["/Users/blake/out"]);
  assert.deepEqual(writePathsIn("Save the notes to $HOME/notes.md"), ["$HOME/notes.md"]);
  assert.deepEqual(writePathsIn("Read /Users/blake/granted/notes.md and summarize it."), [], "reading a granted folder is fine");
  assert.deepEqual(writePathsIn("Copy the findings from /Users/blake/granted/notes.md into findings.md"), [], "a path it copies from is a read");
  assert.deepEqual(writePathsIn("Use the API at https://example.com/Users/list and write summary.md"), []);
  assert.deepEqual(writePathsIn("Roughly ~5 items, and/or more"), []);
  const t = { description: "Write it to /tmp/a.", output: "/tmp/a", files: ["~/x/b.md", "c.md"] };
  assert.deepEqual(taskWritePaths(t).sort(), ["/tmp/a", "~/x/b.md"]);
  assert.deepEqual(taskWritePaths({ files: ["/data/goals/g1/out.md"] }, "/data/goals/g1"), [], "inside the goal's folder is not outside it");
  const fixed = relativizeTask({ ...t, criteria: [{ text: "exists", check: "test -d /tmp/a" }, "text"] }, undefined);
  assert.equal(fixed.length, 2);
});

test("plan gate: a task told to write to /tmp or another absolute path is sent back with a plain reason; reading a granted folder is not", () => {
  const base: RawPlanTask = { key: "t1", title: "Baseline", description: "Make a git baseline copy of the tree and write it to /tmp/vizio-cdp-baseline.", output: "/tmp/vizio-cdp-baseline", criteria: ["It exists"], covers: ["G1"] };
  const reqs = [{ id: "G1", text: "A baseline copy exists", status: "open" as const }];
  const problems = validatePlan([base], reqs, new Set(["codex"]));
  assert.equal(problems.length, 1, "one problem per path, not one per field");
  assert.match(problems[0], /Task t1 is told to write to \/tmp\/vizio-cdp-baseline, outside its task folder/);
  assert.match(problems[0], /relative path \(for example "vizio-cdp-baseline"\)/);
  assert.match(problems[0], /Reading from a granted folder is fine/);
  assert.doesNotMatch(problems[0], /—/, "plain copy");
  const reads: RawPlanTask = { ...base, description: "Read /Users/blake/granted/notes.md and summarize it into summary.md.", output: "summary.md" };
  assert.deepEqual(validatePlan([reads], reqs, new Set(["codex"])), []);
  const inside: RawPlanTask = { ...base, description: "Write the full result into the goal folder.", output: "/data/goals/g1/out.md" };
  assert.deepEqual(validatePlan([inside], reqs, new Set(["codex"]), { goalFolder: "/data/goals/g1" }), []);
});

test("plan gate end to end: the planner is sent the reason, and the repaired plan carries no absolute path", async () => {
  const e = setup(); autoRun(e);
  tune(e, "claude", { settings: { absPath: true } });
  const base = MockAdapter.calls.length;
  const goal = await e.orch.runGoal(e.room.id, "Make a git baseline copy of the vizio tree");
  assert.equal(goal.status, "done");
  const plans = MockAdapter.calls.slice(base).filter((c) => c.kind === "PLAN" && c.agentId === "claude");
  assert.equal(plans.length, 2, "asked again once");
  assert.match(plans[1].prompt, /Task a is told to write to \/tmp\/vizio-cdp-baseline, outside its task folder/);
  const tasks = e.store.listTasks({ goalId: goal.id }).filter((t) => t.origin === "plan");
  assert.ok(tasks.every((t) => !/\/tmp\//.test(`${t.description} ${t.output ?? ""}`)));
});

test("plan gate: a path the planner still doesn't fix is rewritten to a relative one, and the room is told", async () => {
  const e = setup(); autoRun(e);
  tune(e, "claude", { settings: { absPath: true, absPathStays: true } });
  const goal = await e.orch.runGoal(e.room.id, "Make a git baseline copy of the vizio tree");
  const a = e.store.listTasks({ goalId: goal.id }).find((t) => t.title === "Research the topic")!;
  assert.equal(a.output, "vizio-cdp-baseline");
  assert.match(a.description, /write it to vizio-cdp-baseline\./);
  assert.ok(e.store.listMessages(e.room.id, 500).some((m) => /Agents can only write inside their task folder, so \/tmp\/vizio-cdp-baseline became vizio-cdp-baseline/.test(m.text)));
});

// ---------------------------------------------------------------- 2. agents that don't run on this Mac

test("runsHere: the hub's own adapters run here; an MCP agent runs here only when its connections come from loopback; the owner's setting wins", () => {
  for (const adapter of ["claude-code", "codex", "acp", "command", "openai-api", "mock"] as const) assert.equal(runsHere(agent({ adapter })), true, adapter);
  const mcp = (over: Partial<AgentConfig>) => agent({ adapter: "mcp", ...over });
  assert.equal(runsHere(mcp({})), false, "never heard from: not here");
  assert.equal(runsHere(mcp({ connectsFrom: { address: "127.0.0.1", loopback: true, at: 1 } })), true);
  assert.equal(runsHere(mcp({ connectsFrom: { address: "100.101.102.103", loopback: false, at: 1 } })), false, "Tailscale 100.x");
  assert.equal(runsHere(mcp({ location: "here", connectsFrom: { address: "100.101.102.103", loopback: false, at: 1 } })), true, "owner says it is here");
  assert.equal(runsHere(mcp({ location: "elsewhere", connectsFrom: { address: "127.0.0.1", loopback: true, at: 1 } })), false, "owner says it is not");
  assert.equal(runsHere(agent({ adapter: "codex", location: "elsewhere" })), false);
  assert.ok(isLoopbackAddress("::ffff:127.0.0.1") && isLoopbackAddress("::1") && !isLoopbackAddress("100.64.0.9") && !isLoopbackAddress(undefined));
});

test("a task works on the task folder when it writes files, has a command check, hands back a file or is coding, unless the planner says otherwise", () => {
  assert.equal(taskNeedsWorkspace({ files: ["a.md"] }), true);
  assert.equal(taskNeedsWorkspace({ criteria: [{ text: "x", check: "test -s a.md" }] }), true);
  assert.equal(taskNeedsWorkspace({ output: "summary.md" }), true);
  assert.equal(taskNeedsWorkspace({ taskType: "coding" }), true);
  assert.equal(taskNeedsWorkspace({ output: "the result, in the reply", criteria: ["x"], taskType: "research" }), false);
  assert.equal(taskNeedsWorkspace({ output: "e.g. a short list", taskType: "research" }), false);
  assert.equal(taskNeedsWorkspace({ files: ["a.md"], workspace: false }), false, "the planner's word wins");
  assert.equal(taskNeedsWorkspace({ output: "answer", workspace: true }), true);
  assert.deepEqual(withWorkspaceNeed(["salesforce"], { files: ["a.md"] }), ["salesforce", WORKSPACE_NEED]);
  assert.deepEqual(withWorkspaceNeed(["salesforce", "workspace"], { workspace: false }), ["salesforce"]);
  assert.deepEqual(withWorkspaceNeed(["workspace"], {}), ["workspace"], "named in needs and not contradicted");
});

test("where an MCP agent connects from is recorded: loopback is this Mac; a Tailscale address or a proxied call is elsewhere; changes are audited", () => {
  const e = setup();
  e.store.saveAgent(presetAgent("muse")!);
  recordConnection(e.store, "muse", { address: "::ffff:127.0.0.1" }, 1000);
  assert.deepEqual(e.store.getAgent("muse")!.connectsFrom, { address: "127.0.0.1", loopback: true, at: 1000 });
  assert.equal(runsHere(e.store.getAgent("muse")!), true);
  recordConnection(e.store, "muse", { address: "100.101.102.103" }, 2000);
  assert.deepEqual(e.store.getAgent("muse")!.connectsFrom, { address: "100.101.102.103", loopback: false, at: 2000 });
  assert.equal(runsHere(e.store.getAgent("muse")!), false);
  recordConnection(e.store, "muse", { address: "127.0.0.1", proxied: true }, 3000);
  assert.equal(e.store.getAgent("muse")!.connectsFrom!.loopback, false, "a proxied call arrives from 127.0.0.1 but is not the Mac's own");
  assert.ok(e.store.listAudit().some((a) => a.action === "agent.location" && /muse connects from 100\.101\.102\.103 \(another machine\)/.test(a.detail)));
  const before = e.store.listAudit().length;
  recordConnection(e.store, "muse", { address: "127.0.0.1", proxied: true }, 3500); // same place again: nothing to write
  assert.equal(e.store.listAudit().length, before);
  recordConnection(e.store, "claude", { address: "100.1.1.1" }); // not an MCP agent: ignored
  assert.equal(e.store.getAgent("claude")!.connectsFrom, undefined);
});

test("POST /mcp records where an external agent connects from, and the owner's setting overrides it", async () => {
  const e = setup();
  e.store.saveAgent(presetAgent("muse")!);
  const app = await buildServer({ ...e, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const { token } = (await (await fetch(`${base}/pair/local`, { method: "POST", headers: localPairHeaders(e.dir), body: "{}" })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const key = ((await (await fetch(`${base}/mcp-tokens`, { method: "POST", headers: h, body: JSON.stringify({ agentId: "muse", name: "Muse" }) })).json()) as { token: string }).token;
  const call = async (extra: Record<string, string> = {}) => {
    const c = new Client({ name: "muse", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}`, ...extra } } }));
    await c.listTools(); await c.close();
  };
  await call();
  assert.equal(e.store.getAgent("muse")!.connectsFrom?.loopback, true, "straight to the hub on this Mac");
  assert.equal(runsHere(e.store.getAgent("muse")!), true);
  await call({ "x-forwarded-for": "100.88.1.2", "x-forwarded-host": "mac.tail1.ts.net", "x-forwarded-proto": "https" });
  assert.deepEqual([e.store.getAgent("muse")!.connectsFrom!.address, e.store.getAgent("muse")!.connectsFrom!.loopback], ["100.88.1.2", false]);
  assert.equal(runsHere(e.store.getAgent("muse")!), false);
  const put = await fetch(`${base}/agents/muse`, { method: "PUT", headers: h, body: JSON.stringify({ location: "here" }) });
  assert.equal(((await put.json()) as AgentConfig).location, "here");
  assert.equal(runsHere(e.store.getAgent("muse")!), true, "the owner's setting wins");
  assert.equal(e.store.getAgent("muse")!.connectsFrom!.address, "100.88.1.2", "what was seen is kept");
  assert.equal((await fetch(`${base}/agents/muse`, { method: "PUT", headers: h, body: JSON.stringify({ location: "mars" }) })).status >= 400, true);
  await app.close();
});

/** Demo room where hermes is Muse: it runs somewhere else. Claude plans with files (every task works on the task folder) when `checks`. */
function museRoom(checks: boolean) {
  const e = setup(); autoRun(e);
  tune(e, "hermes", { location: "elsewhere" });
  if (checks) tune(e, "claude", { settings: { checks: true } });
  return e;
}

test("routing: a task that works on the task folder never goes to an agent that runs elsewhere, even as the planned owner", async () => {
  const e = museRoom(true);
  const base = MockAdapter.calls.length;
  const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const tasks = e.store.listTasks({ goalId: goal.id }).filter((t) => t.origin === "plan");
  assert.ok(tasks.length >= 2);
  for (const t of tasks) { assert.ok(t.needs?.includes(WORKSPACE_NEED), `${t.title} works on its folder`); assert.notEqual(t.assignee, "hermes", `${t.title} not to the agent that runs elsewhere`); }
  assert.ok(MockAdapter.calls.slice(base).filter((c) => c.kind === "TASK").every((c) => c.agentId !== "hermes"), "hermes never ran a task");
  for (const r of e.store.listRouting({ goalId: goal.id }).filter((x) => x.kind === "task")) {
    assert.ok(r.candidates.every((c) => c.agentId !== "hermes"), "not even a candidate");
    assert.deepEqual(r.needsFilteredOut, [{ agentId: "hermes", missing: [WORKSPACE_NEED] }]);
  }
  const plan = MockAdapter.calls.slice(base).find((c) => c.kind === "PLAN" && c.agentId === "claude")!;
  assert.match(plan.prompt, /hermes: .*runs on another machine: no task folder or shell, give it text-only work/);
  assert.match(plan.prompt, /"workspace"/);
});

test("routing: text-only work still goes to an agent that runs elsewhere, and its prompt has no task folder", async () => {
  const e = museRoom(false);
  const base = MockAdapter.calls.length;
  const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const tasks = e.store.listTasks({ goalId: goal.id }).filter((t) => t.origin === "plan");
  assert.ok(tasks.every((t) => !t.needs?.includes(WORKSPACE_NEED)), "answers returned in the reply need no folder");
  const mine = MockAdapter.calls.slice(base).filter((c) => c.kind === "TASK" && c.agentId === "hermes");
  assert.equal(mine.length, 1, "hermes took the writing task it was planned for");
  assert.doesNotMatch(mine[0].prompt, /# Shared folder/);
  assert.match(mine[0].prompt, /no task folder on your machine/);
  const other = MockAdapter.calls.slice(base).filter((c) => c.kind === "TASK" && c.agentId !== "hermes");
  assert.ok(other.every((c) => /# Shared folder/.test(c.prompt) && c.prompt.includes(WRITE_RULE)), "agents on this Mac get the folder and the rule");
});

test("routing: when no agent that runs on this Mac is switched on, the room is told in one plain line and nothing is handed to the others", async () => {
  const e = museRoom(true);
  tune(e, "claude", { location: "elsewhere" }); tune(e, "codex", { location: "elsewhere" });
  const base = MockAdapter.calls.length;
  const p = e.orch.runGoal(e.room.id, "Summarize the venue TV market");
  const says = () => e.store.listMessages(e.room.id, 500).filter((m) => m.author.kind === "system" && /works in its task folder/.test(m.text));
  await until(() => says().length > 0);
  await sleep(500);
  assert.equal(says().length, 1, "once");
  assert.match(says()[0].text, /none of your agents that run on this Mac is switched on\. Claude runs on another machine, Codex runs on another machine, Hermes runs on another machine and can't reach it\. It waits until one is\./);
  assert.equal(MockAdapter.calls.slice(base).filter((c) => c.kind === "TASK").length, 0);
  e.orch.stopRoom(e.room.id);
  await p;
});

test("routing: when the agents that run on this Mac are all offline, the room is told once and the task waits", async () => {
  const e = museRoom(true);
  tune(e, "claude", { location: "elsewhere" });
  tune(e, "codex", { adapter: "mcp", location: "here" }); // runs here but has not connected: not ready
  const base = MockAdapter.calls.length;
  const p = e.orch.runGoal(e.room.id, "Summarize the venue TV market");
  const says = () => e.store.listMessages(e.room.id, 500).filter((m) => m.author.kind === "system" && /none of the agents that run on this Mac is available right now/.test(m.text));
  await until(() => says().length > 0);
  await sleep(500);
  assert.equal(says().length, 1, "once");
  assert.match(says()[0].text, /It starts as soon as one is\./);
  assert.equal(MockAdapter.calls.slice(base).filter((c) => c.kind === "TASK").length, 0, "the agents that run elsewhere were not given it");
  e.orch.stopRoom(e.room.id);
  await p;
});

test("needsGate and needsMessage know the workspace need", () => {
  const away = agent({ id: "muse", name: "Muse", adapter: "mcp", connectsFrom: { address: "100.64.0.5", loopback: false, at: 1 } });
  const here = agent({ id: "codex", name: "Codex", adapter: "codex" });
  const g = needsGate({ roomId: "r", needs: ["workspace"] }, [away, here])!;
  assert.deepEqual([...g.ok], ["codex"]);
  assert.deepEqual(g.filteredOut, [{ agentId: "muse", missing: ["workspace"] }]);
  assert.deepEqual(g.nobody, []);
  const none = needsGate({ roomId: "r", needs: ["workspace"] }, [away])!;
  assert.deepEqual(none.nobody, ["workspace"]);
  assert.equal(needsMessage(none, "Copy it", [away]), `"Copy it" works in its task folder, and none of your agents that run on this Mac is switched on. Muse runs on another machine (100.64.0.5) and can't reach it. It waits until one is.`);
});

test("helpers: a helper goes only to an agent that runs on this Mac, by name or by routing", async () => {
  const e = setup();
  tune(e, "codex", { location: "elsewhere" });
  const goalId = id("goal"), taskId = id("task");
  const goal: Goal = { id: goalId, roomId: e.room.id, text: "Review the data", status: "running", createdAt: now(), approvedAt: now(), contract: { objective: "x", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: now(), amendments: [], requirements: [] }, state: { decisions: [], nextAction: "", progress: newProgress() } };
  e.store.saveGoal(goal);
  e.store.saveTask({ id: taskId, roomId: e.room.id, goalId, title: "Review", description: "Review it carefully.", taskType: "analysis", acceptance: "AC1: Done.", dependsOn: [], owner: "claude", assignee: "claude", role: "worker", files: [], status: "running", attempts: 1, history: [], createdAt: now(), updatedAt: now() } as Task);
  const grant = { agentId: "claude", roomId: e.room.id, taskId, hop: 0 };
  const named = await e.orch.subagents.spawn(grant, { instructions: "Check the SQL in the queries file.", agent: "codex" });
  assert.match(named, /Codex runs on another machine and can't use a folder here, which a helper needs/);
  // hermes is the only other agent that runs here; "any" picks it and never codex
  MockAdapter.calls.length = 0;
  const any = await e.orch.subagents.spawn(grant, { instructions: "Check the SQL in the queries file.", readOnly: true });
  assert.match(any, /Hermes \(read-only\) finished/);
  assert.ok(MockAdapter.calls.every((c) => c.agentId !== "codex"));
  tune(e, "hermes", { location: "elsewhere" });
  const none = await e.orch.subagents.spawn(grant, { instructions: "Check the SQL in the queries file.", readOnly: true });
  assert.match(none, /No other agent that runs on this Mac is free right now/);
});

test("replacement routes: a replacement task that works on the folder is not for an agent that runs elsewhere", async () => {
  const e = setup(); autoRun(e);
  tune(e, "hermes", { location: "elsewhere" });
  tune(e, "claude", { settings: { recoverOwner: "hermes", recoverWorkspace: true } });
  const { goal, stuck } = seedGoal(e, [{ key: "T1", status: "failed", covers: ["G1"] }], ["G1"]);
  await (e.orch as unknown as Recover).recoverGoal(goal, [stuck.T1], "it failed", new AbortController().signal);
  const fresh = e.store.listTasks({ goalId: goal.id }).filter((t) => t.origin === "recovery");
  assert.equal(fresh.length, 1);
  assert.ok(fresh[0].needs?.includes(WORKSPACE_NEED));
  assert.deepEqual([...needsGate(fresh[0], e.store.listAgents().filter((a) => a.enabled))!.ok].sort(), ["claude", "codex"]);
});

// ---------------------------------------------------------------- 3. duplicate work

type Recover = { recoverGoal(goal: Goal, stuck: Task[], why: string, signal: AbortSignal): Promise<boolean> };
/** A goal with requirements G1..Gn and tasks in the given states, written straight into the store. */
function seedGoal(e: Env, specs: { key: string; status: Task["status"]; covers: string[] }[], reqIds: string[], unmet: string[] = []) {
  const goalId = id("goal");
  const goal: Goal = {
    id: goalId, roomId: e.room.id, text: "Make a baseline copy", status: "running", createdAt: now(), approvedAt: now(),
    contract: { objective: "A baseline copy", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: now(), amendments: [], requirements: reqIds.map((r) => ({ id: r, text: `Requirement ${r}`, status: unmet.includes(r) ? "unmet" as const : "open" as const })) },
    state: { decisions: [], nextAction: "", progress: newProgress() },
  };
  e.store.saveGoal(goal);
  const stuck: Record<string, Task> = {};
  for (const s of specs) {
    const t = { id: id("task"), roomId: e.room.id, goalId, title: `Task ${s.key}`, description: "Do the part.", taskType: "other", acceptance: "AC1: Done.", criteria: [{ id: "AC1", text: "Done" }], dependsOn: [], owner: "codex", assignee: "codex", role: "worker", files: [], covers: s.covers, status: s.status, attempts: 2, history: [], createdAt: now(), updatedAt: now() } as Task;
    e.store.saveTask(t); stuck[s.key] = t;
  }
  return { goal, stuck };
}
const quiet = (e: Env) => e.store.listMessages(e.room.id, 500).map((m) => m.text);
const recoverCalls = () => MockAdapter.calls.filter((c) => c.kind === "RECOVER");

test("duplicate work: a failed task whose requirements an accepted task already met gets no replacement, and the log says so once", async () => {
  const e = setup(); autoRun(e);
  const { goal, stuck } = seedGoal(e, [{ key: "PASS", status: "done", covers: ["G1"] }, { key: "DUP", status: "failed", covers: ["G1"] }], ["G1"]);
  MockAdapter.calls.length = 0;
  const ok = await (e.orch as unknown as Recover).recoverGoal(goal, [stuck.DUP], "it failed", new AbortController().signal);
  assert.equal(ok, true, "the goal carries on");
  assert.equal(recoverCalls().length, 0, "the planner wasn't even asked");
  assert.equal(e.store.getTask(stuck.DUP.id)!.recovered, true);
  assert.equal(e.store.listTasks({ goalId: goal.id }).filter((t) => t.origin === "recovery").length, 0, "no replacement");
  assert.equal(e.store.getGoal(goal.id)!.state!.progress!.goalReplans, 0, "not counted as a replan");
  const lines = quiet(e).filter((l) => /Not replacing/.test(l));
  assert.deepEqual(lines, [`Not replacing "Task DUP": G1 already met by "Task PASS".`]);
});

test("duplicate work: a requirement not yet met, or marked unmet by the whole-goal check, still gets its replacement", async () => {
  const e = setup(); autoRun(e);
  const a = seedGoal(e, [{ key: "PASS", status: "done", covers: ["G1"] }, { key: "STUCK", status: "failed", covers: ["G2"] }], ["G1", "G2"]);
  MockAdapter.calls.length = 0;
  await (e.orch as unknown as Recover).recoverGoal(a.goal, [a.stuck.STUCK], "it failed", new AbortController().signal);
  assert.equal(recoverCalls().length, 1);
  assert.equal(e.store.listTasks({ goalId: a.goal.id }).filter((t) => t.origin === "recovery").length, 1);
  const b = seedGoal(e, [{ key: "PASS", status: "done", covers: ["G1"] }, { key: "STUCK", status: "failed", covers: ["G1"] }], ["G1"], ["G1"]);
  MockAdapter.calls.length = 0;
  await (e.orch as unknown as Recover).recoverGoal(b.goal, [b.stuck.STUCK], "it failed", new AbortController().signal);
  assert.equal(recoverCalls().length, 1, "the whole-goal check said G1 is unmet: work is still needed");
});

test("duplicate work: a replacement the planner proposes for requirements already met is skipped", async () => {
  const e = setup(); autoRun(e);
  tune(e, "claude", { settings: { recoverCovers: ["G1"] } });
  const { goal, stuck } = seedGoal(e, [{ key: "PASS", status: "done", covers: ["G1"] }, { key: "STUCK", status: "failed", covers: ["G2"] }], ["G1", "G2"]);
  MockAdapter.calls.length = 0;
  const ok = await (e.orch as unknown as Recover).recoverGoal(goal, [stuck.STUCK], "it failed", new AbortController().signal);
  assert.equal(ok, true);
  assert.equal(recoverCalls().length, 1, "the planner was asked, since G2 is not met");
  assert.equal(e.store.listTasks({ goalId: goal.id }).filter((t) => t.origin === "recovery").length, 0, "but its replacement only redid G1");
  assert.equal(quiet(e).filter((l) => /Skipped "Smaller first step"/.test(l)).length, 1);
});

// ---------------------------------------------------------------- 4. blocked by the sandbox or environment

test("failure tag: an agent that says its sandbox or machine can't do the task is a placement problem, not a quality one", () => {
  const codex = "Blocked. /tmp/vizio-cdp-baseline cannot be created in this environment";
  const muse = "I run on a Linux VM, not on Blake's Mac ... /Users/blake.sabatinelli/.agent-room/worktrees/goal_1/task_2 does not exist here";
  const muse2 = "I cannot perform this task from my environment.";
  for (const text of [codex, muse, muse2, "The sandbox blocks writes outside the workspace.", "error: Read-only file system"]) assert.equal(isPlacementBlock(text), true, text);
  for (const text of ["Need the target audience.", "I need the Salesforce export to continue.", "Tests failed: 3 of 10", "Blocked on a decision about the sandbox naming scheme."]) assert.equal(isPlacementBlock(text), false, text);
  assert.deepEqual(classifyFailure({ kind: "blocked", report: { status: "blocked", criteria: {}, outOfScope: "none", reason: codex } }), { tag: "placement", why: "blocked by its environment" });
  assert.equal(classifyFailure({ kind: "blocked", report: { status: "missing", criteria: {}, outOfScope: "none" }, text: muse2 }).tag, "placement");
  assert.equal(classifyFailure({ kind: "blocked", report: { status: "blocked", criteria: {}, outOfScope: "none", reason: "need the target audience" } }).tag, "spec", "a real question stays a spec failure");
});

test("a blocked-by-environment reply is tagged placement, the room says what was blocked, and the task moves to another agent", async () => {
  const e = setup(); autoRun(e);
  tune(e, "codex", { settings: { blockedText: "Blocked. /tmp/vizio-cdp-baseline cannot be created in this environment" } });
  const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const a = e.store.listTasks({ goalId: goal.id }).find((t) => t.title === "Research the topic")!;
  assert.deepEqual(a.triedBy, ["codex"]);
  assert.notEqual(a.assignee, "codex", "another agent did it");
  assert.equal(a.status, "done");
  const f = a.failures!.find((x) => x.agentId === "codex")!;
  assert.equal(f.tag, "placement");
  assert.match(f.note, /^blocked by its environment: /);
  const rec = e.store.listRouting({ goalId: goal.id }).find((r) => r.taskId === a.id && r.chosen === "codex")!;
  assert.equal(rec.failureTag, "placement");
  assert.equal(rec.outcome, "blocked");
  const line = quiet(e).find((l) => /couldn't do "Research the topic" from where it runs/.test(l))!;
  assert.ok(line, "a room line");
  assert.match(line, /That is a placement problem, not a quality one; the task moves to another agent\./);
  assert.match(line, /cannot be created in this environment/);
  assert.doesNotMatch(line, /—/);
  assert.equal(e.store.getScore("codex", "research").runs, 0, "nothing graded, so codex's quality score is untouched");
});
