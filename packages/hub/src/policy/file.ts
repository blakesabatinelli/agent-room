import type { PolicyRule } from "../control/schema.js";
import { editFrontMatter, replaceBody, seqNode, splitDoc } from "../control/parse.js";
import { parseMatch } from "./match.js";
import { labelFor, toolWord, type Narrow } from "./shape.js";

/**
 * 4.2 Edits to POLICY.md that keep the owner's file readable: the rules go in the front matter, and each learned rule or
 * lease also gets one plain-English line in the body, tagged with its id so the line can be found again.
 * Pure text in, text out; the engine does the reading, locking and committing (ControlFolder.update).
 */

export type Section = "learned" | "lease";
const HEADER: Record<Section, string> = { learned: "## Learned from your approvals", lease: "## Active leases" };
const INTRO: Record<Section, string> = {
  learned: "These came from what you approved and rejected. A rule applies only after you accept it: press Accept in the app, or set `accepted: true` in the rule above. Delete a line's rule to turn it down.",
  lease: "Access that ends by itself, when its time is up or its goal ends. Revoke one in the app, or delete its rule above.",
};
const TAG = /\[((?:learned|lease)-[0-9a-z]+)\]\s*$/;

/** Cap the owner's file so the hub's lines never push it over its 8 KB limit; the engine stops adding past this. */
export const POLICY_SOFT_CAP = 7 * 1024;

export interface RuleOut { id: string; effect: PolicyRule["effect"]; tool: string; match: string; scope: string; expires?: string; source: PolicyRule["source"]; accepted: boolean }

const touch = (doc: import("yaml").Document, by: string, today: string) => { doc.set("updated", today); doc.set("updated_by", by); };
type Seq = { items: { get(k: string): unknown }[]; flow?: boolean; add(v: unknown): void };
const rulesSeq = (doc: import("yaml").Document) => doc.get("rules") as Seq | undefined;
const indexOf = (doc: import("yaml").Document, id: string) => rulesSeq(doc)?.items.findIndex((it) => it.get?.("id") === id) ?? -1;

/** Add rules (each with its plain line) to POLICY.md. A rule whose id is already there is left alone. */
export function addRules(text: string, items: { rule: RuleOut; line: string; section: Section }[], by: string, today: string): string {
  const added = new Set<string>();
  let out = editFrontMatter(text, (doc) => {
    let changed = false;
    for (const { rule } of items) {
      if (indexOf(doc, rule.id) >= 0) continue;
      added.add(rule.id);
      if (!rulesSeq(doc)) doc.set("rules", seqNode(doc, []));
      const s = rulesSeq(doc)!;
      s.flow = false;
      const node: Record<string, unknown> = { id: rule.id, effect: rule.effect, tool: rule.tool, match: rule.match, scope: rule.scope };
      if (rule.expires) node.expires = rule.expires;
      node.source = rule.source; node.accepted = rule.accepted;
      s.add(doc.createNode(node)); changed = true;
    }
    if (changed) touch(doc, by, today);
  });
  for (const { rule, line, section } of items) if (added.has(rule.id) && line) out = setBodyLine(out, section, rule.id, line);
  return out;
}

/** Change fields of one rule (and its line, when `line` is given). */
export function patchRule(text: string, id: string, patch: Partial<Pick<RuleOut, "effect" | "match" | "scope" | "accepted">> & { expires?: string | null }, by: string, today: string, section?: Section, line?: string): string {
  let out = editFrontMatter(text, (doc) => {
    const i = indexOf(doc, id);
    if (i < 0) return;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "expires" && v === null) { if (doc.hasIn(["rules", i, "expires"])) { doc.deleteIn(["rules", i, "expires"]); changed = true; } continue; }
      if (v === undefined) continue;
      if (doc.getIn(["rules", i, k]) !== v) { doc.setIn(["rules", i, k], v); changed = true; }
    }
    if (changed) touch(doc, by, today);
  });
  if (section && line !== undefined) out = setBodyLine(out, section, id, line);
  return out;
}

/** Take rules out, with their lines. */
export function removeRules(text: string, ids: string[], by: string, today: string): string {
  let out = editFrontMatter(text, (doc) => {
    let changed = false;
    for (const id of ids) {
      const i = indexOf(doc, id);
      if (i >= 0) { doc.deleteIn(["rules", i]); changed = true; }
    }
    if (changed) touch(doc, by, today);
  });
  for (const id of ids) out = setBodyLine(out, id.startsWith("lease-") ? "lease" : "learned", id, null);
  return out;
}

