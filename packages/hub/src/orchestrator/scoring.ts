import type { AgentConfig, AgentScore, Judgment } from "@agent-room/shared";
import type { Store } from "../db/store.js";

/** Expected quality for an agent on a task type, with an optimistic prior for untried agents. */
export function expected(s: AgentScore): number {
  if (s.runs === 0) return 0.7;
  const failRate = s.failures / s.runs;
  return s.quality * (1 - 0.5 * failRate);
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
    .map((a) => ({ a, v: expected(store.getScore(a.id, taskType)) }))
    .sort((x, y) => y.v - x.v)[0].a;
}

export function recordOutcome(
  store: Store, agentId: string, taskType: string,
  outcome: { judgment?: Judgment; seconds: number; failed: boolean; revision: boolean },
) {
  const s = store.getScore(agentId, taskType);
  s.runs += 1;
  if (outcome.failed) s.failures += 1;
  if (outcome.revision) s.revisions += 1;
  const q = outcome.failed ? 0 : outcome.judgment?.score ?? 0;
  s.quality += (q - s.quality) / s.runs;
  s.avgSeconds += (outcome.seconds - s.avgSeconds) / s.runs;
  store.saveScore(s);
}

/** Owner calibration: nudge the agent's score toward the owner's rating. */
export function applyOwnerRating(store: Store, agentId: string, taskType: string, judgeScore: number, owner: number) {
  const s = store.getScore(agentId, taskType);
  if (s.runs === 0) return;
  s.quality = Math.min(1, Math.max(0, s.quality + (owner - judgeScore) / s.runs));
  store.saveScore(s);
  const cal = store.getKV<{ n: number; absErr: number }>("judge_calibration", { n: 0, absErr: 0 });
  cal.n += 1; cal.absErr += (Math.abs(owner - judgeScore) - cal.absErr) / cal.n;
  store.setKV("judge_calibration", cal);
}
