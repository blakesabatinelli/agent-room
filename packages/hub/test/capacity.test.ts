import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "@agent-room/shared";
import { adapters } from "../src/adapters/index.js";
import { buildServer } from "../src/api/server.js";
import { CapacityGovernor } from "../src/capacity/governor.js";
import { describeProfile, detectHardware, parseVmStat, planCapacity, readFreeGB, type OsLike, type Probes } from "../src/capacity/hardware.js";
import { classifyAgent, estimateModelGB } from "../src/capacity/locality.js";
import { HW, setup } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const GIB = 1024 ** 3;

/** A stand-in for node:os and the Mac-only probes. */
function machine(o: { gb: number; freeGb?: number; cores: number; platform?: string; arch?: string; sysctl?: Record<string, string>; vmStat?: string }): [OsLike, Probes] {
  return [
    { totalmem: () => o.gb * GIB, freemem: () => (o.freeGb ?? o.gb / 4) * GIB, cpus: () => Array.from({ length: o.cores }, () => ({})), platform: () => o.platform ?? "darwin", arch: () => o.arch ?? "arm64" },
    { sysctl: (k) => o.sysctl?.[k], vmStat: () => o.vmStat },
  ];
}
const agent = (id: string, adapter: AgentConfig["adapter"], settings: Record<string, unknown> = {}): AgentConfig =>
  ({ id, name: id, provider: id, adapter, enabled: true, color: "#000000", settings, tools: {} });

// ---------- detection and the plan (AC1, AC2)

test("8 GB, 8 cores: small plan, 2 tasks, one local CLI, local models off", () => {
  const hw = detectHardware(...machine({ gb: 8, cores: 8, sysctl: { "hw.perflevel0.physicalcpu": "4", "machdep.cpu.brand_string": "Apple M1", "hw.model": "MacBookAir10,1" } }));
  assert.deepEqual({ totalGB: hw.totalGB, cores: hw.cores, perfCores: hw.perfCores, appleSilicon: hw.appleSilicon, chip: hw.chip, machine: hw.machine },
    { totalGB: 8, cores: 8, perfCores: 4, appleSilicon: true, chip: "Apple M1", machine: "MacBook Air" });
  const plan = planCapacity(hw);
  assert.equal(plan.tier, "small");
  assert.equal(plan.maxConcurrentTasks, 2);
  assert.equal(plan.maxLocalCliAgents, 1);
  assert.equal(plan.localModelsAllowed, false);
  assert.equal(plan.localModelMaxGB, 0);
  assert.match(plan.reason, /local models off/);
});

test("16 GB: medium plan, 3 tasks, local models on up to 6 GB", () => {
  const hw = detectHardware(...machine({ gb: 16, cores: 10, sysctl: { "hw.perflevel0.physicalcpu": "8", "machdep.cpu.brand_string": "Apple M2 Pro", "hw.model": "MacBookPro18,3" } }));
  const plan = planCapacity(hw);
  assert.equal(plan.tier, "medium");
  assert.equal(plan.maxConcurrentTasks, 3);
  assert.equal(plan.maxLocalCliAgents, 2);
  assert.equal(plan.localModelsAllowed, true);
  assert.equal(plan.localModelMaxGB, 6);
  assert.equal(describeProfile(hw, plan), "MacBook Pro, 16 GB, 10 cores: up to 3 tasks at once; local models on");
});

test("64 GB, 16 cores: large plan, concurrency from cores, up to 6", () => {
  const hw = detectHardware(...machine({ gb: 64, cores: 16 }));
  const plan = planCapacity(hw);
  assert.equal(plan.tier, "large");
  assert.equal(plan.maxConcurrentTasks, 6);
  assert.equal(plan.localModelsAllowed, true);
  assert.equal(plan.localModelMaxGB, 32);
  // 32 GB with 10 cores (8 performance) is large too, with fewer tasks
  const mid = planCapacity(detectHardware(...machine({ gb: 32, cores: 10, sysctl: { "hw.perflevel0.physicalcpu": "8" } })));
  assert.equal(mid.tier, "large");
  assert.equal(mid.maxConcurrentTasks, 4);
  // never more tasks than cores
  assert.equal(planCapacity(detectHardware(...machine({ gb: 8, cores: 1 }))).maxConcurrentTasks, 1);
});

