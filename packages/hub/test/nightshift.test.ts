import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, Contract, Goal, NightShiftSettings, Task, TournamentRun } from "@agent-room/shared";
import type { RunResult } from "../src/adapters/types.js";
import { buildServer } from "../src/api/server.js";
import { attentionFor } from "../src/attention/index.js";
import { Store } from "../src/db/store.js";
import { goalFolder } from "../src/orchestrator/workspace.js";
import { closeRecord, fixedDecision, openRecord } from "../src/orchestrator/routing.js";
import { recordOutcome } from "../src/orchestrator/scoring.js";
import { versionRows } from "../src/orchestrator/versions.js";
import { TaskWorkspaces } from "../src/orchestrator/worktree.js";
import { quotaFor } from "../src/quota/index.js";
import { quotaLimited } from "../src/quota/router.js";
import { ShadowRunner, type ShadowHost } from "../src/resume/shadow.js";
import { seed } from "../src/seed.js";
import {
  NightShift, getNight, getSource, headToHeadOf, headlineOf, listTournaments, nightLine, nightOf, nightSettings, saveSource, saveTournament, scrubNames,
  type NightHost,
} from "../src/nightshift/index.js";
import { setup } from "./helpers.js";

// ---------------------------------------------------------------- the clock and the quota

/** The goals were accepted on the afternoon of 21 Oct (UTC); the night window 23:00 to 06:00 that follows belongs to "2026-10-21". */
const ACCEPT = Date.UTC(2026, 9, 21, 15, 0);
const NIGHT1 = Date.UTC(2026, 9, 22, 1, 0);
const DAYTIME = Date.UTC(2026, 9, 22, 14, 0);
const MORNING = Date.UTC(2026, 9, 22, 7, 0);
/** A five-hour window that opened at 22:00: at 01:00 it has two hours left, so 60% of its unused capacity is about to expire. */
const ANCHOR = Date.UTC(2026, 9, 21, 22, 0);
const NIGHT = "2026-10-21";

const C = ["-c", "user.name=Tester", "-c", "user.email=tester@example.test"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...C, ...args], { cwd, encoding: "utf8" }).trim();

/** Subscriptions with a known limit (10 runs per five hours) and a window anchor. `used` runs already sent in the window. */
function setQuota(store: Store, o: { anchor?: number; limit?: number | null; used?: Record<string, number>; usedAt?: number } = {}) {
  const q = quotaFor(store);
  const limit = o.limit === undefined ? 10 : o.limit;
  const have = q.subscriptions();
  const extra = store.listAgents().filter((a) => !have.some((s) => s.agentIds.includes(a.id)))
    .map((a) => ({ id: a.id, provider: a.provider, label: `${a.name} (subscription)`, agentIds: [a.id], kind: "subscription" as const, windows: {} }));
  const subs = [...have, ...extra].map((s) => (s.kind === "local" ? s : {
    ...s, windows: limit === null ? {} : { fiveHour: { limitRuns: limit } }, ...(o.anchor !== undefined ? { resetAnchor: { fiveHourStart: o.anchor } } : {}),
  }));
  q.saveSubscriptions(subs);
  for (const [agentId, runs] of Object.entries(o.used ?? {})) {
    const sub = q.subscriptions().find((s) => s.kind !== "local" && s.agentIds.includes(agentId))!;
    q.ledger.record({ agentId, subscriptionId: sub.id, at: o.usedAt ?? NIGHT1 - 3_600_000, tokensIn: 0, tokensOut: 0, runs, rateLimited: false, source: "task" });
  }
}

function mulberry32(seedValue: number) {
  let a = seedValue >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- a world: a store, real git, fake agents and a fake judge

const ORIGINAL_Q = 0.6;
/** What each fake agent's work is worth to the fake judge (it reads `Q=<n>` in the files it is shown). */
const QUALITY: Record<string, number> = { claude: 0.85, codex: 0.9, hermes: 0.5, gemini: 0.8, muse: 0.7 };
const MODELS: Record<string, string> = { claude: "claude-test-1", codex: "gpt-test-2", hermes: "hermes-test-3", gemini: "gemini-test-4", muse: "muse-test-5" };
const NAME_RE = /\b(claude|codex|hermes|gemini|muse|anthropic|openai|nous|sage)\b/i;

interface RunLog { agentId: string; taskId: string; cwd: string; head: string; files: string[]; prompt: string }
interface JudgeLog { agentId: string; prompt: string; q: number }
interface World {
  dir: string; store: Store; roomId: string; ws: TaskWorkspaces; ns: NightShift;
  t: number; at(ms: number): void;
  runs: RunLog[]; judged: JudgeLog[]; rewrites: string[]; logs: string[]; pushes: string[];
  onRun?: () => void;
  quality: Record<string, number>; crash: Set<string>; aliases: Record<string, string[]>; busy: Set<string>;
}

async function world(o: { settings?: Partial<NightShiftSettings>; seedRand?: number; agents?: AgentConfig[]; quota?: Parameters<typeof setQuota>[1] } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "ns-"));
  const store = new Store(join(dir, "t.db"));
  seed(store, true);
  for (const a of o.agents ?? []) store.saveAgent(a);
  const roomId = store.listRooms()[0].id;
  store.setSettings({ ...store.getSettings(), attention: { timezone: "UTC" }, nightShift: { enabled: true, ...(o.settings ?? {}) } });
  setQuota(store, { anchor: ANCHOR, ...(o.quota ?? {}) });
  const ws = new TaskWorkspaces({ dataDir: dir });

  const w: World = {
    dir, store, roomId, ws, ns: undefined as unknown as NightShift, t: NIGHT1, at(ms) { w.t = ms; },
    runs: [], judged: [], rewrites: [], logs: [], pushes: [], quality: { ...QUALITY }, crash: new Set(), aliases: { claude: ["Sage"] }, busy: new Set(),
  };
  const ready = async () => store.listAgents().filter((a) => a.enabled);
  const governor = { admit: () => true, start() {}, release() {} };
  const busy = (agentId: string, set?: boolean) => { if (set === true) w.busy.add(agentId); else if (set === false) w.busy.delete(agentId); return w.busy.has(agentId); };
  const ref = (g: Goal) => ({ id: g.id, folder: g.folder! });

  const shadowHost: ShadowHost = {
    store, workspaces: ws, ref, readyAgents: ready, busy, governor,
    async run(agent, prompt, r): Promise<RunResult> {
      w.onRun?.();
      w.runs.push({ agentId: agent.id, taskId: r.taskId, cwd: r.cwd, head: git(r.cwd, "rev-parse", "HEAD"), files: readdirSync(r.cwd).filter((f) => f !== ".git").sort(), prompt });
      if (w.crash.has(agent.id)) return { ok: false, text: "", durationMs: 1, error: "The CLI is signed out" };
      writeFileSync(join(r.cwd, "night.md"), `Q=${w.quality[agent.id] ?? 0.5}\n`);
      return { ok: true, text: `${agent.name} here: I wrote night.md. ${agent.name} used the ${agent.provider} CLI.`, durationMs: 1000, model: MODELS[agent.id], usage: { inputTokens: 100, outputTokens: 50 } };
    },
    judge: async () => { throw new Error("the night shift judges its own pairs"); },
    beforeRun: async () => undefined,
    notes: () => [], decisions: () => ["LATER DECISION"], ledger: () => "LEDGER SECRET", checksAllowed: () => false,
    log: (_room, text) => { w.logs.push(text); }, now: () => w.t,
  };
  const shadows = new ShadowRunner(shadowHost);

  const host: NightHost = {
    store, workspaces: ws, ref, readyAgents: ready, busy, governor, notes: () => [],
    async call(_agent, prompt): Promise<RunResult> { w.rewrites.push(prompt); return { ok: true, text: /"""\n([\s\S]*?)\n"""/.exec(prompt)?.[1] ?? "", durationMs: 1 }; },
    async callJson<T>(prompt: string, agent: AgentConfig): Promise<T | null> {
      const q = Number(/Q=([0-9.]+)/.exec(prompt)?.[1] ?? "0.5");
      w.judged.push({ agentId: agent.id, prompt, q });
      return { score: q, verdict: q >= 0.7 ? "accept" : "revise", feedback: q >= 0.7 ? "" : "Thin.", criteria: { AC1: { verdict: q >= 0.7 ? "PASS" : "FAIL", evidence: "read the files" } }, on_task: true } as unknown as T;
    },
    quotaLimited: (agentId, at) => quotaLimited(store, agentId, at),
    aliases: (a) => w.aliases[a.id] ?? [],
  };
  w.ns = new NightShift({ store, shadows, host });
  w.ns.clock = () => w.t;
  w.ns.rand = mulberry32(o.seedRand ?? 7);
  const att = attentionFor(store);
  att.clock = () => w.t;
  att.push = (title, body) => { w.pushes.push(`${title} ${body}`); };
  return w;
}

