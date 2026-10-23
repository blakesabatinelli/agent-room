import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/api/server.js";
import { connectTunnel } from "../src/relay/tunnel.js";
import { startRelay, sha256Hex } from "../../relay/src/relay.js";
import { setup } from "./helpers.js";

const HUB_ID = "blakes-mac";
const SECRET = "tunnel-secret-for-tests";

/** Real hub on loopback, real relay on another port, hub tunnelled out to the relay. */
async function bootRelayed() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const hubBase = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token: deviceToken } = (await (await fetch(`${hubBase}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  const mk = await fetch(`${hubBase}/mcp-tokens`, { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: "claude", name: "Claude" }) });
  const mcpToken = ((await mk.json()) as { token: string }).token;

  const relay = await startRelay({ port: 0, host: "127.0.0.1", hubSecrets: { [HUB_ID]: sha256Hex(SECRET) } });
  let connected!: () => void;
  const up = new Promise<void>((r) => { connected = r; });
  const tunnel = connectTunnel({
    relayUrl: `ws://127.0.0.1:${relay.port}/hub/connect`, hubId: HUB_ID, secret: SECRET, localBase: hubBase,
    onState: (s) => { if (s === "connected") connected(); },
  });
  await up;
  const relayBase = `http://127.0.0.1:${relay.port}/h/${HUB_ID}`;
  const client = (base: string, token: string) => {
    const c = new Client({ name: "cloud-agent", version: "1" });
    return { c, connect: () => c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })) };
  };
  const stop = async () => { tunnel.close(); await relay.close(); await app.close(); };
  return { ...ctx, hubBase, relayBase, deviceToken, mcpToken, client, stop };
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]).text;

test("a cloud MCP client lists tools and calls read_room through the relay", async () => {
  const { relayBase, mcpToken, client, room, store, stop } = await bootRelayed();
  store.addMessage({ roomId: room.id, author: { kind: "human", id: "owner", name: "Blake" }, type: "human", text: "hello via relay", mentions: [] });
  const { c, connect } = client(relayBase, mcpToken);
  await connect();
  const tools = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("read_room") && tools.includes("post_message"));
  const out = await c.callTool({ name: "read_room", arguments: { roomId: room.id } });
  assert.match(textOf(out), /hello via relay/);
  await c.close();
  await stop();
});

test("the hub still authenticates every call: a bad MCP token is refused through the relay", async () => {
  const { relayBase, client, stop } = await bootRelayed();
  const { connect } = client(relayBase, "not-a-real-token");
  await assert.rejects(connect(), /401|Unauthorized|Invalid MCP token/i);
  const raw = await fetch(`${relayBase}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
  assert.equal(raw.status, 401, "the hub's own 401 comes back through the tunnel");
  const none = await fetch(`${relayBase}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(none.status, 401);
  await stop();
});

test("the rest of the hub API is not reachable through the relay, even with a valid device token", async () => {
  const { relayBase, deviceToken, hubBase, stop } = await bootRelayed();
  // Control: the token is good when talking to the hub directly.
  assert.equal((await fetch(`${hubBase}/agents`, { headers: { authorization: `Bearer ${deviceToken}` } })).status, 200);
  for (const path of ["/agents", "/rooms", "/mcp-tokens", "/pair", "/setup", "/ws"]) {
    const r = await fetch(`${relayBase}${path}`, { method: path === "/mcp-tokens" || path === "/pair" ? "POST" : "GET", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: path === "/mcp-tokens" || path === "/pair" ? "{}" : undefined });
    assert.equal(r.status, 404, `${path} must be 404 at the relay`);
    assert.deepEqual(await r.json(), { error: "Not found." });
  }
  assert.equal((await fetch(`${relayBase}/health`)).status, 200);
  await stop();
});

test("latency: read_room direct vs through the relay (localhost, median of 20)", async () => {
  const { hubBase, relayBase, mcpToken, client, room, stop } = await bootRelayed();
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const time = async (base: string) => {
    const { c, connect } = client(base, mcpToken);
    await connect();
    for (let i = 0; i < 5; i++) await c.callTool({ name: "read_room", arguments: { roomId: room.id } });
    const ms: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await c.callTool({ name: "read_room", arguments: { roomId: room.id } });
      ms.push(performance.now() - t0);
    }
    await c.close();
    return median(ms);
  };
  const direct = await time(hubBase);
  const relayed = await time(relayBase);
  console.log(`# read_room median of 20: direct ${direct.toFixed(2)} ms, via relay ${relayed.toFixed(2)} ms (+${(relayed - direct).toFixed(2)} ms)`);
  assert.ok(relayed < 1000, "relay round trip stays sane on localhost");
  await stop();
});
