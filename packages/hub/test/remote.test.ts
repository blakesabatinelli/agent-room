import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConnection, RemoteStatus } from "@agent-room/shared";
import WebSocket from "ws";
import { buildServer } from "../src/api/server.js";
import { isAllowedLocalAddress } from "../src/net.js";
import { Tailscale, MAC_APP_CLI, readFunnel, pathsOnPort } from "../src/remote/tailscale.js";
import { AuthLimiter, isRemoteRequest } from "../src/remote/guard.js";
import { localPairHeaders, setup } from "./helpers.js";

const HOST = "mac.tail1234.ts.net";
const RUNNING = {
  BackendState: "Running", MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "blake@example.com", MagicDNSEnabled: true },
  Self: { DNSName: `${HOST}.`, TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"], Online: true },
};

/** A fake `tailscale` CLI: prints canned JSON per subcommand, logs its argv, and edits a serve config when asked to funnel. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.FAKE_TS_DIR, args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(args) + "\\n");
const read = (n) => { try { return fs.readFileSync(path.join(dir, n), "utf8"); } catch { return null; } };
const sub = args[0];
if (sub === "status") {
  const s = read("status.json");
  if (s === null) { process.stderr.write("failed to connect to local tailscaled; it doesn't appear to be running\\n"); process.exit(1); }
  process.stdout.write(s); process.exit(0);
}
if (sub === "funnel" || sub === "serve") {
  if (args[1] === "status") { process.stdout.write(read("serve.json") || "{}"); process.exit(0); }
  if (read("funnel-denied")) {
    process.stdout.write("Funnel is not enabled on your tailnet.\\nTo enable, visit:\\n  https://login.tailscale.com/f/funnel?node=nABC123\\n"); process.exit(1);
  }
  const off = args.includes("off");
  const sp = (args.find((a) => a.startsWith("--set-path=")) || "--set-path=/").slice(11);
  const port = (args.find((a) => a.startsWith("--https=")) || "--https=443").slice(8);
  const target = args.filter((a) => !a.startsWith("--") && a !== "off" && a !== sub).pop();
  const hp = ${JSON.stringify(HOST)} + ":" + port;
  const cfg = JSON.parse(read("serve.json") || "{}");
  cfg.TCP ||= {}; cfg.Web ||= {}; cfg.AllowFunnel ||= {};
  if (off) {
    if (read("off-fails")) { process.stderr.write("could not remove handler\\n"); process.exit(1); }
    if (cfg.Web[hp]) { delete cfg.Web[hp].Handlers[sp]; if (!Object.keys(cfg.Web[hp].Handlers).length) { delete cfg.Web[hp]; delete cfg.AllowFunnel[hp]; delete cfg.TCP[port]; } }
  } else {
    cfg.TCP[port] = { HTTPS: true };
    (cfg.Web[hp] ||= { Handlers: {} }).Handlers[sp] = { Proxy: target };
    if (sub === "funnel") cfg.AllowFunnel[hp] = true;
  }
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify(cfg));
  process.exit(0);
}
process.exit(2);
`;

function fakeCli(initial: { status?: unknown; serve?: unknown } = { status: RUNNING }) {
  const dir = mkdtempSync(join(tmpdir(), "ar-ts-"));
  const bin = join(dir, "tailscale");
  writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  const put = (name: string, v: unknown) => writeFileSync(join(dir, name), typeof v === "string" ? v : JSON.stringify(v));
  if (initial.status !== undefined) put("status.json", initial.status);
  if (initial.serve !== undefined) put("serve.json", initial.serve);
  const argv = (): string[][] => (existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const ts = (extra: { ttlMs?: number; openApp?: () => Promise<{ ok: boolean; message: string }> } = {}) =>
    new Tailscale({ bin, env: { FAKE_TS_DIR: dir }, ttlMs: extra.ttlMs ?? 0, openApp: extra.openApp });
  return { dir, bin, put, argv, ts };
}

async function boot(cli = fakeCli(), opts: { burst?: number; openApp?: () => Promise<{ ok: boolean; message: string }> } = {}) {
  const ctx = setup();
  const tailscale = cli.ts({ openApp: opts.openApp });
  const app = await buildServer({ ...ctx, ownerName: "Blake", tailscale, remoteAuth: { burst: opts.burst ?? 3, refillMs: 60_000 } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const pr = await fetch(`${base}/pair/local`, { method: "POST", headers: localPairHeaders(ctx.dir), body: "{}" });
  const { token } = (await pr.json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const tk = await fetch(`${base}/mcp-tokens`, { method: "POST", headers: h, body: JSON.stringify({ agentId: "claude", name: "Claude" }) });
  const mcpToken = ((await tk.json()) as { token: string }).token;
  return { ...ctx, ...cli, hubDir: ctx.dir, app, base, port, token, h, mcpToken, tailscale };
}

const RPC = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const mcpHeaders = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });
/** Tailscale's serve config with Funnel on for /mcp, proxying to the hub on `port` (or to `target`). */
const serveFor = (port: number, target = `http://127.0.0.1:${port}/mcp`) => ({
  TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/mcp": { Proxy: target } } } }, AllowFunnel: { [`${HOST}:443`]: true },
});
const PROXY = { "x-forwarded-for": "203.0.113.7", "x-forwarded-host": HOST, "x-forwarded-proto": "https" };

// ---------------------------------------------------------------- AC1: detect and show

