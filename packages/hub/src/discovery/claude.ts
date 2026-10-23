import type { DiscoveredAgent } from "@agent-room/shared";
import { connectorsFrom, dataSourcesOf } from "./connectors.js";
import type { DiscoveryEnv } from "./env.js";
import { skillNames } from "./skills.js";

/** Server names from `claude mcp list`: `name: target - ✓ Connected`. Health is not read; the hub only wants to know what exists. */
export function parseClaudeMcpList(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?):\s+\S.*\s-\s+\S/.exec(line.trim());
    if (m && !/^(checking|error)/i.test(m[1])) names.push(m[1].trim());
  }
  return names;
}

const keys = (o: unknown): string[] => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o as object) : []);

/**
 * Claude Code: `claude` on PATH, signed in when ~/.claude.json has an oauthAccount (same test as the adapter), MCP servers
 * from ~/.claude.json (user level and every project), the connectors the Claude account added (listed there too and in
 * `claude mcp list`), skills from ~/.claude/skills and installed plugins.
 */
export async function probeClaude(env: DiscoveryEnv): Promise<DiscoveredAgent> {
  const bin = await env.which("claude");
  const base = { id: "claude", name: "Claude", provider: "anthropic", adapter: "claude-code" as const, defaultEnabled: true };
  if (!bin) {
    return { ...base, installed: false, signedIn: false, detail: "Claude Code isn't installed.", settings: {}, capabilities: { connectors: [], dataSources: [], skills: [], tools: [] }, capabilitiesKnown: false };
  }
  let signedIn: boolean | null = null, detail = "Installed. Sign-in couldn't be confirmed.";
  const raw = env.readFile(`${env.home}/.claude.json`);
  let cfg: Record<string, unknown> | undefined;
  if (raw !== undefined) { try { cfg = JSON.parse(raw) as Record<string, unknown>; } catch { cfg = undefined; } }
  if (cfg) {
    const email = (cfg.oauthAccount as { emailAddress?: string } | undefined)?.emailAddress;
    if (email) { signedIn = true; detail = `Signed in as ${email}`; }
    else if (env.vars.ANTHROPIC_API_KEY) { signedIn = true; detail = "Using ANTHROPIC_API_KEY"; }
    else { signedIn = false; detail = "Installed, but not signed in."; }
  }

  const names = new Set<string>(keys(cfg?.mcpServers));
  for (const p of Object.values((cfg?.projects as Record<string, { mcpServers?: unknown }> | undefined) ?? {})) for (const k of keys(p?.mcpServers)) names.add(k);
  const ever = cfg?.claudeAiMcpEverConnected;
  if (Array.isArray(ever)) for (const n of ever) if (typeof n === "string") names.add(n);
  // `claude mcp list` also shows connectors added in the Claude account. It checks each server, so give it a few seconds only.
  let listed = false;
  if (signedIn !== false) {
    const r = await env.run("claude", ["mcp", "list"], 12_000).catch(() => undefined);
    if (r && r.code === 0) { listed = true; for (const n of parseClaudeMcpList(r.stdout)) names.add(n); }
  }
  const connectors = connectorsFrom(names);
  const skills = [...new Set([
    ...skillNames(env, `${env.home}/.claude/skills`, 1),
    ...skillNames(env, `${env.home}/.claude/plugins/cache`, 8),
  ])].sort();
  return {
    ...base, installed: true, signedIn, detail,
    settings: {},
    capabilities: { connectors, dataSources: dataSourcesOf(connectors), skills, tools: ["web", "filesystem", "shell"] },
    // Nothing readable and nothing listed: don't claim "no connectors" (that would switch the Room's connector tools off).
    capabilitiesKnown: !!cfg || listed,
  };
}
