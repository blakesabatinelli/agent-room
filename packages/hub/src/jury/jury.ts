import { createHash } from "node:crypto";
import type { AgentConfig, Contract, FailureTag, Judgment, JuryInfo, JuryRecord, JurySettings, OrchestratorSettings, Task, Verdict } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { localModelsFor } from "../discovery/usage.js";
import { parseFailureCategory } from "../orchestrator/failures.js";
import { pickProfile } from "../orchestrator/contract.js";
import { judgePrompt } from "../orchestrator/prompts.js";
import { id, now } from "../util.js";
import { agreementOf, aggregate, isSplit, type JudgeRead } from "./aggregate.js";
import { familyOf, isLocalAgent, modelOf } from "./family.js";
import { neutralize, type Neutral } from "./neutralize.js";
import { listJuries, saveJury } from "./records.js";
import type { RunResult } from "../adapters/types.js";

/**
 * 2.2 Blind cross-vendor juries.
 *  1. The agent's reply is rewritten into a neutral voice (a local model when one is ready), files are left alone.
 *  2. Three judges from three different model families, none the worker's, one of them local, grade it in parallel
 *     with the usual judge prompt.
 *  3. The reads are merged into one normal Judgment (majority and median), with the jury's details attached.
 *  4. The jury, its agreement and (later) its distance from the owner's rating are recorded in `juries`.
 * With too few families ready the single rotating judge does the work and the record says why.
 */

/** What the jury needs from the orchestrator. Kept narrow so tests can drive it with fakes. */
export interface JuryHost {
  store: Store;
  readyAgents(): Promise<AgentConfig[]>;
  call(agent: AgentConfig, prompt: string, o?: { jsonOnly?: boolean; signal?: AbortSignal; taskId?: string }): Promise<RunResult>;
  callJson<T>(prompt: string, agent: AgentConfig, signal: AbortSignal | undefined, role: "reviewer"): Promise<T | null>;
  /** 1.5: a local judge has to be admitted, and is counted while it runs. */
  governor?: { admit(a: AgentConfig): boolean; start(key: string, a: AgentConfig): void; release(key: string): void };
  /** 1.6 */
  quotaLimited(agentId: string): boolean;
}

export interface JuryInput {
  task: Task;
  worker: AgentConfig;
  contract?: Contract;
  notes: string[];
  signal?: AbortSignal;
  changed: string[];
  files: string;
  previousFeedback?: string;
  /** The judge(s) that already reviewed it: one id, or the comma-joined ids of a jury (this is then the extra reviewer). */
  notJudge?: string;
}

export type JuryOutcome =
  /** A jury judged it. */
  | { judgment: Judgment }
  /** The jury is switched off: judge exactly as before. */
  | { off: true }
  /** No jury this time: judge with the single judge on `task` (its reply neutralised mechanically), then pass the result to `finish`. */
  | { fallback: string; task: Task; finish: (single: Judgment) => Judgment };

export const JURY_DEFAULTS: Required<JurySettings> = { enabled: true, size: 3, requireLocal: true, minFamilies: 3 };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export function jurySettings(s: Pick<OrchestratorSettings, "jury">): Required<JurySettings> & { auto: boolean } {
  const j = s.jury ?? {};
  const size = clamp(j.size ?? JURY_DEFAULTS.size, 2, 5);
  return {
    enabled: j.enabled ?? JURY_DEFAULTS.enabled, auto: j.enabled === undefined,
    size, requireLocal: j.requireLocal ?? JURY_DEFAULTS.requireLocal,
    minFamilies: clamp(j.minFamilies ?? JURY_DEFAULTS.minFamilies, 2, size),
  };
}

export interface Pick2 { judges: AgentConfig[]; noLocal?: string; fallback?: string }

/**
 * Who judges. One agent per family, none in the worker's family, not the worker, not an agent out of quota, not
 * `exclude`. A local model is included when one is ready and the governor admits it. Pure: the caller supplies the checks.
 */
