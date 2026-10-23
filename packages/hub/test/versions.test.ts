import { test } from "node:test";
import assert from "node:assert/strict";
import type { Judgment, ModelShift, VersionScore, VersionScoreRow } from "@agent-room/shared";
import { setup } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { applyOwnerRating, expected, expectedFor, pickAgent, recordOutcome } from "../src/orchestrator/scoring.js";
import { decide } from "../src/orchestrator/routing.js";
import { quotaDecide } from "../src/quota/router.js";
import { attentionFor } from "../src/attention/index.js";
import { listShifts, normaliseModelVersion, resolveModelVersion, versionRows, welchP } from "../src/orchestrator/versions.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const judged = (score: number): Judgment => ({ score, verdict: score >= 0.7 ? "accept" : "revise", feedback: "", judgeAgentId: "claude" });
const ok = (store: ReturnType<typeof setup>["store"], agent: string, type: string, score: number, model: string | undefined, at: number) =>
  recordOutcome(store, agent, type, { judgment: judged(score), seconds: 10, failed: false, revision: false }, model, at);
const bad = (store: ReturnType<typeof setup>["store"], agent: string, type: string, model: string, at: number) =>
  recordOutcome(store, agent, type, { seconds: 10, failed: true, revision: false }, model, at);
const row = (agentId: string, taskType: string, modelVersion: string, p: Partial<VersionScore>): VersionScore =>
  ({ agentId, taskType, modelVersion, runs: 0, quality: 0, avgSeconds: 0, revisions: 0, failures: 0, m2: 0, firstSeen: T0, lastSeen: T0, ...p });
/** Synthetic history: save these version rows and the agent-level roll-up that adds them up (as recordOutcome would have). */
function seed(store: ReturnType<typeof setup>["store"], agentId: string, taskType: string, rows: VersionScore[]) {
  for (const r of rows) store.saveVersionScore(r);
  const all = store.listVersionScores(agentId, taskType), runs = sum(all.map((r) => r.runs));
  store.saveScore({ agentId, taskType, runs, quality: sum(all.map((r) => r.runs * r.quality)) / runs, avgSeconds: 0, revisions: 0, failures: sum(all.map((r) => r.failures)) });
}
// 2.7: a flagged shift is posted quietly (the work log) and waits for the digest, so look for it by what it says.
const visible = (store: ReturnType<typeof setup>["store"]) => store.listMessages(store.listRooms()[0].id).filter((m) => m.text.includes(" changed models "));

// ---------- identity

