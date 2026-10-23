import { TOOLS, type TwoKeyKind } from "@agent-room/shared";
import { scanShell, type ShellScan } from "./shell.js";

/**
 * 4.1 Which actions are two-key. Table-driven: the lists below are the whole policy.
 *
 *  - email    sending, replying or forwarding through an email connector (gmail, outlook, smtp...). Drafts, labels and reads are not.
 *  - crm      any write to a CRM connector (salesforce, hubspot...): create, update, upsert, merge, log, convert, delete. Reads are not.
 *  - delete   deleting ANYTHING: a file (through the broker, or `rm` and its kin in a shell), an email or thread, a calendar event, a Drive file,
 *             a message. Any tool whose name or action says delete, remove, trash, destroy, purge...
 *
 * Unsure means two-key: a shell command that cannot be read with confidence, and a connector call with a verb the tables don't know, are
 * treated as the dangerous kind. A false alarm costs one extra draft; a miss lets an action through on one agent's word.
 * (`readonly` in a tool's name, like Salesforce's `dispatch_readonly`, is a promise that it writes nothing.)
 */

export interface TwoKeyClass {
  twoKey: boolean;
  kind?: TwoKeyKind;
  /** One plain sentence for the audit log and the card. */
  why: string;
  /** For a shell command: what the scan found. */
  shell?: ShellScan;
  /** The shell command that was scanned. */
  command?: string;
}

// ---- the tables

/** Words (tokens of the tool's name and the action) that say a connector is email. */
export const EMAIL_CONNECTORS = ["gmail", "outlook", "email", "emails", "mail", "smtp", "sendgrid", "mailgun", "postmark", "mailchimp", "exchange"];
/** Words that say a connector is a CRM. */
export const CRM_CONNECTORS = ["salesforce", "sfdc", "hubspot", "pipedrive", "zoho", "dynamics", "crm", "sugarcrm", "insightly", "copper", "freshsales", "attio", "highrise"];
/** Words that say a tool runs shell commands. */
export const SHELL_WORDS = ["shell", "bash", "sh", "zsh", "exec", "execute", "terminal", "cmd", "powershell", "pwsh", "command", "run"];
/** Deleting, on any tool. */
export const DELETE_VERBS = ["delete", "deleted", "deleting", "deletes", "remove", "removes", "removed", "removing", "trash", "trashed", "destroy", "destroyed", "purge", "purged", "erase", "erased", "unlink", "rm", "rmdir", "wipe", "truncate", "uninstall", "unpublish"];
/** Email that leaves the building. */
export const SEND_VERBS = ["send", "sends", "sending", "reply", "replies", "replyall", "forward", "forwards", "fwd", "deliver", "broadcast", "blast", "compose"];
/** Email actions that stay inside the mailbox. */
export const EMAIL_SAFE_WORDS = ["read", "get", "list", "search", "find", "fetch", "draft", "drafts", "label", "labels", "unlabel", "spam", "unspam", "view", "download", "lookup", "query", "show", "check", "count", "thread", "threads", "history", "profile", "attachment"];
/** Writing to a CRM. */
export const CRM_WRITE_VERBS = ["create", "creates", "insert", "update", "updates", "upsert", "merge", "patch", "set", "add", "log", "write", "writes", "convert", "assign", "dispatch", "post", "put", "save", "edit", "modify", "change", "submit", "import", "sync", "push", "close", "reopen", "mark", "move", "transfer", "manage", "execute", "apply", "link", "unlink", "enroll", "unenroll", "delete"];
/** Reading a CRM. */
export const CRM_READ_VERBS = ["read", "get", "list", "search", "find", "fetch", "query", "describe", "discover", "view", "show", "count", "check", "status", "lookup", "report", "reports", "retrieve", "history", "summarize", "summarise", "analyze", "analyse", "export", "download", "soql", "sosl"];

