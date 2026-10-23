import { readFileSync } from "node:fs";
import type { CommandEntry, CommandIndex, TaskCommand } from "@agent-room/shared";
import { ROOM_COMMANDS, frontMatter, isRoomCommand } from "./index.js";

/**
 * 2.6: what the owner typed, and what to send the agent for it.
 *
 * `/pause`, `/stop`, `/redirect ...` (room commands) are never touched here. `/<agent>:<command> args` is looked up in the index.
 * Anything else that looks like a command but isn't one is "unknown": answered by the room, never sent to an agent.
 */
export type Parsed =
  | { kind: "none" }
  | { kind: "room"; name: string }
  | { kind: "agent"; entry: CommandEntry; args: string }
  | { kind: "unknown"; typed: string; suggestions: string[] };

/** A bare command word, optionally `namespace:name`. A path like /etc/hosts or a sentence starting with a slash is not one. */
const TOKEN = /^\/([a-z0-9][a-z0-9_.-]*(?::[a-z0-9_.:-]+)?)(?=\s|$)/i;

export function parseCommand(text: string, index: CommandIndex): Parsed {
  const t = text.trim();
  const m = TOKEN.exec(t);
  if (!m) return { kind: "none" };
  const typed = m[1].toLowerCase();
  if (isRoomCommand(typed)) return { kind: "room", name: typed }; // room commands win, always (AC3)
  const entry = index.entries.find((e) => e.name === typed);
  if (entry) return { kind: "agent", entry, args: t.slice(m[0].length).trim() };
  return { kind: "unknown", typed, suggestions: suggest(typed, index) };
}

/** Edit distance, capped: enough to catch a typo or a missing letter. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 4) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Up to five close matches, best first: same word inside, same ending, or a few letters off. Room commands count too. */
export function suggest(typed: string, index: CommandIndex, max = 5): string[] {
  const tail = typed.split(":").pop() ?? typed;
  const names = [...ROOM_COMMANDS.map((c) => c.name), ...index.entries.map((e) => e.name)];
  return names.map((n) => {
    const nt = n.split(":").pop() ?? n;
    let score = Math.min(distance(typed, n), distance(tail, nt) + (typed.includes(":") && !n.startsWith(typed.split(":")[0] + ":") ? 1 : 0));
    if (tail.length >= 3 && (nt.includes(tail) || tail.includes(nt))) score = Math.min(score, 1);
    if (!typed.includes(":") && n.includes(":")) score += 0.5; // a bare word is most likely a room command with a typo
    return { n, score };
  }).filter((x) => x.score <= 3).sort((a, b) => a.score - b.score || a.n.localeCompare(b.n)).slice(0, max).map((x) => x.n);
}

export const unknownReply = (p: Extract<Parsed, { kind: "unknown" }>) =>
  p.suggestions.length
    ? `There is no /${p.typed} command. Close matches: ${p.suggestions.map((s) => `/${s}`).join(", ")}. Type / to see them all.`
    : `There is no /${p.typed} command. Type / to see what is available.`;

// ---- building what the agent receives

/** Split arguments on spaces, keeping "quoted phrases" together; `KEY="a b"` stays one `KEY=a b` token. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/(?:([A-Za-z_]\w*)=)?(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g)) {
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    out.push(m[1] ? `${m[1]}=${val}` : val);
  }
  return out;
}

/**
 * Codex custom prompts, expanded the way Codex does (developers.openai.com/codex/custom-prompts):
 * `$1`..`$9` take the space-separated arguments, `$ARGUMENTS` is all of them, `$NAME` (upper case) is filled from `NAME=value`
 * pairs (quote values with spaces), and `$$` is a literal `$`. One pass, so a `$` inside an argument is never expanded again.
 */
export function expandCodexPrompt(content: string, args: string): string {
  const parts = splitArgs(args);
  const named = new Map<string, string>();
  for (const p of parts) { const m = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/.exec(p); if (m) named.set(m[1], m[2]); }
  return content.replace(/\$\$|\$ARGUMENTS\b|\$([1-9])|\$([A-Z][A-Z0-9_]*)/g, (all, d?: string, k?: string) =>
    all === "$$" ? "$" : all === "$ARGUMENTS" ? args : d ? parts[Number(d) - 1] ?? "" : named.get(k!) ?? "");
}

export interface Invocation { prompt: string; command: TaskCommand }

/**
 * The message for the agent, by how it supports commands:
 *  - Claude Code custom commands (and skills the model may not load itself): the prompt is `/<name> <args>`. Docs
 *    (code.claude.com/docs/en/headless, "Command support differs in -p mode"): "User-invoked skills and custom commands work.
 *    Include /skill-name in the prompt string and Claude Code expands it before running." It has to start the prompt, so nothing goes before it.
 *  - Other skills (Claude Code, Codex, Hermes): an explicit instruction to use that skill with the owner's arguments.
 *  - Codex prompts: the file's content with the arguments filled in, as `/prompts:<name>` would send it.
 */
export function buildInvocation(entry: CommandEntry, args: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): { ok: true; invocation: Invocation } | { ok: false; error: string } {
  const command: TaskCommand = { name: entry.name, agentId: entry.agentId, kind: entry.kind, mode: entry.mode, args };
  const ROOM = "\n\nYou are in a shared chat room with the owner and other AI agents. Put the result in your reply here.";
  if (entry.mode === "slash") return { ok: true, invocation: { prompt: `/${entry.native}${args ? ` ${args}` : ""}`, command } };
  if (entry.mode === "inline") {
    let text: string;
    try { text = read(entry.source); } catch { return { ok: false, error: `I couldn't read ${entry.name} (${entry.source}). Has the file moved?` }; }
    return { ok: true, invocation: { prompt: expandCodexPrompt(frontMatter(text).body.trim(), args) + ROOM, command } };
  }
  const line = entry.agentId === "hermes"
    ? `Run your ${entry.native} skill${args ? ` with: ${args}` : ""}`
    : `Use the ${entry.native} skill${args ? ` to handle this request: ${args}` : ""}`;
  return { ok: true, invocation: { prompt: `${line}.${ROOM}`, command } };
}