test("versions: what adapters report is normalised into a version key", () => {
  assert.equal(normaliseModelVersion("claude-opus-5-5-20261001"), "claude-opus-5-5-20261001");
  assert.equal(normaliseModelVersion("  GPT-5.6-Terra "), "gpt-5.6-terra");
  assert.equal(normaliseModelVersion("openai/gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(normaliseModelVersion("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(normaliseModelVersion("claude-opus-5-5-latest"), "claude-opus-5-5");
  assert.equal(normaliseModelVersion("qwen3 coder 30b"), "qwen3-coder-30b");
  assert.equal(normaliseModelVersion("   "), undefined);
  assert.equal(normaliseModelVersion(undefined), undefined);
  assert.notEqual(normaliseModelVersion("claude-opus-5-5-20261001"), normaliseModelVersion("claude-opus-5-5-20270115"), "a new dated snapshot is a new version");
  // reported wins, then the requested model, then unknown
  assert.equal(resolveModelVersion("gpt-5.6-terra", "gpt-5"), "gpt-5.6-terra");
  assert.equal(resolveModelVersion(undefined, "GPT-5"), "gpt-5");
  assert.equal(resolveModelVersion("", undefined), "unknown");
});

test("versions: a run with no reported model is filed under the agent's requested model, else unknown", () => {
  const { store } = setup();
  ok(store, "claude", "coding", 0.8, "", T0);
  assert.equal(store.getVersionScore("claude", "coding", "unknown")?.runs, 1);
  const a = store.getAgent("codex")!;
  store.saveAgent({ ...a, settings: { ...a.settings, model: "GPT-5.6-Terra" } });
  recordOutcome(store, "codex", "coding", { judgment: judged(0.7), seconds: 5, failed: false, revision: false }, undefined, T0);
  assert.equal(store.getVersionScore("codex", "coding", "gpt-5.6-terra")?.runs, 1);
});

// ---------- AC1: keyed by model version

test("versions: runs on two versions are stored separately, and the agent roll-up still adds them up", () => {
  const { store } = setup();
  for (const s of [0.8, 0.9]) ok(store, "codex", "coding", s, "gpt-5.6-terra", T0 + 1);
  for (const s of [0.4, 0.6, 0.5]) ok(store, "codex", "coding", s, "gpt-5.7-terra", T0 + DAY);
  ok(store, "codex", "writing", 0.7, "gpt-5.7-terra", T0 + DAY);
  const a = store.getVersionScore("codex", "coding", "gpt-5.6-terra")!, b = store.getVersionScore("codex", "coding", "gpt-5.7-terra")!;
  assert.equal(a.runs, 2); assert.ok(close(a.quality, 0.85));
  assert.equal(b.runs, 3); assert.ok(close(b.quality, 0.5));
  assert.equal(a.firstSeen, T0 + 1); assert.equal(b.firstSeen, T0 + DAY); assert.equal(b.lastSeen, T0 + DAY);
  assert.equal(store.getVersionScore("codex", "writing", "gpt-5.6-terra"), undefined, "keyed by task type too");
  const roll = store.getScore("codex", "coding");
  assert.equal(roll.runs, 5); assert.ok(close(roll.quality, (0.8 + 0.9 + 0.4 + 0.6 + 0.5) / 5), "scores table is the roll-up");
  assert.equal(store.listVersionScores("codex", "coding").length, 2);
  assert.equal(store.listVersionScores("claude").length, 0);
});

test("versions: history from before 2.4 becomes the unknown version instead of being lost", () => {
  const { store } = setup();
  store.saveScore({ agentId: "claude", taskType: "coding", runs: 10, quality: 0.8, avgSeconds: 12, revisions: 1, failures: 1 });
  assert.equal(store.listVersionScores("claude").length, 0);
  assert.ok(close(expectedFor(store, "claude", "coding", T0), expected(store.getScore("claude", "coding"))), "no version rows: the roll-up is used");
  ok(store, "claude", "coding", 0.8, "claude-opus-5-5-20261001", T0);
  const legacy = store.getVersionScore("claude", "coding", "unknown")!;
  assert.equal(legacy.runs, 10); assert.ok(close(legacy.quality, 0.8)); assert.equal(legacy.failures, 1);
  assert.equal(listShifts(store).length, 0, "moving off unknown is not a model change");
  const wl = 10 * 0.5 ** (1 / 5); // legacy weight per run after one run on the new version
  assert.ok(close(expectedFor(store, "claude", "coding", T0), (wl * 0.76 + 0.8) / (wl + 1), 1e-6), "legacy evidence is blended in, faded by the one new run");
});

test("versions: an owner rating moves the version that did the work, as well as the roll-up", () => {
  const { store } = setup();
  for (const s of [0.8, 0.8]) ok(store, "claude", "coding", s, "v-one", T0);
  for (const s of [0.6, 0.6]) ok(store, "claude", "coding", s, "v-two", T0 + DAY);
  applyOwnerRating(store, "claude", "coding", 0.6, 1, "v-one");
  assert.ok(close(store.getVersionScore("claude", "coding", "v-one")!.quality, 0.8 + 0.4 / 2));
  assert.ok(close(store.getVersionScore("claude", "coding", "v-two")!.quality, 0.6), "the other version is untouched");
  applyOwnerRating(store, "claude", "coding", 0.6, 0.5); // no version named: the current one
  assert.ok(close(store.getVersionScore("claude", "coding", "v-two")!.quality, 0.6 - 0.1 / 2));
  assert.ok(close(store.getScore("claude", "coding").quality, (0.8 * 2 + 0.6 * 2) / 4 + 0.4 / 4 - 0.1 / 4));
});

// ---------- AC2: older evidence fades

test("versions: expected() fades the old version as new-version runs accumulate (exact weights)", () => {
  const { store } = setup();
  // v1: 10 runs at 0.8, last seen at T0. v2: first seen right after. weight on v1 = 0.5^(n/5) * 0.5^(days/30)
  const v1Row = (failures = 0) => row("codex", "coding", "v1", { runs: 10, quality: 0.8, failures, firstSeen: T0 - 10 * DAY, lastSeen: T0 });
  const v2 = (runs: number, failures = 0) => seed(store, "codex", "coding", [v1Row(failures && 4), row("codex", "coding", "v2", { runs, quality: 0.5, firstSeen: T0 + 1, lastSeen: T0 + 1 })]);
  const at = T0;
  const want = (n: number, ageDays = 0) => { const w = 0.5 ** (n / 5) * 0.5 ** ageDays; return (n * 0.5 + 10 * w * 0.8) / (n + 10 * w); };
  v2(5); assert.ok(close(expectedFor(store, "codex", "coding", at), 6.5 / 10), "5 runs: v1 weight 0.5, so (2.5 + 4) / 10 = 0.65");
  assert.ok(close(expectedFor(store, "codex", "coding", at), want(5)));
  v2(10); assert.ok(close(expectedFor(store, "codex", "coding", at), 7 / 12.5), "10 runs: v1 weight 0.25");
  v2(15); assert.ok(close(expectedFor(store, "codex", "coding", at), want(15)));
  v2(1); assert.ok(close(expectedFor(store, "codex", "coding", at), want(1)));
  // monotone: the more the new version has run, the closer expected is to its own mean
  const seq = [1, 2, 3, 5, 8, 13, 21].map((n) => { v2(n); return expectedFor(store, "codex", "coding", at); });
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] < seq[i - 1]);
  // age: 30 days after v1 was last seen its weight halves again
  v2(5);
  assert.ok(close(expectedFor(store, "codex", "coding", T0 + 30 * DAY), want(5, 1)), "age half-life is 30 days");
  assert.ok(close(expectedFor(store, "codex", "coding", T0 + 60 * DAY), want(5, 2)));
  // the current version is never faded by age
  assert.ok(close(expectedFor(store, "codex", "coding", T0 + 3650 * DAY), (5 * 0.5 + 10 * 0.5 * 0.5 ** 121.67 * 0.8) / (5 + 10 * 0.5 * 0.5 ** 121.67), 1e-9));
  // failures fade with their version: expected() of each row is quality * (1 - failRate / 2)
  v2(5, 1);
  const e1 = 0.8 * (1 - 0.5 * 0.4);
  assert.ok(close(expectedFor(store, "codex", "coding", at), (5 * 0.5 + 10 * 0.5 * e1) / 10));
});