const mockAgent = (id: string, name: string, provider: string): AgentConfig => ({ id, name, provider, adapter: "mock", enabled: true, color: "#123456", settings: {}, tools: { web: true, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false } });

interface Work { key: string; goalId: string; taskId: string; folder: string; base: string; accepted: string; agentId: string }
interface WorkOpts { agent?: string; type?: string; acceptedAt?: number; goalStatus?: Goal["status"]; needs?: string[]; approval?: boolean; noSource?: boolean; granted?: boolean }

/** One accepted real task: a goal folder (a git repository: base commit, then the accepted work), its rows, the original's routing record and the saved starting state. */
function addWork(w: World, key: string, o: WorkOpts = {}): Work {
  const { store } = w;
  const agentId = o.agent ?? "claude", agent = store.getAgent(agentId)!;
  const acceptedAt = o.acceptedAt ?? ACCEPT;
  const folder = join(w.dir, "goals", key);
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q", "-b", "main");
  writeFileSync(join(folder, "README.md"), "# Notes\n");
  git(folder, "add", "-A"); git(folder, "commit", "-q", "-m", "base");
  const base = git(folder, "rev-parse", "HEAD");
  writeFileSync(join(folder, "out.md"), `Q=${ORIGINAL_Q}\n`);
  git(folder, "add", "-A"); git(folder, "commit", "-q", "-m", "accepted work");
  const accepted = git(folder, "rev-parse", "HEAD");

  const goalId = `g-${key}`, taskId = `t-${key}`;
  const contract: Contract = { objective: `Write the ${key} notes`, constraints: [], deliverables: ["out.md"], outOfScope: [], version: 1, lockedAt: acceptedAt - 3_600_000, amendments: [], decisions: ["Use plain headings"] };
  store.saveGoal({ id: goalId, roomId: w.roomId, text: `Write the ${key} notes`, status: o.goalStatus ?? "done", approvedAt: acceptedAt - 3_600_000, folder, contract, createdAt: acceptedAt - 7_200_000 });
  const task = {
    id: taskId, roomId: w.roomId, goalId, title: `Write the ${key} notes`, description: "Write short notes about venue screens.", taskType: o.type ?? "coding",
    acceptance: "The notes exist", dependsOn: [], owner: agentId, assignee: agentId, criteria: [{ id: "AC1", text: "out.md holds the notes" }], files: ["out.md"], output: "out.md",
    status: "done", attempts: 1, result: `${agent.name} here: I wrote out.md. ${agent.name} used the ${agent.provider} CLI. ${(w.aliases[agentId] ?? [""])[0]} signing off.`,
    createdAt: acceptedAt - 3_600_000, updatedAt: acceptedAt, ...(o.needs ? { needs: o.needs } : {}),
  } as Task;
  store.saveTask(task);
  const rec = openRecord(store, fixedDecision(store, agent, [], task.taskType, "planned_owner", 0), task, `Write the ${key} notes`, "task");
  store.saveRouting({ ...rec, at: acceptedAt - 600_000, outcome: "accepted", completedAt: acceptedAt, modelVersion: "claude-test-0", judgment: { score: 0.8, verdict: "accept", judgeAgentId: "codex" } });
  if (o.approval) store.saveApproval({ id: `ap-${key}`, roomId: w.roomId, agentId, tool: "shell", action: "run the tests", detail: "npm test", status: "approved", createdAt: acceptedAt - 300_000 } as never);
  if (!o.noSource) saveSource(store, { taskId, goalId, baseCommit: base, mode: o.granted ? "granted-git" : "plain", agentId, changed: ["out.md"], files: `out.md\nQ=${ORIGINAL_Q}\n`, openedAt: acceptedAt - 3_000_000, acceptedAt });
  if (o.granted) {
    mkdirSync(w.ws.root(goalId), { recursive: true });
    writeFileSync(join(w.ws.root(goalId), "_source.json"), JSON.stringify({ mode: "granted-git", path: "/owner/repo", branch: `agent-room/${goalId}`, clone: join(w.dir, "no-such-clone"), integration: join(w.dir, "no-such-integration") }));
  }
  return { key, goalId, taskId, folder, base, accepted, agentId };
}

