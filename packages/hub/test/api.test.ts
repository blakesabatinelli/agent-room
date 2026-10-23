import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/api/server.js";
import { setup } from "./helpers.js";

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  return { ...ctx, app, base, code };
}

test("pairing, auth and owner messages", async () => {
  const { app, base, code, room, store } = await boot();
  assert.equal((await fetch(`${base}/agents`)).status, 401);
  const bad = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000", deviceName: "x" }) });
  assert.equal(bad.status, 403);
  const ok = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await ok.json()) as { token: string };
  const reuse = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "x" }) });
  assert.equal(reuse.status, 403, "code is one-time");
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal(((await (await fetch(`${base}/agents`, { headers: h })).json()) as unknown[]).length, 3);

  const t = await fetch(`${base}/agents/claude/tools`, { method: "PUT", headers: h, body: JSON.stringify({ gmail: true }) });
  assert.equal(((await t.json()) as { tools: Record<string, boolean> }).tools.gmail, true);

  await fetch(`${base}/rooms/${room.id}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "Write a two line poem about bars" }) });
  for (let i = 0; i < 50 && store.listGoals(room.id)[0]?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.listGoals(room.id)[0].status, "done");
  await app.close();
});

test("MCP server: external app reads the room and needs approval", async () => {
  const { app, base, code, room, store, approvals, orch } = await boot();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await pr.json()) as { token: string };
  const tk = await fetch(`${base}/mcp-tokens`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: "claude", name: "Claude" }) });
  const mcpToken = ((await tk.json()) as { token: string }).token;

  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["read_room", "post_message", "read_memory", "propose_memory", "list_tasks", "update_task", "request_approval", "approval_prompt"]) assert.ok(tools.includes(n), n);

  for (const n of ["ask_agent", "wait_for_assignment", "submit_result"]) assert.ok(tools.includes(n), n);

  // Uninvited: an external agent can't jump into the room.
  const refused = await client.callTool({ name: "post_message", arguments: { text: "I'll take this one!", roomId: room.id } });
  assert.match((refused.content as { text: string }[])[0].text, /NOT POSTED/);
  assert.ok(!store.listMessages(room.id).some((m) => m.text.includes("I'll take this one")));

  // Once it's been tagged it has the floor.
  orch.floor.give("claude", room.id);
  await client.callTool({ name: "post_message", arguments: { text: "hello from MCP", roomId: room.id } });
  assert.equal(store.listMessages(room.id).at(-1)!.text, "hello from MCP");

  const denied = await client.callTool({ name: "request_approval", arguments: { tool: "gmail", action: "send", detail: "x" } });
  assert.match((denied.content as { text: string }[])[0].text, /switched off/);

  const a = store.getAgent("claude")!; a.tools.gmail = true; store.saveAgent(a);
  const call = client.callTool({ name: "request_approval", arguments: { tool: "gmail", action: "send", detail: "x" } });
  for (let i = 0; i < 40 && !store.listApprovals("pending").length; i++) await new Promise((r) => setTimeout(r, 25));
  approvals.decide(store.listApprovals("pending")[0].id, "approved");
  assert.match(((await call).content as { text: string }[])[0].text, /APPROVED/);

  const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
  assert.equal(bad.status, 401);
  await client.close();
  await app.close();
});

test("Mac app pairs itself locally; browsers can't", async () => {
  const { app, base } = await boot();
  const fromBrowser = await fetch(`${base}/pair/local`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(fromBrowser.status, 403);
  const { request } = await import("node:http");
  const reboundStatus = await new Promise<number>((resolve) => {
    const r = request(`${base}/pair/local`, { method: "POST", headers: { host: "evil.example", "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode!); });
    r.end("{}");
  });
  assert.equal(reboundStatus, 403, "DNS-rebinding Host header rejected");
  const ok = await fetch(`${base}/pair/local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceName: "Mac" }) });
  const { token } = (await ok.json()) as { token: string };
  const setup = (await (await fetch(`${base}/setup`, { headers: { authorization: `Bearer ${token}` } })).json()) as { agents: unknown[]; phone: { code: string }; onboarded: boolean };
  assert.equal(setup.agents.length, 3);
  assert.match(setup.phone.code, /^\d{6}$/);
  assert.equal(setup.onboarded, false);
  await app.close();
});