test("versions: a version still in use next to the current one is not faded", () => {
  const { store } = setup();
  // an agent whose profiles run two models: neither has been superseded
  seed(store, "claude", "coding", [
    row("claude", "coding", "opus", { runs: 10, quality: 0.9, firstSeen: T0, lastSeen: T0 + 2 * DAY }),
    row("claude", "coding", "sonnet", { runs: 10, quality: 0.5, firstSeen: T0 + DAY, lastSeen: T0 + 3 * DAY }),
  ]);
  const rows = versionRows(store, "claude", T0 + 3 * DAY);
  assert.deepEqual(rows.map((r) => [r.modelVersion, r.weight]), [["sonnet", 1], ["opus", 1]]);
  assert.ok(close(expectedFor(store, "claude", "coding", T0 + 3 * DAY), 0.7));
});

test("versions: a new version with no runs on this task type yet uses the earlier mean plus an uncertainty bump", () => {
  const { store } = setup();
  for (let i = 0; i < 6; i++) ok(store, "codex", "writing", 0.7, "gpt-5.6-terra", T0 + i);
  const before = expectedFor(store, "codex", "writing", T0 + 10);
  assert.ok(close(before, 0.7));
  ok(store, "codex", "coding", 0.7, "gpt-5.7-terra", T0 + 20); // the agent moves to a new version on another task type
  const after = expectedFor(store, "codex", "writing", T0 + 20);
  assert.ok(close(after, 0.8), "0.7 mean plus the 0.1 bump, evidence not faded by run count (no runs on the new version)");
  assert.equal(versionRows(store, "codex", T0 + 20).find((r) => r.taskType === "writing")?.weight, 1);
  assert.ok(expectedFor(store, "codex", "writing", T0 + 20) <= 1);
});

