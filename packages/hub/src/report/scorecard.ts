import type { RoutingRecord, Scorecard, ScorecardAgentRow, ScorecardGoalCost, ScorecardGoalRework, ScorecardJudgeGroup, ScorecardTaskType } from "@agent-room/shared";
import { attentionFor } from "../attention/index.js";
import type { Store } from "../db/store.js";
import { listJuries } from "../jury/records.js";
import { quotaFor } from "../quota/index.js";
import { retroDb } from "../retro/index.js";
import { isoWeek } from "../retro/metrics.js";
import { DAY, clip, mean, money, pct, round, weekOf, ymd } from "./periods.js";

/**
 * 2.7 The weekly scorecard (ISO week, Monday to Sunday, UTC): which agent is best at which kind of work, which goals were
 * vague enough to cause rework, how far the judges are from the owner, what each goal cost, how often the Room interrupted, and what it learned.
 * Everything is computed from the routing log, the jury records, the quota ledger, the retro lessons and the attention counters.
 */

/** An agent needs this many graded runs in a week before it can be called the best at a task type. */
export const MIN_GRADED = 3;
const TOP_GOALS = 5;
const TOP_LESSONS = 5;
/** Outcomes that mean the first attempt is over (an interrupted or still-running attempt is not a result). */
const OPEN = new Set(["pending", "interrupted"]);

/** One entry per task: its first finished attempt, with the send-backs it needed after that. */
function firstAttempts(records: RoutingRecord[]) {
  const byTask = new Map<string, RoutingRecord[]>();
  for (const r of records) if (r.kind === "task") byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const out: RoutingRecord[] = [];
  for (const recs of byTask.values()) {
    recs.sort((a, b) => a.at - b.at);
    const first = recs.find((r) => !OPEN.has(r.outcome));
    if (first) out.push(first);
  }
  return out;
}

function bestByTaskType(inWeek: RoutingRecord[], firsts: RoutingRecord[]): ScorecardTaskType[] {
  const types = [...new Set(inWeek.filter((r) => r.kind === "task").map((r) => r.taskType))].sort();
  const out: ScorecardTaskType[] = [];
  for (const taskType of types) {
    const graded = inWeek.filter((r) => r.kind === "task" && r.taskType === taskType && r.judgment);
    const agents: ScorecardAgentRow[] = [...new Set(graded.map((r) => r.chosen))].map((agentId) => {
      const runs = graded.filter((r) => r.chosen === agentId);
      const started = firsts.filter((r) => r.taskType === taskType && r.chosen === agentId);
      return {
        agentId, gradedRuns: runs.length, meanQuality: round(mean(runs.map((r) => r.judgment!.score)) ?? 0),
        firstPass: started.length ? round(started.filter((r) => r.outcome === "accepted").length / started.length) : null, firstPassTasks: started.length,
      };
    }).sort((a, b) => b.meanQuality - a.meanQuality || (b.firstPass ?? -1) - (a.firstPass ?? -1) || b.gradedRuns - a.gradedRuns || a.agentId.localeCompare(b.agentId));
    if (!agents.length) continue;
    const eligible = agents.filter((a) => a.gradedRuns >= MIN_GRADED);
    out.push({
      taskType, agents,
      ...(eligible.length ? { best: eligible[0].agentId } : { note: `No agent has ${MIN_GRADED} graded runs yet (most: ${Math.max(...agents.map((a) => a.gradedRuns))}).` }),
    });
  }
  return out;
}

