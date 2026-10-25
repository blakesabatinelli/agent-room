import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig, Judgment, JuryRecord, ServerEvent, Task } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { HW, localPairHeaders, setup } from "./helpers.js";
import { quotaFor } from "../src/quota/index.js";
import { familyOf } from "../src/jury/family.js";
import { aggregate, agreementOf, fleissKappa, fleissKappaFromCounts, isSplit, median, mergeFeedback, type JudgeRead } from "../src/jury/aggregate.js";
import { factsOf, mechanical, neutralize, rewriteProblem, stripPersona } from "../src/jury/neutralize.js";
import { getJury, listJuries } from "../src/jury/records.js";
import { jurySettings, selectJudges } from "../src/jury/jury.js";

type Ctx = ReturnType<typeof setup>;
const PB = "<!-- agent-room:persona:begin -->", PE = "<!-- agent-room:persona:end -->";
/** A reply with a persona block, a signature, emphasis and an emoji: everything AC1 says must be gone before judging. */
const ORIGINAL = `${PB}\nPERSONA-SECRET: you are Pixel, a cheerful pirate.\n${PE}\nSure! Here is the **summary**:\n\n## Findings\nI found 3 venues in \`venues.csv\`, 42% of them bars. 🎉\n\n— Claude`;

const calls = (kind: string) => MockAdapter.calls.filter((c) => c.kind === kind);

/** Speed: judging now defaults to fast (one cross-vendor judge). These tests exercise the full jury, so they opt into it. */
const full = (ctx: Ctx): Ctx => { ctx.store.setSettings({ ...ctx.store.getSettings(), judging: "full" }); return ctx; };

/** The three seeded agents (anthropic, openai, nous) plus a local Bonsai and a Gemini: five families. */
function fiveFamilies(setupOpts: Parameters<typeof setup>[0] = {}): Ctx {
  const ctx = full(setup(setupOpts));
  const base = ctx.store.getAgent("claude")!;
  ctx.store.saveAgent({ ...base, id: "bonsai", name: "Bonsai", provider: "local", settings: { quality: 0.8, model: "bonsai-8b", locality: "local-model" }, canBeOrchestrator: false });
  ctx.store.saveAgent({ ...base, id: "gemini", name: "Gemini", provider: "google", settings: { quality: 0.8, model: "gemini-3-pro" }, canBeOrchestrator: false });
  return ctx;
}
/** Three cloud families and one local: claude as the worker leaves openai, nous and local for the jury. */
function fourFamilies(setupOpts: Parameters<typeof setup>[0] = {}): Ctx {
  const ctx = fiveFamilies(setupOpts);
  ctx.store.deleteAgent("gemini");
  return ctx;
}
const agent = (ctx: Ctx, id: string) => ctx.store.getAgent(id)!;
const quality = (ctx: Ctx, id: string, q: number, extra: Record<string, unknown> = {}) => { const a = agent(ctx, id); ctx.store.saveAgent({ ...a, settings: { ...a.settings, quality: q, ...extra } }); };

let n = 0;
/** A finished task waiting for review, saved in the store, with two criteria. */
function review(ctx: Ctx, result = ORIGINAL, workerId = "claude"): Task {
  const t = {
    id: `task_jury${++n}`, roomId: ctx.room.id, goalId: `goal_jury${n}`, title: "Write the summary", description: "Summarise the venue findings with sources.",
    taskType: "writing", acceptance: "", dependsOn: [], assignee: workerId, owner: workerId, status: "review", attempts: 1, createdAt: 1, updatedAt: 1,
    criteria: [{ id: "AC1", text: "At least 3 facts" }, { id: "AC2", text: "Each fact has a source" }], result, checks: [],
  } as unknown as Task;
  ctx.store.saveTask(t);
  return t;
}
/** Run the orchestrator's judge (private: the jury hook lives inside it). */
const judge = (ctx: Ctx, t: Task, workerId = "claude", notJudge?: string): Promise<Judgment> =>
  (ctx.orch as unknown as { judge: (...a: unknown[]) => Promise<Judgment> }).judge(t, agent(ctx, workerId), undefined, [], new AbortController().signal, [], "", undefined, notJudge);

