import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocket } from "ws";
import { startRelay, sha256Hex } from "../src/relay.js";
import { connectTunnel, type TunnelState } from "../../hub/src/relay/tunnel.js";

const SECRET = "s3cret-for-tests";
const HUB = "hub1";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A tiny HTTP server standing in for the hub. */
async function localHub(handler: Handler) {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => { seen.push(req.url ?? ""); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, seen, base: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())); } };
}

function tracked(opts: Parameters<typeof connectTunnel>[0]) {
  const states: { state: TunnelState; detail?: string }[] = [];
  const tunnel = connectTunnel({ minBackoffMs: 30, maxBackoffMs: 100, ...opts, onState: (state, detail) => states.push({ state, detail }) });
  const waitFor = async (want: TunnelState, count = 1) => {
    for (let i = 0; i < 200; i++) {
      if (states.filter((s) => s.state === want).length >= count) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`tunnel never reached ${want} x${count}: ${JSON.stringify(states)}`);
  };
  return { tunnel, states, waitFor };
}

const relayUrl = (port: number) => `ws://127.0.0.1:${port}/hub/connect`;
const hubSecrets = { [HUB]: sha256Hex(SECRET) };

test("hub with the wrong secret, or an unknown id, is refused at the door", async () => {
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1" });
  const refusals: number[] = [];
  const attempt = (headers: Record<string, string>) => new Promise<void>((resolve) => {
    const ws = new WebSocket(relayUrl(relay.port), { headers });
    ws.on("unexpected-response", (_req, res) => { refusals.push(res.statusCode ?? 0); res.resume(); resolve(); });
    ws.on("open", () => { refusals.push(101); ws.close(); resolve(); });
    ws.on("error", () => resolve());
  });
  await attempt({ "x-hub-id": HUB, authorization: "Bearer wrong" });
  await attempt({ "x-hub-id": "stranger", authorization: `Bearer ${SECRET}` });
  await attempt({ "x-hub-id": HUB });
  await attempt({ authorization: `Bearer ${SECRET}` });
  await attempt({ "x-hub-id": "../etc", authorization: `Bearer ${SECRET}` });
  assert.deepEqual(refusals, [401, 401, 401, 401, 401]);

  const t = tracked({ relayUrl: relayUrl(relay.port), hubId: HUB, secret: "wrong", localBase: "http://127.0.0.1:1" });
  await t.waitFor("disconnected");
  assert.match(t.states.find((s) => s.state === "disconnected")!.detail ?? "", /401/);
  assert.equal(t.states.some((s) => s.state === "connected"), false);
  assert.equal((await fetch(`http://127.0.0.1:${relay.port}/h/${HUB}/mcp`)).status, 503);
  t.tunnel.close();
  await relay.close();
});

test("function-style secret check works too", async () => {
  const relay = await startRelay({ port: 0, hubSecrets: (id, secret) => id === "x" && secret === "pw", host: "127.0.0.1" });
  const good = tracked({ relayUrl: relayUrl(relay.port), hubId: "x", secret: "pw", localBase: "http://127.0.0.1:1" });
  await good.waitFor("connected");
  good.tunnel.close();
  await relay.close();
});

test("unknown hub id and no hub connected both give 503; other paths give 404", async () => {
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${relay.port}`;
  assert.equal((await fetch(`${base}/h/${HUB}/mcp`, { method: "POST", body: "{}" })).status, 503);
  assert.equal((await fetch(`${base}/h/nobody/mcp`, { method: "POST", body: "{}" })).status, 503);
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/mcp`)).status, 404);
  assert.equal((await fetch(`${base}/hub/connect`)).status, 404);
  await relay.close();
});

test("only allowlisted paths cross the relay", async () => {
  const hub = await localHub((_req, res) => { res.end("secret stuff"); });
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1" });
  const t = tracked({ relayUrl: relayUrl(relay.port), hubId: HUB, secret: SECRET, localBase: hub.base });
  await t.waitFor("connected");
  const base = `http://127.0.0.1:${relay.port}/h/${HUB}`;
  for (const p of ["/agents", "/rooms", "/mcp/../agents", "/mcp/extra", "//agents", "/%6dcp", "/mcp%2f..%2fagents", "/ws"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, `${p} should be 404`);
    await r.arrayBuffer();
  }
  assert.deepEqual(hub.seen, [], "nothing non-allowlisted reached the hub");
  const ok = await fetch(`${base}/mcp?x=1`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "secret stuff");
  assert.deepEqual(hub.seen, ["/mcp?x=1"]);
  t.tunnel.close();
  await relay.close();
  await hub.close();
});