test("1.2 AC1: status reports every Tailscale state, with address and MagicDNS name", async () => {
  // not installed: the CLI isn't there at all
  const missing = new Tailscale({ bin: join(tmpdir(), "definitely-not-tailscale"), ttlMs: 0 });
  const ni = await missing.status();
  assert.equal(ni.state, "not_installed");
  assert.equal(ni.funnel.on, false);

  // stopped: CLI exists, daemon isn't running (status exits 1)
  const cli = fakeCli({});
  const stopped = await cli.ts().status();
  assert.equal(stopped.state, "stopped");
  assert.match(stopped.detail, /isn't running/);

  // stopped: backend says Stopped
  cli.put("status.json", { BackendState: "Stopped" });
  assert.equal((await cli.ts().status()).state, "stopped");

  // needs login (and machine approval)
  cli.put("status.json", { BackendState: "NeedsLogin" });
  const nl = await cli.ts().status();
  assert.equal(nl.state, "needs_login");
  assert.match(nl.detail, /not signed in/);
  cli.put("status.json", { BackendState: "NeedsMachineAuth" });
  assert.match((await cli.ts().status()).detail, /approval/);

  // running: address, MagicDNS name (trailing dot removed) and tailnet
  cli.put("status.json", RUNNING);
  const run = await cli.ts().status();
  assert.deepEqual({ state: run.state, ip: run.ip, dnsName: run.dnsName, tailnet: run.tailnet }, { state: "running", ip: "100.101.102.103", dnsName: HOST, tailnet: "blake@example.com" });
  assert.equal(run.funnel.on, false);

  // MagicDNS off: no name, the IP still works
  cli.put("status.json", { ...RUNNING, CurrentTailnet: { Name: "t", MagicDNSEnabled: false } });
  const noDns = await cli.ts().status();
  assert.equal(noDns.dnsName, undefined);
  assert.equal(noDns.ip, "100.101.102.103");
});

test("1.2 AC1: CLI lookup order and 10 second cache", async () => {
  const saved = process.env.AGENT_ROOM_TAILSCALE_BIN;
  try {
    delete process.env.AGENT_ROOM_TAILSCALE_BIN;
    // 1.2 review L4: fixed absolute paths only; a bare "tailscale" is never handed to the OS to look up
    assert.deepEqual(new Tailscale().candidates(), [MAC_APP_CLI, "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"], "the Mac app, then the usual install folders");
    process.env.AGENT_ROOM_TAILSCALE_BIN = "/opt/custom/tailscale";
    assert.deepEqual(new Tailscale().candidates(), ["/opt/custom/tailscale", MAC_APP_CLI, "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"], "the override goes first");
    process.env.AGENT_ROOM_TAILSCALE_BIN = "tailscale";
    assert.deepEqual(new Tailscale().candidates()[0], MAC_APP_CLI, "a relative override is a PATH lookup in disguise and is ignored");
    assert.deepEqual(new Tailscale({ bin: "/x/ts" }).candidates(), ["/x/ts"], "an explicit option is used alone");
  } finally { if (saved === undefined) delete process.env.AGENT_ROOM_TAILSCALE_BIN; else process.env.AGENT_ROOM_TAILSCALE_BIN = saved; }

  // found on PATH, but only when nobody but an administrator can change the file or its folder
  const cli = fakeCli({ status: RUNNING });
  const env = { FAKE_TS_DIR: cli.dir, PATH: `${cli.dir}:${dirname(process.execPath)}` }; const fixedPaths = ["/nonexistent/tailscale"];
  assert.equal((await new Tailscale({ env, fixedPaths, isWritable: () => true }).status()).state, "not_installed", "a PATH entry this user can write is never run");
  assert.equal((await new Tailscale({ env, fixedPaths, isWritable: () => false }).status()).state, "running", "a protected PATH entry is the fallback");
  assert.equal((await new Tailscale({ fixedPaths, env: { ...env, PATH: `relative/bin:${cli.dir}` }, isWritable: (p) => p === cli.dir }).status()).state, "not_installed", "writable folder, relative entry: refused");
  assert.equal((await new Tailscale({ env, fixedPaths, isWritable: (p) => p === cli.bin }).status()).state, "not_installed", "a writable file is refused even in a protected folder");
  assert.ok(!cli.argv().some((a) => a.length === 0));

  // cached: two calls, one CLI run
  const cached = new Tailscale({ bin: cli.bin, env: { FAKE_TS_DIR: cli.dir }, ttlMs: 10_000 });
  await cached.status(); await cached.status();
  assert.equal(cli.argv().filter((a) => a[0] === "status").length >= 1, true);
  const before = cli.argv().filter((a) => a[0] === "status").length;
  await cached.status();
  assert.equal(cli.argv().filter((a) => a[0] === "status").length, before, "served from cache");
  await cached.status(true);
  assert.equal(cli.argv().filter((a) => a[0] === "status").length, before + 1, "fresh=true re-reads");
});

test("1.2 AC1: GET /remote/status needs a paired device and shows the address", async () => {
  const b = await boot();
  assert.equal((await fetch(`${b.base}/remote/status`)).status, 401);
  const s = (await (await fetch(`${b.base}/remote/status`, { headers: b.h })).json()) as RemoteStatus;
  assert.equal(s.state, "running");
  assert.equal(s.host, HOST, "MagicDNS name preferred");
  assert.equal(s.ip, "100.101.102.103");
  assert.equal(s.hubUrl, `http://${HOST}:${b.port}`);
  assert.deepEqual(s.funnel, { on: false, intent: false, extraPaths: [] }, "off by default, nothing extra");
  const setupInfo = (await (await fetch(`${b.base}/setup`, { headers: b.h })).json()) as { phone: { url: string } };
  assert.equal(setupInfo.phone.url, `http://${HOST}:${b.port}`, "pairing screen address is the MagicDNS name");
  await b.app.close();
});

// ---------------------------------------------------------------- AC2: onboarding support

test("1.2 AC2: the hub can open the Tailscale app for sign-in, from the Mac app only", async () => {
  let opened = 0;
  const cli = fakeCli({ status: { BackendState: "NeedsLogin" } });
  const b = await boot(cli, { openApp: async () => { opened++; return { ok: true, message: "Opened Tailscale." }; } });
  assert.equal((await fetch(`${b.base}/remote/open`, { method: "POST" })).status, 401);
  const r = await fetch(`${b.base}/remote/open`, { method: "POST", headers: b.h, body: "{}" });
  assert.deepEqual(await r.json(), { ok: true, message: "Opened Tailscale." });
  assert.equal(opened, 1);
  const proxied = await fetch(`${b.base}/remote/open`, { method: "POST", headers: { ...b.h, ...PROXY }, body: "{}" });
  assert.equal(proxied.status, 404);
  assert.equal(opened, 1);
  const s = (await (await fetch(`${b.base}/remote/status`, { headers: b.h })).json()) as RemoteStatus;
  assert.equal(s.state, "needs_login");
  assert.equal(s.hubUrl, undefined, "no address until it's signed in");
  await b.app.close();
});

test("1.2 AC2: both apps carry the Tailscale step, the Settings card and the phone row", () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const card = src("../../app/src/components/RemoteAccess.tsx");
  assert.match(card, /https:\/\/tailscale\.com\/download\/mac/);
  assert.match(card, /Get Tailscale/);
  assert.match(card, /Check again/);
  assert.match(card, /Open Tailscale to sign in/);
  assert.match(card, /Lets cloud agents like ChatGPT connectors reach this Mac's agent endpoint\. Only \/mcp is exposed and every call needs a token\./);
  assert.match(src("../../app/src/screens/OnboardingScreen.tsx"), /<RemoteAccess/);
  assert.match(src("../../app/src/screens/SettingsScreen.tsx"), /<RemoteAccess funnel/);
  const js = src("../web/app.js");
  assert.match(js, /data-nav="remote"/);
  assert.match(js, /\/remote\/status/);
  assert.match(js, /\/remote\/funnel/);
  assert.doesNotMatch(card + js, /—/, "no em dashes in user-facing copy");
});

// ---------------------------------------------------------------- AC3: reachable over the tailnet

test("1.2 AC3: tailnet interface traffic is still accepted, everything else refused", () => {
  for (const ok of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.0", "100.101.102.103", "100.127.255.255", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::5"]) assert.equal(isAllowedLocalAddress(ok), true, ok);
  for (const no of [undefined, "", "192.168.1.5", "10.0.0.2", "100.63.255.255", "100.128.0.0", "8.8.8.8", "fd7a:115c:a1e1::1", "fe80::1"]) assert.equal(isAllowedLocalAddress(no), false, String(no));
});

