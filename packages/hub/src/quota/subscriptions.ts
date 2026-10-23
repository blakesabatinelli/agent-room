import type { AgentConfig, Subscription } from "@agent-room/shared";

/**
 * 1.6 Default subscriptions, seeded from the agents the Room has. Owner-editable; limits start unknown ("learning").
 * Hermes has two: its local Bonsai model (free) and the MiniMax subscription it falls back to. A Hermes run is
 * recognised as MiniMax when the model it reports matches /minimax/i; anything else counts as local.
 */
export const MINIMAX_MATCH = "minimax";

const none = { windows: {} } as const;
export const DEFAULT_SUBSCRIPTIONS: Subscription[] = [
  { id: "claude", provider: "anthropic", label: "Claude (subscription)", agentIds: ["claude"], kind: "subscription", ...none },
  { id: "codex", provider: "openai", label: "ChatGPT/Codex (subscription)", agentIds: ["codex"], kind: "subscription", ...none },
  { id: "hermes-local", provider: "hermes", label: "Hermes on Bonsai (local)", agentIds: ["hermes"], kind: "local", ...none },
  { id: "hermes-minimax", provider: "minimax", label: "MiniMax (fallback, subscription)", agentIds: ["hermes"], kind: "subscription", modelMatch: MINIMAX_MATCH, ...none },
  { id: "muse", provider: "muse", label: "Meta (subscription)", agentIds: ["muse"], kind: "subscription", ...none },
];

/** Defaults for agents the Room has that no subscription covers yet and that haven't been seeded before. */
export function seedFor(agents: AgentConfig[], existing: Subscription[], seeded: string[]): Subscription[] {
  const out: Subscription[] = [];
  for (const a of agents) {
    if (seeded.includes(a.id) || existing.some((s) => s.agentIds.includes(a.id))) continue;
    for (const d of DEFAULT_SUBSCRIPTIONS) if (d.agentIds.includes(a.id) && !existing.some((s) => s.id === d.id) && !out.some((s) => s.id === d.id)) out.push(structuredClone(d));
  }
  return out;
}

/**
 * Which of an agent's subscriptions a run belongs to: the one whose modelMatch fits the model the CLI reported,
 * else the agent's default one (no modelMatch), else the first.
 */
export function resolveSubscription(subs: Subscription[], agentId: string, model?: string): Subscription | undefined {
  const mine = subs.filter((s) => s.agentIds.includes(agentId));
  if (model) {
    const hit = mine.find((s) => { try { return !!s.modelMatch && new RegExp(s.modelMatch, "i").test(model); } catch { return false; } });
    if (hit) return hit;
  }
  return mine.find((s) => !s.modelMatch) ?? mine[0];
}
