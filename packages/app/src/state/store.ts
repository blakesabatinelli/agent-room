import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import type { AgentConfig, AgentStatus, Approval, Goal, MemoryProposal, Message, Room, ServerEvent, Task } from "@agent-room/shared";
import { Hub } from "../api/client";
import { launcher, LOCAL_HUB, readLocalPairSecret } from "../native/hub";

const KEY = "agent-room.connection";

export type Page = "agents" | "approvals" | "memory" | "permissions" | "folders" | "settings" | "scorecard" | "resumes" | "office" | "policy"; // 4.2: the approval rules; 3.1: scorecard and resumes are screens of their own; 3.4: the office
/** What the main pane shows: a room or direct message, or one of the workspace pages. */
export type View = { kind: "room" } | { kind: "page"; page: Page };

interface State {
  hub?: Hub;
  ownerName: string;
  online: boolean;
  rooms: Room[];
  roomId?: string;
  view: View;
  /** All messages in the open room, including behind-the-scenes log lines (quiet). */
  messages: Message[];
  /** The room whose messages are loaded, and where the owner had read up to when it opened. */
  loaded?: { roomId: string; readAt: number };
  tasks: Record<string, Task>;
  goals: Record<string, Goal>;
  agents: AgentConfig[];
  statuses: Record<string, AgentStatus>;
  /** roomId -> agentId -> label, for the "… is working" line */
  working: Record<string, Record<string, string>>;
  unread: Record<string, number>;
  approvals: Approval[];
  proposals: MemoryProposal[];
  calibration: Task[];
  /** Bumped when a control file changes on disk or in the app, so Settings can reload its notices. */
  controlStamp: number;
  /** 3.1: bumped to put the cursor in the composer (the palette's "Start a goal"). */
  composerStamp: number;
  error?: string;
  onboarded: boolean;
  startupError?: string;
  restore(): Promise<void>;
  pair(baseUrl: string, code: string, deviceName: string): Promise<void>;
  unpair(): Promise<void>;
  load(): Promise<void>;
  refreshStatus(fresh?: boolean): Promise<void>;
  selectRoom(id: string): Promise<void>;
  openDm(agentId: string): Promise<void>;
  openPage(page: Page): void;
  focusComposer(): void;
  apply(e: ServerEvent | { type: "room_deleted"; roomId: string }): void;
  setError(e?: string): void;
}

let stopLive: (() => void) | undefined;

