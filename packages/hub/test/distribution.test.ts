// 4.7 1.0 distribution, the parts that run here: crash reports and their scrubbing, the off-by-default rule for anything that leaves the Mac,
// the telemetry allow-list, the appcast reader and update banner feed, and the HTTP routes. Nothing here uses the network or a real CLI:
// uploads and the appcast fetch go through injected fakes. (Signing, notarization and Sparkle itself need a Mac: see distribution-assets.test.ts
// for what is checked statically.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrashList, PrivacyState, TelemetryPayload, VersionInfo } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { offerFrom, parseAppcast } from "../src/distribution/appcast.js";
import { buildCrashReport, clearCrashReports, crashDir, installCrashHandlers, listCrashReports, writeCrashReport } from "../src/distribution/crash.js";
import { listMacReports } from "../src/distribution/diagnostics.js";
import { KV_CRASH, KV_TELEMETRY, KV_TELEMETRY_SENT, KV_TELEMETRY_SINCE, WEEK_MS, privacyState, reportEndpoint, sendPendingCrashes, setPrivacy, upload, type FetchLike } from "../src/distribution/reporting.js";
import { safeMessage, scrubPaths, scrubText } from "../src/distribution/scrub.js";
import { UpdateChecker, feedUrl, telemetryTick, type TextFetch } from "../src/distribution/schedule.js";
import { TELEMETRY_FIELDS, TELEMETRY_KEYS, buildTelemetry, sanitizeTelemetry } from "../src/distribution/telemetry.js";
import { appVersion, compareVersions, macosVersionFromDarwin, plistVersion } from "../src/distribution/version.js";
import { setup } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const APPCAST = readFileSync(join(here, "fixtures", "appcast.xml"), "utf8");
const ENDPOINT = "https://reports.example.com/ingest";
const HOMES = ["/Users/blake"];

function spyFetch(ok = true, status = 200) {
  const calls: { url: string; body: string }[] = [];
  const fn: FetchLike = async (url, init) => { calls.push({ url, body: init.body }); return { ok, status }; };
  return { fn, calls };
}

// ---------- scrubbing

test("4.7 scrub: the home folder becomes ~, other users' homes too, and credentials, emails and tailnet names are removed", () => {
  const t = scrubText("at run (/Users/blake/Agent Room/x.js:1:2) and /Users/someone/else/y.js, /home/ci/z.js", HOMES);
  assert.ok(!t.includes("blake") && !t.includes("someone") && !t.includes("/home/ci"), t);
  assert.match(t, /~\/Agent Room\/x\.js/);
  const s = scrubText("auth Bearer abcdefghijklmnop1234 and sk-ant-api03-AAAAAAAAAAAAAAAAAAAA and ghp_aaaaaaaaaaaaaaaaaaaaaaaa mail me@corp.com host mac.tail1234.ts.net https://x.test/cb?token=SECRET123&code=abc&ok=1", HOMES);
  for (const bad of ["abcdefghijklmnop1234", "sk-ant", "ghp_aaaa", "me@corp.com", "tail1234", "SECRET123", "code=abc"]) assert.ok(!s.includes(bad), `${bad} survived: ${s}`);
  assert.match(s, /ok=1/, "harmless parameters stay");
  assert.ok(!scrubText("pair secret 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", HOMES).includes("0123456789abcdef0123456789abcdef"));
  assert.equal(scrubPaths("/Users/blake", HOMES), "~");
});

test("4.7 scrub: plain Error messages are withheld; engine and system errors keep their text with every quoted piece removed", () => {
  assert.equal(safeMessage("Error", undefined, "Can't start goal: write my diary", HOMES), "(message withheld)");
  assert.equal(safeMessage("ZodError", undefined, '[{"received":"my prompt"}]', HOMES), "(message withheld)");
  const m = safeMessage("SyntaxError", undefined, `Unexpected token 'h', "hello my private prompt"... is not valid JSON`, HOMES);
  assert.ok(!m.includes("private") && !m.includes("hello"), m);
  assert.match(m, /Unexpected token/);
  const e = safeMessage("Error", "ENOENT", "ENOENT: no such file or directory, open '/Users/blake/Clients/Acme/plan.md'", HOMES);
  assert.ok(!e.includes("Acme") && !e.includes("blake"), e);
  assert.ok(e.length <= 160);
});

// ---------- crash reports

