import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, Approval, Goal, OfficeState, ServerEvent, Task } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { OfficeTracker, buildOfficeState, type OfficeInput } from "../src/office/state.js";
import { HW, setup } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "../web");
const read = (f: string) => readFileSync(join(web, f), "utf8");
const T0 = 1_000_000;

const agent = (id: string, o: Partial<AgentConfig> = {}): AgentConfig => ({ id, name: id[0].toUpperCase() + id.slice(1), provider: id, adapter: "mock", enabled: true, color: "#6B4FD8", settings: {}, tools: {}, ...o });
const task = (id: string, status: Task["status"], o: Record<string, unknown> = {}): Task =>
  ({ id, roomId: "r1", goalId: "g1", title: `Task ${id}`, description: "", taskType: "writing", acceptance: "", dependsOn: [], status, attempts: 1, createdAt: T0, updatedAt: T0, ...o }) as Task;
const approval = (id: string, agentId: string, o: Partial<Approval> = {}): Approval => ({ id, agentId, tool: "gmail", action: "send", detail: "", status: "pending", createdAt: T0, roomId: "r1", ...o });
const goal = (o: Partial<Goal> = {}): Goal => ({ id: "g1", roomId: "r1", text: "Do the thing", status: "running", createdAt: T0, ...o });
const input = (o: Partial<OfficeInput> = {}): OfficeInput => ({ agents: [agent("claude"), agent("codex"), agent("hermes")], tasks: [], goals: [], approvals: [], working: {}, now: T0, ...o });
const byId = (s: OfficeState, id: string) => s.agents.find((a) => a.id === id)!;

// ---------- AC1: the four states, from synthetic store state and events

test("AC1: an agent with nothing to do is idle; a disabled agent is offline", () => {
  const s = buildOfficeState(input({ agents: [agent("claude"), agent("atlas", { enabled: false })] }));
  assert.equal(byId(s, "claude").state, "idle");
  assert.equal(byId(s, "atlas").state, "offline");
  assert.equal(byId(s, "claude").taskTitle, undefined);
});

test("AC1: running, assigned and revising tasks mean working, and name the task", () => {
  for (const status of ["running", "assigned", "revising"] as const) {
    const s = buildOfficeState(input({ tasks: [task("t1", status, { assignee: "claude", title: "Draft the deck" })] }));
    assert.equal(byId(s, "claude").state, "working", status);
    assert.equal(byId(s, "claude").taskTitle, "Draft the deck");
    assert.equal(byId(s, "codex").state, "idle");
  }
  const done = buildOfficeState(input({ tasks: [task("t1", "done", { assignee: "claude" }), task("t2", "waiting", { assignee: "codex" }), task("t3", "failed", { assignee: "hermes" })] }));
  assert.deepEqual(done.agents.map((a) => a.state), ["idle", "idle", "idle"]);
});

test("AC1: a working event (a chat reply, planning) makes an agent work, scoped to its room", () => {
  const s = buildOfficeState(input({ working: { r1: { codex: "replying" } } }));
  assert.equal(byId(s, "codex").state, "working");
  assert.equal(byId(s, "codex").taskTitle, "replying");
  assert.equal(buildOfficeState(input({ working: { r1: { codex: "replying" } }, roomId: "r2" })).agents.find((a) => a.id === "codex")!.state, "idle", "another room's work is not shown");
  assert.equal(buildOfficeState(input({ working: { r1: { codex: "replying" } }, roomId: "r1" })).agents.find((a) => a.id === "codex")!.state, "working");
});

test("AC1: a task in review means its worker is being judged", () => {
  const s = buildOfficeState(input({ tasks: [task("t1", "review", { assignee: "hermes", title: "Check the figures" })] }));
  assert.equal(byId(s, "hermes").state, "judged");
  assert.equal(byId(s, "hermes").taskTitle, "Check the figures");
});

