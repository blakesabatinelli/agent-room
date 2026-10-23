import type { AgentConfig, Room } from "@agent-room/shared";
import { TOOLS } from "@agent-room/shared";
import { editFrontMatter, emitFile, seqNode, splitDoc } from "./parse.js";
import { agentLevel, catalogDefault, levelEffect, policyLevel, strictest } from "./permissions.js";
import { SCHEMA_VERSION, SENSITIVE, type Fm, type Level } from "./schema.js";
import { slugify } from "../library/library.js";

/**
 * How the Store's agents and rooms map to control files and back.
 * Files win when they change; the app's edits are written to the files first (CONTROL.md section 6).
 */

export const ROOM_SLUG_MAX = 60;
export const roomSlug = (r: Pick<Room, "name">) => slugify(r.name, ROOM_SLUG_MAX, "room");

// ---- permissions: Store view (tools + autoApprove) <-> file view (levels)

/** What the Store says about one tool, as a level: off, ask (sensitive, asks first), on. */
export function desiredLevel(a: AgentConfig, tool: string): Level {
  if (!a.tools?.[tool]) return "off";
  if (SENSITIVE.has(tool)) return a.autoApprove?.[tool] ? "on" : "ask";
  return "on";
}

/** Levels collapse to the three things the app can express: off, asks first, runs. Non-sensitive tools only know off and on. */
export const storeClass = (level: Level, tool: string): Level => (level === "off" ? "off" : SENSITIVE.has(tool) ? (level === "on" ? "on" : "ask") : "on");

