import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, lstatSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerEvent } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { ControlFolder } from "../src/control/folder.js";
import { buildTaskContextDetailed, buildTaskContext, restoreTaskContext, writeTaskContext, BEGIN, END } from "../src/control/context.js";
import { lint } from "../src/control/lint.js";
import { emitFile } from "../src/control/parse.js";
import { setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;

async function mk(t: TestContext, o: { watch?: boolean; prep?: (c: Ctx) => void } = {}) {
  const ctx = setup();
  o.prep?.(ctx);
  const root = join(ctx.dir, "Agent Room");
  const control = new ControlFolder(root, ctx.store, { debounceMs: 40, ownerName: "Blake", watch: o.watch ?? true });
  await control.init();
  control.start();
  ctx.orch.control = control;
  t.after(() => control.close());
  return { ...ctx, control, root };
}

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const commits = (root: string) => git(root, "log", "--format=%an|%s").trim().split("\n").filter(Boolean);
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const write = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await sleep(15); }
}
const head = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, schema: 1, updated: "2026-10-23", updated_by: "owner", ...extra });

async function api(ctx: { app: Awaited<ReturnType<typeof buildServer>>; base: string; token: string }, method: string, path: string, body?: unknown) {
  const res = await fetch(`${ctx.base}${path}`, { method, headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}
async function boot(t: TestContext, o: Parameters<typeof mk>[1] = {}) {
  const c = await mk(t, o);
  const app = await buildServer({ store: c.store, orch: c.orch, approvals: c.approvals, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await pr.json()) as { token: string };
  return { ...c, app, base, token };
}

// ---------------------------------------------------------------- AC4, AC1: generation from the Store

test("1.9 init: generates valid control files from the Store and commits once", async (t) => {
  const { root, store } = await mk(t);
  for (const f of ["AGENTS.md", "USER.md", "POLICY.md", "agents/claude/SOUL.md", "agents/claude/TOOLS.md", "agents/codex/TOOLS.md", "agents/hermes/SOUL.md", "rooms/general/ROOM.md"]) {
    assert.ok(existsSync(join(root, f)), f);
  }
  assert.match(read(root, "USER.md"), /name: Blake/);
  assert.match(read(root, "agents/claude/SOUL.md"), /color: "?#6B4FD8"?/i);
  assert.match(read(root, "agents/claude/TOOLS.md"), /room_allows:[\s\S]*web: on[\s\S]*shell: off/);
  assert.match(read(root, "rooms/general/ROOM.md"), /Give the room a goal/);
  assert.match(read(root, ".gitignore"), /^Library\/$/m);
  assert.deepEqual(lint(root), { blocks: [], flags: [] });
  const log = commits(root);
  assert.equal(log.length, 1, "one commit for the whole generation");
  assert.match(log[0], /^hub\|Create the control folder/);
  assert.ok(existsSync(join(root, "Library")) && !git(root, "ls-files").includes("Library"));
  assert.equal(store.getAgent("claude")!.name, "Claude", "loading what it just wrote changes nothing");
});

test("1.9 init never overwrites a file that exists", async (t) => {
  const c = setup();
  const root = join(c.dir, "Agent Room");
  write(root, "USER.md", `${emitFile(head("user", { name: "Casey", timezone: "UTC" }), "Mine.\n")}`);
  const control = new ControlFolder(root, c.store, { watch: false });
  t.after(() => control.close());
  await control.init();
  assert.match(read(root, "USER.md"), /name: Casey/);
  assert.match(read(root, "USER.md"), /Mine\./);
});

// ---------------------------------------------------------------- AC2: file -> app

test("1.9 editing TOOLS.md in an editor (web off) updates the agent within the debounce window and is committed", async (t) => {
  const { root, store, control } = await mk(t);
  const events: ServerEvent[] = []; store.on("event", (e: ServerEvent) => events.push(e));
  assert.equal(store.getAgent("claude")!.tools.web, true);
  const before = commits(root).length;
  write(root, "agents/claude/TOOLS.md", read(root, "agents/claude/TOOLS.md").replace("web: on", "web: off"));
  await until(() => store.getAgent("claude")!.tools.web === false, "the agent to pick up the edit");
  await control.idle();
  assert.equal(store.getAgent("claude")!.tools.filesystem, true, "other tools untouched");
  const log = commits(root);
  assert.equal(log.length, before + 1);
  assert.match(log[0], /^owner\|Edit agents\/claude\/TOOLS\.md in an editor/);
  assert.ok(events.some((e) => e.type === "control" && e.changed.includes("agents/claude/TOOLS.md")), "a control event went out");
  assert.equal(control.effectivePermissions("claude").web, "off");
});

test("1.9 editing SOUL.md and ROOM.md in an editor changes the name, colour and topic in the Store", async (t) => {
  const { root, store, control, room } = await mk(t);
  write(root, "agents/codex/SOUL.md", read(root, "agents/codex/SOUL.md").replace(/name: Codex/, "name: Codey").replace(/color: .*/, "color: \"#112233\""));
  write(root, "rooms/general/ROOM.md", read(root, "rooms/general/ROOM.md").replace("Give the room a goal, or @mention an agent", "Ship the beta"));
  await until(() => store.getAgent("codex")!.name === "Codey" && store.getRoom(room.id)!.topic === "Ship the beta", "name and topic");
  assert.equal(store.getAgent("codex")!.color, "#112233");
  await control.idle();
  assert.equal(commits(root).filter((l) => l.startsWith("owner|Edit")).length, 2, "one commit per changed file");
});

test("1.9 a new agent folder written in an editor creates the agent; a deleted agent does not come back", async (t) => {
  const { root, store, control } = await mk(t);
  const claude = store.getAgent("claude")!;
  write(root, "agents/scout/SOUL.md", emitFile(head("soul", { name: "Scout", color: "#445566", role: "Finds things", tone: "Curt" }), "Scout.\n"));
  write(root, "agents/scout/TOOLS.md", emitFile(head("tools", { runtime: { adapter: "mock", provider: "custom", enabled: true }, room_allows: { web: "on", shell: "ask" } }), "Notes.\n"));
  await until(() => !!store.getAgent("scout"), "the new agent");
  assert.equal(store.getAgent("scout")!.tools.web, true);
  assert.equal(store.getAgent("scout")!.tools.shell, true);
  assert.ok(!store.getAgent("scout")!.autoApprove?.shell, "ask, not run freely");
  // Deleting an agent in the app must survive the next reload.
  store.deleteAgent("claude");
  await control.load();
  assert.equal(store.getAgent("claude"), undefined);
  store.saveAgent(claude);
});

// ---------------------------------------------------------------- AC2: app -> file

test("1.9 PUT /agents/:id/tools writes TOOLS.md, commits as owner, and doesn't echo", async (t) => {
  const c = await boot(t);
  const { root, store, control } = c;
  const before = commits(root);
  const agentEvents: ServerEvent[] = []; store.on("event", (e: ServerEvent) => { if (e.type === "agent") agentEvents.push(e); });
  const r = await api(c, "PUT", "/agents/claude/tools", { gmail: true });
  assert.equal(r.status, 200);
  await control.idle();
  await sleep(250); // several debounce windows: an echo would show up as a second commit or another agent event
  await control.idle();
  assert.match(read(root, "agents/claude/TOOLS.md"), /gmail: ask/);
  const log = commits(root);
  assert.equal(log.length, before.length + 1, "exactly one new commit");
  assert.match(log[0], /^owner\|Change Claude: gmail asks first \(from the app\)/);
  assert.equal(agentEvents.length, 1, "the Store was not rewritten by the reload");
  assert.equal(git(root, "status", "--porcelain").trim(), "", "nothing left uncommitted");
  assert.equal(store.getAgent("claude")!.tools.gmail, true);
});

test("1.9 'run without asking' from the app round-trips through a policy rule", async (t) => {
  const c = await boot(t);
  const { root, store, control } = c;
  await api(c, "PUT", "/agents/claude/tools", { shell: true });
  await api(c, "PUT", "/agents/claude/auto-approve", { shell: true });
  await control.idle(); await sleep(150); await control.idle();
  assert.match(read(root, "agents/claude/TOOLS.md"), /shell: on/);
  assert.match(read(root, "POLICY.md"), /id: app-claude-shell/);
  assert.deepEqual(lint(root).flags, [], "the rule makes room_allows legitimate, so nothing is flagged");
  assert.equal(store.getAgent("claude")!.autoApprove?.shell, true, "a reload keeps what the owner chose");
  assert.equal(control.effectivePermissions("claude").shell, "on");
  await api(c, "PUT", "/agents/claude/auto-approve", { shell: false });
  await control.idle(); await sleep(150); await control.idle();
  assert.doesNotMatch(read(root, "POLICY.md"), /app-claude-shell/);
  assert.match(read(root, "agents/claude/TOOLS.md"), /shell: ask/);
  assert.equal(control.effectivePermissions("claude").shell, "ask");
});

test("1.9 app changes to a room's topic and name reach ROOM.md; a rename moves the folder", async (t) => {
  const c = await boot(t);
  const { root, store, control, room } = c;
  await api(c, "PUT", `/rooms/${room.id}`, { topic: "Quarterly planning" });
  await control.idle();
  assert.match(read(root, "rooms/general/ROOM.md"), /^Quarterly planning$/m);
  assert.match(commits(root)[0], /^owner\|Change the topic of #general/);
  await api(c, "PUT", `/rooms/${room.id}`, { name: "planning" });
  await control.idle(); await sleep(150); await control.idle();
  assert.ok(existsSync(join(root, "rooms/planning/ROOM.md")) && !existsSync(join(root, "rooms/general")));
  assert.match(read(root, "rooms/planning/ROOM.md"), /name: planning/);
  assert.match(commits(root)[0], /Rename room to planning/);
  assert.equal(store.getRoom(room.id)!.topic, "Quarterly planning");
  const created = await api(c, "POST", "/rooms", { name: "Ops Team", topic: "Keep it running" });
  await control.idle();
  assert.match(read(root, "rooms/ops-team/ROOM.md"), /Keep it running/);
  assert.equal(created.status, 200);
});

// ---------------------------------------------------------------- AC5: lint blocks, last good stays

test("1.9 a malformed SOUL.md is blocked: the last good version stays loaded and a notice is raised", async (t) => {
  const { root, store, control } = await mk(t);
  const events: ServerEvent[] = []; store.on("event", (e: ServerEvent) => events.push(e));
  write(root, "agents/claude/SOUL.md", "---\nkind: soul\nschema: 1\nupdated: 2026-10-23\nupdated_by: owner\nname: [broken\ncolor: \"#000000\"\n---\nBody\n");
  await until(() => control.status().notices.some((n) => n.file === "agents/claude/SOUL.md"), "the notice");
  const n = control.status().notices.find((x) => x.file === "agents/claude/SOUL.md")!;
  assert.equal(n.level, "block");
  assert.ok(n.line && n.line >= 2, `has a line (${n.line})`);
  assert.match(n.message, /Keeping the last good version/);
  assert.equal(store.getAgent("claude")!.name, "Claude");
  assert.equal(control.snapshot().agents.claude.soul!.fm.name, "Claude");
  assert.ok(events.some((e) => e.type === "control" && e.notices.some((x) => x.file === "agents/claude/SOUL.md")));
  assert.equal(lint(root).blocks.filter((b) => b.file === "agents/claude/SOUL.md").length > 0, true);
  // Fixing it clears the notice and loads the new version.
  write(root, "agents/claude/SOUL.md", emitFile(head("soul", { name: "Claudia", color: "#6B4FD8", role: "Lead", tone: "Warm" }), "Hi.\n"));
  await until(() => store.getAgent("claude")!.name === "Claudia", "the fix");
  assert.equal(control.status().notices.filter((x) => x.file === "agents/claude/SOUL.md").length, 0);
});

test("1.9 lint blocks: unknown or mismatched kind, missing field, newer schema, over cap, unknown roster agent, goal id mismatch", async (t) => {
  const { root } = await mk(t, { watch: false });
  const bad = (rel: string, text: string) => write(root, rel, text);
  bad("USER.md", emitFile(head("nope", { name: "x", timezone: "UTC" }), ""));
  bad("agents/claude/SOUL.md", emitFile(head("tools", { name: "x" }), ""));
  bad("agents/codex/SOUL.md", emitFile(head("soul", { color: "#123456", role: "r", tone: "t" }), ""));
  bad("agents/hermes/SOUL.md", emitFile({ ...head("soul", { name: "H", color: "#123456", role: "r", tone: "t" }), schema: 2 }, ""));
  bad("AGENTS.md", emitFile(head("agents", { hard_limits: [] }), "x".repeat(8 * 1024 + 1)));
  bad("rooms/general/ROOM.md", emitFile(head("room", { name: "general", roster: ["claude", "ghost"] }), "Hi\n"));
  bad("goals/g1/GOAL.md", emitFile(head("goal", { id: "g2", room: "general", status: "running" }), "Do it\n"));
  bad("agents/claude/TOOLS.md", "no front matter at all\n");
  const { blocks } = lint(root);
  const by = (file: string) => blocks.filter((b) => b.file === file).map((b) => b.message).join(" | ");
  assert.match(by("USER.md"), /unknown kind "nope"/);
  assert.match(by("agents/claude/SOUL.md"), /kind is "tools" but a file in this place must be kind: soul/);
  assert.match(by("agents/codex/SOUL.md"), /missing required field "name"/);
  assert.match(by("agents/hermes/SOUL.md"), /schema 2 is newer/);
  assert.match(by("AGENTS.md"), /over its 8192 byte limit/);
  assert.match(by("rooms/general/ROOM.md"), /roster names "ghost"/);
  assert.match(by("goals/g1/GOAL.md"), /doesn't match its folder goals\/g1\//);
  assert.match(by("agents/claude/TOOLS.md"), /must start with front matter/);
  for (const b of blocks) assert.ok(b.line && b.line >= 1, `${b.file} has a line`);
  assert.equal(blocks.find((b) => b.file === "rooms/general/ROOM.md")!.line, 7, "points at the roster entry");
});

test("1.9 lint flags: loosening, opposing rules, contradictory or expired memory, expired leases, unknown files", async (t) => {
  const { root } = await mk(t, { watch: false });
  const rule = (id: string, effect: string, extra: Record<string, unknown> = {}) => ({ id, effect, tool: "gmail", match: "*", scope: "*", source: "owner", accepted: true, ...extra });
  write(root, "POLICY.md", emitFile(head("policy", {
    defaults: { shell: "ask", gmail: "ask" },
    rules: [rule("a", "allow"), rule("b", "deny"), rule("old", "allow", { tool: "slack", expires: "2020-01-01" })],
  }), ""));
  write(root, "rooms/general/MEMORY.md", emitFile(head("room-memory"), [
    "- Budget is approved — source: owner, expires: 2099-01-01",
    "- Budget is not approved — source: g1, expires: 2099-01-01",
    "- Deadline: May 3 — source: owner, expires: 2099-01-01",
    "- Deadline: May 9 — source: owner, expires: 2099-01-01",
    "- Old news — source: owner, expires: 2020-02-02",
  ].join("\n") + "\n"));
  write(root, "SOUL.MD", "oops\n");
  write(root, "agents/claude/notes.txt", "stray\n");
  const { blocks, flags } = lint(root);
  assert.deepEqual(blocks, []);
  const msgs = flags.map((f) => `${f.file}:${f.line ?? ""} ${f.message}`).join("\n");
  assert.match(msgs, /POLICY\.md:\d+ rules "a" and "b" allow and deny the same gmail actions/);
  assert.match(msgs, /POLICY\.md:\d+ rule "old" expired on 2020-01-01/);
  assert.match(msgs, /rooms\/general\/MEMORY\.md:\d+ contradicts the fact on line \d+: "Budget is not approved"/);
  assert.match(msgs, /rooms\/general\/MEMORY\.md:\d+ contradicts[^\n]*Deadline: May 9/);
  assert.match(msgs, /MEMORY\.md:\d+ fact expired on 2020-02-02/);
  assert.match(msgs, /SOUL\.MD:? unknown file; did you mean SOUL\.md/);
  assert.match(msgs, /agents\/claude\/notes\.txt:? isn't part of the control folder layout/);
});

test("1.9 ROOM.md can't loosen POLICY.md: shell on where policy says ask is flagged and the permission stays ask", async (t) => {
  const { root, store, control } = await mk(t, {
    prep: (c) => { const a = c.store.getAgent("claude")!; a.tools.shell = true; c.store.saveAgent(a); },
  });
  assert.equal(control.effectivePermissions("claude", "general").shell, "ask");
  write(root, "rooms/general/ROOM.md", read(root, "rooms/general/ROOM.md").replace("tools: {}", "tools:\n  shell: on\n  web: off"));
  await until(() => control.status().notices.some((n) => n.level === "flag" && n.file === "rooms/general/ROOM.md"), "the flag");
  const f = control.status().notices.find((n) => n.file === "rooms/general/ROOM.md")!;
  assert.match(f.message, /shell: on, but POLICY\.md says ask/);
  assert.ok(f.line && f.line > 1);
  assert.equal(control.effectivePermissions("claude", "general").shell, "ask", "the looser line is ignored");
  assert.equal(control.effectivePermissions("claude", "general").web, "off", "a room can tighten");
  assert.equal(control.effectivePermissions("claude").web, "on", "outside the room it is still on");
  assert.equal(store.getAgent("claude")!.autoApprove?.shell, undefined);
  assert.ok(lint(root).flags.some((x) => x.file === "rooms/general/ROOM.md"));
});

test("1.9 effective permissions: off beats ask beats on across platform, policy, room_allows and room", async (t) => {
  const { root, control } = await mk(t, { watch: false });
  write(root, "agents/claude/TOOLS.md", read(root, "agents/claude/TOOLS.md")
    .replace("connectors: []", "connectors: [gmail]").replace(/room_allows:[\s\S]*?\n---/, "room_allows:\n  web: on\n  gmail: on\n  slack: on\n  shell: ask\n  drive: on\n---"));
  write(root, "POLICY.md", read(root, "POLICY.md").replace("drive: on", "drive: off"));
  await control.load();
  const p = control.effectivePermissions("claude");
  assert.equal(p.web, "on");
  assert.equal(p.gmail, "ask", "policy default for gmail is ask");
  assert.equal(p.slack, "off", "platform lists connectors and slack isn't one");
  assert.equal(p.shell, "ask");
  assert.equal(p.drive, "off", "policy beats room_allows");
  assert.equal(p.salesforce, "off", "not listed in room_allows means not allowed");
});

// ---------------------------------------------------------------- AC3: context

function populate(root: string) {
  write(root, "AGENTS.md", emitFile(head("agents", { hard_limits: ["no-external-email-without-approval"] }), "RULES-BODY\n"));
  write(root, "USER.md", emitFile(head("user", { name: "Blake", timezone: "America/Chicago" }), "USER-BODY\n"));
  write(root, "rooms/general/ROOM.md", emitFile(head("room", { name: "general", roster: ["claude", "codex"], tools: { web: "off" }, folders: [], in_scope: ["the website"], out_of_scope: ["billing"] }), "ROOM-BODY purpose\n"));
  write(root, "agents/claude/SOUL.md", emitFile(head("soul", { name: "Claude", color: "#6B4FD8", role: "Lead", tone: "Warm" }), "SOUL-BODY voice\n"));
  const tools = read(root, "agents/claude/TOOLS.md").replace(/\n+$/, "\n");
  write(root, "agents/claude/TOOLS.md", tools + "TOOLNOTE-1\n".repeat(30));
  write(root, "playbooks/coding.md", emitFile(head("playbook", { task_type: "coding", applies_to: ["claude"] }), Array.from({ length: 40 }, (_, i) => `PB-LINE-${i} ${"p".repeat(40)}`).join("\n") + "\n"));
  write(root, "playbooks/writing.md", emitFile(head("playbook", { task_type: "writing", applies_to: "*" }), "WRITING-PLAYBOOK\n"));
  write(root, "agents/claude/LESSONS.md", emitFile(head("lessons", { task_types: ["coding", "research"] }),
    ["## coding", ...Array.from({ length: 30 }, (_, i) => `- LESSON-${String(i).padStart(2, "0")} ${"l".repeat(40)} (from g${i})`), "## research", "- RESEARCH-LESSON (from g9)"].join("\n") + "\n"));
  write(root, "rooms/general/MEMORY.md", emitFile(head("room-memory"),
    [...Array.from({ length: 30 }, (_, i) => `- ROOMFACT-${String(i).padStart(2, "0")} ${"m".repeat(40)} — source: owner, expires: 2099-01-01`), "- EXPIREDFACT — source: owner, expires: 2020-01-01"].join("\n") + "\n"));
  write(root, "agents/claude/MEMORY.md", emitFile(head("agent-memory", { updated_by: "claude" }), Array.from({ length: 10 }, (_, i) => `- OWNNOTE-${String(i).padStart(2, "0")} ${"n".repeat(40)}`).join("\n") + "\n"));
  write(root, "goals/g1/GOAL.md", emitFile(head("goal", { id: "g1", room: "general", status: "running", requirements: [{ id: "G1", text: "REQ-ONE" }], in_scope: ["landing page"], out_of_scope: ["pricing"] }), "GOALFILE-BODY\n"));
  write(root, "goals/g1/DECISIONS.md", emitFile(head("decisions", { goal: "g1" }), "- DECIDED-BLUE (owner)\n"));
}
const taskInput = (control: ControlFolder, over: Record<string, unknown> = {}) => ({
  control: control.snapshot(), agentId: "claude", roomSlug: "general", taskType: "coding",
  goal: { id: "g1", text: "GOAL-TEXT build the site", contract: { objective: "o", constraints: ["CONSTRAINT-X"], deliverables: [], outOfScope: ["OOS-GOAL"], version: 1, lockedAt: 1, amendments: [{ at: 1, text: "AMEND-USE-RED" }] } },
  task: { title: "TASK-TITLE", description: "TASK-DESC", acceptance: "ACCEPT-IT", criteria: [{ id: "C1", text: "CRIT-ONE" }], files: ["site/**"], output: "HANDBACK" },
  ...over,
}) as Parameters<typeof buildTaskContext>[0];

test("1.9 buildTaskContext: layers come in CONTROL.md order, the persona is marked, POLICY and RESUME stay out", async (t) => {
  const { root, control } = await mk(t, { watch: false });
  populate(root);
  write(root, "POLICY.md", read(root, "POLICY.md").replace(/\n+$/, "\n") + "POLICY-SECRET\n");
  write(root, "agents/claude/RESUME.md", emitFile(head("resume"), "RESUME-SECRET\n"));
  await control.load();
  const text = buildTaskContext(taskInput(control));
  const at = (s: string) => { const i = text.indexOf(s); assert.ok(i >= 0, `${s} is in the context`); return i; };
  const order = ["RULES-BODY", "no-external-email-without-approval", "USER-BODY", "ROOM-BODY", "SOUL-BODY", "What you can use here", "TOOLNOTE-1", "PB-LINE-0", "LESSON-00", "ROOMFACT-00", "OWNNOTE-00", "GOALFILE-BODY", "DECIDED-BLUE", "AMEND-USE-RED", "TASK-TITLE"].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "broadest layer first");
  assert.ok(text.startsWith(BEGIN) && text.trimEnd().endsWith(END));
  assert.match(text, /<!-- agent-room:persona:begin -->[\s\S]*SOUL-BODY[\s\S]*<!-- agent-room:persona:end -->/);
  assert.doesNotMatch(text, /POLICY-SECRET|RESUME-SECRET|EXPIREDFACT|RESEARCH-LESSON|WRITING-PLAYBOOK/);
  assert.match(text, /- web \(Web browsing\): not available/, "the room narrowed web off");
  assert.match(text, /- shell \(Shell commands\): not available/);
  assert.match(text, /REQ-ONE/); assert.match(text, /CRIT-ONE/); assert.match(text, /site\/\*\*/); assert.match(text, /HANDBACK/);
  assert.match(text, /In scope:\n- the website/); assert.match(text, /Out of scope:\n- billing/);
});

test("1.9 buildTaskContext: stays under the cap, trims in the documented order, never drops hard limits, room scope or the contract", async (t) => {
  const { root, control } = await mk(t, { watch: false });
  populate(root);
  await control.load();
  const full = buildTaskContextDetailed(taskInput(control, { capBytes: 1_000_000 }));
  assert.equal(full.trimmed.memory + full.trimmed.lessons + full.trimmed.playbookLines + full.trimmed.toolNoteLines, 0);
  assert.ok(full.bytes < 24_576, "this fixture fits the default cap");

  // Step down the cap and check what has gone at each point.
  const sizes: ReturnType<typeof buildTaskContextDetailed>[] = [];
  for (let cap = full.bytes - 50; cap > 1500; cap -= 150) {
    const r = buildTaskContextDetailed(taskInput(control, { capBytes: cap }));
    sizes.push(r);
    if (!r.overCap) assert.ok(r.bytes <= cap, `${r.bytes} <= ${cap}`);
    for (const must of ["no-external-email-without-approval", "In scope:\n- the website", "Out of scope:\n- billing", "TASK-TITLE", "TASK-DESC", "ACCEPT-IT", "CRIT-ONE", "AMEND-USE-RED", "DECIDED-BLUE", "REQ-ONE", "HANDBACK", "site/**"]) {
      assert.ok(r.text.includes(must), `cap ${cap} still has ${must}`);
    }
    // Order of loss: memory, then lessons, then playbook tail, then tool notes.
    if (r.trimmed.lessons) assert.ok(!r.text.includes("ROOMFACT-") && !r.text.includes("OWNNOTE-"), "memory is gone before lessons are cut");
    if (r.trimmed.playbookLines) assert.ok(!r.text.includes("LESSON-"), "lessons are gone before the playbook is cut");
    if (r.trimmed.toolNoteLines) assert.ok(!r.text.includes("PB-LINE-"), "the playbook is gone before tool notes are cut");
    if (r.trimmed.otherLines) assert.ok(!r.text.includes("TOOLNOTE-"), "tool notes are gone before anything else");
  }
  assert.ok(sizes.some((r) => r.trimmed.memory > 0 && r.trimmed.lessons === 0), "memory goes first");
  assert.ok(sizes.some((r) => r.trimmed.lessons > 0), "then lessons");
  assert.ok(sizes.some((r) => r.trimmed.playbookLines > 0), "then the playbook tail");
  assert.ok(sizes.some((r) => r.trimmed.toolNoteLines > 0), "then tool notes");
  // Oldest first: the first fact goes before the last.
  const mid = sizes.find((r) => r.trimmed.memory > 0 && r.trimmed.memory < 20)!;
  assert.ok(!mid.text.includes("ROOMFACT-00") && mid.text.includes("ROOMFACT-29"), "oldest memory is cut first");
  assert.match(mid.text, /<!-- agent-room: cut to fit/);
  // An impossible cap keeps the protected parts and says so.
  const tiny = buildTaskContextDetailed(taskInput(control, { capBytes: 10 }));
  assert.equal(tiny.overCap, true);
  for (const must of ["no-external-email-without-approval", "- the website", "TASK-TITLE", "AMEND-USE-RED"]) assert.ok(tiny.text.includes(must));
});

test("1.9 buildTaskContext through the folder: a default call fits 24 KB with a huge memory file", async (t) => {
  const { root, control } = await mk(t, { watch: false });
  populate(root);
  write(root, "rooms/general/MEMORY.md", emitFile(head("room-memory"), Array.from({ length: 120 }, (_, i) => `- BIGFACT-${String(i).padStart(3, "0")} ${"z".repeat(80)} — source: owner, expires: 2099-01-01`).join("\n") + "\n"));
  write(root, "agents/claude/LESSONS.md", emitFile(head("lessons"), "## coding\n" + Array.from({ length: 100 }, (_, i) => `- BIGLESSON-${i} ${"y".repeat(80)}`).join("\n") + "\n"));
  await control.load();
  const out = control.contextFor({ agentId: "claude", roomSlug: "general", taskType: "coding", goal: { id: "g1", text: "x" }, task: { title: "T", description: "D" } });
  assert.ok(Buffer.byteLength(out) <= 24_576, `${Buffer.byteLength(out)} bytes`);
  assert.ok(out.includes("BIGFACT-119") && !out.includes("BIGFACT-000"));
  assert.ok(out.includes("no-external-email-without-approval"));
});

// ---------------------------------------------------------------- AC3: the worktree file

test("1.9 writeTaskContext / restoreTaskContext leave an existing CLAUDE.md byte-identical", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-wt-"));
  const original = Buffer.concat([Buffer.from("# Repo rules\r\n\r\nNo trailing newline, CRLF, and bytes: "), Buffer.from([0xe2, 0x82, 0xac, 0xff, 0x00, 0x7f]), Buffer.from("end")]);
  writeFileSync(join(dir, "CLAUDE.md"), original, { mode: 0o640 });
  const w = writeTaskContext(dir, "claude-code", "CONTEXT-TEXT\nline two");
  const during = readFileSync(join(dir, "CLAUDE.md"));
  assert.ok(during.toString("utf8").startsWith(`${BEGIN}\nCONTEXT-TEXT\nline two\n${END}\n`), "the block is at the top");
  assert.ok(during.subarray(during.length - original.length).equals(original), "the owner's text follows untouched");
  assert.equal(w.file, "CLAUDE.md");
  assert.equal(writeTaskContext(dir, "claude-code", "SECOND").file, "CLAUDE.md");
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8").split(BEGIN).length, 2, "writing twice never stacks blocks");
  assert.equal(restoreTaskContext(dir), true);
  assert.ok(readFileSync(join(dir, "CLAUDE.md")).equals(original), "byte-identical");
  assert.equal(lstatSync(join(dir, "CLAUDE.md")).mode & 0o777, 0o640);
  assert.ok(!existsSync(join(dir, ".agent-room")), "no backup left behind");
  assert.equal(restoreTaskContext(dir), false, "nothing more to restore");
});

test("1.9 writeTaskContext: no file before means no file after; Codex gets AGENTS.md; others get .agent-room/CONTEXT.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-wt-"));
  assert.equal(writeTaskContext(dir, "claude-code", "A").file, "CLAUDE.md");
  assert.ok(readFileSync(join(dir, "CLAUDE.md"), "utf8").includes("A"));
  restoreTaskContext(dir);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(writeTaskContext(dir, "codex", "B").file, "AGENTS.md");
  restoreTaskContext(dir);
  assert.equal(writeTaskContext(dir, "mcp", "C").file, ".agent-room/CONTEXT.md");
  assert.equal(writeTaskContext(dir, "command", "D").file, ".agent-room/CONTEXT.md");
  assert.match(readFileSync(join(dir, ".agent-room/CONTEXT.md"), "utf8"), /D/);
  restoreTaskContext(dir);
  assert.deepEqual(readdirSync(dir), []);
});

test("1.9 a CLAUDE.md that is a symlink comes back as the same symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-wt-"));
  writeFileSync(join(dir, "AGENTS.md"), "shared rules\n");
  symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
  writeTaskContext(dir, "claude-code", "CTX");
  assert.ok(!lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink());
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "shared rules\n", "the target is never touched");
  assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf8"), /shared rules/);
  restoreTaskContext(dir);
  assert.equal(readlinkSync(join(dir, "CLAUDE.md")), "AGENTS.md");
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "shared rules\n");
});

