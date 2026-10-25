import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "@agent-room/shared";
import { setup } from "./helpers.js";
import { MockAdapter } from "../src/adapters/mock.js";

// ---- FIX 2 integration: the judge is shown the whole deliverable, including evidence past the old 6000-char cut.

test("the judge sees the whole deliverable, including content past char 6000, and accepts it", async () => {
  MockAdapter.calls.length = 0; MockAdapter.transientSeen.clear();
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) store.saveAgent({ ...a, settings: { ...a.settings, bigFile: { path: "report.md", marker: "LATE_CRITERION_EVIDENCE", size: 8000 } } } as AgentConfig);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");

  assert.equal(goal.status, "done", "the goal finishes rather than looping on a deliverable the judge couldn't fully see");
  const judgeSawTheEnd = MockAdapter.calls.some((c) => c.kind === "JUDGE" && c.prompt.includes("LATE_CRITERION_EVIDENCE"));
  assert.ok(judgeSawTheEnd, "the reviewer's prompt contains the deliverable content that sat past the old 6000-char cap");
});

// ---- FIX 3: an unreadable reviewer reply is the judge's fault, never the worker's. Rotate once, then fall back or park.

test("an unreadable judge reply rotates to a second reviewer and does not burn the worker's attempt", async () => {
  MockAdapter.calls.length = 0; MockAdapter.transientSeen.clear();
  const { store, orch, room } = setup();
  // every reviewer's own reply is unreadable; the workers still report their own PASS, so the task is decided on that, not sent back.
  for (const a of store.listAgents()) store.saveAgent({ ...a, settings: { ...a.settings, badJudge: true } } as AgentConfig);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");

  assert.equal(goal.status, "done", "an unreadable reviewer never causes an infinite revise loop");
  const tasks = store.listTasks({ goalId: goal.id });
  const a = tasks.find((t) => t.title === "Research the topic")!;
  assert.equal(a.status, "done");
  assert.equal(a.attempts, 1, "the judge's unreadability did not spend the worker's attempt");
  const judges = new Set(MockAdapter.calls.filter((c) => c.kind === "JUDGE").map((c) => c.agentId));
  assert.ok(judges.size >= 2, "a second reviewer was tried after the first came back unreadable");
  assert.ok(store.listAudit().some((e) => e.action === "judge.unreadable"), "the unreadable review is recorded for Issues/Trace");
});

test("when nothing can be judged and no reviewer is readable, the task waits for the owner instead of looping", async () => {
  MockAdapter.calls.length = 0; MockAdapter.transientSeen.clear();
  const { store, orch, room } = setup();
  // no reviewer is readable AND the worker files no STATUS block, so there is nothing mechanical to decide on.
  for (const a of store.listAgents()) store.saveAgent({ ...a, settings: { ...a.settings, badJudge: true, noReport: true } } as AgentConfig);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");

  assert.equal(goal.status, "paused", "the goal waits on the owner rather than spinning");
  const a = store.listTasks({ goalId: goal.id }).find((t) => t.title === "Research the topic")!;
  assert.equal(a.status, "waiting", "the task is parked for the owner");
  assert.equal(a.attempts, 0, "no attempt was spent on the judge's unreadability");
  assert.ok(store.listMessages(room.id).some((m) => m.text.includes("Couldn't get a readable review")), "one plain line tells the owner");
});