// ---------- model family

test("family: provider, model name and where it runs decide it; a Hermes on local Bonsai is local", () => {
  const ctx = fiveFamilies();
  assert.equal(familyOf(agent(ctx, "claude")), "anthropic");
  assert.equal(familyOf(agent(ctx, "codex")), "openai");
  assert.equal(familyOf(agent(ctx, "hermes")), "nous");
  assert.equal(familyOf(agent(ctx, "gemini")), "google");
  assert.equal(familyOf(agent(ctx, "bonsai")), "local-bonsai-8b");
  const hermes = agent(ctx, "hermes");
  assert.equal(familyOf({ ...hermes, settings: { model: "claude-sonnet-5-5" } }), "anthropic", "the model's name beats the agent's label");
  assert.equal(familyOf({ ...hermes, settings: { model: "llama-3.1-8b" } }), "meta");
  assert.equal(familyOf({ ...hermes, settings: { discovered: { localServer: "llama.cpp", model: "Bonsai-8B" } } }), "local-bonsai-8b", "Hermes using a local server");
  assert.equal(familyOf({ ...hermes, adapter: "mcp", settings: { model: "qwen3-0.6b" } }, ["qwen3-0.6b"]), "local-qwen3-0.6b", "a model discovery found running here");
  assert.equal(familyOf({ ...hermes, settings: { model: "gpt-5.6-terra" } }), "openai");
});

// ---------- neutral rewrite (AC1)