test("1.2 AC3: non-proxied local requests behave exactly as before", async () => {
  const b = await boot();
  assert.equal((await fetch(`${b.base}/health`)).status, 200);
  assert.equal((await fetch(`${b.base}/`)).status, 200);
  assert.equal((await fetch(`${b.base}/agents`)).status, 401);
  assert.equal((await fetch(`${b.base}/agents`, { headers: b.h })).status, 200);
  assert.equal((await fetch(`${b.base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000", deviceName: "x" }) })).status, 403);
  assert.equal((await fetch(`${b.base}/pair/local`, { method: "POST", headers: localPairHeaders(b.hubDir), body: "{}" })).status, 200);
  assert.equal((await fetch(`${b.base}/mcp`, { method: "GET" })).status, 405);
  assert.equal((await fetch(`${b.base}/mcp`, { method: "POST", headers: mcpHeaders("nope"), body: JSON.stringify(RPC) })).status, 401);
  // a tailnet peer's request has no proxy headers and a Host that is the MagicDNS name or the IP: not remote
  assert.equal(isRemoteRequest({ headers: { host: `${HOST}:4747` }, socket: { remoteAddress: "100.90.80.70" } }), false);
  assert.equal(isRemoteRequest({ headers: { host: "100.101.102.103:4747" }, socket: { remoteAddress: "100.90.80.70" } }), false);
  assert.equal(isRemoteRequest({ headers: { host: "127.0.0.1:4747" }, socket: { remoteAddress: "127.0.0.1" } }), false);
  // failed auth is never rate limited for local callers
  for (let i = 0; i < 15; i++) assert.equal((await fetch(`${b.base}/mcp`, { method: "POST", headers: mcpHeaders("nope"), body: JSON.stringify(RPC) })).status, 401);
  await b.app.close();
});

// ---------------------------------------------------------------- AC4: Muse and other tailnet agents

test("1.2 AC4: MCP connection text prefers the MagicDNS name, then the tailnet IP, and adds the Funnel address when on", async () => {
  const b = await boot();
  const conn = (await (await fetch(`${b.base}/agents/claude/mcp-connection`, { method: "POST", headers: b.h, body: "{}" })).json()) as McpConnection;
  assert.equal(conn.tailscaleUrl, `http://${HOST}:${b.port}/mcp`);
  assert.equal(conn.tailscaleIpUrl, `http://100.101.102.103:${b.port}/mcp`);
  assert.equal(conn.funnelUrl, undefined);
  const remote = conn.snippets!.find((s) => s.id === "remote")!;
  assert.ok(remote.text.includes(`url: "http://${HOST}:${b.port}/mcp"`));
  assert.ok(conn.snippets!.some((s) => s.id === "remote-ip"));
  assert.ok(!conn.snippets!.some((s) => s.id === "funnel"), "no Funnel snippet while Funnel is off");
  assert.equal(conn.snippets!.find((s) => s.id === "hermes")!.text.includes("127.0.0.1"), true, "local snippets unchanged");

  // MagicDNS off: the IP is the address, and there's no duplicate
  b.put("status.json", { ...RUNNING, CurrentTailnet: { Name: "t", MagicDNSEnabled: false } });
  const ipOnly = (await (await fetch(`${b.base}/agents/claude/mcp-connection/config`, { headers: b.h })).json()) as McpConnection;
  assert.equal(ipOnly.tailscaleUrl, `http://100.101.102.103:${b.port}/mcp`);
  assert.equal(ipOnly.tailscaleIpUrl, undefined);
  b.put("status.json", RUNNING);

  await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: b.h, body: JSON.stringify({ on: true }) });
  const withFunnel = (await (await fetch(`${b.base}/agents/claude/mcp-connection/config`, { headers: b.h })).json()) as McpConnection;
  assert.equal(withFunnel.funnelUrl, `https://${HOST}/mcp`);
  assert.ok(withFunnel.snippets!.find((s) => s.id === "funnel")!.text.includes(`https://${HOST}/mcp`));
  await b.app.close();
});

test("1.2 AC4: an agent on another tailnet device joins over MCP with its key and nothing else", async () => {
  const b = await boot();
  // A tailnet peer connects to the hub directly: no proxy headers.
  const client = new Client({ name: "muse", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${b.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${b.mcpToken}` } } }));
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("wait_for_assignment") && names.includes("submit_result"));
  assert.equal(b.store.listAudit().some((a) => a.action === "mcp.remote"), false, "direct tailnet calls are not 'remote'");
  await client.close(); await b.app.close();
});

// ---------------------------------------------------------------- AC5: Funnel for /mcp only

test("1.2 AC5: enabling Funnel passes exactly the /mcp path and never exposes /", async () => {
  const b = await boot();
  const r = await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: b.h, body: JSON.stringify({ on: true }) });
  assert.equal(r.status, 200);
  const s = (await r.json()) as RemoteStatus;
  assert.equal(s.funnel.on, true);
  assert.equal(s.funnel.url, `https://${HOST}/mcp`);
  assert.equal(s.funnel.intent, true);
  assert.deepEqual(s.funnel.extraPaths, []);
  const calls = b.argv().filter((a) => a[0] === "funnel" && a[1] !== "status");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["funnel", "--bg", "--yes", "--https=443", "--set-path=/mcp", `http://127.0.0.1:${b.port}/mcp`]);
  for (const a of calls[0]) assert.notEqual(a, "/");
  assert.ok(!calls[0].some((a) => /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(a)), "the target always carries the /mcp path");
  assert.ok(!b.argv().some((a) => a.includes("reset")), "never resets the owner's other serve config");
  assert.ok(b.store.listAudit().some((a) => a.action === "remote.funnel.on" && a.actor === "owner"));

  const off = await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: b.h, body: JSON.stringify({ on: false }) });
  const so = (await off.json()) as RemoteStatus;
  assert.equal(so.funnel.on, false);
  assert.equal(so.funnel.intent, false);
  assert.deepEqual(b.argv().filter((a) => a[0] === "funnel" && a.includes("off")).at(-1), ["funnel", "--https=443", "--set-path=/mcp", "off"]);
  assert.ok(b.store.listAudit().some((a) => a.action === "remote.funnel.off"));
  await b.app.close();
});

test("1.2 AC5: Funnel is off by default and the switch needs a paired device", async () => {
  const b = await boot();
  const s = (await (await fetch(`${b.base}/remote/status`, { headers: b.h })).json()) as RemoteStatus;
  assert.equal(s.funnel.on, false);
  assert.equal(s.funnel.intent, false);
  assert.equal((await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) })).status, 401);
  assert.equal((await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: b.h, body: JSON.stringify({ on: "yes" }) })).status, 400);
  assert.ok(!b.argv().some((a) => a[0] === "funnel" && a[1] !== "status"), "nothing was switched");
  await b.app.close();
});