const has = (set: string[]) => { const s = new Set(set); return (tokens: string[]) => tokens.some((t) => s.has(t)); };
/** A connector is named when any word contains one of its names: "webmail" is email, "zohocrm" is a CRM, and "pipedrive" is a CRM and not Google Drive. */
const hasPart = (set: string[]) => (tokens: string[]) => tokens.some((t) => set.some((c) => t.includes(c)));
/** Moving or renaming a file removes it from where it was and can overwrite what is at the other end. */
export const MOVE_VERBS = ["move", "moved", "moves", "moving", "rename", "renamed", "renames", "renaming", "mv"];
const isEmail = hasPart(EMAIL_CONNECTORS), isCrm = hasPart(CRM_CONNECTORS), isShellWord = has(SHELL_WORDS), saysDelete = has(DELETE_VERBS), saysMove = has(MOVE_VERBS), saysSend = has(SEND_VERBS), emailSafe = has(EMAIL_SAFE_WORDS), crmWrite = has(CRM_WRITE_VERBS), crmRead = has(CRM_READ_VERBS);

/** "mcp__Gmail__send_message" -> mcp gmail send message; "salesforceWrite" -> salesforce write. */
export function words(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Which of the hub's tools (gmail, drive, shell...) a raw tool name stands for. Matched on whole words, never on letters inside a word:
 * `mcp__pipedrive__update_deal` is not Google Drive, and `webmail` is not the web.
 */
export function toolIdOf(toolName: string): string {
  const w = words(toolName);
  return TOOLS.find((t) => w.includes(t.id) || (t.id === "shell" && toolName === "Bash"))?.id ?? toolName;
}

const asObj = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);

/** The structured input of a request: the object itself, or the agent's detail when that is a JSON object. */
export function parsedInput(detail: string, input: unknown): unknown {
  if (asObj(input)) return input;
  const t = detail.trim();
  if (!t.startsWith("{")) return undefined;
  try { return JSON.parse(t) as unknown; } catch { return undefined; }
}

/** The shell command in a request, if it carries one. */
export function commandOf(input: unknown): string | undefined {
  const o = asObj(input);
  if (o) {
    for (const k of ["command", "cmd", "script", "commands", "code"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v;
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) return (v as string[]).join(k === "commands" ? "\n" : " ");
    }
    return undefined;
  }
  if (Array.isArray(input) && input.length && input.every((x) => typeof x === "string")) return (input as string[]).join(" ");
  return typeof input === "string" && input.trim() ? input : undefined;
}

const OP_KEYS = new Set(["op", "operation", "action", "method", "verb", "type"]);
/**
 * Words from a structured input that say what operation it is (op, operation, action, method...), at any depth. The agent writes them, so they can
 * only make a call two-key (a write verb) and never make one safe.
 */
function opWords(input: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (Array.isArray(input)) return input.slice(0, 20).flatMap((x) => opWords(x, depth + 1));
  const o = asObj(input); if (!o) return [];
  return Object.entries(o).slice(0, 60).flatMap(([k, v]) => (OP_KEYS.has(k.toLowerCase()) && typeof v === "string" ? words(v) : typeof v === "object" ? opWords(v, depth + 1) : []));
}

const BODY_KEYS = ["content", "contents", "text", "data", "body", "new_source"];
/** A file tool (Claude Code's Write) given an empty body: the file is emptied. */
function emptyWrite(nameTokens: string[], input: unknown): { path: string } | undefined {
  const o = asObj(input);
  if (!o || !nameTokens.some((t) => ["write", "overwrite", "save", "put"].includes(t))) return undefined;
  const k = BODY_KEYS.find((x) => typeof o[x] === "string" && !(o[x] as string).trim());
  if (!k) return undefined;
  const path = ["file_path", "path", "filepath", "filename", "file", "notebook_path"].map((x) => o[x]).find((x) => typeof x === "string") as string | undefined;
  return { path: path ?? "(a file)" };
}

function crmClass(nameTokens: string[], opTokens: string[]): TwoKeyClass {
  const tokens = [...nameTokens, ...opTokens];
  // `readonly` is the tool's own promise, read from its name only; a write verb in the input beats it (an agent can't talk its way into a read-only call)
  const readonly = nameTokens.includes("readonly") || nameTokens.some((t, i) => t === "read" && nameTokens[i + 1] === "only");
  if (readonly && !crmWrite(opTokens) && !saysDelete(opTokens)) return { twoKey: false, why: "a read-only CRM call" };
  if (saysDelete(tokens)) return { twoKey: true, kind: "crm", why: "deletes a CRM record" };
  if (crmWrite(tokens)) return { twoKey: true, kind: "crm", why: "writes to a CRM" };
  if (crmRead(nameTokens)) return { twoKey: false, why: "reads a CRM" };
  return { twoKey: true, kind: "crm", why: "a CRM action the tables don't know, so it is treated as a write" };
}

