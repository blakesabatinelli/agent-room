import { TOOLS, type AgentConfig, type MemoryEntry, type ServerEvent } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { ControlFolder } from "../control/folder.js";
import { SENSITIVE, type Level } from "../control/schema.js";
import { CLAUDE_TOOL_MAP } from "../adapters/claudeCode.js";

/**
 * 4.3 What a room's ROOM.md decides at run time. One class so the orchestrator, the file broker and the MCP server all ask the
 * same questions the same way, and every answer is read from the control folder when it is asked (an edit to ROOM.md changes the
 * room at the next message, task or tool call; nothing is cached).
 *
 *  - roster: who is planned, routed, judged, mentioned and spawned in this room. A room with no ROOM.md, a direct-message room,
 *    and a ROOM.md that lists nobody are open: every agent works there.
 *  - permissions: ROOM.md `tools` (and everything under it in CONTROL.md section 3) narrows each run's tools. Layers only tighten.
 *  - folders: ROOM.md `folders` lists the only folder grants this room's goals and file tools may use.
 *  - memory: private notes an agent made in one room never reach its prompts in another.
 */

export interface RoomRulesHost {
  store: Store;
  control: () => ControlFolder | undefined;
}

/** What the file broker needs to know about a room. */
export interface RoomGate {
  /** Grant ids this room is limited to; undefined: no limit. */
  folders(roomId: string): string[] | undefined;
  /** The level of a tool for an agent in a room (strictest layer); "on" when nothing says otherwise. */
  level(agentId: string, roomId: string | undefined, tool: string): Level;
}

/** An agent as one run in one room may use it. */
export interface RunPermissions {
  /** The agent with `tools` and `autoApprove` narrowed. The adapters read nothing else. */
  agent: AgentConfig;
  /** Tools the room switched off (they were on for the agent). */
  denied: string[];
  /** Tools the room forces to ask first, even though the agent could use them (or auto-approve them) on its own. */
  ask: string[];
}

export class RoomRules implements RoomGate {
  /**
   * An agent that joins after a room's roster was written belongs to every room whose roster listed all the others (the same rule
   * `joinOpenRosters` writes into the file). The file edit is a commit that lands a moment later, so until the file changes this
   * keeps the new agent in those rooms. Any change to that ROOM.md (the commit, or the owner narrowing the room) ends it.
   */
  private late = new Map<string, { sig: string; ids: Set<string> }>();
  private known: Set<string>;
  /**
   * 4.4: a lane of a fork is a hidden room with a roster of its own. Set by the fork service. A lane's roster wins over any ROOM.md; its tools,
   * folders and memory come from the room the fork was started in (`parent`), and `family` lists the agents sharing an agent's model family.
   */
  fork?: (roomId: string) => { roster: string[]; parent: string; family(agentId: string): string[] } | undefined;

  constructor(private d: RoomRulesHost) {
    this.known = new Set(d.store.listAgents().map((a) => a.id));
    d.store.on("event", (e: ServerEvent) => {
      if (e.type !== "agent" || this.known.has(e.agent.id)) return;
      this.known.add(e.agent.id);
      const c = this.d.control(); if (!c) return;
      const others = [...this.known].filter((x) => x !== e.agent.id);
      for (const room of this.d.store.listRooms()) {
        const r = c.rosterFor(room.id);
        if (!r || !r.length || r.includes(e.agent.id) || !others.every((o) => r.includes(o))) continue;
        const cur = this.late.get(room.id);
        this.late.set(room.id, { sig: r.join(","), ids: new Set([...(cur && cur.sig === r.join(",") ? cur.ids : []), e.agent.id]) });
      }
    });
  }

  private slug(roomId: string | undefined): string | undefined {
    return roomId ? this.d.control()?.slugFor(this.fork?.(roomId)?.parent ?? roomId) : undefined; // 4.4: a lane is the room the fork came from, for tools and folders
  }

  // ---------------------------------------------------------------- roster