test("1.2 AC5: Funnel refuses to start when the port already serves something else", async () => {
  const cli = fakeCli({ status: RUNNING, serve: { TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } } });
  const b = await boot(cli);
  const r = await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: b.h, body: JSON.stringify({ on: true }) });
  assert.equal(r.status, 409);
  assert.match(((await r.json()) as { error: string }).error, /already serves \//);
  assert.ok(!b.argv().some((a) => a[0] === "funnel" && a.includes("--bg")), "the CLI was never asked to funnel");
  assert.ok(b.store.listAudit().some((a) => a.action === "remote.funnel.failed"));
  assert.equal(b.store.getKV("remote_funnel", false), false);
  await b.app.close();
});

test("1.2 AC5: Funnel that exposes more than /mcp is reported, and a tailnet that hasn't allowed Funnel gets a link", async () => {
  const wide = { TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/mcp": { Proxy: "http://127.0.0.1:4747/mcp" }, "/": { Proxy: "http://127.0.0.1:4747" } } } }, AllowFunnel: { [`${HOST}:443`]: true } };
  assert.deepEqual(readFunnel(wide, 4747), { on: true, url: `https://${HOST}/mcp`, extraPaths: ["/"], wrongTarget: undefined, forwards: [] });
  assert.deepEqual(readFunnel({ Foreground: { s1: wide } }, 4747).extraPaths, ["/"], "a foreground funnel counts too");
  assert.deepEqual(readFunnel({ TCP: { "443": { TCPForward: "127.0.0.1:22" } }, AllowFunnel: { [`${HOST}:443`]: true } }, 4747).extraPaths, ["tcp:443"]);
  assert.deepEqual(readFunnel({}, 4747), { on: false, url: undefined, extraPaths: [], wrongTarget: undefined, forwards: [] });
  assert.deepEqual(readFunnel(null, 4747).on, false);
  assert.deepEqual(pathsOnPort(wide, 443), ["/", "/mcp"]);
  assert.deepEqual(pathsOnPort(wide, 8443), []);

  const cli = fakeCli({ status: RUNNING });
  cli.put("funnel-denied", "1");
  const b = await boot(cli);
  const r = await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: b.h, body: JSON.stringify({ on: true }) });
  assert.equal(r.status, 409);
  const body = (await r.json()) as { error: string; approvalUrl?: string };
  assert.equal(body.approvalUrl, "https://login.tailscale.com/f/funnel?node=nABC123");
  assert.match(body.error, /hasn't allowed Funnel/);
  await b.app.close();
});

test("1.2 AC5: if Tailscale won't turn Funnel off, the owner is told and the drift shows", async () => {
  const cli = fakeCli({ status: RUNNING });
  cli.put("off-fails", "1");
  const b = await boot(cli);
  b.put("serve.json", serveFor(b.port));
  const r = await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: b.h, body: JSON.stringify({ on: false }) });
  assert.equal(r.status, 409);
  const s = (await (await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h })).json()) as RemoteStatus;
  assert.equal(s.funnel.on, true);
  assert.equal(s.funnel.drift, "on_in_tailscale");
  await b.app.close();
});

test("1.2 AC5: drift between Tailscale and the hub is reported, never silently fixed", async () => {
  // Funnel on in Tailscale, hub never asked for it
  const cli = fakeCli({ status: RUNNING });
  const b = await boot(cli);
  b.put("serve.json", serveFor(b.port));
  const check = (b.app as unknown as { remoteCheck: () => Promise<RemoteStatus> }).remoteCheck;
  const s = await check();
  assert.equal(s.funnel.on, true);
  assert.equal(s.funnel.intent, false);
  assert.equal(s.funnel.drift, "on_in_tailscale");
  assert.ok(b.store.listAudit().some((a) => a.action === "remote.funnel.drift" && /on in Tailscale but off in Agent Room/.test(a.detail)));
  await check();
  assert.equal(b.store.listAudit().filter((a) => a.action === "remote.funnel.drift").length, 1, "reported once, not on every check");
  assert.ok(!b.argv().some((a) => a[0] === "funnel" && a[1] !== "status"), "the hub changed nothing");
  assert.equal(b.store.getKV("remote_funnel", false), false, "and didn't adopt Tailscale's state as the owner's wish");

  // Owner wants it on, Tailscale has it off (e.g. someone ran `tailscale funnel reset`)
  b.store.setKV("remote_funnel", true);
  b.put("serve.json", {});
  const s2 = await check();
  assert.equal(s2.funnel.drift, "off_in_tailscale");
  assert.ok(b.store.listAudit().some((a) => a.action === "remote.funnel.drift" && /off in Tailscale but on in Agent Room/.test(a.detail)));
  assert.equal(b.store.getKV("remote_funnel", false), true, "intent is left as the owner set it");
  assert.ok(!b.argv().some((a) => a[0] === "funnel" && a[1] !== "status"));
  await b.app.close();
});