test("versions: decide() probabilities still sum to 1 and use the faded expectation", () => {
  const { store } = setup();
  const agents = store.listAgents();
  // codex: 10 good runs on gpt-5.6, then 5 poor ones on gpt-5.7. The others are steady at 0.6.
  for (let i = 0; i < 10; i++) ok(store, "codex", "coding", 0.9, "gpt-5.6-terra", T0 + i);
  for (let i = 0; i < 5; i++) ok(store, "codex", "coding", 0.4, "gpt-5.7-terra", T0 + 10 + i);
  for (const id of ["claude", "hermes"]) for (let i = 0; i < 10; i++) ok(store, id, "coding", 0.6, "steady", T0 + i);
  const at = T0 + 20; // a few ms after the last run, so the age fade is negligible
  const faded = (5 * 0.4 + 10 * 0.5 * 0.9) / 10; // 0.65; the plain roll-up would say 0.733
  assert.ok(close(expected(store.getScore("codex", "coding")), (10 * 0.9 + 5 * 0.4) / 15), "roll-up for comparison");
  const d = decide(store, agents, "coding", 0.15, [], () => 0.99, {}, at)!;
  const codex = d.candidates.find((c) => c.agentId === "codex")!;
  assert.ok(close(codex.expected, faded, 1e-3), "the record shows the faded value");
  assert.equal(d.agent.id, "codex");
  assert.ok(close(sum(d.candidates.map((c) => c.p)), 1, 1e-3), "probabilities sum to 1");
  assert.ok(close(codex.p, 0.85 + 0.15 / 3, 1e-3));
  // once the new version has run more, the faded value is lower than the others and the pick changes
  for (let i = 0; i < 10; i++) ok(store, "codex", "coding", 0.4, "gpt-5.7-terra", T0 + 30 + i);
  const d2 = decide(store, agents, "coding", 0.15, [], () => 0.99, {}, T0 + 100)!;
  assert.notEqual(d2.agent.id, "codex");
  assert.ok(close(sum(d2.candidates.map((c) => c.p)), 1, 1e-3));
  assert.ok(d2.candidates.find((c) => c.agentId === "codex")!.expected < 0.6);
  // pickAgent and quotaDecide use the same expectation
  assert.equal(pickAgent(store, agents, "coding", 0, [], () => 0.99)!.id, decide(store, agents, "coding", 0, [], () => 0.99)!.agent.id);
  const q = quotaDecide(store, agents, "coding", 0.15, [], () => 0.99);
  assert.equal(q?.candidates.find((c) => c.agentId === "codex")?.expected, decide(store, agents, "coding", 0.15, [], () => 0.99)!.candidates.find((c) => c.agentId === "codex")!.expected);
});

test("versions: if the agent-level roll-up was changed some other way, it wins over stale version rows", () => {
  const { store } = setup();
  for (let i = 0; i < 6; i++) ok(store, "claude", "coding", 0.5, "a", T0 + i);
  assert.ok(close(expectedFor(store, "claude", "coding", T0 + 10), 0.5));
  store.saveScore({ ...store.getScore("claude", "coding"), quality: 0.9 });
  assert.ok(close(expectedFor(store, "claude", "coding", T0 + 10), 0.9));
});

// ---------- AC3: the Room flags a significant shift

test("versions: a significant drop posts exactly one message, audits once, and is not repeated", () => {
  const { store } = setup();
  const room = store.listRooms()[0];
  const v1 = [0.8, 0.85, 0.78, 0.82, 0.8, 0.81], v2 = [0.62, 0.6, 0.64, 0.61, 0.63, 0.62, 0.6];
  v1.forEach((s, i) => ok(store, "codex", "coding", s, "gpt-5.6-terra", T0 + i));
  assert.equal(visible(store).length, 0);
  v2.slice(0, 4).forEach((s, i) => ok(store, "codex", "coding", s, "gpt-5.7-terra", T0 + 2 * DAY + i));
  assert.equal(visible(store).length, 0, "4 runs on the new version is not enough");
  ok(store, "codex", "coding", v2[4], "gpt-5.7-terra", T0 + 2 * DAY + 4);
  const msgs = visible(store);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].roomId, room.id);
  assert.ok(msgs[0].quiet, "a shift is a quiet post, not an interruption");
  assert.equal(attentionFor(store).state().queue.filter((i) => i.kind === "model_shift").length, 1, "and it waits for the evening digest");
  assert.match(msgs[0].text, /^Codex changed models this week \(gpt-5\.6-terra → gpt-5\.7-terra\) and is scoring lower on coding: 0\.62 vs 0\.81 over 5 runs\.$/);
  assert.equal(store.listAudit().filter((a) => a.action === "model.shift").length, 1);
  // more runs on the same pair: nothing more
  v2.slice(5).forEach((s, i) => ok(store, "codex", "coding", s, "gpt-5.7-terra", T0 + 2 * DAY + 10 + i));
  assert.equal(visible(store).length, 1);
  assert.equal(store.listAudit().filter((a) => a.action === "model.shift").length, 1);
  const shifts = listShifts(store).filter((s) => s.kind === "shift");
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].agentId, "codex"); assert.equal(shifts[0].taskType, "coding"); assert.equal(shifts[0].trigger, "quality");
  assert.equal(shifts[0].fromRuns, 6); assert.equal(shifts[0].toRuns, 5); assert.ok(shifts[0].p! < 0.05);
  assert.equal(shifts[0].text, msgs[0].text);
  // a different task type on the same pair is its own finding
  v1.forEach((s, i) => ok(store, "codex", "writing", s, "gpt-5.6-terra", T0 + 100 + i));
  assert.equal(visible(store).length, 1);
});

