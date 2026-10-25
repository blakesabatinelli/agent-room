import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentConfig, Goal } from "@agent-room/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/api/server.js";
import { adapters } from "../src/adapters/index.js";
import { MockAdapter } from "../src/adapters/mock.js";
import type { RunRequest } from "../src/adapters/types.js";
import { ClaudeCodeAdapter, claudePermissionArgs } from "../src/adapters/claudeCode.js";
import { codexSandboxArgs } from "../src/adapters/codex.js";
import { ControlFolder } from "../src/control/folder.js";
import { checkFile, lint } from "../src/control/lint.js";
import { emitFile } from "../src/control/parse.js";
import { MemoryKeeper } from "../src/memory/keeper.js";
import { StandingRooms, firesBetween, isStandingRoom, joinOpenRosters, nextFire, parseCron, validZone, wallToEpoch } from "../src/rooms/index.js";
import { id } from "../src/util.js";
import { RoomRules } from "../src/rooms/rules.js";
import { setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;

// ---------------------------------------------------------------- helpers

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const commits = (root: string) => git(root, "log", "--format=%an|%s").trim().split("\n").filter(Boolean);
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const write = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 6000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await sleep(15); }
}
const head = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, schema: 1, updated: "2026-10-23", updated_by: "owner", ...extra });
const at = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;

/** A hub with a control folder and a second room, "pipeline". Claude can run shell commands without asking, everywhere, until a room says otherwise. */
async function mk(t: TestContext, o: { prep?: (c: Ctx) => void } = {}) {
  const ctx = setup();
  const claude = ctx.store.getAgent("claude")!;
  ctx.store.saveAgent({ ...claude, tools: { ...claude.tools, shell: true }, autoApprove: { shell: true } });
  ctx.store.createRoom("pipeline", { topic: "Weekly pipeline review" });
  o.prep?.(ctx);
  const root = join(ctx.dir, "Agent Room");
  const control = new ControlFolder(root, ctx.store, { debounceMs: 40, ownerName: "Blake", watch: false });
  await control.init();
  control.start();
  ctx.orch.control = control;
  t.after(() => { control.close(); ctx.orch.standing.stop(); });
  const pipeline = ctx.store.listRooms().find((r) => r.name === "pipeline")!;
  const general = ctx.store.listRooms().find((r) => r.name === "general")!;
  return { ...ctx, control, root, pipeline, general };
}
type C = Awaited<ReturnType<typeof mk>>;

/** Write rooms/<slug>/ROOM.md the way the owner would in an editor, and let the hub read it. */
async function roomFile(c: C, slug: string, extra: Record<string, unknown> = {}, body = `${slug} room\n`) {
  write(c.root, `rooms/${slug}/ROOM.md`, emitFile(head("room", { name: slug, roster: ["claude", "codex", "hermes"], tools: {}, folders: [], in_scope: [], out_of_scope: [], ...extra }), body));
  await c.control.load();
}

/** Every request an adapter run gets, for the permission arguments. */
function capture(t: TestContext) {
  const seen: RunRequest[] = [];
  const orig = adapters.mock.run.bind(adapters.mock);
  adapters.mock.run = (req: RunRequest) => { seen.push(req); return orig(req); };
  t.after(() => { adapters.mock.run = orig; });
  return seen;
}
const calls = (agent: string, kind?: string) => MockAdapter.calls.filter((x) => x.agentId === agent && (!kind || x.kind === kind));
const sysTexts = (c: C, roomId: string) => c.store.listMessages(roomId, 200).filter((m) => m.author.kind === "system").map((m) => m.text);
const claudeOf = (c: C): AgentConfig => c.store.getAgent("claude")!;
const noJury = (c: C) => c.store.setSettings({ ...c.store.getSettings(), jury: { enabled: false } });