test("AC1/AC4: a pending approval means the agent is waiting, and beats judged and working", () => {
  const s = buildOfficeState(input({
    tasks: [task("t1", "running", { assignee: "claude", title: "Write" }), task("t2", "review", { assignee: "claude", title: "Check" }), task("t3", "review", { assignee: "codex" })],
    approvals: [approval("a1", "claude"), approval("a2", "codex")],
  }));
  assert.equal(byId(s, "claude").state, "waiting_approval");
  assert.equal(byId(s, "claude").taskTitle, "Write", "says what it was doing");
  assert.equal(byId(s, "codex").state, "waiting_approval");
  // decided approvals do not count
  const settled = buildOfficeState(input({ approvals: [approval("a1", "claude", { status: "approved" }), approval("a2", "codex", { status: "rejected" }), approval("a3", "hermes", { status: "expired" })] }));
  assert.ok(settled.agents.every((a) => a.state === "idle"));
  assert.equal(settled.pendingApprovals, 0);
});

test("AC1: judged beats working", () => {
  const s = buildOfficeState(input({ tasks: [task("t1", "review", { assignee: "claude" }), task("t2", "running", { assignee: "claude" })] }));
  assert.equal(byId(s, "claude").state, "judged");
});

test("the persona's avatar is used, else the first letter of the name", () => {
  const s = buildOfficeState(input({ agents: [agent("muse", { avatar: "🎨" }), agent("claude")] }));
  assert.equal(byId(s, "muse").avatar, "🎨");
  assert.equal(byId(s, "claude").avatar, "C");
  assert.equal(byId(s, "claude").color, "#6B4FD8");
});

// ---------- AC2: subagents as helpers at the parent's desk

test("AC2: a subagent task shows as a helper at its parent task's agent, not as that agent working at its own desk", () => {
  const s = buildOfficeState(input({
    tasks: [
      task("p", "running", { assignee: "claude" }),
      task("s1", "running", { assignee: "hermes", parentTaskId: "p", kind: "subagent", depth: 1, spawnedBy: "claude", readOnly: true, title: "Scan the old deck" }),
      task("s2", "review", { assignee: "codex", parentTaskId: "p", kind: "subagent", depth: 1, spawnedBy: "claude" }),
      task("s3", "pending", { assignee: "codex", parentTaskId: "p", kind: "subagent", depth: 1 }),
    ],
  }));
  const helpers = byId(s, "claude").helpers;
  assert.deepEqual(helpers.map((h) => [h.id, h.agentId, h.readOnly, h.state]), [["s1", "hermes", true, "working"], ["s2", "codex", false, "judged"], ["s3", "codex", false, "idle"]]);
  assert.equal(helpers[0].title, "Scan the old deck");
  assert.equal(byId(s, "hermes").state, "idle", "hermes works at claude's desk, so its own desk stays idle");
  assert.equal(byId(s, "codex").state, "idle");
  assert.equal(byId(s, "claude").state, "working");
  assert.deepEqual(byId(s, "hermes").helpers, []);
});

test("AC2: finished subagents leave; with no parent task the spawner's desk is used; without either, nothing shows", () => {
  const s = buildOfficeState(input({
    tasks: [
      task("p", "running", { assignee: "claude" }),
      task("s1", "done", { assignee: "hermes", parentTaskId: "p", kind: "subagent" }),
      task("s2", "failed", { assignee: "hermes", parentTaskId: "p", kind: "subagent" }),
      task("s3", "cancelled", { assignee: "hermes", parentTaskId: "p", kind: "subagent" }),
      task("s4", "running", { assignee: "hermes", parentTaskId: "gone", kind: "subagent", spawnedBy: "codex" }),
      task("s5", "running", { assignee: "hermes", kind: "subagent" }),
    ],
  }));
  assert.deepEqual(byId(s, "claude").helpers, []);
  assert.deepEqual(byId(s, "codex").helpers.map((h) => h.id), ["s4"]);
  assert.equal(s.agents.reduce((n, a) => n + a.helpers.length, 0), 1);
});