const rows = (w: World) => listTournaments(w.store);
const roomMessages = (w: World) => w.store.listMessages(w.roomId, 10_000).length;

// ---------------------------------------------------------------- AC1: spare quota re-runs the day's tasks, blind

test("AC1: inside the window with expiring capacity, the day's accepted tasks are re-run on the agents that did not do them, from the task's base commit, never merged", async () => {
  const w = await world();
  const a = addWork(w, "a"), b = addWork(w, "b");
  const messages = roomMessages(w), approvals = w.store.listApprovals().length;
  w.at(NIGHT1);
  const { started } = await w.ns.tick();
  assert.equal(started, 4, "two tasks, two other agents each");

  const done = rows(w);
  assert.equal(done.length, 4);
  for (const t of done) {
    assert.equal(t.original.agentId, "claude");
    assert.notEqual(t.challenger.agentId, "claude", "an agent that already did the task is never the challenger");
    assert.equal(t.night, NIGHT);
  }
  for (const work of [a, b]) assert.deepEqual(done.filter((t) => t.taskId === work.taskId).map((t) => t.challenger.agentId).sort(), ["codex", "hermes"]);

  // Each re-run had its own worktree, cut from the commit the real task started from (not the accepted state), and the worktree is gone.
  assert.equal(w.runs.length, 4);
  assert.equal(new Set(w.runs.map((r) => r.cwd)).size, 4, "four separate work folders");
  for (const r of w.runs) {
    const work = r.taskId.startsWith("t-a") ? a : b;
    assert.equal(r.head, work.base, "starts at the task's base commit");
    assert.deepEqual(r.files, ["README.md"], "the accepted work (out.md) is not in the starting state");
    assert.ok(r.cwd.startsWith(join(w.dir, "worktrees", work.goalId)), "inside the hub's own worktree folder");
    assert.ok(r.cwd.includes(`-night-${r.agentId}`), "named for the agent and the night shift");
    assert.equal(existsSync(r.cwd), false, "thrown away afterwards");
    assert.ok(!/LEDGER SECRET|LATER DECISION/.test(r.prompt), "no look at the goal's later state");
    assert.match(r.prompt, /Use plain headings/, "the contract's own decisions are shown");
  }

  // Never merged, nothing left behind.
  for (const work of [a, b]) {
    assert.equal(git(work.folder, "rev-parse", "HEAD"), work.accepted, "the goal's repository did not move");
    assert.equal(git(work.folder, "branch", "--list", "ar/*"), "", "no task branch left");
    assert.equal(git(work.folder, "worktree", "list").split("\n").length, 1, "no worktree left registered");
    assert.equal(git(work.folder, "status", "--porcelain"), "");
    assert.equal(existsSync(join(work.folder, "night.md")), false);
  }

  // No room messages, no approvals.
  assert.equal(roomMessages(w), messages);
  assert.deepEqual(w.logs, []);
  assert.equal(w.store.listApprovals().length, approvals);

  // The routing log says what they were.
  const shadows = w.store.listRouting().filter((r) => r.kind === "shadow");
  assert.equal(shadows.length, 4);
  assert.ok(shadows.every((r) => r.shadow === true && r.tournament === true && (r.shadowOf === a.taskId || r.shadowOf === b.taskId) && r.chosen !== "claude"));
  assert.ok(shadows.every((r) => r.outcome === "accepted" || r.outcome === "revise" || r.outcome === "reassign"));
});

test("AC1: outside the window, with the switch off, or without expiring capacity, nothing runs", async () => {
  const cases: { label: string; at: number; settings?: Partial<NightShiftSettings>; quota?: Parameters<typeof setQuota>[1]; unknownLimit?: boolean }[] = [
    { label: "daytime", at: DAYTIME },
    { label: "the morning after", at: MORNING },
    { label: "switched off", at: NIGHT1, settings: { enabled: false } },
    { label: "no limit known (learning)", at: NIGHT1, quota: { limit: null } },
    { label: "a window that just began", at: NIGHT1, quota: { anchor: NIGHT1 - 300_000 } },
    { label: "everything already used", at: NIGHT1, quota: { used: { claude: 10, codex: 10, hermes: 10 } } },
    { label: "a bar too high for what is left", at: NIGHT1, settings: { minExpiringShare: 0.7 } },
  ];
  for (const c of cases) {
    const w = await world({ settings: c.settings, quota: c.quota });
    addWork(w, "a");
    w.at(c.at);
    const r = await w.ns.tick();
    assert.equal(r.started, 0, c.label);
    assert.equal(rows(w).length, 0, c.label);
    assert.equal(w.runs.length, 0, c.label);
    assert.equal(w.judged.length, 0, c.label);
  }
});

test("AC1: only an agent whose own quota is about to expire takes a re-run, and an agent out of quota is neither challenger nor judge", async () => {
  const w = await world({ agents: [mockAgent("gemini", "Gemini", "google")], quota: { used: { codex: 10 } } }); // Codex has nothing left this window
  addWork(w, "a");
  w.at(NIGHT1);
  await w.ns.tick();
  assert.deepEqual(rows(w).map((t) => t.challenger.agentId).sort(), ["gemini", "hermes"]);
  for (const t of rows(w)) assert.ok(!t.judges.some((j) => j.agentId === "codex"), "an agent expected to be rate limited does not judge either");
  assert.ok(w.judged.every((j) => j.agentId !== "codex"));
});

