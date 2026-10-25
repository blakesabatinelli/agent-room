import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "@agent-room/shared";
import { setup } from "./helpers.js";
import { Deferrer } from "../src/orchestrator/defer.js";

// Speed: work off the streaming path. Posting the agent's words to the room must not be behind the non-critical
// bookkeeping (memory harvest, tag routing, status writes). Those are deferred to run after the post.

test("Deferrer: work runs after the current synchronous stack, in order, and a throw is swallowed", async () => {
  const log: string[] = [];
  const d = new Deferrer(undefined, (label) => log.push(`ran:${label}`));
  d.after("a", () => log.push("a"));
  d.after("boom", () => { throw new Error("should not escape"); });
  d.after("b", () => log.push("b"));
  log.push("sync-done");
  await Promise.resolve(); // let the microtasks flush
  assert.deepEqual(log, ["sync-done", "a", "ran:a", "ran:boom", "b", "ran:b"], "deferred work runs after the sync stack, in order, and the throw did not stop the rest");
});

test("Deferrer: an injected scheduler collects work instead of running it", () => {
  const queue: (() => void)[] = [];
  const d = new Deferrer((fn) => queue.push(fn));
  let ran = false;
  d.after("x", () => { ran = true; });
  assert.equal(ran, false, "nothing ran yet");
  assert.equal(queue.length, 1);
  queue[0]();
  assert.equal(ran, true);
});

test("a reply's room post is created before the deferred bookkeeping runs; nothing is dropped", async () => {
  const queue: (() => void)[] = [];
  const ran: string[] = [];
  // Collect deferred work instead of running it, so we can inspect the room before the bookkeeping fires.
  const ctx = setup({ defer: (fn) => queue.push(fn), onDefer: (label) => ran.push(label) });
  const agent = ctx.store.getAgent("claude") as AgentConfig;
  const before = ctx.store.listMessages(ctx.room.id).length;
  await (ctx.orch as unknown as { reply: (...a: unknown[]) => Promise<string | undefined> })
    .reply(ctx.room.id, agent, { from: "owner", text: "say hello", hop: 0, turn: { kind: "owner", triggerId: "m0" } });

  const agentPost = ctx.store.listMessages(ctx.room.id).find((m) => m.author.kind === "agent");
  assert.ok(agentPost, "the agent's words are already in the room");
  assert.ok(ctx.store.listMessages(ctx.room.id).length > before);
  // The harvest and tag routing were deferred, not run inline before the post.
  assert.ok(queue.length >= 1, "bookkeeping was deferred");
  assert.equal(ran.length, 0, "and has not run yet");
  // Flushing runs the deferred work (nothing was dropped).
  for (const fn of queue.splice(0)) fn();
  assert.ok(ran.length >= 1, "the deferred bookkeeping ran once flushed");
});
