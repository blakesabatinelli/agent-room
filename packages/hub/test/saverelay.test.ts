import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, Task } from "@agent-room/shared";
import { MockAdapter } from "../src/adapters/mock.js";
import { needsGate } from "../src/discovery/routing.js";
import { listSteps } from "../src/durable/index.js";
import { WORKSPACE_NEED } from "../src/placement/index.js";
import { hasRunnableChecks, parseFileBlocks, relayEligible, saveRelayFiles } from "../src/placement/relay.js";
import { setup } from "./helpers.js";

/**
 * Save relay: an agent that runs on another machine does a task that works on the task folder by handing the file contents back in its
 * reply; a local step writes them into the task's worktree, so the usual confinement, judging and merge all apply.
 */

type Env = ReturnType<typeof setup>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20); };
const keepOrder = (store: Env["store"]) => { for (const a of ["claude", "codex", "hermes"]) store.saveAgent(store.getAgent(a)!); };
const tune = (e: Env, aid: string, patch: Partial<AgentConfig> & { settings?: Record<string, unknown> }) => {
  const a = e.store.getAgent(aid)!;
  e.store.saveAgent({ ...a, ...patch, settings: { ...a.settings, ...(patch.settings ?? {}) } });
  keepOrder(e.store);
};
const agent = (over: Partial<AgentConfig>): AgentConfig => ({ id: "x", name: "X", provider: "x", adapter: "mock", enabled: true, color: "#000", settings: {}, tools: { web: true, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false }, ...over });

/** A room where Hermes runs on another machine and every planned task works on its folder with no command check, so each is relay-eligible. */
function relayRoom() {
  const e = setup();
  e.store.setSettings({ ...e.store.getSettings(), planApproval: "never", autoRunChecks: true });
  tune(e, "hermes", { location: "elsewhere" });
  tune(e, "claude", { settings: { workspace: true } }); // the planner marks every task as working on its folder, with no runnable check
  return e;
}

// ---------------------------------------------------------------- 1. parsing and the guarded write

test("save relay: parses === FILE blocks, writes the valid ones into the worktree, and refuses absolute paths, traversal and .git", () => {
  const reply = [
    "Here is the work; the hub should save these.",
    "=== FILE: section-muse.md",
    "# Section",
    "Line two.",
    "=== END FILE",
    "=== FILE: out/team-doc.md",
    "Team doc body.",
    "=== END FILE",
    "=== FILE: /etc/passwd",
    "root:x:0:0",
    "=== END FILE",
    "=== FILE: ../escape.md",
    "nope",
    "=== END FILE",
    "=== FILE: .git/config",
    "[core]",
    "=== END FILE",
    "STATUS: done",
    "AC1: PASS",
  ].join("\n");
  const blocks = parseFileBlocks(reply);
  assert.deepEqual(blocks.map((b) => b.path), ["section-muse.md", "out/team-doc.md", "/etc/passwd", "../escape.md", ".git/config"]);
  assert.equal(blocks[0].content, "# Section\nLine two.", "the verbatim contents, not the markers");
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const r = saveRelayFiles(dir, blocks);
  assert.deepEqual(r.saved.sort(), ["out/team-doc.md", "section-muse.md"]);
  assert.deepEqual(r.refused.map((x) => x.path).sort(), ["../escape.md", ".git/config", "/etc/passwd"]);
  assert.equal(readFileSync(join(dir, "section-muse.md"), "utf8"), "# Section\nLine two.\n");
  assert.equal(readFileSync(join(dir, "out", "team-doc.md"), "utf8"), "Team doc body.\n");
  assert.equal(existsSync(join(dir, "escape.md")), false, "nothing escaped the worktree");
  assert.equal(parseFileBlocks("Just prose, no deliverable blocks here.").length, 0);
  assert.equal(parseFileBlocks("=== FILE: half.md\nno closing marker").length, 0, "an unterminated block is not a file");
});

// ---------------------------------------------------------------- 2. eligibility: who a relay-eligible task can go to

