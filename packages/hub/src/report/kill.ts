import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RoutingRecord } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { listJuries } from "../jury/records.js";
import { quotaFor } from "../quota/index.js";
import { isoWeek, weekStart } from "../retro/metrics.js";
import { DAY, clip, mean, pct, round, ymd } from "./periods.js";
import { compareToSingleAgents, enough, type Comparison, type LoggedDecision } from "./ope.js";

/**
 * 2.7 Tooling for kill-criteria review #1 (PRODUCT.md section 15, PLAN.md section 7's checkpoint).
 * Run it with `pnpm review:kill [path to agent-room.db]` (the script is killReview.ts; the logic is here, so the hub can bundle it without running it). It reads the hub's database and writes a Markdown report
 * to the screen and to the Library. It changes nothing else.
 *
 *  (a) Routing doesn't pay: replay the log. After 200 graded tasks, does learned routing beat "always use the single best agent" by 5 points of pass rate?
 *  (b) Juries are worse than the user: do cross-vendor judges disagree with the owner's spot ratings more often than same-vendor ones?
 *  (c) Costs more attention than it saves: minutes the owner spent on approvals against minutes the owner says each accepted task saves.
 *  (d) Subscriptions close: cannot be measured; the report lists what to check by hand.
 */

export const REVIEW = {
  /** Graded tasks needed before the routing replay means anything. */
  minGradedTasks: 200,
  /** The learned policy has to beat the best single agent by this much pass rate (0.05 = 5 points). */
  routingPoints: 0.05,
  /** Fewest decisions of a task type before it gets its own line. */
  minPerType: 30,
  /** Owner ratings needed on each side (same family, other family) before the jury comparison counts. */
  minRatings: 20,
  /** A judge "disagrees" with the owner when its score is this far from the owner's rating (0..1). */
  disagreeAt: 0.2,
  /** Most minutes one approval or plan decision counts for: a card left open overnight was not an overnight of attention. */
  capMinutesPerItem: 5,
};

/** Outcomes that mean a judge graded the attempt. */
const GRADED = new Set(["accepted", "revise", "reassign"]);
/** Picks made by the learned policy itself, so their logged probabilities are the policy's. Revisions, planned owners, commands and the planner's choice are not. */
const POLICY = new Set(["learned", "explore"]);

export type Status = "triggered" | "not triggered" | "not enough data" | "manual" | "needs input";

// ---------------------------------------------------------------- (a) routing

export interface RoutingReview {
  status: Status;
  gradedTasks: number;
  need: number;
  /** Estimated date the log reaches `need` graded tasks, at the pace of the last four weeks. */
  reachesAt?: string;
  perDay: number;
  decisions: number;
  overall?: Comparison;
  byTaskType: { taskType: string; cmp: Comparison }[];
  detail: string;
}

/** The decisions the replay can use: made by the learned policy, with at least two candidates, and graded. */
export function loggedDecisions(records: RoutingRecord[]): { rows: LoggedDecision[]; types: string[] } {
  const rows: LoggedDecision[] = [], types: string[] = [];
  for (const r of records) {
    if (r.kind !== "task" || !POLICY.has(r.reason) || !GRADED.has(r.outcome) || r.candidates.length < 2 || !(r.pChosen > 0)) continue;
    rows.push({ context: r.taskType, chosen: r.chosen, p: r.pChosen, probs: Object.fromEntries(r.candidates.map((c) => [c.agentId, c.p])), reward: r.outcome === "accepted" ? 1 : 0 });
    types.push(r.taskType);
  }
  return { rows, types };
}