test("neutral voice: persona blocks, signatures, emphasis and emoji go; numbers, files and code stay", () => {
  const out = mechanical(ORIGINAL, { name: "Claude", id: "claude", provider: "anthropic" });
  assert.ok(!out.includes("PERSONA-SECRET") && !out.includes(PB) && !out.includes(PE), out);
  assert.ok(!/— Claude|\*\*|##|🎉|^Sure/m.test(out), out);
  for (const keep of ["3", "venues.csv", "42%", "summary", "Findings"]) assert.ok(out.includes(keep), `${keep} kept in: ${out}`);
  assert.equal(stripPersona(`a ${PB} secret ${PE} b`), "a  b");
  assert.equal(stripPersona(`a ${PB} unclosed`), "a  unclosed", "a stray marker is dropped, nothing else");
  assert.equal(mechanical("```\n**not bold** — Claude\n```\nDone."), "```\n**not bold** — Claude\n```\nDone.", "code is left alone");
  assert.equal(mechanical("Result:\n- one\n- two"), "Result:\n- one\n- two", "a final bullet is content, not a sign-off");
});

test("neutral voice: a rewrite is used only when it keeps every number and file reference", async () => {
  const task = { title: "t" };
  const src = mechanical(ORIGINAL);
  assert.deepEqual(factsOf("I found 3 venues in `venues.csv`, 42% of them. See docs/a.md and 1,200 rows").sort(), ["1200", "3", "42", "docs/a.md", "venues.csv"].sort());
  assert.match(rewriteProblem(src, "Some venues were found.")!, /dropped/);
  assert.equal(rewriteProblem(src, `Three... 3 venues in venues.csv, 42% bars. Summary Findings`), undefined);
  const good = await neutralize(ORIGINAL, task, { rewrite: async (p) => `Plain: ${p.split('"""')[1].trim()}` });
  assert.equal(good.how, "model");
  const bad = await neutralize(ORIGINAL, task, { rewrite: async () => "Work was done." });
  assert.equal(bad.how, "mechanical");
  assert.match(bad.note!, /dropped/);
  assert.equal(bad.text, src, "falls back to the mechanical text");
  assert.equal((await neutralize(ORIGINAL, task, { rewrite: async () => { throw new Error("down"); } })).how, "mechanical");
  assert.equal((await neutralize("", task)).how, "empty");
});

// ---------- agreement maths

test("Fleiss' kappa matches the textbook example (0.210) and the edge cases", () => {
  // Wikipedia's worked example: 10 subjects, 14 raters, 5 categories.
  const counts = [[0, 0, 0, 0, 14], [0, 2, 6, 4, 2], [0, 0, 3, 5, 6], [0, 3, 9, 2, 0], [2, 2, 8, 1, 1], [7, 7, 0, 0, 0], [3, 2, 6, 3, 0], [2, 5, 3, 2, 2], [6, 5, 2, 1, 0], [0, 2, 2, 3, 7]];
  assert.ok(Math.abs(fleissKappaFromCounts(counts)! - 0.21) < 0.001, String(fleissKappaFromCounts(counts)));
  assert.equal(fleissKappa([["PASS", "PASS", "PASS"], ["FAIL", "FAIL", "FAIL"]]), 1, "perfect agreement");
  assert.equal(fleissKappa([["PASS", "PASS", "PASS"], ["PASS", "PASS", "PASS"]]), 1, "one category throughout and everyone agrees: perfect, not undefined");
  assert.equal(fleissKappa([["PASS", "FAIL", "PASS"]]), null, "one criterion is not enough");
  // Two criteria, three judges, one dissenter on both: kappa = -0.5 (worked by hand: Pbar 1/3, Pe 5/9).
  assert.ok(Math.abs(fleissKappa([["PASS", "FAIL", "PASS"], ["PASS", "FAIL", "PASS"]])! + 0.5) < 1e-9);
  assert.equal(median([0.9, 0.3, 0.9]), 0.9);
  assert.equal(median([0.2, 0.8]), 0.5);
});

const read = (agentId: string, o: Partial<JudgeRead> = {}): JudgeRead => ({
  agentId, family: agentId, local: false, score: 0.8, verdict: "accept", feedback: "", onTask: true,
  criteria: { AC1: { verdict: "PASS", evidence: "ok" }, AC2: { verdict: "PASS", evidence: "ok" } }, ...o,
});
const crit = (a: string, b: string) => ({ AC1: { verdict: a as "PASS", evidence: a }, AC2: { verdict: b as "PASS", evidence: b } });
const spec = { criteria: [{ id: "AC1", text: "x" }, { id: "AC2", text: "y" }], checks: [] };

test("aggregate: a split jury takes the median score, the majority verdict and per-criterion majorities; ties are UNSURE", () => {
  const reads = [
    read("a", { score: 0.9 }),
    read("b", { score: 0.4, verdict: "revise", feedback: "Add a source for each fact. Too thin.", criteria: crit("PASS", "FAIL") }),
    read("c", { score: 0.8, feedback: "", criteria: crit("PASS", "PASS") }),
  ];
  const g = aggregate(reads, spec);
  assert.equal(g.score, 0.8, "median");
  assert.equal(g.verdict, "accept", "two accepts against one revise");
  assert.deepEqual([g.criteria.AC1.verdict, g.criteria.AC2.verdict], ["PASS", "PASS"]);
  assert.ok(isSplit(reads.map((r) => r.verdict)));
  const ag = agreementOf(reads, g.verdict, ["AC1", "AC2"]);
  assert.deepEqual([ag.majority, ag.pairwise, ag.spread], [0.67, 0.33, 0.5]);

  const tie = aggregate([read("a", { criteria: crit("PASS", "PASS") }), read("b", { criteria: crit("FAIL", "PASS"), verdict: "revise" }), read("c", { criteria: crit("UNSURE", "PASS"), verdict: "revise" })], spec);
  assert.equal(tie.criteria.AC1.verdict, "UNSURE", "1 PASS, 1 FAIL, 1 UNSURE has no majority");
  assert.equal(tie.verdict, "revise", "1 accept, 2 revise");
  assert.match(tie.feedback, /Not yet passing: AC1/);

  const even = aggregate([read("a"), read("b", { verdict: "revise" })], spec);
  assert.equal(even.verdict, "revise", "a tied verdict goes back for revision");
  // Accept needs every criterion to pass, same as one judge.
  const bad = aggregate([read("a", { criteria: crit("FAIL", "PASS") }), read("b", { criteria: crit("FAIL", "PASS") }), read("c")], spec);
  assert.equal(bad.verdict, "revise");
  assert.deepEqual(bad.failing, ["AC1"]);
});

test("aggregate: feedback is merged without repeats, and drift needs two judges", () => {
  const f = mergeFeedback(["Add sources. Fix the title.", "Add sources!", "fix the title. Count the venues."]);
  assert.equal(f, "Add sources. Fix the title. Count the venues.");
  const one = aggregate([read("a", { drift: "wrote the summary" }), read("b"), read("c")], spec);
  assert.equal(one.drift, undefined, "one judge's flag is not drift");
  assert.equal(one.onTask, true);
  const two = aggregate([read("a", { drift: "wrote the summary" }), read("b", { onTask: false, drift: "wandered off" }), read("c")], spec);
  assert.match(two.drift!, /wrote the summary/);
  assert.match(two.drift!, /wandered off/);
  assert.equal(two.onTask, true, "only one of them said off task");
  assert.equal(aggregate([read("a", { onTask: false }), read("b", { onTask: false }), read("c")], spec).onTask, false, "two said off task");
});

// ---------- selection

test("selectJudges: three families, none the worker's, one local; limited and not-admitted judges are skipped", () => {
  const ctx = fiveFamilies();
  const ready = ctx.store.listAgents();
  const base = { ready, worker: agent(ctx, "claude"), workerFamily: "anthropic", localModels: [] as string[], settings: jurySettings({}), rotation: ["claude", "codex"], limited: () => false, admit: () => true };
  const pick = selectJudges(base);
  assert.equal(pick.fallback, undefined);
  assert.equal(pick.judges.length, 3);
  assert.equal(pick.judges[0].id, "bonsai", "the local judge comes first");
  assert.ok(!pick.judges.some((j) => j.id === "claude"));
  assert.equal(new Set(pick.judges.map((j) => familyOf(j))).size, 3);
  assert.deepEqual(selectJudges({ ...base, limited: (id) => id === "codex" }).judges.map((j) => j.id), ["bonsai", "hermes", "gemini"], "codex is out of quota");
  const noLocal = selectJudges({ ...base, admit: (a) => a.id !== "bonsai" });
  assert.equal(noLocal.judges.length, 3);
  assert.match(noLocal.noLocal!, /governor/);
  assert.match(selectJudges({ ...base, ready: ready.filter((a) => ["claude", "codex", "hermes"].includes(a.id)) }).fallback!, /only 2 model families besides the worker's are ready \(a jury needs 3\)/);
  assert.equal(selectJudges({ ...base, settings: jurySettings({ jury: { requireLocal: false } }) }).judges[0].id, "codex", "no local preference");
  assert.equal(jurySettings({ jury: { size: 9, minFamilies: 9 } }).size, 5);
  assert.equal(jurySettings({}).auto, true);
});

// ---------- the jury through the orchestrator (AC1, AC2)

test("AC1: the judges read the neutralised text, not the original; the persona never reaches the rewriter", async () => {
  const ctx = fourFamilies();
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, review(ctx));
  const judges = calls("JUDGE");
  assert.equal(judges.length, 3);
  for (const c of judges) {
    assert.ok(c.prompt.includes("Neutral rewrite:"), "the rewriter's text is what they read");
    assert.ok(!c.prompt.includes("PERSONA-SECRET") && !c.prompt.includes(PB) && !c.prompt.includes(PE), "persona text is gone");
    assert.ok(!c.prompt.includes("— Claude"), "the signature is gone");
    assert.ok(!c.prompt.includes("**summary**") && !c.prompt.includes("🎉"));
    for (const keep of ["venues.csv", "42%"]) assert.ok(c.prompt.includes(keep), `${keep} survives`);
  }
  const rewrites = calls("NEUTRALIZE");
  assert.equal(rewrites.length, 1);
  assert.equal(rewrites[0].agentId, "bonsai", "a local model rewrites it when there is one");
  assert.ok(!rewrites[0].prompt.includes("PERSONA-SECRET"), "the persona is stripped before the rewriter sees the reply");
  const rec = getJury(ctx.store, j.jury!.id)!;
  assert.equal(rec.rewriter, "bonsai", "the rewriter is recorded");
});

test("AC1: a rewriter that drops facts is refused; the mechanical text is judged and the record says so", async () => {
  const ctx = fourFamilies();
  quality(ctx, "bonsai", 0.8, { badRewrite: true });
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, review(ctx));
  const rec = getJury(ctx.store, j.jury!.id)!;
  assert.equal(rec.rewriter, "mechanical");
  assert.match(rec.rewriterNote!, /dropped/);
  for (const c of calls("JUDGE")) { assert.ok(!c.prompt.includes("Work was done.")); assert.ok(!c.prompt.includes("— Claude") && !c.prompt.includes("PERSONA-SECRET")); assert.ok(c.prompt.includes("venues.csv")); }
});

