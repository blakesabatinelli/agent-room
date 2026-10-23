import { basename } from "node:path";
import type { DiscoveryResult, DiscoverySettings, DiscoveryState } from "@agent-room/shared";
import type { ControlFolder } from "../control/folder.js";
import type { Store } from "../db/store.js";
import { applyDiscovery } from "./apply.js";
import { refreshCommandIndex } from "../commands/index.js"; // 2.6
import { connectHermes, hermesConfiguredKey, installHermesSkill, type HermesConnect } from "./connect.js";
import { defaultEnv, discover, type DiscoveryEnv } from "./index.js";
import { McpTokens } from "../mcp/tokens.js";
import { freshKey, keyWorks } from "./tokens.js";
import { localModelsFor } from "./usage.js";

export interface DiscoveryOptions {
  /** Every probe the discovery makes. Defaults to the real machine. */
  env?: DiscoveryEnv;
  /** The control folder, read at call time (it may be attached after this is built). */
  control?: () => ControlFolder | undefined;
  /** The hub's MCP URL as the hub's own machine reaches it, for agents on this Mac (Hermes). */
  mcpUrl: () => string | undefined;
  /** The hub's key store (hashed at rest). Defaults to one over the same Store. */
  tokens?: McpTokens;
}

/**
 * 1.3: finds the agents, tools and model servers on this Mac, brings them into the Store and the control folder,
 * and (when the owner left "Connect automatically" on) joins Hermes to the hub. The last result is kept so the apps can show it
 * and so a local model's runs can be told apart from a cloud model's.
 */
export class DiscoveryService {
  private inflight?: Promise<DiscoveryResult>;
  private timer?: NodeJS.Timeout;
  private tokens: McpTokens;
  constructor(private store: Store, private opts: DiscoveryOptions) { this.tokens = opts.tokens ?? new McpTokens(store); }

  settings(): DiscoverySettings { return { connectAutomatically: true, ...this.store.getKV<Partial<DiscoverySettings>>("discovery_settings", {}) }; }
  saveSettings(s: Partial<DiscoverySettings>): DiscoverySettings {
    const next = { ...this.settings(), ...(s.connectAutomatically !== undefined ? { connectAutomatically: !!s.connectAutomatically } : {}) };
    this.store.setKV("discovery_settings", next);
    this.store.audit("owner", "discovery.settings", `connect automatically ${next.connectAutomatically ? "on" : "off"}`);
    return next;
  }
  last(): DiscoveryResult | null { return this.store.getKV<DiscoveryResult | null>("discovery_last", null); }
  state(): DiscoveryState { return { last: this.last(), settings: this.settings(), running: !!this.inflight }; }
  /** Models running on this Mac, from the last discovery. */
  localModels(): string[] { return localModelsFor(this.store); }

  /** Look, apply, and connect Hermes. Concurrent calls share one run. */
  run(): Promise<DiscoveryResult> {
    this.inflight ??= this.runOnce().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  /** Re-run now and then so a CLI installed later shows up without anyone asking. */
  startTimer(everyMs = 30 * 60_000) {
    clearInterval(this.timer);
    this.timer = setInterval(() => { void this.run().catch(() => undefined); }, everyMs);
    this.timer.unref?.();
  }
  stopTimer() { clearInterval(this.timer); }

  private async runOnce(): Promise<DiscoveryResult> {
    const env = this.opts.env ?? defaultEnv();
    const { hermes: _info, ...found } = await discover(env);
    const applied = await applyDiscovery(this.store, found, this.opts.control?.());
    const hermes = this.settings().connectAutomatically ? this.autoConnect(env, found) : undefined;
    const result: DiscoveryResult = { ...found, applied: { ...applied, ...(hermes ? { hermes: hermesSummary(hermes) } : {}) } };
    this.store.setKV("discovery_last", result);
    try { refreshCommandIndex(this.store, result, env); } catch { /* 2.6: the command index is a convenience; discovery never fails over it */ }
    this.store.audit("hub", "discovery.ran", `${result.summary}${applied.created.length ? `; added ${applied.created.join(", ")}` : ""}`);
    return result;
  }

  private autoConnect(env: DiscoveryEnv, found: DiscoveryResult): HermesConnect | undefined {
    const d = found.agents.find((a) => a.id === "hermes");
    const agent = this.store.getAgent("hermes");
    // Only for a Hermes that is installed, and that the owner hasn't switched off.
    if (!d?.installed || !agent?.enabled) return undefined;
    return this.connectHermesNow(env, agent.id, agent.name);
  }

  /** Write the hub's connection into Hermes's config (also what the owner's "Connect Hermes" button does, whatever the setting says). */
  connectHermes(actor = "owner"): HermesConnect {
    const agent = this.store.getAgent("hermes");
    if (!agent) throw new Error("There is no Hermes agent to connect.");
    return this.connectHermesNow(this.opts.env ?? defaultEnv(), agent.id, agent.name, actor);
  }

  private connectHermesNow(env: DiscoveryEnv, id: string, name: string, actor = "hub"): HermesConnect {
    const url = this.opts.mcpUrl();
    if (!url) return { status: "failed", detail: "The hub isn't listening yet.", configPath: "", snippet: "" };
    // Keys are only stored as hashes, so the key already written into Hermes's config.yaml is the one copy. Keep it while the
    // hub still accepts it; otherwise make a new one, and only at the moment the file is about to be written.
    const configured = hermesConfiguredKey(env);
    const keep = keyWorks(this.tokens, id, configured) ? configured : undefined;
    const r = connectHermes(env, { url, token: keep ?? (() => freshKey(this.tokens, { id, name }, actor)) });
    if (r.status === "failed") this.store.audit(actor, "hermes.connect.failed", r.detail);
    else if (r.status !== "skipped") {
      const skill = installHermesSkill(env);
      if (r.status !== "unchanged" || skill === "written") this.store.audit(actor, "hermes.connected", `${r.status}: ${r.configPath}${r.backupPath ? `, original kept as ${basename(r.backupPath)}` : ""}; skill ${skill}`);
    }
    return r;
  }
}

/** What the apps see (never the key). */
const hermesSummary = (r: HermesConnect) => ({ status: r.status, detail: r.detail, configPath: r.configPath || undefined, backupPath: r.backupPath });
export { hermesSummary };