export function selectJudges(a: {
  ready: AgentConfig[]; worker: AgentConfig; workerFamily: string; localModels: string[]; settings: ReturnType<typeof jurySettings>;
  rotation: string[]; exclude?: string[]; size?: number; limited: (id: string) => boolean; admit: (a: AgentConfig) => boolean;
}): Pick2 {
  const size = a.size ?? a.settings.size;
  const order = (x: AgentConfig) => { const i = a.rotation.indexOf(x.id); return i < 0 ? 1e6 : i; };
  const eligible = a.ready.filter((x) => x.enabled && x.id !== a.worker.id && !(a.exclude ?? []).includes(x.id) && familyOf(x, a.localModels) !== a.workerFamily && !a.limited(x.id));
  const byFamily = new Map<string, AgentConfig>();
  let localSkipped = false, localSeen = false;
  for (const x of [...eligible].sort((p, q) => order(p) - order(q))) {
    const fam = familyOf(x, a.localModels), local = isLocalAgent(x, a.localModels);
    if (local) { localSeen = true; if (!a.admit(x)) { localSkipped = true; continue; } }
    if (!byFamily.has(fam)) byFamily.set(fam, x);
  }
  const all = [...byFamily.values()];
  const locals = all.filter((x) => isLocalAgent(x, a.localModels)), cloud = all.filter((x) => !isLocalAgent(x, a.localModels));
  const picked = a.settings.requireLocal && locals.length ? [locals[0], ...cloud, ...locals.slice(1)] : [...cloud, ...locals];
  const judges = picked.slice(0, size);
  const noLocal = a.settings.requireLocal && !locals.length
    ? (localSkipped ? "the local model wasn't admitted by the capacity governor (no free memory or at its limit)" : localSeen ? "no local model could be used" : "no local model is ready") : undefined;
  const need = size < 2 ? 1 : Math.max(2, Math.min(a.settings.minFamilies, size));
  if (judges.length < need) {
    return { judges, noLocal, fallback: `only ${judges.length} model ${judges.length === 1 ? "family" : "families"} besides the worker's ${judges.length === 1 ? "is" : "are"} ready (a jury needs ${need})` };
  }
  return { judges, noLocal };
}

// ---- the neutral text

/** Neutral text is made once per reply: an UNSURE re-review reuses it instead of paying for another rewrite. */
const cache = new Map<string, { n: Neutral; rewriter: string }>();
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** The rewriter: a local model when one is ready, else an agent of another family than the worker's, and never the worker. */
export function pickRewriter(a: { ready: AgentConfig[]; worker: AgentConfig; workerFamily: string; localModels: string[]; judges: AgentConfig[]; limited: (id: string) => boolean; admit: (x: AgentConfig) => boolean }): AgentConfig | undefined {
  const judgeFamilies = new Set(a.judges.map((j) => familyOf(j, a.localModels)));
  const ok = a.ready.filter((x) => x.enabled && x.id !== a.worker.id && familyOf(x, a.localModels) !== a.workerFamily && !a.limited(x.id) && (!isLocalAgent(x, a.localModels) || a.admit(x)));
  const rank = (x: AgentConfig) => (isLocalAgent(x, a.localModels) ? 0 : 2) + (judgeFamilies.has(familyOf(x, a.localModels)) ? 0.5 : 0);
  return [...ok].sort((p, q) => rank(p) - rank(q))[0];
}

