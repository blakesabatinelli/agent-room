import type { FileResult } from "./lint.js";
import { effectivePermissionsFrom } from "./permissions.js";
import type { Fm, Kind, Level } from "./schema.js";

/** A loaded control file: validated front matter plus its Markdown body. */
export interface Doc<K extends Kind> { path: string; fm: Fm<K>; body: string; bodyLine: number }

export interface AgentDocs {
  soul?: Doc<"soul">; tools?: Doc<"tools">; resume?: Doc<"resume">; lessons?: Doc<"lessons">; memory?: Doc<"agent-memory">;
}
export interface RoomDocs { room?: Doc<"room">; memory?: Doc<"room-memory"> }
export interface GoalDocs { goal?: Doc<"goal">; ledger?: Doc<"ledger">; decisions?: Doc<"decisions"> }

/** Everything the hub has loaded from the control folder, as typed values. */
export interface ControlSnapshot {
  rules?: Doc<"agents">;
  user?: Doc<"user">;
  policy?: Doc<"policy">;
  agents: Record<string, AgentDocs>;
  rooms: Record<string, RoomDocs>;
  goals: Record<string, GoalDocs>;
  playbooks: Record<string, Doc<"playbook">>;
}

export const emptySnapshot = (): ControlSnapshot => ({ agents: {}, rooms: {}, goals: {}, playbooks: {} });

const asDoc = <K extends Kind>(r: FileResult): Doc<K> => ({ path: r.rel, fm: r.fm as Fm<K>, body: r.body, bodyLine: r.bodyLine });

export function buildSnapshot(files: Iterable<FileResult>): ControlSnapshot {
  const s = emptySnapshot();
  for (const r of files) {
    if (!r.fm) continue;
    const m = r.meta;
    switch (m.kind) {
      case "agents": s.rules = asDoc(r); break;
      case "user": s.user = asDoc(r); break;
      case "policy": s.policy = asDoc(r); break;
      case "soul": (s.agents[m.agent!] ??= {}).soul = asDoc(r); break;
      case "tools": (s.agents[m.agent!] ??= {}).tools = asDoc(r); break;
      case "resume": (s.agents[m.agent!] ??= {}).resume = asDoc(r); break;
      case "lessons": (s.agents[m.agent!] ??= {}).lessons = asDoc(r); break;
      case "agent-memory": (s.agents[m.agent!] ??= {}).memory = asDoc(r); break;
      case "room": (s.rooms[m.room!] ??= {}).room = asDoc(r); break;
      case "room-memory": (s.rooms[m.room!] ??= {}).memory = asDoc(r); break;
      case "goal": (s.goals[m.goal!] ??= {}).goal = asDoc(r); break;
      case "ledger": (s.goals[m.goal!] ??= {}).ledger = asDoc(r); break;
      case "decisions": (s.goals[m.goal!] ??= {}).decisions = asDoc(r); break;
      case "playbook": s.playbooks[m.taskType!] = asDoc(r); break;
    }
  }
  return s;
}

/**
 * Effective permission of every tool for one agent in one room: the strictest of the platform,
 * POLICY.md, TOOLS.md room_allows and ROOM.md tools (CONTROL.md section 3). Off beats ask beats on.
 * `roomSlug` undefined means no room layer. `fallback` supplies room_allows for an agent that has no TOOLS.md yet.
 */
export function effectivePermissions(
  snap: ControlSnapshot, agentId: string, roomSlug?: string, opts: { today?: string; fallback?: Record<string, Level> } = {},
): Record<string, Level> {
  const tools = snap.agents[agentId]?.tools?.fm;
  const synth = !tools && opts.fallback ? ({ room_allows: opts.fallback, platform: { connectors: [], data_sources: [], skills: [] } } as unknown as Fm<"tools">) : tools;
  return effectivePermissionsFrom(agentId, roomSlug, {
    policy: snap.policy?.fm, tools: synth, room: roomSlug ? snap.rooms[roomSlug]?.room?.fm : undefined, today: opts.today,
  });
}
