import type { ModelShift, Message, VersionScore, VersionScoreRow } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { id, now as clock } from "../util.js";
import { attentionFor } from "../attention/index.js"; // 2.7

/**
 * 2.4 Scores per model version. A vendor ships a new model under the same agent name, so an agent's old results stop
 * predicting its new ones. Each run is kept under the model version that produced it (`version_scores`); the agent-level
 * `scores` table stays as the roll-up. This module holds the pure parts (identity, fading weights, the shift test) and the
 * bookkeeping that runs when a run is recorded. scoring.ts uses it for expected(); nothing here imports scoring.ts.
 */

export const UNKNOWN_VERSION = "unknown";

export const VERSION_TUNING = {
  /** Previous versions' evidence halves for every this many runs on the current version. */
  halfLifeRuns: 5,
  /** ...and halves for every this many days since that version was last seen. */
  halfLifeDays: 30,
  /** Added to the expected score when the agent has moved to a version with no results yet for this task type. */
  uncertaintyBump: 0.1,
  /** Shift test: runs needed on each of the two versions. */
  minRuns: 5,
  /** Mean quality must move by more than this (and Welch p < alpha)... */
  minDiff: 0.1,
  alpha: 0.05,
  /** ...or the failure rate must move by more than this many points (0.2 = 20 points). */
  minFailureDelta: 0.2,
};

const DAY = 86_400_000;
const KV_VERSIONS = "agent_versions";
const KV_SHIFTS = "model_shifts";
const MAX_SHIFTS = 200;

// ---------- identity

/** What adapters report ("claude-opus-5-5-20261001", "openai/GPT-5.6-Terra", "claude-opus-5-5[1m]") reduced to one comparable key. Dated snapshots stay distinct: a new snapshot is a new model. */
export function normaliseModelVersion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let v = raw.trim().toLowerCase();
  v = v.replace(/\[[^\]]*\]\s*$/, "");                 // context-window tags: claude-opus-5-5[1m]
  v = v.replace(/^[a-z0-9_-]+\//, "");                  // provider prefix: openai/gpt-5.6-terra
  v = v.replace(/\s+/g, "-").replace(/-latest$/, "");   // "-latest" says nothing about which model ran
  return v || undefined;
}

/** The version a run is filed under: what the CLI reported, else the model that was asked for, else "unknown". */
export function resolveModelVersion(reported: unknown, requested?: unknown): string {
  return normaliseModelVersion(reported) ?? normaliseModelVersion(requested) ?? UNKNOWN_VERSION;
}

// ---------- fading weights

export interface Evidence { row: VersionScore; weight: number; current: boolean }
export interface VersionEvidence {
  rows: Evidence[];
  /** The agent's current version (last version it ran on, any task type), if known. */
  currentVersion?: string;
  /** Runs on the current version for this task type. */
  currentRuns: number;
  /** The agent has moved to a version this task type has no runs on, so earlier results are all there is. */
  needsBump: boolean;
}

interface AgentVersions { current: string; since: number; seen: string[] }
const registry = (store: Store) => store.getKV<Record<string, AgentVersions>>(KV_VERSIONS, {});

/**
 * Weight per run for every version's evidence, now. The current version counts fully. A version the agent has moved on
 * from counts 0.5^(runs on the current version / halfLifeRuns), and also fades with the days since it was last seen.
 * A version still in use alongside the current one (an agent whose profiles run different models) is not superseded and counts fully.
 */
export function versionEvidence(store: Store, agentId: string, taskType: string, at = clock(), rowsIn?: VersionScore[]): VersionEvidence {
  const rows = rowsIn ?? store.listVersionScores(agentId, taskType);
  if (!rows.length) return { rows: [], currentRuns: 0, needsBump: false };
  const reg = registry(store)[agentId];
  const latest = rows.reduce((a, b) => (b.lastSeen > a.lastSeen || (b.lastSeen === a.lastSeen && b.firstSeen > a.firstSeen) ? b : a));
  const currentVersion = reg?.current ?? latest.modelVersion;
  const cur = rows.find((r) => r.modelVersion === currentVersion);
  const currentRuns = cur?.runs ?? 0;
  // Superseded: last used before the current version first ran (or, with no runs yet on it, before the agent moved to it).
  const movedAt = cur?.firstSeen ?? reg?.since ?? Infinity;
  const runFade = Math.pow(0.5, currentRuns / VERSION_TUNING.halfLifeRuns);
  const out = rows.map((row): Evidence => {
    if (row === cur) return { row, weight: 1, current: true };
    const superseded = row.lastSeen < movedAt;
    const age = Math.pow(0.5, Math.max(0, at - row.lastSeen) / (VERSION_TUNING.halfLifeDays * DAY));
    return { row, weight: superseded ? runFade * age : 1, current: false };
  });
  // No runs on the version it moved to: its earlier results are all there is, so widen the doubt. Not when the only earlier
  // evidence is the "unknown" bucket (pre-2.4 history): that says nothing about a model change.
  const needsBump = !cur && out.some((e) => e.row.modelVersion !== UNKNOWN_VERSION);
  return { rows: out, currentVersion, currentRuns, needsBump };
}

