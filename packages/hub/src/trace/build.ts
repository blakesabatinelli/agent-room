import type {
  Approval, FailureTag, GoalTrace, Goal, Message, RoutingRecord, Task, TraceAttempt, TraceEvent, TracePlan, TraceState, TraceSummary, TraceTask,
} from "@agent-room/shared";
import type { ReplyTurn } from "../turns/turns.js";
import { GRACE_MS, slotFor, slotOf, type Slot } from "./attribute.js";

/**
 * The trace of one goal: plan, tasks in plan order, each attempt with its agent, model, time, cost, outcome, failure, judge and verdict,
 * and what happened during it (approvals, reply turns, posts in the room), with helpers under their parent. Pure: it reads what the
 * hub already recorded (goal, tasks, routing log, approvals, reply turns, messages) and invents nothing. A figure the hub never
 * recorded (tokens, cost) is left out.
 */
export interface TraceInput {
  goal: Goal;
  /** Every task of the goal, helpers included. */
  tasks: Task[];
  /** The goal's routing records. */
  routing: RoutingRecord[];
  messages: Message[];
  approvals: Approval[];
  turns: ReplyTurn[];
  lessons: { id: string; agentId: string; taskType: string; text: string; at: number }[];
  agentName: (id: string) => string;
  now: number;
}

/** Events kept on one attempt. Past this the oldest work-log lines go first. */
export const EVENT_CAP = 30;
const TEXT_CAP = 240;
const ACTIVE: Task["status"][] = ["assigned", "running", "review", "revising"];

const clip = (s: string, n = TEXT_CAP) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const stateOf = (r: RoutingRecord, task: Task): TraceState => {
  switch (r.outcome) {
    case "accepted": case "answered": return "ok";
    case "revise": case "reassign": return "sent_back";
    case "run_failed": case "blocked": return "failed";
    case "needs_input": return "waiting";
    case "interrupted": return "stopped";
    default: return ACTIVE.includes(task.status) && task.routingId === r.id ? "running" : "stopped"; // a record left open by a hub that stopped
  }
};

const planOrder = (tasks: Task[]): Task[] => {
  const sorted = tasks.map((t, i) => ({ t, i })).sort((a, b) => a.t.createdAt - b.t.createdAt || a.i - b.i).map((x) => x.t);
  const ids = new Set(sorted.map((t) => t.id));
  const placed = new Set<string>(); const out: Task[] = [];
  while (out.length < sorted.length) {
    const next = sorted.find((t) => !placed.has(t.id) && t.dependsOn.every((d) => placed.has(d) || !ids.has(d))) ?? sorted.find((t) => !placed.has(t.id))!;
    placed.add(next.id); out.push(next);
  }
  return out;
};

const PLAN_STEP = /^(Plan written|Owner approved the plan|Owner asked for plan changes|Owner amendment)/;

function planOf(goal: Goal, tasks: Task[]): TracePlan {
  const planned = tasks.filter((t) => t.kind !== "subagent");
  const approval: TracePlan["approval"] =
    goal.status === "awaiting_approval" ? { state: "waiting" }
    : goal.approvedAt ? { state: "approved", at: goal.approvedAt }
    : goal.status === "planning" && !planned.length ? { state: "planning" }
    : goal.status === "failed" && /^Plan cancelled/.test(goal.summary ?? "") ? { state: "cancelled" }
    : { state: "not_needed" };
  return {
    ...(goal.contract ? { version: goal.contract.version, lockedAt: goal.contract.lockedAt } : {}),
    approval,
    amendments: (goal.contract?.amendments ?? []).map((a) => ({ at: a.at, text: clip(a.text) })),
    steps: (goal.state?.decisions ?? []).filter((d) => PLAN_STEP.test(d.text)).map((d) => ({ at: d.at, text: clip(d.text) })),
    requirements: (goal.contract?.requirements ?? []).map((r) => ({ id: r.id, text: clip(r.text), status: r.status ?? "open" })),
  };
}

