import type { AgentConfig, AgentScore, Approval, Goal, Message, OfficeAgent, OfficeAgentState, OfficeGoal, OfficeHelper, OfficeRequirement, OfficeState, ServerEvent, Task } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { ControlFolder } from "../control/folder.js";
import { isStarterPersona, readPersona } from "../persona/index.js";
import { agentDetail, officeCounts, planNodes, plainLine, shortTitle, type PersonaLine } from "./floor.js";

/**
 * 3.4 The office: what each agent is doing, derived from the same live state as the room.
 * Nothing here is stored. `buildOfficeState` is a pure function of the store's rows and the working events;
 * `OfficeTracker` keeps the working events (which are never persisted) and reads the rest from the store.
 */

/**
 * The fields 3.3 (subagents) adds to Task. Read defensively: on a base without 3.3 none of them is ever set,
 * and the office simply shows no helpers.
 */
export type SubagentFields = { parentTaskId?: string; depth?: number; spawnedBy?: string; kind?: "task" | "subagent"; readOnly?: boolean };
type OfficeTask = Task & SubagentFields;

const isSubagent = (t: OfficeTask) => t.kind === "subagent" || !!t.parentTaskId;
const OPEN: Task["status"][] = ["pending", "assigned", "running", "review", "revising", "waiting"];
const ACTIVE_GOAL: Goal["status"][] = ["running", "awaiting_approval", "planning", "paused"];
/** A working event that was never closed (a crashed run) stops counting after this long. */
const STALE_WORKING_MS = 30 * 60_000;
/** 3.4b: how far back each room's messages are read for outputs and monitors. */
const MESSAGES_PER_ROOM = 80;

export interface OfficeInput {
  agents: AgentConfig[];
  tasks: Task[];
  goals: Goal[];
  approvals: Approval[];
  /** roomId -> agentId -> label, from `working` events that are still active. */
  working: Record<string, Record<string, string>>;
  roomId?: string;
  now?: number;
  /** 3.4b: recent messages in the office's rooms (for each agent's outputs and monitor), scores (for typical run time) and persona lines. */
  messages?: Message[];
  scores?: AgentScore[];
  personas?: Record<string, PersonaLine>;
}

function helperState(t: Task): OfficeHelper["state"] {
  if (t.status === "review") return "judged";
  if (t.status === "running" || t.status === "assigned" || t.status === "revising") return "working";
  return "idle";
}

function whiteboard(goals: Goal[], tasks: Task[], agentIds: Set<string>): OfficeGoal | undefined {
  const live = goals.filter((g) => g.status !== "superseded");
  const newest = (a: Goal, b: Goal) => b.createdAt - a.createdAt;
  const active = live.filter((g) => ACTIVE_GOAL.includes(g.status)).sort((a, b) => ACTIVE_GOAL.indexOf(a.status) - ACTIVE_GOAL.indexOf(b.status) || newest(a, b));
  const goal = active[0] ?? live.sort(newest)[0];
  if (!goal) return undefined;
  let reqs: OfficeRequirement[] = (goal.contract?.requirements ?? []).map((r) => ({ id: r.id, text: r.text, status: r.status ?? "open" }));
  // A goal planned without a requirement list still has deliverables: show those, ticked only once the goal is done.
  if (!reqs.length) reqs = (goal.contract?.deliverables ?? []).map((text, i) => ({ id: `D${i + 1}`, text, status: goal.status === "done" ? "met" : "open" }));
  const own = tasks.filter((t) => t.goalId === goal.id && !isSubagent(t as OfficeTask) && t.status !== "cancelled");
  const progress = goal.status === "done" ? 1
    : reqs.length ? reqs.filter((r) => r.status === "met").length / reqs.length
    : own.length ? own.filter((t) => t.status === "done").length / own.length : 0;
  const nodes = planNodes(tasks.filter((t) => t.goalId === goal.id && !isSubagent(t as OfficeTask)), agentIds); // 3.4b: the task-flow board
  const next = goal.state?.nextAction?.trim();
  return { id: goal.id, objective: goal.contract?.objective || goal.text, status: goal.status, requirements: reqs, progress: Math.round(progress * 100) / 100,
    title: shortTitle(goal.text || goal.contract?.objective || ""), tasks: nodes, ...(next ? { nextAction: plainLine(next, 160) } : {}) };
}

