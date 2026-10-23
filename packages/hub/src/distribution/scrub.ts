// 4.7 Making crash reports safe to keep and to send. A report may name code (function names, file names inside the app), the
// platform and an error's kind. It must never carry what the user wrote or read: prompts, messages, file contents, names of folders
// outside the home folder, tokens. Everything here fails closed: when unsure, leave the text out.
import { homedir } from "node:os";

/** Replaces the home folder (and any other /Users/<name> or /home/<name>) with ~. */
export function scrubPaths(text: string, homes: string[] = [homedir(), process.env.HOME ?? ""]): string {
  let out = text;
  for (const h of [...new Set(homes.filter((x) => x.length > 1))].sort((a, b) => b.length - a.length)) out = out.split(h).join("~");
  return out.replace(/\/(?:Users|home)\/[^/\s:"'()<>]+/g, "~");
}

const SECRETS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "[key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[token]"],
  [/([?&;](?:token|access_token|key|api_key|apikey|code|secret|password|pass|auth|state)[A-Za-z_]*)=[^&\s"')]+/gi, "$1=[redacted]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  [/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b/g, "[tailnet-host]"],
  [/\b[0-9a-fA-F]{32,}\b/g, "[hex]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[long-token]"],
];

/** Removes anything that looks like a credential, an email address or a tailnet name. Run after scrubPaths. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
}

export const scrubText = (text: string, homes?: string[]) => scrubSecrets(scrubPaths(text, homes));

/** Built-in JavaScript error kinds: their messages are written by the engine, not by us or the user. */
const ENGINE_ERRORS = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError"]);
const SYSTEM_CODE = /^(?:E[A-Z]{2,15}|ERR_[A-Z0-9_]{2,60})$/;

/**
 * The part of an error message a report may keep. Messages from plain `Error`s and our own classes are withheld (they can quote a goal, a
 * task title or a file). Engine and system errors are kept with every quoted piece removed (those carry the data), paths and secrets scrubbed,
 * and the length capped.
 */
export function safeMessage(name: string, code: string | undefined, message: string, homes?: string[]): string {
  if (!ENGINE_ERRORS.has(name) && !(code && SYSTEM_CODE.test(code))) return "(message withheld)";
  const collapsed = message.replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, "<quoted>");
  return scrubText(collapsed, homes).replace(/\s+/g, " ").slice(0, 160).trim();
}

/** The "at ..." lines of a stack, scrubbed, never the first line (that is the message). At most 40, each at most 300 characters. */
export function safeFrames(stack: string | undefined, homes?: string[]): string[] {
  if (!stack) return [];
  return stack.split("\n").filter((l) => /^\s+at /.test(l)).slice(0, 40).map((l) => scrubText(l.trim(), homes).slice(0, 300));
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_$]{0,59}$/;
export const safeName = (n: unknown) => (typeof n === "string" && SAFE_NAME.test(n) ? n : "Error");
