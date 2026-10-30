import type { AgentConfig } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { now } from "../util.js";

/**
 * S1: taint per task (security spec, Oct 26 2026).
 *
 * A run whose context may include untrusted content (a web page, an inbound email, CRM free text, a chat channel, another vendor's agent
 * whose reads the hub can't see, a message from outside) is "tainted". A tainted task, and every later task of the same goal (its
 * decisions and outputs flow forward), never acts without the owner: Orchestrator.requestApproval sends every sensitive action to a card,
 * whatever POLICY.md allows, whatever the agent "runs without asking", and even when two-key drafts match.
 *
 * The hub can't see what an agent's own connectors return (Claude Code runs WebFetch itself), so taint is set by capability at the start of a
 * run (fail closed: a run that COULD read untrusted content is treated as if it did), and by what the hub itself hands over.
 *
 * Labels name the source ("web", "gmail", "external-agent" ...). Labels of sensitive data sources also stop night-shift re-runs on another
 * vendor (S12). Stored in the kv table so a restart keeps them.
 */

/** Tools whose results are content the owner didn't write. */
export const UNTRUSTED_TOOLS = ["web", "gmail", "slack", "drive", "salesforce"] as const;
/** Labels for data the owner may not want to leave its vendor (S12). Web pages are untrusted but not private. */
export const SENSITIVE_DATA_LABELS = new Set(["gmail", "slack", "drive", "salesforce"]);

const KEY = "security_taint_v1";
const MAX_ENTRIES = 5000;

interface Entry { labels: string[]; at: number; why: string }
type Table = Record<string, Entry>;

export interface TaintScope { agentId: string; roomId?: string; taskId?: string; tokenId?: string }

export class TaintTracker {
  constructor(private store: Store, private goalOf: (taskId: string) => string | undefined = (t) => store.getTask(t)?.goalId) {}

  private table(): Table { return this.store.getKV<Table>(KEY, {}); }
  private save(t: Table) {
    const keys = Object.keys(t);
    if (keys.length > MAX_ENTRIES) for (const k of keys.sort((a, b) => t[a].at - t[b].at).slice(0, keys.length - MAX_ENTRIES)) delete t[k];
    this.store.setKV(KEY, t);
  }

  /** The keys a scope is tainted under: its task, its goal, or (no task) the agent in that room. */
  private keys(s: TaintScope): string[] {
    if (s.taskId) {
      const g = this.goalOf(s.taskId);
      return [`task:${s.taskId}`, ...(g ? [`goal:${g}`] : [])];
    }
    return [`run:${s.agentId}:${s.roomId ?? "*"}`];
  }

  /** Mark a scope (and its goal) tainted. Idempotent; labels accumulate. Audited once per new label. */
  mark(s: TaintScope, labels: string[], why: string) {
    if (!labels.length) return;
    const t = this.table();
    const fresh: string[] = [];
    for (const k of this.keys(s)) {
      const e = t[k] ?? { labels: [], at: now(), why };
      for (const l of labels) if (!e.labels.includes(l)) { e.labels.push(l); if (!fresh.includes(l)) fresh.push(l); }
      e.at = now();
      t[k] = e;
    }
    if (!fresh.length) return;
    this.save(t);
    this.store.audit(s.agentId, "taint.marked", `${s.taskId ?? `run ${s.roomId ?? ""}`}: ${fresh.join(", ")} (${why})`.slice(0, 300));
  }

  markGoal(goalId: string, labels: string[], why: string, actor = "hub") {
    const t = this.table();
    const e = t[`goal:${goalId}`] ?? { labels: [], at: now(), why };
    const fresh = labels.filter((l) => !e.labels.includes(l));
    if (!fresh.length) return;
    e.labels.push(...fresh); e.at = now(); t[`goal:${goalId}`] = e;
    this.save(t);
    this.store.audit(actor, "taint.marked", `goal ${goalId}: ${fresh.join(", ")} (${why})`.slice(0, 300));
  }

  /** Every label on a scope: its own, and its goal's. External MCP keys are always tainted: the hub can't see what those agents read. */
  labels(s: TaintScope): string[] {
    const t = this.table();
    const out = new Set<string>();
    for (const k of this.keys(s)) for (const l of t[k]?.labels ?? []) out.add(l);
    if (s.tokenId) out.add("external-agent");
    return [...out];
  }
  goalLabels(goalId: string): string[] { return [...(this.table()[`goal:${goalId}`]?.labels ?? [])]; }

  isTainted(s: TaintScope): boolean { return this.labels(s).length > 0; }

  /** What a run of this agent could read that the owner didn't write. Taken from the agent as narrowed for the run (room rules applied). */
  static capabilityLabels(agent: Pick<AgentConfig, "tools" | "adapter">): string[] {
    const out: string[] = UNTRUSTED_TOOLS.filter((t) => agent.tools?.[t] === true);
    // An agent the hub reaches over MCP or ACP brings its own connectors; the hub can't see them.
    if (agent.adapter === "mcp" || agent.adapter === "acp") out.push("external-agent");
    return out;
  }

  /** True when a label set includes data from a sensitive source (S12). */
  static hasSensitiveData(labels: string[]): boolean { return labels.some((l) => SENSITIVE_DATA_LABELS.has(l)); }

  /** The agent with every "run without asking" removed, for a tainted run: sensitive tools then always reach the approval gate. */
  static stripAutoApprove<A extends Pick<AgentConfig, "autoApprove">>(agent: A): A {
    if (!agent.autoApprove || !Object.keys(agent.autoApprove).length) return agent;
    const next = { ...agent }; delete next.autoApprove; return next;
  }
}

/** The line added to an approval card for an action from a tainted task. */
export const taintNote = (labels: string[]) =>
  `\n\n[Untrusted content] This task may have read content you didn't write (${labels.join(", ")}). It can't act on its own: you decide.`;
