import type { AgentConfig, McpConnection, McpInvite } from "@agent-room/shared";

/** Agents that exist only as a connection from somewhere else. Asking for an invite makes them if they aren't there yet. */
export const INVITE_PRESETS: Record<string, { name: string; provider: string; color: string }> = {
  muse: { name: "Muse", provider: "muse", color: "#E01E5A" },
  hermes: { name: "Hermes", provider: "hermes", color: "#E8912D" },
};

export function presetAgent(id: string): AgentConfig | undefined {
  const p = INVITE_PRESETS[id];
  return p ? { id, name: p.name, provider: p.provider, adapter: "mcp", enabled: true, color: p.color, settings: {}, tools: { web: true, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false } } : undefined;
}

/**
 * The whole pairing step for an agent on another tailnet device (Muse today): its MCP address on the tailnet, its own key,
 * and the message to give it. Same key and instructions as the MCP connection screen.
 */
export function buildInvite(agent: Pick<AgentConfig, "id" | "name">, conn: McpConnection, url: string): McpInvite {
  // The key exists once, in the response that made it. A repeat invite has none to show, so the text carries a placeholder.
  const key = conn.token || "YOUR_KEY";
  const config = JSON.stringify({ mcpServers: { "agent-room": { type: "http", url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  const block = [
    `Connect ${agent.name} to Agent Room`,
    "",
    `1. Add this MCP server to ${agent.name} (URL and header):`,
    `   URL:     ${url}`,
    `   Header:  Authorization: Bearer ${key}`,
    "",
    `   or as a config block:`,
    ...config.split("\n").map((l) => `   ${l}`),
    "",
    `2. Then tell ${agent.name}:`,
    ...conn.instructions.split("\n").map((l) => `   ${l}`),
  ].join("\n");
  return { agentId: agent.id, name: agent.name, url, token: conn.token, ...(conn.token ? {} : { tokenHidden: true }), block, instructions: conn.instructions };
}