export function toolNames(a: AgentConfig | undefined, tools?: Fm<"tools">): string[] {
  return [...new Set([...TOOLS.map((t) => t.id), ...Object.keys(a?.tools ?? {}), ...Object.keys(tools?.room_allows ?? {})])];
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** The parts of an agent the control files own, in a comparable form. */
export function normalizeAgent(a: AgentConfig): string {
  const tools: Record<string, boolean> = {}; const auto: string[] = [];
  for (const [k, v] of Object.entries(a.tools ?? {})) {
    tools[k] = !!v;
    if (v && SENSITIVE.has(k) && a.autoApprove?.[k]) auto.push(k);
  }
  return stable({
    name: a.name, color: a.color.toLowerCase(), provider: a.provider, adapter: a.adapter, enabled: !!a.enabled,
    model: (a.settings?.model as string | undefined) || null, binary: (a.settings?.binary as string | undefined) || null,
    profiles: a.profiles ?? [], tools, auto: auto.sort(),
  });
}

/** The agent as the control files describe it. `base` keeps everything the files don't own (other settings, orchestrator flag). */
export function agentFromFiles(
  base: AgentConfig | undefined, id: string,
  soul: Fm<"soul"> | undefined, tools: Fm<"tools"> | undefined, policy: Fm<"policy"> | undefined, today?: string,
): AgentConfig | undefined {
  if (!base && !(soul && tools)) return undefined;
  const next: AgentConfig = base ? { ...base, settings: { ...base.settings }, tools: {}, autoApprove: undefined } : {
    id, name: id, provider: "custom", adapter: "mock", enabled: false, color: "#5e6875", settings: {}, tools: {},
  };
  if (soul) { next.name = soul.name; next.color = soul.color; }
  if (tools) {
    const rt = tools.runtime;
    next.adapter = rt.adapter; next.provider = rt.provider; next.enabled = rt.enabled;
    if (rt.model) next.settings.model = rt.model; else delete next.settings.model;
    if (rt.binary) next.settings.binary = rt.binary; else delete next.settings.binary;
    if (rt.profiles?.length) next.profiles = rt.profiles as AgentConfig["profiles"]; else delete next.profiles;
    const auto: Record<string, boolean> = {};
    for (const tool of toolNames(base, tools)) {
      const lvl = agentLevel(policy, tools, id, tool, today);
      next.tools[tool] = lvl !== "off";
      if (SENSITIVE.has(tool) && lvl === "on") auto[tool] = true;
    }
    if (Object.keys(auto).length) next.autoApprove = auto;
  } else {
    next.tools = { ...(base?.tools ?? {}) };
    if (base?.autoApprove) next.autoApprove = { ...base.autoApprove };
  }
  if (!next.autoApprove) delete next.autoApprove;
  return next;
}

// ---- managed policy rules: the app's "run without asking" has to be a rule, because layers only tighten

export const managedRuleId = (agentId: string, tool: string) => `app-${agentId}-${tool}`;
const isManaged = (id: string) => id.startsWith("app-");

/**
 * The rule (or none) that makes POLICY.md agree with what the owner chose in the app. A rule is needed only when
 * the policy is stricter than the choice; room_allows alone can tighten a looser policy.
 */
export function managedRule(policy: Fm<"policy"> | undefined, a: AgentConfig, tool: string, want: Level, today?: string) {
  const id = managedRuleId(a.id, tool);
  const without = policyLevel(policy, tool, a.id, undefined, today, new Set([id]));
  if (want === "off" || strictest(without, want) === want) return { id, rule: null };
  return { id, rule: { id, effect: levelEffect(want), tool, match: "*", scope: `agent:${a.id}`, source: "owner" as const, accepted: true } };
}

// ---- generated files

const today0 = () => new Date().toISOString().slice(0, 10);
const head = (kind: string, by: string, today: string) => ({ kind, schema: SCHEMA_VERSION, updated: today, updated_by: by });

export function agentsMd(by = "hub", today = today0()): string {
  return emitFile({ ...head("agents", by, today), hard_limits: ["no-external-email-without-approval", "no-secrets-in-files"] },
    `# Rules for every agent

These apply in every room. Agents can read this file but never change it.

- Do the task you were given. If something else needs doing, say so instead of doing it.
- Say what you are unsure of. Don't present a guess as a fact.
- Keep work inside the task's folder. Ask before touching anything else.
- Short and plain beats long and clever.
`);
}

export function userMd(name: string, timezone: string, by = "hub", today = today0()): string {
  return emitFile({ ...head("user", by, today), name, timezone },
    `# About ${name}

Write how you like to work and what you expect from agents here. Every agent reads it.
`);
}

export function soulMd(a: AgentConfig, by = "hub", today = today0()): string {
  return emitFile({
    ...head("soul", by, today), name: a.name, color: a.color,
    role: a.canBeOrchestrator ? "Plans, routes and does the work" : "Does the work it is given",
    tone: "Plain, direct and brief",
  }, `# ${a.name}

Describe this agent's voice here. It shapes how the agent writes in the room and is left out when its work is judged.
`);
}

export function toolsMd(a: AgentConfig, by = "hub", today = today0()): string {
  const runtime: Record<string, unknown> = { adapter: a.adapter, provider: a.provider, enabled: !!a.enabled };
  if (a.settings?.binary) runtime.binary = a.settings.binary;
  if (a.settings?.model) runtime.model = a.settings.model;
  if (a.profiles?.length) runtime.profiles = a.profiles;
  const room_allows: Record<string, Level> = {};
  for (const tool of toolNames(a)) room_allows[tool] = desiredLevel(a, tool);
  return emitFile({
    ...head("tools", by, today), runtime, platform: { connectors: [], data_sources: [], skills: [] }, room_allows,
  }, `# How ${a.name} runs

\`room_allows\` is what you let this agent use: on, ask (it asks you first) or off. A room or POLICY.md can narrow it, never widen it.
`);
}

export function roomMd(r: Room, roster: string[], by = "hub", today = today0()): string {
  return emitFile({
    ...head("room", by, today), name: r.name, roster, tools: {}, folders: [], in_scope: [], out_of_scope: [],
  }, `${r.topic ?? ""}\n`);
}

export function policyMd(agents: AgentConfig[], by = "hub", today = today0()): string {
  const defaults: Record<string, Level> = {};
  for (const t of TOOLS) defaults[t.id] = catalogDefault(t.id);
  const doc = { ...head("policy", by, today), defaults, rules: [] as unknown[] };
  const probe = doc as unknown as Fm<"policy">;
  for (const a of agents) for (const tool of toolNames(a)) {
    const m = managedRule(probe, a, tool, desiredLevel(a, tool));
    if (m.rule) doc.rules.push(m.rule);
  }
  return emitFile(doc, `# Approval rules

\`defaults\` set how each tool behaves for everyone: on, ask or off. A rule can change that for one agent or room. Rules the app makes start with \`app-\`.
`);
}

// ---- patching existing files from the Store (app -> file)

const touch = (doc: import("yaml").Document, by: string, today: string) => { doc.set("updated", today); doc.set("updated_by", by); };

export function patchSoul(text: string, a: AgentConfig, by: string, today: string): string {
  return editFrontMatter(text, (doc) => {
    let changed = false;
    if (doc.get("name") !== a.name) { doc.set("name", a.name); changed = true; }
    if (String(doc.get("color")).toLowerCase() !== a.color.toLowerCase()) { doc.set("color", a.color); changed = true; }
    if (changed) touch(doc, by, today);
  });
}

export function patchTools(text: string, a: AgentConfig, levels: Record<string, Level>, by: string, today: string): string {
  return editFrontMatter(text, (doc) => {
    let changed = false;
    const setScalar = (path: string[], v: unknown) => {
      if (v === undefined || v === "") { if (doc.hasIn(path)) { doc.deleteIn(path); changed = true; } }
      else if (doc.getIn(path) !== v) { doc.setIn(path, v); changed = true; }
    };
    setScalar(["runtime", "adapter"], a.adapter);
    setScalar(["runtime", "provider"], a.provider);
    setScalar(["runtime", "enabled"], !!a.enabled);
    setScalar(["runtime", "model"], (a.settings?.model as string | undefined) || undefined);
    setScalar(["runtime", "binary"], (a.settings?.binary as string | undefined) || undefined);
    const cur = (doc.getIn(["runtime", "profiles"]) as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? [];
    if (stable(cur) !== stable(a.profiles ?? [])) {
      if (a.profiles?.length) doc.setIn(["runtime", "profiles"], doc.createNode(a.profiles)); else doc.deleteIn(["runtime", "profiles"]);
      changed = true;
    }
    for (const [tool, lvl] of Object.entries(levels)) {
      if (doc.getIn(["room_allows", tool]) !== lvl) { doc.setIn(["room_allows", tool], lvl); changed = true; }
    }
    if (changed) touch(doc, by, today);
  });
}

export function patchPolicy(text: string, ops: { id: string; rule: Record<string, unknown> | null }[], by: string, today: string): string {
  return editFrontMatter(text, (doc) => {
    let changed = false;
    for (const op of ops) {
      if (!isManaged(op.id)) continue;
      const seq = doc.get("rules") as { items: { get(k: string): unknown; toJSON(): Record<string, unknown> }[]; flow?: boolean; add(v: unknown): void } | undefined;
      const idx = seq?.items.findIndex((it) => it.get?.("id") === op.id) ?? -1;
      if (!op.rule) {
        if (idx >= 0) { doc.deleteIn(["rules", idx]); changed = true; }
      } else if (idx >= 0) {
        if (stable(seq!.items[idx].toJSON()) !== stable(op.rule)) { doc.setIn(["rules", idx], doc.createNode(op.rule)); changed = true; }
      } else {
        if (!seq) doc.set("rules", seqNode(doc, []));
        const s = doc.get("rules") as { flow?: boolean; add(v: unknown): void };
        s.flow = false; s.add(doc.createNode(op.rule)); changed = true;
      }
    }
    if (changed) touch(doc, by, today);
  });
}

// ---- rooms: the topic is the first line of the body

/** First non-empty line of the body, without a leading `#`. */
export function topicFromBody(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/^\s*#+\s*/, "").trim().slice(0, 250);
}

export function patchRoom(text: string, r: Room, by: string, today: string): string {
  const sp = splitDoc(text);
  if (sp.raw === null) throw new Error("no front matter");
  const want = (r.topic ?? "").trim();
  const topicChanged = topicFromBody(sp.body) !== want;
  let body = sp.body;
  if (topicChanged) {
    const lines = sp.body.split("\n");
    const i = lines.findIndex((l) => l.trim() !== "");
    if (i < 0) body = `${want}\n`;
    else if (want) { lines[i] = `${/^\s*#+\s*/.exec(lines[i])?.[0] ?? ""}${want}`; body = lines.join("\n"); }
    else { lines.splice(i, 1); body = lines.join("\n"); }
  }
  const withFm = editFrontMatter(text, (doc) => {
    let changed = topicChanged;
    if (doc.get("name") !== r.name) { doc.set("name", r.name); changed = true; }
    if (changed) touch(doc, by, today);
  });
  if (withFm === text && !topicChanged) return text;
  return `---\n${splitDoc(withFm).raw}\n---\n\n${body.replace(/^\n+/, "")}`;
}
