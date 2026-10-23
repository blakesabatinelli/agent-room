import type { AgentConfig } from "@agent-room/shared";
import type { Store } from "./db/store.js";

const defaultTools = { web: true, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false };

export function seed(store: Store, demo: boolean) {
  if (!store.listRooms().length) store.createRoom("general", { topic: "Give the room a goal, or @mention an agent" });
  if (store.listAgents().length) return migrate(store);
  const agents: AgentConfig[] = demo
    ? [
        { id: "claude", name: "Claude", provider: "anthropic", adapter: "mock", enabled: true, color: "#6B4FD8", settings: { quality: 0.85 }, tools: { ...defaultTools }, canBeOrchestrator: true },
        { id: "codex", name: "Codex", provider: "openai", adapter: "mock", enabled: true, color: "#0E8A7A", settings: { quality: 0.75 }, tools: { ...defaultTools }, canBeOrchestrator: true },
        { id: "hermes", name: "Hermes", provider: "hermes", adapter: "mock", enabled: true, color: "#B7791F", settings: { quality: 0.65 }, tools: { ...defaultTools } },
      ]
    : [
        { id: "claude", name: "Claude", provider: "anthropic", adapter: "claude-code", enabled: true, color: "#D97757", settings: {}, tools: { ...defaultTools }, canBeOrchestrator: true },
        { id: "codex", name: "Codex", provider: "openai", adapter: "codex", enabled: true, color: "#2BAC76", settings: {}, tools: { ...defaultTools }, canBeOrchestrator: true },
        { id: "hermes", name: "Hermes", provider: "hermes", adapter: "mcp", enabled: true, color: "#E8912D", settings: {}, tools: { ...defaultTools } },
        { id: "muse", name: "Muse", provider: "muse", adapter: "mcp", enabled: true, color: "#A63A86", settings: {}, tools: { ...defaultTools } },
      ];
  agents.forEach((a) => store.saveAgent(a));
}

/** Bring older installs forward without touching the owner's own choices. */
function migrate(store: Store) {
  for (const a of store.listAgents()) {
    // Hermes and Muse join over MCP, not as a local command.
    if ((a.id === "hermes" || a.id === "muse") && a.adapter === "command" && (a.settings.command === a.id)) {
      store.saveAgent({ ...a, adapter: "mcp", enabled: true, settings: {}, color: a.id === "hermes" ? "#E8912D" : "#A63A86" });
    }
    if (a.provider === "mcp" && a.adapter === "mock" && a.settings.mcpOnly) store.saveAgent({ ...a, adapter: "mcp", enabled: true, settings: {} });
  }
}