export const useRoom = create<State>((set, get) => ({
  ownerName: "Owner", online: false, rooms: [], messages: [], tasks: {}, goals: {}, agents: [], statuses: {},
  working: {}, unread: {}, approvals: [], proposals: [], calibration: [], controlStamp: 0, composerStamp: 0, onboarded: true, view: { kind: "room" },

  async restore() {
    set({ startupError: undefined });
    if (launcher) {
      // Mac: start our own hub and pair with it silently. No codes, no terminal.
      try { await launcher.ensureRunning(); }
      catch (e) { set({ startupError: (e as Error).message }); return; }
      const saved = await AsyncStorage.getItem(KEY);
      let hub = saved ? new Hub(LOCAL_HUB, JSON.parse(saved).token) : undefined;
      if (saved) set({ ownerName: JSON.parse(saved).ownerName ?? "Owner" });
      if (hub) { try { await hub.setup(); } catch { hub = undefined; } } // token no longer valid
      if (!hub) {
        try {
          const res = await new Hub(LOCAL_HUB).pairLocal(await readLocalPairSecret()); // 1.2: the hub's secret, read from ~/.agent-room
          await AsyncStorage.setItem(KEY, JSON.stringify({ baseUrl: LOCAL_HUB, token: res.token, ownerName: res.ownerName }));
          hub = new Hub(LOCAL_HUB, res.token);
          set({ ownerName: res.ownerName });
        } catch (e) { set({ startupError: (e as Error).message }); return; }
      }
      const info = await hub.setup();
      set({ hub, onboarded: info.onboarded });
      await get().load();
      return;
    }
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return;
    const { baseUrl, token, ownerName } = JSON.parse(raw);
    set({ hub: new Hub(baseUrl, token), ownerName });
    await get().load();
  },

  async pair(baseUrl, code, deviceName) {
    const url = baseUrl.trim().replace(/\/$/, "");
    const res = await new Hub(url).pair(code.trim(), deviceName);
    await AsyncStorage.setItem(KEY, JSON.stringify({ baseUrl: url, token: res.token, ownerName: res.ownerName }));
    set({ hub: new Hub(url, res.token), ownerName: res.ownerName });
    await get().load();
  },

  async unpair() {
    stopLive?.(); await AsyncStorage.removeItem(KEY);
    set({ hub: undefined, online: false, messages: [], rooms: [] });
  },

  async load() {
    const hub = get().hub; if (!hub) return;
    try {
      const [rooms, agents, approvals, proposals] = await Promise.all([hub.rooms(), hub.agents(), hub.approvals(), hub.proposals()]);
      set({ rooms, agents: agents.sort((a, b) => a.name.localeCompare(b.name)), approvals, proposals, error: undefined });
      stopLive?.();
      stopLive = hub.connect((e) => get().apply(e), (online) => set({ online }));
      void get().refreshStatus();
      const id = get().roomId ?? rooms.find((r) => !r.dmAgentId)?.id ?? rooms[0]?.id;
      if (id) await get().selectRoom(id);
    } catch (e) { set({ error: (e as Error).message }); }
  },

  async refreshStatus(fresh = false) {
    const hub = get().hub; if (!hub) return;
    try {
      const list = await hub.allStatus(fresh);
      set({ statuses: Object.fromEntries(list.map((s) => [s.id, s])) });
    } catch { /* keep last known */ }
  },

  async selectRoom(id) {
    const hub = get().hub!;
    // Clear the old room first so the list never positions itself on the wrong messages.
    set({ roomId: id, view: { kind: "room" }, unread: { ...get().unread, [id]: 0 }, messages: [], loaded: undefined });
    const [messages, tasks, goals, mark] = await Promise.all([hub.messages(id), hub.tasks(id), hub.goals(id), hub.readMark(id).catch(() => ({ at: 0 }))]);
    if (get().roomId !== id) return; // user moved on
    set({ messages, loaded: { roomId: id, readAt: mark.at }, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), goals: Object.fromEntries(goals.map((g) => [g.id, g])) });
  },

  async openDm(agentId) {
    const hub = get().hub; if (!hub) return;
    try {
      const room = await hub.dm(agentId);
      if (!get().rooms.some((r) => r.id === room.id)) set({ rooms: [...get().rooms, room] });
      await get().selectRoom(room.id);
    } catch (e) { set({ error: (e as Error).message }); }
  },

  openPage(page) { set({ view: { kind: "page", page } }); },
  focusComposer() { set({ composerStamp: Date.now() }); },

  apply(e) {
    const s = get();
    switch (e.type) {
      case "message":
        if (e.message.roomId === s.roomId && s.view.kind === "room") set({ messages: [...s.messages, e.message] });
        else if (e.message.roomId === s.roomId) set({ messages: [...s.messages, e.message] });
        if ((e.message.roomId !== s.roomId || s.view.kind !== "room") && !e.message.quiet && e.message.author.kind !== "human")
          set({ unread: { ...get().unread, [e.message.roomId]: (get().unread[e.message.roomId] ?? 0) + 1 } });
        break;
      case "read": if (s.unread[e.roomId]) set({ unread: { ...s.unread, [e.roomId]: 0 } }); break;
      case "task": if (e.task.roomId === s.roomId) set({ tasks: { ...s.tasks, [e.task.id]: e.task } }); break;
      case "subagent": if (e.task.roomId === s.roomId) set({ tasks: { ...s.tasks, [e.task.id]: e.task } }); break; // 3.3: the same task, told again with its parent's id
      case "goal": if (e.goal.roomId === s.roomId) set({ goals: { ...s.goals, [e.goal.id]: e.goal } }); break;
      case "agent": set({ agents: [...s.agents.filter((a) => a.id !== e.agent.id), e.agent].sort((a, b) => a.name.localeCompare(b.name)) }); break;
      case "agent_status":
        if (!s.agents.some((a) => a.id === e.status.id) && e.status.detail === "deleted") set({ statuses: Object.fromEntries(Object.entries(s.statuses).filter(([k]) => k !== e.status.id)) });
        else set({ statuses: { ...s.statuses, [e.status.id]: e.status } });
        if (e.status.detail === "deleted") set({ agents: get().agents.filter((a) => a.id !== e.status.id) });
        break;
      case "room": if (e.room.forkId) break; /* 4.4: the two lanes of a fork are not rooms to open */ set({ rooms: [...s.rooms.filter((r) => r.id !== e.room.id), e.room].sort((a, b) => a.createdAt - b.createdAt) }); break;
      case "room_deleted": {
        const rooms = s.rooms.filter((r) => r.id !== e.roomId);
        set({ rooms });
        if (s.roomId === e.roomId) { const next = rooms.find((r) => !r.dmAgentId) ?? rooms[0]; if (next) void get().selectRoom(next.id); }
        break;
      }
      case "working": {
        const room = { ...(s.working[e.roomId] ?? {}) };
        if (e.active) room[e.agentId] = e.label ?? "working"; else delete room[e.agentId];
        set({ working: { ...s.working, [e.roomId]: room } });
        break;
      }
      case "approval": set({ approvals: e.approval.status === "pending" ? [...s.approvals.filter((a) => a.id !== e.approval.id), e.approval] : s.approvals.filter((a) => a.id !== e.approval.id) }); break;
      case "proposal": set({ proposals: e.proposal.status === "pending" ? [...s.proposals.filter((p) => p.id !== e.proposal.id), e.proposal] : s.proposals.filter((p) => p.id !== e.proposal.id) }); break;
      case "calibration": set({ calibration: [...s.calibration, e.task] }); break;
      case "control": set({ controlStamp: e.at }); break;
    }
  },

  setError(error) { set({ error }); },
}));

export const agentColor = (agents: AgentConfig[], id: string) => agents.find((a) => a.id === id)?.color;

/** Presence for the sidebar dot. */
export function presence(s: Pick<State, "statuses" | "agents" | "working">, agentId: string): "ready" | "busy" | "off" | "error" {
  const st = s.statuses[agentId];
  const a = s.agents.find((x) => x.id === agentId);
  if (!a?.enabled || !st) return "off";
  if (Object.values(s.working).some((w) => w[agentId])) return "busy";
  if (st.ready) return "ready";
  return st.state === "error" ? "error" : "off";
}