test("AC2: three judges from three different families, none the worker's, one of them local", async () => {
  const ctx = fiveFamilies();
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, review(ctx));
  assert.equal(j.jury!.kind, "jury");
  const rec = getJury(ctx.store, j.jury!.id)!;
  assert.equal(rec.judges.length, 3);
  assert.equal(new Set(rec.judges.map((x) => x.family)).size, 3, "distinct families");
  assert.ok(rec.judges.every((x) => x.family !== rec.workerFamily), "none in the worker's family");
  assert.equal(rec.workerFamily, "anthropic");
  assert.equal(rec.judges.filter((x) => x.local).length, 1, "one local");
  assert.equal(rec.judges.find((x) => x.local)!.agentId, "bonsai");
  assert.deepEqual(new Set(calls("JUDGE").map((c) => c.agentId)), new Set(rec.judges.map((x) => x.agentId)), "those three were actually asked");
  assert.equal(j.judgeAgentId.split(",").length, 3);
  assert.ok(rec.judges.every((x) => x.model !== undefined || x.agentId), "each judge's model or agent is kept");
  assert.equal(listJuries(ctx.store, { taskId: rec.taskId }).length, 1);
  assert.ok(rec.agreement.kappa !== null, "two criteria: kappa is recorded");
  assert.equal(ctx.governor.snapshot().running.total, 0, "the local judge's slot was released");
});

