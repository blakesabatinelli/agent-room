import { isTwoKey, parsedInput } from "../twokey/classify.js";

/**
 * 4.2 The shape of an approval request: the parts of "tool, action, detail" that a rule can talk about.
 *
 *   verb      what is being done, normalised ("read", "write", "send", "run"...)
 *   paths     every file or Drive path the request names, normalised (/Board/q3/deck.md)
 *   domains   the recipient domains (bob@atmosphere.tv -> atmosphere.tv)
 *   command   the shell command, when there is one
 *
 * Two jobs: the learner groups past approvals by shape, and the matcher checks a new request against rules (match.ts).
 * Everything here is pure, so it is easy to test and the same answer comes out everywhere.
 */

export interface Shape {
  tool: string;
  verb: string;
  paths: string[];
  domains: string[];
  command?: string;
  /**
   * The request was JSON that was cut short and no whole input was given, so a recipient, path or command a rule names may sit in the part that is
   * missing. An allow never applies to such a request, and a rule that would hold it back is treated as matching.
   */
  truncated?: boolean;
}

const CLAUDE_VERBS: Record<string, string> = {
  read: "read", glob: "read", grep: "read", ls: "read", notebookread: "read",
  write: "write", edit: "write", multiedit: "write", notebookedit: "write",
  bash: "run", webfetch: "fetch", websearch: "fetch",
};

/** Verbs that only look at things. A learned rule about one of these needs no further narrowing. */
export const READ_VERBS = new Set(["read", "list", "search", "get", "fetch", "view", "query", "find", "download"]);

/** What is being done, as one lower-case word. "mcp__gmail__send_message" and "Send email to Bob" both give "send". */
export function verbOf(action: string): string {
  const a = action.trim().toLowerCase();
  if (!a) return "";
  if (CLAUDE_VERBS[a]) return CLAUDE_VERBS[a];
  const mcp = /^mcp__[a-z0-9_-]+?__([a-z0-9]+)(?:_|$)/.exec(a);
  if (mcp) return mcp[1];
  return /^[a-z]+/.exec(a)?.[0] ?? "";
}

// ---- paths

