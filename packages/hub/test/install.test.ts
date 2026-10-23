// 1.7 Installable app: sign-in parsing and flows (fake CLIs), the setup timer, the packaging scripts' sanity, and the
// staged package.json. Nothing here runs a real CLI or touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, SignInView } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { parseSignIn, redactSignIn, needsTty, callbackPortBusy } from "../src/install/parse.js";
import { SignInManager, type LoginProc, type SignInDeps } from "../src/install/signin.js";
import { KV_FIRST_GOAL_DONE, KV_STARTED, markFirstGoalDone, markSetupStarted, setupTimer } from "../src/install/timer.js";
import { setup } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const fixture = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

// ---------- parsing the CLIs' sign-in output

test("1.7 parse: Claude Code's sign-in link and its paste-a-code prompt", () => {
  const a = parseSignIn("claude-code", fixture("signin-claude-login.txt"));
  assert.match(a.url ?? "", /^https:\/\/claude\.ai\/oauth\/authorize\?/);
  assert.ok(a.url!.includes("state=Qw3rTy"), "the whole query string survives, not just the host");
  assert.equal(a.code, undefined);
  assert.equal(a.needsPaste, false);
  const b = parseSignIn("claude-code", fixture("signin-claude-paste.txt"));
  assert.match(b.url ?? "", /^https:\/\/claude\.ai\/oauth\/authorize\?/);
  assert.equal(b.needsPaste, true);
  assert.ok(!b.url!.endsWith("."), "trailing punctuation is not part of the link");
});

test("1.7 parse: Codex browser sign-in prints the OpenAI link, never the localhost callback", () => {
  const p = parseSignIn("codex", fixture("signin-codex-browser.txt"));
  assert.match(p.url ?? "", /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  assert.equal(p.code, undefined, "client ids and challenges are not device codes");
});

test("1.7 parse: Codex device code, with ANSI colour and in the docs' wording", () => {
  const real = parseSignIn("codex", fixture("signin-codex-device.txt"));
  assert.equal(real.url, "https://auth.openai.com/codex/device");
  assert.equal(real.code, "AAAAB-BB6TU");
  const docs = parseSignIn("codex", fixture("signin-codex-device-docs.txt"));
  assert.equal(docs.url, "https://chatgpt.com/activate");
  assert.equal(docs.code, "ABCD-1234");
});

test("1.7 parse: only https links on the provider's own domain are ever returned", () => {
  const p = parseSignIn("claude-code", fixture("signin-hostile.txt"));
  assert.equal(p.url, "https://claude.com/cai/oauth/authorize?state=1");
  assert.equal(parseSignIn("claude-code", "visit https://auth.openai.com/x").url, undefined, "another provider's domain is not this agent's");
  assert.equal(parseSignIn("codex", "go to http://auth.openai.com/x").url, undefined, "no plain http");
  assert.equal(parseSignIn("codex", "go to https://user:pw@auth.openai.com/x").url, undefined, "no credentials in the link");
});

test("1.7 parse: tty and port-busy detection, and the log never keeps links or codes", () => {
  assert.ok(needsTty("Error: Raw mode is not supported on the current process.stdin"));
  assert.ok(!needsTty(fixture("signin-codex-browser.txt")));
  assert.ok(callbackPortBusy(fixture("signin-codex-port-busy.txt")));
  assert.ok(!callbackPortBusy(fixture("signin-codex-browser.txt")));
  const red = redactSignIn(fixture("signin-codex-device.txt"));
  assert.ok(!red.includes("https://") && !red.includes("AAAAB-BB6TU"), red);
});

// ---------- sign-in flows with a scripted CLI

class FakeProc implements LoginProc {
  outs: ((c: string) => void)[] = []; exits: ((c: number | null) => void)[] = []; written: string[] = []; killed = false;
  onOutput(cb: (c: string) => void) { this.outs.push(cb); }
  onExit(cb: (c: number | null) => void) { this.exits.push(cb); }
  write(s: string) { this.written.push(s); }
  kill() { this.killed = true; }
  say(text: string) { this.outs.forEach((f) => f(text)); }
  exit(code: number) { this.exits.forEach((f) => f(code)); }
}
const agent = (adapter: "claude-code" | "codex", over: Partial<AgentConfig> = {}): AgentConfig =>
  ({ id: adapter === "codex" ? "codex" : "claude", name: adapter, provider: "x", adapter, enabled: true, color: "#000", settings: {}, tools: {}, ...over });
const until = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); assert.ok(cond(), "timed out waiting"); };

