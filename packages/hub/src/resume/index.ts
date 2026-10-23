import type { AgentConfig } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { ResumeNotes } from "../orchestrator/prompts.js";
import type { Resumes } from "./service.js";
import { barredSet, probationStatus } from "./probation.js";

export { buildResume, noteOwnerRating, strengthLine, weaknessLine } from "./build.js";
export { OWNER_NOTES, ownerNotesOf, renderResume } from "./file.js";
export { barredSet, countRuns, endProbation, onProbation, probationAgentIds, probationRuns, probationState, probationStatus, realAgents, startProbation } from "./probation.js";
export { Resumes } from "./service.js";
export type { ResumesOptions } from "./service.js";
export { SHADOW_TUNING, ShadowRunner } from "./shadow.js";
export type { ShadowHost } from "./shadow.js";
export { CONDENSE_AT, RESUME_CAP, RESUME_TUNING } from "./tuning.js";

/** Longest résumé summary the planner is shown for one agent. */
const NOTE_CAP = 480;

/**
 * 2.3 What the planner is told about each agent instead of the raw score table: the résumé's strengths and weaknesses
 * (short lines with their numbers), and who is on probation. Capped per agent. This goes to the planner only; no worker
 * agent's task prompt or context file ever contains it (resume.test.ts asserts that).
 *
 * `agents` are the ones shown to the planner; `everyone` are all connected agents, so probation agents (left out of
 * `agents`) can still be named once, as not to be assigned.
 */
export function planNotes(store: Store, resumes: Resumes, agents: AgentConfig[], everyone: AgentConfig[] = agents): ResumeNotes {
  const lines: Record<string, string[]> = {};
  for (const a of agents) {
    const r = resumes.live(a.id);
    let out = [...r.strengths, ...r.weaknesses];
    if (!out.length && r.runs) out = [`no standout strengths or weaknesses yet (${r.runs} graded run${r.runs === 1 ? "" : "s"}, mean ${(r.byType.reduce((s, t) => s + t.quality * t.runs, 0) / Math.max(1, r.byType.reduce((s, t) => s + t.runs, 0))).toFixed(2)})`];
    // Keep whole lines: drop from the end until it fits.
    while (out.length > 1 && out.join("; ").length > NOTE_CAP) out.pop();
    lines[a.id] = out.map((l) => (l.length > NOTE_CAP ? `${l.slice(0, NOTE_CAP - 1)}…` : l));
  }
  const barred = barredSet(store, everyone); // only where probation is really applied
  const on = everyone.filter((a) => barred.has(a.id));
  const probation = on.length
    ? `On probation (do not assign them anything; they practise on copies of real tasks): ${on.map((a) => { const p = probationStatus(store, a.id); return `${a.name} (${p.graded} of ${p.needed} graded runs)`; }).join(", ")}.`
    : undefined;
  return { lines, ...(probation ? { probation } : {}) };
}
