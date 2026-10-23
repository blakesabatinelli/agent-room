import type { FailureTag, Judgment, JuryAgreement, Task, Verdict } from "@agent-room/shared";

/** One judge's read of the work, after its reply was cleaned up. */
export interface JudgeRead {
  agentId: string;
  family: string;
  local: boolean;
  model?: string;
  score: number;
  verdict: Judgment["verdict"];
  feedback: string;
  criteria: Record<string, { verdict: Verdict; evidence: string }>;
  onTask: boolean;
  drift?: string;
  failureCategory?: FailureTag;
}

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** The most common value; null on a tie for first place. */
function plurality<T extends string>(votes: T[]): T | null {
  const n = new Map<T, number>();
  for (const v of votes) n.set(v, (n.get(v) ?? 0) + 1);
  const top = Math.max(...n.values());
  const winners = [...n].filter(([, c]) => c === top);
  return winners.length === 1 ? winners[0][0] : null;
}

/**
 * Fleiss' kappa. `counts[i][j]` = how many raters put subject i in category j; every row sums to the same n raters.
 * 1 = perfect agreement, 0 = no better than chance. null when it can't be told (fewer than 2 subjects or raters, or
 * uneven rows). When every rating is in one category chance agreement is already 1 and the formula divides by zero:
 * that is perfect agreement, so it returns 1.
 */
export function fleissKappaFromCounts(counts: number[][]): number | null {
  const N = counts.length;
  if (N < 2) return null;
  const n = counts[0].reduce((a, b) => a + b, 0);
  if (n < 2 || counts.some((r) => r.reduce((a, b) => a + b, 0) !== n)) return null;
  const cats = counts[0].length;
  const pBar = counts.reduce((sum, row) => sum + (row.reduce((a, c) => a + c * c, 0) - n) / (n * (n - 1)), 0) / N;
  let pe = 0;
  for (let j = 0; j < cats; j++) { const pj = counts.reduce((a, row) => a + row[j], 0) / (N * n); pe += pj * pj; }
  if (pe >= 1) return pBar >= 1 ? 1 : null;
  return (pBar - pe) / (1 - pe);
}

/** Fleiss' kappa from ratings[subject][rater] labels. */
export function fleissKappa(ratings: string[][]): number | null {
  const cats = [...new Set(ratings.flat())];
  return fleissKappaFromCounts(ratings.map((row) => cats.map((c) => row.filter((x) => x === c).length)));
}

const VERDICTS: Verdict[] = ["PASS", "FAIL", "UNSURE"];

/** Agreement among the judges: share with the final verdict, pairwise, kappa over criterion verdicts, and score spread. */
export function agreementOf(judges: Pick<JudgeRead, "verdict" | "score" | "criteria">[], finalVerdict: Judgment["verdict"], criterionIds: string[]): JuryAgreement {
  const n = judges.length;
  if (!n) return { majority: 1, pairwise: 1, kappa: null, spread: 0 };
  const majority = judges.filter((j) => j.verdict === finalVerdict).length / n;
  let same = 0, pairs = 0;
  for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) { pairs++; if (judges[i].verdict === judges[k].verdict) same++; }
  const ids = criterionIds.filter((id) => judges.every((j) => j.criteria[id]));
  const kappa = n >= 2 && ids.length >= 2
    ? fleissKappaFromCounts(ids.map((id) => VERDICTS.map((v) => judges.filter((j) => j.criteria[id].verdict === v).length)))
    : null;
  const scores = judges.map((j) => j.score);
  return {
    majority: round(majority, 2), pairwise: round(pairs ? same / pairs : 1, 2),
    kappa: kappa === null ? null : round(kappa, 3), spread: round(Math.max(...scores) - Math.min(...scores), 3),
  };
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Distinct sentences across several judges' feedback, in order. */
export function mergeFeedback(texts: string[], max = 12): string {
  const seen = new Set<string>(), out: string[] = [];
  for (const t of texts) {
    for (const part of String(t ?? "").split(/(?<=[.!?])\s+|\n+/)) {
      const p = part.trim(); const k = key(p);
      if (!k || seen.has(k)) continue;
      // a sentence already contained in a longer one that was kept is the same point
      if (out.some((o) => key(o).includes(k))) continue;
      seen.add(k); out.push(p);
      if (out.length >= max) return out.join(" ");
    }
  }
  return out.join(" ");
}

export interface Aggregate {
  score: number;
  verdict: Judgment["verdict"];
  feedback: string;
  criteria: NonNullable<Judgment["criteria"]>;
  onTask: boolean;
  drift?: string;
  failureCategory?: FailureTag;
  failing: string[];
}

/**
 * Per-criterion majority (ties are UNSURE), median score, majority verdict (ties go to revise), merged feedback,
 * and drift when any two judges flag it. Same rule as one judge: accept only when every criterion passes
 * (or a command already verified it).
 */
export function aggregate(reads: JudgeRead[], task: Pick<Task, "criteria" | "checks">): Aggregate {
  const ids = (task.criteria ?? []).map((c) => c.id);
  const criteria: NonNullable<Judgment["criteria"]> = {};
  for (const id of ids) {
    const v = plurality(reads.map((r) => r.criteria[id]?.verdict ?? "UNSURE")) ?? "UNSURE";
    const ev = [...new Set(reads.filter((r) => (r.criteria[id]?.verdict ?? "UNSURE") === v).map((r) => r.criteria[id]?.evidence?.trim()).filter(Boolean))];
    criteria[id] = { verdict: v, evidence: ev.join(" / ").slice(0, 400) };
  }
  const score = round(Math.min(1, Math.max(0, median(reads.map((r) => r.score)))), 4);
  let verdict: Judgment["verdict"] = plurality(reads.map((r) => r.verdict)) ?? "revise";
  const verified = new Set((task.checks ?? []).filter((r) => r.ok).map((r) => r.criterionId));
  const failing = Object.entries(criteria).filter(([k, v]) => v.verdict !== "PASS" && !verified.has(k)).map(([k]) => k);
  if (verdict === "accept" && failing.length && ids.length) verdict = "revise"; // done means every check passes
  const from = verdict === "accept" ? reads : reads.filter((r) => r.verdict !== "accept");
  const merged = mergeFeedback((from.length ? from : reads).map((r) => r.feedback));
  const feedback = merged + (verdict === "revise" && failing.length && ids.length ? ` Not yet passing: ${failing.join(", ")}.` : "");
  // Drift: any two judges flag it (all of them, with a jury of two).
  const flagged = reads.filter((r) => !r.onTask || r.drift);
  const needed = Math.min(2, reads.length);
  const drifted = flagged.length >= needed && flagged.length > 0;
  const drift = drifted ? mergeFeedback(flagged.map((r) => r.drift ?? ""), 4) || "off task" : undefined;
  const offTask = reads.filter((r) => !r.onTask).length >= needed && reads.length > 0;
  const cats = verdict === "accept" ? [] : reads.filter((r) => r.verdict !== "accept" && r.failureCategory).map((r) => r.failureCategory!);
  const failureCategory = cats.length ? (plurality(cats) ?? cats[0]) : undefined;
  return { score, verdict, feedback: feedback.trim(), criteria, onTask: !offTask, drift, failureCategory, failing };
}

/** The judges didn't agree on accept or revise (reassign counts as revise). */
export function isSplit(verdicts: Judgment["verdict"][]): boolean {
  const accepts = verdicts.filter((v) => v === "accept").length;
  return accepts > 0 && accepts < verdicts.length;
}
