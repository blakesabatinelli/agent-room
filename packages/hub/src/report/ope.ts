/**
 * 2.7 Off-policy evaluation for the "routing doesn't pay" kill criterion.
 *
 * The routing log (0.2) records, for every pick, the probability the policy gave each candidate. So a question like
 * "what would the pass rate have been if Codex had taken every task?" can be answered from the log, without running anything,
 * by re-weighting the tasks Codex really took by 1 / (the probability it had of being picked).
 *
 * Three estimates of V(always X), each over the decisions where X was a candidate with a non-zero probability:
 *  - ips:   (1/n) * sum 1{chosen = X} * r / p                      unbiased; noisy when p is small.
 *  - snips: sum w*r / sum w, with w = 1{chosen = X} / p            self-normalised; biased a little, much less noisy.
 *  - dr:    doubly robust: a reward model (the mean pass rate of X on that task type, shrunk toward X's overall mean, and
 *           left-one-out for the row being scored) plus an IPS correction of the model's error. Right if either the model
 *           or the logged probabilities are right.
 * `logged` is what the policy actually got on the same decisions, so `logged - estimate` is how much the policy beat "always X" by.
 */

export interface LoggedDecision {
  /** What the decision is conditioned on: the task type. */
  context: string;
  chosen: string;
  /** Probability the policy gave the chosen agent when it picked. */
  p: number;
  /** Probability of every candidate at that moment (the chosen one included). */
  probs: Record<string, number>;
  /** 1 = the work was accepted, 0 = it was not. */
  reward: number;
}

export interface OpeEstimate {
  target: string;
  /** Decisions where the target had a non-zero probability: the ones that say anything about "always target". */
  n: number;
  /** Of those, the ones where the target really was picked. */
  picked: number;
  /** n over all decisions given. */
  coverage: number;
  /** Pass rate the policy actually got on those n decisions. */
  logged: number | null;
  ips: number | null;
  snips: number | null;
  dr: number | null;
  /** Effective sample size of the weights, (sum w)^2 / sum w^2: how many equally weighted decisions the estimate is worth. */
  ess: number;
}

export interface OpeOptions {
  /** Cap on a single weight (default none: IPS stays unbiased). */
  maxWeight?: number;
  /** How many pseudo-observations the reward model borrows from the agent's overall mean (default 2). */
  priorStrength?: number;
}

const supportOf = (rows: LoggedDecision[], target: string) => rows.filter((r) => (r.probs[target] ?? 0) > 0);

/** Estimates for "always use `target`" over the decisions that can speak to it. */
export function evaluateAlways(rows: LoggedDecision[], target: string, opts: OpeOptions = {}): OpeEstimate {
  const S = supportOf(rows, target);
  const n = S.length;
  const empty: OpeEstimate = { target, n, picked: 0, coverage: rows.length ? n / rows.length : 0, logged: null, ips: null, snips: null, dr: null, ess: 0 };
  if (!n) return empty;
  const cap = opts.maxWeight ?? Infinity;
  const k = opts.priorStrength ?? 2;

  // The reward model: how often `target` passed on each context, from the decisions where it was picked.
  const cell = new Map<string, { s: number; n: number }>();
  let totS = 0, totN = 0;
  for (const r of S) if (r.chosen === target) {
    const c = cell.get(r.context) ?? { s: 0, n: 0 };
    c.s += r.reward; c.n += 1; cell.set(r.context, c);
    totS += r.reward; totN += 1;
  }
  const allMean = S.reduce((a, r) => a + r.reward, 0) / n;
  /** The model's guess for `target` on a context, leaving out one picked row's own reward when it is the row being scored. */
  const model = (context: string, leaveOut?: number) => {
    const c = cell.get(context) ?? { s: 0, n: 0 };
    const cs = c.s - (leaveOut ?? 0), cn = c.n - (leaveOut === undefined ? 0 : 1);
    const ts = totS - (leaveOut ?? 0), tn = totN - (leaveOut === undefined ? 0 : 1);
    const agentMean = tn > 0 ? ts / tn : allMean;
    return (cs + k * agentMean) / (cn + k);
  };

  let sw = 0, sw2 = 0, swr = 0, ips = 0, dr = 0, logged = 0, picked = 0;
  for (const r of S) {
    logged += r.reward;
    if (r.chosen === target) {
      picked++;
      const w = Math.min(cap, 1 / (r.probs[target]));
      sw += w; sw2 += w * w; swr += w * r.reward; ips += w * r.reward;
      const m = model(r.context, r.reward);
      dr += m + w * (r.reward - m);
    } else dr += model(r.context);
  }
  return {
    target, n, picked, coverage: n / rows.length, logged: logged / n,
    ips: ips / n, snips: sw > 0 ? swr / sw : null, dr: dr / n, ess: sw2 > 0 ? (sw * sw) / sw2 : 0,
  };
}

