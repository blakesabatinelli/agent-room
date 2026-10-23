import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ControlNotice } from "@agent-room/shared";
import { contradicts, expired, parseFacts } from "./facts.js";
import { checkFrontMatter, parseDoc, type ParsedDoc } from "./parse.js";
import { agentLevel, looser, platformLevel, policyLevel, scopesOverlap } from "./permissions.js";
import { CAPS, KNOWN_NAMES, classify, expiryMs, isRealInstant, todayString, type Fm, type FileMeta, type Kind } from "./schema.js";
import { parseMatch } from "../policy/match.js"; // 4.2
import { parseCron } from "../rooms/cron.js"; // 4.3
import { validZone } from "../rooms/zone.js"; // 4.3

/**
 * The linter (CONTROL.md section 7). Blocks: the file is not loaded and the last good version stays.
 * Flags: the file loads, the owner is told, and the looser line is ignored by the permission code.
 */
export type Issue = ControlNotice;

export interface FileResult {
  rel: string;
  meta: FileMeta;
  text: string;
  bytes: number;
  /** Validated front matter; undefined when the file has a block. */
  fm?: Fm<Kind>;
  body: string;
  bodyLine: number;
  parsed?: ParsedDoc;
  blocks: Issue[];
  flags: Issue[];
}

export interface Analysis {
  files: Map<string, FileResult>;
  /** Folder names under agents/, whether or not the files in them are valid. */
  agentIds: Set<string>;
  blocks: Issue[];
  flags: Issue[];
}

export interface LintOptions { today?: string; /** 4.2: the moment a lease is judged against (epoch ms). Default: the clock. */ now?: number }