test("save relay eligibility: a workspace task with no runnable check is relay-eligible; one whose check must run locally is not", () => {
  assert.equal(relayEligible({ needs: [WORKSPACE_NEED], criteria: [{ id: "AC1", text: "done" }] }), true);
  assert.equal(relayEligible({ needs: [WORKSPACE_NEED], criteria: [{ id: "AC1", text: "x", check: "npm test" }] }), false, "a command check must run on this Mac");
  assert.equal(relayEligible({ needs: [], criteria: [{ id: "AC1", text: "x" }] }), false, "text-only work isn't a workspace task");
  assert.equal(hasRunnableChecks({ criteria: [{ id: "AC1", text: "x", check: "   " }] }), false, "a blank check doesn't count");

  const away = agent({ id: "muse", name: "Muse", adapter: "mcp", connectsFrom: { address: "100.64.0.5", loopback: false, at: 1 } });
  const here = agent({ id: "codex", name: "Codex", adapter: "codex" });
  const noCheck: Pick<Task, "needs" | "roomId"> & { criteria: Task["criteria"] } = { roomId: "r", needs: [WORKSPACE_NEED], criteria: [{ id: "AC1", text: "done" }] };
  const withCheck: typeof noCheck = { roomId: "r", needs: [WORKSPACE_NEED], criteria: [{ id: "AC1", text: "done", check: "test -s a.md" }] };
  // Without relay (every other caller): the off-machine agent is still excluded from the task folder.
  assert.deepEqual([...needsGate(noCheck, [away, here])!.ok], ["codex"]);
  // With relay (routing to live agents): a no-check workspace task now reaches the off-machine agent too.
  assert.deepEqual([...needsGate(noCheck, [away, here], undefined, { relay: true })!.ok].sort(), ["codex", "muse"]);
  // With relay, but the task's check must run locally: the off-machine agent stays out.
  const g = needsGate(withCheck, [away, here], undefined, { relay: true })!;
  assert.deepEqual([...g.ok], ["codex"]);
  assert.deepEqual(g.filteredOut, [{ agentId: "muse", missing: [WORKSPACE_NEED] }]);
});

// ---------------------------------------------------------------- 3. end to end

test("save relay end to end: a relay-eligible workspace task to an off-machine agent gets its file written into the worktree, judged, accepted and merged", async () => {
  const e = relayRoom();
  tune(e, "hermes", { settings: { relayFiles: { "summary.md": "The venue TV market summary.\nUnder 200 words." } } });
  MockAdapter.calls.length = 0;
  const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const g = e.store.getGoal(goal.id)!;
  const relayTask = e.store.listTasks({ goalId: g.id }).find((t) => t.assignee === "hermes" && t.origin === "plan")!;
  assert.ok(relayTask, "the off-machine agent was given a task");
  assert.ok(relayTask.needs?.includes(WORKSPACE_NEED), "and it works on the task folder");
  assert.equal(relayTask.status, "done");

  // The prompt told it to hand files back, not to use a folder it doesn't have.
  const call = MockAdapter.calls.find((c) => c.agentId === "hermes" && c.kind === "TASK")!;
  assert.doesNotMatch(call.prompt, /# Shared folder/);
  assert.match(call.prompt, /# Handing files back/);
  assert.match(call.prompt, /=== FILE: relative\/path\.md/);

  // The file it handed back was saved, shows as the task's changed files, and merged into the goal folder.
  const steps = listSteps(e.store, g.id, relayTask.id);
  const finished = steps.find((s) => s.kind === "run_finished")!;
  assert.ok((finished.data.changed as string[]).includes("summary.md"), "saved file is a changed file in Trace");
  assert.ok(steps.some((s) => s.kind === "merged"), "accepted work was merged");
  assert.equal(readFileSync(join(g.folder!, "summary.md"), "utf8"), "The venue TV market summary.\nUnder 200 words.\n");

  // The save is a distinct audited step and the room is told once.
  assert.ok(e.store.listAudit().some((a) => a.actor === "hermes" && a.action === "task.save_relay" && /saved 1 file/.test(a.detail)), "audited");
  const room = e.store.listMessages(e.room.id, 999).filter((m) => /did the work off-machine; saved 1 file into the task folder\./.test(m.text));
  assert.equal(room.length, 1, "one quiet room line");
});

test("save relay: an off-machine agent that hands back no file blocks for a file task is sent back once for the format, not passed silently", async () => {
  const e = relayRoom();
  // Hermes replies with prose and no === FILE blocks (no relayFiles knob).
  const p = e.orch.runGoal(e.room.id, "Summarize the venue TV market").catch(() => undefined);
  let task: Task | undefined;
  await until(() => {
    const g = e.store.listGoals(e.room.id)[0];
    if (!g) return false;
    task = e.store.listTasks({ goalId: g.id }).find((t) => (t.assignee === "hermes" || t.triedBy?.includes("hermes")) && t.needs?.includes(WORKSPACE_NEED) && t.judgment?.judgeAgentId === "hub");
    return !!task;
  });
  e.orch.stopRoom(e.room.id);
  await p;
  assert.ok(task, "the off-machine agent's file task was sent back by the hub");
  assert.equal(task!.judgment!.verdict, "revise", "sent back, not accepted");
  assert.match(task!.judgment!.feedback, /hand back each deliverable file/);
  assert.match(task!.judgment!.feedback, /=== FILE:/, "the feedback shows the format");
  // Nothing was saved or merged for the empty reply.
  assert.ok(!e.store.listAudit().some((a) => a.action === "task.save_relay" && a.actor === "hermes" && /saved/.test(a.detail)), "nothing saved");
});
