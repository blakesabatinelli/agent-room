import type { AgentConfig } from "@agent-room/shared";
import { familyOf, isLocalAgent } from "../jury/family.js";

/**
 * 4.1 Who turns the second key. An agent of a DIFFERENT model family than the first (never the same vendor under another name: `familyOf` decides),
 * from the agents this room's roster lets work here and that are ready, not out of quota, not a local model the capacity governor won't admit, and
 * not an agent on probation (the caller filters those out of `ready`). The best of them: cloud before local, then the agent's quality, then its id.
 */
export interface PickInput {
  ready: AgentConfig[];
  first: AgentConfig;
  localModels: string[];
  limited: (agentId: string) => boolean;
  admit: (a: AgentConfig) => boolean;
}
export interface PickResult { agent?: AgentConfig; family?: string; firstFamily: string; why?: string }

export function pickSecond(a: PickInput): PickResult {
  const firstFamily = familyOf(a.first, a.localModels);
  const others = a.ready.filter((x) => x.enabled && x.id !== a.first.id);
  const other = others.filter((x) => familyOf(x, a.localModels) !== firstFamily);
  if (!other.length) {
    return { firstFamily, why: others.length
      ? `every other agent that is ready is the same model family as ${a.first.name} (${firstFamily})`
      : "no other agent is ready here" };
  }
  const usable = other.filter((x) => !a.limited(x.id));
  if (!usable.length) return { firstFamily, why: "the agents of another model family are out of quota" };
  const admitted = usable.filter((x) => !isLocalAgent(x, a.localModels) || a.admit(x));
  if (!admitted.length) return { firstFamily, why: "the only agents of another model family are local models the capacity governor will not run right now" };
  const rank = (x: AgentConfig) => (isLocalAgent(x, a.localModels) ? 1000 : 0) - Number((x.settings as { quality?: number } | undefined)?.quality ?? 0.8) * 100;
  const agent = [...admitted].sort((p, q) => rank(p) - rank(q) || p.id.localeCompare(q.id))[0];
  return { agent, family: familyOf(agent, a.localModels), firstFamily };
}