export function buildTrace(inp: TraceInput): GoalTrace {
  const { goal, now } = inp;
  const name = (id: string) => inp.agentName(id);
  const byId = new Map(inp.tasks.map((t) => [t.id, t]));
  const records = inp.routing.filter((r) => r.kind !== "shadow" && !r.shadow).sort((a, b) => a.at - b.at);

  // ---- attempts, from the routing log (one record per run handed to an agent)
  const attemptsFor = (task: Task): TraceAttempt[] => {
    const recs = records.filter((r) => r.taskId === task.id);
    const used = new Set<number>();
    const history = (task.history ?? []).filter((h) => h.agentId !== "hub" && h.agentId !== "orchestrator");
    return recs.map((r, i) => {
      const nextAt = recs[i + 1]?.at ?? Infinity;
      const hi = history.findIndex((h, k) => !used.has(k) && h.agentId === r.chosen && h.at >= r.at - 1000 && h.at < nextAt);
      if (hi >= 0) used.add(hi);
      const note = hi >= 0 ? clip(history[hi].note, 300) : undefined;
      const state = stateOf(r, task);
      const tokens = r.usage && (r.usage.inputTokens !== undefined || r.usage.outputTokens !== undefined) ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : undefined;
      const fail = r.failureTag ? { tag: r.failureTag, reason: clip(r.failureNote ?? task.failures?.find((f) => f.routingId === r.id)?.note ?? "", 300) } : undefined;
      const judgeIds = r.judgment ? r.judgment.judgeAgentId.split(",").map((x) => x.trim()).filter(Boolean) : [];
      const latest = task.routingId === r.id && task.judgment ? task.judgment : undefined;
      const a: TraceAttempt = {
        id: r.id, n: i + 1, at: r.at,
        ...(r.completedAt ? { endedAt: r.completedAt } : {}),
        ...(r.seconds !== undefined ? { seconds: r.seconds } : r.completedAt ? { seconds: Math.round((r.completedAt - r.at) / 100) / 10 } : {}),
        agentId: r.chosen, agentName: name(r.chosen),
        ...(r.modelVersion || r.modelRequested ? { model: r.modelVersion ?? r.modelRequested } : {}),
        ...(r.profileId ? { profileId: r.profileId } : {}),
        reason: r.reason, revision: r.revision,
        ...(r.usage ? { usage: r.usage } : {}), ...(tokens !== undefined ? { tokens } : {}),
        outcome: r.outcome, state, accepted: r.outcome === "accepted" || r.outcome === "answered",
        ...(r.outcome === "revise" || r.outcome === "reassign" ? { sentBack: r.outcome } : {}),
        ...(fail ? { failure: fail } : {}),
        ...(r.judgment ? { judge: { agentIds: judgeIds, names: judgeIds.map(name), score: r.judgment.score, verdict: r.judgment.verdict, ...(latest?.feedback ? { feedback: clip(latest.feedback, 300) } : {}) } } : {}),
        ...(note ? { note } : {}),
        events: [],
      };
      return a;
    });
  };

  // ---- task nodes (helpers nest under their parent)
  const node = (task: Task): TraceTask => {
    const attempts = attemptsFor(task);
    const helperTasks = inp.tasks.filter((t) => t.parentTaskId === task.id).sort((a, b) => a.createdAt - b.createdAt);
    const helpers = helperTasks.map((h) => {
      const n = node(h);
      const inside = [...attempts].reverse().find((a) => h.createdAt >= a.at - GRACE_MS && h.createdAt <= (a.endedAt ?? now) + GRACE_MS) ?? [...attempts].reverse().find((a) => a.at <= h.createdAt);
      return inside ? { ...n, parentAttempt: inside.n } : n;
    });
    const who = task.assignee ?? task.owner ?? (task.spawnedBy);
    return {
      id: task.id, title: task.title, taskType: task.taskType, status: task.status, helper: task.kind === "subagent",
      ...(task.native ? { native: true } : {}), ...(task.kind === "subagent" && task.readOnly !== undefined ? { readOnly: task.readOnly } : {}),
      ...(who ? { assigneeId: who, assigneeName: name(who) } : {}),
      dependsOn: task.dependsOn ?? [], ...(task.origin ? { origin: task.origin } : {}), ...(task.flagged?.length ? { flagged: task.flagged } : {}),
      attempts, helpers,
    };
  };
  const planned = inp.tasks.filter((t) => t.kind !== "subagent");
  const tasks = planOrder(planned).map((t) => node(t));
  const flat: TraceTask[] = [];
  const walk = (ts: TraceTask[]) => { for (const t of ts) { flat.push(t); walk(t.helpers); } };
  walk(tasks);

  // ---- what happened during each attempt
  const attemptAt = new Map<string, TraceAttempt>(); // routing id -> attempt
  for (const t of flat) for (const a of t.attempts) attemptAt.set(a.id, a);
  const slots: Slot[] = records.filter((r) => attemptAt.has(r.id)).map((r) => slotOf(r, now));
  const loose: TraceEvent[] = [];
  const put = (slot: Slot | undefined, ev: TraceEvent) => { const a = slot ? attemptAt.get(slot.id) : undefined; if (a) a.events.push(ev); else loose.push(ev); };
  const agentsHere = new Set(records.map((r) => r.chosen));
  const start = goal.createdAt - 1000;
  const lastEnd = Math.max(0, ...records.map((r) => r.completedAt ?? r.at));
  const live = ["running", "planning", "awaiting_approval", "paused"].includes(goal.status);
  // A finished goal ends at its last attempt, last judge note or final check. (A task's updatedAt is not used: it moves whenever anything touches the task later.)
  const lastNote = Math.max(0, ...inp.messages.filter((m) => m.roomId === goal.roomId && m.taskId && byId.has(m.taskId)).map((m) => m.createdAt));
  const finish = live ? now : Math.max(lastEnd, lastNote, goal.state?.progress?.lastAcceptAt ?? 0, goal.state?.gate?.at ?? 0, goal.createdAt);

  const approvalsIn = inp.approvals.filter((a) => (!a.roomId || a.roomId === goal.roomId) && a.createdAt >= start && a.createdAt <= finish + GRACE_MS);
  for (const a of approvalsIn) {
    const slot = slotFor(slots, { agentId: a.agentId, roomId: goal.roomId, at: a.createdAt });
    if (!slot && !agentsHere.has(a.agentId)) continue; // somebody else's card in the same room
    const wait = a.decidedAt ? Math.round((a.decidedAt - a.createdAt) / 1000) : undefined;
    put(slot, { kind: "approval", at: a.createdAt, id: a.id, tool: a.tool, action: clip(a.action, 120), status: a.status, ...(a.auto ? { auto: true } : {}), ...(a.decidedAt ? { decidedAt: a.decidedAt } : {}), ...(wait !== undefined ? { waitSeconds: wait } : {}) });
  }
  for (const t of inp.turns) {
    if (t.roomId !== goal.roomId || t.startedAt < start || t.startedAt > finish + GRACE_MS) continue;
    const slot = slotFor(slots, { agentId: t.agentId, roomId: t.roomId, at: t.startedAt });
    if (!slot && !agentsHere.has(t.agentId)) continue;
    put(slot, { kind: "turn", at: t.startedAt, id: t.id, turnKind: t.kind, status: t.status, ...(t.endedAt ? { endedAt: t.endedAt } : {}), ...(t.via ? { via: t.via } : {}), dropped: t.dropped, ...(t.error ? { error: clip(t.error, 200) } : {}) });
  }
  for (const m of inp.messages) {
    if (m.roomId !== goal.roomId || !m.taskId || !byId.has(m.taskId)) continue;
    const mine = (attemptsOfTask(flat, m.taskId));
    const a = [...mine].reverse().find((x) => x.at <= m.createdAt); // the latest attempt that had started: judge notes come after the run ends and before the next one starts
    const ev: TraceEvent = { kind: "post", at: m.createdAt, id: m.id, author: m.author.kind === "agent" ? name(m.author.id) : m.author.name, text: clip(m.text), ...(m.quiet ? { quiet: true } : {}) };
    if (a) a.events.push(ev); else loose.push(ev);
  }
  for (const a of attemptAt.values()) {
    a.events.sort((x, y) => x.at - y.at);
    if (a.events.length > EVENT_CAP) {
      let drop = a.events.length - EVENT_CAP;
      const keep = a.events.filter((e) => { if (drop > 0 && e.kind === "post" && e.quiet) { drop--; return false; } return true; });
      const rest = keep.filter((e) => { if (drop > 0 && e.kind === "post") { drop--; return false; } return true; });
      a.hidden = a.events.length - rest.length; a.events = rest;
    }
  }
  loose.sort((x, y) => x.at - y.at);

  // ---- summary
  const everyAttempt = flat.flatMap((t) => t.attempts);
  const mine = flat.filter((t) => !t.helper).flatMap((t) => t.attempts);
  const failures: Partial<Record<FailureTag, number>> = {};
  for (const a of mine) if (a.failure) failures[a.failure.tag] = (failures[a.failure.tag] ?? 0) + 1;
  const events = [...everyAttempt.flatMap((a) => a.events), ...loose];
  const cards = events.filter((e): e is Extract<TraceEvent, { kind: "approval" }> => e.kind === "approval");
  const costs = everyAttempt.map((a) => a.usage?.costUsd).filter((c): c is number => c !== undefined);
  const toks = everyAttempt.map((a) => a.tokens).filter((c): c is number => c !== undefined);
  const live2 = planned.filter((t) => t.status !== "cancelled" && !(t.recovered && t.status !== "done"));
  const summary: TraceSummary = {
    tasksDone: live2.filter((t) => t.status === "done").length, tasksTotal: live2.length,
    attempts: mine.length, helpers: flat.filter((t) => t.helper).length,
    sentBack: mine.filter((a) => a.state === "sent_back").length,
    failures, failureTotal: Object.values(failures).reduce((n, v) => n + (v ?? 0), 0),
    elapsedSeconds: Math.max(0, Math.round((finish - goal.createdAt) / 1000)),
    workSeconds: Math.round(everyAttempt.reduce((n, a) => n + (a.seconds ?? 0), 0)),
    approvals: { total: cards.length, pending: cards.filter((c) => c.status === "pending").length, auto: cards.filter((c) => c.auto).length },
    ...(toks.length ? { tokens: toks.reduce((n, v) => n + v, 0) } : {}),
    ...(costs.length ? { costUsd: Math.round(costs.reduce((n, v) => n + v, 0) * 10000) / 10000 } : {}),
  };

  return {
    at: now,
    goal: { id: goal.id, roomId: goal.roomId, text: clip(goal.contract?.objective || goal.text, 400), status: goal.status, createdAt: goal.createdAt, ...(goal.summary ? { summary: clip(goal.summary, 400) } : {}) },
    plan: planOf(goal, inp.tasks), summary, tasks, loose,
    lessons: inp.lessons.map((l) => ({ id: l.id, agentId: l.agentId, agentName: name(l.agentId), taskType: l.taskType, text: clip(l.text, 300), at: l.at })),
  };
}

function attemptsOfTask(flat: TraceTask[], taskId: string): TraceAttempt[] {
  return flat.find((t) => t.id === taskId)?.attempts ?? [];
}
