import type { AgentConfig, RunUsage } from "@agent-room/shared";

export interface RunRequest {
  agent: AgentConfig;
  prompt: string;
  systemPrompt?: string;
  /** sandboxed working directory for this agent + task */
  cwd: string;
  /** 1.1: the hub's data folder, so a confined Claude Code run can keep the hub's database and other tasks' folders off limits. */
  dataDir?: string;
  /** hub MCP endpoint the agent can use to talk to the room */
  mcp?: { url: string; token: string };
  /** true for orchestrator planning/judging calls: no tools, JSON out */
  jsonOnly?: boolean;
  /** room/task the run belongs to, when known */
  roomId?: string;
  taskId?: string;
  /** Profile overrides; fall back to agent.settings.model. */
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** MCP agents: give the work back if not picked up within this. */
  claimTimeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
  /**
   * 4.6: asks the owner (through the approvals queue) whether a tool the agent wants to use may run. `tool` is one of the room's tool ids
   * (shell, web, filesystem...). Resolves true only when it was approved. Absent for runs that can't ask: such a run is refused anything sensitive.
   */
  approve?: (tool: string, action: string, detail: string) => Promise<boolean>;
}

export interface RunResult {
  ok: boolean;
  text: string;
  durationMs: number;
  error?: string;
  /** Tokens and cost, when the CLI reports them. */
  usage?: RunUsage;
  /** The model version the CLI says it ran, when it says. */
  model?: string;
}

import type { AgentState } from "@agent-room/shared";
export interface AdapterStatus { ready: boolean; state: AgentState; detail: string }

export interface Adapter {
  run(req: RunRequest): Promise<RunResult>;
  status(agent: AgentConfig): Promise<AdapterStatus>;
}
