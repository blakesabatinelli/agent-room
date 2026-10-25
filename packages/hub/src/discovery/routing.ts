import { TOOLS, type AgentConfig, type Task } from "@agent-room/shared";
import type { ControlFolder } from "../control/folder.js";
import { canonicalConnector, coversNeed, reachOf } from "./connectors.js";
import { WORKSPACE_NEED, runsHere, whereText } from "../placement/index.js"; // "workspace" is a need too: only an agent that runs on this Mac can use the task folder
import { relayEligible } from "../placement/relay.js"; // save relay: a workspace task with no local command check can go to an off-machine agent, which hands the files back for a local step to save

/**
 * 1.3 (AC6): routing by capability. A task that needs a data source ("salesforce", "gmail", "snowflake") may only go to an
 * agent whose platform has it AND whose permission for it is on. Learned quality only decides among agents that can do the task.
 */

const ROOM_TOOLS = new Set(TOOLS.map((t) => t.id));

export interface NeedsGate {
  needs: string[];
  /** Enabled agents that cover every need. */
  ok: Set<string>;
  /** Every other enabled agent and what it lacks. */
  filteredOut: { agentId: string; missing: string[] }[];
  /** Needs that no enabled agent's platform has at all. */
  nobody: string[];
  /** Agents whose platform has a need but the owner (or a room or policy) has switched the tool off. */
  switchedOff: { agentId: string; need: string }[];
}

/** Can this agent use `need` right now? `has`: its platform reaches it. `allowed`: the tool, if the Room has one for it, is on. */
function check(a: AgentConfig, need: string, level: ((tool: string) => string | undefined) | undefined, relayWorkspace = false) {
  // 4.3 save relay: the task folder is normally only an agent that runs on this Mac; a relay-eligible workspace task also lets an off-machine agent take it (it hands the files back for a local save).
  if (need === WORKSPACE_NEED) return { has: runsHere(a) || relayWorkspace, allowed: true };
  const roomTool = ROOM_TOOLS.has(need);
  const allowed = !roomTool || (level ? level(need) !== "off" : !!a.tools?.[need]);
  // An agent discovery has never looked at: the owner's switch is all there is to go on for the Room's own connectors.
  const has = a.capabilities ? coversNeed(a.capabilities, need) : roomTool && !!a.tools?.[need];
  return { has, allowed };
}

/** undefined when the task needs nothing. `relay` (from routing to live agents): a workspace task with no local command check may also go to an off-machine agent. */
export function needsGate(task: Pick<Task, "needs" | "roomId"> & { criteria?: Task["criteria"] }, enabled: AgentConfig[], control?: ControlFolder, opts?: { relay?: boolean }): NeedsGate | undefined {
  const needs = (task.needs ?? []).map((n) => canonicalConnector(n)).filter(Boolean);
  if (!needs.length) return undefined;
  const relayWorkspace = !!opts?.relay && relayEligible(task); // this particular task can be saved from an off-machine agent's reply
  const slug = control?.slugFor(task.roomId);
  const ok = new Set<string>(), filteredOut: NeedsGate["filteredOut"] = [], switchedOff: NeedsGate["switchedOff"] = [];
  const hasAny = new Map<string, boolean>(needs.map((n) => [n, false]));
  for (const a of enabled) {
    const perms = control?.effectivePermissions(a.id, slug);
    const level = perms ? (t: string) => perms[t] : undefined;
    const missing: string[] = [];
    for (const n of needs) {
      const c = check(a, n, level, relayWorkspace);
      if (c.has) hasAny.set(n, true);
      if (c.has && !c.allowed) switchedOff.push({ agentId: a.id, need: n });
      if (!(c.has && c.allowed)) missing.push(n);
    }
    if (missing.length) filteredOut.push({ agentId: a.id, missing }); else ok.add(a.id);
  }
  return { needs, ok, filteredOut, nobody: needs.filter((n) => !hasAny.get(n)), switchedOff };
}

const nameOf = (agents: AgentConfig[], id: string) => agents.find((a) => a.id === id)?.name ?? id;
const label = (need: string) => TOOLS.find((t) => t.id === need)?.label ?? need.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** What the owner is told when no agent can take a task: which source, and what to do. One message, no silent fallback. */
export function needsMessage(gate: NeedsGate, taskTitle: string, agents: AgentConfig[]): string {
  const off = gate.switchedOff.filter((s) => !gate.nobody.includes(s.need));
  const parts: string[] = [];
  if (gate.nobody.includes(WORKSPACE_NEED)) parts.push(workspaceMessage(taskTitle, agents.filter((a) => !runsHere(a))));
  const sources = gate.nobody.filter((n) => n !== WORKSPACE_NEED);
  if (sources.length) {
    const what = sources.map(label).join(" and ");
    parts.push(`Nobody in the room can reach ${what}, which "${taskTitle}" needs. Connect it to one of your agents (for example as an MCP connector), then check again under Agents. This task waits until then.`);
  }
  if (off.length) {
    const lines = [...new Set(off.map((s) => `${nameOf(agents, s.agentId)} can reach ${label(s.need)}, but it is switched off for it`))];
    parts.push(`${lines.join(". ")}. Turn it on under Permissions and "${taskTitle}" goes ahead.`);
  }
  if (!parts.length) parts.push(`No agent can take "${taskTitle}" because of what it needs (${gate.needs.map(label).join(", ")}). This task waits.`);
  return parts.join("\n");
}

/** One plain line: the task works in its task folder and no agent that runs on this Mac can take it right now. */
export function workspaceMessage(taskTitle: string, elsewhere: AgentConfig[], why: "none" | "unavailable" = "none"): string {
  const away = elsewhere.length ? ` ${elsewhere.map((a) => `${a.name} runs on ${whereText(a)}`).join(", ")} and can't reach it.` : "";
  return why === "none"
    ? `"${taskTitle}" works in its task folder, and none of your agents that run on this Mac is switched on.${away} It waits until one is.`
    : `"${taskTitle}" works in its task folder, and none of the agents that run on this Mac is available right now.${away} It starts as soon as one is.`;
}

/** A line for the planner: what an agent can reach, so it can name the right owner. Empty when nothing is known. */
export function capabilityText(a: AgentConfig): string {
  const c = a.capabilities;
  if (!c) return "";
  const allowed = [...reachOf(c)].filter((n) => !ROOM_TOOLS.has(n) || a.tools?.[n]);
  const off = [...reachOf(c)].filter((n) => ROOM_TOOLS.has(n) && !a.tools?.[n]);
  const bits: string[] = [];
  if (allowed.length) bits.push(`can reach: ${allowed.join(", ")}`);
  if (off.length) bits.push(`has but switched off: ${off.join(", ")}`);
  return bits.length ? ` — ${bits.join("; ")}` : "";
}