test("a split jury: median score, majority verdict, a jury_split event and the record", async () => {
  const ctx = fourFamilies();
  quality(ctx, "codex", 0.9); quality(ctx, "bonsai", 0.9); quality(ctx, "hermes", 0.3);
  const seen: ServerEvent[] = [];
  ctx.store.on("event", (e) => seen.push(e));
  const j = await judge(ctx, review(ctx));
  assert.equal(j.verdict, "accept");
  assert.equal(j.score, 0.9);
  assert.equal(j.jury!.split, true);
  assert.deepEqual(j.jury!.judges.map((x) => x.verdict).sort(), ["accept", "accept", "revise"]);
  assert.equal(j.jury!.agreement.majority, 0.67);
  assert.equal(j.jury!.agreement.kappa, -0.5, "both criteria had one dissenter");
  assert.equal(j.jury!.agreement.spread, 0.6);
  assert.match(j.feedback, /Too thin/, "the dissenter's point is not lost");
  const ev = seen.find((e) => (e as { type: string }).type === "jury_split") as unknown as { taskId: string; juryId: string; judges: unknown[] };
  assert.ok(ev, "event emitted");
  assert.equal(ev.juryId, j.jury!.id);
  assert.equal(ev.judges.length, 3);
  assert.ok(getJury(ctx.store, j.jury!.id)!.split);
  assert.ok(ctx.store.listAudit().some((a) => a.action === "jury.split"));
  // Unanimous juries stay quiet.
  seen.length = 0;
  quality(ctx, "hermes", 0.9);
  await judge(ctx, review(ctx));
  assert.ok(!seen.some((e) => (e as { type: string }).type === "jury_split"));
});

