import type { AdapterKind } from "@agent-room/shared";
import type { Adapter } from "./types.js";
import { ClaudeCodeAdapter } from "./claudeCode.js";
import { CodexAdapter } from "./codex.js";
import { CommandAdapter } from "./command.js";
import { OpenAIApiAdapter } from "./openaiApi.js";
import { MockAdapter } from "./mock.js";
import { ExternalMcpAdapter } from "./mcp.js";
import { AcpAdapter } from "./acp.js"; // 4.6
import { withJsonScratch } from "./scratch.js"; // 1.1 round 2

export * from "./types.js";
export { inbox, type Assignment } from "./mcp.js";

export const adapters: Record<AdapterKind, Adapter> = {
  "claude-code": withJsonScratch(new ClaudeCodeAdapter()), // 1.1 round 2 (M1): planner, judge and draft calls run in a fresh empty folder
  codex: withJsonScratch(new CodexAdapter()),
  mcp: new ExternalMcpAdapter(),
  command: withJsonScratch(new CommandAdapter()),
  "openai-api": new OpenAIApiAdapter(),
  mock: new MockAdapter(),
  acp: withJsonScratch(new AcpAdapter()), // 4.6
};