test("the tunnel enforces its own allowlist even if the relay forwards something else", async () => {
  const hub = await localHub((_req, res) => { res.end("nope"); });
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1", allowPaths: ["/mcp", "/agents"] });
  const t = tracked({ relayUrl: relayUrl(relay.port), hubId: HUB, secret: SECRET, localBase: hub.base });
  await t.waitFor("connected");
  const r = await fetch(`http://127.0.0.1:${relay.port}/h/${HUB}/agents`);
  assert.equal(r.status, 502);
  assert.deepEqual(hub.seen, []);
  t.tunnel.close();
  await relay.close();
  await hub.close();
});

test("streamed responses arrive intact and incrementally; headers and bodies are forwarded", async () => {
  const chunks = [randomBytes(100_000), randomBytes(1), randomBytes(250_000), randomBytes(7)];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let seenHeaders: IncomingMessage["headers"] = {};
  const hub = await localHub(async (req, res) => {
    seenHeaders = req.headers;
    const body: Buffer[] = [];
    for await (const c of req) body.push(c as Buffer);
    res.writeHead(200, { "content-type": "text/event-stream", "x-echo-len": String(Buffer.concat(body).length), "set-cookie": ["a=1", "b=2"] });
    res.write(chunks[0]);
    await gate; // the rest only flows once the client has already seen the first bytes
    res.write(chunks[1]); res.write(chunks[2]);
    res.end(chunks[3]);
  });
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1" });
  const t = tracked({ relayUrl: relayUrl(relay.port), hubId: HUB, secret: SECRET, localBase: hub.base });
  await t.waitFor("connected");

  const payload = randomBytes(300_000);
  const res = await fetch(`http://127.0.0.1:${relay.port}/h/${HUB}/mcp`, {
    method: "POST", body: payload,
    headers: { authorization: "Bearer mcp-token", "content-type": "application/octet-stream", "x-forwarded-for": "6.6.6.6", "x-agent-room-via": "spoof", connection: "keep-alive" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("x-echo-len"), String(payload.length));
  assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2"]);
  const reader = res.body!.getReader();
  const got: Buffer[] = [];
  const first = await reader.read();
  got.push(Buffer.from(first.value!));
  release(); // proves the head and first bytes were delivered before the hub finished
  for (;;) { const { done, value } = await reader.read(); if (done) break; got.push(Buffer.from(value)); }
  assert.ok(Buffer.concat(got).equals(Buffer.concat(chunks)), "body identical");

  assert.equal(seenHeaders.authorization, "Bearer mcp-token", "MCP credentials pass through untouched");
  assert.equal(seenHeaders["x-agent-room-via"], "relay", "client cannot spoof the via marker");
  assert.notEqual(seenHeaders["x-forwarded-for"], "6.6.6.6");
  assert.match(String(seenHeaders["x-forwarded-for"]), /127\.0\.0\.1/);
  assert.equal(seenHeaders.host, `127.0.0.1:${hub.port}`, "host header is the hub's own");
  t.tunnel.close();
  await relay.close();
  await hub.close();
});

test("oversized request bodies are refused with 413 before reaching the hub", async () => {
  const hub = await localHub((_req, res) => { res.end("x"); });
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1", maxBodyBytes: 1000 });
  const t = tracked({ relayUrl: relayUrl(relay.port), hubId: HUB, secret: SECRET, localBase: hub.base });
  await t.waitFor("connected");
  const r = await fetch(`http://127.0.0.1:${relay.port}/h/${HUB}/mcp`, { method: "POST", body: Buffer.alloc(5000) });
  assert.equal(r.status, 413);
  assert.deepEqual(hub.seen, []);
  t.tunnel.close();
  await relay.close();
  await hub.close();
});

test("a client that disconnects cancels the request at the hub", async () => {
  let closed!: () => void;
  const hubSawClose = new Promise<void>((r) => { closed = r; });
  const hub = await localHub((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("first\n");
    res.on("close", () => closed()); // never ends on its own
  });
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1" });
  const t = tracked({ relayUrl: relayUrl(relay.port), hubId: HUB, secret: SECRET, localBase: hub.base });
  await t.waitFor("connected");
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${relay.port}/h/${HUB}/mcp`, { method: "POST", body: "{}", signal: ctl.signal });
  const reader = res.body!.getReader();
  assert.equal(Buffer.from((await reader.read()).value!).toString(), "first\n");
  ctl.abort();
  await Promise.race([hubSawClose, new Promise((_, rej) => setTimeout(() => rej(new Error("cancel never reached the hub")), 3000))]);
  t.tunnel.close();
  await relay.close();
  await hub.close();
});

test("hub reconnects by itself after the relay restarts on the same port", async () => {
  const hub = await localHub((_req, res) => { res.end("still here"); });
  const relay1 = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1" });
  const port = relay1.port;
  const t = tracked({ relayUrl: relayUrl(port), hubId: HUB, secret: SECRET, localBase: hub.base });
  await t.waitFor("connected");
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/h/${HUB}/mcp`)).text(), "still here");

  await relay1.close();
  await t.waitFor("disconnected");
  const relay2 = await startRelay({ port, hubSecrets, host: "127.0.0.1" });
  await t.waitFor("connected", 2);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/h/${HUB}/mcp`)).text(), "still here");
  t.tunnel.close();
  await relay2.close();
  await hub.close();
});

test("a newer connection for the same hub id replaces the old one", async () => {
  const a = await localHub((_req, res) => { res.end("A"); });
  const b = await localHub((_req, res) => { res.end("B"); });
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${relay.port}/h/${HUB}/mcp`;
  const ta = tracked({ relayUrl: relayUrl(relay.port), hubId: HUB, secret: SECRET, localBase: a.base, minBackoffMs: 60_000, maxBackoffMs: 60_000 });
  await ta.waitFor("connected");
  assert.equal(await (await fetch(url)).text(), "A");
  const tb = tracked({ relayUrl: relayUrl(relay.port), hubId: HUB, secret: SECRET, localBase: b.base });
  await tb.waitFor("connected");
  await ta.waitFor("disconnected");
  assert.equal(await (await fetch(url)).text(), "B");
  ta.tunnel.close(); tb.tunnel.close();
  await relay.close();
  await a.close(); await b.close();
});

