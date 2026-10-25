import type { AgentUsageLeft, QuotaWindowStatus, SubscriptionStatus, UsageLeftResponse, UsageLeftStatus, UsageLeftSubscription, UsageLeftWindow } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { Quota } from "./index.js";

/**
 * Usage left, per enabled agent (GET /agents/usage). A view over the 1.6 quota computations: nothing here measures or guesses.
 * A limit that is not known yet is "learning" and never gets a percentage.
 *
 * Status from the tightest known window: more than 40% left is "plenty", 40% down to 15% "getting low", 15% or less "almost out".
 * "out" is the quota service's own call (a rate limit a CLI reported and is still in force, or a window used up to the near-limit mark).
 */
export const GETTING_LOW_AT = 0.4;
export const ALMOST_OUT_AT = 0.15;

const RANK: Record<UsageLeftStatus, number> = { unlimited: 0, plenty: 1, learning: 2, getting_low: 3, almost_out: 4, out: 5 };
const LABEL = { fiveHour: "5-hour", weekly: "weekly" } as const;

/** "3:15 PM" within a day, else "Mon 9:00 AM" (hub's local time; the apps may format `outUntil` themselves). */
export function untilText(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return at - now < 20 * 3600_000 ? time : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

function windowView(w: QuotaWindowStatus): UsageLeftWindow {
  return {
    window: w.window, label: LABEL[w.window], usedTokens: w.usedTokens, usedRuns: w.usedRuns,
    ...(w.limitTokens !== undefined ? { limitTokens: w.limitTokens } : {}), ...(w.limitRuns !== undefined ? { limitRuns: w.limitRuns } : {}),
    ...(w.limitSource ? { limitSource: w.limitSource } : {}),
    learning: w.headroom === undefined, ...(w.headroom !== undefined ? { percentLeft: Math.round(w.headroom * 100) } : {}), resetAt: w.resetsAt,
  };
}

function subscriptionView(st: SubscriptionStatus, now: number): UsageLeftSubscription {
  const sub = st.subscription;
  const base = { subscriptionId: sub.id, name: sub.label, ...(sub.plan ? { plan: sub.plan } : {}), kind: sub.kind, free: st.free, fiveHour: windowView(st.windows.fiveHour), weekly: windowView(st.windows.weekly) };
  if (st.free) return { ...base, status: "unlimited", statusText: "unlimited" };
  const percentLeft = st.headroom !== undefined ? Math.round(st.headroom * 100) : undefined;
  const pct = percentLeft !== undefined ? { percentLeft } : {};
  if (st.limited && st.limitedUntil !== undefined) return { ...base, ...pct, status: "out", statusText: `out until ${untilText(st.limitedUntil, now)}`, outUntil: st.limitedUntil };
  if (st.headroom === undefined) return { ...base, status: "learning", statusText: "learning your limits" };
  if (st.headroom <= ALMOST_OUT_AT + 1e-9) return { ...base, ...pct, status: "almost_out", statusText: "almost out" };
  if (st.headroom <= GETTING_LOW_AT + 1e-9) return { ...base, ...pct, status: "getting_low", statusText: "getting low" };
  return { ...base, ...pct, status: "plenty", statusText: "plenty" };
}

/** Every enabled agent with what is left on each subscription it can run on. */
export function usageLeft(store: Store, quota: Quota, now = Date.now()): UsageLeftResponse {
  const agents: AgentUsageLeft[] = store.listAgents().filter((a) => a.enabled).map((a) => {
    const subscriptions = quota.subscriptionsOf(a.id).map((s) => subscriptionView(quota.status(s, now), now));
    // The agent can still run while any one subscription has room, so it shows the best of them.
    const best = subscriptions.length ? subscriptions.reduce((x, y) => (RANK[y.status] < RANK[x.status] ? y : x)) : undefined;
    return {
      agentId: a.id, agentName: a.name, subscriptions,
      status: best?.status ?? "learning", statusText: best?.statusText ?? "learning your limits",
      ...(best?.percentLeft !== undefined ? { percentLeft: best.percentLeft } : {}), ...(best?.outUntil !== undefined ? { outUntil: best.outUntil } : {}),
      free: subscriptions.some((s) => s.free),
    };
  });
  return { at: now, agents };
}
