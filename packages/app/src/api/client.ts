import type {
  AgentConfig, AgentScore, AgentStatus, CapacitySnapshot, ControlCommit, ControlNotice, ControlStatus, McpConnection, Approval, AuditEntry, Goal, MemoryEntry, MemoryProposal,
  Message, OrchestratorSettings, RemoteStatus, Room, ServerEvent, Subscription, SubscriptionStatus, Task,
} from "@agent-room/shared";

export interface SetupInfo {
  agents: { id: string; name: string; enabled: boolean; color: string; adapter: string; ready: boolean; detail: string }[];
  practiceMode: boolean;
  onboarded: boolean;
  phone: { url: string | null; code: string };
}

export class Hub {
  constructor(public baseUrl: string, public token?: string) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `Hub returned ${res.status}`), { approvalUrl: (body as { approvalUrl?: string }).approvalUrl });
    return body as T;
  }
  private send<T>(method: string, path: string, body?: unknown) { return this.req<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }); }

  health = () => this.req<{ ok: boolean }>("/health");
  pair = (code: string, deviceName: string) => this.send<{ token: string; ownerName: string }>("POST", "/pair", { code, deviceName });
  pairLocal = () => this.send<{ token: string; ownerName: string }>("POST", "/pair/local", { deviceName: "This Mac" });
  setup = () => this.req<SetupInfo>("/setup");
  saveSetup = (s: { practiceMode?: boolean; onboarded?: boolean }) => this.send("PUT", "/setup", s);
  signIn = (agentId: string) => this.send<{ ok: boolean; message: string }>("POST", `/setup/signin/${agentId}`);

  signInLog = (agentId: string) => this.req<{ log: string | null }>(`/setup/signin/${agentId}/log`);

  // 1.2 remote access over Tailscale
  remoteStatus = (fresh = false) => this.req<RemoteStatus>(`/remote/status${fresh ? "?fresh=1" : ""}`);
  setFunnel = (on: boolean) => this.send<RemoteStatus>("POST", "/remote/funnel", { on });
  openTailscale = () => this.send<{ ok: boolean; message: string }>("POST", "/remote/open");

  rooms = () => this.req<Room[]>("/rooms");
  createRoom = (name: string, topic?: string) => this.send<Room>("POST", "/rooms", { name, topic });
  updateRoom = (id: string, patch: { name?: string; topic?: string }) => this.send<Room>("PUT", `/rooms/${id}`, patch);
  deleteRoom = (id: string) => this.send("DELETE", `/rooms/${id}`);
  dm = (agentId: string) => this.send<Room>("POST", `/rooms/dm/${agentId}`);
  readMark = (roomId: string) => this.req<{ at: number }>(`/rooms/${roomId}/read`);
  markRead = (roomId: string, at: number) => this.send<{ at: number }>("PUT", `/rooms/${roomId}/read`, { at });
  messages = (roomId: string, since = 0) => this.req<Message[]>(`/rooms/${roomId}/messages?since=${since}`);
  post = (roomId: string, text: string) => this.send("POST", `/rooms/${roomId}/messages`, { text });
  pause = (roomId: string, paused: boolean) => this.send("POST", `/rooms/${roomId}/pause`, { paused });
  stop = (roomId: string) => this.send("POST", `/rooms/${roomId}/stop`);
  goals = (roomId: string) => this.req<Goal[]>(`/rooms/${roomId}/goals`);
  tasks = (roomId: string) => this.req<Task[]>(`/rooms/${roomId}/tasks`);
  decidePlan = (goalId: string, decision: "approve" | "revise" | "cancel", text?: string) => this.send("POST", `/goals/${goalId}/plan`, { decision, text });
  goalFiles = (goalId: string) => this.req<{ folder: string | null; files: string[] }>(`/goals/${goalId}/files`);
  revealGoal = (goalId: string) => this.send("POST", `/goals/${goalId}/reveal`);
  rate = (taskId: string, score: number) => this.send("POST", `/tasks/${taskId}/rate`, { score });

  agents = () => this.req<AgentConfig[]>("/agents");
  saveAgent = (a: AgentConfig) => this.send<AgentConfig>("POST", "/agents", a);
  updateAgent = (id: string, patch: Partial<AgentConfig>) => this.send<AgentConfig>("PUT", `/agents/${id}`, patch);
  setTools = (id: string, tools: Record<string, boolean>) => this.send<AgentConfig>("PUT", `/agents/${id}/tools`, tools);
  setAutoApprove = (id: string, auto: Record<string, boolean>) => this.send<AgentConfig>("PUT", `/agents/${id}/auto-approve`, auto);
  deleteAgent = (id: string) => this.send("DELETE", `/agents/${id}`);
  agentStatus = (id: string) => this.req<AgentStatus>(`/agents/${id}/status`);
  allStatus = (fresh = false) => this.req<AgentStatus[]>(`/agents/status${fresh ? "?fresh=1" : ""}`);
  mcpInfo = (id: string) => this.req<{ exists: boolean; connected: boolean; lastSeen: number | null }>(`/agents/${id}/mcp-connection`);
  mcpConnect = (id: string, rotate = false) => this.send<McpConnection>("POST", `/agents/${id}/mcp-connection`, { rotate });
  mcpConfig = (id: string) => this.req<McpConnection>(`/agents/${id}/mcp-connection/config`);
  mcpRevoke = (id: string) => this.send("DELETE", `/agents/${id}/mcp-connection`);
  scores = () => this.req<AgentScore[]>("/scores");
  tools = () => this.req<{ id: string; label: string; sensitive: boolean }[]>("/tools");

  settings = () => this.req<OrchestratorSettings & { calibration: { n: number; absErr: number } }>("/settings");
  saveSettings = (s: Partial<OrchestratorSettings>) => this.send<OrchestratorSettings>("PUT", "/settings", s);
  capacity = () => this.req<CapacitySnapshot>("/capacity");

  quota = () => this.req<SubscriptionStatus[]>("/quota/subscriptions");
  saveQuota = (subs: Subscription[]) => this.send<SubscriptionStatus[]>("PUT", "/quota/subscriptions", subs);

  memory = (roomId?: string) => this.req<MemoryEntry[]>(`/memory${roomId ? `?roomId=${roomId}` : ""}`);
  editMemory = (id: string, text: string) => this.send("PUT", `/memory/${id}`, { text });
  deleteMemory = (id: string) => this.send("DELETE", `/memory/${id}`);
  proposals = () => this.req<MemoryProposal[]>("/memory/proposals?status=pending");
  decideProposal = (id: string, accept: boolean) => this.send("POST", `/memory/proposals/${id}`, { accept });

  approvals = () => this.req<Approval[]>("/approvals?status=pending");
  decide = (id: string, decision: "approved" | "rejected") => this.send("POST", `/approvals/${id}`, { decision });
  audit = () => this.req<AuditEntry[]>("/audit");
  // 1.9 control files
  controlStatus = () => this.req<ControlStatus>("/control/status");
  controlHistory = (path?: string) => this.req<ControlCommit[]>(`/control/history${path ? `?path=${encodeURIComponent(path)}` : ""}`);
  controlRevert = (commit: string) => this.send<{ ok: boolean; commit: string; files: string[] }>("POST", `/control/revert/${commit}`);
  controlLint = () => this.send<{ blocks: ControlNotice[]; flags: ControlNotice[] }>("POST", "/control/lint");
  mcpToken = (agentId: string, name: string) => this.send<{ token: string; url: string }>("POST", "/mcp-tokens", { agentId, name });

  /** Live events with automatic reconnect. Returns a stop function. */
  connect(onEvent: (e: ServerEvent) => void, onStatus: (online: boolean) => void): () => void {
    let ws: WebSocket | undefined; let stopped = false; let delay = 1000;
    const open = () => {
      ws = new WebSocket(`${this.baseUrl.replace(/^http/, "ws")}/ws?token=${this.token}`);
      ws.onopen = () => { delay = 1000; onStatus(true); };
      ws.onmessage = (m) => { try { const e = JSON.parse(String(m.data)); if (e.type !== "hello") onEvent(e); } catch { /* ignore */ } };
      ws.onclose = () => { onStatus(false); if (!stopped) setTimeout(open, (delay = Math.min(delay * 2, 15000))); };
    };
    open();
    return () => { stopped = true; ws?.close(); };
  }
}
