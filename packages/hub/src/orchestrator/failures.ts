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
 *  - other         run errors (crash, timeout, rate limit) and plain quality shortfalls
 */
export const TAGS: FailureTag[] = ["spec", "misalignment", "verification", "other"];
const isTag = (x: unknown): x is FailureTag => typeof x === "string" && (TAGS as string[]).includes(x);

export interface FailureEvidence {
  kind: "run_error" | "blocked" | "needs_input" | "sent_back";
  report?: TaskReport;
  judgment?: Judgment;
  /** Drift lines the orchestrator found (self-reported, out-of-scope files, judge). */
  drift?: string[];
  /** Criteria a runnable check failed. */
  failedChecks?: string[];
}

export function classifyFailure(e: FailureEvidence): { tag: FailureTag; why: string } {
  if (e.kind === "run_error") return { tag: "other", why: "run error" };
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
