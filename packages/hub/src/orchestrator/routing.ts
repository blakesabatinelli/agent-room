import type { AgentConfig, RoutingCandidate, RoutingReason, RoutingRecord, RunUsage, Task } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { id, now } from "../util.js";
import { expected } from "./scoring.js";

/**
 * 0.2 Routing decision log. Every pick is recorded with the probability the policy gave each candidate,
 * so history can be replayed later ("would more tasks have passed if Codex took every SQL task?").
 * History that isn't logged can't be recovered, so this records from the first goal on.
 */

export interface RouteDecision {
  agent: AgentConfig;
  reason: RoutingReason;
  epsilon: number;
  candidates: RoutingCandidate[];
  pChosen: number;
  excluded: string[];
}

/** Each candidate's expected score, in pool order. */
function scored(store: Store, pool: AgentConfig[], taskType: string) {
  return pool.map((a) => { const s = store.getScore(a.id, taskType); return { a, expected: expected(s), runs: s.runs }; });
}

/**
 * Epsilon-greedy over learned scores, with the probabilities it implies.
 * With n candidates, every one gets epsilon/n; the greedy pick (first best in pool order) gets 1-epsilon on top.
 * Uses the same random draws as before, so routing behaviour is unchanged.
 */
export function decide(
  store: Store, candidates: AgentConfig[], taskType: string, epsilon: number,
  exclude: string[] = [], rand = Math.random,
): RouteDecision | undefined {
  const pool = candidates.filter((a) => !exclude.includes(a.id));
  if (!pool.length) return undefined;
  const s = scored(store, pool, taskType);
  let best = 0;
  for (let i = 1; i < s.length; i++) if (s[i].expected > s[best].expected) best = i;
  const n = pool.length;
  const eps = Math.min(1, Math.max(0, epsilon));
  const cands: RoutingCandidate[] = s.map((x, i) => ({ agentId: x.a.id, expected: round(x.expected), runs: x.runs, p: round(eps / n + (i === best ? 1 - eps : 0)) }));
  const excluded = candidates.filter((a) => exclude.includes(a.id)).map((a) => a.id);
  let pick = best, reason: RoutingReason = "learned";
  if (rand() < eps) { pick = Math.floor(rand() * n); reason = "explore"; }
  if (n === 1) return { agent: pool[0], reason: "only_candidate", epsilon: eps, candidates: [{ ...cands[0], p: 1 }], pChosen: 1, excluded };
  return { agent: pool[pick], reason, epsilon: eps, candidates: cands, pChosen: cands[pick].p, excluded };
}

/** A pick that wasn't made by the learned policy (plan owner, revision, planner's choice): p = 1 for the chosen agent. */
export function fixedDecision(store: Store, agent: AgentConfig, others: AgentConfig[], taskType: string, reason: RoutingReason, epsilon: number): RouteDecision {
  const pool = [agent, ...others.filter((a) => a.id !== agent.id)];
  const candidates = scored(store, pool, taskType).map((x) => ({ agentId: x.a.id, expected: round(x.expected), runs: x.runs, p: x.a.id === agent.id ? 1 : 0 }));
  return { agent, reason, epsilon, candidates, pChosen: 1, excluded: [] };
}

const round = (x: number) => Math.round(x * 10000) / 10000;

/** Open a routing record when a task is handed to an agent. */
export function openRecord(store: Store, d: RouteDecision, t: Task, goalText: string, kind: RoutingRecord["kind"] = "task"): RoutingRecord {
  const r: RoutingRecord = {
    id: id("rt"), at: now(), roomId: t.roomId, goalId: t.goalId, goalText: goalText.slice(0, 500),
    taskId: t.id, taskTitle: t.title, taskType: t.taskType, kind,
    attempt: kind === "direct" ? 1 : t.attempts + 1, revision: kind === "task" && t.status === "revising",
    reason: d.reason, epsilon: d.epsilon, candidates: d.candidates, chosen: d.agent.id, pChosen: d.pChosen,
    ...(d.excluded.length ? { excluded: d.excluded } : {}),
    modelRequested: (d.agent.settings?.model as string | undefined) || undefined,
    outcome: "pending",
  };
  store.saveRouting(r);
  return r;
}

/** Fill in what happened. Missing records (e.g. a hub restarted mid-run) are skipped, never invented. */
export function closeRecord(store: Store, routingId: string | undefined, patch: Partial<RoutingRecord>) {
  if (!routingId) return;
  const r = store.getRouting(routingId);
  if (!r) return;
  store.saveRouting({ ...r, ...patch, completedAt: patch.outcome && patch.outcome !== "pending" ? now() : r.completedAt });
}

/** Add one run's usage to another (task retries count toward the same attempt). */
export function addUsage(a: RunUsage | undefined, b: RunUsage | undefined): RunUsage | undefined {
  if (!a) return b; if (!b) return a;
  const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;
  const out: RunUsage = {};
  for (const k of keys) { const v = (a[k] ?? 0) + (b[k] ?? 0); if (a[k] !== undefined || b[k] !== undefined) out[k] = v; }
  return out;
}

/** JSONL export: one record per line, oldest first. */
export function routingJsonl(records: RoutingRecord[]) {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}