/** A path as the rules compare it: forward slashes, one leading slash, no `.` segments. undefined when it climbs out with `..`. */
export function normPath(p: string): string | undefined {
  const segs: string[] = [];
  for (const s of p.trim().replace(/\\/g, "/").replace(/^file:\/\//, "").split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") return undefined;
    segs.push(s);
  }
  return segs.length ? `/${segs.join("/")}` : undefined;
}

/** Is `path` (normalised) the prefix itself, or inside it? Case doesn't matter (a Mac's disk and Drive don't care). */
export function underPath(path: string, prefix: string): boolean {
  const p = path.toLowerCase(), x = prefix.toLowerCase();
  return p === x || p.startsWith(`${x}/`);
}

/** The directory a learned rule is about: the top folder in Drive, the first two folders on disk. A path with one part is its own prefix. */
export function pathPrefix(path: string, tool: string): string {
  const segs = path.split("/").filter(Boolean);
  const depth = tool === "drive" ? 1 : 2;
  return `/${segs.slice(0, Math.max(1, Math.min(depth, segs.length - 1))).join("/")}`;
}

const PATH_KEYS = new Set(["file_path", "path", "notebook_path", "folder", "directory", "dir", "filepath"]);
const RECIPIENT_KEYS = new Set(["to", "cc", "bcc", "recipient", "recipients", "email", "emails", "attendees"]);
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const TEXT_PATH = /(?:^|[\s"'(=])((?:~|\.{1,2})?\/[^\s"'<>|;&()]+)/g;

type Json = unknown;
const strings = (v: Json, out: string[] = [], depth = 0): string[] => {
  if (depth > 6 || out.length > 200) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
};
const keyed = (v: Json, keys: Set<string>, out: string[] = [], depth = 0): string[] => {
  if (depth > 6 || !v || typeof v !== "object") return out;
  if (Array.isArray(v)) { for (const x of v) keyed(x, keys, out, depth + 1); return out; }
  for (const [k, x] of Object.entries(v)) {
    if (keys.has(k.toLowerCase())) strings(x, out); else keyed(x, keys, out, depth + 1);
  }
  return out;
};
const domainsIn = (texts: string[]) => [...new Set(texts.flatMap((t) => [...t.matchAll(EMAIL)].map((m) => m[1].toLowerCase())))].sort();

function parseJson(detail: string): Json | undefined {
  const t = detail.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

/** Text that starts like JSON, fails to parse, and is as long as the longest text the hub keeps of a tool input: it was cut. */
const CUT_AT = 4000;
const looksCut = (detail: string) => /^[{[]/.test(detail.trim()) && detail.length >= CUT_AT && parseJson(detail) === undefined;

/**
 * Break an approval request into the parts a rule can match. Never throws.
 * `input` is the tool's own input object when there is one: it is read in preference to `detail`, which is cut short for display (a long body can push
 * the recipient past the cut, and a shape made from half a JSON text would miss it).
 */
export function shapeOf(tool: string, action: string, detail: string, input?: unknown): Shape {
  const whole = input && typeof input === "object" ? input : undefined;
  const json = whole ?? parseJson(detail);
  const truncated = json === undefined && looksCut(detail);
  const verb = verbOf(action);
  let rawPaths: string[] = [];
  let recipients: string[] = [];
  let command: string | undefined;
  if (json !== undefined) {
    rawPaths = keyed(json, PATH_KEYS);
    recipients = keyed(json, RECIPIENT_KEYS);
    if (!recipients.length) recipients = strings(json);
    const c = keyed(json, new Set(["command"]));
    if (tool === "shell" && c.length === 1) command = c[0].trim();
  } else {
    const text = `${action}\n${detail}`;
    rawPaths = [...text.matchAll(TEXT_PATH)].map((m) => m[1]);
    recipients = [text];
    if (tool === "shell") command = detail.trim().replace(/^\$\s+/, "") || undefined;
  }
  const paths: string[] = [];
  for (const p of rawPaths.slice(0, 20)) {
    const n = normPath(p.replace(/^~(?=\/)/, "/~"));
    if (n === undefined) paths.push("/.."); // a path that climbs out is never inside anything a rule names
    else if (!paths.includes(n)) paths.push(n);
  }
  return { tool, verb, paths, domains: domainsIn(recipients), ...(command ? { command } : {}), ...(truncated ? { truncated } : {}) };
}

// ---- commands

/** A command a prefix rule may match without being tricked: one simple command, no chaining, redirects, substitution or newlines. */
export const commandIsSimple = (cmd: string) => !/[;&|<>$`\\\n\r(){}]/.test(cmd);

/** Runners whose second word says what they do ("npm test", "git push"). */
const SUBCOMMAND = new Set(["npm", "pnpm", "yarn", "git", "cargo", "go", "make", "docker", "kubectl", "pip", "pip3", "brew", "gh", "bun", "deno", "npx", "node", "python", "python3", "ruby", "tsx"]);
/** Of those, the ones where the third word is the real job ("npm run build"). */
const RUNS = new Set(["run", "exec", "dlx", "x", "run-script"]);
/** Programs a rule must never cover by name alone: they run anything, or damage things. */
const NEVER_BY_NAME = new Set(["rm", "sudo", "su", "curl", "wget", "ssh", "scp", "sftp", "dd", "chmod", "chown", "mv", "kill", "pkill", "eval", "exec", "sh", "bash", "zsh", "fish", "env", "xargs", "find", "osascript", "open", "launchctl", "defaults", "tee", "nc", "ncat"]);

/** "npm test" for `npm test --silent`; undefined when no word-level prefix says enough ("bash -c ...", "rm ..."). */
export function commandPrefix(cmd: string): string | undefined {
  const t = cmd.trim().split(/\s+/).filter(Boolean);
  if (!t.length || !commandIsSimple(cmd)) return undefined;
  const first = t[0];
  if (NEVER_BY_NAME.has(first)) return undefined;
  if (SUBCOMMAND.has(first)) {
    if (!t[1] || t[1].startsWith("-")) return undefined;
    if (RUNS.has(t[1])) return t[2] && !t[2].startsWith("-") ? t.slice(0, 3).join(" ") : undefined;
    return t.slice(0, 2).join(" ");
  }
  return first;
}

/** Does this command start with the prefix, on a word boundary (a space, or where a chained command begins)? */
export const commandStarts = (cmd: string, prefix: string) => cmd === prefix || (cmd.startsWith(prefix) && /[\s;&|<>)]/.test(cmd[prefix.length]));

// ---- what a learned rule is about

export type Narrow = { kind: "path" | "to" | "cmd"; value: string } | { kind: "none" };

/** Which one part of the request a learned rule is about, or undefined when the request has no stable shape to learn from. */
export function narrowOf(s: Shape): Narrow | undefined {
  const pref = (): Narrow | undefined => {
    if (!s.paths.length) return { kind: "none" };
    if (s.paths.includes("/..")) return undefined;
    const set = new Map(s.paths.map((p) => { const x = pathPrefix(p, s.tool); return [x.toLowerCase(), x] as const; }));
    return set.size === 1 ? { kind: "path", value: [...set.values()][0] } : undefined;
  };
  const dom = (): Narrow | undefined => (s.domains.length > 1 ? undefined : s.domains.length === 1 ? { kind: "to", value: s.domains[0] } : { kind: "none" });
  if (s.tool === "shell") {
    if (s.command === undefined) return { kind: "none" };
    const p = commandPrefix(s.command);
    return p ? { kind: "cmd", value: p } : undefined;
  }
  if (s.tool === "gmail" || s.tool === "slack") return dom();
  if (s.tool === "drive" || s.tool === "filesystem") return pref();
  const p = pref();
  return p && p.kind !== "none" ? p : dom();
}

/** A shape that a learned rule can be made from: it has a verb, a stable narrowing, and (unless it only reads) at least one. */
export function learnable(s: Shape): { verb: string; narrow: Narrow } | undefined {
  if (!s.verb || s.truncated) return undefined; // a request that was cut short has no stable shape to learn from
  const narrow = narrowOf(s);
  if (!narrow) return undefined;
  if (narrow.kind === "none" && !READ_VERBS.has(s.verb)) return undefined;
  return { verb: s.verb, narrow };
}

// ---- classes the two-key rule (4.1) owns

/**
 * Actions where two vendors must draft the action independently before it runs (PRODUCT.md 6.11): email sends, CRM writes, deletes, and a shell
 * command that deletes or can't be read. A policy "allow" never stands in for that check, and a rule is never learned to skip it.
 * This is the two-key classifier itself (twokey/classify.ts): one table for the gate, the policy, the learner and auto-approval. `input` is the
 * tool's input (an object) or the agent's detail text.
 */
export function twoKeyClass(tool: string, action: string, input?: unknown): boolean {
  return isTwoKey(tool, action, parsedInput(typeof input === "string" ? input : "", input) ?? input).twoKey; // a JSON text is the input it holds
}

// ---- words

const TOOL_WORDS: Record<string, string> = { drive: "Drive", gmail: "Gmail", slack: "Slack", salesforce: "Salesforce", shell: "shell", filesystem: "file", web: "web" };
export const toolWord = (tool: string) => TOOL_WORDS[tool] ?? tool;

/** "Drive reads in /Board", "Gmail sends to @atmosphere.tv", "shell command npm test". */
export function labelFor(tool: string, verb: string, narrow: Narrow): string {
  const t = toolWord(tool);
  if (tool === "shell" && narrow.kind === "cmd") return `shell command "${narrow.value}"`;
  const v = verb ? `${verb}${verb.endsWith("s") ? "es" : "s"}` : "actions";
  const base = tool === "shell" ? `${t} ${verb} commands` : `${t} ${v}`;
  if (narrow.kind === "path") return `${base} in ${narrow.value}`;
  if (narrow.kind === "to") return `${base} to @${narrow.value}`;
  return base;
}
