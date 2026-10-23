// ---- 3.1 What the goal card, the verdict chips and the command palette show, as plain data.
// Shared by the Mac app and (as a hand port in hub/web/goalview.js, the phone app has no build step) the phone app.
// test/design.test.ts runs both over the same fixtures and requires identical answers. Change them together.
// Types only come from the package index; there are no runtime imports, so Metro and tsx both load it.

import type { AgentConfig, Goal, Message, Task, Room } from "./index.js";

// ---------- the goal card

export type GoalStateKey = "planning" | "awaiting_approval" | "running" | "waiting" | "paused" | "done" | "failed";
export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

export interface GoalCardRequirement { id: string; text: string; status: "open" | "met" | "unmet"; evidence?: string }

export interface GoalCardModel {
  goalId: string;
  /** The contract's objective once the plan is written, the owner's words until then. */
  objective: string;
  state: { key: GoalStateKey; label: string; tone: Tone };
  /** The "Done means" list (G1, G2, ...). Empty until the plan is written. */
  requirements: GoalCardRequirement[];
  met: number;
  total: number;
  tasksDone: number;
  tasksTotal: number;
  /** What the owner needs to read: the question the goal is waiting on, or what happens next. */
  note?: { kind: "waiting" | "next"; text: string };
  /** The goal is still moving (or waiting on the owner), so the card opens expanded. */
  live: boolean;
}

const STATE_LABEL: Record<GoalStateKey, string> = {
  planning: "Planning", awaiting_approval: "Awaiting approval", running: "Running", waiting: "Waiting on you",
  paused: "Paused", done: "Done", failed: "Failed",
};
const STATE_TONE: Record<GoalStateKey, Tone> = {
  planning: "neutral", awaiting_approval: "warn", running: "accent", waiting: "warn", paused: "neutral", done: "ok", failed: "danger",
};

export function goalStateKey(g: Pick<Goal, "status" | "state">): GoalStateKey {
  if (g.status === "paused" && g.state?.waitingOnOwner) return "waiting";
  if (g.status === "superseded") return "done";
  return g.status as GoalStateKey;
}

/** The goal the card shows: the live one if there is one, else the newest. Superseded goals never show. */
export function pickGoal(goals: Goal[]): Goal | undefined {
  const own = goals.filter((g) => g.status !== "superseded");
  const live = (g: Goal) => g.status === "planning" || g.status === "awaiting_approval" || g.status === "running" || g.status === "paused";
  const byNew = (a: Goal, b: Goal) => b.createdAt - a.createdAt;
  return own.filter(live).sort(byNew)[0] ?? own.sort(byNew)[0];
}

export function goalCardModel(goal: Goal, tasks: Task[]): GoalCardModel {
  const key = goalStateKey(goal);
  const mine = tasks.filter((t) => t.goalId === goal.id && t.status !== "cancelled");
  const requirements = (goal.contract?.requirements ?? []).map((r) => ({
    id: r.id, text: r.text, status: (r.status ?? "open") as GoalCardRequirement["status"], ...(r.evidence ? { evidence: r.evidence } : {}),
  }));
  const waiting = goal.state?.waitingOnOwner;
  const next = goal.state?.nextAction;
  return {
    goalId: goal.id,
    objective: goal.contract?.objective || goal.text,
    state: { key, label: STATE_LABEL[key], tone: STATE_TONE[key] },
    requirements,
    met: requirements.filter((r) => r.status === "met").length,
    total: requirements.length,
    tasksDone: mine.filter((t) => t.status === "done").length,
    tasksTotal: mine.length,
    ...(waiting ? { note: { kind: "waiting" as const, text: waiting } } : next && key === "running" ? { note: { kind: "next" as const, text: next } } : {}),
    live: key !== "done" && key !== "failed",
  };
}

/** "2 of 5 met, 3 of 6 tasks done". Terse enough for the collapsed line. */
export function goalProgressLine(m: GoalCardModel): string {
  const parts: string[] = [];
  if (m.total) parts.push(`${m.met} of ${m.total} met`);
  if (m.tasksTotal) parts.push(`${m.tasksDone} of ${m.tasksTotal} ${m.tasksTotal === 1 ? "task" : "tasks"} done`);
  return parts.join(", ");
}