/** GET /scores/versions rows. */
export function versionRows(store: Store, agentId?: string, at = clock()): VersionScoreRow[] {
  const all = store.listVersionScores(agentId);
  const keys = [...new Set(all.map((r) => `${r.agentId}\u0000${r.taskType}`))];
  const out: VersionScoreRow[] = [];
  for (const k of keys) {
    const [a, t] = k.split("\u0000");
    const ev = versionEvidence(store, a, t, at, all.filter((r) => r.agentId === a && r.taskType === t));
    for (const e of ev.rows) out.push({ ...e.row, current: e.row.modelVersion === ev.currentVersion, weight: Math.round(e.weight * 10000) / 10000 });
  }
  return out.sort((x, y) => x.agentId.localeCompare(y.agentId) || x.taskType.localeCompare(y.taskType) || y.lastSeen - x.lastSeen);
}

// ---------- recording

export interface RunStats { quality: number; failed: boolean; revision: boolean; seconds: number; /** 4.5: how much the run counts (default 1) */ weight?: number }

/** File one run under its version. `legacy` is the agent-level roll-up from before this run: if no version has been recorded yet, it becomes the "unknown" version so old evidence isn't lost. */
export function recordVersionRun(store: Store, agentId: string, taskType: string, version: string, run: RunStats, at: number, legacy?: { runs: number; quality: number; avgSeconds: number; revisions: number; failures: number }) {
  if (legacy && legacy.runs > 0 && !store.listVersionScores(agentId, taskType).length) {
    store.saveVersionScore({ agentId, taskType, modelVersion: UNKNOWN_VERSION, runs: legacy.runs, quality: legacy.quality, avgSeconds: legacy.avgSeconds, revisions: legacy.revisions, failures: legacy.failures, m2: 0, firstSeen: at - 1, lastSeen: at - 1 });
  }
  trackVersion(store, agentId, version, at);
  const v = store.getVersionScore(agentId, taskType, version)
    ?? { agentId, taskType, modelVersion: version, runs: 0, quality: 0, avgSeconds: 0, revisions: 0, failures: 0, m2: 0, firstSeen: at, lastSeen: at };
  const w = run.weight ?? 1;
  v.runs += w;
  if (run.failed) v.failures += w;
  if (run.revision) v.revisions += w;
  const d = run.quality - v.quality;
  v.quality += (w * d) / v.runs;
  v.m2 += w * d * (run.quality - v.quality);
  v.avgSeconds += (w * (run.seconds - v.avgSeconds)) / v.runs;
  v.lastSeen = Math.max(v.lastSeen, at);
  store.saveVersionScore(v);
  detectShift(store, agentId, taskType, version, at);
}

/** The version an owner rating applies to: the one named, else the agent's current one. */
export function ratedVersion(store: Store, agentId: string, taskType: string, reported?: unknown): VersionScore | undefined {
  const named = normaliseModelVersion(reported);
  const rows = store.listVersionScores(agentId, taskType);
  const key = named ?? registry(store)[agentId]?.current;
  return rows.find((r) => r.modelVersion === key) ?? (named ? undefined : rows.sort((a, b) => b.lastSeen - a.lastSeen)[0]);
}

// ---------- version changes and shifts

const generalRoom = (store: Store) => store.listRooms().find((r) => r.name === "general") ?? store.listRooms()[0];
const agentName = (store: Store, agentId: string) => store.getAgent(agentId)?.name ?? agentId;
const SYSTEM: Message["author"] = { kind: "system", id: "system", name: "System" };

export const listShifts = (store: Store) => store.getKV<ModelShift[]>(KV_SHIFTS, []);
function pushShift(store: Store, s: Omit<ModelShift, "id">) {
  const all = listShifts(store);
  all.push({ id: id("shift"), ...s });
  store.setKV(KV_SHIFTS, all.slice(-MAX_SHIFTS));
}