test("AC1: maxRunsPerNight is respected, held across ticks, and a new night starts again", async () => {
  const w = await world({ settings: { maxRunsPerNight: 2 } });
  addWork(w, "a"); addWork(w, "b");
  w.at(NIGHT1);
  assert.equal((await w.ns.tick()).started, 2);
  assert.equal((await w.ns.tick()).started, 0, "the same night's cap is kept");
  assert.equal(rows(w).length, 2);
  assert.equal(getNight(w.store, NIGHT)?.runs, 2);
  assert.equal(w.ns.state().runsTonight, 2);

  // The next evening: a new task was accepted, and a window that is ending in a while.
  const later = Date.UTC(2026, 9, 22, 23, 30);
  addWork(w, "c", { acceptedAt: Date.UTC(2026, 9, 22, 16, 0) });
  setQuota(w.store, { anchor: Date.UTC(2026, 9, 22, 22, 0) });
  w.at(later);
  const next = await w.ns.tick();
  assert.ok(next.started >= 1 && next.started <= 2, "a fresh night, a fresh cap");
  assert.equal(getNight(w.store, "2026-10-22")?.runs, next.started);
  assert.equal(w.ns.state().tonight, "2026-10-22");
});

test("AC1: both results are judged blind: no names, ids, providers or persona in any judge prompt, and the order varies", async () => {
  const w = await world();
  let draw = 0;
  w.ns.rand = () => (draw++ % 2 === 0 ? 0.1 : 0.9); // one draw per pair here (a lone judge is not shuffled): the order alternates
  for (const k of ["a", "b", "c"]) addWork(w, k);
  w.at(NIGHT1);
  await w.ns.tick();
  const done = rows(w);
  assert.equal(done.length, 6);

  assert.ok(w.judged.length >= 12, "both results of every pair were judged");
  for (const j of w.judged) assert.doesNotMatch(j.prompt, NAME_RE, "no agent name, id, provider or persona in a judge prompt");
  assert.ok(w.rewrites.length >= 12, "both replies went through the rewriter");
  for (const p of w.rewrites) assert.doesNotMatch(p, NAME_RE, "nor in the text that went to the rewriter");

  // No judge is in either worker's family (three families, so the one other agent judges alone).
  for (const t of done) {
    assert.equal(t.judging, "single");
    assert.equal(t.judges.length, 1);
    const families = new Set([t.original.agentId, t.challenger.agentId]);
    assert.ok(!families.has(t.judges[0].agentId), "not a worker");
  }

  // The order the judges saw the two results in is the recorded one, and it is not always the same.
  let at = 0;
  const orders = new Set<string>();
  for (const t of done) {
    const chunk = w.judged.slice(at, at + 2 * t.judges.length);
    at += chunk.length;
    const seen = chunk.map((j) => (j.q === ORIGINAL_Q ? "original" : "challenger")).filter((s, i, all) => i === 0 || s !== all[i - 1]);
    assert.deepEqual(seen, t.order, "the recorded order is what the judge was shown");
    orders.add(t.order.join(">"));
  }
  assert.equal(orders.size, 2, `both orders were used (${[...orders].join(" | ")})`);
});

test("AC1: with enough other families a jury judges, none of them from either worker's family", async () => {
  const w = await world({ agents: [mockAgent("gemini", "Gemini", "google"), mockAgent("muse", "Muse", "muse")], seedRand: 3 });
  setQuota(w.store, { anchor: ANCHOR });
  addWork(w, "a");
  w.at(NIGHT1);
  await w.ns.tick();
  const done = rows(w);
  assert.ok(done.length >= 3);
  for (const t of done) {
    assert.equal(t.judging, "jury");
    assert.ok(t.judges.length >= 2);
    const workers = [t.original.agentId, t.challenger.agentId];
    for (const j of t.judges) assert.ok(!workers.includes(j.agentId));
    const families = t.judges.map((j) => j.family);
    assert.equal(new Set(families).size, families.length, "one judge per family");
    assert.ok(!families.includes("anthropic") || !workers.includes("claude"));
    assert.ok(!families.includes("openai") || !workers.includes("codex"));
  }
  for (const j of w.judged) assert.doesNotMatch(j.prompt, NAME_RE);
});

test("AC1: with no judge outside both workers' families nothing is run", async () => {
  const w = await world();
  w.store.saveAgent({ ...w.store.getAgent("hermes")!, enabled: false });
  addWork(w, "a");
  w.at(NIGHT1);
  assert.equal((await w.ns.tick()).started, 0);
  assert.equal(w.runs.length, 0);
  assert.deepEqual(getNight(w.store, NIGHT)?.skipped, { "no judge outside both model families": 1 });
});

// ---------------------------------------------------------------- AC2: the results feed the scores

test("AC2: the tournament agent's version score changes and the original's does not; the row records both sides", async () => {
  const w = await world({ settings: { maxRunsPerNight: 1 } });
  const work = addWork(w, "a");
  // The original agent has history of its own.
  recordOutcome(w.store, "claude", "coding", { judgment: { score: 0.8, verdict: "accept", feedback: "", judgeAgentId: "codex" }, seconds: 30, failed: false, revision: false }, "claude-test-0", ACCEPT);
  const claudeScore = structuredClone(w.store.getScore("claude", "coding"));
  const claudeVersions = structuredClone(versionRows(w.store, "claude", NIGHT1));
  assert.equal(w.store.getScore("codex", "coding").runs, 0);

  w.at(NIGHT1);
  await w.ns.tick();
  const [t] = rows(w);
  assert.equal(t.challenger.agentId, "codex");
  assert.deepEqual(w.store.getScore("claude", "coding"), claudeScore, "the original's scores are untouched");
  assert.deepEqual(versionRows(w.store, "claude", NIGHT1), claudeVersions, "and so are its version rows");

  const score = w.store.getScore("codex", "coding");
  assert.equal(score.runs, 1);
  assert.ok(Math.abs(score.quality - 0.9) < 1e-6);
  const v = versionRows(w.store, "codex", NIGHT1).find((r) => r.taskType === "coding" && r.modelVersion === "gpt-test-2");
  assert.ok(v, "recorded under the model version that ran");
  assert.equal(v!.runs, 1);
  assert.ok(Math.abs(v!.quality - 0.9) < 1e-6);

  assert.equal(t.taskId, work.taskId);
  assert.equal(t.taskType, "coding");
  assert.equal(t.original.modelVersion, "claude-test-0");
  assert.equal(t.challenger.modelVersion, "gpt-test-2");
  assert.ok(Math.abs(t.original.score - ORIGINAL_Q) < 1e-6);
  assert.ok(Math.abs(t.challenger.score - 0.9) < 1e-6);
  assert.equal(t.original.verdict, "revise");
  assert.equal(t.challenger.verdict, "accept");
  assert.equal(t.preference, "challenger");
  assert.equal(t.weight, 1);
  const rec = w.store.listRouting().find((r) => r.kind === "shadow")!;
  assert.equal(rec.tournament, true);
  assert.equal(rec.modelVersion, "gpt-test-2");
  assert.equal(rec.judgment?.score && Math.round(rec.judgment.score * 100), 90);
  assert.equal(rec.id, t.routingId);
});