function vagueGoals(store: Store, inWeek: RoutingRecord[], start: number, end: number): ScorecardGoalRework[] {
  const rows = new Map<string, ScorecardGoalRework>();
  const row = (goalId: string, fallback = "") => {
    let r = rows.get(goalId);
    if (!r) {
      const g = store.getGoal(goalId);
      r = { goalId, goal: clip(g?.contract?.objective ?? g?.text ?? fallback, 120), specFailures: 0, clarifications: 0, revisions: 0 };
      rows.set(goalId, r);
    }
    return r;
  };
  for (const r of inWeek) {
    if (r.kind !== "task") continue;
    if (r.failureTag === "spec") row(r.goalId, r.goalText).specFailures++;
    if (r.revision) row(r.goalId, r.goalText).revisions++;
  }
  // Each time the owner had to say more after the plan was locked (an answer to a question, or an amendment) is one clarification.
  for (const room of store.listRooms()) {
    for (const g of store.listGoals(room.id)) {
      const n = (g.contract?.amendments ?? []).filter((a) => a.at >= start && a.at < end).length;
      if (n) row(g.id, g.text).clarifications += n;
    }
  }
  return [...rows.values()].filter((r) => r.specFailures + r.clarifications > 0)
    .sort((a, b) => (b.specFailures + b.clarifications) - (a.specFailures + a.clarifications) || b.revisions - a.revisions || a.goalId.localeCompare(b.goalId))
    .slice(0, TOP_GOALS);
}

function judgeDistance(store: Store, start: number, end: number): Scorecard["judges"] {
  // A jury's row is written when it judges; the owner's rating can come days later, so look back a while for the ones rated this week.
  const rated = listJuries(store, { since: start - 60 * DAY }).filter((j) => j.owner && j.owner.at >= start && j.owner.at < end);
  const group = (xs: number[]): ScorecardJudgeGroup => ({ n: xs.length, meanDistance: xs.length ? round(mean(xs)!) : null });
  const judges = rated.flatMap((j) => j.judges.filter((x) => x.distance !== undefined).map((x) => ({ family: x.family, same: x.family === j.workerFamily, d: x.distance! })));
  const families = [...new Set(judges.map((x) => x.family))].sort();
  return {
    rated: rated.length,
    jury: group(rated.filter((j) => j.kind === "jury").map((j) => j.owner!.juryDistance)),
    single: group(rated.filter((j) => j.kind !== "jury").map((j) => j.owner!.juryDistance)),
    sameFamily: group(judges.filter((x) => x.same).map((x) => x.d)),
    crossFamily: group(judges.filter((x) => !x.same).map((x) => x.d)),
    byFamily: families.map((family) => { const ds = judges.filter((x) => x.family === family).map((x) => x.d); return { family, n: ds.length, meanDistance: round(mean(ds)!) }; }),
  };
}

function costPerGoal(store: Store, inWeek: RoutingRecord[]): { goals: ScorecardGoalCost[]; total: Scorecard["cost"] } {
  const ledger = quotaFor(store).ledger;
  const byGoal = new Map<string, RoutingRecord[]>();
  for (const r of inWeek) byGoal.set(r.goalId, [...(byGoal.get(r.goalId) ?? []), r]);
  const goals: ScorecardGoalCost[] = [...byGoal].map(([goalId, recs]) => {
    let tokens = 0, estimated = false, cost = 0, anyCost = false;
    for (const r of recs) {
      const u = r.usage;
      if (u && (u.inputTokens !== undefined || u.outputTokens !== undefined)) tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      else {
        // The CLI reported nothing: use what the quota ledger estimated from the text, and say so.
        const rows = ledger.byTask(r.taskId).filter((x) => !x.rateLimited && x.at >= r.at && (r.completedAt === undefined || x.at <= r.completedAt + 1000));
        if (rows.length) { tokens += rows.reduce((n, x) => n + x.tokensIn + x.tokensOut, 0); estimated = true; }
      }
      if (u?.costUsd !== undefined) { cost += u.costUsd; anyCost = true; }
    }
    const accepted = new Set(recs.filter((r) => r.kind === "task" && r.outcome === "accepted").map((r) => r.taskId)).size;
    const g = store.getGoal(goalId);
    const costUsd = anyCost ? round(cost, 4) : null;
    return { goalId, goal: clip(g?.contract?.objective ?? g?.text ?? recs[0].goalText, 100), runs: recs.length, tokens, estimated, costUsd, accepted, costPerAccepted: costUsd !== null && accepted ? round(costUsd / accepted, 4) : null };
  }).sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens || a.goalId.localeCompare(b.goalId));
  const anyCost = goals.some((g) => g.costUsd !== null);
  const costUsd = anyCost ? round(goals.reduce((n, g) => n + (g.costUsd ?? 0), 0), 4) : null;
  const accepted = goals.reduce((n, g) => n + g.accepted, 0);
  return { goals, total: { goals: goals.length, tokens: goals.reduce((n, g) => n + g.tokens, 0), costUsd, accepted, costPerAccepted: costUsd !== null && accepted ? round(costUsd / accepted, 4) : null } };
}

