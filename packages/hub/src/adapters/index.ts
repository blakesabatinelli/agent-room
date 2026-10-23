import type { AdapterKind } from "@agent-room/shared";
import type { Adapter } from "./types.js";
import { ClaudeCodeAdapter } from "./claudeCode.js";
import { CodexAdapter } from "./codex.js";
import { CommandAdapter } from "./command.js";
import { OpenAIApiAdapter } from "./openaiApi.js";
import { MockAdapter } from "./mock.js";
import { ExternalMcpAdapter } from "./mcp.js";

export * from "./types.js";
export { inbox, type Assignment } from "./mcp.js";

export const adapters: Record<AdapterKind, Adapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
  mcp: new ExternalMcpAdapter(),
  command: new CommandAdapter(),
  "openai-api": new OpenAIApiAdapter(),
  mock: new MockAdapter(),
};
