import type { AgentResume } from "@agent-room/shared";
import { emitFile, splitDoc } from "../control/parse.js";
import { CONDENSE_AT, RESUME_CAP, RESUME_TUNING } from "./tuning.js";

/**
 * 2.3 RESUME.md (CONTROL.md section 2): front matter `runs`, `strengths`, `weaknesses`, `model_versions`, `probation`,
 * then a body of the evidence. The orchestrator rewrites everything above "Owner notes" each time; whatever the owner
 * writes under a `## Owner notes` heading is kept as it is. The file is never put in any agent's context.
 *
 * Over 80% of the 8 KB cap the body is condensed, in this order, until it fits: lessons, the per-type table's tail, the
 * failure and judge sections, the table itself. The front matter (the part the hub reads) is never cut.
 */

export const OWNER_NOTES = "## Owner notes";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const bytes = (s: string) => Buffer.byteLength(s);

/** What the owner wrote under "Owner notes" in the file that is there now (heading included), or "". */
export function ownerNotesOf(existing: string | undefined): string {
  if (!existing) return "";
  const body = splitDoc(existing).body;
  const at = body.search(/^##\s+Owner notes\s*$/im);
  return at < 0 ? "" : body.slice(at).replace(/\s+$/, "");
}

function status(r: AgentResume): string[] {
  const p = r.probation;
  const out: string[] = [];
  if (p.on) out.push(`- On probation: ${p.graded} of ${p.needed} graded runs. Until it has them it practises on copies of real tasks (shadow runs) and is never given real work.`);
  else if (p.endedAt) out.push(`- Probation ended ${new Date(p.endedAt).toISOString().slice(0, 10)} ${p.endedBy === "owner" ? "by the owner" : `after ${plural(p.graded, "graded run")}`}${p.mean === null || p.mean === undefined ? "" : `, mean ${p.mean.toFixed(2)}`}.`);
  else out.push("- Not on probation.");
  out.push(`- Graded runs: ${r.runs}${r.shadowRuns ? ` (${r.shadowRuns} shadow)` : ""}. First-pass acceptance: ${pct(r.firstPass)}. Send-backs per task: ${r.revisionsPerTask === null ? "n/a" : r.revisionsPerTask.toFixed(2)}.`);
  if (r.modelVersions.length) out.push(`- Model versions seen: ${r.modelVersions.map((v, i) => (i === 0 && r.currentVersion === v ? `${v} (current)` : v)).join(", ")}.`);
  return out;
}

function table(r: AgentResume, rows: number): string[] {
  if (!r.byType.length) return [];
  const shown = r.byType.slice(0, rows);
  const out = ["", "## By task type", "", "| Task type | Runs | Quality | First-pass | Sent back | Failed runs |", "|---|---|---|---|---|---|",
    ...shown.map((t) => `| ${t.taskType} | ${t.runs}${t.currentVersionOnly ? " (current model)" : ""} | ${t.quality.toFixed(2)} | ${pct(t.firstPass)} | ${t.sentBack} of ${t.tasks} | ${t.runFailures} |`)];
  if (r.byType.length > shown.length) out.push("", `${r.byType.length - shown.length} more task types not listed.`);
  return out;
}

function judges(r: AgentResume): string[] {
  const out: string[] = [];
  const mix = Object.entries(r.failureMix).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  if (mix.length) out.push(`- Why work came back, by family: ${mix.join(", ")}.`);
  if (r.jury) out.push(`- Jury agreement on its work: ${Math.round(r.jury.majority * 100)}% voted with the majority over ${plural(r.jury.n, "judged run")}; ${r.jury.splits} split.`);
  if (r.owner) out.push(`- Owner rated ${plural(r.owner.n, "run")}: mean ${r.owner.ownerMean.toFixed(2)} against the judges' ${r.owner.judgeMean.toFixed(2)} (off by ${r.owner.meanDistance.toFixed(2)} on average).`);
  return out.length ? ["", "## Judges and ratings", "", ...out] : [];
}

const HOW = [
  "", "## How this is written", "",
  `A task type needs ${RESUME_TUNING.minRuns} graded runs before it is judged. Strong: mean quality of ${RESUME_TUNING.strongQuality} or more and ${Math.round(RESUME_TUNING.strongFirstPass * 100)}% first-pass acceptance. Weak: mean quality under ${RESUME_TUNING.weakQuality}, or ${Math.round(RESUME_TUNING.weakSentBack * 100)}% or more of its tasks sent back after the first attempt. When the current model version has enough runs of its own, only those count. Written by the orchestrator from the routing log; never given to the agent.`,
];

/** One level of condensing per step; level 0 is the full file. */
function body(r: AgentResume, level: number): string[] {
  const lines = [`# ${r.name}: résumé`, "", "Written from graded results by the orchestrator. The agent never sees it. Add your own notes under \"Owner notes\" at the end; they are kept.",
    "", "## Status", "", ...status(r),
    "", "## Strengths", "", ...(r.strengths.length ? r.strengths.map((s) => `- ${s}`) : [`- None yet. A task type needs ${RESUME_TUNING.minRuns} graded runs first.`]),
    "", "## Weaknesses", "", ...(r.weaknesses.length ? r.weaknesses.map((s) => `- ${s}`) : ["- None found."]),
    ...(level >= 3 ? [] : table(r, level >= 2 ? 5 : RESUME_TUNING.maxTypes)),
    ...(level >= 4 ? [] : judges(r)),
    ...(r.lessons.length && level < 1 ? ["", "## Lessons it has learned", "", ...r.lessons.map((l) => `- ${l}`)] : []),
    ...(level >= 5 ? [] : HOW)];
  return lines;
}

/** The whole RESUME.md text for a résumé. `existing` is the file now (the owner's notes are carried over). */
export function renderResume(r: AgentResume, o: { today: string; existing?: string; capBytes?: number }): { text: string; bytes: number; level: number } {
  const cap = o.capBytes ?? RESUME_CAP;
  const notes = ownerNotesOf(o.existing);
  const fm = {
    kind: "resume", schema: 1, updated: o.today, updated_by: "orchestrator",
    runs: r.runs, strengths: r.strengths, weaknesses: r.weaknesses, model_versions: r.modelVersions, probation: r.probation.on,
  };
  const make = (level: number) => emitFile(fm, `${body(r, level).join("\n").replace(/\n{3,}/g, "\n\n")}${notes ? `\n\n${notes}` : ""}\n`);
  let level = 0, text = make(0);
  while (bytes(text) > cap * CONDENSE_AT && level < 5) text = make(++level);
  return { text, bytes: bytes(text), level };
}
