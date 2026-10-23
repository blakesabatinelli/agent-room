import type { AgentConfig, QuotaReport, QuotaSettings, QuotaWindowId, Subscription, SubscriptionStatus } from "@agent-room/shared";
import { QUOTA_DEFAULTS } from "@agent-room/shared";
import type { RunResult } from "../adapters/types.js";
import type { Store } from "../db/store.js";
import { applyBurst, applyQuotaHit, MIN_LIMITED_MS } from "./learn.js";
import { QuotaLedger } from "./ledger.js";
import { BURST_COOLDOWN_MS, classifyRateLimit } from "./limits.js";
import { resolveSubscription, seedFor } from "./subscriptions.js";
import { expiresSoon, headroom, predictLimited, windowStatus, windowUsage, type LimitPrediction } from "./windows.js";

/**
 * 1.6 Quota awareness: one service per Store. Tracks what the Room sent to each subscription, predicts when a window
 * is used up, learns the real limit from rate limits, and answers the router. Subscriptions live in the key/value table
 * (no schema change), usage in its own `usage` table (created here).
 */
export class Quota {
  readonly ledger: QuotaLedger;
  constructor(private store: Store) { this.ledger = new QuotaLedger(store.db); }

  // ---- settings and subscriptions
  settings(): QuotaSettings { return { ...QUOTA_DEFAULTS, ...this.store.getKV<Partial<QuotaSettings>>("quota_settings", {}) }; }
  saveSettings(s: Partial<QuotaSettings>): QuotaSettings {
    const next = { ...this.settings(), ...s };
    next.freeMargin = Math.min(1, Math.max(0, next.freeMargin)); next.expiryBonus = Math.min(0.5, Math.max(0, next.expiryBonus)); next.nearLimit = Math.min(1, Math.max(0.5, next.nearLimit));
    this.store.setKV("quota_settings", next);
    this.store.audit("owner", "quota.settings", JSON.stringify(next));
    return next;
  }

  /** The owner's subscriptions. Defaults are added for agents that have none and haven't been seeded before. */
  subscriptions(): Subscription[] {
    const subs = this.store.getKV<Subscription[]>("quota_subscriptions", []);
    const seeded = this.store.getKV<string[]>("quota_seeded", []);
    const agents = this.store.listAgents();
    const add = seedFor(agents, subs, seeded);
    const fresh = agents.map((a) => a.id).filter((id) => !seeded.includes(id));
    if (!add.length && !fresh.length) return subs;
    const next = [...subs, ...add];
    this.store.setKV("quota_subscriptions", next);
    this.store.setKV("quota_seeded", [...seeded, ...fresh]);
    return next;
  }

  /**
   * Owner edit. Limits, plan, label, anchors and which agents a subscription covers come from the owner; what the hub
   * learned (learned limits, reset times, "limited until") stays with the hub, so an edit can't wipe it.
   */
  saveSubscriptions(list: Subscription[]): Subscription[] {
    const old = new Map(this.subscriptions().map((s) => [s.id, s]));
    const next = list.map(({ learned: _ignored, ...s }) => { const l = old.get(s.id)?.learned; return l ? { ...s, learned: l } : s; });
    this.store.setKV("quota_subscriptions", next);
    this.store.setKV("quota_seeded", [...new Set([...this.store.getKV<string[]>("quota_seeded", []), ...this.store.listAgents().map((a) => a.id)])]);
    this.store.audit("owner", "quota.subscriptions", `${next.length} subscriptions: ${next.map((s) => s.label).join(", ")}`);
    return next;
  }

  /** Forget what the hub learned about one subscription (limits, reset times). Owner action. */
  forgetLearned(subId: string) {
    const subs = this.subscriptions().map((s) => { if (s.id !== subId) return s; const { learned: _l, ...rest } = s; return rest; });
    this.store.setKV("quota_subscriptions", subs);
    this.store.audit("owner", "quota.forget", subId);
    return subs;
  }

  subscriptionFor(agentId: string, model?: string) { return resolveSubscription(this.subscriptions(), agentId, model); }
  subscriptionsOf(agentId: string) { return this.subscriptions().filter((s) => s.agentIds.includes(agentId)); }

  // ---- windows
  headroom(sub: Subscription, now = Date.now()) { return headroom(sub, this.ledger, now); }
  expiresSoon(sub: Subscription, now = Date.now()) { return expiresSoon(sub, this.ledger, now); }
  predictLimited(sub: Subscription, now = Date.now()): LimitPrediction { return predictLimited(sub, this.ledger, now, this.settings()); }

  status(sub: Subscription, now = Date.now()): SubscriptionStatus {
    const pred = this.predictLimited(sub, now);
    return {
      subscription: sub,
      windows: { fiveHour: windowStatus(sub, "fiveHour", this.ledger, now), weekly: windowStatus(sub, "weekly", this.ledger, now) },
      ...(this.headroom(sub, now) !== undefined ? { headroom: this.headroom(sub, now) } : {}),
      expiresSoon: this.expiresSoon(sub, now),
      limited: pred.limited,
      ...(pred.limited ? { limitedUntil: pred.until, limitedReason: pred.reason } : {}),
      free: sub.kind === "local",
    };
  }
  statuses(now = Date.now()) { return this.subscriptions().map((s) => this.status(s, now)); }

