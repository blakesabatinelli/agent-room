import type { AgentConfig } from "@agent-room/shared";

/**
 * 4.4 Fork a goal: the pure parts. Reading the `/fork` line, splitting the agents into two rosters, and taking every agent, vendor
 * and model name out of the text the blind judges see.
 */

// ---------------------------------------------------------------- the /fork line

export interface ForkRequest { text?: string; rosterA?: string[]; rosterB?: string[] }

/**
 * `/fork <goal text> | rosterA: claude,codex | rosterB: hermes,muse`.
 * The goal text and the two roster parts can come in any order; every part after the first is `rosterA:`, `rosterB:` (or `a:`, `b:`).
 * Agents are named by id or name, with or without `@`, separated by commas or spaces. `/fork` alone forks the room's last goal.
 */
export function parseForkLine(line: string): { ok: true; req: ForkRequest } | { ok: false; error: string } {
  const body = line.trim().replace(/^\/fork\b/i, "").trim();
  const req: ForkRequest = {};
  const text: string[] = [];
  for (const part of body.split("|")) {
    const m = /^\s*(?:roster\s*)?([ab])\s*[:=]\s*([\s\S]*)$/i.exec(part);
    if (!m) { if (part.trim()) text.push(part.trim()); continue; }
    const names = m[2].split(/[\s,]+/).map((x) => x.replace(/^@/, "").trim()).filter(Boolean);
    if (!names.length) return { ok: false, error: `Roster ${m[1].toUpperCase()} is empty. Name at least one agent, like "roster${m[1].toUpperCase()}: claude,codex".` };
    const key = m[1].toLowerCase() === "a" ? "rosterA" : "rosterB";
    if (req[key]) return { ok: false, error: `Roster ${m[1].toUpperCase()} is given twice.` };
    req[key] = names;
  }
  if (text.length) req.text = text.join(" | ");
  return { ok: true, req };
}

/** Agent ids for the names a roster was given with (id or name, any case). Unknown names are returned apart. */
export function resolveRoster(names: string[], agents: AgentConfig[]): { ids: string[]; unknown: string[] } {
  const ids: string[] = [], unknown: string[] = [];
  for (const n of names) {
    const k = n.toLowerCase();
    const a = agents.find((x) => x.id.toLowerCase() === k) ?? agents.find((x) => x.name.toLowerCase() === k) ?? agents.find((x) => x.name.toLowerCase().split(/\s+/)[0] === k);
    if (!a) unknown.push(n);
    else if (!ids.includes(a.id)) ids.push(a.id);
  }
  return { ids, unknown };
}

// ---------------------------------------------------------------- the default split

/**
 * Two rosters from the agents that are ready: different vendors on each side where possible. Whole model families stay together
 * (largest first, each to the side with fewer agents so far); with only one family its agents are dealt out in turn.
 * Needs at least two agents.
 */
export function defaultSplit(agents: AgentConfig[], familyOf: (a: AgentConfig) => string): { a: string[]; b: string[] } | { error: string } {
  if (agents.length < 2) return { error: agents.length ? "Only one agent is available, and a fork needs two rosters. Switch another agent on, or name the rosters yourself." : "No agents are connected right now." };
  const families = new Map<string, AgentConfig[]>();
  for (const x of agents) families.set(familyOf(x), [...(families.get(familyOf(x)) ?? []), x]);
  const a: string[] = [], b: string[] = [];
  if (families.size === 1) agents.forEach((x, i) => (i % 2 ? b : a).push(x.id));
  else {
    const order = [...families.values()].map((g, i) => ({ g, i })).sort((p, q) => q.g.length - p.g.length || p.i - q.i);
    for (const { g } of order) { const side = a.length <= b.length ? a : b; side.push(...g.map((x) => x.id)); }
    if (!b.length) b.push(a.pop()!); // one family took everything on its own: still two rosters
  }
  return { a, b };
}

// ---------------------------------------------------------------- blind text

/** Words that give away a vendor or model, on top of the agents' own names. */
const VENDOR_WORDS = ["anthropic", "openai", "claude", "codex", "chatgpt", "gpt", "gemini", "hermes", "nous", "muse", "llama", "opus", "sonnet", "haiku", "qwen", "bonsai"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A function that replaces every agent name, id, provider, model name and vendor word with a neutral marker, so a judge can't tell
 * who wrote a candidate. It runs over the whole text the judges get (summary, file paths, file contents, documents).
 */
export function scrubber(agents: AgentConfig[]): (text: string) => string {
  const words = new Set<string>(VENDOR_WORDS);
  for (const a of agents) {
    for (const w of [a.name, a.id, a.provider, a.name.split(/\s+/)[0], typeof a.settings?.model === "string" ? a.settings.model : ""]) if (w && w.trim().length >= 3) words.add(w.trim().toLowerCase());
    for (const p of a.profiles ?? []) if (p.model && p.model.length >= 3) words.add(p.model.toLowerCase());
  }
  const list = [...words].sort((x, y) => y.length - x.length).map(esc);
  if (!list.length) return (t) => t;
  const re = new RegExp(`(?<![\\w])@?(?:${list.join("|")})(?![\\w])`, "gi");
  return (text) => text.replace(re, "[agent]");
}

/** `agent-room/<target>-a`: the side's own branch in the owner's repository. */
export const sideBranch = (target: string, side: "a" | "b") => `agent-room/${target}-${side}`;
