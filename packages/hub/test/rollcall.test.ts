// "Orchestrator, have each agent respond to this chat" got one answer (routing picked an agent). A roll call reaches every agent in the room.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { isRollCall } from "../src/orchestrator/contract.js";

const settle = async (ok: () => boolean, ms = 3000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); };

test("roll call: phrasings that ask every agent to answer, and ordinary requests that don't", () => {
  for (const t of ["Orchestrator, have each agent respond to this chat", "everyone introduce yourselves", "@all what do you think?", "All agents, reply with your model name",
    "Ask every one of you to share one idea for the launch", "each of you... no wait, each one of you weigh in", "@everyone check in please"]) assert.equal(isRollCall(t), true, t);
  for (const t of ["Write a report on each agent's strengths", "Build a dashboard that shows every agent", "Draft an email to everyone on the team about Friday",
    "Fix the failing tests", "@codex what do you think?", "`@all` is a string in the code, explain it", `everyone respond ${"x".repeat(400)}`]) assert.equal(isRollCall(t), false, t);
});

test("roll call: every agent in the room answers, one after another, and no goal is planned", async () => {
  const { store, orch, room } = setup();
  const inRoom = store.listAgents().filter((a) => a.enabled).map((a) => a.id);
  await orch.handleOwnerMessage(room.id, "Orchestrator, have each agent respond to this chat");
  const replies = () => store.listMessages(room.id).filter((m) => m.type === "agent" && !m.quiet);
  await settle(() => replies().length >= inRoom.length);
  assert.deepEqual(replies().map((m) => m.author.id), inRoom, "each agent once, in the room's order");
  assert.equal(store.listGoals(room.id).length, 0, "a roll call is a conversation, not a goal");
});

test("roll call: an agent that can't answer is named instead of silently missing", async () => {
  const { store, orch, room } = setup();
  const off = store.listAgents().find((a) => a.enabled)!;
  (orch as unknown as { agentStatus: (a: { id: string }) => Promise<{ ready: boolean }> }).agentStatus = async (a) => ({ ready: a.id !== off.id });
  await orch.handleOwnerMessage(room.id, "@all say hi");
  await settle(() => store.listMessages(room.id).some((m) => m.type === "system" && m.text.includes(off.name)));
  const note = store.listMessages(room.id).find((m) => m.type === "system" && m.text.includes("can't answer right now"));
  assert.ok(note?.text.includes(off.name), "the missing agent is named");
});

test("tagged agents answer in the order tagged, the second seeing the first's reply", async () => {
  const { store, orch, room } = setup();
  await orch.handleOwnerMessage(room.id, "@codex @claude what do you think?");
  const replies = () => store.listMessages(room.id).filter((m) => m.type === "agent" && !m.quiet);
  await settle(() => replies().length >= 2);
  assert.deepEqual(replies().slice(0, 2).map((m) => m.author.id), ["codex", "claude"]);
});