function rig(over: Partial<SignInDeps> & { signed?: () => boolean | undefined } = {}) {
  const starts: { cmd: string; args: string[]; proc: FakeProc }[] = [];
  const audits: string[] = []; const done: string[] = [];
  const state = { signed: false as boolean | undefined };
  const mgr = new SignInManager({
    start: (cmd, args) => { const proc = new FakeProc(); starts.push({ cmd, args, proc }); return proc; },
    which: async (bin) => `/fake/bin/${bin}`,
    signedIn: async () => (over.signed ? over.signed() : state.signed),
    pollMs: 10, timeoutMs: 5000,
    audit: (a, d) => audits.push(`${a} ${d}`), onDone: (a) => done.push(a.id),
    ...over,
  });
  return { mgr, starts, audits, done, state };
}

test("1.7 sign-in: Codex in the browser. The link shows up, the poll sees the login, the flow ends signed in", async () => {
  const { mgr, starts, audits, done, state } = rig();
  const v0 = await mgr.start(agent("codex"));
  assert.equal(v0.state, "starting");
  await until(() => starts.length === 1);
  assert.deepEqual([starts[0].cmd, ...starts[0].args], ["/fake/bin/codex", "login"]);
  starts[0].proc.say(fixture("signin-codex-browser.txt"));
  const v1 = mgr.view("codex");
  assert.equal(v1.state, "waiting");
  assert.match(v1.url ?? "", /^https:\/\/auth\.openai\.com\//);
  assert.equal(v1.method, "browser");
  state.signed = true; // the browser finished; Codex wrote its login
  await until(() => mgr.view("codex").state === "done");
  assert.deepEqual(done, ["codex"]);
  assert.ok(audits.some((a) => a.startsWith("setup.signin.start codex browser")) && audits.some((a) => a.startsWith("setup.signin.done")));
  assert.ok(audits.every((a) => !a.includes("https://")), "the audit log never holds the link");
});

test("1.7 sign-in: Codex with a one-time code", async () => {
  const { mgr, starts, state } = rig();
  await mgr.start(agent("codex"), { mode: "device" });
  await until(() => starts.length === 1);
  assert.deepEqual(starts[0].args, ["login", "--device-auth"]);
  starts[0].proc.say(fixture("signin-codex-device.txt"));
  const v = mgr.view("codex");
  assert.equal(v.code, "AAAAB-BB6TU");
  assert.equal(v.url, "https://auth.openai.com/codex/device");
  assert.match(v.message, /code/i);
  state.signed = true; starts[0].proc.exit(0);
  await until(() => mgr.view("codex").state === "done");
});

test("1.7 sign-in: Claude Code runs `claude auth login`; a pasted code goes to the CLI and nowhere else", async () => {
  const { mgr, starts, state } = rig();
  await mgr.start(agent("claude-code"));
  await until(() => starts.length === 1);
  assert.deepEqual([starts[0].cmd, ...starts[0].args], ["/fake/bin/claude", "auth", "login"]);
  starts[0].proc.say(fixture("signin-claude-paste.txt"));
  assert.equal(mgr.view("claude").needsPaste, true);
  assert.equal(mgr.submitCode("claude", "not a code!"), false, "odd characters are refused");
  assert.equal(mgr.submitCode("claude", "AbC123-_xyz789"), true);
  assert.deepEqual(starts[0].proc.written, ["AbC123-_xyz789\n"]);
  assert.equal(mgr.view("claude").needsPaste, false);
  assert.ok(!JSON.stringify(mgr.view("claude")).includes("AbC123"), "the code isn't kept in the view");
  state.signed = true; starts[0].proc.exit(0);
  await until(() => mgr.view("claude").state === "done");
});

test("1.7 sign-in: a CLI that needs a terminal is retried once inside `script`; Codex's busy port falls back to a code", async () => {
  const a = rig();
  await a.mgr.start(agent("claude-code"), { force: true });
  await until(() => a.starts.length === 1);
  a.starts[0].proc.say("Error: Raw mode is not supported on the current process.stdin");
  a.starts[0].proc.exit(1);
  await until(() => a.starts.length === 2);
  assert.deepEqual([a.starts[1].cmd, ...a.starts[1].args], ["/usr/bin/script", "-q", "/dev/null", "/fake/bin/claude", "auth", "login"]);
  a.starts[1].proc.exit(1); // still failing: it is not retried again
  a.state.signed = false;
  await until(() => a.mgr.view("claude").state === "failed");
  assert.equal(a.starts.length, 2);

  const b = rig();
  await b.mgr.start(agent("codex"), { force: true });
  await until(() => b.starts.length === 1);
  b.starts[0].proc.say(fixture("signin-codex-port-busy.txt"));
  b.starts[0].proc.exit(1);
  await until(() => b.starts.length === 2);
  assert.deepEqual(b.starts[1].args, ["login", "--device-auth"]);
  assert.equal(b.mgr.view("codex").method, "device");
});

test("1.7 sign-in: missing CLI is installed first; a failed install says where to go next", async () => {
  const installs: string[] = [];
  let found = false;
  const a = rig({ which: async (b) => (found ? `/fake/bin/${b}` : null), install: async (ad) => { installs.push(ad); found = true; return { ok: true, output: "ok" }; } });
  const v = await a.mgr.start(agent("codex"));
  assert.ok(["starting", "installing"].includes(v.state));
  await until(() => a.starts.length === 1);
  assert.deepEqual(installs, ["codex"]);

  const b = rig({ which: async () => null, install: async () => ({ ok: false, output: "curl: (6) Could not resolve host" }) });
  await b.mgr.start(agent("claude-code"));
  await until(() => b.mgr.view("claude").state === "failed");
  assert.match(b.mgr.view("claude").message, /Terminal/);
  assert.equal(b.starts.length, 0);
});

test("1.7 sign-in: already signed in, a failed login, a timeout and a cancel", async () => {
  const a = rig(); a.state.signed = true;
  await a.mgr.start(agent("codex"));
  await until(() => a.mgr.view("codex").state === "done");
  assert.equal(a.starts.length, 0, "no login is started when status() already says signed in");
  assert.match(a.mgr.view("codex").message, /Already/);

  const b = rig();
  await b.mgr.start(agent("codex"), { force: true });
  await until(() => b.starts.length === 1);
  b.starts[0].proc.say("Error: access_denied");
  b.starts[0].proc.exit(1);
  await until(() => b.mgr.view("codex").state === "failed");
  assert.match(b.mgr.view("codex").message, /access_denied/);

  const c = rig({ timeoutMs: 40 });
  await c.mgr.start(agent("codex"), { force: true });
  await until(() => c.starts.length === 1);
  await until(() => c.mgr.view("codex").state === "failed");
  assert.match(c.mgr.view("codex").message, /Timed out/);
  assert.ok(c.starts[0].proc.killed);

  const d = rig();
  await d.mgr.start(agent("codex"), { force: true });
  await until(() => d.starts.length === 1);
  d.mgr.cancel("codex");
  assert.equal(d.mgr.view("codex").state, "cancelled");
  assert.ok(d.starts[0].proc.killed);
  d.starts[0].proc.exit(0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.mgr.view("codex").state, "cancelled", "an exit after cancel changes nothing");
});

test("1.7 sign-in: a flow already running is returned as it is, and the log holds no links or codes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-signin-"));
  const { mgr, starts } = rig({ logDir: dir });
  await mgr.start(agent("codex"), { mode: "device", force: true });
  await until(() => starts.length === 1);
  starts[0].proc.say(fixture("signin-codex-device.txt"));
  const again = await mgr.start(agent("codex"));
  assert.equal(again.code, "AAAAB-BB6TU");
  assert.equal(starts.length, 1, "no second login process");
  const log = readFileSync(join(dir, "signin-codex.log"), "utf8");
  assert.ok(log.includes("<url>") && log.includes("<code>") && !log.includes("https://") && !log.includes("BB6TU"), log);
});