test("AC2: a base without 3.3 (no subagent fields on any task) simply has no helpers", () => {
  const s = buildOfficeState(input({ tasks: [task("p", "running", { assignee: "claude" })] }));
  assert.ok(s.agents.every((a) => a.helpers.length === 0));
});

// ---------- AC3: the whiteboard

test("AC3: the whiteboard lists the goal's requirements with their status, and progress is the share met", () => {
  const contract = { objective: "Ship the board update", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: T0, amendments: [],
    requirements: [{ id: "G1", text: "Revenue slide", status: "met" as const }, { id: "G2", text: "Headcount", status: "open" as const }, { id: "G3", text: "Narrative", status: "unmet" as const }, { id: "G4", text: "Sources" }] };
  const s = buildOfficeState(input({ goals: [goal({ contract })] }));
  assert.equal(s.goal!.objective, "Ship the board update");
  assert.deepEqual(s.goal!.requirements.map((r) => [r.id, r.text, r.status]), [["G1", "Revenue slide", "met"], ["G2", "Headcount", "open"], ["G3", "Narrative", "unmet"], ["G4", "Sources", "open"]]);
  assert.equal(s.goal!.progress, 0.25);
  assert.equal(s.goal!.status, "running");
});

test("AC3: no requirements falls back to deliverables, then to task progress; a finished goal is full", () => {
  const base = { objective: "O", constraints: [], deliverables: ["A deck", "A memo"], outOfScope: [], version: 1, lockedAt: T0, amendments: [] };
  const s1 = buildOfficeState(input({ goals: [goal({ contract: base })] }));
  assert.deepEqual(s1.goal!.requirements.map((r) => [r.id, r.text, r.status]), [["D1", "A deck", "open"], ["D2", "A memo", "open"]]);
  const s2 = buildOfficeState(input({ goals: [goal({ text: "Plain goal" })], tasks: [task("a", "done"), task("b", "running"), task("c", "done"), task("d", "cancelled")] }));
  assert.equal(s2.goal!.objective, "Plain goal");
  assert.deepEqual(s2.goal!.requirements, []);
  assert.equal(s2.goal!.progress, 0.67);
  const s3 = buildOfficeState(input({ goals: [goal({ status: "done", contract: base })] }));
  assert.equal(s3.goal!.progress, 1);
  assert.ok(s3.goal!.requirements.every((r) => r.status === "met"));
});

test("AC3: the running goal is the one on the board; superseded goals never are; no goal means no board", () => {
  const old = goal({ id: "old", status: "done", createdAt: T0 + 5 }), live = goal({ id: "live", status: "running", createdAt: T0 }), gone = goal({ id: "gone", status: "superseded", createdAt: T0 + 9 });
  assert.equal(buildOfficeState(input({ goals: [old, live, gone] })).goal!.id, "live");
  assert.equal(buildOfficeState(input({ goals: [old, gone] })).goal!.id, "old", "with nothing active, the latest finished goal");
  assert.equal(buildOfficeState(input({ goals: [gone] })).goal, undefined);
  assert.equal(buildOfficeState(input()).goal, undefined);
  const awaiting = goal({ id: "aw", status: "awaiting_approval", createdAt: T0 + 1 });
  assert.equal(buildOfficeState(input({ goals: [awaiting, live] })).goal!.id, "live", "running outranks a plan that is waiting");
});

// ---------- AC4: the door light

test("AC4: pending approvals are counted (for the room, plus any that name no room)", () => {
  const approvals = [approval("a1", "claude"), approval("a2", "codex", { roomId: "r2" }), approval("a3", "hermes", { roomId: undefined }), approval("a4", "claude", { status: "approved" })];
  assert.equal(buildOfficeState(input({ approvals })).pendingApprovals, 3);
  assert.equal(buildOfficeState(input({ approvals, roomId: "r1" })).pendingApprovals, 2);
  assert.equal(buildOfficeState(input({ approvals, roomId: "r2" })).pendingApprovals, 2);
  assert.equal(buildOfficeState(input()).pendingApprovals, 0);
});

