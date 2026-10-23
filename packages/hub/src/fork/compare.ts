import type { AgentConfig, ForkComparison, ForkPass, ForkRequirementVerdict, ForkSideId, Verdict } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { localModelsFor } from "../discovery/usage.js";
import { familyOf } from "../jury/family.js";
import { mechanical } from "../jury/neutralize.js";
import { extractJson } from "../orchestrator/json.js";
import type { RunResult } from "../adapters/types.js";
import { id, now } from "../util.js";

/**
 * 4.4 AC2: the blind comparison of a fork's two results.
 *
 * Both results are made neutral (the 2.2 rewrite: persona, sign-offs and emphasis go) and every agent, vendor and model name is taken out
 * of everything the judges read. They then judge the two results pairwise against the requirements, twice, with the two results in opposite
 * order (which comes first is chosen at random), so a leaning toward whatever is read first cancels out. Each pass reports a preference and a
 * verdict per requirement; the passes are merged and their agreement is reported. The judges come from outside both rosters' model families
 * when anyone there is ready. The result is a suggestion: the owner chooses what to merge.
 */

export interface Dossier {
  summary: string;
  files: { path: string; change: string; diff: string; binary?: boolean }[];
  docs: { title: string; body: string }[];
}

export interface CompareHost {
  store: Store;
  readyAgents(): Promise<AgentConfig[]>;
  call(agent: AgentConfig, prompt: string, o?: { jsonOnly?: boolean; signal?: AbortSignal }): Promise<RunResult>;
  quotaLimited(agentId: string): boolean;
  rand: () => number;
  /** Agents on probation take no real work, and that includes judging. */
  barred?: (agents: AgentConfig[]) => Set<string>;
}

const PER_CANDIDATE = 12_000;
const PER_DOC = 3_000;

/** One candidate's text, shortened to the same budget whichever side it is. */
export function candidateText(d: Dossier, scrub: (t: string) => string): string {
  const out: string[] = [];
  out.push(`Summary:\n${scrub(mechanical(d.summary || "") || "(no summary)")}`);
  let left = PER_CANDIDATE;
  if (d.files.length) {
    out.push("Files:");
    for (const f of d.files) {
      const head = `--- ${scrub(f.path)} (${f.change})`;
      const body = f.binary ? "(not a text file)" : scrub(f.diff).trim() || "(too large to show)";
      const part = `${head}\n${body.length > left ? `${body.slice(0, Math.max(0, left))}\n... (cut)` : body}`;
      out.push(part); left -= part.length;
      if (left <= 0) { out.push("(more files not shown)"); break; }
    }
  } else out.push("Files: none");
  if (d.docs.length) {
    out.push("Documents:");
    for (const doc of d.docs.slice(0, 4)) out.push(`## ${scrub(doc.title)}\n${scrub(mechanical(doc.body)).slice(0, PER_DOC)}`);
  }
  return out.join("\n");
}

export function comparePrompt(goal: string, requirements: string[], first: string, second: string, scrub: (t: string) => string): string {
  return `[[COMPARE]]
You are comparing two results for the same goal. You are not told who produced either, and it doesn't matter. Judge only what was delivered.
Prefer the result that meets more of the requirements and meets them better. Ignore length, order, tone and style. Answer "tie" only when they are truly equal.

Goal: ${scrub(goal)}
Requirements (check each one for both results):
${requirements.map((r, i) => `R${i + 1}: ${scrub(r)}`).join("\n")}

=== CANDIDATE 1 ===
${first}
=== CANDIDATE 2 ===
${second}
=== END ===

Reply with JSON only, no other text:
{"preferred":"1" | "2" | "tie","reasons":["one short reason","..."],"requirements":{"R1":{"1":"PASS|FAIL|UNSURE","2":"PASS|FAIL|UNSURE","note":"why"}}}`;
}

interface RawPass { preferred?: string; reasons?: unknown; requirements?: Record<string, Record<string, unknown>> }
const verdict = (v: unknown): Verdict => { const s = String(v ?? "UNSURE").toUpperCase(); return s === "PASS" || s === "FAIL" ? s : "UNSURE"; };
const other = (s: ForkSideId): ForkSideId => (s === "a" ? "b" : "a");

/** Two passes' verdicts for one side on one requirement: the same verdict stays; a PASS against a FAIL is UNSURE; UNSURE gives way to the other. */
export function mergeVerdicts(x: Verdict | undefined, y: Verdict | undefined): Verdict {
  if (!x) return y ?? "UNSURE";
  if (!y) return x;
  if (x === y) return x;
  if (x === "UNSURE") return y;
  if (y === "UNSURE") return x;
  return "UNSURE";
}

/** Who judges: ready agents outside both rosters' model families when there are any, else anyone ready (and the result says so). */
export function pickJudges(a: { ready: AgentConfig[]; workers: AgentConfig[]; localModels: string[]; limited: (id: string) => boolean; rotation: string[]; barred?: Set<string> }): { judges: AgentConfig[]; independence: "full" | "partial" } {
  const workerFamilies = new Set(a.workers.map((w) => familyOf(w, a.localModels)));
  const order = (x: AgentConfig) => { const i = a.rotation.indexOf(x.id); return i < 0 ? 1e6 : i; };
  const able = a.ready.filter((x) => x.enabled && !a.limited(x.id) && !a.barred?.has(x.id)).sort((p, q) => order(p) - order(q));
  const outside = able.filter((x) => !workerFamilies.has(familyOf(x, a.localModels)));
  return outside.length ? { judges: outside, independence: "full" } : { judges: able, independence: "partial" };
}

