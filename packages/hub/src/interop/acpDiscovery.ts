// 4.6 Finding agents that speak ACP (Agent Client Protocol) on this Mac, so they join through the generic "acp" adapter with no per-agent code.
//
// How each CLI is started in ACP mode, from the ACP registry (read 2026-10-23):
//   https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
//   https://agentclientprotocol.com/overview/agents
//   gemini    @google/gemini-cli   `gemini --acp`   (docs: https://geminicli.com/docs/cli/acp-mode/; older builds used `--experimental-acp`)
//   qwen      @qwen-code/qwen-code `qwen --acp`
//   opencode  `opencode acp`       goose `goose acp`       kimi `kimi acp`
// Claude Code and Codex also speak ACP through Zed's adapters (claude-agent-acp, codex-acp); the hub drives those two natively, so they aren't listed here.
// Muse Code has no documented ACP launch command yet (the registry lists only an unofficial "Muse Spark Code"), so it stays on its own connection.
//
// A CLI only counts when it is on PATH AND its --help mentions ACP: an older Gemini CLI without ACP is left alone.
import type { DiscoveredAgent } from "@agent-room/shared";
import type { DiscoveryEnv } from "../discovery/env.js";

export interface AcpCli {
  /** Agent id in the Room. */
  id: string;
  name: string;
  provider: string;
  bin: string;
  /** `flag`: the CLI takes --acp (or the older --experimental-acp). `subcommand`: `<bin> acp`. */
  style: "flag" | "subcommand";
}

export const ACP_CLIS: AcpCli[] = [
  { id: "gemini", name: "Gemini CLI", provider: "google", bin: "gemini", style: "flag" },
  { id: "qwen", name: "Qwen Code", provider: "alibaba", bin: "qwen", style: "flag" },
  { id: "opencode", name: "OpenCode", provider: "opencode", bin: "opencode", style: "subcommand" },
  { id: "goose", name: "goose", provider: "block", bin: "goose", style: "subcommand" },
  { id: "kimi", name: "Kimi CLI", provider: "moonshot", bin: "kimi", style: "subcommand" },
];

/** The arguments that start this CLI in ACP mode, from its --help text, or undefined when the help doesn't offer ACP. */
export function acpLaunchArgs(cli: Pick<AcpCli, "style">, help: string): string[] | undefined {
  if (!/\bacp\b/i.test(help)) return undefined;
  if (cli.style === "subcommand") return ["acp"];
  // Prefer the current flag; fall back to the one older builds used.
  if (/(^|[\s,|])--acp\b/m.test(help)) return ["--acp"];
  if (/--experimental-acp\b/.test(help)) return ["--experimental-acp"];
  return undefined;
}

/**
 * Every ACP-capable CLI found, as an agent that is off until the owner switches it on. New agents start on probation (2.3), so the first runs
 * are practice copies of real tasks, and its tools start with files on, web on, shell off.
 */
export async function probeAcpAgents(env: DiscoveryEnv, clis: AcpCli[] = ACP_CLIS): Promise<DiscoveredAgent[]> {
  const found = await Promise.all(clis.map(async (cli): Promise<DiscoveredAgent | undefined> => {
    const path = await env.which(cli.bin).catch(() => undefined);
    if (!path) return undefined;
    const r = await env.run(path, ["--help"], 8000).catch(() => undefined);
    if (!r) return undefined;
    const args = acpLaunchArgs(cli, `${r.stdout}\n${r.stderr}`);
    if (!args) return undefined;
    return {
      id: cli.id, name: cli.name, provider: cli.provider, adapter: "acp", installed: true, signedIn: null,
      detail: `Found at ${path}. Speaks ACP (${cli.bin} ${args.join(" ")}). Switch it on to give it work.`,
      settings: { command: cli.bin, args, protocol: "acp" },
      capabilities: { connectors: [], dataSources: [], skills: [], tools: ["filesystem"] },
      // What an ACP agent can reach on its own isn't visible from here: don't claim "none".
      capabilitiesKnown: false,
      defaultEnabled: false,
    };
  }));
  return found.filter((a): a is DiscoveredAgent => !!a);
}