// ---------- the live tracker

test("the tracker follows working events and forgets stale ones", () => {
  const ctx = setup();
  let clock = T0;
  const tracker = new OfficeTracker(ctx.store, () => clock);
  const emit = (e: ServerEvent) => ctx.store.emit("event", e);
  const roomId = ctx.room.id;
  assert.equal(byId(tracker.state(roomId), "claude").state, "idle");
  emit({ type: "working", roomId, agentId: "claude", label: "planning", active: true });
  assert.equal(byId(tracker.state(roomId), "claude").state, "working");
  assert.equal(byId(tracker.state(roomId), "claude").taskTitle, "planning");
  assert.equal(byId(tracker.state(), "claude").state, "working", "no room means every room");
  emit({ type: "working", roomId, agentId: "claude", active: false });
  assert.equal(byId(tracker.state(roomId), "claude").state, "idle");
  // an event that never closed (a crashed run) stops counting after half an hour
  emit({ type: "working", roomId, agentId: "codex", active: true });
  assert.equal(byId(tracker.state(roomId), "codex").state, "working");
  clock += 31 * 60_000;
  assert.equal(byId(tracker.state(roomId), "codex").state, "idle");
  tracker.dispose();
  emit({ type: "working", roomId, agentId: "hermes", active: true });
  assert.equal(byId(tracker.state(roomId), "hermes").state, "idle", "a disposed tracker hears nothing");
});

// ---------- GET /office

async function boot(hardware = HW.large) {
  const ctx = setup({ hardware });
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const paired = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await paired.json()) as { token: string };
  return { ...ctx, app, base, h: { authorization: `Bearer ${token}` } };
}

test("GET /office: needs a paired device and answers the whole office, live from the store", async () => {
  const b = await boot();
  assert.equal((await fetch(`${b.base}/office`)).status, 401);
  const first = (await (await fetch(`${b.base}/office?roomId=${b.room.id}`, { headers: b.h })).json()) as OfficeState;
  assert.deepEqual(first.agents.map((a) => [a.id, a.state]), [["claude", "idle"], ["codex", "idle"], ["hermes", "idle"]]);
  assert.equal(first.roomId, b.room.id);
  assert.equal(first.pendingApprovals, 0);
  assert.equal(first.goal, undefined);

  const now = Date.now();
  b.store.saveGoal(goal({ id: "g9", roomId: b.room.id, createdAt: now, contract: { objective: "Plan the offsite", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: now, amendments: [], requirements: [{ id: "G1", text: "A venue", status: "met" }, { id: "G2", text: "A budget", status: "open" }] } }));
  b.store.saveTask(task("t1", "running", { roomId: b.room.id, goalId: "g9", assignee: "claude", title: "Find venues" }));
  b.store.saveTask(task("t2", "review", { roomId: b.room.id, goalId: "g9", assignee: "hermes", title: "Check the budget" }));
  b.store.saveTask(task("s1", "running", { roomId: b.room.id, goalId: "g9", assignee: "codex", parentTaskId: "t1", kind: "subagent", spawnedBy: "claude", readOnly: true, title: "Read the old quotes" }));
  b.store.saveApproval(approval("apr1", "codex", { roomId: b.room.id }));
  b.store.emit("event", { type: "working", roomId: b.room.id, agentId: "codex", label: "replying", active: true });
  const s = (await (await fetch(`${b.base}/office?roomId=${b.room.id}`, { headers: b.h })).json()) as OfficeState;
  assert.deepEqual(s.agents.map((a) => [a.id, a.state]), [["claude", "working"], ["codex", "waiting_approval"], ["hermes", "judged"]]);
  assert.deepEqual(byId(s, "claude").helpers, [{ id: "s1", agentId: "codex", readOnly: true, state: "working", title: "Read the old quotes" }]);
  assert.equal(s.pendingApprovals, 1);
  assert.equal(s.goal!.objective, "Plan the offsite");
  assert.equal(s.goal!.progress, 0.5);
  assert.deepEqual(s.goal!.requirements.map((r) => r.status), ["met", "open"]);

  // without a room: every room
  const all = (await (await fetch(`${b.base}/office`, { headers: b.h })).json()) as OfficeState;
  assert.equal(all.roomId, undefined);
  assert.equal(byId(all, "claude").state, "working");

  assert.equal((await fetch(`${b.base}/office?roomId=room_nope`, { headers: b.h })).status, 404);
  assert.equal((await fetch(`${b.base}/office?roomId=${"x".repeat(200)}`, { headers: b.h })).status, 400);
  await b.app.close();
});

