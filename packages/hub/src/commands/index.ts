import type { CommandEntry, CommandGroup, CommandIndex, CommandKind, CommandMode, CommandRow, DiscoveryResult } from "@agent-room/shared";
import { defaultEnv, type DiscoveryEnv } from "../discovery/env.js";
import { readHermesConfig } from "../discovery/hermes.js";
import type { Store } from "../db/store.js";

/**
 * 2.6: one index of the commands every agent offers, built from what discovery (1.3) found on this Mac.
 * Names are `<agent id>:<slug>`, so an agent's command can never be mistaken for a room command (those have no prefix).
 */

/** Room commands: unprefixed, listed first in their own group. Agent commands can never shadow them. */
export const ROOM_COMMANDS: CommandRow[] = [
  { name: "pause", title: "Pause", description: "Pause all work in this room.", kind: "room" },
  { name: "resume", title: "Resume", description: "Pick paused work back up.", kind: "room" },
  { name: "stop", title: "Stop", description: "Stop all work in this room.", kind: "room" },
  { name: "fork", title: "Fork", description: "Branch this room into a new one.", kind: "room" },
  { name: "digest", title: "Digest", description: "Summarize what happened in this room.", kind: "room" },
  { name: "redirect", title: "Redirect", description: "Restart the running work with a change.", argsHint: "[@agent] what to change", kind: "room" },
  { name: "replan", title: "Replan", description: "Change direction and plan the rest again.", argsHint: "what to change", kind: "room" },
];
/** Words the room already treats as commands but doesn't list (plan answers, the goal prefix). Reserved so nothing shadows them. */
const RESERVED_ROOM = ["goal", "approve", "cancel"];
export const isRoomCommand = (name: string) => ROOM_COMMANDS.some((c) => c.name === name) || RESERVED_ROOM.includes(name);

const LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes" };
const MAX_PER_AGENT = 400;

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "command";
const titleOf = (native: string) => { const t = (native.split(":").pop() ?? native).replace(/[-_]+/g, " ").trim(); return t ? t[0].toUpperCase() + t.slice(1) : native; };
const oneLine = (s: string, n = 200) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };

