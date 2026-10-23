import type { AgentConfig, QuotaNote } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { decide, type RouteDecision } from "../orchestrator/routing.js";
import { expected } from "../orchestrator/scoring.js";
import { quotaFor } from "./index.js";

/**
 * 1.6 Quota-aware routing. Runs on the candidate pool BEFORE decide() computes its probabilities, so the logged
 * probabilities describe the pool the policy really chose from:
 *  (a) agents whose subscription is expected to be rate limited are left out (if every candidate is limited, only the
 *      one that frees up first is kept);
 *  (b) local models are a free tier: preferred when their expected quality is within `freeMargin` of the best;
 *  (c) capacity about to expire gets a small score bonus (up to `expiryBonus`), so it's spent rather than lost.
 */
export interface QuotaAdjustment {
  /** Candidates that may be routed to, in their original order. */
  pool: AgentConfig[];
  /** Additive bonus on each agent's expected score, for decide(). */
  bonus: Record<string, number>;
  note: QuotaNote;
  /** Every candidate was limited, so the pool is the one that frees up first (it will probably be limited too). */
  allLimited: boolean;
}

export function quotaAdjust(store: Store, candidates: AgentConfig[], taskType: string, now = Date.now()): QuotaAdjustment {
  const q = quotaFor(store), cfg = q.settings();
  const note: QuotaNote = { excluded: [], boosted: [] };
  const info = candidates.map((agent) => {
    const subs = q.subscriptionsOf(agent.id);
    const preds = subs.map((s) => ({ s, p: q.predictLimited(s, now) }));
    const primary = subs.find((s) => !s.modelMatch) ?? subs[0];
    return {
      agent, primary,
      limited: preds.length > 0 && preds.every((x) => x.p.limited),
      until: Math.max(0, ...preds.map((x) => x.p.until ?? 0)),
      reason: preds[0]?.p.reason ?? "estimated" as "reported" | "estimated",
      free: !!subs.find((s) => s.kind === "local" && !s.modelMatch),
      expiring: primary && primary.kind !== "local" ? q.expiresSoon(primary, now) : 0,
    };
  });

  // (a) leave out what's expected to be rate limited; if that's everyone, keep whoever frees up first
  let keep = info.filter((i) => !i.limited);
  const allLimited = !keep.length && info.length > 0;
  if (allLimited) {
    const soonest = Math.min(...info.map((i) => i.until));
    keep = info.filter((i) => i.until === soonest).slice(0, 1);
  }
  for (const i of info) if (!keep.includes(i)) note.excluded.push({ agentId: i.agent.id, subscriptionId: i.primary!.id, reason: i.reason, until: i.until || undefined });

  // (b) and (c): small, additive, only when there is a choice to make
  const bonus: Record<string, number> = {};
  if (keep.length > 1) {
    const exp = new Map(keep.map((i) => [i.agent.id, expected(store.getScore(i.agent.id, taskType))]));
    const bestRaw = Math.max(...exp.values());
    for (const i of keep) if (!i.free && i.expiring > 0.001) {
      const b = Math.round(cfg.expiryBonus * i.expiring * 10000) / 10000;
      if (b > 0) { bonus[i.agent.id] = b; note.boosted.push({ agentId: i.agent.id, subscriptionId: i.primary!.id, bonus: b, reason: "expiring" }); }
    }
    // Free tier: lift every free agent within the margin of the best (other bonuses included) just past the best, keeping their order.
    const free = keep.filter((i) => i.free && exp.get(i.agent.id)! >= bestRaw - cfg.freeMargin);
    if (free.length) {
      const bestScore = Math.max(...keep.filter((i) => !free.includes(i)).map((i) => exp.get(i.agent.id)! + (bonus[i.agent.id] ?? 0)), -Infinity);
      const topFree = Math.max(...free.map((i) => exp.get(i.agent.id)!));
      if (topFree <= bestScore) {
        const b = Math.round((bestScore - topFree + 0.001) * 10000) / 10000;
        for (const i of free) { bonus[i.agent.id] = b; note.boosted.push({ agentId: i.agent.id, subscriptionId: i.primary!.id, bonus: b, reason: "free_tier" }); }
      }
    }
  }
  return { pool: candidates.filter((a) => keep.some((i) => i.agent === a)), bonus, note, allLimited };
}

/**
 * decide() over the quota-adjusted pool, with the reasons attached for the routing record. `exclude` is the agents that
 * already tried. `busy` is agents that are working but still have quota: if every idle candidate is limited and one of
 * them is not, this returns undefined so the task waits for it instead of going to an agent that will be rate limited.
 */
export function quotaDecide(store: Store, candidates: AgentConfig[], taskType: string, epsilon: number, exclude: string[] = [], rand = Math.random, busy: AgentConfig[] = [], now = Date.now()): RouteDecision | undefined {
  const open = candidates.filter((a) => !exclude.includes(a.id));
  const adj = quotaAdjust(store, open, taskType, now);
  if (adj.allLimited && busy.some((a) => !exclude.includes(a.id) && !quotaFor(store).agentLimited(a.id, now))) return undefined;
  const d = decide(store, adj.pool, taskType, epsilon, [], rand, adj.bonus);
  if (!d) return undefined;
  d.excluded = candidates.filter((a) => exclude.includes(a.id)).map((a) => a.id);
  if (adj.note.excluded.length || adj.note.boosted.length) d.quota = adj.note;
  return d;
}

/** Is this agent held back right now? (assign() skips a planned owner or a revision's agent that is.) */
export function quotaLimited(store: Store, agentId: string, now = Date.now()) { return quotaFor(store).agentLimited(agentId, now); }