async function boot(t: TestContext) {
  const c = await mk(t);
  const app = await buildServer({ store: c.store, orch: c.orch, approvals: c.approvals, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await pr.json()) as { token: string };
  return { ...c, app, base, token };
}
async function api(c: { base: string; token: string }, method: string, path: string, body?: unknown) {
  const res = await fetch(`${c.base}${path}`, { method, headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

/** A calendar trigger on a fake clock whose goals are plain records the test finishes by hand. */
function standingOn(c: C, clock: { t: number }) {
  const runs: { roomId: string; text: string; scheduled?: Goal["scheduled"]; goalId: string }[] = [];
  const notes: string[] = [];
  const mkStanding = () => {
    const s = new StandingRooms({
      store: c.store, control: () => c.control, attention: c.orch.attention,
      runGoal: async (roomId, text, o) => {
        const g: Goal = { id: id("goal"), roomId, text, status: "running", createdAt: clock.t, scheduled: o.scheduled };
        c.store.saveGoal(g); runs.push({ roomId, text, scheduled: o.scheduled, goalId: g.id });
        return g;
      },
      note: (_r, text) => { notes.push(text); },
      fallbackZone: () => "UTC", ownerName: () => "Blake",
    });
    s.clock = () => clock.t;
    return s;
  };
  const finish = (goalId: string, status: Goal["status"] = "done") => { const g = c.store.getGoal(goalId)!; c.store.saveGoal({ ...g, status }); };
  return { mkStanding, runs, notes, finish };
}
const WEEKLY = { schedule: "0 9 * * 1", standing_goal: "Weekly pipeline review", timezone: "America/Chicago" };

// ---------------------------------------------------------------- the cron parser and the clock

test("cron: fields, lists, ranges, steps, names and macros", () => {
  const ok = (e: string) => { const r = parseCron(e); assert.ok(r.ok, `${e}: ${r.ok ? "" : r.error}`); return r.ok ? r.cron : undefined!; };
  assert.deepEqual(ok("*/15 * * * *").minute, [0, 15, 30, 45]);
  assert.deepEqual(ok("10-40/10 * * * *").minute, [10, 20, 30, 40]);
  assert.deepEqual(ok("0 9,17 * * *").hour, [9, 17]);
  assert.deepEqual(ok("0 9 * * mon-fri").dow, [1, 2, 3, 4, 5]);
  assert.deepEqual(ok("0 9 * jan,jul *").month, [1, 7]);
  assert.deepEqual(ok("0 9 * * 7").dow, [0], "7 is Sunday, like 0");
  assert.deepEqual(ok("@daily").hour, [0]);
  assert.equal(ok("  0   9  * * 1 ").source, "0 9 * * 1", "extra spaces are fine");
  for (const [bad, why] of [
    ["", /empty/], ["0 9 * *", /5 fields/], ["0 9 * * * *", /5 fields/], ["60 * * * *", /minute 60/], ["* 24 * * *", /hour 24/], ["* * 0 * *", /day of month 0/],
    ["* * * 13 *", /month 13/], ["* * * * 8", /day of week 8/], ["5-1 * * * *", /backwards/], ["*/0 * * * *", /step/], ["a * * * *", /isn't a valid minute/], ["1,,2 * * * *", /empty entry/],
  ] as [string, RegExp][]) {
    const r = parseCron(bad);
    assert.ok(!r.ok, `${JSON.stringify(bad)} is refused`);
    if (!r.ok) assert.match(r.error, why, bad);
  }
});

test("cron: next run on the wall clock of a zone; day-of-month and day-of-week are ORed when both are set", () => {
  const c = (e: string) => { const r = parseCron(e); assert.ok(r.ok); return (r as { cron: Parameters<typeof nextFire>[0] }).cron; };
  // Mondays 09:00 in Chicago: CDT (UTC-5) until 1 Nov 2026, CST (UTC-6) after.
  assert.equal(nextFire(c("0 9 * * 1"), at("2026-10-23T12:00:00Z"), "America/Chicago"), at("2026-10-26T14:00:00Z"));
  assert.equal(nextFire(c("0 9 * * 1"), at("2026-10-26T14:00:00Z"), "America/Chicago"), at("2026-11-02T15:00:00Z"), "strictly after, and the offset changed");
  assert.equal(nextFire(c("0 9 * * 1"), at("2026-10-26T14:00:00Z"), "UTC"), at("2026-10-26T14:00:00Z") + 7 * DAY - 5 * 3_600_000, "the same instant is 14:00 UTC: next Monday 09:00 UTC is later");
  // "0 0 13 * 5": the 13th, or any Friday.
  const both = c("0 0 13 * 5");
  assert.equal(nextFire(both, at("2026-10-01T00:00:00Z"), "UTC"), at("2026-10-02T00:00:00Z"), "a Friday");
  assert.equal(nextFire(both, at("2026-10-12T00:00:00Z"), "UTC"), at("2026-10-13T00:00:00Z"), "the 13th (a Tuesday)");
  // A day that never exists never fires.
  assert.equal(nextFire(c("0 0 31 2 *"), at("2026-01-01T00:00:00Z"), "UTC"), undefined);
  assert.ok(validZone("America/Chicago") && !validZone("Mars/Base"));
});

test("cron: America/Chicago spring forward (14 Mar 2027): 02:30 doesn't exist, so it runs when the gap ends, once", () => {
  const c = (e: string) => (parseCron(e) as { cron: Parameters<typeof nextFire>[0] }).cron;
  const daily = c("30 2 * * *");
  const r = firesBetween(daily, at("2027-03-13T00:00:00Z"), at("2027-03-16T00:00:00Z"), "America/Chicago");
  assert.deepEqual(r.slots.map((s) => new Date(s).toISOString()), [
    "2027-03-13T08:30:00.000Z", // 02:30 CST
    "2027-03-14T08:00:00.000Z", // no 02:30: the clock goes 02:00 -> 03:00, so it runs at 03:00 CDT
    "2027-03-15T07:30:00.000Z", // 02:30 CDT
  ]);
  assert.equal(wallToEpoch(2027, 3, 14, 2, 30, "America/Chicago").kind, "gap");
  // Hourly across the jump: 02:00 doesn't exist and 03:00 is the same instant; it runs once.
  const hourly = firesBetween(c("0 * * * *"), at("2027-03-14T06:00:00Z"), at("2027-03-14T10:00:00Z"), "America/Chicago").slots.map((s) => new Date(s).toISOString());
  assert.deepEqual(hourly, ["2027-03-14T07:00:00.000Z", "2027-03-14T08:00:00.000Z", "2027-03-14T09:00:00.000Z", "2027-03-14T10:00:00.000Z"], "01:00 CST, 03:00 CDT (once), 04:00, 05:00");
});

test("cron: America/Chicago fall back (1 Nov 2026): 01:30 happens twice and runs the first time only", () => {
  const c = (e: string) => (parseCron(e) as { cron: Parameters<typeof nextFire>[0] }).cron;
  const r = firesBetween(c("30 1 * * *"), at("2026-10-31T00:00:00Z"), at("2026-11-03T00:00:00Z"), "America/Chicago");
  assert.deepEqual(r.slots.map((s) => new Date(s).toISOString()), [
    "2026-10-31T06:30:00.000Z", // 01:30 CDT
    "2026-11-01T06:30:00.000Z", // 01:30 CDT, the first one; 01:30 CST (07:30Z) is not run again
    "2026-11-02T07:30:00.000Z", // 01:30 CST
  ]);
  assert.equal(wallToEpoch(2026, 11, 1, 1, 30, "America/Chicago").kind, "ambiguous");
  const hourly = firesBetween(c("0 * * * *"), at("2026-11-01T04:30:00Z"), at("2026-11-01T09:30:00Z"), "America/Chicago").slots.map((s) => new Date(s).toISOString());
  assert.deepEqual(hourly, ["2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-01T08:00:00.000Z", "2026-11-01T09:00:00.000Z"], "00:00, 01:00 (first), 02:00 CST, 03:00 CST; the second 01:00 is skipped");
  // A 09:00 job keeps its wall time across the change: the instant moves an hour.
  const nine = firesBetween(c("0 9 * * *"), at("2026-10-31T00:00:00Z"), at("2026-11-03T00:00:00Z"), "America/Chicago").slots.map((s) => new Date(s).toISOString());
  assert.deepEqual(nine, ["2026-10-31T14:00:00.000Z", "2026-11-01T15:00:00.000Z", "2026-11-02T15:00:00.000Z"]);
});

// ---------------------------------------------------------------- the linter and the file

test("lint: standing_goal, timezone and catch_up_hours are in the ROOM.md schema; a bad cron, a missing goal and a bad zone are flagged", () => {
  const room = (extra: Record<string, unknown>) => checkFile("rooms/pipeline/ROOM.md", { kind: "room", room: "pipeline" }, emitFile(head("room", { name: "pipeline", roster: ["claude"], tools: {}, folders: [], in_scope: [], out_of_scope: [], ...extra }), "Pipeline\n"));
  const good = room({ ...WEEKLY, catch_up_hours: 6 });
  assert.deepEqual(good.blocks, []);
  assert.deepEqual((good as { flags?: unknown[] }).flags ?? [], []);
  assert.equal((good.fm as { standing_goal: string }).standing_goal, "Weekly pipeline review");
  assert.equal((good.fm as { catch_up_hours: number }).catch_up_hours, 6);
  assert.ok(room({ catch_up_hours: 500 }).blocks.length, "the window is capped at a week");
});

test("lint: the folder linter flags a schedule the hub can't run, and keeps loading the rest of the file", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", { schedule: "0 9 * *", standing_goal: "x" });
  const flags = lint(c.root).flags.filter((f) => f.file === "rooms/pipeline/ROOM.md").map((f) => f.message);
  assert.ok(flags.some((m) => /isn't a valid cron: a schedule needs 5 fields/.test(m)), flags.join(" | "));
  assert.deepEqual(lint(c.root).blocks, [], "a flag, not a block");
  assert.equal(c.orch.standing.scheduleOf(c.pipeline.id).ok, false, "and no run is scheduled");
  await roomFile(c, "pipeline", { schedule: "0 9 * * 1" });
  assert.ok(lint(c.root).flags.some((f) => /no.*standing_goal|standing_goal is empty/i.test(f.message) || /standing_goal/.test(f.message)), "a schedule with nothing to run");
  await roomFile(c, "pipeline", { ...WEEKLY, timezone: "Nowhere/Town" });
  assert.ok(lint(c.root).flags.some((f) => /isn't a time zone/.test(f.message)));
  await roomFile(c, "pipeline", WEEKLY);
  assert.deepEqual(lint(c.root), { blocks: [], flags: [] });
  assert.equal(c.orch.standing.scheduleOf(c.pipeline.id).ok, true);
});

// ---------------------------------------------------------------- roster

test("roster: only the roster is planned and given work; the same goal in an open room uses everyone", async (t) => {
  const c = await mk(t);
  noJury(c);
  await roomFile(c, "pipeline", { roster: ["claude", "codex"] });
  MockAdapter.calls.length = 0;
  const g = await c.orch.runGoal(c.pipeline.id, "Research the topic and write the summary");
  await c.orch.idle();
  const tasks = c.store.listTasks({ goalId: g.id });
  assert.ok(tasks.length >= 2, "a real plan");
  assert.ok(tasks.every((x) => ["claude", "codex"].includes(x.assignee ?? x.owner ?? "")), tasks.map((x) => `${x.title}:${x.assignee}`).join(", "));
  assert.deepEqual(calls("hermes"), [], "hermes was never asked anything in this room");
  assert.equal(c.store.getGoal(g.id)!.status, "done");
  assert.ok(tasks.every((x) => x.judgment && !x.judgment.outsideRoster), "judged inside the roster");

  MockAdapter.calls.length = 0;
  const open = await c.orch.runGoal(c.general.id, "Research the topic and write the summary");
  await c.orch.idle();
  assert.ok(c.store.listTasks({ goalId: open.id }).some((x) => x.owner === "hermes"), "the open room's plan still names hermes");
});

test("roster: a room whose roster has nobody switched on says so and starts nothing", async (t) => {
  const c = await mk(t);
  c.store.saveAgent({ ...c.store.getAgent("codex")!, enabled: false });
  await roomFile(c, "pipeline", { roster: ["codex"] });
  const g = await c.orch.runGoal(c.pipeline.id, "Research the topic and write the summary");
  assert.equal(g.status, "failed");
  assert.ok(sysTexts(c, c.pipeline.id).some((x) => /Nobody on this room's roster is switched on/.test(x)));
});

test("roster: judges come from the roster; outside it only when nobody inside can judge, and that is recorded", async (t) => {
  const c = await mk(t);
  noJury(c);
  const g = await c.orch.runGoal(c.general.id, "Research the topic and write the summary");
  const base = c.store.listTasks({ goalId: g.id })[0];
  const judge = (worker: string, notJudge?: string) => (c.orch as unknown as { judge: (...a: unknown[]) => Promise<import("@agent-room/shared").Judgment> })
    .judge({ ...base, roomId: c.pipeline.id }, c.store.getAgent(worker)!, undefined, [], new AbortController().signal, [], "", undefined, notJudge);

  await roomFile(c, "pipeline", { roster: ["claude", "codex"] });
  const inside = await judge("claude");
  assert.equal(inside.judgeAgentId, "codex");
  assert.equal(inside.outsideRoster, undefined, "a roster judge needs no exception");

  // A roster of one: the only member is the worker, so the review has to come from outside.
  await roomFile(c, "pipeline", { roster: ["claude"] });
  const outside = await judge("claude");
  assert.notEqual(outside.judgeAgentId, "claude");
  assert.deepEqual(outside.outsideRoster, [outside.judgeAgentId], "the judgment says who came from outside");
  assert.ok(c.store.listAudit(500).some((a) => a.action === "judge.outside_roster" && a.detail.includes(outside.judgeAgentId)), "and so does the audit log");
  assert.ok(c.store.listMessages(c.pipeline.id, 200).some((m) => m.quiet && /from outside this room's roster/.test(m.text)), "and the room's work log");
});

test("roster: a jury that can't be formed inside the roster is formed from outside, and the outsiders are recorded", async (t) => {
  const c = await mk(t, { prep: (x) => {
    for (const [idn, provider] of [["gemini", "google"], ["mistral", "mistral"]] as const) x.store.saveAgent({ id: idn, name: idn, provider, adapter: "mock", enabled: true, color: "#123456", settings: {}, tools: { web: true } });
  } });
  const g = await c.orch.runGoal(c.general.id, "Research the topic and write the summary");
  const base = c.store.listTasks({ goalId: g.id })[0];
  await roomFile(c, "pipeline", { roster: ["claude", "codex"] });
  const j = await (c.orch as unknown as { judge: (...a: unknown[]) => Promise<import("@agent-room/shared").Judgment> })
    .judge({ ...base, roomId: c.pipeline.id, result: "Claude finished the task.\nSTATUS: done" }, c.store.getAgent("claude")!, undefined, [], new AbortController().signal);
  assert.equal(j.jury?.kind, "jury", "three families judged");
  assert.ok(j.outsideRoster && j.outsideRoster.length >= 1, "some of them from outside");
  assert.ok(j.outsideRoster!.every((x) => !["claude", "codex"].includes(x)));
});

test("roster: @mentions of an agent outside the roster get a short reply and reach nobody", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", { roster: ["claude", "codex"] });
  MockAdapter.calls.length = 0;
  await c.orch.handleOwnerMessage(c.pipeline.id, "@hermes what do you think?");
  await c.orch.idle();
  assert.deepEqual(calls("hermes"), []);
  assert.deepEqual(c.store.listGoals(c.pipeline.id), [], "no goal was started either");
  const reply = sysTexts(c, c.pipeline.id).find((x) => /isn't in this room/.test(x));
  assert.ok(reply && reply.includes("Hermes") && reply.includes("@claude") && reply.includes("@codex") && !/@hermes/.test(reply.split("Here:")[1] ?? ""), reply);
  assert.ok(!/—/.test(reply!), "no em dash");

  // Tagging someone inside and someone outside: the one inside answers.
  await c.orch.handleOwnerMessage(c.pipeline.id, "@claude @hermes hi both?");
  await c.orch.idle();
  assert.equal(calls("claude", "CHAT").length, 1);
  assert.deepEqual(calls("hermes"), []);

  // The same message in the open room reaches hermes.
  await c.orch.handleOwnerMessage(c.general.id, "@hermes what do you think?");
  await c.orch.idle();
  assert.equal(calls("hermes", "CHAT").length, 1);
});

test("roster: agents can't pull in, ask or post as someone outside the roster", async (t) => {
  const c = await mk(t);
  const claude = claudeOf(c);
  c.store.saveAgent({ ...claude, settings: { ...claude.settings, tag: "hermes" } }); // claude's replies tag @hermes
  await roomFile(c, "pipeline", { roster: ["claude", "codex"] });
  MockAdapter.calls.length = 0;
  await c.orch.handleOwnerMessage(c.pipeline.id, "@claude hello");
  await c.orch.idle();
  assert.equal(calls("claude", "CHAT").length, 1);
  assert.deepEqual(calls("hermes"), [], "the tag went nowhere");
  assert.ok(c.store.listMessages(c.pipeline.id, 200).some((m) => m.quiet && /Hermes, who isn't in this room/.test(m.text)), "and the work log says so");

  const ask = await c.orch.askAgent({ agentId: "claude", roomId: c.pipeline.id }, "hermes", "How many venues?");
  assert.match(ask, /^Hermes isn't in this room\. Agents here: @(claude|codex), @(claude|codex)\.$/);
  assert.deepEqual(calls("hermes"), []);
  assert.equal(c.orch.mayPost("hermes", c.pipeline.id).ok, false, "and it can't post");
  assert.equal(c.orch.mayPost("hermes", c.general.id).ok, false, "(not its turn there either)");
  assert.match(c.orch.mayPost("hermes", c.pipeline.id).why!, /roster/);

  // Subagents (3.1) ask the same helper: only the roster can be spawned in this room.
  const all = c.store.listAgents();
  assert.deepEqual(c.orch.rooms.spawnable(c.pipeline.id, all).map((a) => a.id).sort(), ["claude", "codex"]);
  assert.deepEqual(c.orch.rooms.spawnable(c.general.id, all).map((a) => a.id), all.map((a) => a.id));
  assert.deepEqual(c.orch.rooms.spawnable(undefined, all).map((a) => a.id), all.map((a) => a.id));
});

test("roster: a command (/agent:skill) for an agent outside the roster is refused", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", { roster: ["claude", "codex"] });
  const run = (c.orch as unknown as { runCommand: (r: string, text: string, agentId: string, inv: unknown) => Promise<void> }).runCommand.bind(c.orch);
  MockAdapter.calls.length = 0;
  await run(c.pipeline.id, "/hermes:x", "hermes", { command: { name: "x" }, prompt: "do x" });
  assert.deepEqual(calls("hermes"), []);
  assert.ok(sysTexts(c, c.pipeline.id).some((x) => /Hermes isn't in this room/.test(x)));
});

test("roster: an agent that joins later is added to the rooms that included everyone, and not to a room narrowed on purpose", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", { roster: ["claude", "codex"] }); // narrowed by the owner
  const stop = joinOpenRosters(c.store, () => c.control);
  t.after(stop);
  c.store.saveAgent({ id: "muse", name: "Muse", provider: "muse", adapter: "mock", enabled: true, color: "#E01E5A", settings: {}, tools: { web: true } });
  await until(() => read(c.root, "rooms/general/ROOM.md").includes("muse"), "muse to join the open room");
  await c.control.idle();
  assert.match(read(c.root, "rooms/general/ROOM.md"), /^updated_by: hub$/m);
  assert.ok(!read(c.root, "rooms/pipeline/ROOM.md").includes("muse"), "the narrowed room stays as the owner left it");
  assert.deepEqual(lint(c.root).blocks, []);
  assert.ok(c.orch.rooms.allows(c.general.id, "muse"));
  assert.ok(!c.orch.rooms.allows(c.pipeline.id, "muse"));
});

// ---------------------------------------------------------------- permissions

test("permissions: tools: { shell: off } removes shell from every run in that room, even with autoApprove; other rooms keep it", async (t) => {
  const c = await mk(t);
  const seen = capture(t);
  assert.equal(c.control.effectivePermissions("claude", "general").shell, "on", "claude runs shell without asking in general");
  await roomFile(c, "pipeline", { tools: { shell: "off" } });

  await c.orch.call(claudeOf(c), "hello", { roomId: c.pipeline.id });
  const there = seen.at(-1)!;
  assert.equal(there.agent.tools.shell, false);
  assert.equal(there.agent.autoApprove?.shell, undefined, "no auto-approval is left to use");
  const args = claudePermissionArgs(there.agent.tools, undefined, there.agent.autoApprove, there.ask);
  assert.ok(args.disallowed.includes("Bash") && !args.allowed.includes("Bash"), JSON.stringify(args));
  const cli = new ClaudeCodeAdapter().buildArgs({ ...there, agent: { ...there.agent, adapter: "claude-code" } });
  assert.ok(cli.join(" ").includes("--disallowedTools") && /--disallowedTools[^-]*Bash/.test(cli.join(" ")), cli.join(" "));
  assert.deepEqual(codexSandboxArgs({ filesystem: false, shell: there.agent.tools.shell, web: false }), ["--sandbox", "read-only"]);

  await c.orch.call(claudeOf(c), "hello", { roomId: c.general.id });
  const here = seen.at(-1)!;
  assert.equal(here.agent.tools.shell, true); assert.equal(here.agent.autoApprove?.shell, true);
  assert.ok(claudePermissionArgs(here.agent.tools, undefined, here.agent.autoApprove, here.ask).allowed.includes("Bash"), "general still allows it");
  assert.equal(claudeOf(c).tools.shell, true, "and the agent's own settings were never changed");
});

test("permissions: off denies the approval request, the MCP request_approval check and the file tools; nothing reaches the owner", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", { tools: { shell: "off", filesystem: "off" } });
  const grant = { agentId: "claude", roomId: c.pipeline.id };
  const res = await c.orch.requestApproval(grant, "shell", "run ls", "ls");
  assert.equal(res.status, "rejected");
  assert.deepEqual(c.store.listApprovals("pending"), [], "no card for the owner");
  assert.ok(c.store.listAudit(200).some((a) => a.actor === "claude" && a.action === "room.denied" && a.detail.startsWith("shell")));
  assert.match(c.orch.roomDenied(grant, "shell")!, /switched off for you in this room/);
  assert.equal(c.orch.roomDenied({ agentId: "claude", roomId: c.general.id }, "shell"), undefined);
  assert.equal(RoomRules.toolForClaudeName("Bash"), "shell");
  assert.equal(RoomRules.toolForClaudeName("Write"), "filesystem");

  // the same agent in general: its own auto-approval still works
  const ok = await c.orch.requestApproval({ agentId: "claude", roomId: c.general.id }, "shell", "run ls", "ls");
  assert.equal(ok.status, "approved"); assert.equal(ok.auto, true);

  // the file tools
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "grant-")));
  writeFileSync(join(dir, "a.txt"), "hello");
  c.orch.files.addGrant({ path: dir, agentId: "claude", read: true, write: true });
  assert.equal(c.orch.files.list("claude", c.general.id, ".").ok, true);
  const denied = c.orch.files.list("claude", c.pipeline.id, ".");
  assert.ok(!denied.ok && /switched off for this agent in this room/.test(denied.reason), JSON.stringify(denied));
  assert.equal(c.orch.files.read("claude", c.pipeline.id, "a.txt").ok, false);
  assert.equal(c.orch.files.proposeWrite("claude", c.pipeline.id, "b.txt", "x").ok, false);
});

test("permissions: tools: { shell: ask } forces an approval even though the agent auto-approves shell", async (t) => {
  const c = await mk(t);
  const seen = capture(t);
  await roomFile(c, "pipeline", { tools: { shell: "ask" } });
  await c.orch.call(claudeOf(c), "hello", { roomId: c.pipeline.id });
  const req = seen.at(-1)!;
  assert.deepEqual(req.ask, ["shell"]);
  assert.equal(req.agent.tools.shell, true, "still available");
  assert.equal(req.agent.autoApprove?.shell, undefined, "but not pre-approved");
  const args = claudePermissionArgs(req.agent.tools, undefined, req.agent.autoApprove, req.ask);
  assert.ok(!args.allowed.includes("Bash") && !args.disallowed.includes("Bash"), "left for the approval prompt tool to decide");
  assert.deepEqual(codexSandboxArgs({ filesystem: false, shell: true, web: false }, ["shell"]), ["--sandbox", "read-only"], "Codex can't stop to ask, so ask means no there");

  const p = c.orch.requestApproval({ agentId: "claude", roomId: c.pipeline.id }, "shell", "run ls", "ls");
  await until(() => c.store.listApprovals("pending").length === 1, "the approval card");
  assert.equal(c.store.listApprovals("pending")[0].tool, "shell");
  c.approvals.decide(c.store.listApprovals("pending")[0].id, "approved");
  assert.equal((await p).status, "approved");

  // another room, same agent, same tool: no card
  const auto = await c.orch.requestApproval({ agentId: "claude", roomId: c.general.id }, "shell", "run ls", "ls");
  assert.equal(auto.auto, true);
});

test("permissions: a tool the agent never had can still be asked for once; the room turning it off refuses even that", async (t) => {
  const c = await mk(t);
  const a = claudeOf(c); a.tools = { ...a.tools, gmail: false }; delete a.autoApprove?.gmail; c.store.saveAgent(a);
  await roomFile(c, "pipeline", { tools: {} });
  const p = c.orch.requestApproval({ agentId: "claude", roomId: c.pipeline.id }, "gmail", "send", "x");
  await until(() => c.store.listApprovals("pending").length === 1, "the approval card, as before 4.3");
  c.approvals.decide(c.store.listApprovals("pending")[0].id, "rejected");
  assert.equal((await p).status, "rejected");
  await roomFile(c, "pipeline", { tools: { gmail: "off" } });
  assert.equal((await c.orch.requestApproval({ agentId: "claude", roomId: c.pipeline.id }, "gmail", "send", "x")).status, "rejected");
  assert.deepEqual(c.store.listApprovals("pending"), [], "no card: the room said off");
});

test("roster: an agent added after the rosters were written joins the rooms that had everyone, until the file says otherwise", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline"); // claude, codex, hermes: everyone there is
  c.store.saveAgent({ ...claudeOf(c), id: "muse", name: "Muse" });
  assert.ok(c.orch.rooms.allows(c.pipeline.id, "muse"), "in until the file is edited");
  await roomFile(c, "pipeline", { roster: ["claude", "codex"] }); // the owner narrows it on purpose
  assert.ok(!c.orch.rooms.allows(c.pipeline.id, "muse"));
  assert.ok(!c.orch.rooms.allows(c.pipeline.id, "hermes"));
  await roomFile(c, "pipeline", { roster: ["claude"] });
  c.store.saveAgent({ ...claudeOf(c), id: "zed", name: "Zed" });
  assert.ok(!c.orch.rooms.allows(c.pipeline.id, "zed"), "a room that didn't include everyone stays as written");
});

test("permissions: a room can't loosen anything: ask on a tool the agent has off stays off, and a room with no ROOM.md changes nothing", async (t) => {
  const c = await mk(t);
  const seen = capture(t);
  await roomFile(c, "pipeline", { tools: { gmail: "ask", web: "ask" } });
  await c.orch.call(claudeOf(c), "hello", { roomId: c.pipeline.id });
  const req = seen.at(-1)!;
  assert.equal(req.agent.tools.gmail, false, "gmail was off for this agent and still is");
  assert.deepEqual(req.ask, ["web"], "web is on, so the room's ask applies to it");
  assert.deepEqual(c.orch.rooms.narrow(claudeOf(c), undefined).ask, [], "no room, no narrowing");
});

test("permissions: over MCP, a room that turns a tool off refuses Claude Code's prompt for it, request_approval and the file tools; ask reaches the owner", async (t) => {
  const c = await boot(t);
  await roomFile(c, "pipeline", { tools: { shell: "off", filesystem: "off", web: "ask" } });
  const connect = async (roomId: string) => {
    const token = `tok_${id("t")}`;
    c.orch.grants.set(token, { agentId: "claude", roomId, locked: true, expiresAt: Date.now() + 60_000 });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${c.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    t.after(() => client.close());
    return async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
  };
  const inPipeline = await connect(c.pipeline.id), inGeneral = await connect(c.general.id);

  assert.deepEqual(JSON.parse(await inPipeline("approval_prompt", { tool_name: "Bash", input: { command: "ls" } })), { behavior: "deny", message: "the shell tool is switched off for you in this room (ROOM.md)." });
  assert.equal(JSON.parse(await inPipeline("approval_prompt", { tool_name: "Write", input: { file_path: "x" } })).behavior, "deny", "Claude Code's Write is the filesystem tool");
  assert.match(await inPipeline("request_approval", { tool: "shell", action: "run", detail: "ls" }), /^DENIED: the shell tool is switched off for you in this room/);
  assert.match(await inPipeline("list_granted_folders"), /^DENIED:.*in this room/);
  assert.match(await inPipeline("file_write_status", { proposalId: "x" }), /^DENIED:.*in this room/);
  assert.deepEqual(c.store.listApprovals("pending"), [], "nothing for the owner to look at");
  assert.ok(c.store.listAudit(300).filter((a) => a.action === "room.denied").length >= 3);

  // general: shell auto-approved as before
  assert.equal(JSON.parse(await inGeneral("approval_prompt", { tool_name: "Bash", input: { command: "ls" } })).behavior, "allow");

  // ask: the prompt for web goes to the owner, who decides
  const pending = inPipeline("approval_prompt", { tool_name: "WebFetch", input: { url: "https://example.com" } });
  await until(() => c.store.listApprovals("pending").length === 1, "the approval card");
  assert.equal(c.store.listApprovals("pending")[0].tool, "web");
  c.approvals.decide(c.store.listApprovals("pending")[0].id, "rejected");
  assert.equal(JSON.parse(await pending).behavior, "deny");

  // read_memory: private notes made in another room don't come along
  const now = Date.now();
  const note = (idn: string, roomId: string | undefined, text: string) => c.store.saveMemory({ id: idn, scope: "private", ownerAgentId: "claude", roomId, text, sourceAgentId: "claude", confidence: 1, createdAt: now, source: { kind: "owner", at: now }, expiresAt: now + 30 * DAY, memKind: "fact" } as never);
  note("n1", c.pipeline.id, "PIPELINE-NOTE"); note("n2", c.general.id, "GENERAL-NOTE"); note("n3", undefined, "OWN-NOTE");
  const mine = await inGeneral("read_memory");
  assert.ok(mine.includes("GENERAL-NOTE") && mine.includes("OWN-NOTE") && !mine.includes("PIPELINE-NOTE"), mine);
  const there = await inPipeline("read_memory");
  assert.ok(there.includes("PIPELINE-NOTE") && there.includes("OWN-NOTE") && !there.includes("GENERAL-NOTE"), there);
});

// ---------------------------------------------------------------- folders

test("folders: ROOM.md folders limit which grants the room's goals and file tools can use", async (t) => {
  const c = await mk(t);
  const mkdir = (n: string, file: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), "grant-"))); writeFileSync(join(d, file), n); return d; };
  const d1 = mkdir("one", "one.txt"), d2 = mkdir("two", "two.txt");
  const g1 = c.orch.files.addGrant({ path: d1, agentId: "*", read: true, write: false });
  const g2 = c.orch.files.addGrant({ path: d2, agentId: "*", read: true, write: false });
  const ids = (room: string) => c.orch.files.grantsFor("claude", room).map((g) => g.id).sort();

  assert.deepEqual(ids(c.pipeline.id), [g1.id, g2.id].sort(), "no list, no limit");
  await roomFile(c, "pipeline", { folders: [g1.id] });
  assert.deepEqual(ids(c.pipeline.id), [g1.id], "only the listed grant");
  assert.deepEqual(ids(c.general.id), [g1.id, g2.id].sort(), "other rooms are untouched");

  // file tools
  const ok = c.orch.files.read("claude", c.pipeline.id, "one.txt");
  assert.ok(ok.ok && !ok.binary && ok.content === "one");
  const no = c.orch.files.read("claude", c.pipeline.id, "two.txt", g2.id);
  assert.ok(!no.ok && /unknown grantId/.test(no.reason), JSON.stringify(no));
  assert.equal(c.orch.files.list("claude", c.general.id, ".", g2.id).ok, true, "the same grant works from general");

  // goals
  assert.equal(c.orch.goalSources.usable(g1.id, c.pipeline.id).ok, true);
  const refused = c.orch.goalSources.usable(g2.id, c.pipeline.id);
  assert.ok(!refused.ok && /isn't open to this room's goals/.test(refused.reason), JSON.stringify(refused));
  const goal = await c.orch.runGoal(c.pipeline.id, "Summarize what is in the folder", { folderGrantId: g2.id });
  assert.equal(goal.sourceGrantId, undefined, "a folder outside the list is not attached to the goal");
  const goal1 = await c.orch.runGoal(c.pipeline.id, "Summarize what is in the folder", { folderGrantId: g1.id });
  assert.equal(goal1.sourceGrantId, g1.id);

  // editing the file changes it live
  await roomFile(c, "pipeline", { folders: [g2.id] });
  assert.deepEqual(ids(c.pipeline.id), [g2.id]);
  await roomFile(c, "pipeline", { folders: [] });
  assert.deepEqual(ids(c.pipeline.id), [g1.id, g2.id].sort(), "an empty list means no limit again");
});

// ---------------------------------------------------------------- memory

test("memory: what one standing room knows never reaches another room's prompts", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", { ...WEEKLY, roster: ["claude", "codex"] });
  const now = Date.now();
  const mem = (x: Record<string, unknown>) => c.store.saveMemory({ confidence: 1, sourceAgentId: "claude", createdAt: now, source: { kind: "owner", at: now }, expiresAt: now + 30 * DAY, memKind: "fact", ...x } as never);
  mem({ id: "m_p", scope: "shared", roomId: c.pipeline.id, text: "PIPELINE-FACT the Q4 target is 40 deals" });
  mem({ id: "m_g", scope: "shared", roomId: c.general.id, text: "GENERAL-FACT the office is in Austin" });
  mem({ id: "m_pn", scope: "private", ownerAgentId: "claude", roomId: c.pipeline.id, text: "PIPELINE-NOTE claude did the forecast" });
  mem({ id: "m_gn", scope: "private", ownerAgentId: "claude", roomId: c.general.id, text: "GENERAL-NOTE claude did the intro" });
  mem({ id: "m_own", scope: "private", ownerAgentId: "claude", text: "OWN-NOTE claude likes short answers" });

  const lastPrompt = () => calls("claude", "CHAT").at(-1)!.prompt;
  MockAdapter.calls.length = 0;
  await c.orch.handleOwnerMessage(c.general.id, "@claude what do you know?");
  await c.orch.idle();
  let p = lastPrompt();
  assert.ok(p.includes("GENERAL-FACT") && p.includes("GENERAL-NOTE") && p.includes("OWN-NOTE"), "general sees its own");
  assert.ok(!p.includes("PIPELINE-FACT") && !p.includes("PIPELINE-NOTE"), "and nothing from the standing room");

  await c.orch.handleOwnerMessage(c.pipeline.id, "@claude what do you know?");
  await c.orch.idle();
  p = lastPrompt();
  assert.ok(p.includes("PIPELINE-FACT") && p.includes("PIPELINE-NOTE") && p.includes("OWN-NOTE"), "the standing room sees its own");
  assert.ok(!p.includes("GENERAL-FACT") && !p.includes("GENERAL-NOTE"), "and nothing from general");

  // a task's prompt and the MCP read_memory answer use the same filter
  assert.deepEqual(c.orch.rooms.privateFor("claude", c.general.id).map((e) => e.id).sort(), ["m_gn", "m_own"]);
  assert.deepEqual(c.orch.rooms.privateFor("claude", c.pipeline.id).map((e) => e.id).sort(), ["m_own", "m_pn"]);
  assert.deepEqual(c.orch.rooms.privateFor("claude", undefined).map((e) => e.id), ["m_own"]);
});

test("memory: a standing room's facts stay in the room's MEMORY.md, out of the agent's own file and the context-file export", async (t) => {
  const c = await mk(t);
  c.orch.memory.close();
  await roomFile(c, "pipeline", WEEKLY);
  assert.ok(isStandingRoom(c.store, c.control, c.pipeline.id), "a schedule makes a room standing");
  assert.ok(!isStandingRoom(c.store, c.control, c.general.id), "a plain room isn't");
  const keeper = new MemoryKeeper({ store: c.store, approvals: c.approvals, control: () => c.control, ask: (async () => ({ decision: "accept" })) as never, dataDir: c.dir },
    { debounceMs: 5, exportEnv: { home: join(c.dir, "home"), vars: {} }, log: () => {} });
  t.after(() => keeper.close());
  const now = Date.now();
  const mem = (x: Record<string, unknown>) => c.store.saveMemory({ confidence: 1, sourceAgentId: "claude", createdAt: now, source: { kind: "owner", at: now }, expiresAt: now + 30 * DAY, memKind: "fact", ...x } as never);
  mem({ id: "m_p", scope: "shared", roomId: c.pipeline.id, text: "PIPELINE-FACT target is 40 deals" });
  mem({ id: "m_g", scope: "shared", roomId: c.general.id, text: "GENERAL-FACT office is in Austin" });
  mem({ id: "m_pn", scope: "private", ownerAgentId: "claude", roomId: c.pipeline.id, text: "PIPELINE-NOTE did the forecast" });
  mem({ id: "m_gn", scope: "private", ownerAgentId: "claude", roomId: c.general.id, text: "GENERAL-NOTE did the intro" });
  (keeper as unknown as { markAllDirty(): void }).markAllDirty();
  await keeper.idle();
  assert.match(read(c.root, "rooms/pipeline/MEMORY.md"), /PIPELINE-FACT/, "the room's own file has its facts");
  assert.ok(!read(c.root, "rooms/pipeline/MEMORY.md").includes("GENERAL-FACT"));
  assert.ok(!read(c.root, "rooms/general/MEMORY.md").includes("PIPELINE-FACT"));
  const mine = read(c.root, "agents/claude/MEMORY.md");
  assert.match(mine, /GENERAL-NOTE/);
  assert.ok(!mine.includes("PIPELINE-NOTE"), "the agent's own file, which every room's context carries, has nothing from the standing room");
  const exported = (keeper as unknown as { exporter: { factsFor(a: string): { id: string }[] } }).exporter.factsFor("claude").map((e) => e.id);
  assert.ok(exported.includes("m_g") && !exported.includes("m_p"), `export: ${exported.join(",")}`);
  assert.deepEqual(lint(c.root).blocks, []);
});

// ---------------------------------------------------------------- the calendar trigger

test("schedule: fires on time on a fake clock, once, as the owner, with the standing goal", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", WEEKLY);
  const clock = { t: at("2026-10-26T13:59:00Z") }; // Mon 08:59 CDT
  const h = standingOn(c, clock); const s = h.mkStanding();
  assert.equal(s.nextRun(c.pipeline.id), at("2026-10-26T14:00:00Z"));
  assert.deepEqual(s.tick().map((o) => o.kind), ["init"], "the first look starts the books and runs nothing");
  clock.t = at("2026-10-26T13:59:50Z");
  assert.deepEqual(s.tick(), [], "not yet");
  clock.t = at("2026-10-26T14:00:20Z");
  const [o] = s.tick();
  assert.equal(o.kind, "started");
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].text, "Weekly pipeline review");
  assert.deepEqual(h.runs[0].scheduled, { slot: at("2026-10-26T14:00:00Z") }, "on time: not a catch-up");
  const m = c.store.listMessages(c.pipeline.id, 50).find((x) => x.text.startsWith("Scheduled:"))!;
  assert.equal(m.text, "Scheduled: Weekly pipeline review");
  assert.deepEqual([m.author.kind, m.author.id, m.author.name, m.type], ["human", "owner", "Blake", "human"]);
  assert.ok(c.store.listAudit(100).some((a) => a.actor === "hub" && a.action === "standing.fired"));
  for (let i = 0; i < 5; i++) { clock.t += 20_000; assert.deepEqual(s.tick(), [], "no second run for the same slot"); }
  assert.equal(h.runs.length, 1);
  assert.equal(s.nextRun(c.pipeline.id), at("2026-11-02T15:00:00Z"), "next Monday, after the clocks went back");
  // a different room with no schedule never runs
  assert.equal(c.store.listGoals(c.general.id).length, 0);
});

test("schedule: a run is skipped, with a quiet note, while the previous scheduled goal is still going", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", WEEKLY);
  const clock = { t: at("2026-10-26T13:59:00Z") };
  const h = standingOn(c, clock); const s = h.mkStanding();
  s.tick(); clock.t = at("2026-10-26T14:00:10Z"); s.tick();
  assert.equal(h.runs.length, 1);
  clock.t = at("2026-11-02T15:00:10Z"); // next Monday; the first goal is still running
  const [o] = s.tick();
  assert.equal(o.kind, "busy");
  assert.equal(h.runs.length, 1, "nothing new started");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /^Skipped the scheduled run for .*: the last one \("Weekly pipeline review"\) is still going\.$/);
  assert.ok(!/—/.test(h.notes[0]));
  assert.ok(!c.store.listMessages(c.pipeline.id, 100).some((m) => !m.quiet && /Skipped/.test(m.text)), "the note doesn't interrupt the room (the work log gets it)");
  assert.equal(s.state(c.pipeline.id)!.note, h.notes[0]);
  clock.t += 30_000; assert.deepEqual(s.tick(), [], "the skipped slot is not retried");

  // a plan waiting for the owner counts as still going
  h.finish(h.runs[0].goalId, "awaiting_approval");
  clock.t = at("2026-11-09T15:00:10Z");
  assert.equal(s.tick()[0].kind, "busy");
  // once it is over, the next slot runs
  h.finish(h.runs[0].goalId, "done");
  clock.t = at("2026-11-16T15:00:10Z");
  assert.equal(s.tick()[0].kind, "started");
  assert.equal(h.runs.length, 2);
  // and a paused room skips too
  c.store.saveRoom({ ...c.store.getRoom(c.pipeline.id)!, paused: true });
  h.finish(h.runs[1].goalId, "done");
  clock.t = at("2026-11-23T15:00:10Z");
  assert.equal(s.tick()[0].kind, "paused");
  assert.equal(h.runs.length, 2);
});

test("schedule: never fires twice across a restart; the last slot is saved before the goal starts", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", WEEKLY);
  const clock = { t: at("2026-10-26T13:59:00Z") };
  const h = standingOn(c, clock);
  const first = h.mkStanding();
  first.tick(); clock.t = at("2026-10-26T14:00:10Z"); first.tick();
  assert.equal(h.runs.length, 1);
  // The hub restarts: a new object, the same database.
  const second = h.mkStanding();
  clock.t = at("2026-10-26T14:00:40Z");
  assert.deepEqual(second.tick(), [], "the restarted hub knows the slot ran");
  clock.t = at("2026-10-26T14:03:00Z");
  assert.deepEqual(second.tick(), []);
  assert.equal(h.runs.length, 1);
  assert.equal(second.state(c.pipeline.id)!.lastGoalId, h.runs[0].goalId);
  // Even when the first start crashed, the slot is spent: it is not tried a second time.
  const c2 = await mk(t);
  await roomFile(c2, "pipeline", WEEKLY);
  const clock2 = { t: at("2026-10-26T13:59:00Z") };
  let tries = 0;
  const boom = new StandingRooms({ store: c2.store, control: () => c2.control, attention: c2.orch.attention, runGoal: async () => { tries++; throw new Error("planner is down"); }, note: () => undefined, fallbackZone: () => "UTC", ownerName: () => "Blake" });
  boom.clock = () => clock2.t;
  boom.tick(); clock2.t = at("2026-10-26T14:00:10Z"); boom.tick(); await sleep(5);
  clock2.t += 40_000; boom.tick();
  assert.equal(tries, 1);
  assert.ok(c2.store.listAudit(100).some((a) => a.action === "standing.error" && /planner is down/.test(a.detail)));
});