/** Top-level `key: value` lines of a file's front matter (folded and literal blocks joined); the body after it. Never throws. */
export function frontMatter(text: string | undefined): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  if (!text) return { fm, body: "" };
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fm, body: text };
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(" ");
    } else v = v.replace(/^(["'])(.*)\1$/, "$2");
    fm[kv[1].toLowerCase()] = v;
  }
  return { fm, body: text.slice(m[0].length) };
}

/** Description: the front matter's, else the first line of text that isn't a heading. */
function describe(fm: Record<string, string>, body: string): string {
  if (fm.description) return oneLine(fm.description);
  for (const l of body.split(/\r?\n/)) { const t = l.trim(); if (t && !t.startsWith("#") && !t.startsWith("---")) return oneLine(t.replace(/^[-*>]\s*/, "")); }
  return "";
}

interface Raw { kind: CommandKind; native: string; /** the name without plugin or prompts: prefix */ local: string; description: string; argsHint?: string; source: string; mode: CommandMode; plugin?: string }

const isDir = (env: DiscoveryEnv, p: string) => env.isDir(p);
const skipName = (n: string) => n.startsWith(".") || n === "node_modules";

/** Every `<name>/SKILL.md` under a folder (a few levels down). */
function skillFiles(env: DiscoveryEnv, root: string, maxDepth: number): { dir: string; file: string }[] {
  const out: { dir: string; file: string }[] = [];
  const seen = { n: 0 };
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= MAX_PER_AGENT || seen.n++ > 4000) return;
    const names = env.listDir(dir);
    if (!names) return;
    if (depth > 0 && names.includes("SKILL.md")) { out.push({ dir, file: `${dir}/SKILL.md` }); return; }
    for (const n of [...names].sort()) if (!skipName(n) && isDir(env, `${dir}/${n}`)) walk(`${dir}/${n}`, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** `*.md` files in a folder, and in its subfolders when `nested` (Claude Code: `frontend/build.md` is `frontend:build`). */
function markdownFiles(env: DiscoveryEnv, root: string, nested: boolean): { rel: string[]; file: string }[] {
  const out: { rel: string[]; file: string }[] = [];
  const walk = (dir: string, rel: string[], depth: number) => {
    if (depth > 3 || out.length >= MAX_PER_AGENT) return;
    for (const n of [...(env.listDir(dir) ?? [])].sort()) {
      if (skipName(n)) continue;
      const p = `${dir}/${n}`;
      if (n.endsWith(".md")) out.push({ rel: [...rel, n.slice(0, -3)], file: p });
      else if (nested && isDir(env, p)) walk(p, [...rel, n], depth + 1);
    }
  };
  walk(root, [], 0);
  return out;
}

function skillRaw(env: DiscoveryEnv, s: { dir: string; file: string }, kind: CommandKind, mode: (fm: Record<string, string>) => CommandMode, plugin?: string): Raw {
  const { fm, body } = frontMatter(env.readFile(s.file));
  const base = fm.name?.trim() || s.dir.split("/").pop()!;
  return { kind, local: base, native: plugin ? `${plugin}:${base}` : base, description: describe(fm, body), argsHint: fm["argument-hint"] || undefined, source: s.file, mode: mode(fm), plugin };
}

/** Claude Code: ~/.claude/skills, ~/.claude/commands, and the skills and commands of installed plugins (~/.claude/plugins/cache). */
function claudeCommands(env: DiscoveryEnv): Raw[] {
  const out: Raw[] = [];
  // Docs (code.claude.com/docs/en/headless): in `claude -p`, "User-invoked skills and custom commands work. Include /skill-name in the prompt string."
  // A skill the model may not load by itself (disable-model-invocation: true) can only be reached that way; any other skill gets an explicit "Use the <skill> skill" instruction.
  const skillMode = (fm: Record<string, string>): CommandMode => (/^true$/i.test(fm["disable-model-invocation"] ?? "") ? "slash" : "instruction");
  for (const s of skillFiles(env, `${env.home}/.claude/skills`, 1)) out.push(skillRaw(env, s, "skill", skillMode));
  for (const f of markdownFiles(env, `${env.home}/.claude/commands`, true)) {
    const { fm, body } = frontMatter(env.readFile(f.file));
    out.push({ kind: "command", local: f.rel.join(":"), native: f.rel.join(":"), description: describe(fm, body), argsHint: fm["argument-hint"] || undefined, source: f.file, mode: "slash" });
  }
  // Plugins: a folder that holds `skills/` or `commands/`. Its name is from .claude-plugin/plugin.json, else the folder (above a version folder).
  const seen = { n: 0 };
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || seen.n++ > 3000) return;
    const names = env.listDir(dir) ?? [];
    const hasSkills = names.includes("skills") && isDir(env, `${dir}/skills`), hasCommands = names.includes("commands") && isDir(env, `${dir}/commands`);
    if (hasSkills || hasCommands) {
      const json = env.readFile(`${dir}/.claude-plugin/plugin.json`);
      let name: string | undefined;
      if (json) { try { const n = (JSON.parse(json) as { name?: unknown }).name; if (typeof n === "string" && n.trim()) name = n.trim(); } catch { /* not JSON */ } }
      const parts = dir.split("/");
      const last = parts[parts.length - 1];
      name ??= /^(v?\d[\w.+-]*|[0-9a-f]{7,40}|unknown)$/i.test(last) ? parts[parts.length - 2] : last;
      if (hasSkills) for (const s of skillFiles(env, `${dir}/skills`, 1)) out.push(skillRaw(env, s, "plugin-skill", () => "instruction", name));
      if (hasCommands) for (const f of markdownFiles(env, `${dir}/commands`, false)) {
        const { fm, body } = frontMatter(env.readFile(f.file));
        out.push({ kind: "command", local: f.rel.join(":"), native: `${name}:${f.rel.join(":")}`, description: describe(fm, body), argsHint: fm["argument-hint"] || undefined, source: f.file, mode: "slash", plugin: name });
      }
      return; // a plugin's own folders hold no more plugins
    }
    for (const n of [...names].sort().reverse()) if (!skipName(n) && isDir(env, `${dir}/${n}`)) walk(`${dir}/${n}`, depth + 1); // newest version folder first
  };
  walk(`${env.home}/.claude/plugins/cache`, 0);
  return out;
}

/** Codex: custom prompts (~/.codex/prompts/*.md, run as /prompts:<file>) and ~/.codex/skills. */
function codexCommands(env: DiscoveryEnv): Raw[] {
  const out: Raw[] = [];
  for (const f of markdownFiles(env, `${env.home}/.codex/prompts`, false)) {
    const { fm, body } = frontMatter(env.readFile(f.file));
    out.push({ kind: "prompt", local: f.rel[0], native: `prompts:${f.rel[0]}`, description: describe(fm, body), argsHint: fm["argument-hint"] || undefined, source: f.file, mode: "inline" });
  }
  for (const s of skillFiles(env, `${env.home}/.codex/skills`, 1)) out.push(skillRaw(env, s, "skill", () => "instruction"));
  return out;
}