test("1.2 AC5: a proxied request reaches only POST /mcp; everything else is 404, even with a valid device token", async () => {
  const b = await boot();
  const paired = { ...b.h, ...PROXY };
  for (const [method, path] of [
    ["GET", "/agents"], ["GET", "/rooms"], ["POST", "/pair"], ["POST", "/pair/local"], ["GET", "/"], ["GET", "/web/app.js"], ["GET", "/health"],
    ["GET", "/ws"], ["GET", "/ws?token=" + b.token], ["GET", "/remote/status"], ["POST", "/remote/funnel"], ["POST", "/mcp-tokens"], ["GET", "/audit"], ["GET", "/setup"],
    ["POST", "/setup/signin/claude"], ["DELETE", "/mcp"], ["PUT", "/mcp"], ["GET", "/mcp/"], ["POST", "/mcp/extra"], ["POST", "/mcp?x=1/../pair"], ["POST", "/%6dcp"],
  ] as const) {
    const res = await fetch(`${b.base}${path}`, { method, headers: paired, body: method === "GET" ? undefined : "{}" });
    assert.equal(res.status, path === "/mcp?x=1/../pair" ? 401 : 404, `${method} ${path}`);
  }
  // pairing code guess through the proxy never gets counted or answered
  const code = (b.app as unknown as { pairingCode: () => string }).pairingCode();
  const viaProxy = await fetch(`${b.base}/pair`, { method: "POST", headers: { ...PROXY, "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "attacker" }) });
  assert.equal(viaProxy.status, 404);
  assert.equal((b.store.listDevices() as { name: string }[]).some((d) => d.name === "attacker"), false);
  // a websocket upgrade through the proxy
  const wsStatus = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${b.token}`, { headers: PROXY });
    ws.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("error", () => resolve("error"));
  });
  assert.notEqual(wsStatus, "open");
  assert.equal(wsStatus, "404");
  // the same socket without proxy headers still works
  const okWs = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${b.token}`);
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("error", () => resolve("error"));
  });
  assert.equal(okWs, "open");
  // Tailscale's own headers alone mark a request remote
  for (const h of [{ "tailscale-funnel-request": "?1" }, { "tailscale-user-login": "x@y.z" }, { forwarded: "for=203.0.113.7" }] as Record<string, string>[]) {
    assert.equal((await fetch(`${b.base}/agents`, { headers: { ...b.h, ...h } })).status, 404, JSON.stringify(h));
  }
  // and so does the public Host name on a loopback connection, even if a header went missing
  const status = await new Promise<number>((resolve) => {
    const r = request(`${b.base}/pair/local`, { method: "POST", headers: { host: HOST, "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode!); });
    r.end("{}");
  });
  assert.equal(status, 404);
  assert.equal(b.store.listDevices().length, 1, "only the Mac itself is paired");
  await b.app.close();
});

test("1.2 AC5: a proxied POST /mcp with a valid token works and every call is audited", async () => {
  const b = await boot();
  const client = new Client({ name: "chatgpt-connector", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${b.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${b.mcpToken}`, ...PROXY } } }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("read_room"));
  const res = await client.callTool({ name: "read_room", arguments: {} });
  assert.ok(Array.isArray(res.content));
  await client.close();
  const audit = b.store.listAudit().filter((a) => a.action === "mcp.remote");
  assert.ok(audit.length >= 3, "initialize, tools/list and tools/call each logged");
  assert.ok(audit.every((a) => a.actor === "claude" && /agent=claude/.test(a.detail) && /from 203\.0\.113\.7/.test(a.detail)));
  assert.ok(audit.some((a) => /tools\/call:read_room/.test(a.detail)), "tool name recorded");
  assert.ok(audit.some((a) => /tools\/list/.test(a.detail)));
  // GET /mcp through the proxy is the usual 405, unauthenticated
  assert.equal((await fetch(`${b.base}/mcp`, { headers: PROXY })).status, 405);
  // the token itself never lands in the audit log
  assert.ok(!JSON.stringify(b.store.listAudit()).includes(b.mcpToken));
  await b.app.close();
});

test("1.2 AC5: proxied /mcp with a bad token is 401, then 429 after the allowance, even for a correct token", async () => {
  const b = await boot(fakeCli(), { burst: 3 });
  const post = (token: string, ip: string) => fetch(`${b.base}/mcp`, { method: "POST", headers: mcpHeaders(token, { "x-forwarded-for": ip }), body: JSON.stringify(RPC) });
  for (let i = 0; i < 3; i++) assert.equal((await post("wrong", "198.51.100.9")).status, 401, `failure ${i + 1}`);
  assert.equal((await post("wrong", "198.51.100.9")).status, 429);
  assert.equal((await post(b.mcpToken, "198.51.100.9")).status, 429, "a locked-out caller can't confirm a guess");
  assert.equal((await post(b.mcpToken, "198.51.100.10")).status, 200, "another caller is unaffected");
  const denied = b.store.listAudit().filter((a) => a.action === "mcp.remote.denied");
  assert.equal(denied.length, 3, "failures are audited, rate-limited calls are not");
  // rotating the client-supplied first X-Forwarded-For entry doesn't help: the proxy's own (last) entry is the key
  for (let i = 0; i < 3; i++) await post("wrong", `10.0.0.${i}, 198.51.100.50`);
  assert.equal((await post("wrong", "1.2.3.4, 198.51.100.50")).status, 429);
  await b.app.close();
});

test("1.2 AC5: the failed-auth limiter refills over time", () => {
  let t = 0;
  const l = new AuthLimiter(2, 1000, () => t);
  l.fail("a"); l.fail("a");
  assert.equal(l.blocked("a"), true);
  t = 1100;
  assert.equal(l.blocked("a"), false);
  assert.equal(l.blocked("b"), false);
});

test("1.2 AC5: /pair/local refuses a proxied request even when the Mac app's own checks would pass", async () => {
  const b = await boot();
  const before = b.store.listDevices().length;
  const r = await fetch(`${b.base}/pair/local`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify({ deviceName: "Attacker" }) });
  assert.ok([403, 404].includes(r.status));
  assert.equal(b.store.listDevices().length, before);
  await b.app.close();
});

// ================================================================ 1.2 independent security review: fixes

const rawRequest = (url: string, method: string, headers: Record<string, string>, body = "{}") => new Promise<number>((resolve, reject) => {
  const r = request(url, { method, headers, agent: false }, (res) => { res.resume(); resolve(res.statusCode!); }); // no pooled sockets: an upgraded one is closed by the server
  r.on("error", reject);
  r.end(body);
});

// ---- M1
test("1.2 review M1: a TCP forwarder to the hub gets no device token, and a forward aimed at the hub is a loud warning in status and the audit log", async () => {
  const cli = fakeCli({ status: RUNNING });
  const b = await boot(cli);
  // `tailscale funnel --tls-terminated-tcp`, `ssh -L` and `socat` reach the hub from 127.0.0.1 with the caller's own Host and no proxy header:
  // indistinguishable from the Mac app, except that the caller can't read the secret file.
  const before = b.store.listDevices().length;
  const viaForwarder = await fetch(`${b.base}/pair/local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceName: "Attacker" }) });
  assert.equal(viaForwarder.status, 403);
  assert.equal(b.store.listDevices().length, before);

  // Tailscale's serve config has a raw TCP forward to the hub's port, funneled to the internet
  b.put("serve.json", { TCP: { "8443": { TCPForward: `127.0.0.1:${b.port}`, TerminateTLS: HOST } }, AllowFunnel: { [`${HOST}:8443`]: true } });
  const s = (await (await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h })).json()) as RemoteStatus;
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /forwards PUBLIC \(Funnel\) port 8443 straight to this hub \(127\.0\.0\.1:\d+\)/);
  assert.match(s.warnings[0], /treated as local/);
  assert.deepEqual(s.funnel.extraPaths, ["tcp:8443"]);
  await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h });
  assert.equal(b.store.listAudit().filter((a) => a.action === "remote.tcp_forward").length, 1, "audited once, not on every read");

  // the same for the other spellings of "this Mac", and a forward to something else is none of our business
  for (const target of [`localhost:${b.port}`, `[::1]:${b.port}`, `0.0.0.0:${b.port}`]) {
    b.put("serve.json", { TCP: { "9000": { TCPForward: target } } });
    const w = (await (await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h })).json()) as RemoteStatus;
    assert.equal(w.warnings.length, 1, target);
    assert.doesNotMatch(w.warnings[0], /PUBLIC/, "not funneled: tailnet only");
  }
  b.put("serve.json", { TCP: { "9000": { TCPForward: "127.0.0.1:22" }, "9001": { TCPForward: `10.0.0.5:${b.port}` } } });
  assert.deepEqual(((await (await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h })).json()) as RemoteStatus).warnings, []);
  assert.equal(readFunnel({ TCP: { "443": { TCPForward: `127.0.0.1:${b.port}` } } }, b.port).forwards.length, 1);
  assert.equal(readFunnel({ TCP: { "443": { TCPForward: `127.0.0.1:${b.port}` } } }, b.port + 1).forwards.length, 0);
  assert.equal(readFunnel({ Foreground: { s: { TCP: { "1": { TCPForward: `127.0.0.1:${b.port}` } } } } }, b.port).forwards.length, 1, "a foreground serve counts too");
  await b.app.close();
});

