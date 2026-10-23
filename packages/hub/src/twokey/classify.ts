import type { TwoKeyKind } from "@agent-room/shared";
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
export const CRM_READ_VERBS = ["read", "get", "list", "search", "find", "fetch", "query", "describe", "discover", "view", "show", "count", "check", "status", "lookup", "report", "reports", "retrieve", "history", "summarize", "summarise", "analyze", "analyse", "export", "download", "soql", "sosl", "readonly"];

const has = (set: string[]) => { const s = new Set(set); return (tokens: string[]) => tokens.some((t) => s.has(t)); };
const isEmail = has(EMAIL_CONNECTORS), isCrm = has(CRM_CONNECTORS), isShellWord = has(SHELL_WORDS), saysDelete = has(DELETE_VERBS), saysSend = has(SEND_VERBS), emailSafe = has(EMAIL_SAFE_WORDS), crmWrite = has(CRM_WRITE_VERBS), crmRead = has(CRM_READ_VERBS);

/** "mcp__Gmail__send_message" -> mcp gmail send message; "salesforceWrite" -> salesforce write. */
export function words(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const asObj = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);

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
  return typeof input === "string" && input.trim() ? input : undefined;
}

/** Words from a structured input that say what operation it is (op, operation, action, method). */
function opWords(input: unknown): string[] {
  const o = asObj(input); if (!o) return [];
  return ["op", "operation", "action", "method", "verb", "type"].flatMap((k) => (typeof o[k] === "string" ? words(o[k] as string) : []));
}

/**
 * Is this a two-key action? `tool` is the connector or tool id (gmail, salesforce, shell, filesystem...) or a tool's raw name, `action` what the agent
 * wants to do (a tool name from Claude Code's permission prompt, or the agent's own words), `input` the tool's input (an object) or the agent's detail (text).
 */
export function isTwoKey(tool: string, action: string, input?: unknown): TwoKeyClass {
  const toolTokens = words(tool);
  const nameTokens = [...toolTokens, ...words(action)];
  // The connector is the tool's own name. An agent's words only name one when the tool is a raw tool name (Claude Code's prompt) and says nothing else.
  const connectorTokens = tool === action || !toolTokens.length ? nameTokens : toolTokens;
  const tokens = [...nameTokens, ...opWords(input)];
  const readonly = tokens.includes("readonly") || tokens.some((t, i) => t === "read" && tokens[i + 1] === "only");

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
    if (saysDelete(nameTokens)) return { twoKey: true, kind: "delete", why: "the shell action says it deletes something" };
    return { twoKey: false, why: "a shell action that deletes nothing" };
  }

  if (isCrm(connectorTokens)) {
    if (readonly) return { twoKey: false, why: "a read-only CRM call" };
    if (saysDelete(tokens)) return { twoKey: true, kind: "crm", why: "deletes a CRM record" };
    if (crmWrite(tokens)) return { twoKey: true, kind: "crm", why: "writes to a CRM" };
    if (crmRead(tokens)) return { twoKey: false, why: "reads a CRM" };
    return { twoKey: true, kind: "crm", why: "a CRM action the tables don't know, so it is treated as a write" };
  }

  if (isEmail(connectorTokens)) {
    if (saysSend(tokens)) return { twoKey: true, kind: "email", why: "sends email" };
    if (saysDelete(tokens)) return { twoKey: true, kind: "delete", why: "deletes an email or thread" };
    if (emailSafe(tokens)) return { twoKey: false, why: "reads or files email without sending it" };
    return { twoKey: true, kind: "email", why: "an email action the tables don't know, so it is treated as a send" };
  }

  if (saysDelete(nameTokens)) return { twoKey: true, kind: "delete", why: "deletes something" };
  return { twoKey: false, why: "not an email send, a CRM write or a delete" };
}