test("4.7 crash report: stack frames and platform facts only; the message, prompt text, tokens and paths are not in it", () => {
  const err = new Error("goal 'Email bob@corp.com the layoff list' failed with Bearer abcdefghijklmnop1234");
  err.stack = [
    "Error: goal 'Email bob@corp.com the layoff list' failed with Bearer abcdefghijklmnop1234",
    "    at plan (/Applications/AgentRoom.app/Contents/Resources/Hub/hub.mjs:10:5)",
    "    at run (/Users/blake/agent-room/packages/hub/src/plan.ts:3:4)",
    "    at async Promise.all (index 0)",
  ].join("\n");
  const r = buildCrashReport(err, "uncaughtException", { version: "1.0.0", now: Date.UTC(2026, 9, 23), homes: HOMES, macos: "15.1" });
  const text = JSON.stringify(r);
  for (const bad of ["layoff", "bob@corp.com", "abcdefghijklmnop1234", "blake"]) assert.ok(!text.includes(bad), `${bad} is in the report`);
  assert.equal(r.message, "(message withheld)");
  assert.equal(r.stack.length, 3, "only the 'at' lines");
  assert.ok(r.stack[1].startsWith("at run (~/"), r.stack[1]);
  assert.deepEqual(Object.keys(r).sort(), ["appVersion", "arch", "at", "kind", "macosVersion", "message", "name", "node", "platform", "schema", "stack", "type", "uptimeSeconds"].sort());
  assert.equal(r.macosVersion, "15.1");
  // something that is not an Error (a string a promise was rejected with) carries no text at all
  const s = buildCrashReport("the user's prompt: do X", "unhandledRejection", { version: "1.0.0", homes: HOMES });
  assert.equal(s.name, "NonError");
  assert.ok(!JSON.stringify(s).includes("prompt"));
  assert.deepEqual(s.stack, []);
});

test("4.7 crash handlers: an uncaught exception and an unhandled rejection each write one file and exit; a second crash while handling is ignored", () => {
  const { dir } = setup();
  const proc = new EventEmitter();
  const exits: number[] = []; const logs: string[] = [];
  const off = installCrashHandlers({ dataDir: dir, version: "1.0.0", proc: proc as never, exit: (c) => exits.push(c), log: (m) => logs.push(m) });
  proc.emit("uncaughtException", new TypeError("x is not a function"));
  proc.emit("unhandledRejection", new Error("later"), Promise.resolve()); // already handling: ignored
  assert.deepEqual(exits, [1]);
  const files = readdirSync(crashDir(dir));
  assert.equal(files.length, 1);
  const r = JSON.parse(readFileSync(join(crashDir(dir), files[0]), "utf8"));
  assert.equal(r.kind, "uncaughtException");
  assert.equal(r.name, "TypeError");
  assert.match(r.message, /is not a function/);
  assert.equal(r.appVersion, "1.0.0");
  assert.match(logs[0], /crashed/);
  off();
  assert.equal(proc.listenerCount("uncaughtException"), 0);
  // a fresh install handles a rejection
  const proc2 = new EventEmitter(); const exits2: number[] = [];
  installCrashHandlers({ dataDir: dir, version: "1.0.0", proc: proc2 as never, exit: (c) => exits2.push(c), log: () => {} });
  proc2.emit("unhandledRejection", "just a string");
  assert.deepEqual(exits2, [1]);
  assert.equal(listCrashReports(dir).length, 2);
});

test("4.7 crash files: private to the owner, only the newest 50 are kept, they list newest first, and can be deleted", () => {
  const { dir } = setup();
  const base = Date.UTC(2026, 9, 1);
  for (let i = 0; i < 55; i++) writeCrashReport(dir, buildCrashReport(new RangeError("r"), "uncaughtException", { version: "1.0.0", now: base + i * 1000, homes: HOMES }), base + i * 1000);
  const files = readdirSync(crashDir(dir)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 50);
  assert.ok(!files.includes(new Date(base).toISOString().replace(/[:.]/g, "-") + ".json"), "the oldest went first");
  if (process.platform !== "win32") {
    assert.equal(statSync(join(crashDir(dir), files[0])).mode & 0o077, 0, "files are 0600");
    assert.equal(statSync(crashDir(dir)).mode & 0o077, 0, "the folder is 0700");
  }
  const list = listCrashReports(dir);
  assert.ok(list[0].at > list[1].at);
  assert.equal(clearCrashReports(dir), 50);
  assert.equal(listCrashReports(dir).length, 0);
});