test("AC2: the weight counts a tournament result for less, and scores within the margin are a tie", async () => {
  const w = await world({ settings: { maxRunsPerNight: 1, weight: 0.5 } });
  w.quality.codex = 0.62; // 0.6 vs 0.62: inside the margin
  addWork(w, "a");
  w.at(NIGHT1);
  await w.ns.tick();
  const [t] = rows(w);
  assert.equal(t.preference, "tie");
  assert.equal(t.weight, 0.5);
  assert.equal(w.store.getScore("codex", "coding").runs, 0.5);
  assert.equal(versionRows(w.store, "codex", NIGHT1).find((r) => r.modelVersion === "gpt-test-2")?.runs, 0.5);

  const none = await world({ settings: { maxRunsPerNight: 1, weight: 0 } });
  addWork(none, "a");
  none.at(NIGHT1);
  await none.ns.tick();
  assert.equal(rows(none).length, 1, "still recorded as a head-to-head row");
  assert.equal(none.store.getScore("codex", "coding").runs, 0, "weight 0 feeds nothing to the score");
});

test("AC2: a re-run that crashes is logged, not scored, and the other agents still go", async () => {
  const w = await world();
  w.crash.add("codex");
  addWork(w, "a");
  w.at(NIGHT1);
  await w.ns.tick();
  assert.deepEqual(rows(w).map((t) => t.challenger.agentId), ["hermes"]);
  assert.equal(w.store.getScore("codex", "coding").runs, 0, "a crash overnight says little about the agent");
  const failed = w.store.listRouting().find((r) => r.kind === "shadow" && r.chosen === "codex")!;
  assert.equal(failed.outcome, "run_failed");
  assert.match(failed.failureNote ?? "", /night-shift run failed: The CLI is signed out/);
  assert.ok(w.store.listAudit().some((e) => e.action === "nightshift.failed"));
});

test("AC2: the head-to-head table counts wins, ties and mean scores per task type and pair", async () => {
  const w = await world();
  addWork(w, "a"); addWork(w, "b", { type: "writing" });
  w.at(NIGHT1);
  await w.ns.tick();
  const table = headToHeadOf(rows(w));
  const coding = table.find((r) => r.taskType === "coding" && r.first === "claude" && r.second === "codex")!;
  assert.deepEqual({ n: coding.n, firstWins: coding.firstWins, secondWins: coding.secondWins, ties: coding.ties }, { n: 1, firstWins: 0, secondWins: 1, ties: 0 });
  assert.ok(Math.abs(coding.firstMean - 0.6) < 1e-6 && Math.abs(coding.secondMean - 0.9) < 1e-6);
  const hermes = table.find((r) => r.taskType === "writing" && r.second === "hermes")!;
  assert.deepEqual({ n: hermes.n, firstWins: hermes.firstWins, secondWins: hermes.secondWins }, { n: 1, firstWins: 1, secondWins: 0 }, "Hermes (0.5) lost to the original (0.6)");
  assert.equal(w.ns.state().headToHead.length, table.length);
});

// ---------------------------------------------------------------- visibility: quiet by night, one line in the digest

test("the night is quiet and the digest gets one line when it is over", async () => {
  const w = await world();
  addWork(w, "a"); addWork(w, "b");
  const att = attentionFor(w.store), messages = roomMessages(w);
  w.at(NIGHT1);
  await w.ns.tick();
  assert.equal(rows(w).length, 4);
  assert.deepEqual(w.pushes, [], "nothing pushed during the night");
  assert.ok(!att.state().queue.some((i) => /Night shift/.test(i.title)), "nothing queued for the owner while it runs");
  assert.equal(roomMessages(w), messages, "nothing said in the room");

  w.at(MORNING);
  await w.ns.tick();
  const line = "Night shift: 4 head-to-head runs on spare quota; Codex beat Claude on 2 of 2 coding tasks";
  const item = att.state().queue.filter((i) => /Night shift/.test(i.title));
  assert.equal(item.length, 1);
  assert.equal(item[0].title, line);
  assert.equal(item[0].kind, "report", "waits for the digest like any report");
  assert.match(att.preview(), /Night shift: 4 head-to-head runs on spare quota; Codex beat Claude on 2 of 2 coding tasks/);
  assert.deepEqual(w.pushes, [], "still nothing pushed");
  assert.equal(getNight(w.store, NIGHT)?.reported, true);
  assert.equal(getNight(w.store, NIGHT)?.line, line);

  await w.ns.tick(); // once only
  assert.equal(att.state().queue.filter((i) => /Night shift/.test(i.title)).length, 1);
});

test("a night with no runs says nothing", async () => {
  const w = await world({ quota: { limit: null } });
  addWork(w, "a");
  w.at(NIGHT1);
  await w.ns.tick();
  w.at(MORNING);
  await w.ns.tick();
  assert.ok(!attentionFor(w.store).state().queue.some((i) => /Night shift/.test(i.title)));
});

