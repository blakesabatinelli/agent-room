import type { AgentConfig } from "@agent-room/shared";
import { classifyAgent } from "../capacity/locality.js";

/**
 * 2.2 Model family: who trained the model, because models favour their own family's writing.
 * Named families: anthropic, openai, google, meta, nous. A model running on this Mac is its own family,
 * "local-<model>" (a Hermes run on a local Bonsai is "local-bonsai", not "nous").
 */

const MODEL_FAMILIES: [RegExp, string][] = [
  [/\b(claude|opus|sonnet|haiku)\b|^(opus|sonnet|haiku)[-\d]/i, "anthropic"],
  [/\b(gpt|chatgpt|codex|davinci)\b|gpt-|^o[134](-|$)/i, "openai"],
  [/\b(gemini|gemma|palm|bard)\b/i, "google"],
  [/\b(hermes|nous)\b/i, "nous"],
  [/\b(llama|meta-llama|codellama)\b/i, "meta"],
];
const PROVIDER_FAMILIES: Record<string, string> = {
  anthropic: "anthropic", claude: "anthropic", openai: "openai", chatgpt: "openai", google: "google", gemini: "google",
  meta: "meta", llama: "meta", hermes: "nous", nous: "nous",
};

/** The model an agent is set to run, from its settings or its first profile. */
export function modelOf(agent: AgentConfig): string | undefined {
  const m = agent.settings?.model;
  if (typeof m === "string" && m.trim()) return m.trim();
  const p = agent.profiles?.find((x) => x.model);
  return p?.model;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * Does this agent run its model on this Mac? classifyAgent says so (1.5), or its model is one the last
 * discovery found running here (1.3), or Hermes says it is using a local server.
 */
export function isLocalAgent(agent: AgentConfig, localModels: string[] = []): boolean {
  if (classifyAgent(agent) === "local-model") return true;
  const m = modelOf(agent)?.toLowerCase();
  if (m && localModels.some((l) => { const x = l.toLowerCase(); return x === m || x.includes(m) || m.includes(x); })) return true;
  const d = agent.settings?.discovered as { localServer?: string | null } | undefined;
  return !!d?.localServer;
}

/** The family a model name belongs to, when the name says. */
export function familyOfModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  for (const [re, fam] of MODEL_FAMILIES) if (re.test(model)) return fam;
  return undefined;
}

export function familyOf(agent: AgentConfig, localModels: string[] = []): string {
  const model = modelOf(agent);
  if (isLocalAgent(agent, localModels)) {
    const d = agent.settings?.discovered as { model?: string | null } | undefined;
    const name = model ?? (typeof d?.model === "string" ? d.model : undefined) ?? agent.provider ?? agent.id;
    return `local-${slug(name) || slug(agent.id)}`;
  }
  // The model's name beats the agent's label: Hermes routed to a Claude model is Claude's family.
  return familyOfModel(model) ?? PROVIDER_FAMILIES[agent.provider?.toLowerCase()] ?? (slug(agent.provider ?? "") || slug(agent.id));
}