export async function compareSides(host: CompareHost, input: { goal: string; requirements: string[]; a: Dossier; b: Dossier; workers: AgentConfig[]; scrub: (t: string) => string; signal?: AbortSignal }): Promise<ForkComparison> {
  const { store } = host;
  const base = { id: id("cmp"), at: now() };
  const reqs = input.requirements.length ? input.requirements : [input.goal];
  const localModels = localModelsFor(store);
  const ready = await host.readyAgents();
  const { judges, independence } = pickJudges({ ready, workers: input.workers, localModels, limited: host.quotaLimited, rotation: store.getSettings().judgeRotation, barred: host.barred?.(ready) });
  if (!judges.length) return { ...base, state: "failed", preference: "unclear", agreement: false, reasons: [], requirements: reqs.map((text) => ({ text, a: "UNSURE", b: "UNSURE" })), passes: [], independence, note: "No judge is available right now. Open the two results and decide yourself." };

  const textA = candidateText(input.a, input.scrub), textB = candidateText(input.b, input.scrub);
  // Which side is read first is random; the second pass always swaps it.
  const firstOrder: ForkPass["order"] = host.rand() < 0.5 ? "ab" : "ba";
  const orders: ForkPass["order"][] = [firstOrder, firstOrder === "ab" ? "ba" : "ab"];
  // Two different judges when there are two (different families first), else the same one twice.
  const j1 = judges[0];
  const j2 = judges.find((x) => familyOf(x, localModels) !== familyOf(j1, localModels)) ?? judges.find((x) => x.id !== j1.id) ?? j1;
  const picked = [j1, j2];

  const passes: ForkPass[] = [];
  const perSide: Record<ForkSideId, Verdict[][]> = { a: reqs.map(() => []), b: reqs.map(() => []) };
  const notes: string[][] = reqs.map(() => []);
  const reasons: string[] = [];
  for (let i = 0; i < 2; i++) {
    const order = orders[i], judge = picked[i];
    const first: ForkSideId = order === "ab" ? "a" : "b";
    const prompt = comparePrompt(input.goal, reqs, first === "a" ? textA : textB, first === "a" ? textB : textA, input.scrub);
    let raw: RawPass | null = null;
    try {
      const r = await host.call(judge, prompt, { jsonOnly: true, signal: input.signal });
      raw = r.ok ? extractJson<RawPass>(r.text) : null;
    } catch { raw = null; }
    if (!raw) continue;
    const pref = String(raw.preferred ?? "").toLowerCase();
    const preferred: ForkSideId | "tie" = pref === "1" ? first : pref === "2" ? other(first) : "tie";
    passes.push({ order, judge: judge.id, family: familyOf(judge, localModels), preferred });
    const name = (n: string) => `Side ${(n === "1" ? first : other(first)).toUpperCase()}`;
    for (const r of Array.isArray(raw.reasons) ? raw.reasons : []) {
      const t = String(r).replace(/candidate\s*([12])\b/gi, (_m, n: string) => name(n)).replace(/\s+/g, " ").trim().slice(0, 300);
      if (t && !reasons.includes(t)) reasons.push(t);
    }
    reqs.forEach((_, k) => {
      const v = raw!.requirements?.[`R${k + 1}`];
      if (!v) return;
      perSide[first][k].push(verdict(v["1"]));
      perSide[other(first)][k].push(verdict(v["2"]));
      const note = String(v.note ?? "").replace(/candidate\s*([12])\b/gi, (_m, n: string) => name(n)).replace(/\s+/g, " ").trim().slice(0, 200);
      if (note && !notes[k].includes(note)) notes[k].push(note);
    });
  }
  const requirements: ForkRequirementVerdict[] = reqs.map((text, k) => ({
    text,
    a: perSide.a[k].reduce<Verdict | undefined>((m, v) => mergeVerdicts(m, v), undefined) ?? "UNSURE",
    b: perSide.b[k].reduce<Verdict | undefined>((m, v) => mergeVerdicts(m, v), undefined) ?? "UNSURE",
    ...(notes[k].length ? { note: notes[k].join(" ") } : {}),
  }));
  if (!passes.length) return { ...base, state: "failed", preference: "unclear", agreement: false, reasons: [], requirements, passes, independence, note: "The judges didn't answer. Open the two results and decide yourself." };
  const agreement = passes.length === 2 && passes[0].preferred === passes[1].preferred;
  const preference = passes.length === 2 ? (agreement ? passes[0].preferred : "unclear") : passes[0].preferred;
  const note = passes.length < 2 ? "Only one of the two passes was answered, so the order could not be checked." : !agreement ? "The two orders disagreed, so the jury has no clear preference." : independence === "partial" ? "No judge was free of both rosters' model families." : undefined;
  return { ...base, state: passes.length === 2 ? "done" : "partial", preference, agreement, reasons: reasons.slice(0, 6), requirements, passes, independence, ...(note ? { note } : {}) };
}
