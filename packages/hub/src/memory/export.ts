import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentConfig, MemoryEntry, MemoryExportInfo } from "@agent-room/shared";
import { MEMORY_EXPORT_BYTES_DEFAULT } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { bytes, normText, oneLine } from "./format.js";
import { dateOf, isLive } from "./model.js";

/**
 * 2.5 export (PRODUCT.md 6.8, "memory goes back out to the agents"): the room's unexpired shared memory, compiled into the
 * agent's own context file as one block between two markers. Nothing outside the markers is ever touched.
 *
 * The owner hand-writes these files and has fought context bloat, so this is OFF for every agent until
 * `agent.settings.memoryExport === true`, and it is capped (setting `memoryExportBytes`, default 4 KB).
 *
 * Where each agent reads its own memory (cited from the vendors' docs):
 *  - Claude Code: `~/.claude/CLAUDE.md` (user memory; `$CLAUDE_CONFIG_DIR` moves the folder)  https://docs.claude.com/en/docs/claude-code/memory
 *  - Codex: `~/.codex/AGENTS.md` (global instructions; `$CODEX_HOME` moves the folder; `AGENTS.override.md` there wins when it has content)  https://learn.chatgpt.com/docs/agent-configuration/agents-md
 *  - Hermes: `~/.hermes/memories/MEMORY.md` (`$HERMES_HOME` moves the folder; its own notes, limited to 2,200 characters in all)  https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
 * Agents we know no such file for (Muse, custom agents) get no export.
 */

export const BEGIN = "<!-- agent-room:memory:begin -->";
export const END = "<!-- agent-room:memory:end -->";
const HEADER = "## Shared memory from Agent Room (rewritten automatically; change it in Agent Room, not here)";

export interface ExportEnv { home: string; vars: Record<string, string | undefined> }
export interface ExportTarget {
  agentId: string; label: string; path: string;
  /** The vendor's own limit on the whole file, in characters (Hermes). */
  limitChars?: number;
  /** A sentence to show beside the switch. */
  caution?: string;
}

/** When a fact was last learned or confirmed. */
const recency = (e: MemoryEntry) => Math.max(e.createdAt, e.source?.at ?? 0);
const dirFrom = (v: string | undefined, fallback: string) => (v?.trim() || fallback).replace(/\/+$/, "");

export function targetFor(agentId: string, env: ExportEnv): ExportTarget | undefined {
  switch (agentId) {
    case "claude": return { agentId, label: "Claude Code", path: join(dirFrom(env.vars.CLAUDE_CONFIG_DIR, join(env.home, ".claude")), "CLAUDE.md") };
    case "codex": {
      const dir = dirFrom(env.vars.CODEX_HOME, join(env.home, ".codex"));
      return { agentId, label: "Codex", path: join(dir, "AGENTS.md"), caution: existsNonEmpty(join(dir, "AGENTS.override.md")) ? "Codex reads AGENTS.override.md in that folder instead while it has content." : undefined };
    }
    case "hermes": return {
      agentId, label: "Hermes", path: join(dirFrom(env.vars.HERMES_HOME, join(env.home, ".hermes")), "memories", "MEMORY.md"), limitChars: 2200,
      caution: "Hermes keeps its own notes in this file and limits it to 2,200 characters in all.",
    };
    default: return undefined;
  }
}
function existsNonEmpty(p: string) { try { return statSync(p).size > 0; } catch { return false; } }

export interface ExportResult {
  agentId: string;
  status: "written" | "unchanged" | "removed" | "skipped" | "off" | "unsupported";
  detail: string;
  facts?: number;
  bytes?: number;
}

export interface ExporterOptions {
  env: ExportEnv;
  /** Where the first-time copy of an agent's original file goes. */
  backupDir: string;
  /** Rooms the agent is in, by room id. Global memory is always included. */
  roomsOf: (agentId: string) => Set<string>;
  now?: () => number;
}

interface Located { start: number; end: number }
/** The block's place in a file, "none", or "damaged" when the markers are unpaired, out of order or repeated. */
export function locate(text: string): Located | "none" | "damaged" {
  const count = (s: string) => text.split(s).length - 1;
  const b = count(BEGIN), e = count(END);
  if (b === 0 && e === 0) return "none";
  if (b !== 1 || e !== 1) return "damaged";
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  return start < end ? { start, end: end + END.length } : "damaged";
}