export function reviewRouting(records: RoutingRecord[], now: number, o: { force?: boolean } = {}): RoutingReview {
  const first = new Map<string, number>(); // task id -> when it was first graded
  for (const r of records) if (r.kind === "task" && GRADED.has(r.outcome)) { const t = r.completedAt ?? r.at; if (!first.has(r.taskId) || t < first.get(r.taskId)!) first.set(r.taskId, t); }
  const N = first.size;
  const recent = [...first.values()].filter((t) => t >= now - 28 * DAY);
  const spanDays = first.size ? Math.min(28, Math.max(1, (now - Math.min(...first.values())) / DAY)) : 0;
  const perDay = spanDays ? recent.length / spanDays : 0;
  const need = REVIEW.minGradedTasks;
  const { rows } = loggedDecisions(records);
  const base: RoutingReview = { status: "not enough data", gradedTasks: N, need, perDay: round(perDay, 2), decisions: rows.length, byTaskType: [], detail: "" };

  if (N < need && !o.force) {
    const eta = perDay > 0 ? ymd(now + Math.ceil((need - N) / perDay) * DAY) : undefined;
    return { ...base, ...(eta ? { reachesAt: eta } : {}), detail: `not enough data: ${N} of ${need} graded tasks. ${eta ? `At the pace of the last four weeks (${round(perDay, 1)} a day) the log reaches ${need} on about ${eta}. Run the review again then.` : "Nothing was graded in the last four weeks, so there is no date to estimate yet."}` };
  }
  const overall = compareToSingleAgents(rows);
  const types = [...new Set(rows.map((r) => r.context))].sort();
  const byTaskType = types.map((t) => ({ taskType: t, cmp: compareToSingleAgents(rows.filter((r) => r.context === t)) })).filter((x) => x.cmp.n >= REVIEW.minPerType);
  const pre = N < need ? `Preliminary (forced): ${N} of ${need} graded tasks. ` : "";
  if (overall.gap === undefined || !overall.best) return { ...base, overall, byTaskType, detail: `${pre}No single agent has enough logged picks to compare against (needs ${10} picks and a spread-out set of weights).` };
  const pts = overall.gap * 100;
  const status: Status = N < need ? "not enough data" : overall.gap < REVIEW.routingPoints ? "triggered" : "not triggered";
  const ci = overall.interval ? ` 90% interval ${(overall.interval.lo * 100).toFixed(1)} to ${(overall.interval.hi * 100).toFixed(1)}.` : "";
  return {
    ...base, status, overall, byTaskType,
    detail: `${pre}Learned routing passed ${pct(overall.best.logged)} of the ${overall.best.n} decisions it could be compared on; "always ${overall.best.target}" is estimated at ${pct(overall.best.dr)}. Learned routing wins by ${pts.toFixed(1)} points (threshold ${REVIEW.routingPoints * 100}).${ci}`,
  };
}

// ---------------------------------------------------------------- (b) juries

export interface JuryGroupStats { n: number; mean: number | null; disagreeRate: number | null }
export interface JuryReview {
  status: Status;
  rated: number;
  sameVendor: JuryGroupStats;
  crossVendor: JuryGroupStats;
  jury: { n: number; mean: number | null };
  single: { n: number; mean: number | null };
  detail: string;
}

export function reviewJuries(store: Store): JuryReview {
  const rated = listJuries(store).filter((j) => j.owner);
  const judges = rated.flatMap((j) => j.judges.filter((x) => x.distance !== undefined).map((x) => ({ same: x.family === j.workerFamily, d: x.distance! })));
  const stats = (xs: number[]): JuryGroupStats => ({ n: xs.length, mean: xs.length ? round(mean(xs)!) : null, disagreeRate: xs.length ? round(xs.filter((d) => d > REVIEW.disagreeAt).length / xs.length) : null });
  const same = stats(judges.filter((x) => x.same).map((x) => x.d)), cross = stats(judges.filter((x) => !x.same).map((x) => x.d));
  const grp = (kind: (k: string) => boolean) => { const xs = rated.filter((j) => kind(j.kind)).map((j) => j.owner!.juryDistance); return { n: xs.length, mean: xs.length ? round(mean(xs)!) : null }; };
  const out = { rated: rated.length, sameVendor: same, crossVendor: cross, jury: grp((k) => k === "jury"), single: grp((k) => k !== "jury") };
  const m = REVIEW.minRatings;
  if (same.n < m || cross.n < m) return { ...out, status: "not enough data", detail: `not enough owner ratings: ${same.n} judge scores from the worker's own family and ${cross.n} from other families, ${m} of each needed. ${rated.length} judgment${rated.length === 1 ? "" : "s"} rated so far.` };
  const worse = cross.disagreeRate! > same.disagreeRate!;
  return {
    ...out, status: worse ? "triggered" : "not triggered",
    detail: `Other-family judges were more than ${REVIEW.disagreeAt} away from your rating ${pct(cross.disagreeRate)} of the time (${cross.n} scores, mean distance ${cross.mean!.toFixed(2)}); same-family judges ${pct(same.disagreeRate)} (${same.n} scores, mean ${same.mean!.toFixed(2)}).`,
  };
}

// ---------------------------------------------------------------- (c) attention

export interface AttentionWeek { week: string; items: number; spent: number; accepted: number; saved: number | null }
export interface AttentionReview {
  status: Status;
  minutesSavedPerTask: number | null;
  items: number;
  spent: number;
  accepted: number;
  saved: number | null;
  weeks: AttentionWeek[];
  detail: string;
}

