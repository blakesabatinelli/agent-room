import type { AgentConfig, McpTokenInfo } from "@agent-room/shared";
import type { McpTokens } from "../mcp/tokens.js";

/**
 * Discovery makes and finds the per-agent MCP key through 1.1's key module, so a key is only ever stored as a hash.
 * A key can't be read back once it has been made: it exists in the response that made it (an invite) or in the file it
 * was written into (Hermes's config.yaml). Asking again therefore never returns the old key.
 */

/** The agent's connection key: the newest one that isn't pinned to a room (the one the Connect screen manages). */
export const connectionKeyOf = (tokens: McpTokens, agentId: string): McpTokenInfo | undefined =>
  tokens.forAgent(agentId).filter((k) => !k.roomId).sort((x, y) => y.createdAt - x.createdAt)[0];

export interface IssuedKey {
  /** The new key. Undefined when the agent already has one that was handed out before (nothing is replaced unless asked). */
  token?: string;
  /** True when a key that was already handed out is still in force and was left alone. */
  alreadyHandedOut: boolean;
  /** True when an existing key was replaced (the old one stopped working). */
  rotated: boolean;
}

/**
 * For an invite: the first one makes the agent's key and shows it. A second one says the key was already handed out and
 * changes nothing, because a new key would cut off an agent that is already connected. Only `rotate: true` replaces it.
 */
export function issueKey(tokens: McpTokens, agent: Pick<AgentConfig, "id" | "name">, o: { rotate?: boolean; actor?: string } = {}): IssuedKey {
  const actor = o.actor ?? "owner";
  const have = connectionKeyOf(tokens, agent.id);
  if (!have) return { token: tokens.create({ agentId: agent.id, name: agent.name }, actor).token, alreadyHandedOut: false, rotated: false };
  if (!o.rotate) return { alreadyHandedOut: true, rotated: false };
  return { token: tokens.rotate(have.id, {}, actor)!.token, alreadyHandedOut: false, rotated: true };
}

/**
 * For writing into Hermes's own config: a key that is only kept in that file. Makes a new one (or replaces the existing
 * connection key) because the old one can't be read back. Call it only when a write is about to happen.
 */
export function freshKey(tokens: McpTokens, agent: Pick<AgentConfig, "id" | "name">, actor = "hub"): string {
  const have = connectionKeyOf(tokens, agent.id);
  return have ? tokens.rotate(have.id, {}, actor)!.token : tokens.create({ agentId: agent.id, name: agent.name }, actor).token;
}

/** Is this key one the hub accepts for this agent, unexpired? Used to keep the key already written into Hermes's config. */
export function keyWorks(tokens: McpTokens, agentId: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const hit = tokens.lookup(presented);
  return !!hit && !hit.expired && hit.record.agentId === agentId;
}
