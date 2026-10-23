import type { AgentCapabilities } from "@agent-room/shared";

/**
 * 1.3: turn the names agents give their MCP servers ("claude.ai Gmail", "google-drive", "Snowflake - Cortex Analyst")
 * into the ids the Room uses. gmail, slack, drive and salesforce are the Room's own connector tools; anything else
 * keeps a short readable name so a task can still ask for it ("snowflake", "ramp").
 */

const CANON: [string, RegExp][] = [
  ["gmail", /(^|-)(gmail|google-mail)(-|$)/],
  ["drive", /(^|-)(google-drive|gdrive|drive)(-|$)/],
  ["slack", /(^|-)slack(-|$)/],
  ["salesforce", /(^|-)(salesforce|sfdc)(-|$)/],
  ["snowflake", /(^|-)snowflake(-|$)/],
  ["calendar", /(^|-)(google-calendar|gcal|calendar)(-|$)/],
  ["sheets", /(^|-)(google-sheets|sheets)(-|$)/],
  ["docs", /(^|-)(google-docs|gdocs)(-|$)/],
  ["github", /(^|-)github(-|$)/],
  ["gitlab", /(^|-)gitlab(-|$)/],
  ["linear", /(^|-)linear(-|$)/],
  ["notion", /(^|-)notion(-|$)/],
  ["jira", /(^|-)jira(-|$)/],
  ["confluence", /(^|-)confluence(-|$)/],
  ["hubspot", /(^|-)hubspot(-|$)/],
];

/** Connectors that hold business data a task might need. The rest (calendar, github...) are tools more than sources. */
export const DATA_SOURCE_IDS = new Set(["gmail", "drive", "slack", "salesforce", "snowflake", "sheets", "docs", "notion", "jira", "confluence", "hubspot", "calendar", "ramp", "sigma", "aleph", "zendesk", "stripe", "postgres", "bigquery", "sql"]);

/** Short kebab-case slug for any text. */
export function slugOf(s: string): string {
  return s.toLowerCase().replace(/^claude\.ai\s+/, "").replace(/\b(mcp|server|connector)\b/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** The Room's id for a connector or server name. */
export function canonicalConnector(name: string): string {
  const slug = slugOf(name);
  for (const [id, re] of CANON) if (re.test(slug)) return id;
  return slug;
}

/** Ids of the MCP servers an agent has, without the hub's own entry. Unreadable names are dropped. */
export function connectorsFrom(serverNames: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const n of serverNames) {
    const slug = slugOf(n);
    if (!slug || slug === "agent-room" || slug === "agentroom") continue;
    out.add(canonicalConnector(n));
  }
  return [...out].sort();
}

export const dataSourcesOf = (connectors: string[]): string[] => connectors.filter((c) => DATA_SOURCE_IDS.has(c));

export const emptyCapabilities = (): AgentCapabilities => ({ connectors: [], dataSources: [], skills: [], tools: [] });

/** Everything an agent has under a name: connectors, data sources and the owner's declarations. */
export function reachOf(c: AgentCapabilities | undefined): Set<string> {
  return new Set([...(c?.connectors ?? []), ...(c?.dataSources ?? []), ...(c?.declared ?? [])].map((x) => canonicalConnector(x)));
}

/** A need such as "Salesforce" or "google drive", as an id. */
export const normalizeNeed = (s: string): string => canonicalConnector(String(s));

/** True when the capabilities cover the need. A connector whose name merely contains the need (snowflake-cortex-analyst) counts. */
export function coversNeed(c: AgentCapabilities | undefined, need: string): boolean {
  const n = normalizeNeed(need);
  if (!n) return true;
  const reach = reachOf(c);
  if (reach.has(n)) return true;
  return [...reach].some((r) => r === n || r.startsWith(`${n}-`) || r.endsWith(`-${n}`) || r.includes(`-${n}-`));
}

/** Clean up a planner's list of needs: strings only, normalized, no duplicates, a handful at most. */
export function cleanNeeds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const n = normalizeNeed(x);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= 8) break;
  }
  return out;
}