// ---- M2
test("1.2 review M2: Funnel is 'on' only when /mcp proxies to this hub; any other target is drift wrong_target and no Funnel address is handed out", async () => {
  const P = 4747;
  const on = (proxy: string) => ({ TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/mcp": { Proxy: proxy } } } }, AllowFunnel: { [`${HOST}:443`]: true } });
  for (const ok of [`http://127.0.0.1:${P}/mcp`, `http://localhost:${P}/mcp`, `http://[::1]:${P}/mcp`, `http://LOCALHOST:${P}/mcp`]) assert.equal(readFunnel(on(ok), P).on, true, ok);
  for (const bad of [`http://127.0.0.1:3000/mcp`, `http://127.0.0.1:${P}/`, `http://127.0.0.1:${P}/mcp/x`, `http://127.0.0.1:${P}/other`, `http://10.0.0.9:${P}/mcp`, `http://evil.example:${P}/mcp`,
    `https://127.0.0.1:${P}/mcp`, `http://127.0.0.1/mcp`, "not a url", `http://127.0.0.1:${P}/mcp?x=1`]) {
    const r = readFunnel(on(bad), P);
    assert.equal(r.on, false, bad);
    assert.equal(r.url, undefined, bad);
    assert.equal(r.wrongTarget, bad, bad);
  }

  const cli = fakeCli({ status: RUNNING });
  const b = await boot(cli);
  b.put("serve.json", serveFor(b.port, "http://127.0.0.1:3000/mcp")); // someone else's service answers on the public /mcp
  const s = (await (await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h })).json()) as RemoteStatus;
  assert.equal(s.funnel.on, false);
  assert.equal(s.funnel.url, undefined);
  assert.equal(s.funnel.drift, "wrong_target");
  assert.equal(s.funnel.wrongTarget, "http://127.0.0.1:3000/mcp");
  assert.ok(b.store.listAudit().some((a) => a.action === "remote.funnel.drift" && /wrong_target/.test(a.detail) && /127\.0\.0\.1:3000/.test(a.detail)));
  // even when the owner asked for Funnel, it never shows as on, and no snippet carries the public address
  b.store.setKV("remote_funnel", true);
  const conn = (await (await fetch(`${b.base}/agents/claude/mcp-connection/config`, { headers: b.h })).json()) as McpConnection;
  assert.equal(conn.funnelUrl, undefined);
  assert.ok(!conn.snippets!.some((x) => x.id === "funnel"));
  assert.ok(!JSON.stringify(conn).includes(`https://${HOST}`));
  assert.equal(((await (await fetch(`${b.base}/remote/status`, { headers: b.h })).json()) as RemoteStatus).funnel.drift, "wrong_target", "not off_in_tailscale");

  // pointed back at this hub, it is on and the address comes back
  b.put("serve.json", serveFor(b.port));
  const back = (await (await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h })).json()) as RemoteStatus;
  assert.equal(back.funnel.on, true);
  assert.equal(back.funnel.drift, undefined);
  assert.equal(back.funnel.wrongTarget, undefined);
  await b.app.close();
});