async function neutralText(host: JuryHost, input: JuryInput, workerFamily: string, ready: AgentConfig[], localModels: string[], judges: AgentConfig[], signal?: AbortSignal) {
  const source = input.task.result ?? "";
  const k = `${input.task.id}|${hash(source)}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const rewriter = pickRewriter({ ready, worker: input.worker, workerFamily, localModels, judges, limited: host.quotaLimited, admit: (x) => host.governor?.admit(x) ?? true });
  let rewriterUsed = "mechanical";
  const rewrite = rewriter ? async (prompt: string) => {
    const key = `rewrite:${input.task.id}:${rewriter.id}`;
    if (isLocalAgent(rewriter, localModels)) host.governor?.start(key, rewriter);
    try {
      const r = await host.call(rewriter, prompt, { jsonOnly: true, signal, taskId: input.task.id });
      return r.ok ? r.text : undefined;
    } finally { if (isLocalAgent(rewriter, localModels)) host.governor?.release(key); }
  } : undefined;
  const n = await neutralize(source, input.task, { worker: input.worker, rewrite });
  if (n.how === "model" && rewriter) rewriterUsed = rewriter.id;
  const out = { n, rewriter: rewriterUsed };
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  cache.set(k, out);
  return out;
}

// ---- reading a judge's reply (the same rules as the single judge)

interface RawJudge { score?: number; verdict?: string; feedback?: string; criteria?: Record<string, { verdict?: string; evidence?: string }>; on_task?: boolean; drift?: string; failure_category?: string }

export function readJudge(raw: RawJudge, agent: AgentConfig, task: Pick<Task, "criteria">, localModels: string[]): JudgeRead {
  const score = Math.min(1, Math.max(0, Number(raw.score) || 0));
  const criteria: JudgeRead["criteria"] = {};
  for (const c of task.criteria ?? []) {
    const v = raw.criteria?.[c.id];
    const verdict = String(v?.verdict ?? "UNSURE").toUpperCase();
    criteria[c.id] = { verdict: (["PASS", "FAIL", "UNSURE"].includes(verdict) ? verdict : "UNSURE") as Verdict, evidence: String(v?.evidence ?? "") };
  }
  const verdict = (["accept", "revise", "reassign"] as const).includes(raw.verdict as never) ? raw.verdict as Judgment["verdict"] : score >= 0.6 ? "accept" : "revise";
  const fc = verdict === "accept" ? undefined : parseFailureCategory(raw.failure_category);
  return {
    agentId: agent.id, family: familyOf(agent, localModels), local: isLocalAgent(agent, localModels),
    model: pickProfile(agent, "reviewer").model ?? modelOf(agent),
    score, verdict, feedback: String(raw.feedback ?? ""), criteria,
    onTask: raw.on_task !== false, drift: raw.drift ? String(raw.drift) : undefined, ...(fc ? { failureCategory: fc as FailureTag } : {}),
  };
}

const verdictsOf = (c: Record<string, { verdict: Verdict }>): Record<string, Verdict> => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.verdict]));

function infoOf(rec: JuryRecord): JuryInfo {
  return {
    id: rec.id, kind: rec.kind, ...(rec.reason ? { reason: rec.reason } : {}),
    judges: rec.judges.map((j) => ({ agentId: j.agentId, family: j.family, local: j.local, verdict: j.verdict, score: j.score })),
    agreement: rec.agreement, split: rec.split,
  };
}

// ---- the review

/** Judge with a jury, or say why not. See JuryOutcome. */
export async function review(host: JuryHost, input: JuryInput): Promise<JuryOutcome> {
  const { store } = host;
  const s = store.getSettings();
  const cfg = jurySettings(s);
  if (!cfg.enabled) return { off: true };
  const { task, worker } = input;
  const localModels = localModelsFor(store);
  const workerFamily = familyOf(worker, localModels);
  const prior = (input.notJudge ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const second = prior.length > 1; // the first review was a jury: this is the extra reviewer for an UNSURE
  const ready = await host.readyAgents();
  const governor = host.governor;
  const sel = selectJudges({
    ready, worker, workerFamily, localModels, settings: cfg, rotation: s.judgeRotation, exclude: prior,
    size: second ? 1 : cfg.size, limited: host.quotaLimited, admit: (a) => governor?.admit(a) ?? true,
  });

  const base = { taskId: task.id, goalId: task.goalId, worker: worker.id, workerFamily };
  // The fallback keeps today's behaviour: one rotating judge. Its reply is still tidied mechanically (no model call).
  const fallback = async (reason: string, noLocal?: string): Promise<JuryOutcome> => {
    const n = await neutralize(task.result ?? "", task, { worker });
    return {
      fallback: reason, task: { ...task, result: n.text },
      finish: (single) => {
        const agent = store.getAgent(single.judgeAgentId);
        const read: JudgeRead | undefined = agent ? {
          agentId: agent.id, family: familyOf(agent, localModels), local: isLocalAgent(agent, localModels), model: pickProfile(agent, "reviewer").model ?? modelOf(agent),
          score: single.score, verdict: single.verdict, feedback: single.feedback, criteria: single.criteria ?? {}, onTask: single.onTask !== false,
        } : undefined;
        const judges = read ? [read] : [];
        const rec: JuryRecord = {
          id: id("jur"), at: now(), kind: "fallback", reason, ...(noLocal ? { noLocal } : {}), ...base, rewriter: "mechanical",
          judges: judges.map((j) => ({ agentId: j.agentId, family: j.family, local: j.local, model: j.model, score: j.score, verdict: j.verdict, criteria: verdictsOf(j.criteria) })),
          aggregate: { score: single.score, verdict: single.verdict, criteria: verdictsOf(single.criteria ?? {}), ...(single.drift ? { drift: single.drift } : {}) },
          agreement: agreementOf(judges, single.verdict, (task.criteria ?? []).map((c) => c.id)), split: false,
        };
        saveJury(store, rec);
        return { ...single, jury: infoOf(rec) };
      },
    };
  };
  if (sel.fallback) return fallback(sel.fallback, sel.noLocal);

  // 1. Neutral text.
  const neutral = await neutralText(host, input, workerFamily, ready, localModels, sel.judges, input.signal);
  const view: Task = { ...task, result: neutral.n.text };
  const prompt = judgePrompt(view, input.contract, input.notes, input.changed, input.files, input.previousFeedback);

  // 2. The judges, in parallel. A local judge counts against the governor while it runs.
  const reads = (await Promise.all(sel.judges.map(async (agent): Promise<JudgeRead | undefined> => {
    const key = `jury:${task.id}:${agent.id}`;
    const local = isLocalAgent(agent, localModels);
    if (local) governor?.start(key, agent);
    try {
      const raw = await host.callJson<RawJudge>(prompt, agent, input.signal, "reviewer");
      return raw ? readJudge(raw, agent, task, localModels) : undefined;
    } catch { return undefined; } finally { if (local) governor?.release(key); }
  }))).filter((r): r is JudgeRead => !!r);
  if (reads.length < Math.min(2, sel.judges.length)) return fallback(`the jury's judges didn't answer (${reads.length} of ${sel.judges.length})`, sel.noLocal);

  // 3. One judgment.
  const agg = aggregate(reads, task);
  const ids = (task.criteria ?? []).map((c) => c.id);
  const agreement = agreementOf(reads, agg.verdict, ids);
  const split = reads.length > 1 && isSplit(reads.map((r) => r.verdict));
  const reasons = [reads.length < sel.judges.length ? `${reads.length} of ${sel.judges.length} judges answered` : "", neutral.n.note ? `rewriter: ${neutral.n.note}` : ""].filter(Boolean).join("; ");
  const rec: JuryRecord = {
    id: id("jur"), at: now(), kind: second ? "second" : "jury", ...(reasons ? { reason: reasons } : {}), ...(sel.noLocal && !second ? { noLocal: sel.noLocal } : {}),
    ...base, rewriter: neutral.rewriter, ...(neutral.n.note ? { rewriterNote: neutral.n.note } : {}),
    judges: reads.map((j) => ({ agentId: j.agentId, family: j.family, local: j.local, model: j.model, score: j.score, verdict: j.verdict, criteria: verdictsOf(j.criteria) })),
    aggregate: { score: agg.score, verdict: agg.verdict, criteria: verdictsOf(agg.criteria), ...(agg.drift ? { drift: agg.drift } : {}) },
    agreement, split,
  };
  saveJury(store, rec);
  // 5. Vendor disagreement is a signal for 2.7.
  if (split) {
    store.audit("jury", "jury.split", `"${task.title}": ${reads.map((r) => `${r.family} ${r.verdict}`).join(", ")}`.slice(0, 400));
    store.emit("event", {
      type: "jury_split", at: rec.at, taskId: task.id, goalId: task.goalId, juryId: rec.id, verdict: agg.verdict,
      judges: reads.map((r) => ({ agentId: r.agentId, family: r.family, verdict: r.verdict, score: r.score })),
    });
  }
  const judgment: Judgment = {
    score: agg.score, verdict: agg.verdict, feedback: agg.feedback, judgeAgentId: reads.map((r) => r.agentId).join(","),
    criteria: agg.criteria, onTask: agg.onTask, drift: agg.drift, ...(agg.failureCategory ? { failureCategory: agg.failureCategory } : {}),
    // The extra reviewer's details are in its record; leaving them off keeps the first jury's chips on the task.
    ...(second ? {} : { jury: infoOf(rec) }),
  };
  return { judgment };
}

/** The compact line for a room message: "3 judges: ✓ ✓ ✗ (agree 67%)", or why there was only one. */
export function juryLine(j: Pick<Judgment, "jury"> | undefined): string {
  const info = j?.jury;
  if (!info) return "";
  const mark = (v: Judgment["verdict"]) => (v === "accept" ? "✓" : "✗");
  if (info.kind === "fallback") return `1 judge${info.reason ? ` (no jury: ${info.reason})` : ""}`;
  const who = info.judges.map((x) => `${x.family} ${mark(x.verdict)} ${Math.round(x.score * 100)}`).join(", ");
  return `${info.judges.length} judges: ${info.judges.map((x) => mark(x.verdict)).join(" ")} (agree ${Math.round(info.agreement.majority * 100)}%) [${who}]`;
}

/** One line for the goal summary (phone and Mac): how the goal's tasks were judged. Empty when nothing was recorded. */
export function jurySummary(store: Store, goalId: string): string {
  const latest = new Map<string, JuryRecord>();
  for (const r of listJuries(store, { goalId })) if (r.kind !== "second") latest.set(r.taskId, r);
  const all = [...latest.values()];
  if (!all.length) return "";
  const juries = all.filter((r) => r.kind === "jury"), single = all.length - juries.length;
  const parts: string[] = [];
  if (juries.length) {
    const agree = Math.round((juries.reduce((a, r) => a + r.agreement.majority, 0) / juries.length) * 100);
    const splits = juries.filter((r) => r.split).length;
    parts.push(`${juries.length} judged by a jury (agree ${agree}%${splits ? `, ${splits} split` : ""})`);
  }
  if (single) parts.push(`${single} by one judge`);
  return `\nJudging: ${parts.join(", ")}.`;
}
