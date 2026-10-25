import type { AgentScore, Approval, Message, OfficeAgent, OfficeAgentTask, OfficeApprovalItem, OfficeCounts, OfficeOutput, OfficeTaskNode, Task } from "@agent-room/shared";

/**
 * 3.4b Office, live operations floor: the detail behind each desk and the goal's task flow, for the inspector, the monitors and the header.
 * Pure functions of store rows, like the rest of office/state.ts. Nothing here is stored or guessed: when the hub doesn't know something
 * (how far along a task is, what an agent does) the field is left out and the page says so.
 */

/** What the persona (3.2) says about an agent, as the office shows it. */
export interface PersonaLine { role?: string; about?: string }

const IN_PROGRESS: Task["status"][] = ["assigned", "running", "review", "revising"];
const OPEN: Task["status"][] = ["pending", "assigned", "running", "review", "revising", "waiting"];
const MAX_NODES = 24;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** One line of plain text: markdown marks and extra spaces removed, clipped with an ellipsis. */
export function plainLine(s: string, max: number): string {
  const t = s.replace(/[`*_>#|]+/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
const firstLine = (s: string, max: number) => plainLine(s.split(/\r?\n/).find((l) => plainLine(l, max)) ?? "", max);

/** The goal's first line, cut at a word so it fits on the pedestal. */
export function shortTitle(text: string, max = 48): string {
  const line = firstLine(text, 400);
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1), sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The goal's planned tasks in plan order (creation order, ties kept as stored). Cancelled ones are left off the board. */
export function planNodes(goalTasks: Task[], agentIds: Set<string>): OfficeTaskNode[] {
  return goalTasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.status !== "cancelled")
    .sort((a, b) => a.t.createdAt - b.t.createdAt || a.i - b.i)
    .slice(0, MAX_NODES)
    .map(({ t }) => {
      const judge = t.judgment?.judgeAgentId;
      const who = t.assignee ?? t.owner;
      return {
        id: t.id, title: t.title, status: t.status, ...(who ? { assignee: who } : {}), dependsOn: t.dependsOn ?? [], attempts: t.attempts ?? 0, updatedAt: t.updatedAt,
        ...(judge && agentIds.has(judge) ? { judgeId: judge } : {}), // "owner", "checks" and "system" are not desks
      };
    });
}

/** Failed tasks, tasks waiting for the owner, and open tasks whose agent waits on a pending approval. */
export function officeCounts(agentCount: number, nodes: OfficeTaskNode[], pending: Approval[]): OfficeCounts {
  const asking = new Set(pending.map((p) => p.agentId));
  return {
    agents: agentCount,
    tasks: nodes.length,
    inProgress: nodes.filter((n) => IN_PROGRESS.includes(n.status)).length,
    blockers: nodes.filter((n) => n.status === "failed" || n.status === "waiting" || (OPEN.includes(n.status) && !!n.assignee && asking.has(n.assignee))).length,
  };
}

function progressOf(t: Task, score: AgentScore | undefined, now: number): Pick<OfficeAgentTask, "progress" | "progressFrom"> {
  // In review the latest word is the agent's own report; while revising it is the judge's verdicts.
  const crit = t.status === "review" ? t.report?.criteria : t.status === "revising" ? t.judgment?.criteria : undefined;
  const verdicts = crit ? Object.values(crit) : [];
  if (verdicts.length) return { progress: round2(verdicts.filter((c) => c.verdict === "PASS").length / verdicts.length), progressFrom: "criteria" };
  if ((t.status === "running" || t.status === "assigned") && t.claimedAt && score && score.runs > 0 && score.avgSeconds > 0) {
    return { progress: round2(Math.min(0.95, Math.max(0, (now - t.claimedAt) / 1000 / score.avgSeconds))), progressFrom: "typical_time" };
  }
  return {};
}

function stepOf(t: Task): string {
  switch (t.status) {
    case "assigned": return "Assigned, about to start";
    case "running": return t.attempts > 1 ? `Attempt ${t.attempts}, after feedback` : "First attempt";
    case "review": return "Waiting for the judge";
    case "revising": return t.judgment?.feedback ? `Revising: ${firstLine(t.judgment.feedback, 90)}` : "Revising";
    case "waiting": return "Waiting for your input";
    case "pending": return "Not started";
    default: return t.status[0].toUpperCase() + t.status.slice(1);
  }
}

export interface DetailInput {
  agentId: string;
  /** The task that explains the agent's state (as chosen by buildOfficeState). */
  current?: Task;
  /** Planned tasks (not subagents) in the office's rooms. */
  tasks: Task[];
  byId: Map<string, Task>;
  /** The board's tasks in plan order. */
  nodes: OfficeTaskNode[];
  messages: Message[];
  pending: Approval[];
  score?: AgentScore;
  persona?: PersonaLine;
  now: number;
}

/** Everything the inspector and the desk's monitor show for one agent. */
export function agentDetail(i: DetailInput): Required<Pick<OfficeAgent, "outputs" | "log" | "approvals">> & Pick<OfficeAgent, "role" | "about" | "task" | "next"> {
  const mine = i.pending.filter((p) => p.agentId === i.agentId);
  const approvals: OfficeApprovalItem[] = mine.map((p) => ({ id: p.id, tool: p.tool, action: p.action, detail: plainLine(p.detail ?? "", 160), createdAt: p.createdAt }));

  let task: OfficeAgentTask | undefined;
  const t = i.current;
  if (t) {
    const blockedBy = (t.dependsOn ?? []).map((d) => i.byId.get(d)).filter((d): d is Task => !!d && d.status !== "done" && d.status !== "cancelled").map((d) => d.title);
    for (const p of mine) blockedBy.push(`Approval: ${plainLine(p.action, 80)}`);
    const startedAt = t.claimedAt ?? (IN_PROGRESS.includes(t.status) ? t.updatedAt : undefined);
    task = { id: t.id, title: t.title, status: t.status, attempts: t.attempts ?? 0, ...(startedAt ? { startedAt } : {}), ...progressOf(t, i.score, i.now), step: stepOf(t), blockedBy };
  }

  const nextNode = i.nodes.find((n) => n.assignee === i.agentId && n.status === "pending" && n.id !== t?.id);

  const outputs: OfficeOutput[] = [];
  for (const x of i.tasks) {
    if (x.assignee === i.agentId && x.status === "done") outputs.push({ at: x.updatedAt, kind: "accepted", text: plainLine(x.title, 120), taskId: x.id });
    for (const h of x.history ?? []) if (h.agentId === i.agentId && (h.outcome === "fail" || h.outcome === "drift")) outputs.push({ at: h.at, kind: "sent_back", text: plainLine(x.title, 120), taskId: x.id });
  }
  const said = i.messages.filter((m) => m.author.kind === "agent" && m.author.id === i.agentId && !m.quiet && m.text.trim());
  for (const m of said.slice(-5)) outputs.push({ at: m.createdAt, kind: "message", text: firstLine(m.text, 120), ...(m.taskId ? { taskId: m.taskId } : {}) });
  outputs.sort((a, b) => b.at - a.at);

  const log = said.slice(-3).flatMap((m) => m.text.split(/\r?\n/).map((l) => plainLine(l, 72)).filter(Boolean)).slice(-8);

  return {
    ...(i.persona?.role ? { role: i.persona.role } : {}), ...(i.persona?.about ? { about: i.persona.about } : {}),
    ...(task ? { task } : {}), ...(nextNode ? { next: nextNode.title } : {}),
    outputs: outputs.slice(0, 5), log, approvals,
  };
}
