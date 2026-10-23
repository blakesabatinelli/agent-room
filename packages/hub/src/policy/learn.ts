import { createHash } from "node:crypto";
import type { Approval } from "@agent-room/shared";
import { isTwoKey, parsedInput } from "../twokey/classify.js";
import { matchFor } from "./match.js";
import { labelFor, learnable, shapeOf, type Narrow } from "./shape.js";

/**
 * 4.2 Learning from the owner's own answers. Approvals the owner decided (not ones an agent's "run without asking" setting passed,
 * not questions, not file-write proposals, not ones that timed out) are grouped by agent and the shape of the request
 * ("drive read under /Board", "gmail send to @atmosphere.tv", "shell: npm test"). A group that holds a steady answer becomes a proposed rule:
 *
 *   approved at least N times and never rejected   -> allow
 *   rejected at least 3 times and never approved   -> deny
 *   both, and at least N answers                   -> ask (with a note saying so)
 *
 * Never an "allow" for what the two-key check owns (email sends, CRM writes, deletes, a shell command that deletes or can't be read): the owner answered those
 * with two drafts in front of them, and a rule must not skip that. A "deny" or "ask" is still fine.
 *
 * Nothing here writes a file. It returns proposals; the engine puts them in POLICY.md, unaccepted.
 */

export interface LearnConfig {
  /** Approvals, and no rejections, before "allow" is proposed. */
  minApprovals: number;
  /** Rejections, and no approvals, before "deny" is proposed. */
  minRejections: number;
  /** Only answers this recent count. */
  windowDays: number;
}
export const LEARN_DEFAULTS: LearnConfig = { minApprovals: 5, minRejections: 3, windowDays: 30 };
export const FORGET_DAYS = 30;

export interface Proposal {
  /** `learned-` and eight hex digits of the group: the same group always gets the same id, so it is never proposed twice. */
  id: string;
  agentId: string;
  tool: string;
  verb: string;
  narrow: Narrow;
  effect: "allow" | "ask" | "deny";
  match: string;
  scope: string;
  approved: number;
  rejected: number;
  /** The first answer in the window. */
  since: number;
}

export const learnedId = (agentId: string, tool: string, verb: string, narrow: Narrow) =>
  `learned-${createHash("sha1").update(`${agentId}|${tool}|${verb}|${narrow.kind === "none" ? "" : `${narrow.kind}:${narrow.value.toLowerCase()}`}`).digest("hex").slice(0, 8)}`;

/** Approvals the owner answered by hand. */
export const ownerAnswered = (a: Approval) =>
  !a.auto && !a.question && !a.proposalId && a.decidedAt !== undefined && (a.status === "approved" || a.status === "rejected");

export function learn(history: Approval[], nowMs: number, cfg: LearnConfig = LEARN_DEFAULTS): Proposal[] {
  const from = nowMs - cfg.windowDays * 86_400_000;
  const groups = new Map<string, { agentId: string; tool: string; verb: string; narrow: Narrow; approved: number; rejected: number; since: number; twoKey: boolean }>();
  for (const a of history) {
    if (!ownerAnswered(a) || a.decidedAt! < from) continue;
    const l = learnable(shapeOf(a.tool, a.action, a.detail));
    if (!l) continue;
    const id = learnedId(a.agentId, a.tool, l.verb, l.narrow);
    const g = groups.get(id) ?? { agentId: a.agentId, tool: a.tool, verb: l.verb, narrow: l.narrow, approved: 0, rejected: 0, since: a.decidedAt!, twoKey: false };
    // One approval of a send, CRM write, delete or a shell command that can't be read makes the whole shape one the two-key check owns.
    if (isTwoKey(a.tool, a.action, parsedInput(a.detail, undefined) ?? a.detail).twoKey) g.twoKey = true;
    if (a.status === "approved") g.approved++; else g.rejected++;
    g.since = Math.min(g.since, a.decidedAt!);
    groups.set(id, g);
  }
  const out: Proposal[] = [];
  for (const [id, g] of groups) {
    const effect = g.rejected === 0 && g.approved >= cfg.minApprovals ? (g.twoKey ? undefined : "allow")
      : g.approved === 0 && g.rejected >= cfg.minRejections ? "deny"
      : g.approved > 0 && g.rejected > 0 && g.approved + g.rejected >= cfg.minApprovals ? "ask" : undefined;
    if (!effect) continue;
    out.push({ id, agentId: g.agentId, tool: g.tool, verb: g.verb, narrow: g.narrow, effect, match: matchFor(g.verb, g.narrow), scope: `agent:${g.agentId}`, approved: g.approved, rejected: g.rejected, since: g.since });
  }
  // Steadiest evidence first, so a capped batch keeps the strongest rules.
  return out.sort((a, b) => b.approved + b.rejected - (a.approved + a.rejected) || a.id.localeCompare(b.id));
}

const dayLabel = (ms: number, zone: string) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: zone });

/** The one plain-English line a proposal gets in POLICY.md: "Allow Claude's Drive reads in /Board: you approved 7 of 7 since Oct 12." */
export function describeProposal(p: Proposal, agentName: string, zone = "UTC"): string {
  const what = `${agentName}'s ${labelFor(p.tool, p.verb, p.narrow)}`;
  const since = `since ${dayLabel(p.since, zone)}`;
  if (p.effect === "allow") return `Allow ${what}: you approved ${p.approved} of ${p.approved} ${since}.`;
  if (p.effect === "deny") return `Deny ${what}: you rejected ${p.rejected} of ${p.rejected} ${since}.`;
  return `Always ask before ${what}: you approved ${p.approved} and rejected ${p.rejected} ${since}.`;
}