test("GET /office: a proxied (Funnel) request is refused like every route but /mcp", async () => {
  const b = await boot();
  const r = await fetch(`${b.base}/office`, { headers: { ...b.h, "x-forwarded-for": "203.0.113.7", "x-forwarded-host": "mac.tail1234.ts.net", "x-forwarded-proto": "https" } });
  assert.equal(r.status, 404);
  await b.app.close();
});

// ---------- AC7: what the page reads to choose 3D or 2D

test("AC7: /capacity reports tier small for an 8 GB machine, which is what makes the page draw the 2D plan", async () => {
  const small = await boot(HW.small);
  const cap = (await (await fetch(`${small.base}/capacity`, { headers: small.h })).json()) as { plan: { tier: string } };
  assert.equal(cap.plan.tier, "small");
  await small.app.close();
  const large = await boot(HW.large);
  assert.equal(((await (await fetch(`${large.base}/capacity`, { headers: large.h })).json()) as { plan: { tier: string } }).plan.tier, "large");
  await large.app.close();
  const js = read("office.js");
  assert.match(js, /tier === "small"/);
  assert.match(js, /capacity\?\.plan\?\.tier/);
});

// ---------- the page, its scripts and the pinned three.js

test("the office page, script, style and three.js are served by the hub's fixed web list, with the strict CSP", async () => {
  const b = await boot();
  for (const [file, type] of [["office.html", /text\/html/], ["office.js", /text\/javascript/], ["office.css", /text\/css/], ["vendor/three.module.min.js", /text\/javascript/]] as const) {
    const res = await fetch(`${b.base}/web/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type") ?? "", type, file);
    assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'; style-src 'self'/, file);
    assert.doesNotMatch(res.headers.get("content-security-policy") ?? "", /unsafe-inline|unsafe-eval/);
  }
  const html = await (await fetch(`${b.base}/web/office.html`)).text();
  assert.match(html, /<script type="module" src="\/web\/office\.js">/);
  assert.match(html, /href="\/web\/office\.css"/);
  for (const bad of ["vendor/MANIFEST.json", "vendor/three.LICENSE", "vendor/..%2fapp.js", "vendor/nope.js"]) {
    const res = await fetch(`${b.base}/web/${bad}`);
    assert.equal(res.status, 404, bad);
  }
  await b.app.close();
});

test("three.js is vendored at the pinned version: the file's SHA-256 matches the manifest", () => {
  const manifest = JSON.parse(read("vendor/MANIFEST.json")) as { three: { version: string; file: string; sha256: string; npmIntegrity: string } };
  assert.match(manifest.three.version, /^\d+\.\d+\.\d+$/, "an exact version, not a range");
  const bytes = readFileSync(join(web, "vendor", manifest.three.file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.three.sha256, "vendor/three.module.min.js changed without the manifest");
  assert.match(bytes.subarray(0, 400).toString("utf8"), /Three\.js Authors/);
  // the build's own revision number (r170) agrees with the pinned version (0.170.0)
  assert.match(bytes.subarray(0, 600).toString("utf8"), new RegExp(`const \\w="${manifest.three.version.split(".")[1]}"`));
  assert.match(manifest.three.npmIntegrity, /^sha512-/);
  assert.match(readFileSync(join(web, "vendor/three.LICENSE"), "utf8"), /MIT/);
  // nothing else imports a different copy
  assert.match(read("office.js"), new RegExp(`THREE_URL = "/web/vendor/${manifest.three.file.replace(/\./g, "\\.")}"`));
});

test("the page obeys the CSP: no inline script or style, no event-handler attributes, no eval", () => {
  const html = read("office.html");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "no inline script");
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  const js = read("office.js");
  assert.doesNotMatch(js, /\beval\(|new Function\(|setAttribute\(\s*["']style["']|\sstyle="|\.cssText/);
  assert.doesNotMatch(js, /https?:\/\/(?!127\.0\.0\.1|www\.w3\.org)/, "talks only to the hub it was served from");
  assert.doesNotMatch(read("office.css"), /@import|url\(\s*["']?https?:/);
});

test("AC6: the render loop is gated on page visibility and on the view being on screen, and low power stops idle frames", () => {
  const js = read("office.js");
  assert.match(js, /document\.visibilityState === "visible"/);
  assert.match(js, /addEventListener\("visibilitychange"/);
  assert.match(js, /new IntersectionObserver/);
  assert.match(js, /IDLE_MS = 100/);
  assert.match(js, /else if \(!lowPower && S\.animating\(\)\)/);
  assert.match(js, /function stopLoop\(\)/);
});

test("dark mode follows prefers-color-scheme and data-theme", () => {
  const css = read("office.css");
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(read("office.js"), /attributeFilter: \["data-theme"\]/);
});

// ---------- the apps

test("AC5: the phone web app has an Office button on a room and opens a thread from #room=", () => {
  assert.match(read("index.html"), /id="officeBtn"/);
  const js = read("app.js");
  assert.match(js, /\$\("#officeBtn"\)\.hidden = st\.view !== "room"/);
  assert.match(js, /\/web\/office\.html\?\$\{room\.dmAgentId \? "from" : "roomId"\}=/);
  assert.match(js, /\^#room=/);
  // the page opens a thread by creating (or finding) the DM room and sending the phone back with #room=
  const office = read("office.js");
  assert.match(office, /\/rooms\/dm\/\$\{encodeURIComponent\(agentId\)\}/);
  assert.match(office, /location\.assign\(`\/#room=/);
  assert.match(office, /postMessage\(JSON\.stringify\(msg\)\)/);
  assert.match(office, /window\.parent\.postMessage\(msg, "\*"\)/);
});

test("the Mac app has an Office screen in a web view that opens the agent's DM", () => {
  const app = join(here, "../../app");
  const screen = readFileSync(join(app, "src/screens/OfficeScreen.tsx"), "utf8");
  assert.match(screen, /from "react-native-webview"/);
  assert.match(screen, /m\.type === "openAgent"[\s\S]*openDm\(m\.agentId\)/);
  assert.match(screen, /\/web\/office\.html\?\$\{q\}/);
  assert.match(screen, /injectedJavaScriptBeforeContentLoaded/);
  assert.match(readFileSync(join(app, "src/App.tsx"), "utf8"), /office: <OfficeScreen \/>/);
  assert.match(readFileSync(join(app, "src/state/store.ts"), "utf8"), /export type Page = [^;]*"office"/);
  assert.match(readFileSync(join(app, "src/components/Sidebar.tsx"), "utf8"), /label="Office"/);
  const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.match(pkg.dependencies["react-native-webview"], /^\d+\.\d+\.\d+$/);
});