// ---------- the off-by-default rule

test("4.7 reporting: both switches are off by default, and the report endpoint is unset by default", () => {
  const { store } = setup();
  const p = privacyState(store, {});
  assert.equal(p.crashReports, false);
  assert.equal(p.telemetry, false);
  assert.equal(p.endpointConfigured, false);
  assert.equal(p.endpointHost, undefined);
  assert.equal(p.telemetryNextAt, undefined);
  assert.equal(reportEndpoint({}), undefined);
  assert.equal(reportEndpoint({ AGENT_ROOM_REPORT_URL: "http://evil.example.com/x" }), undefined, "plain http to another host is refused");
  assert.equal(reportEndpoint({ AGENT_ROOM_REPORT_URL: "https://u:p@x.example.com/" }), undefined, "no credentials in the address");
  assert.equal(reportEndpoint({ AGENT_ROOM_REPORT_URL: "not a url" }), undefined);
  assert.equal(reportEndpoint({ AGENT_ROOM_REPORT_URL: "http://127.0.0.1:9/x" })?.host, "127.0.0.1:9", "a local collector over http is fine");
  const plist = (url: string) => `<dict><key>AgentRoomReportURL</key>\n<string>${url}</string></dict>`;
  assert.equal(reportEndpoint({}, plist("")), undefined, "the shipped Info.plist has an empty address: nothing to send to");
  assert.equal(reportEndpoint({}, plist("https://reports.example.com/in"))?.host, "reports.example.com", "a release build bakes the address into Info.plist");
  assert.equal(reportEndpoint({ AGENT_ROOM_REPORT_URL: "https://env.example.com/" }, plist("https://reports.example.com/in"))?.host, "env.example.com", "the environment wins");
  assert.equal(reportEndpoint({}, plist("http://evil.example.com/")), undefined, "Info.plist gets the same https rule");
  assert.equal(p.telemetryFields.length, TELEMETRY_FIELDS.length);
  assert.equal(p.updateChecks, true, "update checks default on: they fetch only the appcast file");
});

