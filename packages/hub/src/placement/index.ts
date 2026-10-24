import type { AdapterKind, AgentConfig } from "@agent-room/shared";
import type { Store } from "../db/store.js";

/**
 * Tasks that agents can actually do (part 2): where an agent runs.
 *
 * A task that works on its task folder (creates or changes files, runs a shell) can only be done by an agent that runs on this Mac. The hub
 * knows that for its own adapters; for an external MCP agent it looks at where the agent's MCP connections come from. A task that only
 * hands back text (an answer, research, writing returned in the reply, a review whose material is in the prompt) can go to anyone.
 */

/** The need a task carries when it works on the task folder. Rides on Task.needs, so the existing needs filter in routing narrows the pool. */
export const WORKSPACE_NEED = "workspace";

/** Adapters the hub starts itself, on this Mac. An MCP agent is the only kind that can live somewhere else. */
const LOCAL_ADAPTERS = new Set<AdapterKind>(["claude-code", "codex", "acp", "command", "openai-api", "mock"]);

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);
export const isLoopbackAddress = (addr: string | undefined): boolean => LOOPBACK.has(String(addr ?? "").trim().toLowerCase());

/**
 * Does this agent run on this Mac? The owner's `location` setting wins. Otherwise: the local adapters do; an MCP agent does only when its
 * connections have come from loopback. An MCP agent the hub has never heard from is treated as elsewhere (it can't be routed work until it
 * connects, and its first call records where it is).
 */
export function runsHere(a: Pick<AgentConfig, "adapter" | "location" | "connectsFrom">): boolean {
  if (a.location === "here") return true;
  if (a.location === "elsewhere") return false;
  if (a.adapter !== "mcp") return LOCAL_ADAPTERS.has(a.adapter);
  return a.connectsFrom?.loopback === true;
}

/** "this Mac", or where the agent connects from, for a message. */
export function whereText(a: Pick<AgentConfig, "adapter" | "location" | "connectsFrom">): string {
  if (runsHere(a)) return "this Mac";
  if (a.location === "elsewhere") return "another machine";
  return a.connectsFrom?.address ? `another machine (${a.connectsFrom.address})` : "another machine";
}

/**
 * Remember where an MCP agent's connection came from. `proxied` is a request that came through Tailscale serve or Funnel: it reaches the
 * hub from 127.0.0.1 but is not the Mac's own traffic. Writes only when the address or the answer changes.
 */
export function recordConnection(store: Store, agentId: string, from: { address?: string; proxied?: boolean }, at = Date.now()): void {
  const a = store.getAgent(agentId);
  if (!a || a.adapter !== "mcp") return;
  const address = String(from.address ?? "unknown").replace(/^::ffff:/, "").slice(0, 64) || "unknown";
  const loopback = !from.proxied && isLoopbackAddress(from.address);
  const cur = a.connectsFrom;
  if (cur && cur.address === address && cur.loopback === loopback) return; // the same place again: nothing to write
  store.saveAgent({ ...a, connectsFrom: { address, loopback, at } });
  if (!cur || cur.loopback !== loopback) store.audit("hub", "agent.location", `${agentId} connects from ${address} (${loopback ? "this Mac" : "another machine"})`);
}

/** Fields of a planned task that say whether it works on the task folder. */
export interface WorkspaceHints { workspace?: unknown; files?: string[]; criteria?: unknown; output?: string; taskType?: string }

/** A hand-back that names a file ("research.md", "out/report.csv") means the task writes into its folder. */
const FILE_NAME = /[\w-]+\.(?:md|txt|json|jsonl|csv|tsv|ts|tsx|js|mjs|py|html|css|ya?ml|xml|pdf|docx?|xlsx?|pptx|png|jpe?g|svg|sql|sh|toml|ini|log|rtf|ipynb|java|go|rs|rb|cpp|c|h)\b/i;

/**
 * Does this task work on the task folder? The planner says so with "workspace": true or false. When it doesn't say, the task does if it
 * lists files it may write, has a criterion a shell command decides, hands back a named file, or is coding.
 */
export function taskNeedsWorkspace(t: WorkspaceHints): boolean {
  if (typeof t.workspace === "boolean") return t.workspace;
  if (t.files?.some((f) => typeof f === "string" && f.trim())) return true;
  if (Array.isArray(t.criteria) && t.criteria.some((c) => typeof c === "object" && c !== null && typeof (c as { check?: unknown }).check === "string" && (c as { check: string }).check.trim())) return true;
  if (t.output && FILE_NAME.test(t.output)) return true;
  return String(t.taskType ?? "").toLowerCase() === "coding";
}

/** The task's needs with "workspace" added when it works on the folder, and left out when the planner said it doesn't. */
export function withWorkspaceNeed(needs: string[], t: WorkspaceHints): string[] {
  const rest = needs.filter((n) => n !== WORKSPACE_NEED);
  const listed = needs.includes(WORKSPACE_NEED) && typeof t.workspace !== "boolean"; // the planner named it in "needs" and didn't say otherwise
  return listed || taskNeedsWorkspace(t) ? [...rest, WORKSPACE_NEED] : rest;
}

export const needsWorkspace = (t: { needs?: string[] }): boolean => !!t.needs?.includes(WORKSPACE_NEED);