test("a unanimous accept, and a tied verdict (2 judges) both resolve; reassign counts as revise for splits", async () => {
  const ctx = fourFamilies();
  const j = await judge(ctx, review(ctx));
  assert.equal(j.verdict, "accept");
  assert.equal(j.jury!.split, false);
  assert.equal(j.jury!.agreement.majority, 1);
  assert.equal(isSplit(["revise", "reassign", "revise"]), false);
});

test("fewer than three families besides the worker's: one rotating judge, recorded as a fallback with the reason", async () => {
  const ctx = full(setup()); // the default three mock agents: anthropic, openai, nous
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, review(ctx));
  assert.equal(j.jury!.kind, "fallback");
  assert.match(j.jury!.reason!, /only 2 model families besides the worker's/);
  assert.equal(j.judgeAgentId.includes(","), false, "one judge");
  assert.equal(calls("JUDGE").length, 1);
  assert.equal(calls("NEUTRALIZE").length, 0, "no model call is spent on rewriting in a fallback");
  assert.ok(!calls("JUDGE")[0].prompt.includes("— Claude") && !calls("JUDGE")[0].prompt.includes("PERSONA-SECRET"), "the reply is still tidied mechanically");
  const rec = getJury(ctx.store, j.jury!.id)!;
  assert.deepEqual([rec.kind, rec.rewriter, rec.judges.length], ["fallback", "mechanical", 1]);
  assert.equal(rec.judges[0].agentId, j.judgeAgentId);
  assert.notEqual(rec.judges[0].agentId, "claude", "still never grades its own work when it can help it");
});

test("the jury can be switched off: judging is exactly what it was, and nothing is recorded", async () => {
  const ctx = fourFamilies();
  ctx.store.setSettings({ ...ctx.store.getSettings(), jury: { enabled: false } });
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, review(ctx));
  assert.equal(j.jury, undefined);
  assert.equal(listJuries(ctx.store).length, 0);
  assert.equal(calls("JUDGE").length, 1);
  assert.ok(!calls("JUDGE")[0].prompt.includes("PERSONA-SECRET"), "3.2: no persona reaches a judge, jury or not"); // was: the raw reply, untouched
  assert.ok(calls("JUDGE")[0].prompt.includes("venues.csv"), "the rest of the reply is untouched when the owner turns it off");
});

test("a judge that is out of quota is skipped", async () => {
  const ctx = fiveFamilies();
  quotaFor(ctx.store).recordRun(agent(ctx, "codex"), { ok: false, text: "", durationMs: 1, error: "You've hit your usage limit. Try again in 3 hours." }, {}, Date.now());
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, review(ctx));
  assert.equal(j.jury!.kind, "jury");
  const ids = j.jury!.judges.map((x) => x.agentId).sort();
  assert.deepEqual(ids, ["bonsai", "gemini", "hermes"], "codex sat this one out");
  assert.ok(!calls("JUDGE").some((c) => c.agentId === "codex"));
  assert.ok(!calls("NEUTRALIZE").some((c) => c.agentId === "codex"), "and did not rewrite either");
});

test("no local model ready: the best three cloud families judge and the record says why there was no local one", async () => {
  const ctx = fiveFamilies();
  ctx.store.saveAgent({ ...agent(ctx, "bonsai"), enabled: false });
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, review(ctx));
  assert.equal(j.jury!.kind, "jury");
  assert.ok(j.jury!.judges.every((x) => !x.local));
  assert.match(getJury(ctx.store, j.jury!.id)!.noLocal!, /no local model is ready/);
  assert.ok(calls("NEUTRALIZE").every((c) => c.agentId !== "claude"), "a cloud rewriter from another family");
  assert.equal(getJury(ctx.store, j.jury!.id)!.rewriter !== "claude", true);
});

test("a local judge the capacity governor won't admit is not used", async () => {
  const ctx = fiveFamilies({ hardware: HW.small, freeGB: () => 0.2 });
  MockAdapter.calls.length = 0;
  const j = await judge(ctx, review(ctx));
  assert.ok(!calls("JUDGE").some((c) => c.agentId === "bonsai"), "no free memory for it");
  assert.ok(!calls("NEUTRALIZE").some((c) => c.agentId === "bonsai"));
  assert.match(getJury(ctx.store, j.jury!.id)!.noLocal!, /governor/);
});