/** The scorecard for one ISO week ("2026-W43", or any moment in it). Defaults to the week that is running now. */
export function buildScorecard(store: Store, week: string | number = Date.now(), opts: { now?: number } = {}): Scorecard {
  const start = weekOf(week);
  if (start === undefined) throw new Error("Week must look like 2026-W43.");
  const end = start + 7 * DAY;
  const records = store.listRouting({ since: start - 30 * DAY });
  const inWeek = records.filter((r) => r.at >= start && r.at < end);
  const firsts = firstAttempts(records).filter((r) => r.at >= start && r.at < end);
  const accepted = firsts.filter((r) => r.outcome === "accepted").length;

  const att = attentionFor(store);
  const first = ymd(start), last = ymd(end - 1);
  const counted = new Map(att.dayRange(first, last).map((x) => [x.day, x.d]));
  const days = Array.from({ length: 7 }, (_, i) => ymd(start + i * DAY)).map((day) => ({ day, interrupts: counted.get(day)?.interrupts ?? 0 }));
  const cost = costPerGoal(store, inWeek);

  const lessons = retroDb(store).list().filter((l) => l.at >= start && l.at < end)
    .sort((a, b) => b.seen - a.seen || b.at - a.at).slice(0, TOP_LESSONS)
    .map((l) => ({ agentId: l.agentId, taskType: l.taskType, text: l.text, goalId: l.goalId }));

  const sc: Scorecard = {
    week: isoWeek(start), start: first, end: last, generatedAt: opts.now ?? Date.now(),
    totals: {
      gradedRuns: inWeek.filter((r) => r.kind === "task" && r.judgment).length, tasks: firsts.length, accepted,
      firstPass: firsts.length ? round(accepted / firsts.length) : null, goals: new Set(inWeek.map((r) => r.goalId)).size,
    },
    bestByTaskType: bestByTaskType(inWeek, firsts),
    vagueGoals: vagueGoals(store, inWeek, start, end),
    judges: judgeDistance(store, start, end),
    costPerGoal: cost.goals.slice(0, 8), cost: cost.total,
    interruptions: {
      total: days.reduce((n, d) => n + d.interrupts, 0), cap: att.settings().dailyInterruptCap,
      overCap: [...counted.values()].reduce((n, d) => n + d.overCap, 0), queued: [...counted.values()].reduce((n, d) => n + d.queued, 0), days,
    },
    lessons, markdown: "",
  };
  sc.markdown = scorecardMarkdown(sc);
  return sc;
}

const dist = (g: ScorecardJudgeGroup) => (g.n ? `${g.meanDistance!.toFixed(2)} (${g.n})` : "no ratings");

