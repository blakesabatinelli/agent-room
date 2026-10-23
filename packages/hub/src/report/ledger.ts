import type { LedgerRow, ReturnLedger, Subscription } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { quotaFor } from "../quota/index.js";
import { resolveSubscription } from "../quota/subscriptions.js";
import { clip, money, monthOf, parseMonth, round } from "./periods.js";

/**
 * 2.7 The monthly subscription return ledger: tasks the owner accepted on each plan, set against what the plan costs.
 *
 * What counts as the cost of a plan:
 *  - a subscription: the monthly price the owner entered (Subscription.monthlyUsd). Not set: no verdict, just a prompt to set it.
 *  - an api key: the cost the CLI reported for its runs that month (every attempt, accepted or not: you pay for the failures too).
 *  - local: $0.
 *
 * Which plan an accepted task belongs to: the subscription that covers the agent that did the accepted attempt (and, for an agent
 * with two plans such as Hermes, the one whose model pattern matches the model it ran).
 *
 * Verdicts (LEDGER_THRESHOLDS, also printed at the bottom of the report):
 *  - keep: up to $5 per accepted task.
 *  - cancel: fewer than 3 accepted tasks in the month, or more than $15 per accepted task.
 *  - watch: between those.
 *  - upgrade: it would be a keep, but it hit a rate limit 3 or more times that month.
 */
export const LEDGER_THRESHOLDS = { keepUpToUsd: 5, cancelAboveUsd: 15, minAccepted: 3, upgradeRateLimitHits: 3 };

const usd = (x: number) => (Number.isInteger(x) ? `$${x}` : money(x));
const shortName = (label: string) => label.replace(/\s*\((?:subscription|local)\)\s*$/i, "").replace(/\s*\((?:fallback,\s*)?subscription\)\s*$/i, "").trim() || label;
const tasks = (n: number) => `${n} accepted task${n === 1 ? "" : "s"}`;

/** The verdict and the sentence for one plan. Pure, so the thresholds can be tested on their own. */
export function advise(sub: Pick<Subscription, "kind" | "label">, accepted: number, costUsd: number | null, rateLimitHits: number): Pick<LedgerRow, "advice" | "line"> {
  const name = shortName(sub.label);
  if (sub.kind === "local") return { advice: "free", line: accepted ? `${name}: ${tasks(accepted)}, free (runs on this Mac).` : `${name}: not used this month, free.` };
  if (costUsd === null) return { advice: "set_price", line: `${name}: ${tasks(accepted)}. Enter what you pay each month to see the cost per task.` };
  const T = LEDGER_THRESHOLDS;
  if (sub.kind === "api" && costUsd === 0 && !accepted) return { advice: "no_data", line: `${name}: not used this month.` };
  if (!accepted) return { advice: "cancel", line: `${name}: 0 accepted for ${usd(costUsd)}. Consider cancelling.` };
  const per = costUsd / accepted;
  const head = `${name}: ${tasks(accepted)} for ${usd(costUsd)}, ${money(per)} each.`;
  if (accepted < T.minAccepted) return { advice: "cancel", line: `${name}: ${accepted} accepted for ${usd(costUsd)}. Consider cancelling.` };
  if (per > T.cancelAboveUsd) return { advice: "cancel", line: `${head} Consider cancelling.` };
  if (per <= T.keepUpToUsd) {
    if (rateLimitHits >= T.upgradeRateLimitHits) return { advice: "upgrade", line: `${head} It hit its limit ${rateLimitHits} times; consider a bigger plan.` };
    return { advice: "keep", line: `${head} Keep.` };
  }
  return { advice: "watch", line: `${head} Worth watching.` };
}