// ---------- the HTTP side and the setup timer

async function boot(signin?: SignInManager) {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake", signin });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const { token } = (await (await fetch(`${base}/pair/local`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async <T>(path: string) => (await (await fetch(`${base}${path}`, { headers: h })).json()) as T;
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { ...ctx, app, base, h, get, post };
}

test("1.7 API: POST/GET /setup/signin/:agent start and poll an in-app sign-in; Terminal stays a fallback", async () => {
  const r = rig();
  const t = await boot(r.mgr);
  const agents = t.store.listAgents();
  const target = agents.find((a) => a.adapter === "mock") ?? agents[0];
  t.store.saveAgent({ ...target, id: "codex", adapter: "codex" }); // the route finds the agent by id; the fake CLI does the rest

  assert.equal((await fetch(`${t.base}/setup/signin/codex`, { method: "POST" })).status, 401, "needs a paired device");
  assert.equal((await t.post("/setup/signin/nobody")).status, 404);
  assert.equal((await t.post("/setup/signin/codex", { mode: "nonsense" })).status, 400);

  const started = (await (await t.post("/setup/signin/codex", { mode: "browser" })).json()) as SignInView & { ok: boolean };
  assert.equal(started.ok, true);
  await until(() => r.starts.length === 1);
  r.starts[0].proc.say(fixture("signin-codex-browser.txt"));
  const polled = await t.get<SignInView>("/setup/signin/codex");
  assert.equal(polled.state, "waiting");
  assert.match(polled.url ?? "", /^https:\/\/auth\.openai\.com\//);

  const nope = await t.post("/setup/signin/codex/code", { code: "abcdef123" });
  assert.equal(nope.status, 200, "a running sign-in takes a pasted code");
  const cancelled = (await (await t.post("/setup/signin/codex/cancel")).json()) as SignInView;
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await t.post("/setup/signin/codex/code", { code: "abcdef123" })).status, 409, "nothing is waiting any more");

  const term = (await (await t.post("/setup/signin/codex", { mode: "terminal" })).json()) as SignInView & { ok: boolean };
  assert.equal(term.terminal, true, "the Terminal fallback is still there");
  assert.ok(t.store.listAudit(50).some((e) => e.action === "setup.signin.terminal"));
  await t.app.close();
});