function emailClass(nameTokens: string[], opTokens: string[]): TwoKeyClass {
  const tokens = [...nameTokens, ...opTokens];
  if (saysSend(tokens)) return { twoKey: true, kind: "email", why: "sends email" };
  if (saysDelete(tokens)) return { twoKey: true, kind: "delete", why: "deletes an email or thread" };
  if (emailSafe(nameTokens)) return { twoKey: false, why: "reads or files email without sending it" };
  return { twoKey: true, kind: "email", why: "an email action the tables don't know, so it is treated as a send" };
}

/**
 * Is this a two-key action? `tool` is the connector or tool id (gmail, salesforce, shell, filesystem...) or a tool's raw name, `action` what the agent
 * wants to do (a tool name from Claude Code's permission prompt, or the agent's own words), `input` the tool's input (an object) or the agent's detail (text).
 *
 * The one classifier, for every caller (the two-key gate, the policy layer, the learning loop, auto-approval). It reads the union of the words of the
 * tool and of the action, and says two-key as soon as any reading does: a connector named in either place counts.
 */
export function isTwoKey(tool: string, action: string, input?: unknown): TwoKeyClass {
  const toolTokens = words(tool);
  const nameTokens = [...toolTokens, ...words(action)];
  const opTokens = opWords(input);
  const tokens = [...nameTokens, ...opTokens];

  // Shell: what the command does decides; the words around it only say that it is a shell.
  const cmd = commandOf(input);
  const shellTool = tool.toLowerCase() === "shell" || action === "Bash" || (!!asObj(input) && !!cmd && isShellWord(nameTokens));
  if (shellTool) {
    const command = cmd ?? (action.trim().length > 4 ? action : undefined);
    if (command) {
      const scan = scanShell(command);
      if (scan.deletes.length) {
        const names = [...new Set(scan.deletes.map((d) => d.program))].join(", ");
        return { twoKey: true, kind: "delete", why: `the shell command deletes files (${names})`, shell: scan, command };
      }
      if (scan.unsure.length) return { twoKey: true, kind: "delete", why: `the shell command can't be read with confidence (${scan.unsure[0]}), so it is treated as a delete`, shell: scan, command };
      return { twoKey: false, why: "a shell command that deletes nothing", shell: scan, command };
    }
    const o = asObj(input);
    if (o && Object.keys(o).length) { // a shell request with no command where the hub looks for one
      const scan: ShellScan = { deletes: [], unsure: ["the command is not where the hub expects it"] };
      return { twoKey: true, kind: "delete", why: `the shell request can't be read with confidence (${scan.unsure[0]}), so it is treated as a delete`, shell: scan, command: JSON.stringify(o).slice(0, 500) };
    }
    if (saysDelete(nameTokens)) return { twoKey: true, kind: "delete", why: "the shell action says it deletes something" };
    return { twoKey: false, why: "a shell action that deletes nothing" };
  }

  const crm = isCrm(nameTokens) ? crmClass(nameTokens, opTokens) : undefined;
  const email = isEmail(nameTokens) ? emailClass(nameTokens, opTokens) : undefined;
  // The tool's own name says which connector it is when both are named: a Gmail call that mentions a CRM is still the email one.
  const found = (isEmail(toolTokens) || !isCrm(toolTokens) ? [email, crm] : [crm, email]).filter((x): x is TwoKeyClass => !!x);
  const hit = found.find((x) => x.twoKey);
  if (hit) return hit;
  if (found.length) return found[0];

  if (saysDelete(tokens)) return { twoKey: true, kind: "delete", why: "deletes something" };
  if (saysMove(tokens)) return { twoKey: true, kind: "delete", why: "moves or renames something, which removes it from where it was and can overwrite what is there" };
  const empty = emptyWrite(nameTokens, input);
  if (empty) {
    const scan: ShellScan = { deletes: [{ program: "a write of nothing", targets: [empty.path], opaque: true }], unsure: [] };
    return { twoKey: true, kind: "delete", why: "writes nothing over a file, which empties it", shell: scan, command: `write ${empty.path}` };
  }
  return { twoKey: false, why: "not an email send, a CRM write or a delete" };
}