/** The plain-English line the body carries for a rule, if it has one. */
export function lineFor(body: string, id: string): string | undefined {
  for (const l of body.split("\n")) {
    const m = TAG.exec(l);
    if (m && m[1] === id) return l.replace(TAG, "").replace(/^\s*-\s*/, "").trim();
  }
  return undefined;
}

// ---- the body

const isManaged = (l: string) => TAG.test(l);

function dropEmptySections(lines: string[]): string[] {
  let out = [...lines];
  for (const section of Object.keys(HEADER) as Section[]) {
    const h = out.findIndex((l) => l.trim() === HEADER[section]);
    if (h < 0) continue;
    let end = h + 1;
    while (end < out.length && !out[end].startsWith("## ")) end++;
    if (!out.slice(h, end).some(isManaged)) {
      let from = h;
      while (from > 0 && out[from - 1].trim() === "") from--;
      out = [...out.slice(0, from), ...out.slice(end)];
    }
  }
  return out;
}

/** Put (or replace, or with `line` null remove) the line for `id` under its section, creating the section when it is the first line. */
export function setBodyLine(text: string, section: Section, id: string, line: string | null): string {
  const sp = splitDoc(text);
  if (sp.raw === null) return text;
  const lines = sp.body.replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") lines.length = 0;
  const tag = `[${id}]`;
  const at = lines.findIndex((l) => { const m = TAG.exec(l); return !!m && m[1] === id; });
  if (line === null) {
    if (at >= 0) lines.splice(at, 1);
  } else {
    const row = `- ${line.replace(/\s+/g, " ").trim()} ${tag}`;
    if (at >= 0) lines[at] = row;
    else {
      const h = lines.findIndex((l) => l.trim() === HEADER[section]);
      if (h < 0) {
        if (lines.length) lines.push("");
        lines.push(HEADER[section], "", INTRO[section], "", row);
      } else {
        let end = h + 1;
        while (end < lines.length && !lines[end].startsWith("## ")) end++;
        let last = end - 1;
        while (last > h && lines[last].trim() === "") last--;
        lines.splice(last + 1, 0, row);
      }
    }
  }
  const body = dropEmptySections(lines).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  const next = replaceBody(text, body ? `${body}\n` : "\n");
  return next === text ? text : next;
}

// ---- words for rules that have no line of their own

const SCOPE_WORDS = (scope: string, agentName?: string) => {
  const parts: string[] = [];
  for (const tok of scope.trim().split(/\s+/)) {
    if (tok.startsWith("room:")) parts.push(`in #${tok.slice(5)}`);
    else if (tok.startsWith("goal:")) parts.push("for one goal");
  }
  // a lease from a room with no folder name (a direct message) or from a request with no room still says where it applies
  if (!parts.some((x) => x.startsWith("in #"))) { if (/(^|\s)roomid:/.test(scope)) parts.unshift("in one room"); else if (/(^|\s)noroom(\s|$)/.test(scope)) parts.unshift("where there is no room"); }
  return { owner: agentName ? `${agentName}'s ` : "", where: parts.join(" ") };
};

/** "Allow Claude's Drive reads in /Board", "Ask before shell command "npm test"". Used where the file has no line for the rule. */
export function describeRule(r: { effect: PolicyRule["effect"]; tool: string; match: string; scope: string; expires?: string }, agentName?: string, zone?: string): string {
  const verb = r.effect === "allow" ? "Allow" : r.effect === "ask" ? "Ask before" : "Deny";
  const { owner, where } = SCOPE_WORDS(r.scope, /(^|\s)agent:/.test(r.scope) ? agentName : undefined);
  const pm = parseMatch(r.match);
  let what: string;
  if (!pm.ok) what = `${toolWord(r.tool)}: ${r.match}`;
  else if (pm.all) what = `${toolWord(r.tool)} (anything)`;
  else {
    const m = pm.m;
    const narrow: Narrow = m.path ? { kind: "path", value: m.path } : m.to ? { kind: "to", value: m.to } : m.cmd ? { kind: "cmd", value: m.cmd } : { kind: "none" };
    what = m.action === "*" && narrow.kind === "none" ? `${toolWord(r.tool)} (anything)` : labelFor(r.tool, m.action ?? "", narrow);
  }
  const until = r.expires ? ` until ${r.expires.includes("T") ? `${new Date(r.expires).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone ?? "UTC", timeZoneName: "short" })}` : r.expires}` : "";
  return `${verb} ${owner}${what}${where ? ` ${where}` : ""}${until}`;
}