test("thresholds sit between the memory sizes Macs ship with", () => {
  const tier = (gb: number) => planCapacity({ ...HW.large, totalGB: gb }).tier;
  assert.deepEqual([8, 11.9, 12, 16, 18, 24, 27.9, 28, 32, 36, 64, 128].map(tier),
    ["small", "small", "medium", "medium", "medium", "medium", "medium", "large", "large", "large", "large", "large"]);
});

test("non-Mac and failed probes fall back to os.cpus() and node:os memory", () => {
  const hw = detectHardware(...machine({ gb: 16, cores: 12, platform: "linux", arch: "x64" }));
  assert.equal(hw.cores, 12);
  assert.equal(hw.appleSilicon, false);
  assert.equal(hw.perfCores, undefined);
  assert.equal(hw.chip, undefined);
  const mac = detectHardware(...machine({ gb: 16, cores: 8 })); // darwin, but sysctl answers nothing
  assert.equal(mac.cores, 8); assert.equal(mac.perfCores, undefined); assert.equal(mac.machine, undefined);
  assert.equal(describeProfile(hw, planCapacity(hw)), "This computer, 16 GB, 12 cores: up to 3 tasks at once; local models on");
});

test("macOS free memory counts cache it gives back, not just 'free' pages", () => {
  const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               20000.\nPages active:                            300000.\nPages inactive:                          200000.\nPages speculative:                        10000.\nPages purgeable:                           5000.\n`;
  assert.equal(parseVmStat(vm), 235000 * 16384);
  const [os, probes] = machine({ gb: 16, freeGb: 0.3, cores: 8, vmStat: vm });
  assert.equal(readFreeGB(os, probes), Math.round(((235000 * 16384) / GIB) * 10) / 10);
  assert.equal(readFreeGB(...machine({ gb: 16, freeGb: 0.3, cores: 8, platform: "linux" })), 0.3);
});

test("owner overrides beat detection", () => {
  assert.equal(planCapacity(HW.small, { maxConcurrentTasks: 5 }).maxConcurrentTasks, 5);
  assert.equal(planCapacity(HW.large, { maxConcurrentTasks: 1 }).maxConcurrentTasks, 1);
  const on = planCapacity(HW.small, { localModels: "on" });
  assert.equal(on.localModelsAllowed, true);
  assert.equal(on.localModelMaxGB, 4, "opted in on 8 GB: up to half of memory");
  assert.equal(planCapacity(HW.small, { localModels: "on", localModelMaxGB: 2 }).localModelMaxGB, 2);
  assert.equal(planCapacity(HW.large, { localModels: "off" }).localModelsAllowed, false);
  assert.equal(planCapacity(HW.medium, { localModels: "auto" }).localModelsAllowed, true);
  assert.equal(planCapacity(HW.medium, { maxLocalCliAgents: 1 }).maxLocalCliAgents, 1);
  assert.equal(planCapacity(HW.medium, { minFreeGB: 5 }).minFreeGB, 5);
  assert.equal(planCapacity(HW.medium, { largeFromGB: 16 }).tier, "large", "thresholds are settings too");
  assert.match(planCapacity(HW.small, { maxConcurrentTasks: 5, localModels: "on" }).reason, /set to 5 in settings; local models turned on/);
});

// ---------- where an agent runs

test("classifyAgent: local model servers, local CLIs, remote", () => {
  assert.equal(classifyAgent(agent("a", "claude-code")), "local-cli");
  assert.equal(classifyAgent(agent("a", "codex")), "local-cli");
  assert.equal(classifyAgent(agent("a", "mcp")), "remote");
  assert.equal(classifyAgent(agent("a", "openai-api")), "remote");
  assert.equal(classifyAgent(agent("a", "openai-api", { baseUrl: "https://api.openai.com/v1" })), "remote");
  assert.equal(classifyAgent(agent("a", "openai-api", { baseUrl: "http://localhost:11434/v1" })), "local-model");
  assert.equal(classifyAgent(agent("a", "openai-api", { baseUrl: "http://127.0.0.1:8080/v1" })), "local-model");
  assert.equal(classifyAgent(agent("a", "openai-api", { baseUrl: "http://192.168.1.20:11434/v1" })), "remote", "a model server on another machine");
  assert.equal(classifyAgent(agent("a", "command", { command: "llama-server", args: ["-m", "x"] })), "local-model");
  assert.equal(classifyAgent(agent("a", "command", { command: "/opt/homebrew/bin/ollama", args: ["run", "qwen3"] })), "local-model");
  assert.equal(classifyAgent(agent("a", "command", { command: "lms", args: ["chat"] })), "local-model");
  assert.equal(classifyAgent(agent("a", "command", { command: "runner", args: ["--url", "http://localhost:1234/v1"] })), "local-model");
  assert.equal(classifyAgent(agent("a", "command", { command: "runner", args: ["--model", "/m/qwen.gguf"] })), "local-model");
  assert.equal(classifyAgent(agent("a", "command", { command: "hermes", args: ["{prompt}"] })), "local-cli");
  assert.equal(classifyAgent(agent("a", "mock")), "local-cli");
  assert.equal(classifyAgent(agent("a", "claude-code", { locality: "remote" })), "remote", "explicit override");
  assert.equal(classifyAgent(agent("a", "mcp", { locality: "local-model" })), "local-model");
  assert.equal(classifyAgent(agent("a", "mcp", { locality: "nonsense" })), "remote", "unknown override is ignored");
});

test("estimateModelGB: from settings or from a size in the model name", () => {
  assert.equal(estimateModelGB(agent("a", "command", { modelGB: 3.5 })), 3.5);
  assert.equal(estimateModelGB(agent("a", "openai-api", { model: "llama-3.1-8b-instruct" })), 5.2);
  assert.equal(estimateModelGB(agent("a", "openai-api", { model: "qwen3-0.6b" })), 0.4);
  assert.equal(estimateModelGB(agent("a", "openai-api", { model: "gpt-5.6-sol" })), undefined);
  assert.equal(estimateModelGB(agent("a", "openai-api", { model: "mixtral-8x7b" })), 36.4, "8 x 7 billion: a safe overestimate; sizes this crude only gate obvious cases");
});

// ---------- the governor

test("governor: remote always, local CLI capped, local models need the plan, the size and free memory", () => {
  let free = 8, t = 0;
  const ctx = setup({ hardware: HW.medium });
  const gov = new CapacityGovernor(ctx.store, HW.medium, { freeGB: () => free, now: () => t });
  const cli1 = agent("c1", "claude-code"), cli2 = agent("c2", "codex"), cli3 = agent("c3", "codex");
  const model = agent("m", "openai-api", { baseUrl: "http://localhost:8080/v1", model: "qwen3-4b" });
  const big = agent("big", "openai-api", { baseUrl: "http://localhost:8080/v1", model: "llama-70b" });
  const cloud = agent("r", "mcp");

  assert.ok(gov.admit(model) && gov.admit(cli1) && gov.admit(cloud));
  assert.equal(gov.admit(big), false, "a 70b model is over the 6 GB cap");
  gov.start("t1", cli1); gov.start("t2", cli2);
  assert.equal(gov.admit(cli3), false, "two local CLIs is the medium cap");
  assert.ok(gov.admit(cloud), "cloud agents never wait on this machine");
  assert.ok(gov.admit(model), "one more task fits under 3");
  gov.start("t3", model);
  assert.equal(gov.admit(agent("c4", "claude-code")), false, "3 tasks at once reached");
  assert.ok(gov.admit(cloud));
  gov.release("t1"); gov.release("t1");
  assert.ok(gov.admit(cli3), "a finished task frees its slot (release is idempotent)");
  assert.deepEqual(gov.snapshot().running, { total: 2, localModel: 1, localCli: 1, remote: 0 });

  // memory floor: free memory is read at most every 5 seconds
  gov.release("t2"); gov.release("t3");
  free = 1; assert.ok(gov.admit(model), "still the cached reading");
  t = 4999; assert.ok(gov.admit(model));
  t = 5000; assert.equal(gov.admit(model), false, "re-read: 1 GB free is under the 2 GB floor");
  assert.ok(gov.admit(cli1), "local CLIs don't need the floor");
  free = 6; t = 10_000; assert.ok(gov.admit(model));
});

test("governor on 8 GB: local models are off, so a local model agent is never admitted", () => {
  const ctx = setup({ hardware: HW.small });
  const gov = new CapacityGovernor(ctx.store, HW.small, { freeGB: () => 5 });
  const model = agent("m", "openai-api", { baseUrl: "http://localhost:11434/v1" });
  assert.equal(gov.admit(model), false);
  ctx.store.setSettings({ ...ctx.store.getSettings(), capacity: { localModels: "on" } });
  assert.ok(gov.admit(model), "the owner's override applies to the next task, no restart");
  ctx.store.setSettings({ ...ctx.store.getSettings(), capacity: { localModels: "on", maxConcurrentTasks: 1 } });
  gov.start("x", agent("c", "codex"));
  assert.equal(gov.admit(model), false);
});

test("preferForOverflow: at the limit only cloud agents are left; under pressure cloud comes first", () => {
  const ctx = setup({ hardware: HW.small });
  const gov = new CapacityGovernor(ctx.store, HW.small, { freeGB: () => 5 });
  const claude = agent("claude", "claude-code"), codex = agent("codex", "codex"), muse = agent("muse", "mcp");
  const model = agent("m", "openai-api", { baseUrl: "http://localhost:11434/v1" });
  assert.deepEqual(gov.preferForOverflow([claude, codex, muse, model]).map((a) => a.id), ["claude", "codex", "muse"], "local model dropped (off on 8 GB), the rest left to the router");
  gov.start("t1", claude);
  assert.equal(gov.snapshot().atLimit, true, "one local CLI is the small-machine cap");
  assert.deepEqual(gov.preferForOverflow([claude, codex, muse, model]).map((a) => a.id), ["muse"]);
  gov.release("t1");
  // plenty of room: order is left to the router
  const big = new CapacityGovernor(ctx.store, HW.large, { freeGB: () => 40 });
  assert.deepEqual(big.preferForOverflow([model, claude, muse]).map((a) => a.id), ["m", "claude", "muse"]);
  // medium machine with 2 of 3 slots taken: cloud first, then CLI, then local model
  const med = new CapacityGovernor(ctx.store, HW.medium, { freeGB: () => 9 });
  med.start("a", codex);
  assert.deepEqual(med.preferForOverflow([model, claude, muse]).map((a) => a.id), ["m", "claude", "muse"], "1 of 3 slots: no pressure yet");
  med.start("b", agent("c2", "codex"));
  assert.deepEqual(med.preferForOverflow([model, claude, muse]).map((a) => a.id), ["muse", "m"], "the CLI cap (2) is full; under pressure cloud comes before the local model");
});

// ---------- the orchestrator honours it (AC2, AC3)

/**
 * Count task runs in flight, per agent, by watching the adapter. `governorPeak` is the most tasks the governor had admitted
 * when a run started: admission happens synchronously in the drive loop, so it does not depend on how long a worktree takes to cut.
 */
function watchRuns(ctx: ReturnType<typeof setup>) {
  const state = { now: 0, max: 0, cli: 0, maxCli: 0, governorPeak: 0, byAgent: new Map<string, number>() };
  const orig = adapters.mock.run.bind(adapters.mock);
  adapters.mock.run = async (req) => {
    if (!req.prompt.includes("# Your task:")) return orig(req);
    const cli = classifyAgent(req.agent) === "local-cli";
    state.now++; state.max = Math.max(state.max, state.now);
    if (cli) { state.cli++; state.maxCli = Math.max(state.maxCli, state.cli); }
    state.governorPeak = Math.max(state.governorPeak, ctx.governor.snapshot().running.total);
    state.byAgent.set(req.agent.id, (state.byAgent.get(req.agent.id) ?? 0) + 1);
    try { return await orig(req); } finally { state.now--; if (cli) state.cli--; }
  };
  return { state, stop: () => { adapters.mock.run = orig; } };
}

/**
 * A plan of n independent tasks. With `overlap`, every task run is held open (the mock's `barrier` knob) until that many runs are in flight
 * together, so how long a worktree takes to cut (it is serialised per goal, and slow on a loaded machine) cannot make runs miss each other.
 */
function widePlan(ctx: ReturnType<typeof setup>, n: number, extra: Record<string, unknown> = {}, overlap = 0) {
  ctx.store.setSettings({ ...ctx.store.getSettings(), planApproval: "never" });
  for (const a of ctx.store.listAgents()) {
    a.settings = { ...a.settings, delayMs: overlap ? 0 : 150, ...(overlap ? { barrier: { key: ctx.dir, n: overlap } } : {}), ...(extra[a.id] as object ?? {}) };
    if (a.id === "claude") a.settings.wide = n;
    ctx.store.saveAgent(a);
  }
}

test("AC2: a goal with 4 independent tasks on a simulated 8 GB machine never runs more than 2 at once", async () => {
  const ctx = setup({ hardware: HW.small });
  widePlan(ctx, 4, { hermes: { locality: "remote" } }, 2); // Hermes joins over MCP in real life
  const w = watchRuns(ctx);
  try {
    const goal = await ctx.orch.runGoal(ctx.room.id, "Write four parts");
    assert.equal(goal.status, "done");
    assert.equal(ctx.store.listTasks({ goalId: goal.id }).filter((t) => t.title.startsWith("Part")).length, 4);
    assert.equal(w.state.max, 2, "2 at once: one local CLI plus the cloud agent (both were held open until they overlapped)");
    assert.equal(w.state.governorPeak, 2, "the governor never had more than 2 admitted, even for the tasks still waiting");
    assert.ok(w.state.maxCli <= 1, "only one local CLI agent at a time on 8 GB");
    assert.equal(ctx.governor.snapshot().running.total, 0, "every slot was released");
  } finally { w.stop(); }
});

test("AC2: the same goal on a simulated 64 GB machine runs all agents in parallel", async () => {
  const ctx = setup({ hardware: HW.large });
  widePlan(ctx, 4, { hermes: { locality: "remote" } }, 3);
  const w = watchRuns(ctx);
  try {
    assert.equal((await ctx.orch.runGoal(ctx.room.id, "Write four parts")).status, "done");
    assert.equal(w.state.max, 3, "one task per agent, nothing throttled (all three were held open until they overlapped)");
    assert.equal(w.state.governorPeak, 3);
  } finally { w.stop(); }
});

test("AC2: the owner's maxConcurrentTasks override is honoured", async () => {
  const ctx = setup({ hardware: HW.large });
  widePlan(ctx, 4);
  ctx.store.setSettings({ ...ctx.store.getSettings(), capacity: { maxConcurrentTasks: 1 } });
  const w = watchRuns(ctx);
  try {
    assert.equal((await ctx.orch.runGoal(ctx.room.id, "Write four parts")).status, "done");
    assert.equal(w.state.max, 1);
    assert.equal(w.state.governorPeak, 1);
    assert.equal([...w.state.byAgent.values()].reduce((x, y) => x + y, 0), 4, "all four tasks ran, one at a time");
  } finally { w.stop(); }
});

test("AC3: with local models off, work goes to the CLI or cloud agent, not the local model", async () => {
  const ctx = setup({ hardware: HW.small });
  // claude would win ties (first in pool); make it the local model server
  widePlan(ctx, 2, { claude: { locality: "local-model" }, hermes: { locality: "remote" } });
  for (const a of ctx.store.listAgents()) { a.settings.noOwner = true; ctx.store.saveAgent(a); }
  const w = watchRuns(ctx);
  try {
    const goal = await ctx.orch.runGoal(ctx.room.id, "Write two parts");
    assert.equal(goal.status, "done");
    const parts = ctx.store.listTasks({ goalId: goal.id }).filter((t) => t.title.startsWith("Part"));
    assert.equal(parts.length, 2);
    assert.ok(parts.every((t) => t.assignee !== "claude"), "the local model was skipped");
    assert.equal(w.state.byAgent.get("claude") ?? 0, 0);
  } finally { w.stop(); }
});

test("AC3: with local models on and memory free, the local model may be chosen", async () => {
  const ctx = setup({ hardware: HW.medium });
  widePlan(ctx, 2, { claude: { locality: "local-model" }, hermes: { locality: "remote" } });
  for (const a of ctx.store.listAgents()) { a.settings.noOwner = true; ctx.store.saveAgent(a); }
  const w = watchRuns(ctx);
  try {
    const goal = await ctx.orch.runGoal(ctx.room.id, "Write two parts");
    assert.equal(goal.status, "done");
    const parts = ctx.store.listTasks({ goalId: goal.id }).filter((t) => t.title.startsWith("Part"));
    assert.ok(parts.some((t) => t.assignee === "claude"), "the local model took a task");
  } finally { w.stop(); }
});

test("AC3: overflow beyond the local CLI cap goes to the cloud agent", async () => {
  const ctx = setup({ hardware: HW.small });
  widePlan(ctx, 3, { hermes: { locality: "remote" } });
  for (const a of ctx.store.listAgents()) { a.settings.noOwner = true; ctx.store.saveAgent(a); }
  const w = watchRuns(ctx);
  try {
    const goal = await ctx.orch.runGoal(ctx.room.id, "Write three parts");
    assert.equal(goal.status, "done");
    assert.ok((w.state.byAgent.get("hermes") ?? 0) >= 1, "the cloud agent took work while the local CLI slot was full");
    assert.ok(w.state.maxCli <= 1);
  } finally { w.stop(); }
});

test("a planned owner the machine can't take right now is overflowed, not waited on", async () => {
  const ctx = setup({ hardware: HW.small });
  widePlan(ctx, 2, { claude: { locality: "local-model" }, hermes: { locality: "remote" } }); // owners: w0 -> claude, w1 -> codex
  const w = watchRuns(ctx);
  try {
    const goal = await ctx.orch.runGoal(ctx.room.id, "Write two parts");
    assert.equal(goal.status, "done");
    const t = ctx.store.listTasks({ goalId: goal.id }).find((x) => x.title === "Part 1")!;
    assert.equal(t.owner, "claude");
    assert.notEqual(t.assignee, "claude", "claude is a local model and local models are off on 8 GB");
  } finally { w.stop(); }
});

// ---------- API and apps

async function boot() {
  const ctx = setup({ hardware: HW.medium });
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const r = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await r.json()) as { token: string };
  return { ...ctx, app, base, h: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

test("GET /capacity and /settings report the profile; PUT /settings saves overrides", async () => {
  const { app, base, h, store } = await boot();
  const cap = (await (await fetch(`${base}/capacity`, { headers: h })).json()) as { summary: string; plan: { tier: string; maxConcurrentTasks: number }; hardware: { totalGB: number }; running: { total: number } };
  assert.equal(cap.plan.tier, "medium");
  assert.equal(cap.hardware.totalGB, 16);
  assert.equal(cap.summary, "MacBook Pro, 16 GB, 10 cores: up to 3 tasks at once; local models on");
  assert.equal(cap.running.total, 0);
  const s = (await (await fetch(`${base}/settings`, { headers: h })).json()) as { capacityProfile: { summary: string } };
  assert.equal(s.capacityProfile.summary, cap.summary);
  assert.equal((await fetch(`${base}/capacity`)).status, 401);

  const put = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ capacity: { maxConcurrentTasks: 2, localModels: "off" } }) });
  assert.equal(put.status, 200);
  assert.deepEqual(store.getSettings().capacity, { maxConcurrentTasks: 2, localModels: "off" });
  assert.ok(store.listAudit().some((a) => a.action === "settings.updated" && a.detail.includes("maxConcurrentTasks")));
  const after = (await (await fetch(`${base}/capacity`, { headers: h })).json()) as { summary: string };
  assert.equal(after.summary, "MacBook Pro, 16 GB, 10 cores: up to 2 tasks at once; local models off");
  assert.equal((await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ capacity: { localModels: "maybe" } }) })).status >= 400, true);
  await app.close();
});

test("the CLI prints the detected profile, and can preview another machine", () => {
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", join(here, "../src/capacity/cli.ts"), ...args], { cwd: join(here, ".."), encoding: "utf8" });
  const out = JSON.parse(run("--json", "--gb", "8", "--cores", "8")) as { plan: { tier: string; maxConcurrentTasks: number; localModelsAllowed: boolean }; hardware: { totalGB: number } };
  assert.equal(out.hardware.totalGB, 8);
  assert.equal(out.plan.tier, "small");
  assert.equal(out.plan.maxConcurrentTasks, 2);
  assert.equal(out.plan.localModelsAllowed, false);
  const text = run("--gb", "32", "--cores", "12");
  assert.match(text, /Tier:\s+large/);
  assert.match(text, /\(simulated\)/);
  assert.match(run(), /Memory:\s+[\d.]+ GB total/, "with no flags it reads this machine");
});

test("both apps show the detected profile line", () => {
  const web = readFileSync(join(here, "../web/app.js"), "utf8");
  const mac = readFileSync(join(here, "../../app/src/screens/SettingsScreen.tsx"), "utf8");
  assert.match(web, /\/capacity/);
  assert.match(web, /capacity\.summary/);
  assert.match(mac, /hub\??\.capacity\(\)/);
  assert.match(mac, /cap\.summary/);
});