test("L3: /health is not on the relay's default client-facing allowlist", async () => {
  const hub = await localHub((_req, res) => { res.end("up"); });
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1" });
  const t = tracked({ relayUrl: relayUrl(relay.port), hubId: HUB, secret: SECRET, localBase: hub.base });
  await t.waitFor("connected");
  const r = await fetch(`http://127.0.0.1:${relay.port}/h/${HUB}/health`);
  assert.equal(r.status, 404);
  await r.arrayBuffer();
  assert.deepEqual(hub.seen, []);
  assert.equal((await fetch(`http://127.0.0.1:${relay.port}/h/${HUB}/mcp`)).status, 200, "/mcp still crosses");
  t.tunnel.close();
  await relay.close();
  await hub.close();
});

test("M3: a hub frame with invalid header names or values cannot crash the relay", async () => {
  const relay = await startRelay({ port: 0, hubSecrets, host: "127.0.0.1" });
  const ws = new WebSocket(relayUrl(relay.port), { headers: { "x-hub-id": HUB, authorization: `Bearer ${SECRET}` } });
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  const rogueHeaders: Record<string, unknown>[] = [
    { "bad header": "x", "x-good": "yes" },
    { "x-split": "a\r\nSet-Cookie: pwned=1", "x-good": "yes" },
    { "x-num": 5, "x-obj": { a: 1 }, "x-arr": ["fine", "bad\nvalue"], "x-good": "yes" },
    { "": "empty-name", "x-good": "yes" },
  ];
  let n = 0;
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString()) as { t: string; id: string };
    if (f.t !== "req") return;
    const headers = rogueHeaders[Math.min(n++, rogueHeaders.length - 1)];
    ws.send(JSON.stringify({ t: "head", id: f.id, status: 200, headers }));
    ws.send(JSON.stringify({ t: "data", id: f.id, chunk: Buffer.from("ok").toString("base64") }));
    ws.send(JSON.stringify({ t: "end", id: f.id }));
  });
  const url = `http://127.0.0.1:${relay.port}/h/${HUB}/mcp`;
  for (let i = 0; i < rogueHeaders.length + 1; i++) {
    const r = await fetch(url);
    assert.ok(r.status === 200 || r.status === 502, `request ${i}: status ${r.status}`);
    if (r.status === 200) {
      assert.equal(await r.text(), "ok");
      assert.equal(r.headers.get("x-good"), "yes", "valid headers still pass");
      assert.equal(r.headers.get("set-cookie"), null, "an injected header never reaches the client");
      assert.equal(r.headers.get("x-split"), null);
      assert.equal(r.headers.get("x-num"), null);
    } else await r.arrayBuffer();
  }
  ws.close();
  await relay.close();
});