export function scorecardMarkdown(s: Scorecard): string {
  const L: string[] = [];
  L.push(`# Scorecard, ${s.week}`, "", `${s.start} to ${s.end} (Monday to Sunday, UTC).`, "");
  L.push(`${s.totals.goals} goal${s.totals.goals === 1 ? "" : "s"} worked on, ${s.totals.tasks} task${s.totals.tasks === 1 ? "" : "s"} finished a first attempt, ${pct(s.totals.firstPass)} accepted first time (${s.totals.accepted} of ${s.totals.tasks}). ${s.totals.gradedRuns} graded run${s.totals.gradedRuns === 1 ? "" : "s"}.`, "");

  L.push("## Best agent for each kind of work", "");
  if (!s.bestByTaskType.length) L.push("No graded work this week.", "");
  else {
    L.push("| Task type | Best | Agent | Graded runs | Mean quality | First time |", "|---|---|---|---|---|---|");
    for (const t of s.bestByTaskType) for (const a of t.agents) L.push(`| ${t.taskType} | ${t.best === a.agentId ? "yes" : ""} | ${a.agentId} | ${a.gradedRuns} | ${a.meanQuality.toFixed(2)} | ${a.firstPass === null ? "none" : `${pct(a.firstPass)} of ${a.firstPassTasks}`} |`);
    L.push("");
    for (const t of s.bestByTaskType) if (t.note) L.push(`- ${t.taskType}: ${t.note}`);
    if (s.bestByTaskType.some((t) => t.note)) L.push("");
  }

  L.push("## Where goals were vague", "");
  if (!s.vagueGoals.length) L.push("No spec failures and no clarifications this week.", "");
  else for (const g of s.vagueGoals) L.push(`- ${g.goal}: ${g.specFailures} spec failure${g.specFailures === 1 ? "" : "s"}, ${g.clarifications} clarification${g.clarifications === 1 ? "" : "s"} from you, ${g.revisions} send-back${g.revisions === 1 ? "" : "s"}.`);
  if (s.vagueGoals.length) L.push("");

  L.push("## How close the judges are to you", "");
  if (!s.judges.rated) L.push("You rated no judgments this week.", "");
  else {
    L.push(`Mean distance from your rating (0 is the same, 1 is the opposite), with the number of ratings:`, "",
      `- A jury: ${dist(s.judges.jury)}. One judge: ${dist(s.judges.single)}.`,
      `- A judge from the worker's own family: ${dist(s.judges.sameFamily)}. From another family: ${dist(s.judges.crossFamily)}.`);
    if (s.judges.byFamily.length) L.push(`- By family: ${s.judges.byFamily.map((f) => `${f.family} ${f.meanDistance.toFixed(2)} (${f.n})`).join(", ")}.`);
    L.push("");
  }

  L.push("## What each goal cost", "");
  if (!s.costPerGoal.length) L.push("No runs this week.", "");
  else {
    L.push("| Goal | Runs | Tokens | Cost | Accepted | Per accepted task |", "|---|---|---|---|---|---|");
    for (const g of s.costPerGoal) L.push(`| ${g.goal} | ${g.runs} | ${g.tokens.toLocaleString("en-US")}${g.estimated ? " (estimated)" : ""} | ${g.costUsd === null ? "not reported" : money(g.costUsd)} | ${g.accepted} | ${g.costPerAccepted === null ? "n/a" : money(g.costPerAccepted)} |`);
    L.push("", `Total: ${s.cost.tokens.toLocaleString("en-US")} tokens, ${s.cost.costUsd === null ? "cost not reported" : `${money(s.cost.costUsd)} at API prices`}, ${s.cost.accepted} accepted. Subscription runs show what they would have cost at API prices; the monthly ledger has what you actually pay.`, "");
  }

  L.push("## Interruptions", "");
  L.push(`${s.interruptions.total} this week (daily cap ${s.interruptions.cap}): ${s.interruptions.days.map((d) => `${d.day.slice(5)} ${d.interrupts}`).join(", ")}.${s.interruptions.overCap ? ` ${s.interruptions.overCap} went through past the cap because work was blocked.` : ""}${s.interruptions.queued ? ` ${s.interruptions.queued} waited for the digest because the cap was used.` : ""}`, "");

  L.push("## What the agents learned", "");
  if (!s.lessons.length) L.push("No new lessons this week.", "");
  else { for (const l of s.lessons) L.push(`- ${l.agentId}, ${l.taskType}: ${l.text}`); L.push(""); }
  return L.join("\n");
}
