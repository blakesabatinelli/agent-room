import type { DiscoveredAgent } from "@agent-room/shared";
import { connectorsFrom, dataSourcesOf } from "./connectors.js";
import type { DiscoveryEnv } from "./env.js";
import { markdownNames, skillNames } from "./skills.js";
import { parseCodexToml } from "./toml.js";

/**
 * Codex: `codex` on PATH, `codex login status` for sign-in (the same call the adapter makes), MCP servers from
 * ~/.codex/config.toml `[mcp_servers.*]` (ones set `enabled = false` are skipped), custom prompts from ~/.codex/prompts/*.md
 * and skills from ~/.codex/skills.
 */
export async function probeCodex(env: DiscoveryEnv): Promise<DiscoveredAgent> {
  const base = { id: "codex", name: "Codex", provider: "openai", adapter: "codex" as const, defaultEnabled: true };
  const bin = await env.which("codex");
  if (!bin) {
    return { ...base, installed: false, signedIn: false, detail: "Codex isn't installed.", settings: {}, capabilities: { connectors: [], dataSources: [], skills: [], tools: [] }, capabilitiesKnown: false };
  }
  const r = await env.run("codex", ["login", "status"], 8000).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  const out = `${r.stdout}\n${r.stderr}`.trim();
  let signedIn: boolean | null, detail: string;
  if (/not logged in/i.test(out)) { signedIn = false; detail = "Installed, but not signed in."; }
  else if (r.code === 0) { signedIn = true; detail = out.split("\n")[0] || "Signed in"; }
  else { signedIn = null; detail = out.split("\n").slice(-2).join(" ") || "Installed. Sign-in couldn't be confirmed."; }

  const toml = env.readFile(`${env.home}/.codex/config.toml`);
  const cfg = toml === undefined ? undefined : parseCodexToml(toml);
  const connectors = connectorsFrom((cfg?.mcpServers ?? []).filter((s) => s.enabled).map((s) => s.name));
  const skills = [...new Set([
    ...markdownNames(env, `${env.home}/.codex/prompts`).map((n) => `/${n}`),
    ...skillNames(env, `${env.home}/.codex/skills`, 1),
  ])].sort();
  return {
    ...base, installed: true, signedIn, detail,
    settings: {},
    capabilities: { connectors, dataSources: dataSourcesOf(connectors), skills, tools: ["web", "filesystem", "shell"] },
    // No config.toml is a real answer for Codex (it has no MCP servers); only an unreadable one isn't.
    capabilitiesKnown: true,
  };
}