  /** Agent ids ROOM.md lists, or undefined when the room is open to everyone. */
  rosterIds(roomId: string | undefined): string[] | undefined {
    if (!roomId) return undefined;
    const lane = this.fork?.(roomId); // 4.4
    if (lane) return lane.roster;
    const r = this.d.control()?.rosterFor(roomId);
    if (!r || !r.length) return undefined;
    const l = this.late.get(roomId);
    if (!l) return r;
    if (l.sig !== r.join(",")) { this.late.delete(roomId); return r; }
    return [...r, ...[...l.ids].filter((x) => !r.includes(x))];
  }

  /** May this agent be planned, routed, judged, mentioned or spawned in this room? */
  allows(roomId: string | undefined, agentId: string): boolean {
    const r = this.rosterIds(roomId);
    return !r || r.includes(agentId);
  }

  /** The agents of this room out of `agents`. The list is returned as it is when the room is open. */
  limit<T extends { id: string }>(roomId: string | undefined, agents: T[]): T[] {
    const r = this.rosterIds(roomId);
    return r ? agents.filter((a) => r.includes(a.id)) : agents;
  }

  /** Spawn helper for subagents (3.1): the agents a subagent in this room may be, out of `agents`. Same rule as everything else. */
  spawnable<T extends { id: string }>(roomId: string | undefined, agents: T[]): T[] { return this.limit(roomId, agents); }

  /** Who is here, in words, for a "not in this room" reply. */
  rosterText(roomId: string, agents: AgentConfig[]): string {
    const names = this.limit(roomId, agents).map((a) => `@${a.id}`);
    return names.length ? names.join(", ") : "nobody is switched on";
  }

  /** The short reply for an agent that was tagged but doesn't work here. */
  notInRoom(roomId: string, agent: AgentConfig, agents: AgentConfig[]): string {
    return `${agent.name} isn't in this room. Here: ${this.rosterText(roomId, agents)}. Change who is here in ROOM.md (or under room settings).`;
  }

  /**
   * Judges for a single-judge review. Judges come from the room's roster; they come from outside it only when nobody inside
   * could judge (everyone inside is the worker or the earlier judge, or not ready), and the ones from outside are named so the
   * caller can record it.
   */
  judgePool(roomId: string | undefined, pool: AgentConfig[], exclude: (string | undefined)[]): { pool: AgentConfig[]; outside: Set<string> } {
    const lane = roomId ? this.fork?.(roomId) : undefined;
    if (lane) {
      // 4.4: in a fork's lane a judge is never the worker's own model family (the worker is the first of `exclude`). The other side's agents and outsiders may judge.
      const worker = exclude[0];
      const bad = new Set<string>([...exclude.filter((x): x is string => !!x), ...(worker ? lane.family(worker) : [])]);
      const inside = pool.filter((a) => lane.roster.includes(a.id) && !bad.has(a.id));
      if (inside.length) return { pool: inside, outside: new Set() };
      const wide = pool.filter((a) => !bad.has(a.id));
      return { pool: wide, outside: new Set(wide.filter((a) => !lane.roster.includes(a.id)).map((a) => a.id)) };
    }
    const r = this.rosterIds(roomId);
    if (!r) return { pool, outside: new Set() };
    const inside = pool.filter((a) => r.includes(a.id));
    if (inside.some((a) => !exclude.includes(a.id))) return { pool: inside, outside: new Set() };
    return { pool, outside: new Set(pool.filter((a) => !r.includes(a.id)).map((a) => a.id)) };
  }

  // ---------------------------------------------------------------- permissions

  /** The strictest level of a tool for this agent in this room across every layer. "on" when there is no control folder or no room. */
  level(agentId: string, roomId: string | undefined, tool: string): Level {
    const slug = this.slug(roomId);
    const c = this.d.control();
    if (!c || !slug) return "on";
    return c.effectivePermissions(agentId, slug)[tool] ?? "on";
  }

