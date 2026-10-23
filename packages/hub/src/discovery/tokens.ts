import type { AgentConfig } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { token } from "../util.js";

/**
 * The per-agent MCP key, kept in the same place and format as POST /agents/:id/mcp-connection (KV "mcp_tokens":
 * key -> { agentId, name }), so a key made here works there and the other way round. Returns the agent's
 * existing key, or makes one. Never replaces a working key.
 */
export function ensureMcpToken(store: Store, agent: Pick<AgentConfig, "id" | "name">, actor = "hub"): { token: string; created: boolean } {
  const all = store.getKV<Record<string, { agentId: string; name: string }>>("mcp_tokens", {});
  const have = Object.entries(all).find(([, v]) => v.agentId === agent.id)?.[0];
  if (have) return { token: have, created: false };
  const t = token();
  all[t] = { agentId: agent.id, name: agent.name };
  store.setKV("mcp_tokens", all);
  store.audit(actor, "mcp.connection.created", agent.id);
  return { token: t, created: true };
}