  /** Is every subscription this agent could run on expected to be rate limited? Agents with none are never held back. */
  agentLimited(agentId: string, now = Date.now()): boolean {
    const subs = this.subscriptionsOf(agentId);
    return subs.length > 0 && subs.every((s) => this.predictLimited(s, now).limited);
  }

  // ---- recording
  /**
   * Record one finished agent run (task, answer, planner or judge call). Called from Orchestrator.call for every run.
   * A rate-limit failure is also checked against what the hub predicted (AC3), taught to the learner, and marks the
   * subscription limited until the reset, so the router stops sending it work.
   */
  recordRun(agent: Pick<AgentConfig, "id" | "settings">, res: RunResult, ctx: { prompt?: string; jsonOnly?: boolean; taskId?: string; model?: string } = {}, now = Date.now()) {
    const model = res.model ?? ctx.model ?? (agent.settings?.model as string | undefined);
    const sub = this.subscriptionFor(agent.id, model);
    if (!sub) return;
    const u = res.usage;
    const reported = !!u && (u.inputTokens !== undefined || u.outputTokens !== undefined);
    const tokensIn = reported ? (u!.inputTokens ?? 0) + (u!.cacheWriteTokens ?? 0) : Math.ceil((ctx.prompt?.length ?? 0) / 4);
    const tokensOut = reported ? (u!.outputTokens ?? 0) : Math.ceil((res.text?.length ?? 0) / 4);
    const rl = res.ok ? undefined : classifyRateLimit(res.error, now);
    const base = { agentId: agent.id, subscriptionId: sub.id, at: now, source: ctx.jsonOnly ? "orchestrator" as const : "task" as const, ...(ctx.taskId ? { taskId: ctx.taskId } : {}), ...(model ? { model } : {}) };

    if (!rl) {
      this.ledger.record({ ...base, tokensIn, tokensOut, runs: 1, rateLimited: false, ...(reported ? {} : { estimated: true }) });
      // A run that started after the mark and worked means the mark was wrong (or the reset came early): lift it.
      if (res.ok && sub.learned?.limitedUntil !== undefined && sub.learned.limitedUntil > now && now - res.durationMs >= (sub.learned.limitedAt ?? 0)) this.clearLimited(sub.id);
      return;
    }
    // The hub's own estimate, taken before this failure changes anything: did it already say this subscription was at its limit?
    const predicted = this.predictLimited(sub, now).limited;
    const win: QuotaWindowId = rl.window ?? "fiveHour";
    const used = windowUsage(sub, win, this.ledger, now);
    const quotaReset = rl.kind === "quota" ? rl.resetAt ?? Math.max(used.end, now + MIN_LIMITED_MS) : undefined;
    const resetAt = quotaReset ?? rl.resetAt ?? now + BURST_COOLDOWN_MS;
    this.ledger.record({ ...base, tokensIn: 0, tokensOut: 0, runs: 1, rateLimited: true, resetAt, predicted });
    this.mutate(sub.id, (s) => (rl.kind === "quota" ? applyQuotaHit(s, win, { tokens: used.tokens, runs: used.runs }, quotaReset!, now) : applyBurst(s, resetAt, now)));
    this.store.audit("hub", "quota.limited", `${sub.label}: ${rl.kind} limit${predicted ? " (predicted)" : ""}, out until ${new Date(resetAt).toISOString()}`);
  }

  private mutate(subId: string, f: (s: Subscription) => Subscription) {
    this.store.setKV("quota_subscriptions", this.subscriptions().map((s) => (s.id === subId ? f(s) : s)));
  }
  private clearLimited(subId: string) {
    this.mutate(subId, (s) => { const { limitedUntil: _u, limitedWindow: _w, limitedAt: _a, ...rest } = s.learned ?? {}; return { ...s, learned: rest }; });
  }

  /** True while a task can still be moved to another agent after a rate limit (bounded, so a day of 429s can't loop forever). */
  mayReroute(taskId: string, agentCount: number) { return this.ledger.rateLimitsForTask(taskId) <= Math.max(3, agentCount * 2); }

  // ---- AC3 measurement
  /** Rate-limit failures in the last `days`, split into ones the hub's own estimate had already flagged (the target is zero) and ones it couldn't have seen. */
  report(days = 7, now = Date.now()): QuotaReport {
    const since = now - days * 86_400_000;
    const labels = new Map(this.subscriptions().map((s) => [s.id, s.label]));
    const out: QuotaReport = { days, since, rateLimitFailures: 0, predicted: 0, unpredicted: 0, bySubscription: {} };
    for (const r of this.ledger.rateLimited(since)) {
      const b = (out.bySubscription[r.subscriptionId] ??= { label: labels.get(r.subscriptionId) ?? r.subscriptionId, rateLimitFailures: 0, predicted: 0, unpredicted: 0 });
      out.rateLimitFailures++; b.rateLimitFailures++;
      if (r.predicted) { out.predicted++; b.predicted++; } else { out.unpredicted++; b.unpredicted++; }
    }
    return out;
  }
}

const cache = new WeakMap<Store, Quota>();
/** The quota service for a store (created on first use, so nothing else has to construct or pass it around). */
export function quotaFor(store: Store): Quota {
  let q = cache.get(store);
  if (!q) { q = new Quota(store); cache.set(store, q); }
  return q;
}