export function reviewAttention(store: Store, records: RoutingRecord[]): AttentionReview {
  const cap = REVIEW.capMinutesPerItem;
  const spent = new Map<number, { items: number; minutes: number }>();
  const add = (at: number, minutes: number) => { const w = weekStart(at); const s = spent.get(w) ?? { items: 0, minutes: 0 }; s.items++; s.minutes += Math.min(cap, Math.max(0, minutes)); spent.set(w, s); };
  for (const a of store.listApprovals()) if ((a.status === "approved" || a.status === "rejected") && !a.auto && a.decidedAt !== undefined) add(a.decidedAt, (a.decidedAt - a.createdAt) / 60_000);
  // A plan the owner approved: from the plan card to the approval.
  const planAt = new Map<string, number[]>();
  for (const room of store.listRooms()) for (const m of store.listMessages(room.id, 100_000)) if (m.planGoalId) planAt.set(m.planGoalId, [...(planAt.get(m.planGoalId) ?? []), m.createdAt]);
  for (const [goalId, times] of planAt) {
    const g = store.getGoal(goalId);
    if (!g?.approvedAt) continue;
    const shown = Math.max(...times.filter((t) => t <= g.approvedAt!), 0);
    if (shown) add(g.approvedAt, (g.approvedAt - shown) / 60_000);
  }
  const accepted = new Map<number, Set<string>>();
  for (const r of records) if (r.kind === "task" && r.outcome === "accepted") { const w = weekStart(r.completedAt ?? r.at); accepted.set(w, (accepted.get(w) ?? new Set()).add(r.taskId)); }

  const per = store.getSettings().minutesSavedPerTask;
  const minutesSavedPerTask = typeof per === "number" && per > 0 ? per : null;
  const starts = [...new Set([...spent.keys(), ...accepted.keys()])].sort((a, b) => a - b);
  const weeks: AttentionWeek[] = starts.map((w) => ({
    week: isoWeek(w), items: spent.get(w)?.items ?? 0, spent: round(spent.get(w)?.minutes ?? 0, 1), accepted: accepted.get(w)?.size ?? 0,
    saved: minutesSavedPerTask === null ? null : round((accepted.get(w)?.size ?? 0) * minutesSavedPerTask, 1),
  }));
  const totalSpent = round(weeks.reduce((n, w) => n + w.spent, 0), 1), totalAccepted = weeks.reduce((n, w) => n + w.accepted, 0);
  const items = weeks.reduce((n, w) => n + w.items, 0);
  const saved = minutesSavedPerTask === null ? null : round(totalAccepted * minutesSavedPerTask, 1);
  const base = { minutesSavedPerTask, items, spent: totalSpent, accepted: totalAccepted, saved, weeks };
  if (!weeks.length) return { ...base, status: "not enough data", detail: "No approvals or accepted tasks yet." };
  if (saved === null) return { ...base, status: "needs input", detail: `You spent about ${totalSpent} minutes on ${items} approvals and plans. Enter how many minutes an accepted task saves you (Settings, minutesSavedPerTask) to compare. ${totalAccepted} tasks were accepted.` };
  const worse = weeks.filter((w) => w.saved !== null && w.spent > w.saved).length;
  return {
    ...base, status: totalSpent > saved ? "triggered" : "not triggered",
    detail: `About ${totalSpent} minutes on ${items} approvals and plans, against ${saved} minutes saved (${totalAccepted} accepted tasks at ${minutesSavedPerTask} minutes each). ${worse} of ${weeks.length} week${weeks.length === 1 ? "" : "s"} cost more attention than they saved.`,
  };
}

// ---------------------------------------------------------------- (d) subscriptions

export interface SubscriptionReview {
  status: Status;
  rows: { id: string; provider: string; label: string; kind: string; plan?: string; limited: boolean; rateLimits30d: number; lastRun?: string }[];
  detail: string;
}