/** The share of the goal that is finished, 0 to 1: requirements when the plan has them, otherwise tasks. */
export function goalFraction(m: GoalCardModel): number {
  if (m.state.key === "done") return 1;
  if (m.total) return m.met / m.total;
  if (m.tasksTotal) return m.tasksDone / m.tasksTotal;
  return 0;
}

// ---------- verdict chips

export type VerdictKey = "accepted" | "sent_back" | "reassigned" | "disputed" | "judging" | "failed" | "needs_you";
export interface VerdictChipModel { key: VerdictKey; label: string; tone: Tone; glyph: string; /** 0 to 100 */ score?: number }

const GLYPH: Record<VerdictKey, string> = { accepted: "✓", sent_back: "↩", reassigned: "⇄", disputed: "≠", judging: "…", failed: "✕", needs_you: "?" };
const chip = (key: VerdictKey, label: string, tone: Tone, score?: number): VerdictChipModel => ({ key, label, tone, glyph: GLYPH[key], ...(score === undefined ? {} : { score }) });

/** The compact verdict for a task, or null while there is nothing to say (not started, or running). */
export function verdictChip(task: Task): VerdictChipModel | null {
  const j = task.judgment;
  const score = j ? Math.round(j.score * 100) : undefined;
  if (task.status === "review") return chip("judging", "Being judged", "neutral");
  if (task.status === "waiting") return chip("needs_you", "Needs you", "warn");
  if (task.status === "failed") return chip("failed", "Failed", "danger", score);
  if (!j) return null;
  if (j.jury?.split) return chip("disputed", "Disputed", "warn", score);
  if (j.verdict === "accept") return chip("accepted", "Accepted", "ok", score);
  if (j.verdict === "reassign") return chip("reassigned", "Reassigned", "warn", score);
  return chip("sent_back", "Sent back", "warn", score);
}

/**
 * The chip sits on the task's last message from its agent. Earlier attempts stay as they were said; the judge's lines
 * (quiet, in the activity log) are not repeated in the conversation.
 */
export function chipMessageIds(messages: Message[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const m of messages) if (m.taskId && m.author.kind === "agent" && !m.quiet) last.set(m.taskId, m.id);
  const out = new Map<string, string>();
  for (const [taskId, messageId] of last) out.set(messageId, taskId);
  return out;
}

// ---------- the command palette

/** Screens the palette can open. `mac` is the page id in the Mac app; `phone` is the view name in the phone app. */
export const PALETTE_SCREENS: { id: string; title: string; mac?: string; phone?: string; keywords?: string }[] = [
  { id: "approvals", title: "Approvals", mac: "approvals", phone: "approvals", keywords: "approve reject waiting" },
  { id: "folders", title: "Folders", mac: "folders", phone: "folders", keywords: "files access grants" },
  { id: "permissions", title: "Permissions", mac: "permissions", phone: "permissions", keywords: "tools shell switches" },
  { id: "settings", title: "Settings", mac: "settings", keywords: "preferences appearance dark light theme" },
  { id: "appearance", title: "Appearance", phone: "appearance", keywords: "dark light theme mode settings" },
  { id: "scorecard", title: "Scorecard", mac: "scorecard", phone: "scorecard", keywords: "first pass weekly ledger" },
  { id: "resumes", title: "Résumés", mac: "resumes", phone: "resumes", keywords: "resume probation strengths" },
  { id: "office", title: "Office", mac: "office", keywords: "3d desks live agents" },
  { id: "memory", title: "Memory", mac: "memory", keywords: "remember proposals" },
  { id: "policy", title: "Approval rules", mac: "policy", phone: "policy", keywords: "policy rules lease allow learned permission expire" },
  { id: "agents", title: "Agents and connections", mac: "agents", phone: "personas", keywords: "connect personas people" },
];

/** The room commands the hub handles as plain messages (orchestrator handleOwnerMessage). */
export const ROOM_COMMANDS: { name: string; title: string; hint: string }[] = [
  { name: "pause", title: "Pause the room", hint: "Running tasks finish; nothing new starts" },
  { name: "resume", title: "Resume the room", hint: "Start new work again" },
  { name: "stop", title: "Stop all work", hint: "Stops everything running in this room" },
  { name: "digest", title: "Digest this room", hint: "Summarize what happened" },
];

