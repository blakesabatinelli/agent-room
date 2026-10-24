import type { AgentResume, FailureTag, ResumeTypeRow, RoutingRecord } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { listJuries } from "../jury/records.js";
import { UNKNOWN_VERSION, resolveModelVersion } from "../orchestrator/versions.js";
import { retroDb } from "../retro/db.js";
import { now } from "../util.js";
import { probationStatus } from "./probation.js";
import { attemptsOf, isGraded } from "./records.js";
import { renderResume } from "./file.js";
import { RESUME_TUNING } from "./tuning.js";

/**
 * 2.3 Résumés written from the record (PRODUCT.md 6.9: "strong on SQL and refactors; weak on slides").
 *
 * `buildResume` reads the agent's graded runs from the routing log and turns them into short, evidence-backed lines.
 * Every line says the numbers behind it, so the owner can check it ("Strong on coding: 0.86 over 14 runs, 79% first-pass").
 * The thresholds are documented in tuning.ts and written at the end of every RESUME.md.
 */

const TAG_ORDER: FailureTag[] = ["verification", "spec", "misalignment", "placement", "other"];
const REASON: Record<FailureTag, string> = { verification: " for verification", spec: " for unclear specs", misalignment: " for drifting off task", placement: "", other: "" };

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => Math.round(x * 100);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const versionOf = (r: RoutingRecord) => resolveModelVersion(r.modelVersion, r.modelRequested);

// ---------- the owner's spot ratings of an agent's work (rateJudgment feeds this)

interface Ratings { n: number; ownerSum: number; judgeSum: number; absSum: number }
const RATINGS_KEY = "resume.ratings";
export function noteOwnerRating(store: Store, agentId: string, judgeScore: number, ownerScore: number) {
  const all = store.getKV<Record<string, Ratings>>(RATINGS_KEY, {});
  const r = all[agentId] ?? { n: 0, ownerSum: 0, judgeSum: 0, absSum: 0 };
  r.n += 1; r.ownerSum += ownerScore; r.judgeSum += judgeScore; r.absSum += Math.abs(ownerScore - judgeScore);
  all[agentId] = r; store.setKV(RATINGS_KEY, all);
}

// ---------- one task type

/** Per task: the agent's first graded run decides first-pass; the rest are send-back revisions. */
function typeRow(taskType: string, all: RoutingRecord[], attempts: RoutingRecord[], current: string | undefined): ResumeTypeRow {
  const own = current ? all.filter((r) => versionOf(r) === current) : [];
  const currentOnly = own.length >= RESUME_TUNING.minRuns && own.length < all.length;
  const basis = currentOnly ? own : all;
  const firsts = new Map<string, RoutingRecord>();
  for (const r of basis) if (!firsts.has(r.taskId)) firsts.set(r.taskId, r);
  const sentBackRecs = [...firsts.values()].filter((r) => r.outcome !== "accepted");
  const tags = new Map<FailureTag, number>();
  for (const r of sentBackRecs) if (r.failureTag) tags.set(r.failureTag, (tags.get(r.failureTag) ?? 0) + 1);
  const top = [...tags.entries()].sort((a, b) => b[1] - a[1] || TAG_ORDER.indexOf(a[0]) - TAG_ORDER.indexOf(b[0]))[0]?.[0];
  const failures = attempts.filter((r) => r.taskType === taskType && !isGraded(r) && r.outcome === "run_failed").length;
  return {
    taskType, runs: basis.length, quality: mean(basis.map((r) => r.judgment!.score)),
    tasks: firsts.size, sentBack: sentBackRecs.length, firstPass: firsts.size ? (firsts.size - sentBackRecs.length) / firsts.size : null,
    revisions: basis.filter((r) => r.revision).length, runFailures: failures, shadowRuns: basis.filter((r) => r.kind === "shadow").length,
    ...(top ? { topFailure: top } : {}), currentVersionOnly: currentOnly,
  };
}

const isWeak = (t: ResumeTypeRow) => t.runs >= RESUME_TUNING.minRuns
  && (t.quality < RESUME_TUNING.weakQuality || (t.tasks >= RESUME_TUNING.minRuns && t.sentBack / t.tasks >= RESUME_TUNING.weakSentBack));
const isStrong = (t: ResumeTypeRow) => t.runs >= RESUME_TUNING.minRuns && !isWeak(t)
  && t.quality >= RESUME_TUNING.strongQuality && (t.firstPass ?? 0) >= RESUME_TUNING.strongFirstPass;

