import { basename } from "node:path";

/**
 * Tasks that agents can actually do (part 1): an agent creates and changes files only inside its task folder (confinement, files/confine.ts),
 * so a task that tells it to write to /tmp or another absolute path can't be done by any confined agent. These helpers find such paths in a
 * planned task so the plan gate can send it back, and rewrite them to relative paths when the planner doesn't fix them.
 */

/** What every task prompt and the planner say about where files go. */
export const WRITE_RULE = "You can create and change files only inside your task folder (your current directory). Put every output there, with relative paths, never in /tmp or at another absolute path; the hub brings accepted work back to the goal's folder.";
/** The same rule for the planner, who writes the tasks. */
export const WRITE_RULE_PLAN = "Agents can create and change files only inside their own task folder, so every file a task writes (in \"files\", \"output\" and the description) is a relative path. Never tell a task to write to /tmp, ~, /Users or any other absolute path; the hub brings accepted work back. A task may still read a granted folder named above.";

const ROOTS = "tmp|Users|home|var|private|opt|etc|root|mnt|Volumes|usr|srv|Library|Applications";
const TAIL = "[^\\s\"'`),;]*";
const ABS = new RegExp(`(^|[\\s"'\`(=:,>])(~\\/${TAIL}|\\$HOME(?:\\/${TAIL})?|\\$TMPDIR(?:\\/${TAIL})?|\\/(?:${ROOTS})(?:\\/${TAIL})?)`, "g");

const WRITE_WORDS = /\b(write|writes|writing|save|saves|saving|create|creates|creating|copy|copies|copying|put|puts|store|stores|output|outputs|export|exports|clone|clones|generate|generates|move|moves|mkdir|init|initiali[sz]e|commit|place|dump|deploy|build|builds|extract|unzip|download|touch|cp|mv|rsync|tee)\b|>>?/i;
const READ_BEFORE = /\b(from|read|reads|reading|open|opens|inspect|see|per|using|source|input|inputs|under|within|inside the granted)\s*$/i;

const clean = (p: string) => p.replace(/[.:!?]+$/, "");

function matches(text: string): { path: string; before: string }[] {
  const out: { path: string; before: string }[] = [];
  for (const m of text.matchAll(ABS)) {
    const path = clean(m[2]);
    if (path.length < 2) continue;
    const start = (m.index ?? 0) + m[1].length;
    out.push({ path, before: text.slice(Math.max(0, start - 120), start) });
  }
  return out;
}

/** Absolute paths a text names as a place to write: a write verb in the same clause, and not introduced as something to read from. */
export function writePathsIn(text: string | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const { path, before } of matches(text)) {
    const clause = before.split(/[.\n;]/).pop() ?? "";
    if (READ_BEFORE.test(clause)) continue;
    if (WRITE_WORDS.test(clause) || /^(>>?)/.test(clause.trim())) found.push(path);
  }
  return [...new Set(found)];
}

/** Every absolute path a text names (for a field that is itself a deliverable: "files", "output"). */
export function allPathsIn(text: string | undefined): string[] {
  return [...new Set(matches(text ?? "").map((m) => m.path))];
}

export interface PathFields { description?: string; output?: string; scope?: string; files?: string[]; criteria?: unknown }

const under = (p: string, root?: string) => !!root && (p === root || p.startsWith(root.replace(/\/+$/, "") + "/"));

/** Absolute paths outside the goal's folder that this task is told to write to. */
export function taskWritePaths(t: PathFields, goalFolder?: string): string[] {
  const critTexts = (Array.isArray(t.criteria) ? t.criteria : []).flatMap((c) => typeof c === "string" ? [c] : [(c as { text?: string })?.text, (c as { check?: string })?.check]).filter((x): x is string => typeof x === "string");
  const all = [
    ...(t.files ?? []).flatMap((f) => allPathsIn(f)),
    ...allPathsIn(t.output),
    ...writePathsIn(t.description), ...writePathsIn(t.scope),
    ...critTexts.flatMap((c) => writePathsIn(c)),
  ];
  return [...new Set(all)].filter((p) => !under(p, goalFolder));
}

/** The relative path an absolute one becomes: its last part ("/tmp/vizio-cdp-baseline" becomes "vizio-cdp-baseline"). */
export function relativeOf(p: string): string {
  const b = basename(p.replace(/\/+$/, ""));
  return !b || b === "~" || b === "$HOME" || b === "$TMPDIR" ? "output" : b;
}

/** Rewrite the paths the task must not write to into relative ones, in every field it names them. Returns what changed. */
export function relativizeTask<T extends PathFields>(t: T, goalFolder?: string): { from: string; to: string }[] {
  const paths = taskWritePaths(t, goalFolder).sort((a, b) => b.length - a.length);
  if (!paths.length) return [];
  const fix = (s: string) => paths.reduce((acc, p) => acc.split(p).join(relativeOf(p)), s);
  if (t.description) t.description = fix(t.description);
  if (t.output) t.output = fix(t.output);
  if (t.scope) t.scope = fix(t.scope);
  if (t.files) t.files = t.files.map(fix);
  if (Array.isArray(t.criteria)) t.criteria = t.criteria.map((c) => typeof c === "string" ? fix(c) : c && typeof c === "object" ? { ...c, ...((c as { text?: string }).text ? { text: fix((c as { text: string }).text) } : {}), ...((c as { check?: string }).check ? { check: fix((c as { check: string }).check) } : {}) } : c);
  return paths.map((from) => ({ from, to: relativeOf(from) }));
}
