import type { HeadToHeadRow, TournamentRun } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { listTournaments } from "./records.js";

/**
 * 4.5 The head-to-head table: for one task type and one pair of agents, how often each was preferred when the same task was done twice and
 * graded blind. The scorecard prints it, and the kill-criteria review reads it next to the routing replay ("always use X" is easier to judge
 * with data where X and Y really did the same tasks). Pure over the `tournaments` rows.
 */

const round = (x: number) => Math.round(x * 10000) / 10000;

/** The agents of a tournament in alphabetical order, with the side each one was on. */
const sides = (t: TournamentRun) => (t.original.agentId <= t.challenger.agentId ? { first: t.original, second: t.challenger, firstIs: "original" as const } : { first: t.challenger, second: t.original, firstIs: "challenger" as const });

export function headToHeadOf(runs: TournamentRun[], taskType?: string): HeadToHeadRow[] {
  const groups = new Map<string, { row: HeadToHeadRow; a: number; b: number }>();
  for (const t of runs) {
    if (taskType && t.taskType !== taskType) continue;
    const { first, second, firstIs } = sides(t);
    const key = `${t.taskType}\u0000${first.agentId}\u0000${second.agentId}`;
    const g = groups.get(key) ?? { row: { taskType: t.taskType, first: first.agentId, second: second.agentId, n: 0, firstWins: 0, secondWins: 0, ties: 0, firstMean: 0, secondMean: 0 }, a: 0, b: 0 };
    g.row.n++; g.a += first.score; g.b += second.score;
    if (t.preference === "tie") g.row.ties++;
    else if (t.preference === firstIs) g.row.firstWins++;
    else g.row.secondWins++;
    groups.set(key, g);
  }
  return [...groups.values()].map(({ row, a, b }) => ({ ...row, firstMean: round(a / row.n), secondMean: round(b / row.n) }))
    .sort((x, y) => y.n - x.n || x.taskType.localeCompare(y.taskType) || x.first.localeCompare(y.first) || x.second.localeCompare(y.second));
}

export function headToHead(store: Store, f: { since?: number; until?: number; taskType?: string } = {}): HeadToHeadRow[] {
  return headToHeadOf(listTournaments(store, { since: f.since, until: f.until }), f.taskType);
}

/** How many tournaments a task type has had, for any pair or for one pair: the router of the night prefers the thinnest. */
export function evidenceCount(runs: TournamentRun[], taskType: string, a?: string, b?: string): number {
  return runs.filter((t) => t.taskType === taskType && (!a || !b || (t.original.agentId === a && t.challenger.agentId === b) || (t.original.agentId === b && t.challenger.agentId === a))).length;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Codex beat Claude on 4 of 6 coding tasks", for the biggest group with a clear winner; undefined when no group has one. */
export function headlineOf(runs: TournamentRun[], name: (agentId: string) => string): string | undefined {
  const best = headToHeadOf(runs)
    .filter((r) => r.firstWins !== r.secondWins)
    .sort((x, y) => y.n - x.n || Math.max(y.firstWins, y.secondWins) - Math.max(x.firstWins, x.secondWins) || x.taskType.localeCompare(y.taskType))[0];
  if (!best) return undefined;
  const firstWon = best.firstWins > best.secondWins;
  const [win, lose] = firstWon ? [best.first, best.second] : [best.second, best.first];
  const wins = firstWon ? best.firstWins : best.secondWins;
  return best.n === 1 ? `${name(win)} beat ${name(lose)} on a ${best.taskType} task` : `${name(win)} beat ${name(lose)} on ${wins} of ${best.n} ${best.taskType} tasks`;
}

/** The one line the digest carries for a night: "Night shift: 9 head-to-head runs on spare quota; Codex beat Claude on 4 of 6 coding tasks". */
export function nightLine(store: Store, night: string): string | undefined {
  const runs = listTournaments(store, { night });
  if (!runs.length) return undefined;
  const head = headlineOf(runs, (id) => store.getAgent(id)?.name ?? id);
  return `Night shift: ${plural(runs.length, "head-to-head run")} on spare quota${head ? `; ${head}` : ""}`;
}
