import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@agent-room/shared";
import { setup } from "./helpers.js";
import { isProviderRefusal } from "../src/orchestrator/failures.js";
import { readDeliverables } from "../src/orchestrator/ledger.js";
import { MockAdapter } from "../src/adapters/mock.js";

// ---- FIX 1 unit: a provider's own safety/policy refusal, told apart from placement / rate limits / ordinary errors.

test("isProviderRefusal matches a model provider's own refusal, not placement, rate limits or ordinary errors", () => {
  // real and near-real provider refusals
  assert.ok(isProviderRefusal("API Error: Opus 4.8's safeguards flagged this message. Our intentionally broad safeguards sometimes flag content."));
  assert.ok(isProviderRefusal("Our intentionally broad safeguards sometimes flag content unnecessarily."));
  assert.ok(isProviderRefusal("This request was flagged by our usage policies and cannot be completed."));
  assert.ok(isProviderRefusal("I'm sorry, but I can't help with that request."));
  assert.ok(isProviderRefusal("I cannot assist with this task as it violates our content policy."));

  // must NOT match a placement block (handled elsewhere) ...
  assert.ok(!isProviderRefusal("Blocked. /tmp/research cannot be created in this environment"));
  assert.ok(!isProviderRefusal("I can't complete this task from my environment; the folder does not exist here."));
  assert.ok(!isProviderRefusal("I cannot reach that folder: no access to the task folder."));
  // ... a rate limit ...
  assert.ok(!isProviderRefusal("429 rate limit exceeded, try again later"));
  assert.ok(!isProviderRefusal("You've hit your usage limit. Try again in 3 hours."));
  // ... or an ordinary error.
  assert.ok(!isProviderRefusal("TypeError: x is not a function"));
  assert.ok(!isProviderRefusal(""));
  assert.ok(!isProviderRefusal(undefined));
});

// ---- FIX 2 unit: an ordinary deliverable is shown WHOLE; only a pathologically huge file is cut (and labelled).

test("readDeliverables shows a whole file past the old 6000 cap, and still caps one giant file", () => {
  const dir = mkdtempSync(join(tmpdir(), "deliv-"));
  // evidence for a late criterion lives after char 6000
  const body = "intro\n" + "x".repeat(7000) + "\nPrioritized next steps: LATE_EVIDENCE_MARKER\n";
  writeFileSync(join(dir, "report.md"), body);
  const out = readDeliverables(dir, ["report.md"]);
  assert.ok(out.includes("LATE_EVIDENCE_MARKER"), "the later content is now fully visible to the judge");
  assert.ok(!/first \d+ of \d+ chars/.test(out), "a normal-size file is not labelled as cut");

  // a pathologically huge file is still truncated to the per-file ceiling and labelled
  writeFileSync(join(dir, "huge.md"), "y".repeat(70000));
  const huge = readDeliverables(dir, ["huge.md"]);
  assert.ok(/first 50000 of 70000 chars/.test(huge), "the ceiling truncates and labels a giant file");
});

// ---- FIX 1 integration: another family picks up a refused task; the refuser doesn't spend an attempt.

const only = (store: ReturnType<typeof setup>["store"], keep: string[]) => {
  for (const a of store.listAgents()) if (!keep.includes(a.id)) { a.enabled = false; store.saveAgent(a); }
};

test("a provider refusal moves the task to another model family and carries on", async () => {
  MockAdapter.transientSeen.clear();
  const { store, orch, room } = setup();
  // codex owns task "a" (owner = 2nd agent) and its provider always refuses; claude/hermes do not.
  const codex = store.getAgent("codex")!;
  store.saveAgent({ ...codex, settings: { ...codex.settings, refuse: true } } as AgentConfig);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");

  assert.equal(goal.status, "done", "the goal finishes: a different family did the refused task");
  const tasks = store.listTasks({ goalId: goal.id });
  const refused = tasks.find((t) => (t.failures ?? []).some((f) => f.agentId === "codex" && f.note.startsWith("provider refusal")))!;
  assert.ok(refused, "the refusal is recorded on the task (Issues/Trace)");
  assert.equal(refused.status, "done", "the refused task still finished");
  assert.notEqual(refused.assignee, "codex", "it ended on another model, not the one that refused");
  assert.equal(refused.attempts, 1, "the refusal did not spend an attempt; only the successful run counts");
  assert.equal(refused.failures![0].tag, "other", "the refusal is tagged 'other' with a distinct note");
  assert.equal(goal.state?.progress?.goalReplans ?? 0, 0, "no replan was triggered by the refusal");
  assert.ok(store.listMessages(room.id).some((m) => m.text.includes("provider declined") && m.text.includes("trying")), "the room says it moved to another model");
});

test("when every ready family refuses, the task is parked for the owner, not replanned in a loop", async () => {
  MockAdapter.transientSeen.clear();
  const { store, orch, room } = setup();
  for (const a of store.listAgents()) store.saveAgent({ ...a, settings: { ...a.settings, refuse: true } } as AgentConfig);
  const goal = await orch.runGoal(room.id, "Summarize the venue TV market");

  assert.equal(goal.status, "paused", "the goal pauses on the owner instead of spinning");
  assert.ok(goal.state?.waitingOnOwner, "it is waiting on the owner");
  assert.equal(goal.state?.progress?.goalReplans ?? 0, 0, "a refused task is never replanned");
  const a = store.listTasks({ goalId: goal.id }).find((t) => t.title === "Research the topic")!;
  assert.equal(a.status, "waiting", "the task waits for the owner (the needs_input/waiting path)");
  assert.equal(a.attempts, 0, "no attempt was spent on the refusals");
  assert.notEqual(a.status, "failed");
  const line = store.listMessages(room.id).find((m) => m.text.includes("provider declined") && m.text.includes("Reword the task"));
  assert.ok(line, "one plain room line explains the provider refusal");
  assert.ok(/\d+ agents? tried/.test(line!.text), "it says how many agents tried");
});