/** A small seeded generator, so a report's confidence interval is the same every time it is run on the same log. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 90% bootstrap interval for (logged - estimate) of "always target", from resampling the decisions. */
export function bootstrapGap(rows: LoggedDecision[], target: string, pick: "dr" | "snips" | "ips" = "dr", o: OpeOptions & { resamples?: number; seed?: number } = {}): { lo: number; hi: number } | null {
  const S = supportOf(rows, target);
  if (S.length < 2) return null;
  const rand = mulberry32(o.seed ?? 7);
  const B = o.resamples ?? 300;
  const gaps: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample: LoggedDecision[] = Array.from({ length: S.length }, () => S[Math.floor(rand() * S.length)]);
    const e = evaluateAlways(sample, target, o);
    const v = e[pick];
    if (e.logged !== null && v !== null) gaps.push(e.logged - v);
  }
  if (gaps.length < B / 2) return null;
  gaps.sort((a, b) => a - b);
  return { lo: gaps[Math.floor(0.05 * (gaps.length - 1))], hi: gaps[Math.ceil(0.95 * (gaps.length - 1))] };
}

/** An estimate only counts when enough decisions really picked the target and the weights are not dominated by a few of them. */
export const MIN_PICKED = 10;
export const MIN_ESS = 10;
export const enough = (e: OpeEstimate) => e.picked >= MIN_PICKED && e.ess >= MIN_ESS;

export interface Comparison {
  /** Estimates for "always X" for every agent seen. */
  estimates: OpeEstimate[];
  /** The agent the policy beat by the least: the single best agent to compare against. Absent when no agent has enough decisions. */
  best?: OpeEstimate;
  /** Points of pass rate (0..1) the policy won by over `best`, by the doubly robust estimate. */
  gap?: number;
  gapSnips?: number | null;
  gapIps?: number | null;
  interval?: { lo: number; hi: number } | null;
  /** The pass rate the policy actually got, over every decision. */
  logged: number | null;
  n: number;
}

/** Learned routing against every "always X": how much the policy won by over the best single agent. */
export function compareToSingleAgents(rows: LoggedDecision[], agents?: string[], opts: OpeOptions & { resamples?: number; seed?: number } = {}): Comparison {
  const ids = agents ?? [...new Set(rows.flatMap((r) => Object.keys(r.probs)))].sort();
  const estimates = ids.map((a) => evaluateAlways(rows, a, opts));
  let best: OpeEstimate | undefined, gap: number | undefined;
  for (const e of estimates) {
    if (!enough(e) || e.logged === null || e.dr === null) continue;
    const g = e.logged - e.dr;
    if (gap === undefined || g < gap) { gap = g; best = e; }
  }
  const logged = rows.length ? rows.reduce((a, r) => a + r.reward, 0) / rows.length : null;
  return {
    estimates, ...(best ? { best, gap, gapSnips: best.snips === null ? null : best.logged! - best.snips, gapIps: best.ips === null ? null : best.logged! - best.ips, interval: bootstrapGap(rows, best.target, "dr", opts) } : {}),
    logged, n: rows.length,
  };
}
