import type { FailureRecord, FailureTag, Judgment, Task, TaskReport } from "@agent-room/shared";
import { now } from "../util.js";

/**
 * 0.5 Failure tags. Every failed or sent-back task attempt gets one family, so the scorecard can show
 * which failure modes still bite (MAST: spec 42%, misalignment 37%, verification 21%).
 *
 * Mechanical evidence decides first; the judge's own category is used only when the evidence is silent:
 *  - spec          the agent said it was blocked or needed input (the brief didn't let it finish)
 *  - misalignment  drift: off task, files outside its scope, or work the judge calls out of scope
 *  - verification  the agent's report claimed PASS on a criterion that a command or the reviewer failed,
 *                  or it sent no STATUS block at all (it skipped checking its own work)
 *  - placement     the agent said its sandbox or machine can't do what the task needs ("cannot be created in this environment"):
 *                  a placement problem, not a quality one, so the agent's work is not judged and the task moves to an agent that can
 *  - other         run errors (crash, timeout, rate limit) and plain quality shortfalls
 */
export const TAGS: FailureTag[] = ["spec", "misalignment", "verification", "placement", "other"];
const isTag = (x: unknown): x is FailureTag => typeof x === "string" && (TAGS as string[]).includes(x);

export interface FailureEvidence {
  kind: "run_error" | "blocked" | "needs_input" | "sent_back";
  report?: TaskReport;
  judgment?: Judgment;
  /** Drift lines the orchestrator found (self-reported, out-of-scope files, judge). */
  drift?: string[];
  /** Criteria a runnable check failed. */
  failedChecks?: string[];
  /** What the agent handed back, for telling a placement block from a real question. */
  text?: string;
}

/**
 * An agent saying it can't do the work from where it runs: its sandbox won't allow the write, the folder isn't on its machine, or it says
 * "I cannot perform this task from my environment". Real examples: Codex "Blocked. /tmp/x cannot be created in this environment", Muse
 * "I run on a Linux VM, not on Blake's Mac ... does not exist here".
 */
const PLACEMENT = [
  /cannot be (created|written|accessed|reached|opened) in this (environment|sandbox|workspace)/i,
  /(can(?:no|')t|unable to|not able to|won'?t be able to)\s+(?:perform|do|complete|run|finish|carry out)\s+(?:this|the)(?:\s+task)?\s+from\s+(?:my|this|the)\s+(?:environment|sandbox|machine|vm)/i,
  /\b(?:sandbox(?:ed)?|read-only (?:file ?system|workspace|sandbox))\b[^.\n]{0,80}\b(?:block|den(?:y|ies|ied)|prevent|restrict|forbid|not allow|only allows?|outside)/i,
  /\b(?:block|den(?:y|ies|ied)|prevent|restrict|forbid)\w*\b[^.\n]{0,40}\b(?:by|in|from) (?:the|my|this) sandbox/i,
  /\bread-only file ?system\b|\boperation not permitted\b/i,
  /\b(?:does ?n[o']t|do not|doesn't) exist (?:here|on this machine|in my environment)\b/i,
  /\bI (?:run|am running|'m running) (?:on|in) (?:a|an|another) [\w -]{0,30}(?:vm|server|machine|container|sandbox)\b/i,
  /\boutside (?:of )?(?:the|my|this) (?:task folder|workspace|working (?:folder|directory)|sandbox)\b/i,
  /\bno access to (?:the|this|your) (?:task folder|mac|local (?:folder|files|filesystem)|shell)\b/i,
];
export function isPlacementBlock(...texts: (string | undefined)[]): boolean {
  const t = texts.filter(Boolean).join("\n").slice(0, 4000);
  return PLACEMENT.some((re) => re.test(t));
}

export function classifyFailure(e: FailureEvidence): { tag: FailureTag; why: string } {
  if (e.kind === "run_error") return { tag: "other", why: "run error" };
  if ((e.kind === "blocked" || e.kind === "needs_input") && isPlacementBlock(e.report?.reason, e.text)) return { tag: "placement", why: "blocked by its environment" };
  if (e.kind === "blocked" || e.kind === "needs_input") return { tag: "spec", why: e.kind === "blocked" ? "agent blocked" : "agent needed input" };
  const hardDrift = (e.drift ?? []).filter((d) => !d.startsWith("No STATUS block"));
  if (hardDrift.length || e.judgment?.onTask === false) return { tag: "misalignment", why: "drift" };
  const claimed = e.report?.criteria ?? {};
  const failedByCheck = new Set(e.failedChecks ?? []);
  const failedByJudge = Object.entries(e.judgment?.criteria ?? {}).filter(([, v]) => v.verdict === "FAIL").map(([k]) => k);
  const overclaimed = [...new Set([...failedByCheck, ...failedByJudge])].filter((k) => claimed[k]?.verdict === "PASS");
  if (overclaimed.length) return { tag: "verification", why: `claimed PASS on ${overclaimed.join(", ")}` };
  if ((e.drift ?? []).some((d) => d.startsWith("No STATUS block"))) return { tag: "verification", why: "no self-check" };
  if (isTag(e.judgment?.failureCategory)) return { tag: e.judgment!.failureCategory!, why: "judge" };
  return { tag: "other", why: "quality" };
}

/** Normalise whatever the judge wrote into a tag, or undefined. */
export function parseFailureCategory(x: unknown): FailureTag | undefined {
  const s = String(x ?? "").trim().toLowerCase();
  if (isTag(s)) return s;
  if (/^spec|unclear|ambig/.test(s)) return "spec";
  if (/misalign|drift|scope|conflict/.test(s)) return "misalignment";
  if (/verif|premature|unchecked/.test(s)) return "verification";
  return undefined;
}

export function addFailure(t: Task, agentId: string, tag: FailureTag, note: string, routingId?: string): FailureRecord {
  const f: FailureRecord = { at: now(), agentId, tag, note: note.slice(0, 300), ...(routingId ? { routingId } : {}) };
  t.failures = [...(t.failures ?? []), f].slice(-30);
  return f;
}