test("4.7 reporting: nothing is uploaded unless the switch is on AND an endpoint is configured (each alone sends nothing)", async () => {
  const { store } = setup();
  const spy = spyFetch();
  const env = { AGENT_ROOM_REPORT_URL: ENDPOINT };
  // endpoint set, switch off
  assert.deepEqual(await upload(store, "crash", { a: 1 }, { fetch: spy.fn, env }), { sent: false, why: "The switch is off." });
  assert.deepEqual(await upload(store, "telemetry", { a: 1 }, { fetch: spy.fn, env }), { sent: false, why: "The switch is off." });
  // switch on, no endpoint
  setPrivacy(store, { crashReports: true, telemetry: true });
  assert.equal((await upload(store, "crash", { a: 1 }, { fetch: spy.fn, env: {} })).why, "No report endpoint is configured.");
  assert.equal((await upload(store, "telemetry", { a: 1 }, { fetch: spy.fn, env: { AGENT_ROOM_REPORT_URL: "garbage" } })).sent, false);
  assert.equal(spy.calls.length, 0, "no request was made in any of those cases");
  // the two switches are separate
  setPrivacy(store, { telemetry: false });
  assert.equal((await upload(store, "telemetry", { a: 1 }, { fetch: spy.fn, env })).sent, false);
  assert.equal(spy.calls.length, 0);
  // both: it goes, to that address only
  const r = await upload(store, "crash", { type: "crash" }, { fetch: spy.fn, env });
  assert.equal(r.sent, true);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].url, ENDPOINT);
  assert.deepEqual(JSON.parse(spy.calls[0].body), { type: "crash" });
  // a failing endpoint is reported in plain words and never throws
  const bad = await upload(store, "crash", {}, { fetch: spyFetch(false, 503).fn, env });
  assert.equal(bad.sent, false);
  assert.match(bad.why!, /503/);
  const boom = await upload(store, "crash", {}, { fetch: async () => { throw Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" }); }, env });
  assert.equal(boom.sent, false);
  // every change of a switch is in the audit log
  assert.ok(store.listAudit(50).some((e) => e.action === "reports.crash.on"));
  assert.ok(store.listAudit(50).some((e) => e.action === "reports.telemetry.off"));
});

test("4.7 reporting: waiting crash reports go out only with switch and endpoint, move to sent/ on success, and stay when the endpoint fails", async () => {
  const { dir, store } = setup();
  for (let i = 0; i < 2; i++) writeCrashReport(dir, buildCrashReport(new RangeError("r"), "uncaughtException", { version: "1.0.0", now: 1_000 + i, homes: HOMES }), 1_000 + i);
  const env = { AGENT_ROOM_REPORT_URL: ENDPOINT };
  const spy = spyFetch();
  assert.equal(await sendPendingCrashes(store, dir, { fetch: spy.fn, env }), 0, "switch off");
  setPrivacy(store, { crashReports: true });
  assert.equal(await sendPendingCrashes(store, dir, { fetch: spy.fn, env: {} }), 0, "no endpoint");
  assert.equal(spy.calls.length, 0);
  assert.equal(await sendPendingCrashes(store, dir, { fetch: spyFetch(false, 500).fn, env }), 0, "endpoint down");
  assert.equal(readdirSync(crashDir(dir)).filter((f) => f.endsWith(".json")).length, 2, "still waiting");
  assert.equal(await sendPendingCrashes(store, dir, { fetch: spy.fn, env }), 2);
  assert.equal(spy.calls.length, 2);
  assert.equal(readdirSync(crashDir(dir)).filter((f) => f.endsWith(".json")).length, 0);
  assert.equal(readdirSync(join(crashDir(dir), "sent")).length, 2);
  assert.equal(await sendPendingCrashes(store, dir, { fetch: spy.fn, env }), 0, "never sent twice");
  assert.ok(listCrashReports(dir).every((c) => c.sent));
});

// ---------- telemetry

test("4.7 telemetry: the payload has only the allow-listed keys, counts only, and none of the owner's text reaches it", () => {
  const { store, room, dir } = setup();
  const now = Date.now();
  // content that must never appear: names, goal and task text, paths, an email, a token
  const secret = "hunter2 bob@corp.com /Users/blake/Clients sk-ant-api03-AAAAAAAAAAAAAAAAAAAA";
  const agent = store.listAgents()[0];
  store.saveAgent({ ...agent, name: `Name ${secret}` });
  store.createRoom(`Room ${secret}`);
  for (const [i, ageDays] of [0.2, 0.5, 1.5, 3, 6.5, 20].entries()) store.saveGoal({ id: `g${i}`, roomId: room.id, text: `Goal ${secret}`, status: "done", createdAt: now - ageDays * 86400_000 });
  for (const [i, status] of (["done", "done", "done", "failed", "running"] as const).entries()) {
    store.saveTask({ id: `t${i}`, roomId: room.id, goalId: "g0", title: `Task ${secret}`, description: secret, taskType: "writing", acceptance: secret, dependsOn: [], status } as never);
  }
  const p = buildTelemetry(store, { version: "1.0.0", macos: "15.1", crashCount: 2, now });
  const keys = Object.keys(p).sort();
  assert.deepEqual(keys, [...TELEMETRY_KEYS].sort());
  const text = JSON.stringify(p);
  for (const bad of ["hunter2", "bob@corp", "Clients", "sk-ant", "Name ", "Room ", "Goal ", "Task ", room.id, agent.id, "/Users"]) assert.ok(!text.includes(bad), `${bad} leaked: ${text}`);
  assert.equal(p.type, "telemetry");
  assert.equal(p.appVersion, "1.0.0");
  assert.equal(p.macosVersion, "15.1");
  assert.equal(p.crashCount, 2);
  assert.equal(p.goalsPerDay.length, 7);
  for (const v of Object.values(p.agentsByKind)) assert.equal(typeof v, "number");
  for (const k of Object.keys(p.agentsByKind)) assert.match(k, /^(claude-code|codex|mcp|command|openai-api|mock|acp)$/, "kinds, never names or ids");
  assert.equal(p.taskAcceptanceRate, 0.75, "3 accepted of 4 finished (the running task doesn't count)");
  void dir;
  // goals are counted by day, oldest first: two in the last 24 hours, one 6 days ago, none from 20 days ago
  assert.equal(p.goalsPerDay.reduce((a, b) => a + b, 0), 5);
  assert.equal(p.goalsPerDay[6], 2, "two goals in the last 24 hours");
  assert.equal(p.goalsPerDay[0], 1, "one about six days ago");
});

test("4.7 telemetry: whatever is handed to sanitize, only the allow-list comes out, with safe types", () => {
  const dirty = {
    type: "telemetry", schema: 1, periodDays: 7, appVersion: "1.0.0 <script>", macosVersion: "15.1", email: "a@b.c", name: "Blake", paths: ["/Users/blake"],
    agentsByKind: { "claude-code": 2, "Blake's agent": 1, codex: -4, mcp: "3" }, goalsPerDay: [1, 2, "x", -5, 9e99, 0, 0, 99, 99], taskAcceptanceRate: 7, crashCount: 2.9,
  };
  const p = sanitizeTelemetry(dirty);
  assert.deepEqual(Object.keys(p).sort(), [...TELEMETRY_KEYS].sort());
  assert.equal(p.appVersion, "unknown", "a version with odd characters is dropped");
  assert.deepEqual(p.agentsByKind, { "claude-code": 2 });
  assert.equal(p.goalsPerDay.length, 7);
  assert.ok(p.goalsPerDay.every((n) => Number.isInteger(n) && n >= 0 && n <= 1_000_000));
  assert.equal(p.taskAcceptanceRate, 1);
  assert.equal(p.crashCount, 2);
  assert.equal(JSON.stringify(sanitizeTelemetry(null)).includes("null,"), true);
  // the owner-facing list names every data field of the payload, in order, and nothing else
  assert.deepEqual(TELEMETRY_FIELDS.map((f) => f.key), TELEMETRY_KEYS.filter((k) => !["type", "schema", "periodDays"].includes(k)));
});

test("4.7 telemetry: one batch a week, first one a week after it was switched on, retried no sooner than six hours after a failure, nothing when off or no endpoint", async () => {
  const { dir, store } = setup();
  const env = { AGENT_ROOM_REPORT_URL: ENDPOINT };
  const t0 = Date.UTC(2026, 9, 23);
  const spy = spyFetch();
  const o = { dataDir: dir, env, fetch: spy.fn, version: "1.0.0", macos: "15.1" };
  assert.equal(await telemetryTick(store, o, t0 + 30 * 86400_000), false, "off");
  setPrivacy(store, { telemetry: true }, t0);
  assert.equal(store.getKV(KV_TELEMETRY_SINCE, 0), t0);
  assert.equal(await telemetryTick(store, { ...o, env: {} }, t0 + 8 * 86400_000), false, "no endpoint");
  assert.equal(await telemetryTick(store, o, t0 + 6 * 86400_000), false, "not a week yet");
  assert.equal(spy.calls.length, 0);
  assert.equal(await telemetryTick(store, o, t0 + WEEK_MS), true);
  assert.equal(spy.calls.length, 1);
  const sent = JSON.parse(spy.calls[0].body) as TelemetryPayload;
  assert.deepEqual(Object.keys(sent).sort(), [...TELEMETRY_KEYS].sort());
  assert.equal(sent.appVersion, "1.0.0");
  assert.equal(store.getKV(KV_TELEMETRY_SENT, 0), t0 + WEEK_MS);
  assert.equal(await telemetryTick(store, o, t0 + WEEK_MS + 3600_000), false, "a batch just went");
  // a failing endpoint: tried, then left alone for six hours
  const down = spyFetch(false, 500);
  const od = { ...o, fetch: down.fn };
  const t2 = t0 + 2 * WEEK_MS;
  assert.equal(await telemetryTick(store, od, t2), false);
  assert.equal(await telemetryTick(store, od, t2 + 3600_000), false);
  assert.equal(down.calls.length, 1, "no second try inside six hours");
  assert.equal(await telemetryTick(store, od, t2 + 7 * 3600_000), false);
  assert.equal(down.calls.length, 2);
  assert.equal(await telemetryTick(store, o, t2 + 14 * 3600_000), true);
  // switching it off stops everything
  setPrivacy(store, { telemetry: false });
  assert.equal(await telemetryTick(store, o, t2 + 30 * 86400_000), false);
  assert.equal(store.getKV(KV_TELEMETRY, null), false);
});

// ---------- appcast and updates

test("4.7 version: the VERSION line becomes the plist form; versions compare like Sparkle's; Darwin maps to the macOS number", () => {
  assert.equal(plistVersion("2026-10-23.1 (Phase 0 week 1: routing log)\n"), "2026.10.23.1");
  assert.equal(plistVersion("1.0.0\n"), "1.0.0");
  assert.ok(appVersion({ AGENT_ROOM_VERSION: "9.9.9" }) === "9.9.9");
  assert.match(appVersion({}), /^[0-9A-Za-z.+-]+$/);
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
  assert.ok(compareVersions("1.0", "1.0.0") === 0);
  assert.ok(compareVersions("1.0.1", "1.0") > 0);
  assert.ok(compareVersions("1.0", "1.0b1") > 0, "a release is newer than its beta");
  assert.ok(compareVersions("2026.10.23.2", "2026.10.23.1") > 0);
  assert.ok(compareVersions("0.9", "1.0") < 0);
  assert.equal(macosVersionFromDarwin("24.1.0", "darwin"), "15.1");
  assert.equal(macosVersionFromDarwin("23.6.0", "darwin"), "14.6");
  assert.equal(macosVersionFromDarwin("25.0.0", "darwin"), "26.0");
  assert.equal(macosVersionFromDarwin("6.18.44", "linux"), "not-mac");
});

test("4.7 appcast: the fixture is read, the newest usable item is offered, betas and too-new-for-this-Mac items are not", () => {
  const items = parseAppcast(APPCAST);
  assert.equal(items.length, 4);
  const v110 = items.find((i) => i.version === "1.1.0")!;
  assert.equal(v110.url, "https://updates.example.com/AgentRoom-1.1.0.dmg?x=1&y=2", "entities are decoded");
  assert.equal(v110.notesUrl, "https://updates.example.com/notes/1.1.0.html");
  assert.equal(v110.minimumSystemVersion, "14.0");
  assert.equal(items.find((i) => i.version === "1.0.0")!.url, undefined, "an http download link is not carried");
  assert.equal(items.find((i) => i.version === "1.2.0")!.channel, "beta");
  const offer = offerFrom(items, "1.0.0", "15.1")!;
  assert.equal(offer.version, "1.1.0", "not 1.2.0 (beta) and not 2.0.0 (needs macOS 99)");
  assert.equal(offer.downloadUrl, v110.url);
  assert.equal(offer.title, "Version 1.1.0");
  assert.equal(offerFrom(items, "1.1.0", "15.1"), undefined, "already current");
  assert.equal(offerFrom(items, "1.5.0", "15.1"), undefined, "ahead of the feed");
  assert.equal(offerFrom(items, "1.0.0", "not-mac")?.version, "2.0.0", "the minimum-system check needs a known macOS version");
  assert.deepEqual(parseAppcast("<rss><channel></channel></rss>"), []);
  assert.deepEqual(parseAppcast("not xml at all"), []);
});

test("4.7 appcast: a DTD or entity declaration, or a huge file, is refused; nothing is expanded", () => {
  assert.throws(() => parseAppcast('<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><sparkle:version>&x;</sparkle:version></item></channel></rss>'), /DTD/);
  assert.throws(() => parseAppcast("<rss>" + "x".repeat(1_100_000) + "</rss>"), /too large/);
  const evil = parseAppcast(`<rss><channel><item><sparkle:version>3.0</sparkle:version><enclosure url="javascript:alert(1)"/><sparkle:releaseNotesLink>file:///etc/passwd</sparkle:releaseNotesLink></item></channel></rss>`)[0];
  assert.equal(evil.url, undefined);
  assert.equal(evil.notesUrl, undefined);
});

test("4.7 update checker: nothing is fetched without a feed address or with the switch off; with both it reads the appcast and remembers the offer", async () => {
  const { store } = setup();
  const urls: string[] = [];
  const fetchOk: TextFetch = async (url, init) => { urls.push(url); assert.match(init.headers["user-agent"], /^AgentRoom\/1\.0\.0$/, "the request names the version and nothing else"); return { ok: true, status: 200, text: async () => APPCAST }; };
  const base = { fetch: fetchOk, version: "1.0.0", macos: "15.1", plistText: "" };
  // no feed: placeholders in Info.plist count as none
  const none = new UpdateChecker(store, { ...base, env: {} });
  assert.equal(none.info().feedConfigured, false);
  await none.check(true);
  const placeholder = '<key>SUFeedURL</key>\n<string>https://updates.example.invalid/agent-room/appcast.xml</string>';
  assert.equal(feedUrl({}, placeholder), undefined);
  await new UpdateChecker(store, { ...base, env: {}, plistText: placeholder }).check(true);
  assert.equal(urls.length, 0, "never fetched");
  // a real address from the app's own Info.plist
  const real = '<key>SUFeedURL</key>\n<string>https://updates.example.com/appcast.xml</string>';
  assert.equal(feedUrl({}, real), "https://updates.example.com/appcast.xml");
  assert.equal(feedUrl({ AGENT_ROOM_APPCAST_URL: "http://plain.example.com/a.xml" }, real), undefined, "a plain-http override is not used");
  const c = new UpdateChecker(store, { ...base, env: {}, plistText: real });
  assert.equal(c.info().update, undefined);
  setPrivacy(store, { updateChecks: false });
  await c.check();
  assert.equal(urls.length, 0, "automatic checks are off");
  const forced = await c.check(true, 5_000);
  assert.equal(urls.length, 1, "the Check now button still works");
  assert.equal(forced.update?.version, "1.1.0");
  assert.equal(forced.checkedAt, 5_000);
  assert.equal(forced.feedConfigured, true);
  assert.equal(forced.checksOn, false);
  // once the app is updated the stale offer disappears
  assert.equal(new UpdateChecker(store, { ...base, version: "1.1.0", env: {}, plistText: real }).info().update, undefined);
  // failures are said plainly and don't throw
  const down = new UpdateChecker(store, { ...base, env: {}, plistText: real, fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
  assert.match((await down.check(true)).error ?? "", /404/);
  const garbled = new UpdateChecker(store, { ...base, env: {}, plistText: real, fetch: async () => ({ ok: true, status: 200, text: async () => "<!DOCTYPE x>" }) });
  assert.match((await garbled.check(true)).error ?? "", /DTD/);
});

// ---------- macOS crash reports

test("4.7 macOS crash reports: Agent Room's and its bundled node's are listed (names, dates, sizes only), others are not, new ones are marked", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-diag-"));
  writeFileSync(join(dir, "AgentRoom-2026-10-23-101010.ips"), "{}");
  writeFileSync(join(dir, "node-2026-10-23-111111.ips"), '{"procPath":"/Applications/AgentRoom.app/Contents/Resources/node"}');
  writeFileSync(join(dir, "node-2026-10-22-000000.ips"), '{"procPath":"/opt/homebrew/bin/node"}');
  writeFileSync(join(dir, "Safari-2026-10-23.ips"), "{}");
  writeFileSync(join(dir, "AgentRoom-notes.txt"), "not a report");
  const all = listMacReports(dir, 0);
  assert.deepEqual(all.map((r) => r.name).sort(), ["AgentRoom-2026-10-23-101010.ips", "node-2026-10-23-111111.ips"]);
  assert.ok(all.every((r) => r.isNew && r.bytes > 0 && r.at > 0));
  assert.ok(listMacReports(dir, Date.now() + 10_000).every((r) => !r.isNew));
  assert.deepEqual(listMacReports(join(dir, "missing")), []);
});

// ---------- HTTP

async function boot(extra: { env?: NodeJS.ProcessEnv; fetch?: FetchLike; updates?: UpdateChecker; macReportsDir?: string } = {}) {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake", distribution: { dataDir: ctx.dir, version: "1.0.0", macos: "15.1", ...extra } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await pr.json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async <T>(p: string) => (await (await fetch(`${base}${p}`, { headers: h })).json()) as T;
  const send = async (m: string, p: string, body?: unknown) => fetch(`${base}${p}`, { method: m, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...ctx, app, base, h, get, send };
}

test("4.7 HTTP: /privacy starts all-off, the owner can switch each on and off, each change is audited, and unknown fields are refused", async () => {
  const b = await boot();
  assert.equal((await fetch(`${b.base}/privacy`)).status, 401, "needs a paired device");
  assert.equal((await fetch(`${b.base}/version`)).status, 401);
  const p0 = await b.get<PrivacyState>("/privacy");
  assert.equal(p0.crashReports, false);
  assert.equal(p0.telemetry, false);
  assert.equal(p0.endpointConfigured, false);
  assert.equal(p0.telemetryFields.length, 6);
  const on = await b.send("PUT", "/privacy", { crashReports: true });
  const p1 = (await on.json()) as PrivacyState;
  assert.equal(p1.crashReports, true);
  assert.equal(p1.telemetry, false, "the other switch is untouched");
  assert.equal((await b.send("PUT", "/privacy", { telemetry: "yes" })).status, 400);
  assert.equal((await b.send("PUT", "/privacy", { somethingElse: true })).status, 400);
  const p2 = (await (await b.send("PUT", "/privacy", { telemetry: true, crashReports: false })).json()) as PrivacyState;
  assert.equal(p2.telemetry, true);
  assert.equal(p2.crashReports, false);
  assert.ok(p2.telemetryNextAt && p2.telemetryNextAt > Date.now() + 6 * 86400_000, "the first batch is a week away");
  const actions = b.store.listAudit(50).map((e) => e.action);
  for (const a of ["reports.crash.on", "reports.crash.off", "reports.telemetry.on"]) assert.ok(actions.includes(a), a);
  await b.app.close();
});

test("4.7 HTTP: /telemetry/preview is the exact payload, works while the switch is off, and sends nothing", async () => {
  const spy = spyFetch();
  const b = await boot({ fetch: spy.fn, env: { AGENT_ROOM_REPORT_URL: ENDPOINT } });
  const pv = await b.get<{ payload: TelemetryPayload; on: boolean; endpointConfigured: boolean; endpointHost: string }>("/telemetry/preview");
  assert.equal(pv.on, false);
  assert.equal(pv.endpointConfigured, true);
  assert.equal(pv.endpointHost, "reports.example.com");
  assert.deepEqual(Object.keys(pv.payload).sort(), [...TELEMETRY_KEYS].sort());
  assert.equal(pv.payload.appVersion, "1.0.0");
  assert.equal(pv.payload.macosVersion, "15.1");
  assert.equal(spy.calls.length, 0, "looking is not sending");
  await b.app.close();
});

test("4.7 HTTP: /version, and the update the appcast offers (read through an injected fetch, parsed from the fixture)", async () => {
  const { store } = setup();
  const updates = new UpdateChecker(store, {
    version: "1.0.0", macos: "15.1", env: {}, plistText: '<key>SUFeedURL</key><string>https://updates.example.com/appcast.xml</string>',
    fetch: async () => ({ ok: true, status: 200, text: async () => APPCAST }),
  });
  const b = await boot({ updates });
  // the checker above has its own store, so check through its own info() too
  const v0 = await b.get<VersionInfo>("/version");
  assert.equal(v0.version, "1.0.0");
  assert.equal(v0.feedConfigured, true);
  assert.equal(v0.update, undefined, "nothing has been fetched yet");
  const v1 = (await (await b.send("POST", "/version/check")).json()) as VersionInfo;
  assert.equal(v1.update?.version, "1.1.0");
  assert.equal(v1.update?.downloadUrl, "https://updates.example.com/AgentRoom-1.1.0.dmg?x=1&y=2");
  assert.equal((await b.get<VersionInfo>("/version")).update?.version, "1.1.0");
  await b.app.close();
  // with no feed (the default build) the route answers and says so
  const b2 = await boot({ env: {} });
  const v2 = await b2.get<VersionInfo>("/version");
  assert.equal(v2.feedConfigured, false);
  assert.equal(v2.update, undefined);
  await b2.app.close();
});

test("4.7 HTTP: /crashes lists hub and macOS reports (no content), /crashes/seen clears 'new', /crashes/clear deletes the hub's files and is audited", async () => {
  const mac = mkdtempSync(join(tmpdir(), "ar-diag-"));
  writeFileSync(join(mac, "AgentRoom-2026-10-23-101010.ips"), "{}");
  const b = await boot({ macReportsDir: mac });
  writeCrashReport(b.dir, buildCrashReport(new TypeError("bad thing"), "uncaughtException", { version: "1.0.0", homes: HOMES }));
  const l = await b.get<CrashList>("/crashes");
  assert.equal(l.hub.length, 1);
  assert.equal(l.hub[0].sent, false);
  assert.match(l.hub[0].message, /TypeError: bad thing/);
  assert.equal(l.mac.length, 1);
  assert.equal(l.mac[0].isNew, true);
  await b.send("POST", "/crashes/seen");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await b.get<CrashList>("/crashes")).mac[0].isNew, false);
  const del = (await (await b.send("POST", "/crashes/clear")).json()) as { deleted: number };
  assert.equal(del.deleted, 1);
  assert.equal((await b.get<CrashList>("/crashes")).hub.length, 0);
  assert.ok(b.store.listAudit(20).some((e) => e.action === "crashes.clear"));
  assert.ok(existsSync(mac), "the macOS reports are never touched");
  assert.equal(readdirSync(mac).length, 1);
  await b.app.close();
});

test("4.7 reporting switches live in the store as plain booleans (the rule is the code above, not a hidden default)", () => {
  const { store } = setup();
  assert.equal(store.getKV(KV_CRASH, "unset"), "unset");
  assert.equal(store.getKV(KV_TELEMETRY, "unset"), "unset");
});