test("schedule: a hub that was asleep catches up once within the window; older than the window it is skipped and goes in the digest", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", { ...WEEKLY, schedule: "0 9 * * *" }); // daily 09:00 Chicago
  const clock = { t: at("2026-10-26T13:00:00Z") }; // Mon 08:00 CDT
  const h = standingOn(c, clock); const s = h.mkStanding();
  s.tick();
  // Asleep for two mornings, back Tue 10:00 CDT. Two slots passed; one run, as a catch-up.
  clock.t = at("2026-10-27T15:00:00Z");
  const [o] = s.tick();
  assert.equal(o.kind, "started");
  assert.ok(o.kind === "started" && o.catchUp && o.skippedEarlier === 1);
  assert.equal(h.runs.length, 1, "once, not twice");
  assert.deepEqual(h.runs[0].scheduled, { slot: at("2026-10-27T14:00:00Z"), catchUp: true });
  assert.match(h.notes.at(-1)!, /^Caught up: ran "Weekly pipeline review" for .*; the hub wasn't running then\. 1 earlier run was missed too\.$/);
  assert.ok(c.orch.attention.state().queue.some((i) => i.key === `standing:caught-up:${c.pipeline.id}:${at("2026-10-27T14:00:00Z")}`), "and it is in the digest");
  h.finish(h.runs[0].goalId);
  clock.t += 60_000; assert.deepEqual(s.tick(), []);

  // Asleep until Wed 22:00 CDT: Wed's 09:00 slot is 13 hours old, past the 12 hour default.
  clock.t = at("2026-10-29T03:00:00Z");
  const [m] = s.tick();
  assert.equal(m.kind, "missed");
  assert.equal(h.runs.length, 1, "not run");
  const item = c.orch.attention.state().queue.find((i) => i.key?.startsWith("standing:missed:"))!;
  assert.ok(item && item.kind === "info" && item.why === "digest", "quietly, for the digest");
  assert.match(item.body, /more than 12 hours ago, so it wasn't run/);
  assert.ok(!/—/.test(item.body));
  assert.ok(c.store.listAudit(100).some((a) => a.action === "standing.missed"));
  // the next morning runs on time as usual
  clock.t = at("2026-10-29T14:00:10Z");
  assert.equal(s.tick()[0].kind, "started");
  assert.equal(h.runs[1].scheduled!.catchUp, undefined);
});

test("schedule: the catch-up window is the room's catch_up_hours, else the hub setting standingCatchUpHours, else 12", async (t) => {
  const c = await mk(t);
  const clock = { t: at("2026-10-26T13:00:00Z") };
  const h = standingOn(c, clock); const s = h.mkStanding();
  await roomFile(c, "pipeline", { ...WEEKLY, schedule: "0 9 * * *", catch_up_hours: 2 });
  assert.equal(s.scheduleOf(c.pipeline.id).ok && (s.scheduleOf(c.pipeline.id) as { schedule: { catchUpHours: number } }).schedule.catchUpHours, 2);
  s.tick();
  clock.t = at("2026-10-26T17:30:00Z"); // 12:30 CDT, 3.5 hours after the slot
  assert.equal(s.tick()[0].kind, "missed", "past the room's 2 hours");

  await roomFile(c, "pipeline", { ...WEEKLY, schedule: "0 9 * * *" });
  assert.equal((s.scheduleOf(c.pipeline.id) as { schedule: { catchUpHours: number } }).schedule.catchUpHours, 12, "the default");
  c.store.setSettings({ ...c.store.getSettings(), standingCatchUpHours: 30 });
  assert.equal((s.scheduleOf(c.pipeline.id) as { schedule: { catchUpHours: number } }).schedule.catchUpHours, 30, "the hub setting");
  clock.t = at("2026-10-26T15:00:00Z"); s.tick(); // changed schedule starts from now
  clock.t = at("2026-10-28T02:00:00Z"); // Tue 21:00 CDT: the slot was 12 hours ago
  assert.equal(s.tick()[0].kind, "started", "inside 30 hours");
});

test("schedule: the time zone is the room's, else USER.md's, else the hub's; a schedule just added or changed has nothing overdue", async (t) => {
  const c = await mk(t);
  const clock = { t: at("2026-10-26T13:59:00Z") };
  const h = standingOn(c, clock); const s = h.mkStanding();
  const zone = () => (s.scheduleOf(c.pipeline.id) as { schedule: { zone: string } }).schedule.zone;
  write(c.root, "USER.md", emitFile(head("user", { name: "Blake", timezone: "America/Los_Angeles" }), "Blake\n"));
  await roomFile(c, "pipeline", { schedule: "0 9 * * 1", standing_goal: "Weekly pipeline review" });
  assert.equal(zone(), "America/Los_Angeles", "USER.md");
  await roomFile(c, "pipeline", WEEKLY);
  assert.equal(zone(), "America/Chicago", "the room's own wins");
  await roomFile(c, "pipeline", { ...WEEKLY, timezone: "Nowhere/Town" });
  assert.equal(zone(), "America/Los_Angeles", "a bad name falls back (the linter flagged it)");

  // Added late on a Monday after 09:00: nothing is overdue, the first run is next Monday.
  await roomFile(c, "pipeline", WEEKLY);
  clock.t = at("2026-10-26T20:00:00Z");
  assert.deepEqual(s.tick().map((o) => o.kind), ["init"]);
  assert.equal(h.runs.length, 0);
  // Changing the schedule starts again from now too.
  await roomFile(c, "pipeline", { ...WEEKLY, schedule: "0 9 * * 2" });
  clock.t = at("2026-10-27T13:00:00Z"); assert.deepEqual(s.tick().map((o) => o.kind), ["init"]);
  clock.t = at("2026-10-27T14:00:30Z"); assert.equal(s.tick()[0].kind, "started");
  // Taking the schedule out stops it and forgets it.
  await roomFile(c, "pipeline", {});
  clock.t = at("2026-11-03T15:00:30Z"); assert.deepEqual(s.tick(), []);
  assert.equal(s.state(c.pipeline.id), undefined);
});

test("schedule: through the real orchestrator, the goal starts in that room as a scheduled goal and runs to the end", async (t) => {
  const c = await mk(t);
  await roomFile(c, "pipeline", { ...WEEKLY, standing_goal: "Research the topic and write the summary" });
  const clock = { t: at("2026-10-26T13:59:00Z") };
  c.orch.standing.clock = () => clock.t;
  c.orch.standing.tick();
  clock.t = at("2026-10-26T14:00:15Z");
  const [o] = c.orch.standing.tick();
  assert.equal(o.kind, "started");
  const goals = c.store.listGoals(c.pipeline.id);
  assert.equal(goals.length, 1);
  assert.deepEqual(goals[0].scheduled, { slot: at("2026-10-26T14:00:00Z") });
  assert.equal(goals[0].text, "Research the topic and write the summary");
  await until(() => c.store.getGoal(goals[0].id)!.status === "done", "the scheduled goal to finish", 20_000);
  assert.ok(c.store.listMessages(c.pipeline.id, 100).some((m) => m.text === "Scheduled: Research the topic and write the summary" && m.author.kind === "human"));
  assert.ok(c.orch.standing.nextRun(c.pipeline.id)! > clock.t);
  assert.equal(c.orch.standing.running(c.pipeline.id), false);
});

// ---------------------------------------------------------------- the file is the room

test("live: editing ROOM.md changes the roster, tools and schedule at the next message, with no restart", async (t) => {
  const c = await mk(t);
  const seen = capture(t);
  // open to everyone
  MockAdapter.calls.length = 0;
  await c.orch.handleOwnerMessage(c.pipeline.id, "@hermes hello there?");
  await c.orch.idle();
  assert.equal(calls("hermes", "CHAT").length, 1);
  // the owner takes hermes out of the roster in an editor
  await roomFile(c, "pipeline", { roster: ["claude", "codex"] });
  MockAdapter.calls.length = 0;
  await c.orch.handleOwnerMessage(c.pipeline.id, "@hermes hello again?");
  await c.orch.idle();
  assert.deepEqual(calls("hermes"), []);
  // and puts it back
  await roomFile(c, "pipeline", { roster: ["claude", "codex", "hermes"] });
  await c.orch.handleOwnerMessage(c.pipeline.id, "@hermes hello once more?");
  await c.orch.idle();
  assert.equal(calls("hermes", "CHAT").length, 1);
  // tools
  await c.orch.call(claudeOf(c), "x", { roomId: c.pipeline.id });
  assert.equal(seen.at(-1)!.agent.tools.shell, true);
  await roomFile(c, "pipeline", { tools: { shell: "off" } });
  await c.orch.call(claudeOf(c), "x", { roomId: c.pipeline.id });
  assert.equal(seen.at(-1)!.agent.tools.shell, false);
  await roomFile(c, "pipeline", {});
  await c.orch.call(claudeOf(c), "x", { roomId: c.pipeline.id });
  assert.equal(seen.at(-1)!.agent.tools.shell, true);
  // a broken edit keeps the last good file: the room doesn't change
  await roomFile(c, "pipeline", { roster: ["claude"] });
  assert.deepEqual(c.orch.rooms.rosterIds(c.pipeline.id), ["claude"]);
  write(c.root, "rooms/pipeline/ROOM.md", "---\nkind: room\nschema: 1\nname: pipeline\nroster: [claude\n---\nbroken\n");
  await c.control.load();
  assert.deepEqual(c.orch.rooms.rosterIds(c.pipeline.id), ["claude"], "the last good copy stands");
  // schedule
  await roomFile(c, "pipeline", WEEKLY);
  assert.ok(c.orch.standing.scheduleOf(c.pipeline.id).ok);
  await roomFile(c, "pipeline", {});
  assert.equal(c.orch.standing.scheduleOf(c.pipeline.id).ok, false);
});

// ---------------------------------------------------------------- the apps' API

test("api: GET /rooms/:id/definition reads the room from ROOM.md: roster, narrowed tools, folders, schedule and next run", async (t) => {
  const c = await boot(t);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "grant-")));
  const g = c.orch.files.addGrant({ path: dir, agentId: "*", read: true, write: false, label: "Deals" });
  await roomFile(c, "pipeline", { ...WEEKLY, roster: ["claude", "codex"], tools: { shell: "off", web: "ask" }, folders: [g.id, "grant_gone"], in_scope: ["pipeline"], out_of_scope: ["billing"] });
  c.orch.standing.clock = () => at("2026-10-23T15:00:00Z");
  const r = await api(c, "GET", `/rooms/${c.pipeline.id}/definition`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.slug, "pipeline"); assert.equal(d.hasFile, true); assert.equal(d.open, false);
  assert.equal(d.path, join(c.root, "rooms/pipeline/ROOM.md"));
  assert.equal(d.memoryPath, join(c.root, "rooms/pipeline/MEMORY.md"));
  assert.deepEqual(d.roster.map((a: { id: string }) => a.id), ["claude", "codex"]);
  assert.ok(d.roster[0].name && d.roster[0].color);
  assert.deepEqual(d.tools, [{ tool: "shell", label: "Shell commands", level: "off" }, { tool: "web", label: "Web browsing", level: "ask" }]);
  assert.deepEqual(d.folders, [{ id: g.id, label: "Deals", path: dir }, { id: "grant_gone", missing: true }]);
  assert.deepEqual(d.inScope, ["pipeline"]); assert.deepEqual(d.outOfScope, ["billing"]);
  const { nextRun, ...sched } = d.schedule;
  assert.deepEqual(sched, { cron: "0 9 * * 1", timezone: "America/Chicago", standingGoal: "Weekly pipeline review", catchUpHours: 12, active: true });
  assert.equal(nextRun, at("2026-10-26T14:00:00Z"));
  // an open room
  const open = (await api(c, "GET", `/rooms/${c.general.id}/definition`)).body;
  assert.equal(open.open, true, "a roster that names everyone is an open room"); assert.equal(open.roster.length, 3); assert.equal(open.schedule, undefined); assert.deepEqual(open.tools, []);
  assert.equal((await api(c, "GET", "/rooms/nope/definition")).status, 404);
  assert.equal((await fetch(`${c.base}/rooms/${c.pipeline.id}/definition`)).status, 401, "paired devices only");
  // a schedule that can't run says why
  await roomFile(c, "pipeline", { schedule: "0 9 * *", standing_goal: "x" });
  const bad = (await api(c, "GET", `/rooms/${c.pipeline.id}/definition`)).body;
  assert.equal(bad.schedule.active, false); assert.match(bad.schedule.problem, /isn't valid/); assert.equal(bad.schedule.nextRun, undefined);
});