// ---- L1
test("1.2 review L1: a loopback request that asks for a *.ts.net name is remote, whatever the case, trailing dot or port", async () => {
  const lo = { remoteAddress: "127.0.0.1" };
  for (const host of [HOST, `${HOST}:443`, `${HOST}.`, `${HOST}.:443`, HOST.toUpperCase(), `${HOST.toUpperCase()}.:8443`, "x.ts.net", "X.TS.NET.", ` ${HOST} `]) {
    assert.equal(isRemoteRequest({ headers: { host }, socket: lo }), true, host);
    assert.equal(isRemoteRequest({ headers: { host }, socket: { remoteAddress: "::ffff:127.0.0.1" } }), true, host);
  }
  for (const host of ["127.0.0.1:4747", "localhost", "localhost.:4747", "[::1]:4747", "ts.net.evil.example", "evilts.net", "mac.ts.net.evil.example.", ""]) {
    assert.equal(isRemoteRequest({ headers: { host }, socket: lo }), false, host);
  }
  // a tailnet peer that connects straight to the hub by its MagicDNS name is not proxied
  assert.equal(isRemoteRequest({ headers: { host: `${HOST}.:4747` }, socket: { remoteAddress: "100.90.80.70" } }), false);

  const b = await boot();
  const before = b.store.listDevices().length;
  for (const host of [`${HOST}.`, `${HOST.toUpperCase()}.:443`]) {
    assert.equal(await rawRequest(`${b.base}/pair/local`, "POST", { host, ...localPairHeaders(b.hubDir) }), 404, host);
    assert.equal(await rawRequest(`${b.base}/agents`, "GET", { host, authorization: `Bearer ${b.token}` }, ""), 404, host);
  }
  assert.equal(b.store.listDevices().length, before);
  await b.app.close();
});

test("1.2 review L1: the docs and the guard no longer claim to fail closed, and the real-Mac checklist has the Connection-header probe", () => {
  const doc = readFileSync(new URL("../../../docs/1.2-remote-access.md", import.meta.url), "utf8");
  const guard = readFileSync(new URL("../src/remote/guard.ts", import.meta.url), "utf8");
  assert.doesNotMatch(guard, /fails closed\./i, "the old claim is gone");
  assert.match(guard, /does NOT fail closed/);
  assert.doesNotMatch(doc, /fails closed:/i);
  assert.match(doc, /does not fail closed/i);
  assert.match(doc, /Connection: X-Forwarded-For/);
  assert.match(doc, /local-pair\.secret/);
});

// ---- L2
test("1.2 review L2: a proxied /mcp call can't use an orchestrator task grant, only an external key", async () => {
  const b = await boot();
  b.orch.grants.set("task-grant-token", { agentId: "claude", roomId: b.room.id, expiresAt: Date.now() + 60_000 });
  const call = (extra: Record<string, string>) => fetch(`${b.base}/mcp`, { method: "POST", headers: mcpHeaders("task-grant-token", extra), body: JSON.stringify(RPC) });
  assert.equal((await call({})).status, 200, "the agent the hub started on this Mac still uses it, directly");
  assert.equal((await call(PROXY)).status, 401, "through Funnel it is just a wrong token");
  assert.equal((await call({ "x-agent-room-via": "relay" })).status, 401, "and so is it through the relay");
  assert.ok(b.store.listAudit().some((a) => a.action === "mcp.remote.denied"), "the attempt is audited as a denied remote call");
  assert.equal((await fetch(`${b.base}/mcp`, { method: "POST", headers: mcpHeaders(b.mcpToken, PROXY), body: JSON.stringify(RPC) })).status, 200, "an external key still works remotely");
  await b.app.close();
});

// ---- L3
test("1.2 review L3: a remote lockout is audited once, with the forwarded address and no token", async () => {
  const b = await boot(fakeCli(), { burst: 3 });
  const post = (token: string, ip: string) => fetch(`${b.base}/mcp`, { method: "POST", headers: mcpHeaders(token, { "x-forwarded-for": ip }), body: JSON.stringify(RPC) });
  for (let i = 0; i < 2; i++) await post("secret-guess-aaaa", "198.51.100.9");
  assert.equal(b.store.listAudit().filter((a) => a.action === "mcp.remote.locked_out").length, 0, "not locked out yet");
  assert.equal((await post("secret-guess-aaaa", "198.51.100.9")).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await post("secret-guess-aaaa", "198.51.100.9")).status, 429);
  const out = b.store.listAudit().filter((a) => a.action === "mcp.remote.locked_out");
  assert.equal(out.length, 1, "once per lockout, not once per refused call");
  assert.match(out[0].detail, /198\.51\.100\.9/);
  assert.ok(!JSON.stringify(b.store.listAudit()).includes("secret-guess-aaaa"), "no token anywhere in the log");
  // another caller's lockout is its own
  for (let i = 0; i < 3; i++) await post("x", "198.51.100.10");
  assert.equal(b.store.listAudit().filter((a) => a.action === "mcp.remote.locked_out").length, 2);
  // and the limiter reports the transition exactly once per lockout, including a second one after a refill
  let t = 0;
  const l = new AuthLimiter(2, 1000, () => t);
  assert.equal(l.fail("k"), false); assert.equal(l.fail("k"), true); assert.equal(l.fail("k"), false);
  t = 5000;
  assert.equal(l.fail("k"), false); assert.equal(l.fail("k"), true, "a new lockout after the first one ended");
  await b.app.close();
});

test("1.2 review L3: drift, extra paths and forwards are detected on every fresh read and after switching Funnel, not only at startup", async () => {
  const cli = fakeCli({ status: RUNNING });
  const b = await boot(cli);
  const count = (action: string) => b.store.listAudit().filter((a) => a.action === action).length;
  const withExtra = { ...serveFor(b.port), Web: { [`${HOST}:443`]: { Handlers: { "/mcp": { Proxy: `http://127.0.0.1:${b.port}/mcp` }, "/files": { Proxy: "http://127.0.0.1:9000" } } } } };
  // nothing was checked at startup: the first thing that looks is GET /remote/status?fresh=1
  b.put("serve.json", withExtra);
  await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h });
  assert.equal(count("remote.funnel.extra_paths"), 1);
  assert.equal(count("remote.funnel.drift"), 1, "on in Tailscale, off in Agent Room");
  await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h });
  assert.equal(count("remote.funnel.extra_paths"), 1, "once per change");
  // it goes away and comes back: recorded again
  b.put("serve.json", {});
  await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h });
  b.put("serve.json", serveFor(b.port, "http://127.0.0.1:3000/mcp"));
  await fetch(`${b.base}/remote/status?fresh=1`, { headers: b.h });
  assert.equal(count("remote.funnel.drift"), 2);

  // after POST /remote/funnel: a forward to the hub that was added behind the owner's back shows up in the answer and the audit log
  b.put("serve.json", { TCP: { "8443": { TCPForward: `127.0.0.1:${b.port}` } } });
  const on = await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: b.h, body: JSON.stringify({ on: true }) });
  assert.equal(on.status, 200);
  assert.equal(((await on.json()) as RemoteStatus).warnings.length, 1);
  assert.equal(count("remote.tcp_forward"), 1);
  // and after a switch that fails
  b.put("off-fails", "1");
  b.put("serve.json", withExtra);
  const before = count("remote.funnel.extra_paths");
  const off = await fetch(`${b.base}/remote/funnel`, { method: "POST", headers: b.h, body: JSON.stringify({ on: false }) });
  assert.equal(off.status, 409);
  assert.equal(count("remote.funnel.extra_paths"), before + 1);

  const doc = readFileSync(new URL("../../../docs/1.2-remote-access.md", import.meta.url), "utf8");
  assert.match(doc, /GET \/remote\/status\?fresh=1/);
  assert.match(doc, /mcp\.remote\.locked_out/);
  await b.app.close();
});

