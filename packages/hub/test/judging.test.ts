import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig, Judgment, Task } from "@agent-room/shared";
import { MockAdapter } from "../src/adapters/mock.js";
import { setup } from "./helpers.js";
import { familyOf } from "../src/jury/family.js";
import { getJury, listJuries } from "../src/jury/records.js";
import { saveTwoKey } from "../src/twokey/records.js";

// Speed: lighter judging by default. One cross-vendor judge per normal task; the full 3-judge jury only on request or for high-stakes work.

type Ctx = ReturnType<typeof setup>;
const PB = "<!-- agent-room:persona:begin -->", PE = "<!-- agent-room:persona:end -->";
const ORIGINAL = `${PB}\nPERSONA-SECRET: you are Pixel, a cheerful pirate.\n${PE}\nHere is the **summary**: 3 venues in \`venues.csv\`, 42% bars. 🎉\n\n— Claude`;
const calls = (kind: string) => MockAdapter.calls.filter((c) => c.kind === kind);
const agent = (ctx: Ctx, id: string) => ctx.store.getAgent(id)!;

/** The three seeded agents plus a local Bonsai and a Gemini: five families, so a full jury can form. */
function fiveFamilies(): Ctx {
  const ctx = setup();
  const base = ctx.store.getAgent("claude")!;
  ctx.store.saveAgent({ ...base, id: "bonsai", name: "Bonsai", provider: "local", settings: { quality: 0.8, model: "bonsai-8b", locality: "local-model" }, canBeOrchestrator: false });
  ctx.store.saveAgent({ ...base, id: "gemini", name: "Gemini", provider: "google", settings: { quality: 0.8, model: "gemini-3-pro" }, canBeOrchestrator: false });
  return ctx;
}

let n = 0;
function reviewTask(ctx: Ctx, extra: Partial<Task> = {}, workerId = "claude"): Task {
  const t = {
    id: `task_fast${++n}`, roomId: ctx.room.id, goalId: `goal_fast${n}`, title: "Write the summary", description: "Summarise the venue findings.",
    taskType: "writing", acceptance: "", dependsOn: [], assignee: workerId, owner: workerId, status: "review", attempts: 1, createdAt: 1, updatedAt: 1,
    criteria: [{ id: "AC1", text: "At least 3 facts" }, { id: "AC2", text: "Each fact has a source" }], result: ORIGINAL, checks: [], ...extra,
  } as unknown as Task;
  ctx.store.saveTask(t);
  return t;
}
const judge = (ctx: Ctx, t: Task, workerId = "claude"): Promise<Judgment> =>
  (ctx.orch as unknown as { judge: (...a: unknown[]) => Promise<Judgment> }).judge(t, agent(ctx, workerId), undefined, [], new AbortController().signal, [], "");

test("fast mode (the default): exactly one cross-vendor judge, no rewrite call, the persona still scrubbed", async () => {
  const ctx = fiveFamilies();
  assert.equal(ctx.store.getSettings().judging, "fast", "fast is the default");
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, reviewTask(ctx));
  assert.equal(calls("JUDGE").length, 1, "one judge");
  assert.equal(calls("NEUTRALIZE").length, 0, "no rewrite model call in fast mode");
  const rec = getJury(ctx.store, j.jury!.id)!;
  assert.equal(rec.kind, "fast");
  assert.equal(rec.rewriter, "mechanical");
  assert.equal(rec.judges.length, 1);
  assert.notEqual(rec.judges[0].family, rec.workerFamily, "the judge is cross-vendor");
  assert.equal(j.judgeAgentId.includes(","), false, "a single judge id");
  assert.equal(typeof j.score, "number", "a score is still recorded");
  const c = calls("JUDGE")[0];
  assert.ok(!c.prompt.includes("PERSONA-SECRET") && !c.prompt.includes(PB) && !c.prompt.includes("— Claude"), "persona/signature scrubbed");
  assert.ok(c.prompt.includes("venues.csv") && c.prompt.includes("42%"), "the facts survive");
});