/** The return ledger for one month ("2026-10"). Defaults to the month that is running now. */
export function buildLedger(store: Store, month: string = monthOf(Date.now()), opts: { now?: number } = {}): ReturnLedger {
  const range = parseMonth(month);
  if (!range) throw new Error("Month must look like 2026-10.");
  const quota = quotaFor(store);
  const subs = quota.subscriptions();
  const records = store.listRouting({ since: range.start - 7 * 86_400_000 }).filter((r) => { const t = r.completedAt ?? r.at; return t >= range.start && t < range.end; });

  const acceptedBy = new Map<string, Set<string>>();
  const reported = new Map<string, number>();
  for (const r of records) {
    const sub = resolveSubscription(subs, r.chosen, r.modelVersion ?? r.modelRequested);
    if (!sub) continue;
    if (r.kind === "task" && r.outcome === "accepted") acceptedBy.set(sub.id, (acceptedBy.get(sub.id) ?? new Set()).add(r.taskId));
    if (r.usage?.costUsd !== undefined) reported.set(sub.id, (reported.get(sub.id) ?? 0) + r.usage.costUsd);
  }
  const limited = new Map<string, number>();
  for (const u of quota.ledger.rateLimited(range.start)) if (u.at < range.end) limited.set(u.subscriptionId, (limited.get(u.subscriptionId) ?? 0) + 1);

  const rows: LedgerRow[] = subs.map((sub) => {
    const accepted = acceptedBy.get(sub.id)?.size ?? 0;
    let costUsd: number | null, costBasis: LedgerRow["costBasis"];
    if (sub.kind === "local") { costUsd = 0; costBasis = "local"; }
    else if (sub.kind === "api") { costUsd = round(reported.get(sub.id) ?? 0, 4); costBasis = "reported cost"; }
    else if (typeof sub.monthlyUsd === "number" && Number.isFinite(sub.monthlyUsd)) { costUsd = sub.monthlyUsd; costBasis = "monthly price"; }
    else { costUsd = null; costBasis = "not set"; }
    const hits = limited.get(sub.id) ?? 0;
    return {
      subscriptionId: sub.id, label: sub.label, kind: sub.kind, ...(sub.plan ? { plan: sub.plan } : {}), accepted, costUsd, costBasis,
      costPerAccepted: costUsd !== null && accepted ? round(costUsd / accepted, 4) : null, rateLimitHits: hits, ...advise(sub, accepted, costUsd, hits),
    };
  });
  const totalCost = rows.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const totalAccepted = rows.reduce((n, r) => n + r.accepted, 0);
  const ledger: ReturnLedger = {
    month, generatedAt: opts.now ?? Date.now(), rows,
    total: { accepted: totalAccepted, costUsd: round(totalCost, 4), costPerAccepted: totalAccepted ? round(totalCost / totalAccepted, 4) : null },
    thresholds: LEDGER_THRESHOLDS, markdown: "",
  };
  ledger.markdown = ledgerMarkdown(ledger);
  return ledger;
}

export function ledgerMarkdown(l: ReturnLedger): string {
  const T = l.thresholds;
  const L: string[] = [`# Subscription return ledger, ${l.month}`, "", "Tasks you accepted on each plan this month, against what the plan costs.", ""];
  for (const r of l.rows) L.push(`- ${r.line}`);
  L.push("", "| Plan | Kind | Accepted | Cost | Basis | Per accepted task | Rate-limit hits |", "|---|---|---|---|---|---|---|");
  for (const r of l.rows) L.push(`| ${clip(r.label, 60)}${r.plan ? ` (${r.plan})` : ""} | ${r.kind} | ${r.accepted} | ${r.costUsd === null ? "not set" : usd(r.costUsd)} | ${r.costBasis} | ${r.costPerAccepted === null ? "n/a" : money(r.costPerAccepted)} | ${r.rateLimitHits} |`);
  L.push("", `All plans: ${tasks(l.total.accepted)} for ${usd(l.total.costUsd)}${l.total.costPerAccepted === null ? "" : `, ${money(l.total.costPerAccepted)} each`}.`, "");
  L.push("How the verdicts are decided:", "",
    `- Keep: up to ${usd(T.keepUpToUsd)} per accepted task.`,
    `- Consider cancelling: fewer than ${T.minAccepted} accepted tasks in the month, or more than ${usd(T.cancelAboveUsd)} per accepted task.`,
    `- Worth watching: in between.`,
    `- Consider a bigger plan: it would be a keep, but it hit a rate limit ${T.upgradeRateLimitHits} or more times.`,
    "- A subscription costs the monthly price you entered; an api key costs what its runs reported; a local model is free.", "");
  return L.join("\n");
}