test("the digest line reads like the spec's example", () => {
  const { store } = setup();
  const t = (n: number, type: string, pref: TournamentRun["preference"], other = "codex"): TournamentRun => ({
    id: `x${type}${other}${n}`, night: NIGHT, at: NIGHT1 + n, taskId: `task${n}`, goalId: "g", roomId: "r", taskTitle: "T", taskType: type,
    original: { agentId: "claude", modelVersion: "m1", score: 0.7, verdict: "accept" }, challenger: { agentId: other, modelVersion: "m2", score: 0.8, verdict: "accept" },
    preference: pref, margin: 0.1, judging: "single", judges: [], order: ["original", "challenger"], weight: 1, seconds: 1,
  });
  const prefs: TournamentRun["preference"][] = ["challenger", "challenger", "challenger", "challenger", "original", "tie"];
  prefs.forEach((p, i) => saveTournament(store, t(i, "coding", p)));
  for (let i = 0; i < 3; i++) saveTournament(store, t(10 + i, "research", i === 0 ? "original" : "challenger", "hermes"));
  // research claude vs hermes: 1 win for the original, 2 for hermes: the coding group is bigger and wins the line
  assert.equal(nightLine(store, NIGHT), "Night shift: 9 head-to-head runs on spare quota; Codex beat Claude on 4 of 6 coding tasks");
  assert.equal(nightLine(store, "2020-01-01"), undefined);
  assert.equal(headlineOf([t(0, "coding", "challenger")], (id) => id), "codex beat claude on a coding task");
  assert.equal(headlineOf([t(0, "coding", "tie"), t(1, "coding", "tie")], (id) => id), undefined, "no winner, no headline");
  assert.equal(headlineOf([t(0, "coding", "challenger"), t(1, "coding", "original")], (id) => id), undefined, "an even split has no winner either");
  assert.equal(nightLine(store, NIGHT)?.includes("—"), false, "no em dash");
});

// ---------------------------------------------------------------- what is never re-run

test("active goals, tasks that needed approvals or outside tools, and tasks with no saved starting state or no owner's files are skipped", async () => {
  const w = await world();
  const ok = addWork(w, "ok");
  addWork(w, "active", { goalStatus: "running" });
  addWork(w, "needs", { needs: ["salesforce"] });
  addWork(w, "approval", { approval: true, acceptedAt: ACCEPT + 3 * 3_600_000 });
  addWork(w, "nosource", { noSource: true });
  addWork(w, "granted", { granted: true });
  w.at(NIGHT1);
  await w.ns.tick();

  const done = rows(w);
  assert.equal(done.length, 2, "only the clean task, on the two other agents");
  assert.ok(done.every((t) => t.taskId === ok.taskId));
  assert.ok(w.runs.every((r) => r.taskId.startsWith(`${ok.taskId}-night-`)));
  assert.deepEqual(getNight(w.store, NIGHT)?.skipped, {
    "goal still active": 1, "needs approvals or outside tools": 2, "starting state not saved": 1, "needs the owner's files": 1, "every other agent has done it": 1,
  });
  for (const k of ["active", "needs", "approval", "nosource", "granted"]) assert.equal(listTournaments(w.store, { taskId: `t-${k}` }).length, 0, k);
});

test("a task already re-run by an agent, as a copy or a re-run, is not run on it again", async () => {
  const w = await world();
  const a = addWork(w, "a");
  const codex = w.store.getAgent("codex")!;
  // Codex already did a practice copy of it
  const copy = { ...w.store.getTask(a.taskId)!, id: `${a.taskId}-shadow-codex` } as Task;
  const rec = openRecord(w.store, fixedDecision(w.store, codex, [], "coding", "shadow", 0), copy, "g", "shadow");
  closeRecord(w.store, rec.id, { outcome: "accepted", shadow: true, shadowOf: a.taskId });
  w.at(NIGHT1);
  await w.ns.tick();
  assert.deepEqual(rows(w).map((t) => t.challenger.agentId), ["hermes"]);
  // the same night again does not repeat the pair
  w.at(NIGHT1 + 60_000);
  assert.equal((await w.ns.tick()).started, 0);
  assert.equal(rows(w).length, 1);
});

test("the pair the log knows least about goes first", async () => {
  const w = await world({ settings: { maxRunsPerNight: 1 } });
  addWork(w, "a");
  // claude vs codex on coding already has two rows, claude vs hermes none
  for (let i = 0; i < 2; i++) saveTournament(w.store, { id: `old${i}`, night: "2026-10-01", at: Date.UTC(2026, 9, 1) + i, taskId: `old${i}`, goalId: "g", roomId: w.roomId, taskTitle: "Old", taskType: "coding",
    original: { agentId: "claude", modelVersion: "m", score: 0.7, verdict: "accept" }, challenger: { agentId: "codex", modelVersion: "m", score: 0.8, verdict: "accept" },
    preference: "challenger", margin: 0.1, judging: "single", judges: [], order: ["original", "challenger"], weight: 1, seconds: 1 });
  w.at(NIGHT1);
  await w.ns.tick();
  assert.equal(rows(w).filter((t) => t.night === NIGHT)[0].challenger.agentId, "hermes");
});

test("a busy agent is left alone", async () => {
  const w = await world();
  w.busy.add("codex");
  addWork(w, "a");
  w.at(NIGHT1);
  await w.ns.tick();
  assert.deepEqual(rows(w).map((t) => t.challenger.agentId), ["hermes"]);
  assert.ok(w.busy.has("codex") && !w.busy.has("hermes"), "an agent that was claimed is freed afterwards");
});

test("no new re-run begins once the window has closed", async () => {
  const w = await world();
  addWork(w, "a"); addWork(w, "b");
  w.at(Date.UTC(2026, 9, 22, 5, 59)); // a minute before the window closes
  w.onRun = () => { w.at(MORNING); }; // it is 07:00 by the time the first re-run is going
  const r = await w.ns.tick();
  assert.equal(r.started, 1, "four were possible; the first one ran out the clock");
  assert.equal(rows(w).length, 1);
});

// ---------------------------------------------------------------- the starting state

test("a granted-folder goal is only used while the hub's clone still holds the commit", async () => {
  const w = await world();
  const a = addWork(w, "a");
  assert.equal(await w.ws.hasCommit({ id: a.goalId, folder: a.folder }, a.base), true, "a plain goal folder holds it");
  assert.equal(await w.ws.hasCommit({ id: a.goalId, folder: a.folder }, "0".repeat(40)), false);
  assert.equal(await w.ws.hasCommit({ id: a.goalId, folder: a.folder }, "not-a-commit"), false);
  mkdirSync(w.ws.root(a.goalId), { recursive: true });
  writeFileSync(join(w.ws.root(a.goalId), "_source.json"), JSON.stringify({ mode: "granted-git", path: "/owner/repo", clone: join(w.dir, "gone") }));
  assert.equal(await w.ws.hasCommit({ id: a.goalId, folder: a.folder }, a.base), false, "granted and no clone: needs the owner's files");
  writeFileSync(join(w.ws.root(a.goalId), "_source.json"), JSON.stringify({ mode: "granted-git", path: "/owner/repo", clone: a.folder }));
  assert.equal(await w.ws.hasCommit({ id: a.goalId, folder: a.folder }, a.base), true, "granted with the clone present");
});