export function buildOfficeState(i: OfficeInput): OfficeState {
  const inRoom = (roomId?: string) => !i.roomId || !roomId || roomId === i.roomId;
  const tasks = i.tasks as OfficeTask[];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // An approval without a room (an MCP agent asking on its own) belongs to every view.
  const pending = i.approvals.filter((a) => a.status === "pending" && inRoom(a.roomId));
  const workingNow = (agentId: string) => {
    for (const [roomId, m] of Object.entries(i.working)) if (inRoom(roomId) && agentId in m) return m[agentId] || "working";
    return undefined;
  };

  const helpersOf = new Map<string, OfficeHelper[]>();
  for (const t of tasks) {
    if (!isSubagent(t) || !OPEN.includes(t.status)) continue;
    const parent = t.parentTaskId ? byId.get(t.parentTaskId) : undefined;
    const deskAgent = parent?.assignee ?? t.spawnedBy;
    if (!deskAgent) continue;
    const list = helpersOf.get(deskAgent) ?? [];
    list.push({ id: t.id, agentId: t.assignee ?? deskAgent, readOnly: t.readOnly === true, state: helperState(t), title: t.title });
    helpersOf.set(deskAgent, list);
  }

  const now = i.now ?? Date.now();
  const goal = whiteboard(i.goals, tasks, new Set(i.agents.map((a) => a.id)));
  const planned = tasks.filter((t) => !isSubagent(t));
  const messages = (i.messages ?? []).filter((m) => inRoom(m.roomId));
  const scoreOf = (agentId: string, taskType: string) => i.scores?.find((s) => s.agentId === agentId && s.taskType === taskType);

  const agents: OfficeAgent[] = i.agents.map((a) => {
    const own = tasks.filter((t) => t.assignee === a.id && !isSubagent(t));
    const asking = pending.find((p) => p.agentId === a.id);
    const judged = own.find((t) => t.status === "review");
    const running = own.find((t) => t.status === "running" || t.status === "assigned" || t.status === "revising");
    const chat = workingNow(a.id);
    let state: OfficeAgentState; let taskTitle: string | undefined;
    if (!a.enabled) state = "offline";
    else if (asking) { state = "waiting_approval"; taskTitle = (running ?? judged)?.title ?? asking.action; }
    else if (judged) { state = "judged"; taskTitle = judged.title; }
    else if (running || chat !== undefined) { state = "working"; taskTitle = running?.title ?? chat; }
    else state = "idle";
    // 3.4b: the task behind the state (a task waiting for the owner's input explains an idle desk), and the inspector's detail
    const current = state === "offline" ? undefined : state === "waiting_approval" ? (running ?? judged) : state === "judged" ? judged : running ?? own.find((t) => t.status === "waiting");
    const detail = agentDetail({ agentId: a.id, current, tasks: planned, byId, nodes: goal?.tasks ?? [], messages, pending, score: current ? scoreOf(a.id, current.taskType) : undefined, persona: i.personas?.[a.id], now });
    return { id: a.id, name: a.name, color: a.color, avatar: a.avatar || (a.name || "?")[0].toUpperCase(), state, ...(taskTitle ? { taskTitle } : {}), helpers: helpersOf.get(a.id) ?? [], ...detail };
  });

  return { at: now, ...(i.roomId ? { roomId: i.roomId } : {}), agents, goal, pendingApprovals: pending.length, counts: officeCounts(agents.length, goal?.tasks ?? [], pending) };
}

/** Keeps the `working` events (they are not stored anywhere) and builds the office from them and the store. */
export class OfficeTracker {
  private working = new Map<string, Map<string, { label: string; at: number }>>();
  private readonly listener = (e: ServerEvent) => this.apply(e);

  constructor(private store: Store, private clock: () => number = Date.now, private control: () => ControlFolder | undefined = () => undefined) { store.on("event", this.listener); }
  dispose() { this.store.off("event", this.listener); }

  /** Feed one live event. Only `working` changes what the tracker holds; everything else is read from the store when asked. */
  apply(e: ServerEvent) {
    if (e.type !== "working") return;
    const room = this.working.get(e.roomId) ?? new Map();
    if (e.active) room.set(e.agentId, { label: e.label ?? "", at: this.clock() }); else room.delete(e.agentId);
    if (room.size) this.working.set(e.roomId, room); else this.working.delete(e.roomId);
  }

  private workingNow(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    const t = this.clock();
    for (const [roomId, m] of this.working) for (const [agentId, w] of m) if (t - w.at < STALE_WORKING_MS) (out[roomId] ??= {})[agentId] = w.label;
    return out;
  }

  /** Each agent's persona role, and the first line of its bio when it has more than the starter text. */
  private personas(): Record<string, PersonaLine> {
    const out: Record<string, PersonaLine> = {};
    for (const a of this.store.listAgents()) {
      const p = readPersona(this.store, this.control(), a.id);
      if (!p) continue;
      const about = isStarterPersona(p) ? "" : plainLine(p.body.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#")) ?? "", 140);
      out[a.id] = { ...(p.role ? { role: plainLine(p.role, 80) } : {}), ...(about ? { about } : {}) };
    }
    return out;
  }

  state(roomId?: string): OfficeState {
    const rooms = roomId ? [roomId] : this.store.listRooms().map((r) => r.id);
    return buildOfficeState({
      agents: this.store.listAgents(),
      tasks: rooms.flatMap((id) => this.store.listTasks({ roomId: id, subagents: true })),
      goals: rooms.flatMap((id) => this.store.listGoals(id)),
      approvals: this.store.listApprovals("pending"),
      working: this.workingNow(),
      roomId, now: this.clock(),
      // 3.4b: what the inspector and the monitors show
      messages: rooms.flatMap((id) => this.store.listMessages(id, MESSAGES_PER_ROOM)),
      scores: this.store.listScores(),
      personas: this.personas(),
    });
  }
}