export function walk(root: string, dir = ""): string[] {
  let names: import("node:fs").Dirent[] = [];
  try { names = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const d of names) {
    if (d.name.startsWith(".") || (dir === "" && d.name === "Library")) continue;
    const rel = dir ? `${dir}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...walk(root, rel));
    else if (d.isFile()) out.push(rel);
  }
  return out;
}

const block = (file: string, message: string, line?: number): Issue => ({ level: "block", file, line, message });
const flag = (file: string, message: string, line?: number): Issue => ({ level: "flag", file, line, message });

/** Check one file on its own: size cap, front matter, schema. Cross-file checks happen in analyzeFolder. */
export function checkFile(rel: string, meta: FileMeta, text: string): FileResult {
  const bytes = Buffer.byteLength(text);
  const r: FileResult = { rel, meta, text, bytes, body: "", bodyLine: 1, blocks: [], flags: [] };
  const cap = CAPS[meta.kind];
  if (cap !== undefined && bytes > cap) {
    r.blocks.push(block(rel, `file is ${bytes} bytes, over its ${cap} byte limit; shorten it`, 1));
    return r;
  }
  const parsed = parseDoc(text);
  r.parsed = parsed; r.body = parsed.body; r.bodyLine = parsed.bodyLine;
  if (parsed.problems.length) { r.blocks.push(...parsed.problems.map((p) => block(rel, p.message, p.line))); return r; }
  const checked = checkFrontMatter(parsed, meta.kind);
  if (checked.problems.length) { r.blocks.push(...checked.problems.map((p) => block(rel, p.message, p.line))); return r; }
  r.fm = checked.fm;
  return r;
}

/** Read every file in the folder and report what is wrong with each. Never throws on bad content. */
export function analyzeFolder(root: string, opts: LintOptions = {}): Analysis {
  const today = opts.today ?? todayString();
  const nowMs = opts.now ?? Date.now();
  const files = new Map<string, FileResult>();
  const agentIds = new Set<string>();
  const loose: Issue[] = []; // issues for files that are not control files

  for (const rel of walk(root).sort()) {
    const c = classify(rel);
    if ("ignored" in c) continue;
    if ("unknown" in c) {
      const name = rel.split("/").pop() ?? rel;
      const hint = KNOWN_NAMES.find((k) => k.toLowerCase() === name.toLowerCase() && k !== name);
      loose.push(flag(rel, hint ? `unknown file; did you mean ${hint}? It is ignored until the name matches` : "isn't part of the control folder layout, so it is ignored"));
      continue;
    }
    const meta = c.meta;
    if (meta.agent) agentIds.add(meta.agent);
    let text = "";
    try { if (lstatSync(join(root, rel)).isFile()) text = readFileSync(join(root, rel), "utf8"); } catch { continue; }
    files.set(rel, checkFile(rel, meta, text));
  }

  // ---- blocks that need other files
  for (const r of files.values()) {
    if (!r.fm) continue;
    if (r.meta.kind === "room") {
      const fm = r.fm as Fm<"room">;
      fm.roster.forEach((a, i) => {
        if (!agentIds.has(a)) r.blocks.push(block(r.rel, `roster names "${a}", but there is no agents/${a}/ folder`, r.parsed?.lineOf(["roster", i])));
      });
    }
    if (r.meta.kind === "goal") {
      const fm = r.fm as Fm<"goal">;
      if (fm.id !== r.meta.goal) r.blocks.push(block(r.rel, `id "${fm.id}" doesn't match its folder goals/${r.meta.goal}/`, r.parsed?.lineOf(["id"])));
    }
    if (r.blocks.length) r.fm = undefined;
  }

  // ---- flags (only on files that loaded)
  const ok = <K extends Kind>(rel: string) => { const r = files.get(rel); return r?.fm ? (r as FileResult & { fm: Fm<K> }) : undefined; };
  const policyFile = ok<"policy">("POLICY.md");
  const policy = policyFile?.fm;

  if (policyFile && policy) {
    const rules = policy.rules;
    rules.forEach((r, i) => {
      // 4.2: a lease (a rule with a UTC moment) is past its time when that moment has gone; a dated rule is good through its day.
      const lease = !!r.expires && isRealInstant(r.expires);
      if (r.expires && (lease ? nowMs >= expiryMs(r.expires) : r.expires < today)) {
        const what = r.id.startsWith("lease-") || lease ? "lease" : "rule";
        policyFile.flags.push(flag("POLICY.md", `${what} "${r.id}" expired ${lease ? `at ${r.expires.replace("T", " ").replace(/(:\d\d)?(\.\d+)?Z$/, " UTC")}` : `on ${r.expires}`}; it no longer applies`, policyFile.parsed?.lineOf(["rules", i, "expires"])));
      }
      // 4.2: an allow for every tool and every action is the whole approval policy switched off for that agent (sends, CRM writes and deletes still meet the two-key check)
      const pm = r.match === "*" ? undefined : parseMatch(r.match);
      if (r.effect === "allow" && r.tool === "*" && pm?.ok && pm.m.action === "*" && pm.m.path === undefined && pm.m.to === undefined && pm.m.cmd === undefined) {
        policyFile.flags.push(flag("POLICY.md", `rule "${r.id}" allows every action of every tool (tool * with action:*). It turns approvals off for ${r.scope === "*" ? "everyone" : r.scope}; name the tools and actions you mean`, policyFile.parsed?.lineOf(["rules", i, "match"])));
      }
      if (r.match !== "*" && !parseMatch(r.match).ok) policyFile.flags.push(flag("POLICY.md", `rule "${r.id}" has a match the hub can't read ("${r.match}"), so it never applies. Use * or words like action:read path:/Board`, policyFile.parsed?.lineOf(["rules", i, "match"])));
    });
    for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i], b = rules[j];
      const opposite = (a.effect === "allow" && b.effect === "deny") || (a.effect === "deny" && b.effect === "allow");
      if (opposite && a.tool === b.tool && a.match === b.match && scopesOverlap(a.scope, b.scope)) {
        policyFile.flags.push(flag("POLICY.md", `rules "${a.id}" and "${b.id}" ${a.effect} and ${b.effect} the same ${a.tool} actions; the stricter one wins`, policyFile.parsed?.lineOf(["rules", j])));
      }
    }
  }

  const toolsOf = (id: string) => ok<"tools">(`agents/${id}/TOOLS.md`);
  for (const r of files.values()) {
    if (!r.fm) continue;
    if (r.meta.kind === "tools") {
      const t = r.fm as Fm<"tools">; const agent = r.meta.agent!;
      for (const [tool, v] of Object.entries(t.room_allows)) {
        const cap = [{ from: "POLICY.md", l: policyLevel(policy, tool, agent, undefined, today) }, { from: "the platform", l: platformLevel(t, tool) }].find((b) => looser(v, b.l));
        if (cap) r.flags.push(flag(r.rel, `room_allows sets ${tool}: ${v}, but ${cap.from} says ${cap.l}; the stricter setting applies and this line is ignored`, r.parsed?.lineOf(["room_allows", tool])));
      }
    }
    if (r.meta.kind === "room") {
      const room = r.fm as Fm<"room">; const slug = r.meta.room!;
      for (const [tool, v] of Object.entries(room.tools)) {
        let cap: { from: string; l: ReturnType<typeof policyLevel> } | undefined;
        const p = policyLevel(policy, tool, undefined, slug, today);
        if (looser(v, p)) cap = { from: "POLICY.md", l: p };
        for (const a of room.roster) {
          if (cap) break;
          const base = agentLevel(policy, toolsOf(a)?.fm, a, tool, today, slug);
          if (looser(v, base)) cap = { from: `agents/${a}/TOOLS.md`, l: base };
        }
        if (cap) r.flags.push(flag(r.rel, `tools sets ${tool}: ${v}, but ${cap.from} says ${cap.l}; a room can only tighten, so the stricter setting applies`, r.parsed?.lineOf(["tools", tool])));
      }
      // 4.3: the calendar trigger. A schedule the hub can't read, or has nothing to run, stays off; the rest of the file still loads.
      if (room.schedule !== undefined) {
        const c = parseCron(room.schedule);
        if (!c.ok) r.flags.push(flag(r.rel, `schedule "${room.schedule}" isn't a valid cron: ${c.error}. The room won't run on a schedule until it is fixed`, r.parsed?.lineOf(["schedule"])));
        else if (!room.standing_goal?.trim()) r.flags.push(flag(r.rel, `schedule is set but standing_goal is empty, so there is nothing to run. Add standing_goal: <what to run>`, r.parsed?.lineOf(["schedule"])));
      }
      if (room.timezone !== undefined && !validZone(room.timezone)) r.flags.push(flag(r.rel, `timezone "${room.timezone}" isn't a time zone (use a name like America/Chicago). The owner's time zone from USER.md is used instead`, r.parsed?.lineOf(["timezone"])));
    }
    if (r.meta.kind === "room-memory") {
      const facts = parseFacts(r.body, r.bodyLine);
      const live = facts.filter((f) => !expired(f, today));
      for (const f of facts) if (expired(f, today)) r.flags.push(flag(r.rel, `fact expired on ${f.expires}: "${f.text.slice(0, 80)}"`, f.line));
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        if (contradicts(live[i].text, live[j].text)) r.flags.push(flag(r.rel, `contradicts the fact on line ${live[i].line}: "${live[j].text.slice(0, 80)}"`, live[j].line));
      }
    }
  }

  const blocks: Issue[] = [], flags: Issue[] = [...loose];
  for (const r of files.values()) { blocks.push(...r.blocks); flags.push(...r.flags); }
  return { files, agentIds, blocks, flags };
}

/** Lint a control folder from disk. */
export function lint(root: string, opts: LintOptions = {}): { blocks: Issue[]; flags: Issue[] } {
  const a = analyzeFolder(root, opts);
  return { blocks: a.blocks, flags: a.flags };
}

/** One line per issue, for the CLI. */
export function formatIssue(i: Issue): string {
  return `${i.level === "block" ? "BLOCK" : "flag "} ${i.file}${i.line ? `:${i.line}` : ""}  ${i.message}`;
}