  /**
   * The agent as a run in this room may use it: a tool the room turns off is off (even if the agent has it and auto-approves it),
   * and a tool the room says to ask about is no longer auto-approved and is routed to the approval prompt. Never loosens anything.
   */
  narrow(agent: AgentConfig, roomId: string | undefined): RunPermissions {
    const slug = this.slug(roomId);
    const c = this.d.control();
    if (!c || !slug) return { agent, denied: [], ask: [] };
    const eff = c.effectivePermissions(agent.id, slug);
    const tools = { ...agent.tools };
    const auto = { ...(agent.autoApprove ?? {}) };
    const denied: string[] = [], ask: string[] = [];
    const roomSays = (tool: string) => c.snapshot().rooms[slug]?.room?.fm.tools?.[tool];
    for (const tool of new Set([...TOOLS.map((t) => t.id), ...Object.keys(agent.tools ?? {})])) {
      if (!agent.tools?.[tool]) continue;
      const level = eff[tool] ?? "on";
      if (level === "off") { tools[tool] = false; delete auto[tool]; denied.push(tool); }
      // A sensitive tool that still auto-approves but a layer says ask about: ask. A tool that isn't sensitive only asks when this room says so
      // (the other layers can't express "ask" for it, so they never did before and still don't).
      else if (level === "ask" && (SENSITIVE.has(tool) ? auto[tool] : roomSays(tool) === "ask")) { delete auto[tool]; ask.push(tool); }
    }
    if (!denied.length && !ask.length) return { agent, denied, ask };
    const next: AgentConfig = { ...agent, tools };
    if (Object.keys(auto).length) next.autoApprove = auto; else delete next.autoApprove;
    return { agent: next, denied, ask };
  }

  /** What this room's own ROOM.md `tools` says about a tool, if anything. */
  says(roomId: string | undefined, tool: string): Level | undefined {
    const slug = this.slug(roomId);
    return slug ? this.d.control()?.snapshot().rooms[slug]?.room?.fm.tools?.[tool] : undefined;
  }

  /**
   * Does a layer (or this room) switch a tool off that the run would otherwise be asking to use? A tool the agent doesn't have at all can still be
   * asked for one time (the owner decides on the card), as before 4.3; but a tool the agent has, and a layer or the room turned off, is refused.
   */
  forbids(agent: AgentConfig | undefined, roomId: string | undefined, tool: string): boolean {
    if (this.says(roomId, tool) === "off") return true;
    return !!agent?.tools?.[tool] && this.level(agent.id, roomId, tool) === "off";
  }

  /** Why a tool can't be used by this agent in this room, or undefined when the room doesn't stop it. (MCP tools use this for a clear message.) */
  denial(agentId: string, roomId: string | undefined, tool: string): string | undefined {
    return this.level(agentId, roomId, tool) === "off" ? `the ${tool} tool is switched off for you in this room (ROOM.md).` : undefined;
  }

  // ---------------------------------------------------------------- folders

  /** Folder grant ids ROOM.md limits this room to, or undefined when it doesn't. */
  folders(roomId: string): string[] | undefined {
    const slug = this.slug(roomId);
    const f = slug ? this.d.control()?.snapshot().rooms[slug]?.room?.fm.folders : undefined;
    return f && f.length ? f : undefined;
  }

  /** May this room's goals and file tools use this folder grant? */
  folderAllowed(grantId: string, roomId: string | undefined): boolean {
    if (!roomId) return true;
    const f = this.folders(roomId);
    return !f || f.includes(grantId);
  }

  // ---------------------------------------------------------------- memory

  /**
   * An agent's own notes as they may appear in a prompt for this room. A note made in one room carries that room's id and stays
   * there; notes with no room are the agent's own and go everywhere.
   */
  privateFor(agentId: string, roomId: string | undefined): MemoryEntry[] {
    const all = this.d.store.listPrivate(agentId);
    return all.filter((e) => !e.roomId || e.roomId === roomId);
  }

  /** The tool ids Claude Code's own tools stand for (Read and Write are the filesystem tool, Bash is shell), so a prompt for one is checked against the right switch. */
  static toolForClaudeName(name: string): string | undefined {
    for (const [tool, names] of Object.entries(CLAUDE_TOOL_MAP)) if (names.includes(name)) return tool;
    return undefined;
  }
}
