import { createHash } from "node:crypto";
import type { MemoryEntry, MemorySource } from "@agent-room/shared";
import { parseFacts } from "../control/facts.js";
import { editFrontMatter, emitFile, replaceBody, splitDoc } from "../control/parse.js";
import { dateOf } from "./model.js";

/**
 * 2.5: the MEMORY.md files (CONTROL.md sections 2 and 5). One fact per bullet:
 *   `- <fact> — source: <goal id | owner | agent:<id>>, expires: YYYY-MM-DD`
 * The database renders into these files and the owner's edits come back from them. The merge keeps everything the owner wrote
 * that isn't a fact line (headings, prose) and every fact line that is still right exactly as they typed it.
 */

export const sha = (s: string) => createHash("sha1").update(s).digest("hex");
export const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Same fact, however it was spaced, cased or punctuated. */
export const normText = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}:]+/gu, " ").replace(/\s+/g, " ").trim();
/** One line, and nothing that would read as the `— source:` tail. */
export const oneLine = (t: string) => t.replace(/\s+/g, " ").replace(/\s+[—–]\s+source:/gi, " - source:").trim();

/** How a source reads in a file. A goal is its id, the owner is `owner`, an agent with no goal is `agent:<id>`. */
export function sourceLabel(s: MemorySource): string {
  if (s.kind === "goal") return s.id || "goal";
  if (s.kind === "owner") return "owner";
  return `agent:${s.agentId || "unknown"}`;
}
/** The other way. No label means the owner typed the line, so the owner is the source. */
export function parseSourceLabel(label: string | undefined): Pick<MemorySource, "kind" | "id" | "agentId"> {
  const l = (label ?? "").trim();
  if (!l || l.toLowerCase() === "owner") return { kind: "owner" };
  const a = /^agent:(.+)$/i.exec(l);
  if (a) return { kind: "agent", agentId: a[1].trim() };
  return { kind: "goal", id: l };
}
export const sameSource = (s: MemorySource, label: string | undefined) => sourceLabel(s) === sourceLabel({ ...parseSourceLabel(label), at: 0 });

export const factLine = (e: Pick<MemoryEntry, "text" | "source" | "expiresAt">) => `- ${oneLine(e.text)} — source: ${sourceLabel(e.source)}, expires: ${dateOf(e.expiresAt)}`;

const BULLET = /^\s*[-*]\s+\S/;

/** The file body with its fact lines brought in line with `desired`; everything else stays as it is. Returns the same string when nothing changes. */
export function mergeBody(body: string, desired: Map<string, { e: MemoryEntry; line: string }>): string {
  const out: string[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!BULLET.test(line)) { out.push(raw); continue; }
    const f = parseFacts(line, 1)[0];
    const key = f ? normText(f.text) : "";
    const d = desired.get(key);
    if (!d || seen.has(key)) { changed = true; continue; } // not (or no longer) a live fact, or a repeat
    seen.add(key);
    if (f.source !== undefined && sameSource(d.e.source, f.source) && f.expires === dateOf(d.e.expiresAt)) out.push(raw);
    else { out.push(d.line); changed = true; }
  }
  const added = [...desired].filter(([k]) => !seen.has(k)).map(([, d]) => d.line);
  if (!changed && !added.length) return body;
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return [...out, ...added].join("\n") + "\n";
}

export interface BuildOptions { kind: "room-memory" | "agent-memory"; updatedBy: string; today: string; capBytes: number }
export interface Built {
  /** The new file text; undefined when there is nothing to write (no file and no facts). */
  text: string | undefined;
  /** Facts that are in the file now. */
  ids: string[];
  /** Facts left out to stay under the cap (lowest confidence first). They stay in the database. */
  dropped: string[];
}

const body0 = (cur: string) => splitDoc(cur).body;
/** What the loaded body of a file hashes to; the same on both sides of a write. */
export const bodyHash = (text: string) => sha(body0(text));

/**
 * Bring a MEMORY.md in line with `entries` (the live facts, oldest first). Over the cap, the lowest-confidence facts go first
 * (CONTROL.md section 5; expired facts were never in `entries`). `cur` is the file as it is, or undefined when there is none.
 */
export function buildMemoryFile(cur: string | undefined, entries: MemoryEntry[], o: BuildOptions): Built {
  const keep = [...entries];
  const dropped: string[] = [];
  const compose = (list: MemoryEntry[]): string | undefined => {
    const desired = new Map<string, { e: MemoryEntry; line: string }>();
    for (const e of list) { const k = normText(e.text); if (k && !desired.has(k)) desired.set(k, { e, line: factLine(e) }); }
    if (cur === undefined) {
      if (!desired.size) return undefined;
      return emitFile({ kind: o.kind, schema: 1, updated: o.today, updated_by: o.updatedBy }, `${[...desired.values()].map((d) => d.line).join("\n")}\n`);
    }
    const sp = splitDoc(cur);
    const merged = mergeBody(sp.body, desired);
    if (merged === sp.body) return cur;
    return editFrontMatter(replaceBody(cur, merged), (doc) => { doc.set("updated", o.today); doc.set("updated_by", o.updatedBy); });
  };
  let text = compose(keep);
  while (text !== undefined && bytes(text) > o.capBytes && keep.length) {
    // lowest confidence first, then the oldest
    let worst = 0;
    keep.forEach((e, i) => { const w = keep[worst]; if (e.confidence < w.confidence || (e.confidence === w.confidence && e.createdAt < w.createdAt)) worst = i; });
    dropped.push(keep.splice(worst, 1)[0].id);
    text = compose(keep);
  }
  // two entries with the same wording share one line; only the first is "in the file"
  const lines = new Set<string>(); const ids: string[] = [];
  for (const e of keep) { const k = normText(e.text); if (k && !lines.has(k)) { lines.add(k); ids.push(e.id); } }
  return { text, ids, dropped };
}