test("api: PUT /rooms/:id/definition writes ROOM.md through the control folder as the owner, one commit, keeping the body", async (t) => {
  const c = await boot(t);
  await roomFile(c, "pipeline", { in_scope: ["pipeline"] }, "My own words about this room.\n");
  const changes = () => commits(c.root).filter((l) => /^owner\|Change #pipeline/.test(l)).length; // (the file written above is committed first, as an editor edit)
  const r = await api(c, "PUT", `/rooms/${c.pipeline.id}/definition`, { roster: ["claude", "codex"], schedule: "0 9 * * 1", standingGoal: "Weekly pipeline review", timezone: "America/Chicago" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const file = read(c.root, "rooms/pipeline/ROOM.md");
  assert.match(file, /^schedule: 0 9 \* \* 1$|^schedule: ["']0 9 \* \* 1["']$/m);
  assert.match(file, /^standing_goal: Weekly pipeline review$/m);
  assert.match(file, /^timezone: America\/Chicago$/m);
  assert.match(file, /^updated_by: owner$/m);
  assert.ok(file.includes("My own words about this room."), "the body is the owner's");
  assert.match(file, /^in_scope: \[pipeline\]$/m, "other fields stay");
  assert.deepEqual(lint(c.root), { blocks: [], flags: [] });
  const log = commits(c.root);
  assert.equal(changes(), 1, `one commit: ${log.slice(0, 3).join(" / ")}`);
  assert.match(log[0], /^owner\|Change #pipeline: roster, schedule, time zone, standing goal/);
  assert.deepEqual(r.body.roster.map((a: { id: string }) => a.id), ["claude", "codex"]);
  assert.equal(r.body.schedule.active, true);
  assert.ok(c.store.listAudit(100).some((a) => a.actor === "owner" && a.action === "room.definition.updated"));
  assert.deepEqual(c.orch.rooms.rosterIds(c.pipeline.id), ["claude", "codex"], "live at once");
  // same again: no commit
  await api(c, "PUT", `/rooms/${c.pipeline.id}/definition`, { roster: ["claude", "codex"], schedule: "0 9 * * 1" });
  assert.equal(changes(), 1, "no change, no commit");
  // clear the schedule
  const cleared = await api(c, "PUT", `/rooms/${c.pipeline.id}/definition`, { schedule: null, standingGoal: null, timezone: null });
  assert.equal(cleared.status, 200);
  assert.ok(!/schedule:|standing_goal:|timezone:/.test(read(c.root, "rooms/pipeline/ROOM.md")));
  assert.equal(cleared.body.schedule, undefined);
});

test("api: PUT /rooms/:id/definition refuses what the linter or the roster would, and changes nothing", async (t) => {
  const c = await boot(t);
  await roomFile(c, "pipeline", {});
  const file = read(c.root, "rooms/pipeline/ROOM.md");
  const log = commits(c.root);
  const bad = async (body: unknown, want: RegExp, status = 400) => {
    const r = await api(c, "PUT", `/rooms/${c.pipeline.id}/definition`, body);
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.match(r.body.error, want);
  };
  await bad({ schedule: "every monday" }, /The schedule isn't valid: a schedule needs 5 fields/);
  await bad({ schedule: "61 9 * * *" }, /minute 61/);
  await bad({ roster: ["claude", "ghost"] }, /There is no agent called "ghost"/);
  await bad({ timezone: "Mars/Base" }, /isn't a time zone/);
  await bad({ catchUpHours: 999 }, /catchUpHours/);
  await bad({ tools: { shell: "on" } }, /request|tools/i); // not editable from here
  assert.equal(read(c.root, "rooms/pipeline/ROOM.md"), file); assert.deepEqual(commits(c.root), log);
  assert.equal((await api(c, "PUT", `/rooms/nope/definition`, { roster: ["claude"] })).status, 404);
  const dm = c.store.listRooms().find((r) => r.dmAgentId) ?? c.store.createRoom("dm", { dmAgentId: "claude" });
  const dmr = await api(c, "PUT", `/rooms/${dm.id}/definition`, { roster: ["claude"] });
  assert.equal(dmr.status, 400); assert.match(dmr.body.error, /direct-message room has no ROOM\.md/);
  // an empty roster, a schedule without a goal: allowed, and the linter flags the second
  const ok = await api(c, "PUT", `/rooms/${c.pipeline.id}/definition`, { schedule: "0 9 * * 1" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.schedule.active, false);
  assert.match(ok.body.schedule.problem, /no standing_goal/);
});

test("api: the catch-up window is a hub setting (standingCatchUpHours)", async (t) => {
  const c = await boot(t);
  const r = await api(c, "PUT", "/settings", { standingCatchUpHours: 6 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await api(c, "GET", "/settings")).body.standingCatchUpHours, 6);
  await roomFile(c, "pipeline", WEEKLY);
  assert.equal((await api(c, "GET", `/rooms/${c.pipeline.id}/definition`)).body.schedule.catchUpHours, 6);
  assert.notEqual((await api(c, "PUT", "/settings", { standingCatchUpHours: 500 })).status, 200);
});

test("api: Edit ROOM.md answers with the path (and says if it could not open it); no file, no open", async (t) => {
  const c = await boot(t);
  const none = await api(c, "POST", `/rooms/${c.pipeline.id}/definition/open`);
  if (none.status === 200) assert.equal(typeof none.body.ok, "boolean"); else assert.match(none.body.error, /no ROOM\.md/);
  await roomFile(c, "pipeline");
  const r = await api(c, "POST", `/rooms/${c.pipeline.id}/definition/open`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.path, /rooms\/pipeline\/ROOM\.md$/);
  assert.equal(typeof r.body.ok, "boolean", "ok says whether the editor opened (false off a Mac)");
  assert.equal((await api(c, "POST", `/rooms/nope/definition/open`)).status, 404);
  const dm = c.store.listRooms().find((r2) => r2.dmAgentId) ?? c.store.createRoom("dm", { dmAgentId: "claude" });
  assert.equal((await api(c, "POST", `/rooms/${dm.id}/definition/open`)).status, 404);
});

test("ui: the Mac app and the phone read the room definition; the phone only reads", () => {
  const here = dirname(new URL(import.meta.url).pathname);
  const app = join(here, "../../app/src");
  const client = readFileSync(join(app, "api/client.ts"), "utf8");
  assert.match(client, /roomDefinition = \(id: string\) => this\.req<RoomDefinition>\(`\/rooms\/\$\{id\}\/definition`\)/);
  assert.match(client, /saveRoomDefinition = .*"PUT", `\/rooms\/\$\{id\}\/definition`/);
  assert.match(client, /openRoomFile = .*`\/rooms\/\$\{id\}\/definition\/open`/);
  const comp = readFileSync(join(app, "components/RoomSettings.tsx"), "utf8");
  for (const s of ["Roster", "Tools in this room", "Folders", "Schedule", "Edit ROOM.md", "Next run", "def.path"]) assert.ok(comp.includes(s), s);
  assert.match(comp, /hub\.saveRoomDefinition\(roomId, input\)/);
  const screen = readFileSync(join(app, "screens/RoomScreen.tsx"), "utf8");
  assert.match(screen, /<RoomSettings roomId=\{roomId\}/);
  assert.match(screen, /label="Room settings"/);
  const web = readFileSync(join(here, "../web/app.js"), "utf8");
  assert.match(web, /api\(`\/rooms\/\$\{encodeURIComponent\(roomId\)\}\/definition`\)/);
  const info = web.slice(web.indexOf("function renderRoomInfo"), web.indexOf("function renderControl"));
  // The room definition (roster, tools, folders, schedule) is still read-only on the phone: the render writes nothing and uses no innerHTML.
  assert.ok(info.length > 200 && !/method:\s*"(PUT|POST|DELETE)"/.test(info) && !/innerHTML/.test(info), "read only, built without innerHTML");
  // Simple by default adds one quiet write: a Delete room action, handled by deleteRoomAction (DELETE, with a force fallback).
  assert.match(info, /data-del-room/, "the info screen offers Delete room");
  assert.match(web, /\$\{force \? "\?force=1" : ""\}`, \{ method: "DELETE" \}\)/, "delete uses the force flag");
  assert.match(readFileSync(join(here, "../web/index.html"), "utf8"), /id="infoBtn"/);
});