test("versions: an improvement is flagged too, with the right wording", () => {
  const { store } = setup();
  [0.5, 0.55, 0.52, 0.5, 0.53].forEach((s, i) => ok(store, "claude", "slides", s, "opus-a", T0 + i));
  [0.8, 0.82, 0.79, 0.81, 0.8].forEach((s, i) => ok(store, "claude", "slides", s, "opus-b", T0 + 10 * DAY + i));
  const [m] = visible(store);
  assert.match(m.text, /^Claude changed models recently \(opus-a → opus-b\) and is scoring higher on slides: 0\.80 vs 0\.52 over 5 runs\.$/);
});

test("versions: an insignificant change posts nothing", () => {
  const { store } = setup();
  // small difference
  [0.9, 0.5, 0.8, 0.7, 0.95, 0.6].forEach((s, i) => ok(store, "claude", "coding", s, "a", T0 + i));
  [0.5, 0.9, 0.6, 0.85, 0.55, 0.7].forEach((s, i) => ok(store, "claude", "coding", s, "b", T0 + DAY + i));
  // bigger difference but too noisy to tell (diff 0.13, p well above 0.05)
  [0.9, 0.3, 0.8, 0.5, 0.95, 0.4].forEach((s, i) => ok(store, "codex", "coding", s, "a", T0 + i));
  [0.4, 0.9, 0.2, 0.7, 0.35, 0.5].forEach((s, i) => ok(store, "codex", "coding", s, "b", T0 + DAY + i));
  const [na, nb] = [store.getVersionScore("codex", "coding", "a")!, store.getVersionScore("codex", "coding", "b")!];
  assert.ok(na.quality - nb.quality > 0.1 && welchP(na.runs, na.quality, na.m2, nb.runs, nb.quality, nb.m2) > 0.05, "fixture: big enough gap, too noisy to trust");
  assert.equal(visible(store).length, 0);
  assert.equal(store.listAudit().filter((a) => a.action === "model.shift").length, 0);
  assert.equal(listShifts(store).filter((s) => s.kind === "shift").length, 0);
  // too few runs on the previous version
  [0.9, 0.9, 0.9].forEach((s, i) => ok(store, "hermes", "coding", s, "a", T0 + i));
  [0.2, 0.2, 0.2, 0.2, 0.2, 0.2].forEach((s, i) => ok(store, "hermes", "coding", s, "b", T0 + DAY + i));
  assert.equal(visible(store).length, 0, "needs 5 runs on each version");
});

test("versions: a jump in failure rate is flagged even when quality holds", () => {
  const { store } = setup();
  [0.6, 0.6, 0.6, 0.6, 0.6].forEach((s, i) => ok(store, "codex", "sql", s, "a", T0 + i));
  bad(store, "codex", "sql", "b", T0 + DAY); bad(store, "codex", "sql", "b", T0 + DAY + 1);
  [1, 1, 1].forEach((s, i) => ok(store, "codex", "sql", s, "b", T0 + DAY + 2 + i));
  const [m, ...rest] = visible(store);
  assert.equal(rest.length, 0);
  assert.match(m.text, /^Codex changed models this week \(a → b\) and is failing more often on sql: 2 of 5 runs vs 0 of 5\.$/);
  assert.equal(listShifts(store).find((s) => s.kind === "shift")?.trigger, "failures");
});

