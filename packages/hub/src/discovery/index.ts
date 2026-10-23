import type { DiscoveredAgent, DiscoveryResult, LocalModelServer } from "@agent-room/shared";
import { probeClaude } from "./claude.js";
import { probeCodex } from "./codex.js";
import { defaultEnv, type DiscoveryEnv } from "./env.js";
import { probeHermes, type HermesInfo } from "./hermes.js";
import { probeServers } from "./servers.js";

export { defaultEnv, type DiscoveryEnv } from "./env.js";
export type { HermesInfo } from "./hermes.js";

const LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes" };

/** The agent that offers a model server nobody is using yet (an OpenAI-compatible agent, off until the owner turns it on). */
export function serverAgent(s: LocalModelServer): DiscoveredAgent {
  const slug = s.id === "openai-compatible" ? `openai-${s.port}` : s.id.replace(/\./g, "");
  const first = s.models[0];
  return {
    id: `local-${slug}`,
    name: s.id === "openai-compatible" ? s.label : `${s.label} (local model)`,
    provider: "local",
    adapter: "openai-api",
    installed: true,
    signedIn: null,
    detail: `${s.label} on port ${s.port}${first ? ` with ${first}${s.models.length > 1 ? ` and ${s.models.length - 1} more` : ""}` : ", still loading a model"}.`,
    settings: { baseUrl: s.baseUrl, model: first ?? "", models: s.models, locality: "local-model", server: s.id },
    capabilities: { connectors: [], dataSources: [], skills: [], tools: [] },
    capabilitiesKnown: true,
    defaultEnabled: false,
  };
}

/** "Found: Claude Code (signed in), Codex (signed in), Hermes, llama.cpp with qwen2.5-coder". */
export function summarize(agents: DiscoveredAgent[], servers: LocalModelServer[]): string {
  const parts = agents.filter((a) => a.installed && a.adapter !== "openai-api").map((a) => {
    const n = LABEL[a.id] ?? a.name;
    return a.signedIn === true ? `${n} (signed in)` : a.signedIn === false ? `${n} (not signed in)` : n;
  });
  for (const s of servers) parts.push(`${s.label}${s.models.length ? ` with ${s.models[0]}${s.models.length > 1 ? ` and ${s.models.length - 1} more` : ""}` : ""}${s.usedBy ? ` (used by ${LABEL[s.usedBy] ?? s.usedBy})` : ""}`);
  return parts.length ? `Found: ${parts.join(", ")}` : "Nothing found yet.";
}

export interface Discovered extends DiscoveryResult { hermes?: HermesInfo }

/**
 * Look at this machine: Claude Code, Codex, Hermes and the local model servers. Every probe goes through `env`
 * (PATH lookup, file reads, HTTP, command runner), so tests fake all of it. Nothing here writes anything.
 */
export async function discover(env: DiscoveryEnv = defaultEnv(), now = Date.now()): Promise<Discovered> {
  const servers = await probeServers(env);
  const [claude, codex, hermes] = await Promise.all([probeClaude(env), probeCodex(env), probeHermes(env, servers)]);
  if (hermes.server) { const s = servers.find((x) => x.id === hermes.server!.id && x.port === hermes.server!.port); if (s) s.usedBy = "hermes"; }
  const agents: DiscoveredAgent[] = [claude, codex, hermes.agent, ...servers.filter((s) => !s.usedBy && s.models.length).map(serverAgent)];
  return { at: now, agents, servers, summary: summarize(agents, servers), hermes: hermes.info };
}