/** The file with `block` (lines, no trailing newline) in place of the old one, appended when there was none, or taken out when null. Only bytes inside the markers (and the one separator we added) change. */
export function applyBlock(text: string, block: string[] | null): string | "damaged" {
  const loc = locate(text);
  if (loc === "damaged") return "damaged";
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  if (block === null) {
    if (loc === "none") return text;
    let before = text.slice(0, loc.start), after = text.slice(loc.end);
    if (after.startsWith(nl)) after = after.slice(nl.length);
    if (before.endsWith(nl + nl)) before = before.slice(0, -nl.length);
    return before + after;
  }
  const b = block.join(nl);
  if (loc !== "none") return text.slice(0, loc.start) + b + text.slice(loc.end);
  if (text === "") return b + nl;
  return text + (text.endsWith("\n") ? nl : nl + nl) + b + nl;
}

export class MemoryExporter {
  private now: () => number;
  constructor(private store: Store, private o: ExporterOptions) { this.now = o.now ?? Date.now; }

  private cap(): number {
    const n = this.store.getSettings().memoryExportBytes;
    return typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 512), 64 * 1024) : MEMORY_EXPORT_BYTES_DEFAULT;
  }
  private show(p: string) { return this.o.env.home && p.startsWith(this.o.env.home + "/") ? `~${p.slice(this.o.env.home.length)}` : p; }
  private state(): Record<string, { path: string; at: number }> { return this.store.getKV("memory.export", {}); }

  info(agent: AgentConfig): MemoryExportInfo {
    const t = targetFor(agent.id, this.o.env);
    const enabled = agent.settings?.memoryExport === true;
    if (!t) return { agentId: agent.id, supported: false, enabled: false };
    const notes = [t.caution];
    if (!existsSync(dirname(t.path))) notes.push(`${this.show(dirname(t.path))} doesn't exist yet, so nothing is written until it does.`);
    return {
      agentId: agent.id, supported: true, file: this.show(t.path), enabled,
      capBytes: Math.min(this.cap(), t.limitChars ?? Infinity),
      note: notes.filter(Boolean).join(" ") || undefined, lastWrittenAt: this.state()[agent.id]?.at,
    };
  }

  /** The facts one agent carries: unexpired shared memory of its rooms and the global kind, highest confidence then newest first. */
  factsFor(agentId: string): MemoryEntry[] {
    const rooms = this.o.roomsOf(agentId);
    const at = this.now();
    const seen = new Set<string>();
    return this.store.allMemory()
      .filter((e) => e.scope === "shared" && isLive(e, at) && (!e.roomId || rooms.has(e.roomId)))
      .sort((a, b) => b.confidence - a.confidence || recency(b) - recency(a) || a.id.localeCompare(b.id))
      .filter((e) => { const k = normText(e.text); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  }

  /** The block's lines, fitting `cap` bytes, or null when no fact fits. */
  buildBlock(facts: MemoryEntry[], cap: number): { lines: string[]; shown: number } | null {
    const render = (lines: string[], omitted: number) => [BEGIN, HEADER, ...lines, ...(omitted ? [`<!-- ${omitted} more not shown: over the ${cap} byte cap -->`] : []), END];
    const lines: string[] = [];
    for (const f of facts) {
      const text = oneLine(f.text);
      const line = `- ${text.length > 300 ? `${text.slice(0, 297)}...` : text} (until ${dateOf(f.expiresAt)})`;
      const next = [...lines, line];
      if (bytes(render(next, facts.length - next.length).join("\n")) > cap) break;
      lines.push(line);
    }
    return lines.length ? { lines: render(lines, facts.length - lines.length), shown: lines.length } : null;
  }

  syncAll(agents: AgentConfig[]): ExportResult[] {
    const out: ExportResult[] = [];
    for (const a of agents) { const r = this.sync(a); if (r.status !== "unsupported" && r.status !== "off") out.push(r); }
    return out;
  }

  sync(agent: AgentConfig): ExportResult {
    const target = targetFor(agent.id, this.o.env);
    if (!target) return { agentId: agent.id, status: "unsupported", detail: "No context file known for this agent." };
    const on = agent.settings?.memoryExport === true;
    const st = this.state();
    try {
      if (!on) return st[agent.id] ? this.remove(agent, target) : { agentId: agent.id, status: "off", detail: "Export is off." };
      return this.write(agent, target);
    } catch (e) {
      const detail = `Couldn't update ${this.show(target.path)}: ${(e as Error).message}`;
      this.store.audit("orchestrator", "memory.export.failed", `${agent.id}: ${detail}`);
      return { agentId: agent.id, status: "skipped", detail };
    }
  }

  private read(path: string): { real: string; text: string | undefined } {
    let real = path;
    try { real = realpathSync(path); } catch { /* not there yet */ }
    try { return { real, text: readFileSync(real, "utf8") }; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { real, text: undefined };
      throw e;
    }
  }

  private write(agent: AgentConfig, t: ExportTarget): ExportResult {
    if (!existsSync(dirname(t.path))) return { agentId: agent.id, status: "skipped", detail: `${this.show(dirname(t.path))} doesn't exist, so ${t.label} isn't set up on this Mac.` };
    const { real, text } = this.read(t.path);
    const cur = text ?? "";
    const loc = locate(cur);
    if (loc === "damaged") {
      const detail = `The ${BEGIN} and ${END} lines in ${this.show(t.path)} are unpaired or repeated. Nothing was written. Fix or delete them and it will carry on.`;
      this.store.audit("orchestrator", "memory.export.skipped", `${agent.id}: markers damaged in ${this.show(t.path)}`);
      return { agentId: agent.id, status: "skipped", detail };
    }
    let cap = this.cap();
    if (t.limitChars) {
      // The whole file, ours and the agent's own notes, has to stay inside the vendor's limit.
      const without = loc === "none" ? cur : (applyBlock(cur, null) as string);
      cap = Math.min(cap, t.limitChars - without.length - 4);
    }
    const facts = this.factsFor(agent.id);
    const built = cap > 0 ? this.buildBlock(facts, cap) : null;
    const next = applyBlock(cur, built?.lines ?? null) as string;
    if (text !== undefined && next === cur) return { agentId: agent.id, status: "unchanged", detail: "Already up to date.", facts: built?.shown ?? 0 };
    if (text === undefined && !built) return { agentId: agent.id, status: "unchanged", detail: facts.length ? `Nothing fits in ${t.limitChars ? "what Hermes leaves" : "the cap"}.` : "No shared memory to export yet.", facts: 0 };
    if (text !== undefined && loc === "none") this.backupOnce(agent.id, real);
    this.atomic(real, next, text !== undefined);
    const st = this.state();
    if (built) st[agent.id] = { path: t.path, at: this.now() }; else delete st[agent.id];
    this.store.setKV("memory.export", st);
    this.store.audit("orchestrator", built ? "memory.export" : "memory.export.removed", built ? `${agent.id}: wrote ${built.shown} fact${built.shown === 1 ? "" : "s"} (${bytes(built.lines.join("\n"))} bytes) to ${this.show(t.path)}` : `${agent.id}: nothing left to share, took the block out of ${this.show(t.path)}`);
    return { agentId: agent.id, status: "written", detail: built ? `Wrote ${built.shown} fact${built.shown === 1 ? "" : "s"} to ${this.show(t.path)}.` : "Took the block out; nothing is left to share.", facts: built?.shown ?? 0, bytes: built ? bytes(built.lines.join("\n")) : 0 };
  }

  /** Export was switched off: take our block back out, once, and forget it. */
  private remove(agent: AgentConfig, t: ExportTarget): ExportResult {
    const st = this.state();
    const { real, text } = this.read(t.path);
    let status: ExportResult["status"] = "off", detail = "Export is off.";
    if (text !== undefined) {
      const next = applyBlock(text, null);
      if (next !== "damaged" && next !== text) {
        this.atomic(real, next, true);
        this.store.audit("orchestrator", "memory.export.removed", `${agent.id}: export switched off, took the block out of ${this.show(t.path)}`);
        status = "removed"; detail = `Took the block out of ${this.show(t.path)}.`;
      }
    }
    delete st[agent.id]; this.store.setKV("memory.export", st);
    return { agentId: agent.id, status, detail };
  }

  /** The agent's own file, as the owner left it, saved once before the first change. */
  private backupOnce(agentId: string, real: string) {
    const dest = join(this.o.backupDir, `${agentId}-${basename(real)}.original`);
    if (existsSync(dest)) return;
    mkdirSync(this.o.backupDir, { recursive: true });
    copyFileSync(real, dest, constants.COPYFILE_EXCL);
    this.store.audit("orchestrator", "memory.export.backup", `${agentId}: saved ${basename(real)} as ${dest}`);
  }

  /** Temp file then rename, keeping the file's permissions; a symlinked file is written through to what it points at. */
  private atomic(real: string, text: string, existed: boolean) {
    const tmp = join(dirname(real), `.${basename(real)}.agent-room-${process.pid}.tmp`);
    const mode = existed ? statSync(real).mode & 0o7777 : 0o644;
    writeFileSync(tmp, text, { mode });
    try { chmodSync(tmp, mode); renameSync(tmp, real); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  }
}