/** Hermes: ~/.hermes/skills (or $HERMES_HOME) and `skills.external_dirs` from its config.yaml. */
function hermesCommands(env: DiscoveryEnv): Raw[] {
  const info = readHermesConfig(env);
  const out: Raw[] = [];
  for (const d of [`${info.home}/skills`, ...info.externalDirs]) for (const s of skillFiles(env, d, 4)) out.push(skillRaw(env, s, "skill", () => "instruction"));
  return out;
}

const SCANNERS: Record<string, (env: DiscoveryEnv) => Raw[]> = { claude: claudeCommands, codex: codexCommands, hermes: hermesCommands };

/**
 * Index the commands of every installed agent discovery knows how to read.
 * Slugs are unique within an agent: on a clash the first (in the order skill, command, prompt, plugin-skill, then by source) keeps the
 * plain name and the others get a suffix (their plugin or kind, then a number).
 */
export function buildCommandIndex(discovery: Pick<DiscoveryResult, "agents">, env: DiscoveryEnv = defaultEnv(), now = Date.now()): CommandIndex {
  const entries: CommandEntry[] = [];
  const agents: { id: string; label: string }[] = [];
  const order: Record<CommandKind, number> = { skill: 0, command: 1, prompt: 2, "plugin-skill": 3 };
  for (const a of discovery.agents) {
    const scan = SCANNERS[a.id];
    if (!scan || !a.installed) continue;
    // Not a namespace that could be read as a room command.
    const ns = slugify(a.id);
    if (isRoomCommand(ns)) continue;
    agents.push({ id: a.id, label: LABEL[a.id] ?? a.name });
    const raws = scan(env).sort((x, y) => order[x.kind] - order[y.kind] || x.source.localeCompare(y.source));
    const taken = new Set<string>();
    for (const r of raws) {
      const base = slugify(r.local);
      let slug = base;
      if (taken.has(slug)) slug = r.plugin ? slugify(`${r.plugin}-${base}`) : slugify(`${base}-${r.kind}`);
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
      taken.add(slug);
      entries.push({ name: `${ns}:${slug}`, agentId: a.id, kind: r.kind, title: titleOf(r.native), description: r.description, ...(r.argsHint ? { argsHint: r.argsHint } : {}), source: r.source, native: r.native, mode: r.mode });
    }
  }
  return { at: now, agents, entries };
}

/** The palette: Room first, then one group per agent that has commands. Local file paths stay out of it. */
export function commandGroups(index: CommandIndex): CommandGroup[] {
  const groups: CommandGroup[] = [{ id: "room", label: "Room", commands: ROOM_COMMANDS.map((c) => ({ ...c })) }];
  for (const a of index.agents) {
    const commands = index.entries.filter((e) => e.agentId === a.id).map((e): CommandRow => ({ name: e.name, title: e.title, description: e.description, ...(e.argsHint ? { argsHint: e.argsHint } : {}), kind: e.kind }));
    if (commands.length) groups.push({ id: a.id, label: a.label, commands });
  }
  return groups;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/**
 * For the planner: each agent's commands as `name (description)`, the ones that look most like the goal first, capped per agent
 * and in total so a big skill library can't swamp the prompt. "" when nobody has any.
 */
export function plannerCommands(index: CommandIndex, agentIds: string[], goal: string, o: { perAgent?: number; maxChars?: number } = {}): string {
  const perAgent = o.perAgent ?? 6, maxChars = o.maxChars ?? 1800;
  const want = words(goal);
  const lines: string[] = [];
  for (const id of agentIds) {
    const mine = index.entries.filter((e) => e.agentId === id).map((e) => {
      const w = words(`${e.name.split(":").pop()} ${e.title} ${e.description}`);
      let hit = 0; for (const x of w) if (want.has(x)) hit++;
      return { e, hit };
    }).sort((a, b) => b.hit - a.hit || Number(!!b.e.description) - Number(!!a.e.description) || a.e.name.localeCompare(b.e.name)).slice(0, perAgent);
    if (mine.length) lines.push(`* ${id} has ${mine.map(({ e }) => `/${e.name}${e.description ? ` (${oneLine(e.description, 70)})` : ""}`).join("; ")}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars).replace(/[^\n]*$/, "").trimEnd() : text;
}

// ---- the stored index (written when discovery runs, read by the orchestrator and the API)
const KEY = "command_index";
export const loadCommandIndex = (store: Store): CommandIndex => store.getKV<CommandIndex>(KEY, { at: 0, agents: [], entries: [] });
export function refreshCommandIndex(store: Store, discovery: Pick<DiscoveryResult, "agents">, env?: DiscoveryEnv): CommandIndex {
  const index = buildCommandIndex(discovery, env);
  store.setKV(KEY, index);
  return index;
}