export function reviewSubscriptions(store: Store, now: number): SubscriptionReview {
  const quota = quotaFor(store);
  const hits = new Map<string, number>();
  for (const u of quota.ledger.rateLimited(now - 30 * DAY)) hits.set(u.subscriptionId, (hits.get(u.subscriptionId) ?? 0) + 1);
  const last = (id: string) => (store.db.prepare("SELECT MAX(at) a FROM usage WHERE subscription_id=?").get(id) as { a: number | null }).a;
  const rows = quota.statuses(now).map((s) => {
    const l = last(s.subscription.id);
    return { id: s.subscription.id, provider: s.subscription.provider, label: s.subscription.label, kind: s.subscription.kind, ...(s.subscription.plan ? { plan: s.subscription.plan } : {}), limited: s.limited, rateLimits30d: hits.get(s.subscription.id) ?? 0, ...(l ? { lastRun: ymd(l) } : {}) };
  });
  return { status: "manual", rows, detail: "Cannot be measured from the log. Check each provider's current terms by hand." };
}

// ---------------------------------------------------------------- the report

export interface KillReview { generatedAt: number; routing: RoutingReview; juries: JuryReview; attention: AttentionReview; subscriptions: SubscriptionReview; markdown: string }

export function buildKillReview(store: Store, o: { now?: number; force?: boolean } = {}): KillReview {
  const now = o.now ?? Date.now();
  const records = store.listRouting();
  const r: KillReview = { generatedAt: now, routing: reviewRouting(records, now, o), juries: reviewJuries(store), attention: reviewAttention(store, records), subscriptions: reviewSubscriptions(store, now), markdown: "" };
  r.markdown = killReviewMarkdown(r);
  return r;
}

const label: Record<Status, string> = { triggered: "TRIGGERED", "not triggered": "Not triggered", "not enough data": "Not enough data", manual: "Check by hand", "needs input": "Needs your input" };
const est = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const cmpTable = (c: Comparison) => [
  "| Always use | Decisions it applies to | Picked | Policy got | IPS | Self-normalised | Doubly robust | Effective n |", "|---|---|---|---|---|---|---|---|",
  ...c.estimates.map((e) => `| ${e.target}${c.best?.target === e.target ? " (best single agent)" : ""}${enough(e) ? "" : " (too few picks)"} | ${e.n} | ${e.picked} | ${est(e.logged)} | ${est(e.ips)} | ${est(e.snips)} | ${est(e.dr)} | ${e.ess.toFixed(0)} |`),
];