// ---------------------------------------------------------------- AC4: history and revert

test("1.9 revert restores a file and the Store follows", async (t) => {
  const c = await boot(t);
  const { root, store, control } = c;
  const original = read(root, "agents/claude/TOOLS.md");
  await api(c, "PUT", "/agents/claude/tools", { gmail: true });
  await control.idle();
  assert.notEqual(read(root, "agents/claude/TOOLS.md"), original);
  const hist = await api(c, "GET", "/control/history?path=agents/claude/TOOLS.md");
  assert.equal(hist.status, 200);
  assert.equal(hist.body.length, 2);
  assert.equal(hist.body[0].author, "owner");
  assert.match(hist.body[0].message, /gmail/);
  const r = await api(c, "POST", `/control/revert/${hist.body[0].commit}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(read(root, "agents/claude/TOOLS.md"), original, "the file is back exactly");
  await until(() => store.getAgent("claude")!.tools.gmail === false, "the Store to follow the revert");
  assert.match(commits(root)[0], /^owner\|Revert/);
  assert.equal(git(root, "status", "--porcelain").trim(), "");
  assert.equal((await api(c, "POST", "/control/revert/not-a-commit")).status, 409);
  const first = hist.body[1].commit;
  assert.equal((await api(c, "POST", `/control/revert/${first}`)).status, 409, "the first commit can't be undone");
  assert.equal((await api(c, "GET", "/control/history?path=../etc")).status, 400);
  assert.ok(control.status().git);
});

test("1.9 REST: status and lint report the folder, notices and lint result", async (t) => {
  const c = await boot(t);
  const { root, control } = c;
  let s = await api(c, "GET", "/control/status");
  assert.equal(s.body.root, root);
  assert.equal(s.body.git, true);
  assert.ok(s.body.lastLoad);
  assert.deepEqual(s.body.notices, []);
  write(root, "USER.md", "broken\n");
  await until(() => control.status().notices.length > 0, "a notice");
  s = await api(c, "GET", "/control/status");
  assert.equal(s.body.notices[0].file, "USER.md");
  assert.equal(s.body.lint.blocks[0].file, "USER.md");
  const l = await api(c, "POST", "/control/lint");
  assert.equal(l.body.blocks[0].file, "USER.md");
  assert.equal((await fetch(`${c.base}/control/status`)).status, 401, "needs a paired device");
});

test("1.9 the lint CLI prints file and line and exits non-zero on a block", async (t) => {
  const { root } = await mk(t, { watch: false });
  const cli = join(dirname(fileURLToPath(import.meta.url)), "../src/control/cli.ts");
  const run = () => spawnSync(process.execPath, ["--import", "tsx", cli, "lint", root], { encoding: "utf8" });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /0 blocking, 0 flagged/);
  write(root, "agents/claude/SOUL.md", "---\nkind: soul\nschema: 1\nupdated: 2026-10-23\nupdated_by: owner\ncolor: \"#000000\"\nrole: r\ntone: t\n---\n");
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /BLOCK agents\/claude\/SOUL\.md:\d+ {2}missing required field "name"/);
});

test("1.9 edits made while the hub was off are committed as the owner at the next start", async (t) => {
  const c = setup();
  const root = join(c.dir, "Agent Room");
  const first = new ControlFolder(root, c.store, { watch: false });
  await first.init();
  write(root, "USER.md", read(root, "USER.md").replace("name: Owner", "name: Pat").replace("name: Blake", "name: Pat"));
  const second = new ControlFolder(root, c.store, { watch: false });
  t.after(() => second.close());
  await second.init();
  assert.match(commits(root)[0], /^owner\|Edit USER\.md \(made while Agent Room was closed\)/);
  assert.equal(second.snapshot().user!.fm.name, "Pat");
});

test("1.9 works without git: files still sync, there is just no history", async (t) => {
  const c = setup();
  const root = join(c.dir, "Agent Room");
  const control = new ControlFolder(root, c.store, { watch: true, debounceMs: 40, gitBin: "/nonexistent/git" });
  t.after(() => control.close());
  await control.init(); control.start();
  assert.equal(control.status().git, false);
  write(root, "agents/claude/TOOLS.md", read(root, "agents/claude/TOOLS.md").replace("web: on", "web: off"));
  await until(() => c.store.getAgent("claude")!.tools.web === false, "the edit");
  assert.deepEqual(await control.history(), []);
});
