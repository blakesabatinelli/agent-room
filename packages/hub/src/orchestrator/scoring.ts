import type { AgentConfig, AgentScore, Judgment, VersionScore } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { VERSION_TUNING, ratedVersion, recordVersionRun, resolveModelVersion, versionEvidence } from "./versions.js";

/** Expected quality for an agent on a task type, with an optimistic prior for untried agents. */
export function expected(s: AgentScore): number {
  if (s.runs === 0) return 0.7;
  const failRate = s.failures / s.runs;
  return s.quality * (1 - 0.5 * failRate);
}

/**
 * 2.4 Expected quality for an agent on a task type, by model version. The current version's runs count fully; earlier
 * versions' runs count less the more runs the current one has (and the longer since they were seen), so a vendor's new
 * model is judged on its own results. With no runs yet on the current version, the earlier mean is used plus a bump
 * so exploration picks the agent up again. With no per-version history it is the plain roll-up score.
 */
export function expectedFor(store: Store, agentId: string, taskType: string, at = Date.now()): number {
  const roll = store.getScore(agentId, taskType);
  const ev = versionEvidence(store, agentId, taskType, at);
  if (!ev.rows.length || !accountsFor(ev.rows.map((e) => e.row), roll)) return expected(roll);
  let w = 0, sum = 0;
  for (const e of ev.rows) { const k = e.weight * e.row.runs; w += k; sum += k * expected(e.row); }
  const mean = w > 0 ? sum / w : expected(ev.rows[ev.rows.length - 1].row);
  return ev.needsBump ? Math.min(1, mean + VERSION_TUNING.uncertaintyBump) : mean;
}

/** The version rows add up to the agent-level roll-up. If the roll-up was changed some other way (an import, a repair), the roll-up wins. */
function accountsFor(rows: VersionScore[], roll: AgentScore) {
  const n = rows.reduce((a, r) => a + r.runs, 0);
  return n === roll.runs && Math.abs(rows.reduce((a, r) => a + r.runs * r.quality, 0) / n - roll.quality) < 0.01;
}

/** Epsilon-greedy pick among enabled, idle agents. */
export function pickAgent(
  store: Store, candidates: AgentConfig[], taskType: string, epsilon: number,
  exclude: string[] = [], rand = Math.random,
): AgentConfig | undefined {
  const pool = candidates.filter((a) => !exclude.includes(a.id));
  if (!pool.length) return undefined;
  if (rand() < epsilon) return pool[Math.floor(rand() * pool.length)];
  return pool
    .map((a) => ({ a, v: expectedFor(store, a.id, taskType) }))
    .sort((x, y) => y.v - x.v)[0].a;
}

/**
 * `modelVersion` is what the adapter reported for the run (res.model); when it is missing the agent's requested model is used, else "unknown".
 * The run is kept per version (version_scores) as well as in the agent-level roll-up (scores).
 */
export function recordOutcome(
  store: Store, agentId: string, taskType: string,
  outcome: { judgment?: Judgment; seconds: number; failed: boolean; revision: boolean },
  modelVersion?: string, at = Date.now(),
) {
  const s = store.getScore(agentId, taskType);
  const before = { ...s };
  s.runs += 1;
  if (outcome.failed) s.failures += 1;
  if (outcome.revision) s.revisions += 1;
  const q = outcome.failed ? 0 : outcome.judgment?.score ?? 0;
  s.quality += (q - s.quality) / s.runs;
  s.avgSeconds += (outcome.seconds - s.avgSeconds) / s.runs;
  store.saveScore(s);
  // 2.4: the same run under its model version (pre-2.4 history becomes the "unknown" version the first time)
  const version = resolveModelVersion(modelVersion, store.getAgent(agentId)?.settings?.model);
  recordVersionRun(store, agentId, taskType, version, { quality: q, failed: outcome.failed, revision: outcome.revision, seconds: outcome.seconds }, at, before);
}

/** Owner calibration: nudge the agent's score toward the owner's rating. `modelVersion` names the version that did the work (default: its current one). */
export function applyOwnerRating(store: Store, agentId: string, taskType: string, judgeScore: number, owner: number, modelVersion?: string) {
  const s = store.getScore(agentId, taskType);
  if (s.runs === 0) return;
  s.quality = Math.min(1, Math.max(0, s.quality + (owner - judgeScore) / s.runs));
  store.saveScore(s);
  const v = ratedVersion(store, agentId, taskType, modelVersion);
  if (v && v.runs > 0) { v.quality = Math.min(1, Math.max(0, v.quality + (owner - judgeScore) / v.runs)); store.saveVersionScore(v); }
  const cal = store.getKV<{ n: number; absErr: number }>("judge_calibration", { n: 0, absErr: 0 });
  cal.n += 1; cal.absErr += (Math.abs(owner - judgeScore) - cal.absErr) / cal.n;
  store.setKV("judge_calibration", cal);
}