test("1.7 timer: starts at first launch, shows in GET /setup, stops at the first finished goal", async () => {
  const t = await boot();
  const s0 = await t.get<{ elapsedSeconds: number; timer: { done: boolean; startedAt: number } }>("/setup");
  assert.equal(s0.timer.done, false);
  assert.ok(s0.elapsedSeconds >= 0 && s0.elapsedSeconds < 5, "just started");

  // Pretend the app was first opened two minutes ago.
  t.store.setKV(KV_STARTED, Date.now() - 125_000);
  const s1 = await t.get<{ elapsedSeconds: number }>("/setup");
  assert.ok(s1.elapsedSeconds >= 125 && s1.elapsedSeconds <= 130, String(s1.elapsedSeconds));

  const room = t.store.listRooms()[0];
  await t.post(`/rooms/${room.id}/messages`, { text: "Write a two line poem about bars" });
  for (let i = 0; i < 100 && t.store.listGoals(room.id)[0]?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.store.listGoals(room.id)[0].status, "done");

  const s2 = await t.get<{ elapsedSeconds: number; timer: { done: boolean; firstGoalDoneAt: number; startedAt: number; firstGoalPractice: boolean } }>("/setup");
  assert.equal(s2.timer.done, true);
  assert.ok(typeof t.store.getKV<number | null>(KV_FIRST_GOAL_DONE, null) === "number");
  assert.equal(s2.elapsedSeconds, Math.round((s2.timer.firstGoalDoneAt - s2.timer.startedAt) / 1000));
  assert.ok(s2.elapsedSeconds >= 125);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await t.get<{ elapsedSeconds: number }>("/setup")).elapsedSeconds, s2.elapsedSeconds, "the clock stopped");
  await t.app.close();
});

test("1.7 timer: module rules (start once, stop once, no stop without a start)", () => {
  const { store } = setup();
  assert.equal(markFirstGoalDone(store, 1000), undefined, "no start, no stop");
  assert.deepEqual(setupTimer(store, 5000), { done: false });
  assert.equal(markSetupStarted(store, 1000), 1000);
  assert.equal(markSetupStarted(store, 9999), 1000, "a later launch keeps the first start");
  assert.equal(setupTimer(store, 61_000).elapsedSeconds, 60);
  assert.equal(markFirstGoalDone(store, 181_000), 181_000);
  assert.equal(markFirstGoalDone(store, 999_000), undefined, "only the first goal counts");
  const t = setupTimer(store, 999_000);
  assert.equal(t.elapsedSeconds, 180);
  assert.equal(t.done, true);
  assert.ok(store.listAudit(20).some((e) => e.action === "setup.first_goal_done"));
});

// ---------- packaging

const SCRIPTS = ["package-mac.sh", "verify-dmg.sh", "stage-hub.sh", "smoke-hub.sh"].map((f) => join(ROOT, "scripts", f));