test("fast mode never lets the worker judge its own work", async () => {
  const ctx = fiveFamilies();
  for (const id of ["codex", "hermes", "gemini"]) ctx.store.saveAgent({ ...agent(ctx, id), enabled: false }); // only claude + local bonsai left
  const j = await judge(ctx, reviewTask(ctx), "claude");
  assert.notEqual(j.judgeAgentId, "claude");
  assert.notEqual(familyOf(agent(ctx, j.judgeAgentId.split(",")[0]), ["bonsai-8b"]), "anthropic");
});

test("full mode: the 3-judge jury convenes and rewrites", async () => {
  const ctx = fiveFamilies();
  ctx.store.setSettings({ ...ctx.store.getSettings(), judging: "full" });
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, reviewTask(ctx));
  assert.equal(j.jury!.kind, "jury");
  assert.equal(calls("JUDGE").length, 3, "three judges");
  assert.equal(calls("NEUTRALIZE").length, 1, "the neutral rewrite runs");
  assert.equal(getJury(ctx.store, j.jury!.id)!.judges.length, 3);
});

test("high-stakes: a verify-round re-check gets the full jury even in fast mode", async () => {
  const ctx = fiveFamilies();
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, reviewTask(ctx, { origin: "verify" }));
  assert.equal(j.jury!.kind, "jury", "a verify task is judged by the full jury");
  assert.equal(calls("JUDGE").length, 3);
});

test("high-stakes: a task that went through two-key gets the full jury even in fast mode", async () => {
  const ctx = fiveFamilies();
  const t = reviewTask(ctx);
  saveTwoKey(ctx.store, { id: "tk1", at: 1, kind: "email", tool: "gmail", action: "send", taskId: t.id, agentA: "claude", familyA: "anthropic", verdict: "match", why: "", threshold: 0.85, draftA: null, draftB: null, diffs: [], outcome: "proceeded" } as never);
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, t);
  assert.equal(j.jury!.kind, "jury", "a task that passed two-key is high-stakes");
  assert.equal(calls("JUDGE").length, 3);
});

test("judge-call count: fast spends 1 call, full spends 3 (plus a rewrite), on the same task", async () => {
  const ctx = fiveFamilies();
  MockAdapter.calls.length = 0;
  await judge(ctx, reviewTask(ctx));
  const fast = calls("JUDGE").length + calls("NEUTRALIZE").length;
  ctx.store.setSettings({ ...ctx.store.getSettings(), judging: "full" });
  MockAdapter.calls.length = 0;
  await judge(ctx, reviewTask(ctx));
  const full = calls("JUDGE").length + calls("NEUTRALIZE").length;
  assert.equal(fast, 1, "fast: one judge, no rewrite");
  assert.equal(full, 4, "full: three judges and one rewrite");
});

test("/jury escalates the running goal to the full jury", async () => {
  const ctx = fiveFamilies();
  const goal = ctx.store.saveGoal({ id: "g_esc", roomId: ctx.room.id, text: "do it", status: "running", createdAt: 1, updatedAt: 1 } as never);
  await ctx.orch.handleOwnerMessage(ctx.room.id, "/jury");
  assert.equal(ctx.store.getGoal("g_esc")!.fullJury, true, "the active goal is switched to the full jury");
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, reviewTask(ctx, { goalId: "g_esc" }));
  assert.equal(j.jury!.kind, "jury", "its tasks now get the full jury");
});

test("a whole goal judges fast by default: every task has a one-judge record", async () => {
  const ctx = fiveFamilies();
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const tasks = ctx.store.listTasks({ goalId: goal.id });
  assert.ok(tasks.length >= 2);
  for (const t of tasks) {
    const rec = getJury(ctx.store, t.judgment!.jury!.id)!;
    assert.equal(rec.kind, "fast", `${t.title}`);
    assert.equal(rec.judges.length, 1);
    assert.notEqual(rec.judges[0].family, rec.workerFamily);
  }
  assert.equal(listJuries(ctx.store, { goalId: goal.id }).length, tasks.length);
});