// ---- L4
test("1.2 review L4: fixed install paths come first; PATH is used only for entries nobody but an administrator can change", async () => {
  const { resolveBin, pathFallbacks, defaultIsWritable } = await import("../src/remote/bin.js");
  const dir = mkdtempSync(join(tmpdir(), "ar-bin-"));
  const exe = join(dir, "thing"); writeFileSync(exe, "#!/bin/sh\n"); chmodSync(exe, 0o755);
  const fixed = join(mkdtempSync(join(tmpdir(), "ar-fix-")), "thing"); writeFileSync(fixed, "#!/bin/sh\n"); chmodSync(fixed, 0o755);
  assert.equal(resolveBin("thing", [fixed], dir, () => false), fixed, "a fixed path beats PATH");
  assert.equal(resolveBin("thing", ["/nonexistent/thing", fixed], dir, () => false), fixed, "a missing fixed path is skipped");
  assert.equal(resolveBin("thing", ["/nonexistent/thing"], dir, () => false), exe, "PATH fallback when the entry is protected");
  assert.equal(resolveBin("thing", ["/nonexistent/thing"], dir, (p) => p === dir), undefined, "a writable folder is refused");
  assert.equal(resolveBin("thing", ["/nonexistent/thing"], dir, (p) => p === exe), undefined, "a writable file is refused");
  assert.equal(resolveBin("thing", ["relative/thing"], dir, () => true), undefined, "a relative 'fixed' path is not a fixed path");
  assert.deepEqual(pathFallbacks("thing", `:relative:${dir}`, () => false), [exe], "empty and relative PATH entries never count");
  // with the real check, a folder this user can write is never trusted
  assert.equal(defaultIsWritable(dir), true);
  assert.equal(pathFallbacks("thing", dir).length, 0);

  // the hub never asks the OS to search PATH for "tailscale" or "open": every candidate it runs is an absolute path
  const ts = new Tailscale({ env: { PATH: dir } });
  assert.ok(ts.candidates().every((c) => c.startsWith("/")));
  assert.ok(ts.pathCandidates().every((c) => c.startsWith("/")));
  const src = readFileSync(new URL("../src/remote/tailscale.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /runProc\("open"|\["tailscale"/);
  assert.match(src, /resolveBin\("open", \["\/usr\/bin\/open"\]/);
});

// ---- L6
test("1.2 review L6: a proxied request that carries an Upgrade header is 404 before anything handles it", async () => {
  const b = await boot();
  const auth = { authorization: `Bearer ${b.mcpToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const before = b.store.listAudit().filter((a) => a.action === "mcp.remote").length;
  for (const upgrade of [{ upgrade: "websocket", connection: "Upgrade" }, { upgrade: "h2c" }, { upgrade: "websocket" }] as Record<string, string>[]) {
    assert.equal(await rawRequest(`${b.base}/mcp`, "POST", { ...auth, ...PROXY, ...upgrade }, JSON.stringify(RPC)), 404, JSON.stringify(upgrade));
    assert.equal(await rawRequest(`${b.base}/mcp`, "GET", { ...PROXY, ...upgrade }, ""), 404, JSON.stringify(upgrade));
    assert.equal(await rawRequest(`${b.base}/ws?token=${b.token}`, "GET", { ...PROXY, ...upgrade }, ""), 404, JSON.stringify(upgrade));
  }
  assert.equal(b.store.listAudit().filter((a) => a.action === "mcp.remote").length, before, "the MCP handler never ran");
  // the same request without the Upgrade header is the ordinary 200, and a local upgrade still works
  assert.equal(await rawRequest(`${b.base}/mcp`, "POST", { ...auth, ...PROXY }, JSON.stringify(RPC)), 200);
  const okWs = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${b.token}`);
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("error", () => resolve("error"));
  });
  assert.equal(okWs, "open");
  await b.app.close();
});

// ---- Info
test("1.2 review info: control characters in JSON-RPC names can't forge audit lines, and the relay's own header marks a request remote", async () => {
  const { rpcSummary, PROXY_HEADERS, forwardedIp } = await import("../src/remote/guard.js");
  const evil = "tools/call\r\n2026-10-23 owner device.paired Attacker";
  const sum = rpcSummary({ jsonrpc: "2.0", id: 1, method: evil, params: { name: "read_room\n\tremote.funnel.on\u0085\u2028x" } });
  assert.doesNotMatch(sum, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  assert.equal(rpcSummary({ method: "tools/call", params: { name: "a\r\nb" } }), "tools/call:ab");
  assert.equal(forwardedIp({ headers: { "x-forwarded-for": "203.0.113.7\r\nowner x" }, socket: {} }), "203.0.113.7owner x");

  assert.ok(PROXY_HEADERS.includes("x-agent-room-via"));
  assert.equal(isRemoteRequest({ headers: { "x-agent-room-via": "relay" }, socket: { remoteAddress: "127.0.0.1" } }), true);
  const b = await boot();
  assert.equal((await fetch(`${b.base}/agents`, { headers: { ...b.h, "x-agent-room-via": "relay" } })).status, 404);
  const call = await fetch(`${b.base}/mcp`, { method: "POST", headers: mcpHeaders(b.mcpToken, { "x-forwarded-for": "203.0.113.7" }), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_room\r\nFAKE", arguments: {} } }) });
  assert.equal(call.status, 200);
  const line = b.store.listAudit().find((a) => a.action === "mcp.remote" && /tools\/call/.test(a.detail))!;
  assert.ok(!/[\r\n]/.test(line.detail));
  await b.app.close();
});