test("1.7 packaging: every script parses (bash -n) and passes shellcheck when it is installed", () => {
  for (const f of SCRIPTS) {
    const r = spawnSync("bash", ["-n", f], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const sc = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
  if (sc.status !== 0) { console.log("shellcheck isn't installed here; bash -n only"); return; }
  const r = spawnSync("shellcheck", ["-S", "warning", ...SCRIPTS], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("1.7 packaging: package-mac.sh stops at once, with a clear message, anywhere but macOS", { skip: process.platform === "darwin" }, () => {
  const r = spawnSync("bash", [join(ROOT, "scripts/package-mac.sh")], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only runs on macOS/);
  const v = spawnSync("bash", [join(ROOT, "scripts/verify-dmg.sh")], { encoding: "utf8", timeout: 10_000 });
  assert.equal(v.status, 1);
  assert.match(v.stderr, /only runs on macOS/);
});

test("1.7 packaging: the staged package.json lists exactly what the bundle leaves external", () => {
  const out = mkdtempSync(join(tmpdir(), "ar-stage-"));
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/stage-hub-package.mjs"), out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const staged = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies?: unknown; type: string };
  const hub = JSON.parse(readFileSync(join(ROOT, "packages/hub/package.json"), "utf8")) as { scripts: { build: string }; dependencies: Record<string, string> };

  // 1. What the build script says to leave out.
  const flagged = [...hub.scripts.build.matchAll(/--external:([^\s"']+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(staged.dependencies).sort(), flagged);
  assert.equal(staged.devDependencies, undefined, "no dev dependencies ship");
  assert.equal(staged.type, "module");
  for (const [name, version] of Object.entries(staged.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned to the version in pnpm-lock.yaml`);
    assert.ok(hub.dependencies[name], `${name} is a dependency of the hub`);
  }
  // 2. run.sh (the dev launcher) leaves out the same things.
  const runSh = [...readFileSync(join(ROOT, "packages/hub/run.sh"), "utf8").matchAll(/--external:([^\s"']+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(runSh)], flagged);

  // 3. What the bundle really imports without bundling it (esbuild's own report), minus Node's built-ins.
  const esbuild = [join(ROOT, "packages/hub/node_modules/.bin/esbuild"), join(ROOT, "node_modules/.bin/esbuild")].find(existsSync);
  assert.ok(esbuild, "esbuild is installed");
  const meta = join(out, "meta.json");
  const b = spawnSync(esbuild!, ["src/main.ts", "--bundle", "--platform=node", "--format=esm", "--target=node20", `--outfile=${join(out, "hub.mjs")}`, `--metafile=${meta}`,
    ...flagged.map((n) => `--external:${n}`), "--log-level=error"], { cwd: join(ROOT, "packages/hub"), encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const imported = new Set<string>();
  const metafile = JSON.parse(readFileSync(meta, "utf8")) as { outputs: Record<string, { imports: { path: string; external?: boolean }[] }> };
  for (const o of Object.values(metafile.outputs)) for (const i of o.imports) if (i.external && !builtins.has(i.path) && !i.path.startsWith("node:")) imported.add(i.path.split("/").slice(0, i.path.startsWith("@") ? 2 : 1).join("/"));
  // ws asks for bufferutil and utf-8-validate inside try/catch and runs without them; they are its declared optional extras.
  const wsMeta = JSON.parse(readFileSync(join(ROOT, "packages/hub/node_modules/ws/package.json"), "utf8")) as { peerDependenciesMeta?: Record<string, { optional?: boolean }> };
  const optionalExtras = new Set(Object.entries(wsMeta.peerDependenciesMeta ?? {}).filter(([, v]) => v.optional).map(([k]) => k));
  assert.ok(optionalExtras.has("bufferutil") && optionalExtras.has("utf-8-validate"));
  assert.deepEqual([...imported].filter((n) => !optionalExtras.has(n)).sort(), flagged, "the bundle imports no package that the app doesn't ship");
});

test("1.7 packaging: package-mac.sh assembles Hub/ the way HubLauncher.m expects", () => {
  const sh = readFileSync(join(ROOT, "scripts/package-mac.sh"), "utf8");
  const m = readFileSync(join(ROOT, "packages/app/macos/AgentRoom-macOS/HubLauncher.m"), "utf8");
  assert.match(sh, /RES="\$APP\/Contents\/Resources"/);
  assert.match(sh, /ditto "\$BUILD\/stage\/Hub" "\$RES\/Hub"/);
  assert.match(sh, /install -m 755 "\$NODE" "\$RES\/node"/);
  assert.match(m, /stringByAppendingPathComponent:@"node"/);
  assert.match(m, /stringByAppendingPathComponent:@"Hub"/);
  assert.match(m, /hub\.mjs/);
  const staged = readdirSync(join(ROOT, "packages/hub/web"));
  assert.ok(staged.includes("index.html"), "the web app the stage script copies exists");
});