test("the opened and accepted hooks keep the starting commit and what was handed back, and never throw", async () => {
  const w = await world();
  const a = addWork(w, "a", { noSource: true });
  const open = await w.ws.open({ id: a.goalId, folder: a.folder }, { id: "t-hook" }, "codex");
  await w.ns.opened({ id: "t-hook", goalId: a.goalId }, open, "codex");
  const src = getSource(w.store, "t-hook")!;
  assert.equal(src.baseCommit, a.accepted, "the head the worktree was cut from");
  assert.equal(src.agentId, "codex");
  assert.equal(src.mode, "plain");
  w.ns.accepted({ id: "t-hook" }, "codex", ["out.md"], "out.md\nQ=1\n");
  assert.deepEqual(getSource(w.store, "t-hook")?.changed, ["out.md"]);
  assert.equal(getSource(w.store, "t-hook")?.files, "out.md\nQ=1\n");
  assert.ok(getSource(w.store, "t-hook")?.acceptedAt);
  // a revision reusing its worktree, a task nobody knows and a bad path do nothing and do not throw
  await w.ns.opened({ id: "t-hook", goalId: a.goalId }, { ...open, reused: true }, "codex");
  w.ns.accepted({ id: "nobody" }, "codex", [], "");
  await w.ns.opened({ id: "t-bad", goalId: a.goalId }, { ...open, kind: "git", path: join(w.dir, "nowhere"), reused: false }, "codex");
  assert.equal(getSource(w.store, "t-bad"), undefined);
  await w.ws.discard({ id: a.goalId, folder: a.folder }, "t-hook");
});

// ---------------------------------------------------------------- settings, window and pure helpers

test("nightOf: the night belongs to the evening it began, in the owner's time zone", () => {
  assert.equal(nightOf(Date.UTC(2026, 9, 21, 23, 30), "UTC", "23:00", "06:00"), "2026-10-21");
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 1, 0), "UTC", "23:00", "06:00"), "2026-10-21", "across midnight");
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 5, 59), "UTC", "23:00", "06:00"), "2026-10-21");
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 6, 30), "UTC", "23:00", "06:00"), undefined);
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 14, 0), "UTC", "23:00", "06:00"), undefined);
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 2, 0), "UTC", "01:00", "05:00"), "2026-10-22", "a window inside one day");
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 2, 0), "UTC", "03:00", "03:00"), undefined, "no window");
  // 22 Oct is daylight time in Chicago (UTC-5)
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 4, 30), "America/Chicago", "23:00", "06:00"), "2026-10-21", "23:30 local");
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 5, 30), "America/Chicago", "23:00", "06:00"), "2026-10-21", "00:30 local, still the same night");
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 11, 30), "America/Chicago", "23:00", "06:00"), undefined, "06:30 local");
  assert.equal(nightOf(Date.UTC(2026, 9, 22, 3, 30), "America/Chicago", "23:00", "06:00"), undefined, "22:30 local, before it opens");
});

test("nightShift settings: off by default, anything out of range takes a safe value", () => {
  const read = (nightShift?: Partial<NightShiftSettings>) => nightSettings({ getSettings: () => ({ nightShift }) } as unknown as Store);
  assert.deepEqual(read(undefined), { enabled: false, from: "23:00", to: "06:00", maxRunsPerNight: 20, minExpiringShare: 0.2, weight: 1 });
  assert.equal(read({ enabled: true }).enabled, true);
  assert.equal(read({ enabled: "yes" as unknown as boolean }).enabled, false);
  const odd = read({ from: "25:99", to: "late", maxRunsPerNight: 999.7, minExpiringShare: -1, weight: 5 });
  assert.deepEqual(odd, { enabled: false, from: "23:00", to: "06:00", maxRunsPerNight: 200, minExpiringShare: 0, weight: 1 });
  assert.equal(read({ maxRunsPerNight: 3.9 }).maxRunsPerNight, 3);
  assert.equal(read({ from: "22:30", to: "5:15" }).from, "22:30");
  assert.equal(read({ weight: 0.25 }).weight, 0.25);
});

test("scrubNames takes both workers' names out of the text and leaves code, paths and numbers alone", () => {
  const names = ["Claude", "claude", "Codex", "anthropic", "Sage"];
  assert.equal(scrubNames("Claude wrote summary.md with 3 tables. codex agrees.", names), "the agent wrote summary.md with 3 tables. the agent agrees.");
  assert.equal(scrubNames("see claude-notes.md, /home/claude/x and @codex/pkg", names), "see claude-notes.md, /home/claude/x and @codex/pkg", "identifiers and paths are code, not signatures");
  assert.equal(scrubNames("Sage: done.", names), "the agent: done.");
  assert.equal(scrubNames("nothing here", names), "nothing here");
  assert.equal(scrubNames("Claude", []), "Claude");
});

test("headToHeadOf and headlineOf read the table", () => {
  const t = (taskType: string, pref: TournamentRun["preference"], a = "claude", b = "codex"): TournamentRun => ({
    id: `r${Math.random()}`, night: NIGHT, at: 1, taskId: "t", goalId: "g", roomId: "r", taskTitle: "T", taskType,
    original: { agentId: a, modelVersion: "m", score: 0.5, verdict: "revise" }, challenger: { agentId: b, modelVersion: "m", score: 0.9, verdict: "accept" },
    preference: pref, margin: 0.4, judging: "single", judges: [], order: ["original", "challenger"], weight: 1, seconds: 1,
  });
  // the same pair seen from both sides counts as one row, in alphabetical order
  const runs = [t("coding", "challenger"), t("coding", "challenger", "codex", "claude"), t("coding", "tie")];
  const [row] = headToHeadOf(runs);
  assert.deepEqual({ first: row.first, second: row.second, n: row.n, firstWins: row.firstWins, secondWins: row.secondWins, ties: row.ties }, { first: "claude", second: "codex", n: 3, firstWins: 1, secondWins: 1, ties: 1 });
  assert.equal(headToHeadOf(runs, "writing").length, 0);
  assert.equal(headlineOf([t("coding", "challenger"), t("coding", "challenger"), t("coding", "original")], (id) => id.toUpperCase()), "CODEX beat CLAUDE on 2 of 3 coding tasks");
});