/** Notice the first run on a version this agent has not run before. Recorded quietly: a model id changing says nothing yet about results. */
function trackVersion(store: Store, agentId: string, version: string, at: number) {
  if (version === UNKNOWN_VERSION) return;
  const reg = registry(store);
  const cur = reg[agentId];
  if (cur?.current === version) return;
  const seen = cur?.seen ?? [];
  reg[agentId] = { current: version, since: at, seen: seen.includes(version) ? seen : [...seen, version] };
  store.setKV(KV_VERSIONS, reg);
  if (!cur || seen.includes(version)) return; // the agent's first known version, or a return to one it has run before
  const text = `${agentName(store, agentId)} is now running ${version} (was ${cur.current}).`;
  pushShift(store, { at, kind: "version_change", agentId, from: cur.current, to: version, text });
  store.audit("system", "model.version", `${agentId}: ${cur.current} -> ${version}`);
  const room = generalRoom(store);
  if (room) store.addMessage({ roomId: room.id, author: SYSTEM, text, type: "system", mentions: [], quiet: true });
}

/**
 * After a run on `version`: with enough graded runs on it and on the version the agent used before, test whether results moved.
 * Flags once per agent, task type and pair of versions.
 */
export function detectShift(store: Store, agentId: string, taskType: string, version: string, at: number) {
  if (version === UNKNOWN_VERSION) return;
  const T = VERSION_TUNING;
  const rows = store.listVersionScores(agentId, taskType);
  const to = rows.find((r) => r.modelVersion === version);
  if (!to || to.runs < T.minRuns) return;
  // The version it used before: the latest one it has moved on from.
  const from = rows.filter((r) => r.modelVersion !== version && r.modelVersion !== UNKNOWN_VERSION && r.lastSeen < to.firstSeen && r.runs >= T.minRuns)
    .sort((a, b) => b.lastSeen - a.lastSeen)[0];
  if (!from) return;
  if (listShifts(store).some((s) => s.kind === "shift" && s.agentId === agentId && s.taskType === taskType && s.from === from.modelVersion && s.to === version)) return;

  const diff = to.quality - from.quality;
  const p = welchP(from.runs, from.quality, from.m2, to.runs, to.quality, to.m2);
  const qualityShift = Math.abs(diff) > T.minDiff && p < T.alpha;
  const fromFail = from.failures / from.runs, toFail = to.failures / to.runs;
  const failureShift = Math.abs(toFail - fromFail) > T.minFailureDelta;
  if (!qualityShift && !failureShift) return;

  const name = agentName(store, agentId);
  const when = at - from.lastSeen <= 7 * DAY ? "this week" : "recently";
  const head = `${name} changed models ${when} (${from.modelVersion} → ${version})`;
  const text = qualityShift
    ? `${head} and is scoring ${diff < 0 ? "lower" : "higher"} on ${taskType}: ${to.quality.toFixed(2)} vs ${from.quality.toFixed(2)} over ${to.runs} runs.`
    : `${head} and is failing ${toFail > fromFail ? "more" : "less"} often on ${taskType}: ${to.failures} of ${to.runs} runs vs ${from.failures} of ${from.runs}.`;
  pushShift(store, {
    at, kind: "shift", agentId, taskType, from: from.modelVersion, to: version,
    fromQuality: round(from.quality), toQuality: round(to.quality), fromFailRate: round(fromFail), toFailRate: round(toFail),
    fromRuns: from.runs, toRuns: to.runs, p: round(p), trigger: qualityShift ? "quality" : "failures", text,
  });
  store.audit("system", "model.shift", `${agentId} ${taskType}: ${from.modelVersion} -> ${version}, ${text}`);
  const room = generalRoom(store);
  // 2.7: a shift is not an interruption. It goes in the work log (quiet) and waits for the evening digest.
  if (room) store.addMessage({ roomId: room.id, author: SYSTEM, text, type: "system", mentions: [], quiet: true });
  attentionFor(store).notify("model_shift", { title: text, roomId: room?.id, key: `shift:${agentId}:${taskType}:${from.modelVersion}:${version}` });
}

const round = (x: number) => Math.round(x * 10000) / 10000;

// ---------- Welch's two-sample t-test (two-sided)

/** p-value for a difference in means; m2 is each sample's sum of squared deviations. Zero spread on both sides: any difference is certain. */
export function welchP(n1: number, mean1: number, m2a: number, n2: number, mean2: number, m2b: number): number {
  if (n1 < 2 || n2 < 2) return 1;
  const v1 = m2a / (n1 - 1), v2 = m2b / (n2 - 1);
  const se2 = v1 / n1 + v2 / n2;
  const diff = mean2 - mean1;
  if (se2 <= 1e-15) return Math.abs(diff) > 1e-12 ? 0 : 1;
  const t = diff / Math.sqrt(se2);
  const df = (se2 * se2) / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  return incBeta(df / (df + t * t), df / 2, 0.5);
}

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/** Regularised incomplete beta I_x(a, b). */
function incBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaCf(x, a, b)) / a : 1 - (front * betaCf(1 - x, b, a)) / b;
}

function betaCf(x: number, a: number, b: number): number {
  const TINY = 1e-30;
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
