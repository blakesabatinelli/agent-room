import { commandIsSimple, commandStarts, normPath, underPath, type Narrow, type Shape } from "./shape.js";

/**
 * 4.2 The `match` of a POLICY.md rule. Either `*` (everything about the tool) or words the owner can write by hand:
 *
 *   action:read                      the verb ("read", "send", "run"), with * and ? allowed ("read*")
 *   path:/Board                      a folder; anything inside it
 *   to:@atmosphere.tv                a recipient domain (the @ is optional)
 *   cmd:npm test                     a command prefix, on a word boundary, for one simple command
 *
 * Words are joined with spaces and every one must hold: `action:read path:/Board`.
 * A match the hub can't read never applies (the linter says so).
 */

export interface Match { action?: string; path?: string; to?: string; cmd?: string }
export type ParsedMatch = { ok: true; all: boolean; m: Match } | { ok: false; why: string };

const KEY = /(?:^|\s)(action|path|to|cmd):/g;
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function parseMatch(text: string): ParsedMatch {
  const s = text.trim();
  if (s === "*") return { ok: true, all: true, m: {} };
  const hits = [...s.matchAll(KEY)];
  if (!hits.length || hits[0].index !== 0) return { ok: false, why: "it must be * or start with action:, path:, to: or cmd:" };
  const m: Match = {};
  for (let i = 0; i < hits.length; i++) {
    const key = hits[i][1] as keyof Match;
    const start = (hits[i].index ?? 0) + hits[i][0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index ?? s.length : s.length;
    const raw = s.slice(start, end).trim();
    if (!raw) return { ok: false, why: `${key}: is empty` };
    if (m[key] !== undefined) return { ok: false, why: `${key}: appears twice` };
    if (key === "action") m.action = raw.toLowerCase();
    else if (key === "path") {
      const p = normPath(raw);
      if (!p) return { ok: false, why: `path: ${raw} isn't a folder` };
      m.path = p;
    } else if (key === "to") {
      const d = raw.replace(/^@/, "").toLowerCase();
      if (!DOMAIN.test(d)) return { ok: false, why: `to: ${raw} isn't a domain` };
      m.to = d;
    } else m.cmd = raw;
  }
  return { ok: true, all: false, m };
}

/** The match as one line, in a fixed order. */
export function formatMatch(m: Match): string {
  const parts: string[] = [];
  if (m.action) parts.push(`action:${m.action}`);
  if (m.path) parts.push(`path:${m.path}`);
  if (m.to) parts.push(`to:@${m.to}`);
  if (m.cmd) parts.push(`cmd:${m.cmd}`);
  return parts.join(" ") || "*";
}

/** The match a learned rule is made with. */
export function matchFor(verb: string, narrow: Narrow): string {
  return formatMatch({ action: verb, ...(narrow.kind === "path" ? { path: narrow.value } : narrow.kind === "to" ? { to: narrow.value } : narrow.kind === "cmd" ? { cmd: narrow.value } : {}) });
}

const glob = (pattern: string, s: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(s);

/**
 * A request that was cut short (Shape.truncated) did not match a rule: could the part that was cut have made it match? True for a rule that names a
 * path, a recipient or a command (those sit in the input) when its action fits. The caller treats such a rule as one that asks.
 */
export function couldHideBehindCut(p: ParsedMatch, s: Shape, rawAction: string): boolean {
  if (!p.ok || p.all) return false;
  const { action, path, to, cmd } = p.m;
  if (path === undefined && to === undefined && cmd === undefined) return false;
  return action === undefined || glob(action, s.verb) || glob(action, rawAction.trim().toLowerCase());
}

/**
 * Does a request fall under a match?
 *
 * `strict` is for rules that let things through ("allow"): every path, every recipient and the whole command must satisfy the rule, a
 * command that chains or redirects never satisfies a command prefix, and a request with no path (or recipient, or command) can't satisfy a
 * rule that names one. Rules that hold things back ("ask", "deny") are lenient: one path or recipient that matches is enough.
 */
export function matches(p: ParsedMatch, s: Shape, rawAction: string, strict: boolean): boolean {
  if (!p.ok) return false;
  if (p.all) return true;
  const { action, path, to, cmd } = p.m;
  if (action !== undefined && !glob(action, s.verb) && !glob(action, rawAction.trim().toLowerCase())) return false;
  if (path !== undefined) {
    if (!s.paths.length) return false;
    if (strict ? !s.paths.every((x) => underPath(x, path)) : !s.paths.some((x) => underPath(x, path))) return false;
  }
  if (to !== undefined) {
    if (!s.domains.length) return false;
    if (strict ? !s.domains.every((d) => d === to) : !s.domains.some((d) => d === to)) return false;
  }
  if (cmd !== undefined) {
    if (s.command === undefined) return false;
    if (strict && !commandIsSimple(s.command)) return false;
    if (!commandStarts(s.command.trim(), cmd)) return false;
  }
  return true;
}