test("practice mode runs real-agent configs on mock agents", async () => {
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) { a.adapter = "claude-code"; a.settings = { binary: "/nonexistent/claude" }; store.saveAgent(a); }
  store.setKV("practice_mode", true);
  const g = await orch.runGoal(room.id, "practice");
  assert.equal(g.status, "done");
});

test("channels, DMs, and MCP connection snippets", async () => {
  const { app, base, code, store } = await boot();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const ch = (await (await fetch(`${base}/rooms`, { method: "POST", headers: h, body: JSON.stringify({ name: "Board Prep" }) })).json()) as { id: string; name: string };
  assert.equal(ch.name, "board-prep");
  const dm1 = (await (await fetch(`${base}/rooms/dm/claude`, { method: "POST", headers: { authorization: h.authorization } })).json()) as { id: string; dmAgentId: string };
  const dm2 = (await (await fetch(`${base}/rooms/dm/claude`, { method: "POST", headers: { authorization: h.authorization } })).json()) as { id: string };
  assert.equal(dm1.dmAgentId, "claude"); assert.equal(dm1.id, dm2.id);
  const conn = (await (await fetch(`${base}/agents/hermes/mcp-connection`, { method: "POST", headers: { authorization: h.authorization } })).json()) as { snippets: { id: string; text: string }[]; token: string };
  const hermes = conn.snippets.find((s) => s.id === "hermes")!;
  assert.ok(hermes.text.includes("mcp_servers:") && hermes.text.includes(conn.token));
  assert.equal((await fetch(`${base}/rooms/${ch.id}`, { method: "DELETE", headers: { authorization: h.authorization } })).status, 200);
  assert.ok(!store.getRoom(ch.id));
  await app.close();
});