export function killReviewMarkdown(r: KillReview): string {
  const L: string[] = [`# Kill-criteria review, ${ymd(r.generatedAt)}`, "",
    "Where the first three kill criteria in PRODUCT.md section 15 stand. \"Triggered\" means the criterion's own condition is met and its remedy applies.", "",
    "| Criterion | Status |", "|---|---|",
    `| Routing doesn't pay | ${label[r.routing.status]} |`, `| Juries are worse than the user | ${label[r.juries.status]} |`,
    `| Costs more attention than it saves | ${label[r.attention.status]} |`, `| Subscriptions close | ${label[r.subscriptions.status]} |`, ""];

  L.push("## 1. Routing doesn't pay", "", "Condition: after 200 graded tasks, learned routing beats \"always use the single best agent\" by less than 5 points of pass rate. Remedy: drop learned routing and keep the Room as a launcher with cross-checking.", "");
  L.push(r.routing.detail, "");
  if (r.routing.overall) {
    L.push(`Replay over ${r.routing.decisions} logged decisions made by the learned policy (revisions and fixed picks are left out, because they have no choice to replay). Pass rate = accepted / graded.`, "", ...cmpTable(r.routing.overall), "");
    const o = r.routing.overall;
    if (o.best) L.push(`Learned routing against the best single agent (${o.best.target}): ${((o.gap ?? 0) * 100).toFixed(1)} points by the doubly robust estimate, ${o.gapSnips === null || o.gapSnips === undefined ? "n/a" : (o.gapSnips * 100).toFixed(1)} by self-normalised IPS, ${o.gapIps === null || o.gapIps === undefined ? "n/a" : (o.gapIps * 100).toFixed(1)} by plain IPS.`, "");
    if (r.routing.byTaskType.length) {
      L.push("By task type:", "");
      for (const t of r.routing.byTaskType) L.push(`- ${t.taskType} (${t.cmp.n} decisions): policy ${pct(t.cmp.logged)}; ${t.cmp.best ? `best single agent ${t.cmp.best.target} at ${est(t.cmp.best.dr)}, policy ahead by ${((t.cmp.gap ?? 0) * 100).toFixed(1)} points` : "no single agent has enough picks to compare"}.`);
      L.push("");
    }
  }
  L.push(`Graded tasks: ${r.routing.gradedTasks} of ${r.routing.need}.`, "");

  const j = r.juries;
  L.push("## 2. Juries are worse than the user", "", "Condition: cross-vendor judges disagree with your spot ratings more often than same-vendor judges do. Remedy: drop cross-vendor judging.", "", j.detail, "");
  L.push("| Judges | Scores | Mean distance from your rating | Disagree (over " + REVIEW.disagreeAt + ") |", "|---|---|---|---|",
    `| Same family as the worker | ${j.sameVendor.n} | ${j.sameVendor.mean === null ? "n/a" : j.sameVendor.mean.toFixed(2)} | ${pct(j.sameVendor.disagreeRate)} |`,
    `| Another family | ${j.crossVendor.n} | ${j.crossVendor.mean === null ? "n/a" : j.crossVendor.mean.toFixed(2)} | ${pct(j.crossVendor.disagreeRate)} |`, "",
    `For reference, the jury's combined score was ${j.jury.mean === null ? "n/a" : j.jury.mean.toFixed(2)} from your rating over ${j.jury.n} rated juries, and a single judge's ${j.single.mean === null ? "n/a" : j.single.mean.toFixed(2)} over ${j.single.n}.`, "");

  const a = r.attention;
  L.push("## 3. Costs more attention than it saves", "", "Condition: you spend more minutes a week approving and reviewing than the Room saves you. Remedy: cut to two agents and digest-only.", "", a.detail, "");
  if (a.weeks.length) {
    L.push("| Week | Approvals and plans | Minutes spent | Accepted tasks | Minutes saved |", "|---|---|---|---|---|", ...a.weeks.slice(-8).map((w) => `| ${w.week} | ${w.items} | ${w.spent} | ${w.accepted} | ${w.saved === null ? "enter an estimate" : w.saved} |`), "");
  }
  L.push(`Minutes spent are the time from an approval card or plan being shown to your decision, at most ${REVIEW.capMinutesPerItem} minutes each (a card left open overnight is not overnight of attention). Time spent rating judgments and reading results is not measured.`, "");

  L.push("## 4. Subscriptions close", "", "Condition: a provider bars orchestrating its CLI on a subscription. Remedy: that provider moves to API keys only, and the cost model gets re-checked. This is checked by hand.", "");
  L.push("| Plan | Provider | Kind | Limited now | Rate limits, 30 days | Last run |", "|---|---|---|---|---|---|", ...r.subscriptions.rows.map((s) => `| ${clip(s.label, 50)}${s.plan ? ` (${s.plan})` : ""} | ${s.provider} | ${s.kind} | ${s.limited ? "yes" : "no"} | ${s.rateLimits30d} | ${s.lastRun ?? "never"} |`), "",
    "- [ ] For each provider above, read its current terms and help pages: is orchestrating its CLI on a subscription still allowed?", "- [ ] Any provider that says no: move it to an API key and re-run the return ledger.", "");
  return L.join("\n");
}

// ---------------------------------------------------------------- command line

/** `pnpm review:kill [db] [--force] [--no-save] [--library <dir>]` */
export async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const lib = argv.indexOf("--library");
  const libDir = lib >= 0 ? argv[lib + 1] : undefined;
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(lib >= 0 && i === lib + 1));
  if ([...flags].some((f) => !["--force", "--no-save", "--library"].includes(f))) { console.error("Usage: review:kill [path to agent-room.db] [--force] [--no-save] [--library <folder>]"); return 2; }
  // pnpm runs scripts from the package folder: a relative path is meant relative to where the owner typed the command.
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), positional[0] ?? join(process.env.AGENT_ROOM_DATA ?? join(homedir(), ".agent-room"), "agent-room.db"));
  if (!existsSync(file)) { console.error(`No database at ${file}. Pass the path to agent-room.db.`); return 2; }
  const { Store } = await import("../db/store.js");
  const store = new Store(file);
  try {
    const review = buildKillReview(store, { force: flags.has("--force") });
    console.log(review.markdown);
    if (!flags.has("--no-save")) {
      const { Library, defaultLibraryRoot } = await import("../library/library.js");
      const room = store.listRooms().find((r) => r.name === "general") ?? store.listRooms()[0];
      if (!room) { console.error("Not saved to the Library: the database has no rooms yet."); return 0; }
      const { doc } = new Library(store, libDir ?? defaultLibraryRoot()).save({
        title: `Kill-criteria review ${ymd(review.generatedAt)}`, body: review.markdown, roomId: room.id, status: "final", author: "orchestrator", tags: ["kill-review"],
      });
      console.error(`Saved to the Library: ${doc.path}`);
    }
    return 0;
  } finally { store.db.close(); }
}
