// "@all" gave doubled replies: Codex posted with the MCP tool and its final answer was posted too; Hermes posted twice. One turn, one reply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { ReplyTurns } from "../src/turns/turns.js";

const settle = async (ok: () => boolean, ms = 3000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); };
type Call = (agent: { id: string }, prompt: string, o: { roomId?: string }) => Promise<{ ok: boolean; text: string; error?: string; durationMs: number }>;

/** Agents that post with the MCP tool while answering: `posts` says what each one posts (and whether it names the room) before its final answer. */
function agentsThatPost(ctx: ReturnType<typeof setup>, posts: Record<string, { texts: string[]; noRoom?: boolean }>, results: string[] = []) {
  const o = ctx.orch as unknown as { call: Call; agentPost: (g: unknown, t: string, r?: string) => { ok: boolean; why?: string } };
  o.call = async (agent, _p, opts) => {
    const plan = posts[agent.id] ?? { texts: [] };
    for (const t of plan.texts) results.push(JSON.stringify(o.agentPost({ agentId: agent.id, expiresAt: Date.now() + 60_000 }, t, plan.noRoom ? undefined : opts.roomId)));
    return { ok: true, text: plan.texts[0] ?? `${agent.id} here.`, durationMs: 1 };
  };
  return results;
}
const replies = (ctx: ReturnType<typeof setup>) => ctx.store.listMessages(ctx.room.id).filter((m) => m.type === "agent" && !m.quiet);

test("an agent that posts its reply with the MCP tool isn't posted a second time from its final answer", async () => {
  const ctx = setup();
  agentsThatPost(ctx, { codex: { texts: ["Codex here, responding. This is my one reply."] } });
  await ctx.orch.handleOwnerMessage(ctx.room.id, "@codex say hi");
  await settle(() => replies(ctx).length >= 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(replies(ctx).map((m) => m.author.id), ["codex"]);
  const [turn] = ctx.orch.turns.list(ctx.room.id);
  assert.equal(turn.status, "answered");
  assert.equal(turn.via, "post");
});

test("a second post in the same turn is kept out, counted, and the agent is told why", async () => {
  const ctx = setup();
  const results = agentsThatPost(ctx, { hermes: { texts: ["Hermes here, responding once.", "Hermes here, responding once. (again)"] } });
  await ctx.orch.handleOwnerMessage(ctx.room.id, "@hermes say hi");
  await settle(() => ctx.orch.turns.list(ctx.room.id)[0]?.status === "answered");
  assert.equal(replies(ctx).length, 1);
  assert.equal(JSON.parse(results[1]).ok, false);
  assert.match(JSON.parse(results[1]).why, /already in the room/);
  assert.equal(ctx.orch.turns.list(ctx.room.id)[0].dropped, 1);
});

test("a post that names no room lands in the room the agent is answering in", async () => {
  const ctx = setup();
  agentsThatPost(ctx, { hermes: { texts: ["Hermes here."], noRoom: true } });
  await ctx.orch.handleOwnerMessage(ctx.room.id, "@hermes say hi");
  await settle(() => replies(ctx).length >= 1);
  assert.equal(replies(ctx)[0]?.author.id, "hermes");
  assert.equal(replies(ctx).length, 1);
});

test("roll call: each agent answers once even when several post with the tool, and the orchestrator tallies it", async () => {
  const ctx = setup();
  const ids = ctx.store.listAgents().filter((a) => a.enabled).map((a) => a.id);
  agentsThatPost(ctx, Object.fromEntries(ids.map((id, i) => [id, { texts: i % 2 ? [`${id} here.`, `${id} here.`] : [] }])));
  await ctx.orch.handleOwnerMessage(ctx.room.id, "@all say hi");
  await settle(() => ctx.store.listMessages(ctx.room.id).some((m) => m.text.startsWith("Roll call:")));
  assert.deepEqual(replies(ctx).map((m) => m.author.id), ids, "one reply each, in order");
  const tally = ctx.store.listMessages(ctx.room.id).find((m) => m.text.startsWith("Roll call:"))!;
  assert.match(tally.text, new RegExp(`${ids.length} of ${ids.length} answered`));
  if (ids.length > 1) assert.match(tally.text, /repeat posts? kept out/);
  assert.equal(ctx.orch.turns.list(ctx.room.id).length, ids.length);
});

test("one message never asks the same agent twice", () => {
  const ctx = setup();
  const turns = new ReplyTurns(ctx.store);
  const t = turns.start(ctx.room.id, "claude", "rollcall", "msg_1")!;
  assert.ok(t);
  assert.equal(turns.start(ctx.room.id, "claude", "tag", "msg_1"), undefined, "while open");
  turns.end(t, "answered");
  assert.equal(new ReplyTurns(ctx.store).start(ctx.room.id, "claude", "tag", "msg_1"), undefined, "after it ended, even after a restart");
  assert.ok(turns.start(ctx.room.id, "claude", "tag", "msg_2"), "a new message is a new turn");
});

test("GET /rooms/:id/turns lists the room's turns", async (t) => {
  const { buildServer } = await import("../src/api/server.js");
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  agentsThatPost(ctx, {});
  await ctx.orch.handleOwnerMessage(ctx.room.id, "@codex hi");
  await settle(() => ctx.orch.turns.list(ctx.room.id)[0]?.status === "answered");
  const res = await fetch(`${base}/rooms/${ctx.room.id}/turns`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { turns: { agentId: string; status: string; via: string }[] };
  assert.deepEqual([body.turns[0].agentId, body.turns[0].status, body.turns[0].via], ["codex", "answered", "answer"]);
  assert.equal((await fetch(`${base}/rooms/${ctx.room.id}/turns`)).status, 401, "owner only");
});