export type PaletteGroup = "Rooms" | "Agents" | "Goals" | "Room commands" | "Screens";
export type PaletteAction =
  | { kind: "room"; roomId: string }
  | { kind: "dm"; agentId: string }
  | { kind: "page"; screen: string }
  | { kind: "command"; text: string }
  | { kind: "goal"; roomId: string };
export interface PaletteItem { id: string; group: PaletteGroup; title: string; hint?: string; keywords: string; action: PaletteAction }

export interface PaletteInput {
  rooms: Pick<Room, "id" | "name" | "dmAgentId" | "paused">[];
  agents: Pick<AgentConfig, "id" | "name" | "enabled">[];
  /** The room on screen, when a room (not a screen) is on screen. */
  currentRoomId?: string;
  /** Screens this app has (their `id`s from PALETTE_SCREENS). Others are left out. */
  screens: string[];
  platform: "mac" | "phone";
}

export function paletteItems(inp: PaletteInput): PaletteItem[] {
  const out: PaletteItem[] = [];
  const dmIds = new Set(inp.rooms.filter((r) => r.dmAgentId).map((r) => r.dmAgentId));
  const here = inp.rooms.find((r) => r.id === inp.currentRoomId);
  // Rooms (the shared ones), then agents (a direct line to each), so typing a name finds both.
  for (const r of inp.rooms.filter((x) => !x.dmAgentId)) out.push({ id: `room:${r.id}`, group: "Rooms", title: r.name, hint: r.paused ? "Paused" : undefined, keywords: `room ${r.name}`, action: { kind: "room", roomId: r.id } });
  for (const a of inp.agents.filter((x) => x.enabled)) out.push({ id: `dm:${a.id}`, group: "Agents", title: a.name, hint: dmIds.has(a.id) ? "Direct message" : "Start a direct message", keywords: `agent dm direct message ${a.id} ${a.name}`, action: { kind: "dm", agentId: a.id } });
  // Goals: start one in the room you are in, or in any other room.
  if (here && !here.dmAgentId) out.push({ id: `goal:${here.id}`, group: "Goals", title: "Start a goal here", hint: here.name, keywords: `goal new start task work ${here.name}`, action: { kind: "goal", roomId: here.id } });
  for (const r of inp.rooms.filter((x) => !x.dmAgentId && x.id !== inp.currentRoomId)) out.push({ id: `goal:${r.id}`, group: "Goals", title: `Start a goal in ${r.name}`, keywords: `goal new start task work ${r.name}`, action: { kind: "goal", roomId: r.id } });
  // Commands for the room on screen.
  if (here) for (const c of ROOM_COMMANDS) {
    if (c.name === "pause" && here.paused) continue;
    if (c.name === "resume" && !here.paused) continue;
    out.push({ id: `cmd:${c.name}`, group: "Room commands", title: c.title, hint: `/${c.name}`, keywords: `/${c.name} ${c.name} command ${c.hint}`, action: { kind: "command", text: `/${c.name}` } });
  }
  for (const s of PALETTE_SCREENS) {
    if (!inp.screens.includes(s.id) || !(inp.platform === "mac" ? s.mac : s.phone)) continue;
    out.push({ id: `page:${s.id}`, group: "Screens", title: s.title, keywords: `open go screen ${s.keywords ?? ""}`, action: { kind: "page", screen: s.id } });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Every word typed must appear in the title or keywords. Titles that start with the query come first, then word starts, then the rest; groups keep their order. */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const scored: { item: PaletteItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const title = norm(item.title), hay = `${title} ${norm(item.keywords)}`;
    if (!words.every((w) => hay.includes(w))) return;
    const score = words.reduce((s, w) => s + (title.startsWith(w) ? 0 : title.split(/[\s/]+/).some((x) => x.startsWith(w)) ? 1 : title.includes(w) ? 2 : 3), 0);
    scored.push({ item, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((x) => x.item);
}
