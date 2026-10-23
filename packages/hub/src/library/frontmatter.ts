import type { DocFrontMatter, DocStatus } from "@agent-room/shared";

/**
 * Dependency-free YAML front matter for exactly the DocFrontMatter schema:
 * flat `key: value` lines, strings bare when safe and JSON double-quoted otherwise,
 * arrays inline as `[a, b]`.
 */

export const DOC_STATUSES: readonly DocStatus[] = ["draft", "review", "final", "superseded"]; // superseded: set by the hub (4.4), never by an agent (the MCP tool takes the first three)
const KEY_ORDER = ["id", "title", "room", "goal", "status", "authors", "created", "updated", "sources", "tags"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Letters, digits and a few joiners, single spaces inside. No `: `, `#`, quotes, commas or brackets.
const BARE = /^[A-Za-z0-9_][A-Za-z0-9_./@+-]*(?: [A-Za-z0-9_./@+-]+)*$/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~|[-+]?\d[\d_.eE+-]*)$/i;

/** One scalar, quoted only when a plain YAML reader could misread it. */
export function emitScalar(s: string): string {
  return BARE.test(s) && !RESERVED.test(s) ? s : JSON.stringify(s);
}
function emitDate(s: string) { return DATE.test(s) ? s : JSON.stringify(s); }
function emitArray(a: string[]) { return `[${a.map(emitScalar).join(", ")}]`; }

/** The full block, `---\n...\n---\n`. */
export function emitFrontMatter(fm: DocFrontMatter): string {
  const lines: string[] = [];
  for (const k of KEY_ORDER) {
    const v = fm[k];
    if (v === undefined) continue;
    if (k === "tags" && Array.isArray(v) && v.length === 0) continue;
    if (Array.isArray(v)) lines.push(`${k}: ${emitArray(v)}`);
    else if (k === "created" || k === "updated") lines.push(`${k}: ${emitDate(v)}`);
    else lines.push(`${k}: ${emitScalar(v)}`);
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

function parseScalar(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) {
    try { const v = JSON.parse(s); if (typeof v === "string") return v; } catch { /* fall through to bare */ }
  }
  return s;
}

function parseArray(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  const parts: string[] = [];
  let cur = ""; let inQ = false; let esc = false;
  for (const ch of inner) {
    if (inQ) {
      cur += ch;
      if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inQ = false;
    } else if (ch === '"') { inQ = true; cur += ch; }
    else if (ch === ",") { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);
  // `[]` and stray empty items parse to nothing; an explicit "" is kept.
  return parts.filter((p) => p.trim() !== "").map(parseScalar);
}

/** Parse the lines between the fences into raw values. Unknown keys are kept; nothing is validated here. */
export function parseFrontMatter(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    if (!m) continue;
    const v = (m[2] ?? "").trim();
    out[m[1]] = v.startsWith("[") && v.endsWith("]") ? parseArray(v) : parseScalar(v);
  }
  return out;
}

/**
 * Strip a leading `---\n...\n---\n` block. Returns the raw block text (without fences) or null when the
 * text does not start with something that looks like front matter, so a Markdown horizontal rule is left alone.
 */
export function splitFrontMatter(text: string): { raw: string | null; body: string } {
  const m = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { raw: null, body: text };
  const raw = m[1] ?? "";
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  const looksYaml = lines.every((l) => /^(?:[A-Za-z_][\w-]*[ \t]*:|[ \t]+\S|-[ \t]|#)/.test(l));
  if (!looksYaml) return { raw: null, body: text };
  return { raw, body: text.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, "") };
}

/** Problems with a front matter object; an empty list means it is valid. */
export function validateFrontMatter(fm: unknown): string[] {
  const errs: string[] = [];
  if (!fm || typeof fm !== "object") return ["front matter is missing"];
  const o = fm as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const list = (k: string, required: boolean) => {
    const v = o[k];
    if (v === undefined) { if (required) errs.push(`${k} is required`); return; }
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) errs.push(`${k} must be a list of strings`);
  };
  if (!str("id")) errs.push("id is required");
  const title = str("title");
  if (title === undefined || title.trim().length < 1 || title.length > 200) errs.push("title must be 1-200 characters");
  if (!str("room")) errs.push("room is required");
  if (o.goal !== undefined && !str("goal")) errs.push("goal must be a non-empty string when present");
  if (!DOC_STATUSES.includes(o.status as DocStatus)) errs.push(`status must be one of ${DOC_STATUSES.join(", ")}`);
  list("authors", true); list("sources", true); list("tags", false);
  if (Array.isArray(o.authors) && o.authors.length === 0) errs.push("authors needs at least one author");
  for (const k of ["created", "updated"]) {
    const v = str(k);
    const t = v && DATE.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
    const real = !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
    if (!real) errs.push(`${k} must be a real YYYY-MM-DD date`);
  }
  return errs;
}

/** Read a whole file: split, parse and validate. Null when it has no valid front matter. */
export function readDocument(text: string): { frontMatter: DocFrontMatter; body: string } | null {
  const { raw, body } = splitFrontMatter(text);
  if (raw === null) return null;
  const fm = parseFrontMatter(raw);
  if (fm.sources === undefined) fm.sources = [];
  if (validateFrontMatter(fm).length) return null;
  return { frontMatter: fm as unknown as DocFrontMatter, body };
}
