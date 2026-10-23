import { Document, LineCounter, isMap, isNode, isScalar, isSeq, parseDocument, visit } from "yaml";
import type { ZodIssue } from "zod";
import { KINDS, SCHEMA_VERSION, schemas, type Fm, type Kind } from "./schema.js";

/** A problem in a control file, with the 1-based line it is on when we know it. */
export interface Problem { line?: number; message: string }

export interface Split {
  /** Front matter text between the fences, or null when the file has none. */
  raw: string | null;
  body: string;
  /** 1-based line the body starts on. */
  bodyLine: number;
  problem?: Problem;
}

/** Split `---\n<yaml>\n---\n<body>`. The front matter's first line is file line 2. */
export function splitDoc(text: string): Split {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { raw: null, body: text, bodyLine: 1, problem: { line: 1, message: "the file must start with front matter between --- lines" } };
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return { raw: null, body: "", bodyLine: 1, problem: { line: 1, message: "front matter is never closed: add a --- line after it" } };
  const body = lines.slice(end + 1).join("\n").replace(/^(?:[ \t]*\n)+/, "");
  return { raw: lines.slice(1, end).join("\n"), body, bodyLine: end + 2 };
}

export interface ParsedDoc {
  fm?: Record<string, unknown>;
  body: string;
  bodyLine: number;
  /** Maps a path inside the front matter to a file line. */
  lineOf: (path: (string | number)[]) => number;
  problems: Problem[];
}

/** Parse a file's front matter as YAML. Problems carry file lines. */
export function parseDoc(text: string): ParsedDoc {
  const sp = splitDoc(text);
  if (sp.raw === null) return { body: sp.body, bodyLine: sp.bodyLine, lineOf: () => 1, problems: sp.problem ? [sp.problem] : [] };
  const lc = new LineCounter();
  const doc = parseDocument(sp.raw, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  const lineAt = (offset: number) => lc.linePos(offset).line + 1; // front matter starts on file line 2
  const problems: Problem[] = doc.errors.map((e) => ({ line: e.linePos ? e.linePos[0].line + 1 : 2, message: oneLine(e.message) }));
  const lineOf = (path: (string | number)[]): number => {
    let node: unknown = doc.contents; let line = 2;
    for (const p of path) {
      if (isMap(node)) {
        const pair = node.items.find((it) => isScalar(it.key) && String(it.key.value) === String(p));
        if (!pair) break;
        if (isNode(pair.key) && pair.key.range) line = lineAt(pair.key.range[0]);
        node = pair.value;
      } else if (isSeq(node)) {
        const item = node.items[Number(p)];
        if (!item) break;
        if (isNode(item) && item.range) line = lineAt(item.range[0]);
        node = item;
      } else break;
    }
    return line;
  };
  if (problems.length) return { body: sp.body, bodyLine: sp.bodyLine, lineOf, problems };
  const js = doc.toJS();
  if (js === null || js === undefined) return { body: sp.body, bodyLine: sp.bodyLine, lineOf, problems: [{ line: 2, message: "front matter is empty" }] };
  if (typeof js !== "object" || Array.isArray(js)) return { body: sp.body, bodyLine: sp.bodyLine, lineOf, problems: [{ line: 2, message: "front matter must be a list of `name: value` lines" }] };
  return { fm: js as Record<string, unknown>, body: sp.body, bodyLine: sp.bodyLine, lineOf, problems: [] };
}

const oneLine = (s: string) => s.split("\n")[0].trim();

/** Turn a zod issue into words the owner can act on. */
export function describeIssue(i: ZodIssue): string {
  const where = i.path.length ? `"${i.path.join(".")}"` : "front matter";
  if (i.code === "invalid_type" && i.received === "undefined") return `missing required field ${where}`;
  if (i.code === "invalid_enum_value") return `${where} must be one of ${i.options.join(", ")} (got "${String(i.received)}")`;
  if (i.code === "invalid_literal") return `${where} must be "${String(i.expected)}"`;
  return `${where}: ${i.message}`;
}

export interface Checked<K extends Kind = Kind> { fm?: Fm<K>; problems: Problem[] }

/**
 * Check front matter against the schema for `expected` (the kind the file's place requires).
 * Order matters: kind first, then schema version, then the full shape.
 */
export function checkFrontMatter(parsed: ParsedDoc, expected: Kind): Checked {
  const fm = parsed.fm;
  if (!fm) return { problems: [] };
  const problems: Problem[] = [];
  const kind = fm.kind;
  if (kind === undefined) problems.push({ line: parsed.lineOf([]), message: `missing required field "kind" (this file needs kind: ${expected})` });
  else if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) problems.push({ line: parsed.lineOf(["kind"]), message: `unknown kind "${String(kind)}"; this file needs kind: ${expected}` });
  else if (kind !== expected) problems.push({ line: parsed.lineOf(["kind"]), message: `kind is "${kind}" but a file in this place must be kind: ${expected}` });
  if (typeof fm.schema === "number" && fm.schema > SCHEMA_VERSION) {
    problems.push({ line: parsed.lineOf(["schema"]), message: `schema ${fm.schema} is newer than this version of Agent Room understands (${SCHEMA_VERSION}); update Agent Room` });
  }
  if (problems.length) return { problems };
  const r = schemas[expected].safeParse(fm);
  if (r.success) return { fm: r.data as Fm<typeof expected>, problems: [] };
  return { problems: r.error.issues.map((i) => ({ line: parsed.lineOf(i.path as (string | number)[]), message: describeIssue(i) })) };
}

// ---- writing

const toText = (doc: Document, body: string) => `---\n${doc.toString({ lineWidth: 0, flowCollectionPadding: false })}---\n\n${body.replace(/^\n+/, "")}`;

/** Short lists of plain values go on one line, the dialect Library documents use. */
function inlineShortLists(doc: Document) {
  visit(doc, { Seq(_k, node) { if (node.items.every((it) => isScalar(it)) ) node.flow = true; } });
}

/** A new inline list for `mutate` callbacks (`doc.setIn(path, seqNode(doc, [...]))`). */
export function seqNode(doc: Document, items: unknown[]) {
  const n = doc.createNode(items);
  if (isSeq(n) && n.items.every((it) => isScalar(it))) n.flow = true;
  return n;
}

/** A new file from an object and a body. */
export function emitFile(fm: Record<string, unknown>, body: string): string {
  const doc = new Document(fm);
  inlineShortLists(doc);
  return toText(doc, body);
}

/**
 * Change a file's front matter in place, keeping comments, key order and the body.
 * `mutate` gets the YAML document; returns the new text, or the old text unchanged when nothing changed.
 */
export function editFrontMatter(text: string, mutate: (doc: Document) => void): string {
  const sp = splitDoc(text);
  if (sp.raw === null) throw new Error(sp.problem?.message ?? "no front matter");
  const doc = parseDocument(sp.raw, { prettyErrors: false });
  if (doc.errors.length) throw new Error(oneLine(doc.errors[0].message));
  const before = doc.toString({ lineWidth: 0 });
  mutate(doc);
  if (doc.toString({ lineWidth: 0 }) === before) return text;
  return toText(doc, sp.body);
}

/** Replace the body, keeping the front matter text exactly as it is. */
export function replaceBody(text: string, body: string): string {
  const sp = splitDoc(text);
  if (sp.raw === null) throw new Error(sp.problem?.message ?? "no front matter");
  return `---\n${sp.raw}\n---\n\n${body.replace(/^\n+/, "")}`;
}