export function strengthLine(t: ResumeTypeRow, version?: string): string {
  return `Strong on ${t.taskType}: ${t.quality.toFixed(2)} over ${plural(t.runs, "run")}, ${pct(t.firstPass ?? 0)}% first-pass${t.currentVersionOnly && version ? ` (${version})` : ""}`;
}
export function weaknessLine(t: ResumeTypeRow, version?: string): string {
  return `Weak on ${t.taskType}: sent back ${t.sentBack} of ${t.tasks}${t.topFailure ? REASON[t.topFailure] : ""} (${t.quality.toFixed(2)} over ${plural(t.runs, "run")}${t.currentVersionOnly && version ? `, ${version}` : ""})`;
}

// ---------- the whole résumé

export function buildResume(store: Store, agentId: string, at = now()): AgentResume {
  const attempts = attemptsOf(store, agentId);
  const graded = attempts.filter(isGraded);
  const known = [...graded, ...attempts].filter((r) => versionOf(r) !== UNKNOWN_VERSION);
  const newest = [...known].sort((a, b) => b.at - a.at)[0];
  const currentVersion = newest ? versionOf(newest) : undefined;

  const types = [...new Set(graded.map((r) => r.taskType))];
  const byType = types.map((t) => typeRow(t, graded.filter((r) => r.taskType === t), attempts, currentVersion))
    .sort((a, b) => b.runs - a.runs || a.taskType.localeCompare(b.taskType));
  const strengths = byType.filter(isStrong).sort((a, b) => b.quality - a.quality || b.runs - a.runs).slice(0, RESUME_TUNING.maxLines).map((t) => strengthLine(t, currentVersion));
  const weaknesses = byType.filter(isWeak).sort((a, b) => (b.sentBack / b.tasks) - (a.sentBack / a.tasks) || a.quality - b.quality).slice(0, RESUME_TUNING.maxLines).map((t) => weaknessLine(t, currentVersion));

  // All graded runs together: first-pass per task, send-backs per task.
  const firsts = new Map<string, RoutingRecord>();
  for (const r of graded) if (!firsts.has(r.taskId)) firsts.set(r.taskId, r);
  const accepted = [...firsts.values()].filter((r) => r.outcome === "accepted").length;
  const failureMix: Record<FailureTag, number> = { spec: 0, misalignment: 0, verification: 0, placement: 0, other: 0 };
  for (const r of attempts) if (r.failureTag) failureMix[r.failureTag] += 1;

  const juries = listJuries(store).filter((j) => j.worker === agentId);
  const jury = juries.length ? { n: juries.length, majority: Math.round(mean(juries.map((j) => j.agreement.majority)) * 100) / 100, splits: juries.filter((j) => j.split).length } : null;
  const rt = store.getKV<Record<string, Ratings>>(RATINGS_KEY, {})[agentId];
  const owner = rt?.n ? { n: rt.n, ownerMean: round2(rt.ownerSum / rt.n), judgeMean: round2(rt.judgeSum / rt.n), meanDistance: round2(rt.absSum / rt.n) } : null;

  const seen = new Map<string, number>();
  for (const r of known) seen.set(versionOf(r), Math.max(seen.get(versionOf(r)) ?? 0, r.at));
  const modelVersions = [...seen.entries()].sort((a, b) => (a[0] === currentVersion ? -1 : b[0] === currentVersion ? 1 : b[1] - a[1])).map(([v]) => v);

  const lessons = retroDb(store).forAgent(agentId).filter((l) => l.active && !l.retired).sort((a, b) => b.at - a.at)
    .slice(0, RESUME_TUNING.maxLessons).map((l) => `${l.taskType}: ${l.text}`);

  const base: AgentResume = {
    agentId, name: store.getAgent(agentId)?.name ?? agentId, at,
    runs: graded.length, shadowRuns: graded.filter((r) => r.kind === "shadow").length,
    strengths, weaknesses, byType,
    firstPass: firsts.size ? accepted / firsts.size : null,
    revisionsPerTask: firsts.size ? graded.filter((r) => r.revision).length / firsts.size : null,
    failureMix, jury, owner, modelVersions, ...(currentVersion ? { currentVersion } : {}), lessons,
    probation: probationStatus(store, agentId), markdown: "",
  };
  base.markdown = renderResume(base, { today: new Date(at).toISOString().slice(0, 10) }).text;
  return base;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
