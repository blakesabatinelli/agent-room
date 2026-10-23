import { TOOLS } from "@agent-room/shared";
import { CONNECTOR_TOOLS, SENSITIVE, todayString, type Fm, type Level, type PolicyRule } from "./schema.js";

/**
 * Effective permissions (CONTROL.md section 3). Layers only tighten: a tool's level is the strictest of
 * what the platform grants, POLICY.md (defaults and rules), TOOLS.md room_allows and ROOM.md tools.
 * Off beats ask beats on.
 */

const RANK: Record<Level, number> = { on: 0, ask: 1, off: 2 };
export const strictest = (...ls: Level[]): Level => ls.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "on" as Level);
/** True when `a` lets more through than `b`. */
export const looser = (a: Level, b: Level) => RANK[a] < RANK[b];

type Policy = Fm<"policy"> | undefined;
type AgentTools = Fm<"tools"> | undefined;
type Room = Fm<"room"> | undefined;

export const EFFECT_LEVEL: Record<PolicyRule["effect"], Level> = { allow: "on", ask: "ask", deny: "off" };
export const levelEffect = (l: Level): PolicyRule["effect"] => (l === "on" ? "allow" : l === "ask" ? "ask" : "deny");

/** The level a tool has when nothing in POLICY.md says otherwise. */
export const catalogDefault = (tool: string): Level => (SENSITIVE.has(tool) ? "ask" : "on");

/** Scopes: `*`, or space-separated `agent:<id>` / `room:<slug>` / `goal:<id>` (4.2) tokens that must all match. */
export function scopeApplies(scope: string, agentId?: string, roomSlug?: string, goalId?: string): boolean {
  const s = scope.trim();
  if (s === "*" || s === "") return true;
  return s.split(/\s+/).every((tok) => {
    if (tok.startsWith("agent:")) return agentId !== undefined && tok.slice(6) === agentId;
    if (tok.startsWith("room:")) return roomSlug !== undefined && tok.slice(5) === roomSlug;
    if (tok.startsWith("goal:")) return goalId !== undefined && tok.slice(5) === goalId; // 4.2: a lease for one goal; tool levels never know the goal, so such a rule never changes them
    return false;
  });
}

/** Two scopes can both apply to the same agent and room. */
export function scopesOverlap(a: string, b: string): boolean {
  const norm = (s: string) => (s.trim() === "" ? "*" : s.trim());
  const x = norm(a), y = norm(b);
  if (x === "*" || y === "*" || x === y) return true;
  const tx = new Map(x.split(/\s+/).map((t) => [t.split(":")[0], t]));
  const ty = new Map(y.split(/\s+/).map((t) => [t.split(":")[0], t]));
  for (const [k, v] of tx) if (ty.has(k) && ty.get(k) !== v) return false; // different agent or different room
  return true;
}

/** An accepted rule that has not expired. Learned rules wait for an explicit accept. */
export function ruleActive(r: PolicyRule, today: string): boolean {
  return r.accepted && !(r.expires && r.expires < today);
}

/**
 * POLICY.md level for a tool. Rules that cover everything about the tool (match `*`) beat the default;
 * several applicable rules resolve to the strictest. Rules that match specific actions are applied by the
 * approval path, not here.
 */
export function policyLevel(policy: Policy, tool: string, agentId?: string, roomSlug?: string, today = todayString(), ignoreRuleIds: ReadonlySet<string> = new Set()): Level {
  const rules = (policy?.rules ?? []).filter((r) => (r.tool === tool || r.tool === "*") && r.match === "*" && ruleActive(r, today)
    && scopeApplies(r.scope, agentId, roomSlug) && !ignoreRuleIds.has(r.id));
  if (rules.length) return strictest(...rules.map((r) => EFFECT_LEVEL[r.effect]));
  return policy?.defaults?.[tool] ?? catalogDefault(tool);
}

/** What the agent's platform grants. A platform that lists no connectors yet (discovery has not run) restricts nothing. */
export function platformLevel(tools: AgentTools, tool: string): Level {
  const connectors = tools?.platform?.connectors ?? [];
  if (!connectors.length || !CONNECTOR_TOOLS.has(tool)) return "on";
  return connectors.includes(tool) ? "on" : "off";
}

/** The owner's per-agent setting. A tool that is not listed is not allowed. */
export const roomAllowsLevel = (tools: AgentTools, tool: string): Level => tools?.room_allows?.[tool] ?? "off";

/** Everything except ROOM.md: what an agent may do anywhere. */
export function agentLevel(policy: Policy, tools: AgentTools, agentId: string, tool: string, today?: string, roomSlug?: string): Level {
  return strictest(platformLevel(tools, tool), policyLevel(policy, tool, agentId, roomSlug, today), roomAllowsLevel(tools, tool));
}

export interface Layers { policy?: Policy; tools?: AgentTools; room?: Room; today?: string }

/** Effective permission of every tool for one agent in one room. `room` undefined means no room layer. */
export function effectivePermissionsFrom(agentId: string, roomSlug: string | undefined, layers: Layers): Record<string, Level> {
  const names = new Set<string>([...TOOLS.map((t) => t.id), ...Object.keys(layers.tools?.room_allows ?? {}), ...Object.keys(layers.room?.tools ?? {})]);
  const out: Record<string, Level> = {};
  for (const tool of names) {
    const roomLevel: Level = layers.room?.tools?.[tool] ?? "on";
    out[tool] = strictest(agentLevel(layers.policy, layers.tools, agentId, tool, layers.today, roomSlug), roomLevel);
  }
  return out;
}