// ---------------------------------------------------------------- the real orchestrator and the HTTP routes

test("a real goal: the hooks save its starting commit and its accepted files, and a night-shift run leaves the goal exactly as it was", async () => {
  const ctx = setup();
  const g = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(g.status, "done");
  const tasks = ctx.store.listTasks({ goalId: g.id }).filter((t) => t.status === "done");
  assert.ok(tasks.length >= 1);
  for (const t of tasks) {
    const s = getSource(ctx.store, t.id);
    assert.ok(s, `a source for ${t.id}`);
    assert.match(s!.baseCommit, /^[0-9a-f]{40,64}$/);
    assert.equal(s!.mode, "plain");
    assert.ok(s!.acceptedAt, "marked accepted");
    assert.equal(typeof s!.files, "string");
  }

  const folder = ctx.store.getGoal(g.id)?.folder ?? goalFolder(ctx.dir, g.id);
  const head = git(folder, "rev-parse", "HEAD"), branches = git(folder, "branch", "--list"), messages = ctx.store.listMessages(ctx.room.id, 10_000).length, approvals = ctx.store.listApprovals().length;

  // A window around now + one hour, with a five-hour quota window that opened an hour before that.
  const clock = Date.now() + 3_600_000, hour = new Date(clock).getUTCHours(), pad = (n: number) => String(n % 24).padStart(2, "0");
  ctx.store.setSettings({ ...ctx.store.getSettings(), attention: { timezone: "UTC" }, nightShift: { enabled: true, from: `${pad(hour)}:00`, to: `${pad(hour + 3)}:00`, maxRunsPerNight: 2 } });
  setQuota(ctx.store, { anchor: clock - 2 * 3_600_000, limit: 1000 });
  ctx.orch.nightshift.clock = () => clock;
  attentionFor(ctx.store).clock = () => clock;
  const r = await ctx.orch.nightshift.tick();
  assert.ok(r.started >= 1 && r.started <= 2, `ran ${r.started}`);

  const done = listTournaments(ctx.store);
  assert.equal(done.length, r.started);
  for (const t of done) {
    assert.ok(tasks.some((x) => x.id === t.taskId));
    assert.notEqual(t.challenger.agentId, t.original.agentId);
    assert.equal(t.original.agentId, ctx.store.getTask(t.taskId)?.assignee);
  }
  assert.equal(git(folder, "rev-parse", "HEAD"), head, "the goal's repository did not move");
  assert.equal(git(folder, "branch", "--list"), branches, "no branch left behind");
  assert.equal(git(folder, "status", "--porcelain"), "");
  assert.equal(ctx.store.listMessages(ctx.room.id, 10_000).length, messages, "nothing said in the room");
  assert.equal(ctx.store.listApprovals().length, approvals, "no approvals");
  assert.ok(ctx.store.listRouting({ goalId: g.id }).filter((x) => x.kind === "shadow" && x.tournament).length >= r.started);
  assert.equal(ctx.orch.nightshift.state().runsTonight, r.started);
});

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await pr.json()) as { token: string };
  return { ...ctx, app, base, h: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

test("GET /nightshift and the nightShift setting", async () => {
  const { app, base, h, store } = await boot();
  assert.equal((await fetch(`${base}/nightshift`)).status, 401, "behind the same paired-device check");
  const first = (await (await fetch(`${base}/nightshift`, { headers: h })).json()) as { settings: NightShiftSettings & { timezone: string }; inWindow: boolean; nights: unknown[]; recent: unknown[]; headToHead: unknown[] };
  assert.equal(first.settings.enabled, false, "off until the owner turns it on");
  assert.equal(first.settings.from, "23:00");
  assert.equal(first.settings.maxRunsPerNight, 20);
  assert.equal(typeof first.settings.timezone, "string");
  assert.deepEqual([first.nights, first.recent, first.headToHead], [[], [], []]);

  const cur = (await (await fetch(`${base}/settings`, { headers: h })).json()) as Record<string, unknown>;
  delete cur.calibration; delete cur.capacityProfile;
  const put = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ ...cur, nightShift: { enabled: true, from: "22:30", maxRunsPerNight: 5, weight: 0.5 } }) });
  assert.equal(put.status, 200);
  const next = (await (await fetch(`${base}/nightshift`, { headers: h })).json()) as { settings: NightShiftSettings };
  assert.deepEqual({ ...next.settings, timezone: undefined }, { enabled: true, from: "22:30", to: "06:00", maxRunsPerNight: 5, minExpiringShare: 0.2, weight: 0.5, timezone: undefined });
  const bad = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ ...cur, nightShift: { from: "25:00" } }) });
  assert.ok(bad.status >= 400, "a bad time is refused");
  assert.equal(((await (await fetch(`${base}/nightshift`, { headers: h })).json()) as { settings: NightShiftSettings }).settings.from, "22:30", "and nothing changed");

  saveTournament(store, {
    id: "tour1", night: NIGHT, at: NIGHT1, taskId: "t1", goalId: "g1", roomId: "r", taskTitle: "T", taskType: "coding",
    original: { agentId: "claude", modelVersion: "m1", score: 0.6, verdict: "revise" }, challenger: { agentId: "codex", modelVersion: "m2", score: 0.9, verdict: "accept" },
    preference: "challenger", margin: 0.3, judging: "single", judges: [{ agentId: "hermes", family: "nous", local: false }], order: ["challenger", "original"], weight: 1, seconds: 3,
  });
  const runs = (await (await fetch(`${base}/nightshift/runs?night=${NIGHT}`, { headers: h })).json()) as TournamentRun[];
  assert.deepEqual(runs.map((r) => r.id), ["tour1"]);
  const table = (await (await fetch(`${base}/nightshift/head-to-head?taskType=coding`, { headers: h })).json()) as { first: string; second: string; secondWins: number }[];
  assert.deepEqual(table.map((r) => [r.first, r.second, r.secondWins]), [["claude", "codex", 1]]);
  assert.equal((await fetch(`${base}/nightshift/runs?night=tonight`, { headers: h })).status, 400);
  await app.close();
});