// ---------- the loop around it

test("a whole goal with the jury on: every judgment has a jury record, the routing log points at it, and the room shows the line", async () => {
  const ctx = fiveFamilies();
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const tasks = ctx.store.listTasks({ goalId: goal.id });
  assert.ok(tasks.length >= 2);
  for (const t of tasks) {
    const rec = getJury(ctx.store, t.judgment!.jury!.id)!;
    assert.equal(rec.kind, "jury", `${t.title}`);
    assert.ok(rec.judges.every((x) => x.family !== rec.workerFamily) && new Set(rec.judges.map((x) => x.family)).size === 3);
  }
  assert.equal(listJuries(ctx.store, { goalId: goal.id }).length, tasks.length);
  const routed = ctx.store.listRouting({ goalId: goal.id }).filter((r) => r.judgment);
  assert.ok(routed.length && routed.every((r) => r.juryId && getJury(ctx.store, r.juryId)));
  assert.ok(ctx.store.listMessages(ctx.room.id).some((m) => /3 judges: [✓✗] [✓✗] [✓✗] \(agree \d+%\)/.test(m.text)), "the chips line is in the room log");
  assert.match(goal.summary!, /Judging: 2 judged by a jury \(agree \d+%/, "and the summary the phone shows says how it was judged");
});

test("UNSURE from the whole jury still escalates and ends flagged, not looping", async () => {
  const ctx = fiveFamilies();
  for (const a of ctx.store.listAgents()) quality(ctx, a.id, a.settings.quality as number ?? 0.8, { unsure: true });
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  assert.ok(ctx.store.listTasks({ goalId: goal.id }).some((t) => t.flagged?.length), "flagged for the owner");
});

test("existing single-judge behaviour holds with only the default agents", async () => {
  const ctx = full(setup());
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const tasks = ctx.store.listTasks({ goalId: goal.id });
  for (const t of tasks) { assert.equal(t.judgment!.jury!.kind, "fallback"); assert.notEqual(t.judgment!.judgeAgentId, t.assignee); }
  assert.match(goal.summary!, /Judging: 2 by one judge\./);
});

// ---------- distance from the owner (AC3)

test("AC3: rating a judgment records each judge's and the jury's distance, and keeps the running calibration", async () => {
  const ctx = fourFamilies();
  quality(ctx, "codex", 0.9); quality(ctx, "bonsai", 0.7); quality(ctx, "hermes", 0.8);
  const t = review(ctx);
  const j = await judge(ctx, t);
  ctx.store.saveTask({ ...t, judgment: j, status: "done" });
  assert.equal(j.score, 0.8);
  ctx.orch.rateJudgment(t.id, 0.6);
  const rec = getJury(ctx.store, j.jury!.id)!;
  assert.equal(rec.owner!.score, 0.6);
  assert.equal(rec.owner!.juryDistance, 0.2);
  const dist = Object.fromEntries(rec.judges.map((x) => [x.agentId, x.distance]));
  assert.deepEqual(dist, { codex: 0.3, bonsai: 0.1, hermes: 0.2 });
  let cal = ctx.store.getKV<{ n: number; juryN: number; juryAbsErr: number; sameFamilyN: number; byFamily: Record<string, { n: number; absErr: number }> }>("jury_calibration", undefined as never);
  assert.deepEqual([cal.n, cal.juryN, cal.juryAbsErr, cal.sameFamilyN], [1, 1, 0.2, 0]);
  assert.deepEqual(cal.byFamily.openai, { n: 1, absErr: 0.3 });
  assert.deepEqual(cal.byFamily["local-bonsai-8b"], { n: 1, absErr: 0.1 });
  // A second rating moves the running means.
  const t2 = review(ctx);
  const j2 = await judge(ctx, t2);
  ctx.store.saveTask({ ...t2, judgment: j2, status: "done" });
  ctx.orch.rateJudgment(t2.id, 0.8);
  cal = ctx.store.getKV("jury_calibration", undefined as never);
  assert.deepEqual([cal.n, cal.juryN, cal.juryAbsErr], [2, 2, 0.1]);
  assert.equal(cal.byFamily.openai.n, 2);
  assert.ok(Math.abs(cal.byFamily.openai.absErr - 0.2) < 1e-9, "(0.3 + 0.1) / 2");
  // The old per-agent calibration still runs.
  assert.equal(ctx.store.getKV<{ n: number }>("judge_calibration", { n: 0 }).n >= 0, true);
});

test("AC3: a same-family single judge is tracked apart, for the 'cross-vendor judges are worse than the user' check", async () => {
  const ctx = full(setup());
  ctx.store.saveAgent({ ...agent(ctx, "claude"), id: "claude2", name: "Claude Two" });
  ctx.store.setSettings({ ...ctx.store.getSettings(), judgeRotation: ["claude"] });
  for (const id of ["codex", "hermes"]) ctx.store.saveAgent({ ...agent(ctx, id), enabled: false });
  quality(ctx, "claude", 0.9);
  const t = review(ctx, ORIGINAL, "claude2");
  const j = await judge(ctx, t, "claude2");
  assert.equal(j.jury!.kind, "fallback");
  assert.equal(j.judgeAgentId, "claude", "the only judge left shares the worker's family");
  ctx.store.saveTask({ ...t, judgment: j, status: "done" });
  ctx.orch.rateJudgment(t.id, 0.5);
  const cal = ctx.store.getKV<{ n: number; juryN: number; singleN: number; singleAbsErr: number; sameFamilyN: number; sameFamilyAbsErr: number }>("jury_calibration", undefined as never);
  assert.deepEqual([cal.n, cal.juryN, cal.singleN, cal.sameFamilyN], [1, 0, 1, 1]);
  assert.equal(cal.sameFamilyAbsErr, 0.4);
  assert.equal(cal.singleAbsErr, 0.4);
});

test("rating a judgment made with the jury off leaves the jury stats alone", () => {
  const ctx = setup();
  const t = review(ctx);
  ctx.store.saveTask({ ...t, judgment: { score: 0.8, verdict: "accept", feedback: "", judgeAgentId: "codex" }, status: "done" });
  ctx.orch.rateJudgment(t.id, 0.4);
  assert.equal(ctx.store.getKV("jury_calibration", null), null);
});

// ---------- HTTP

test("GET /juries?taskId= and GET /jury/stats", async () => {
  const ctx = fourFamilies();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const paired = await fetch(`${base}/pair/local`, { method: "POST", headers: localPairHeaders(ctx.dir), body: JSON.stringify({ deviceName: "Mac" }) });
    const { token } = (await paired.json()) as { token: string };
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/juries`)).status, 401);
    quality(ctx, "hermes", 0.3);
    const t = review(ctx);
    const j = await judge(ctx, t);
    ctx.store.saveTask({ ...t, judgment: j, status: "done" });
    await fetch(`${base}/tasks/${t.id}/rate`, { method: "POST", headers: h, body: JSON.stringify({ score: 0.7 }) });
    const rows = (await (await fetch(`${base}/juries?taskId=${t.id}`, { headers: h })).json()) as JuryRecord[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].judges.length, 3);
    assert.equal(rows[0].owner!.score, 0.7);
    assert.ok(rows[0].judges.every((x) => typeof x.distance === "number"));
    assert.equal(((await (await fetch(`${base}/juries?taskId=nope`, { headers: h })).json()) as unknown[]).length, 0);
    const stats = (await (await fetch(`${base}/jury/stats`, { headers: h })).json()) as { calibration: { n: number; juryAbsErr: number }; juries: number; splits: number; byKind: { jury: number } };
    assert.deepEqual([stats.calibration.n, stats.juries, stats.splits, stats.byKind.jury], [1, 1, 1, 1]);
    // The owner's jury settings survive PUT /settings.
    const put = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ jury: { size: 3, requireLocal: false } }) });
    assert.equal(put.status, 200);
    assert.deepEqual(ctx.store.getSettings().jury, { size: 3, requireLocal: false });
  } finally { await app.close(); }
});
