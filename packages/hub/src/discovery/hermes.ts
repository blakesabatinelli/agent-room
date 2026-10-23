import { parse } from "yaml";
import type { DiscoveredAgent, LocalModelServer } from "@agent-room/shared";
import { connectorsFrom, dataSourcesOf } from "./connectors.js";
import type { DiscoveryEnv } from "./env.js";
import { skillNames } from "./skills.js";

/**
 * Hermes Agent (Nous Research). Where it keeps things, from its docs:
 *  - home: ~/.hermes, or $HERMES_HOME (profiles live in ~/.hermes/profiles/<name>)  https://hermes-agent.nousresearch.com/docs/user-guide/profiles
 *  - config.yaml there holds settings, `mcp_servers` (MCP client: stdio `command`/`args`, or HTTP `url` + `headers`)  https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
 *  - model: `model.default`, `model.provider` ("custom" for a local OpenAI-compatible server), `model.base_url`  https://hermes-agent.nousresearch.com/docs/integrations/providers
 *  - fallback: `fallback_providers: [{provider, model}]`  https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers
 *  - skills: ~/.hermes/skills/<category>/<name>/SKILL.md, plus `skills.external_dirs`  https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
 */
export const hermesHome = (env: DiscoveryEnv) => (env.vars.HERMES_HOME?.trim() || `${env.home}/.hermes`).replace(/\/+$/, "");

export interface HermesInfo {
  home: string;
  configPath: string;
  configFound: boolean;
  /** `model.default`, `model.provider`, `model.base_url` as written. */
  model?: { default?: string; provider?: string; baseUrl?: string };
  /** Providers it falls back to, e.g. ["minimax"]. */
  fallbackProviders: string[];
  /** Names of its MCP servers, with the hub's own entry flagged. */
  mcpServers: { name: string; enabled: boolean }[];
  hasAgentRoomEntry: boolean;
  /** `skills.external_dirs`, with ~ expanded. */
  externalDirs: string[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function readHermesConfig(env: DiscoveryEnv): HermesInfo {
  const home = hermesHome(env);
  const configPath = `${home}/config.yaml`;
  const text = env.readFile(configPath);
  const info: HermesInfo = { home, configPath, configFound: text !== undefined, fallbackProviders: [], mcpServers: [], hasAgentRoomEntry: false, externalDirs: [] };
  if (text === undefined) return info;
  let cfg: Record<string, unknown> | undefined;
  try { const y = parse(text); cfg = y && typeof y === "object" && !Array.isArray(y) ? (y as Record<string, unknown>) : undefined; } catch { cfg = undefined; }
  if (!cfg) return info;
  const m = cfg.model;
  if (m && typeof m === "object") {
    const mm = m as Record<string, unknown>;
    info.model = { default: str(mm.default), provider: str(mm.provider), baseUrl: str(mm.base_url) };
  } else if (str(m)) info.model = { default: str(m) };
  if (Array.isArray(cfg.fallback_providers)) info.fallbackProviders = cfg.fallback_providers.map((f) => str((f as { provider?: unknown })?.provider)).filter((x): x is string => !!x);
  const dirs = (cfg.skills as { external_dirs?: unknown } | undefined)?.external_dirs;
  if (Array.isArray(dirs)) info.externalDirs = dirs.filter((d): d is string => typeof d === "string").map((d) => d.replace(/^~(?=\/|$)/, env.home)).slice(0, 5);
  const servers = cfg.mcp_servers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    for (const [name, v] of Object.entries(servers as Record<string, unknown>)) {
      info.mcpServers.push({ name, enabled: (v as { enabled?: unknown } | null)?.enabled !== false });
      if (name === "agent-room") info.hasAgentRoomEntry = true;
    }
  }
  return info;
}

/** Which detected server Hermes is set up to use, if any: its base_url points at one of them, or its provider names one. */
export function serverUsedBy(info: HermesInfo, servers: LocalModelServer[]): LocalModelServer | undefined {
  const url = info.model?.baseUrl;
  if (url) {
    try {
      const u = new URL(url);
      if (/^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)$/i.test(u.hostname)) {
        const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
        const hit = servers.find((s) => s.port === port);
        if (hit) return hit;
      }
    } catch { /* not a URL */ }
  }
  const p = info.model?.provider?.toLowerCase();
  if (p === "lmstudio" || p === "lm-studio") return servers.find((s) => s.id === "lm-studio");
  if (p === "ollama") return servers.find((s) => s.id === "ollama");
  if (p === "llamacpp" || p === "llama.cpp" || p === "llama-cpp") return servers.find((s) => s.id === "llama.cpp");
  return undefined;
}

export async function probeHermes(env: DiscoveryEnv, servers: LocalModelServer[]): Promise<{ agent: DiscoveredAgent; info: HermesInfo; server?: LocalModelServer }> {
  const info = readHermesConfig(env);
  const bin = await env.which("hermes");
  const installed = !!bin || info.configFound || env.isDir(info.home);
  const base = { id: "hermes", name: "Hermes", provider: "hermes", adapter: "mcp" as const, defaultEnabled: true };
  if (!installed) {
    return { info, agent: { ...base, installed: false, signedIn: null, detail: "Hermes isn't installed.", settings: {}, capabilities: { connectors: [], dataSources: [], skills: [], tools: [] }, capabilitiesKnown: false } };
  }
  const server = serverUsedBy(info, servers);
  const connectors = connectorsFrom(info.mcpServers.filter((s) => s.enabled).map((s) => s.name));
  const skills = [...new Set([`${info.home}/skills`, ...info.externalDirs].flatMap((d) => skillNames(env, d, 4)))].sort();
  const model = info.model?.default;
  const detail = server
    ? `Found. Uses ${server.label}${model ? ` (${model})` : ""} on this Mac${info.fallbackProviders.length ? `, falls back to ${info.fallbackProviders.join(", ")}` : ""}.`
    : `Found${model ? `. Model: ${model}` : ""}${info.fallbackProviders.length ? `, falls back to ${info.fallbackProviders.join(", ")}` : ""}.`;
  return {
    info, server,
    agent: {
      ...base, installed: true, signedIn: null, detail,
      // Facts about how it runs. Not `model`: that setting is the --model the Room asks for, and Hermes picks its own.
      settings: { discovered: { home: info.home, model: model ?? null, provider: info.model?.provider ?? null, localServer: server?.id ?? null, fallbackProviders: info.fallbackProviders } },
      // What Hermes's own tools reach isn't in any file; only its MCP servers and skills are.
      capabilities: { connectors, dataSources: dataSourcesOf(connectors), skills, tools: [] },
      capabilitiesKnown: info.configFound,
    },
  };
}