test("plan approval, shared files and agent profiles over the API", async () => {
  const { app, base, code, room, store } = await boot();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await pr.json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const prof = await fetch(`${base}/agents/claude`, { method: "PUT", headers: h, body: JSON.stringify({ profiles: [{ id: "lead", label: "Opus 5.5 · medium", role: "worker", model: "claude-opus-5-5", effort: "medium", tier: 3 }] }) });
  assert.equal(prof.status, 200);
  assert.equal(store.getAgent("claude")!.profiles![0].effort, "medium");
  const bad = await fetch(`${base}/agents/claude`, { method: "PUT", headers: h, body: JSON.stringify({ profiles: [{ id: "x", label: "x", role: "boss", tier: 9 }] }) });
  assert.equal(bad.status >= 400, true, "invalid profiles are rejected");

  await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ planApproval: "always" }) });
  await fetch(`${base}/rooms/${room.id}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "Summarize the venue TV market" }) });
  for (let i = 0; i < 100 && store.listGoals(room.id)[0]?.status !== "awaiting_approval"; i++) await new Promise((r) => setTimeout(r, 20));
  const goal = store.listGoals(room.id)[0];
  const noText = await fetch(`${base}/goals/${goal.id}/plan`, { method: "POST", headers: h, body: JSON.stringify({ decision: "revise" }) });
  assert.equal(noText.status, 400);
  const ok = await fetch(`${base}/goals/${goal.id}/plan`, { method: "POST", headers: h, body: JSON.stringify({ decision: "approve" }) });
  assert.equal(ok.status, 200);
  const again = await fetch(`${base}/goals/${goal.id}/plan`, { method: "POST", headers: h, body: JSON.stringify({ decision: "approve" }) });
  assert.equal(again.status, 409, "a plan can only be decided once");
  const files = await (await fetch(`${base}/goals/${goal.id}/files`, { headers: h })).json() as { folder: string; files: string[] };
  assert.ok(files.folder?.includes(goal.id));
  for (let i = 0; i < 200 && store.getGoal(goal.id)?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
  await app.close();
});

test("MCP keys for Hermes and Muse survive a hub restart and only change on request", async () => {
  const first = await boot();
  const pair = async (b: string, code: string) => ((await (await fetch(`${b}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string }).token;
  let auth = { authorization: `Bearer ${await pair(first.base, first.code)}`, "content-type": "application/json" };
  const post = async (b: string, body: unknown) => (await (await fetch(`${b}/agents/hermes/mcp-connection`, { method: "POST", headers: auth, body: JSON.stringify(body) })).json()) as { token: string; instructions: string };
  const tools = async (b: string, key: string) => (await fetch(`${b}/mcp`, { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;

  const made = await post(first.base, {});
  assert.equal((await post(first.base, {})).token, made.token, "asking again returns the same key");
  await first.app.close();

  // Restart: new server on the same database.
  const app = await buildServer({ ...first, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  auth = { authorization: auth.authorization, "content-type": "application/json" }; // paired device survives too
  const shown = (await (await fetch(`${base}/agents/hermes/mcp-connection/config`, { headers: auth })).json()) as { token: string; tokenHidden?: boolean; instructions: string };
  // 1.1: only a hash of the key is stored, so after a restart the key works but can't be shown again.
  assert.equal(shown.token, "", "the key itself is not kept");
  assert.equal(shown.tokenHidden, true);
  assert.ok(shown.instructions.includes("get_updates"));
  assert.equal(await tools(base, made.token), 200, "old key still works after restart");
  const again = (await (await fetch(`${base}/agents/hermes/mcp-connection`, { method: "POST", headers: auth, body: "{}" })).json()) as { token: string };
  assert.equal(again.token, "", "asking again after a restart does not make a new key");
  assert.equal(await tools(base, made.token), 200, "and does not retire the old one");

  const rotated = await post(base, { rotate: true });
  assert.notEqual(rotated.token, made.token);
  assert.equal(await tools(base, made.token), 401, "old key stops working after a deliberate rotate");
  assert.equal(await tools(base, rotated.token), 200);
  assert.equal((await fetch(`${base}/agents/muse/mcp-connection/config`, { headers: auth })).status, 404);
  await app.close();
});

test("phone web app is served without a token, but the API behind it still needs pairing", async () => {
  const { app, base, code } = await boot();
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(await page.text(), /Agent Room/);
  for (const f of ["app.js", "app.css", "manifest.webmanifest", "icon-180.png"]) assert.equal((await fetch(`${base}/web/${f}`)).status, 200, f);
  for (const bad of ["../src/main.ts", "..%2Fsrc%2Fmain.ts", "__proto__", "constructor", "nope.js"]) {
    const res = await fetch(`${base}/web/${bad}`);
    assert.ok(res.status === 404 || res.status === 401, `${bad} -> ${res.status}`);
    assert.doesNotMatch(await res.text(), /import |buildServer/, `${bad} must not leak source`);
  }
  assert.equal((await fetch(`${base}/rooms`)).status, 401, "API still locked");

  // The flow the page runs: pair with the code, then read rooms and open the live socket with the token.
  const r = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "iPhone" }) });
  const { token } = (await r.json()) as { token: string };
  assert.equal((await fetch(`${base}/rooms`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  await app.close();
});

test("auto-approve setting and shared read marks over the API", async () => {
  const { app, base, code, room } = await boot();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const ok = await fetch(`${base}/agents/claude/auto-approve`, { method: "PUT", headers: h, body: JSON.stringify({ shell: true }) });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { autoApprove: Record<string, boolean> }).autoApprove.shell, true);
  assert.equal((await fetch(`${base}/agents/claude/auto-approve`, { method: "PUT", headers: h, body: JSON.stringify({ web: true }) })).status, 400, "only tools that ask can be auto-approved");

  const put = async (at: number) => ((await (await fetch(`${base}/rooms/${room.id}/read`, { method: "PUT", headers: h, body: JSON.stringify({ at }) })).json()) as { at: number }).at;
  assert.equal(await put(1000), 1000);
  assert.equal(await put(500), 1000, "read marks never move backwards");
  assert.equal(((await (await fetch(`${base}/rooms/${room.id}/read`, { headers: h })).json()) as { at: number }).at, 1000);
  assert.equal(((await (await fetch(`${base}/rooms/read`, { headers: h })).json()) as Record<string, number>)[room.id], 1000);
  await app.close();
});
