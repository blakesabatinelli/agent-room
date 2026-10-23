import { PROBATION_RUNS_DEFAULT, type ProbationStatus } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { now } from "../util.js";
import { gradedOf } from "./records.js";

/**
 * 2.3 Probation (PRODUCT.md 6.9: "A new agent starts on probation with shadow tasks").
 *
 * An agent on probation never owns real work. It practises on copies of real tasks (resume/shadow.ts) until it has
 * `probationRuns` graded runs, real or shadow (setting, default 5). The state is one KV record per agent:
 *  - no record: not on probation (the seeded and demo agents, agents that were here before this item, agents that
 *    already had enough graded runs when they were added);
 *  - `on: true`: on probation; only runs graded at or after `since` count (a new agent counts everything, so an agent
 *    added again keeps the runs it already has; an owner restart counts from the restart);
 *  - `on: false`: finished, by reaching the threshold or because the owner ended it.
 */

const KEY = "probation";

export interface ProbationState {
  on: boolean;
  since: number;
  startedBy: "new" | "owner";
  endedAt?: number;
  endedBy?: "threshold" | "owner";
  /** Mean quality and run count at the end, for the résumé and the graduation line. */
  mean?: number | null;
  runs?: number;
}

const all = (store: Store) => store.getKV<Record<string, ProbationState>>(KEY, {});
const save = (store: Store, m: Record<string, ProbationState>) => store.setKV(KEY, m);

/** Graded runs an agent needs (the `probationRuns` setting, 1 to 50). */
export function probationRuns(store: Store): number {
  const n = Number(store.getSettings().probationRuns ?? PROBATION_RUNS_DEFAULT);
  return Number.isFinite(n) ? Math.min(50, Math.max(1, Math.round(n))) : PROBATION_RUNS_DEFAULT;
}

export const probationState = (store: Store, agentId: string): ProbationState | undefined => all(store)[agentId];
export const onProbation = (store: Store, agentId: string): boolean => all(store)[agentId]?.on === true;
export const probationAgentIds = (store: Store): string[] => Object.entries(all(store)).filter(([, s]) => s.on).map(([id]) => id);

/** Graded runs since `since`, how many were shadow runs, and their mean quality. */
export function countRuns(store: Store, agentId: string, since = 0) {
  const runs = gradedOf(store, agentId).filter((r) => r.at >= since);
  const shadowRuns = runs.filter((r) => r.kind === "shadow").length;
  const mean = runs.length ? runs.reduce((s, r) => s + r.judgment!.score, 0) / runs.length : null;
  return { graded: runs.length, shadowRuns, mean };
}

export function probationStatus(store: Store, agentId: string): ProbationStatus {
  const st = probationState(store, agentId);
  const needed = probationRuns(store);
  const c = countRuns(store, agentId, st?.since ?? 0);
  if (!st) return { on: false, graded: c.graded, needed, shadowRuns: c.shadowRuns };
  return {
    on: st.on, graded: st.on ? c.graded : st.runs ?? c.graded, needed, since: st.since, startedBy: st.startedBy,
    ...(st.endedAt ? { endedAt: st.endedAt, endedBy: st.endedBy, mean: st.mean ?? null } : {}),
    shadowRuns: c.shadowRuns,
  };
}

/**
 * Put an agent on probation. A new agent (POST /agents, discovery) that already has `probationRuns` graded runs is not
 * put on it: it has a record. An owner restart always starts (`force`). Returns the state, or undefined when not started.
 */
export function startProbation(store: Store, agentId: string, by: "new" | "owner", at = now()): ProbationState | undefined {
  if (by === "new" && countRuns(store, agentId).graded >= probationRuns(store)) return undefined;
  const m = all(store);
  if (by === "new" && m[agentId]?.on) return m[agentId];
  const st: ProbationState = { on: true, since: by === "owner" ? at : 0, startedBy: by };
  m[agentId] = st; save(store, m);
  store.audit(by === "owner" ? "owner" : "hub", "probation.started", `${agentId}: ${by === "owner" ? "restarted by the owner" : "new agent"}, needs ${probationRuns(store)} graded runs`);
  return st;
}

/** End probation. Returns the status as it ended, or undefined when the agent wasn't on probation. */
export function endProbation(store: Store, agentId: string, by: "threshold" | "owner", at = now()): ProbationStatus | undefined {
  const m = all(store);
  const st = m[agentId];
  if (!st?.on) return undefined;
  const c = countRuns(store, agentId, st.since);
  m[agentId] = { ...st, on: false, endedAt: at, endedBy: by, mean: c.mean, runs: c.graded };
  save(store, m);
  store.audit(by === "owner" ? "owner" : "orchestrator", "probation.ended", `${agentId}: ${by === "owner" ? "ended by the owner" : "reached the threshold"} after ${c.graded} graded run${c.graded === 1 ? "" : "s"}${c.mean === null ? "" : `, mean ${c.mean.toFixed(2)}`}`);
  return probationStatus(store, agentId);
}

/**
 * The agents real work may go to: everyone except agents on probation. If that would leave nobody (every connected agent
 * is on probation, e.g. a first install with one new agent), probation is not applied: the owner's work comes first.
 */
export function realAgents<T extends { id: string }>(store: Store, agents: T[]): T[] {
  const on = new Set(probationAgentIds(store));
  if (!on.size) return agents;
  const real = agents.filter((a) => !on.has(a.id));
  return real.length ? real : agents;
}

/**
 * Agents real work must not go to: those on probation. If that would be every enabled agent (a first install with one new
 * agent), nobody is barred: the owner's work comes first.
 */
export function barredSet(store: Store, enabled: { id: string }[]): Set<string> {
  const on = new Set(probationAgentIds(store));
  const barred = new Set(enabled.filter((a) => on.has(a.id)).map((a) => a.id));
  return barred.size >= enabled.length ? new Set() : barred;
}
