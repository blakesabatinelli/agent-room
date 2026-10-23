import type { AgentCapabilities, AgentConfig, DiscoveredAgent, DiscoveryResult, Subscription } from "@agent-room/shared";
import type { ControlFolder } from "../control/folder.js";
import type { Store } from "../db/store.js";
import { quotaFor } from "../quota/index.js";
import { startProbation } from "../resume/probation.js"; // 2.3

const TOOLS_OFF = { web: true, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false };
const COLORS: Record<string, string> = { claude: "#D97757", codex: "#2BAC76", hermes: "#E8912D" };

/** The agent in the Store that a discovered one stands for. An owner may have renamed the id, so CLIs are matched by adapter. */
export function findExisting(store: Store, d: DiscoveredAgent): AgentConfig | undefined {
  const byId = store.getAgent(d.id);
  if (byId) return byId;
  const all = store.listAgents();
  if (d.adapter === "claude-code" || d.adapter === "codex") return all.find((a) => a.adapter === d.adapter);
  if (d.id === "hermes") return all.find((a) => a.provider === "hermes" || a.id === "hermes");
  return undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Capabilities to keep on the agent: what was found, plus the owner's declarations, which discovery never touches. */
function merge(found: AgentCapabilities, old: AgentCapabilities | undefined, at: number): AgentCapabilities {
  return { ...found, ...(old?.declared?.length ? { declared: old.declared } : {}), discoveredAt: at };
}
const core = (c: AgentCapabilities | undefined) => ({ connectors: c?.connectors ?? [], dataSources: c?.dataSources ?? [], skills: c?.skills ?? [], tools: c?.tools ?? [], declared: c?.declared ?? [] });

/** What goes in TOOLS.md `platform`: bounded, so a user with hundreds of plugin skills can't push the file over its 8 KB cap. */
export function platformBlock(c: AgentCapabilities) {
  const cut = (xs: string[], n: number) => [...new Set(xs.map((x) => x.slice(0, 40)))].slice(0, n);
  return { connectors: cut(c.connectors, 40), data_sources: cut([...c.dataSources, ...(c.declared ?? [])], 40), skills: cut(c.skills, 60), tools: cut(c.tools, 10) };
}

/**
 * Bring the Store in line with what discovery found (CONTROL.md: discovery writes `platform`; the owner owns the rest).
 *  - A CLI that is installed and has no agent yet gets one, switched on. A local model server gets one switched off.
 *  - An agent that already exists keeps everything the owner set, `enabled` included. Only its capabilities and discovered facts change.
 *  - Nothing is ever deleted, and an agent the owner removed is not brought back (the ids discovery has seen are remembered).
 *  - Each agent's capabilities go to the Store (so routing works without the control folder) and, when a control folder is
 *    attached, into that agent's TOOLS.md.
 */
export async function applyDiscovery(store: Store, found: DiscoveryResult, control?: ControlFolder): Promise<{ created: string[]; updated: string[] }> {
  const created: string[] = [], updated: string[] = [];
  const known = new Set(store.getKV<string[]>("discovery_known", []));
  const platforms: { agentId: string; caps: AgentCapabilities }[] = [];
  for (const d of found.agents) {
    const existing = findExisting(store, d);
    if (!d.installed) { if (existing) known.add(existing.id); continue; }
    if (!existing) {
      if (known.has(d.id)) continue; // the owner removed it on purpose
      const agent: AgentConfig = {
        id: d.id, name: d.name, provider: d.provider, adapter: d.adapter, enabled: d.defaultEnabled,
        color: COLORS[d.id] ?? "#5A6B7D", settings: { ...d.settings }, tools: { ...TOOLS_OFF },
        ...(d.id === "claude" || d.id === "codex" ? { canBeOrchestrator: true } : {}),
        capabilities: merge(d.capabilities, undefined, found.at),
      };
      store.saveAgent(agent);
      startProbation(store, agent.id, "new"); // 2.3: a new agent practises on shadow tasks before it gets real work
      store.audit("hub", "discovery.agent.created", `${agent.id} (${agent.adapter}), ${agent.enabled ? "on" : "off until you switch it on"}`);
      known.add(agent.id); created.push(agent.id);
      if (d.adapter === "openai-api") addLocalSubscription(store, agent);
      platforms.push({ agentId: agent.id, caps: agent.capabilities! });
      continue;
    }
    known.add(existing.id);
    const next: AgentConfig = { ...existing, settings: { ...existing.settings } };
    if (d.capabilitiesKnown) next.capabilities = merge(d.capabilities, existing.capabilities, found.at);
    // Facts discovery reports about how the agent runs; never the owner's own settings.
    if (d.id === "hermes" && d.settings.discovered) next.settings.discovered = d.settings.discovered;
    if (d.adapter === "openai-api") {
      next.settings.models = d.settings.models;
      if (!next.settings.locality) next.settings.locality = "local-model";
    }
    if (!same(core(existing.capabilities), core(next.capabilities)) || !same(existing.settings, next.settings)) {
      store.saveAgent(next);
      store.audit("hub", "discovery.agent.updated", `${next.id}: capabilities ${(next.capabilities?.connectors ?? []).join(", ") || "none found"}`);
      updated.push(next.id);
    }
    if (d.capabilitiesKnown && next.capabilities) platforms.push({ agentId: next.id, caps: next.capabilities });
  }
  store.setKV("discovery_known", [...known]);
  if (control) for (const p of platforms) {
    try { await control.setPlatform(p.agentId, platformBlock(p.caps)); }
    catch (e) { store.audit("hub", "discovery.platform.failed", `${p.agentId}: ${(e as Error).message}`); }
  }
  return { created, updated };
}

/** A local model costs nothing: give it a free-tier subscription so the router prefers it for work it can do. */
function addLocalSubscription(store: Store, agent: AgentConfig) {
  const subs = quotaFor(store).subscriptions();
  if (subs.some((s) => s.agentIds.includes(agent.id))) return;
  const sub: Subscription = { id: agent.id, provider: "local", label: `${agent.name} (local, free)`, agentIds: [agent.id], kind: "local", windows: {} };
  store.setKV("quota_subscriptions", [...subs, sub]);
}
