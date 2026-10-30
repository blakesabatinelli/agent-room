import type { AgentConfig, RunUsage } from "@agent-room/shared";
import type { NativeEvent } from "../subagents/native.js"; // 3.3

export interface RunRequest {
  agent: AgentConfig;
  prompt: string;
  systemPrompt?: string;
  /** sandboxed working directory for this agent + task */
  cwd: string;
  /** 1.1: the hub's data folder, so a confined Claude Code run can keep the hub's database and other tasks' folders off limits. */
  dataDir?: string;
  /** S4: files and folders a confined run may neither read nor write (the control files that steer agents). */
  protectedPaths?: string[];
  /** hub MCP endpoint the agent can use to talk to the room */
  mcp?: { url: string; token: string };
  /** true for orchestrator planning/judging calls: no tools, JSON out */
  jsonOnly?: boolean;
  /** room/task the run belongs to, when known */
  roomId?: string;
  taskId?: string;
  /** 4.3: tools the room's ROOM.md says to ask about. They are never pre-allowed, so every use goes to the owner's approval prompt. */
  ask?: string[];
  /** Profile overrides; fall back to agent.settings.model. */
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** MCP agents: give the work back if not picked up within this. */
  claimTimeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
  /** 3.3: a read-only helper: no write tools (Claude Code), `--sandbox read-only` (Codex). The hub's own file tools refuse its writes too. */
  readOnly?: boolean;
  /** 3.3: subagents the agent launches inside its own tool, as the event stream shows them. */
  onSubagent?: (e: NativeEvent) => void;
  /**
   * 4.6: asks the owner (through the approvals queue) whether a tool the agent wants to use may run. `tool` is one of the room's tool ids
   * (shell, web, filesystem...). Resolves true only when it was approved. Absent for runs that can't ask: such a run is refused anything sensitive.
   * `detail` is for display and may be cut short; `input` is the tool call's own input, whole, and is what the two-key check and the policy read (4.1, 4.2).
   */
  approve?: (tool: string, action: string, detail: string, input?: unknown) => Promise<boolean>;
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