test("versions: the first run on a new version is recorded quietly, once", () => {
  const { store } = setup();
  ok(store, "codex", "coding", 0.8, "gpt-5.6-terra", T0);
  assert.equal(listShifts(store).length, 0, "the first version an agent runs on is not a change");
  ok(store, "codex", "coding", 0.8, "gpt-5.7-terra", T0 + DAY);
  ok(store, "codex", "writing", 0.8, "gpt-5.7-terra", T0 + DAY);
  ok(store, "codex", "coding", 0.8, "gpt-5.7-terra", T0 + DAY);
  const all = listShifts(store);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "version_change"); assert.equal(all[0].from, "gpt-5.6-terra"); assert.equal(all[0].to, "gpt-5.7-terra"); assert.equal(all[0].taskType, undefined);
  assert.equal(visible(store).length, 0, "not announced");
  const quiet = store.listMessages(store.listRooms()[0].id).filter((m) => m.quiet);
  assert.equal(quiet.length, 1);
  assert.equal(store.listAudit().filter((a) => a.action === "model.version").length, 1);
  // going back to a version it has run before is not a new version
  ok(store, "codex", "coding", 0.8, "gpt-5.6-terra", T0 + 2 * DAY);
  assert.equal(listShifts(store).length, 1);
  // runs with no version information never count as a change
  ok(store, "claude", "coding", 0.8, "opus-a", T0);
  ok(store, "claude", "coding", 0.8, undefined, T0 + 1);
  assert.equal(listShifts(store).length, 1);
});

test("versions: Welch's t-test matches a worked example", () => {
  // [1..5] vs [2..6]: t = 1, df = 8, two-sided p = 0.3466
  assert.ok(close(welchP(5, 3, 10, 5, 4, 10), 0.3466, 1e-3));
  assert.equal(welchP(5, 0.5, 0, 5, 0.5, 0), 1, "identical, no spread");
  assert.equal(welchP(5, 0.9, 0, 5, 0.5, 0), 0, "no spread, different means");
  assert.ok(close(welchP(5, 0.8, 0.01, 5, 0.8, 0.01), 1, 1e-9));
  assert.equal(welchP(1, 0.8, 0, 5, 0.5, 0.1), 1, "one run is no evidence");
});

// ---------- API

test("versions: GET /scores/versions and GET /model-shifts", async () => {
  const ctx = setup();
  const { store } = ctx;
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}` };
  try {
    const now = Date.now();
    [0.8, 0.85, 0.78, 0.82, 0.8].forEach((s, i) => ok(store, "codex", "coding", s, "gpt-5.6-terra", now - 3 * DAY + i));
    [0.6, 0.58, 0.62, 0.6, 0.61].forEach((s, i) => ok(store, "codex", "coding", s, "gpt-5.7-terra", now - DAY + i));
    ok(store, "claude", "coding", 0.9, "opus", now);
    const rows = (await (await fetch(`${base}/scores/versions?agentId=codex`, { headers: h })).json()) as VersionScoreRow[];
    assert.deepEqual(rows.map((r) => [r.agentId, r.taskType, r.modelVersion, r.current]), [["codex", "coding", "gpt-5.7-terra", true], ["codex", "coding", "gpt-5.6-terra", false]]);
    assert.equal(rows[0].weight, 1); assert.ok(rows[1].weight < 0.5 && rows[1].weight > 0);
    assert.equal(rows[0].runs, 5);
    const all = (await (await fetch(`${base}/scores/versions`, { headers: h })).json()) as VersionScoreRow[];
    assert.equal(all.length, 3);
    assert.equal((await fetch(`${base}/scores/versions`)).status, 401);
    const shifts = (await (await fetch(`${base}/model-shifts`, { headers: h })).json()) as ModelShift[];
    assert.deepEqual(shifts.map((s) => s.kind), ["shift", "version_change"], "newest first");
    assert.match(shifts[0].text, /Codex changed models/);
    // the agent-level roll-up is unchanged
    const scores = (await (await fetch(`${base}/scores`, { headers: h })).json()) as { agentId: string; runs: number }[];
    assert.equal(scores.find((s) => s.agentId === "codex")?.runs, 10);
  } finally { await app.close(); }
});
