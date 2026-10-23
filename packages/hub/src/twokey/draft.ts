import { isAbsolute, resolve } from "node:path";
import type { TwoKeyDraft, TwoKeyKind } from "@agent-room/shared";
import { extractJson } from "../orchestrator/json.js";
import { words, type TwoKeyClass } from "./classify.js";
import { scanShell } from "./shell.js";

/**
 * 4.1 Drafts: reading what an agent wants to do as a structured draft, and keeping secrets out of what is stored or shown.
 *
 *   email   {to[], cc[], subject, body}  (bcc when given)
 *   crm     {object, op, id?, fields}
 *   delete  {targets[]}
 *
 * The first agent's draft is read from the request itself (Claude Code's tool input, or the agent's own detail text: JSON, or `To:`/`Subject:` lines).
 * The second agent's draft is read from its reply. A reply that is not a draft is never guessed at.
 */

type Obj = Record<string, unknown>;
const asObj = (x: unknown): Obj | undefined => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : undefined);
const key = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The first value in an object whose key (ignoring case, underscores and dashes) is one of `names`. */
function pick(o: Obj, names: string[]): unknown {
  const want = new Set(names.map(key));
  for (const k of Object.keys(o)) if (want.has(key(k))) return o[k];
  return undefined;
}
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);

// ---- addresses and targets

/** Addresses in any shape (a string, a list, "Name <a@b.c>", {email}), lowercased, unique, sorted. */
export function addressesOf(v: unknown): string[] {
  const out = new Set<string>();
  const add = (x: unknown) => {
    if (x == null) return;
    if (Array.isArray(x)) { x.forEach(add); return; }
    const o = asObj(x);
    if (o) { add(pick(o, ["email", "address", "emailAddress", "mail"]) ?? pick(o, ["name"])); return; }
    const s = String(x);
    const found = s.match(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
    if (found) found.forEach((f) => out.add(f.toLowerCase()));
    else for (const part of s.split(/[;,]/)) if (part.trim()) out.add(part.trim().toLowerCase());
  };
  add(v);
  return [...out].sort();
}

/** Paths resolved against `base` (when it is given), without a trailing slash, unique and sorted. Things that are not paths (`branch:x`, `thread:1`) are kept as written. */
export function targetsOf(list: unknown[], base?: string): string[] {
  const out = new Set<string>();
  for (const t of list) {
    const s = str(t)?.trim(); if (!s) continue;
    if (/^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) { out.add(s); continue; } // gmail:thread:1, branch:x
    if (/[$`]/.test(s)) { out.add(s); continue; }
    const p = base || isAbsolute(s) ? resolve(base ?? "/", s) : s.replace(/^\.\//, "");
    out.add(p.length > 1 ? p.replace(/\/+$/, "") : p);
  }
  return [...out].sort();
}

// ---- reading a request

const stripHtml = (h: string) => h.replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Every key an email request may use, by part. A request with any other key carries something the hub does not compare. */
const EMAIL_KEYS = {
  to: ["to", "recipients", "recipient", "toAddresses", "to_addresses", "sendTo", "emails", "email", "address"],
  cc: ["cc", "ccAddresses", "cc_addresses"],
  bcc: ["bcc", "bccAddresses", "bcc_addresses"],
  body: ["body", "message", "text", "content", "plainBody", "textBody", "messageBody", "emailBody", "htmlBody", "html", "bodyText"],
  subject: ["subject", "title"],
};
/** The values of every key whose name (ignoring case, underscores and dashes) is one of `names`. */
function pickAll(o: Obj, names: string[]): unknown[] {
  const want = new Set(names.map(key));
  return Object.keys(o).filter((k) => want.has(key(k))).map((k) => o[k]);
}
/** Keys of `o` that are none of `groups`' names. */
function keysOutside(o: Obj, ...groups: string[][]): string[] {
  const known = new Set(groups.flat().map(key));
  return Object.keys(o).filter((k) => !known.has(key(k)));
}
const distinct = (xs: string[]) => { const seen = new Set<string>(); return xs.filter((x) => { const k = x.replace(/\s+/g, " ").trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };

/**
 * An email draft from an object with email-ish keys, or undefined when it has neither a recipient nor a body. Every recipient, subject and body-like key
 * is read (a request with `body` and `html` sends both), and a key the hub doesn't know (attachments, from, replyTo, headers...) marks the draft `unparsed`,
 * so it can never match and the owner decides.
 */
export function emailFrom(o: Obj): TwoKeyDraft | undefined {
  const to = addressesOf(pickAll(o, EMAIL_KEYS.to));
  const cc = addressesOf(pickAll(o, EMAIL_KEYS.cc));
  const bcc = addressesOf(pickAll(o, EMAIL_KEYS.bcc));
  const body = distinct(pickAll(o, EMAIL_KEYS.body).map((v) => { const b = str(v) ?? ""; return (/<\/?[a-z][\s\S]*>/i.test(b) ? stripHtml(b) : b).trim(); })).join("\n\n");
  const subject = distinct(pickAll(o, EMAIL_KEYS.subject).map((v) => (str(v) ?? "").trim())).join(" / ");
  if (!to.length && !body.trim()) return undefined;
  const extra = keysOutside(o, EMAIL_KEYS.to, EMAIL_KEYS.cc, EMAIL_KEYS.bcc, EMAIL_KEYS.body, EMAIL_KEYS.subject);
  return { kind: "email", to, cc, ...(bcc.length ? { bcc } : {}), subject, body: body.trim(), ...(extra.length ? { unparsed: `the request also sets ${extra.slice(0, 4).map((k) => clip(k, 30)).join(", ")}${extra.length > 4 ? " and more" : ""}` } : {}) };
}

const CRM_OPS: [RegExp, "create" | "update" | "upsert" | "delete"][] = [[/delete|remove|destroy|purge/, "delete"], [/upsert/, "upsert"], [/create|insert|add|new|post/, "create"], [/update|patch|modify|edit|set|put|change|merge/, "update"]];
export function crmOp(text: unknown): "create" | "update" | "upsert" | "delete" | undefined {
  const s = str(text)?.toLowerCase(); if (!s) return undefined;
  for (const [re, op] of CRM_OPS) if (re.test(s)) return op;
  return undefined;
}
const CRM_META = ["object", "sobject", "sobjectType", "objectType", "objectName", "entity", "type", "resource", "table", "op", "operation", "action", "method", "verb", "id", "recordId", "objectId"];
const CRM_BOX = ["fields", "data", "record", "values", "attributes", "properties", "payload", "changes", "body"];
/** A CRM draft from an object with object/op/id/fields keys. `hint` says the operation when the object doesn't (the tool's name). */
export function crmFrom(o: Obj, hint?: string): TwoKeyDraft | undefined {
  const object = str(pick(o, ["object", "sobject", "sobjectType", "objectType", "objectName", "entity", "type", "resource", "table"]))?.trim();
  if (!object) return undefined;
  const op = crmOp(pick(o, ["op", "operation", "action", "method", "verb"])) ?? crmOp(hint);
  if (!op) return undefined;
  const boxKey = actualKey(o, CRM_BOX), box = boxKey !== undefined ? asObj(o[boxKey]) : undefined;
  const meta = new Set(CRM_META.map(key));
  const fields: Obj = box ? { ...box } : Object.fromEntries(Object.entries(o).filter(([k]) => !meta.has(key(k))));
  // A record's id may sit inside the fields (Salesforce's Id): it names the record, it is not a change to it.
  let id = str(pick(o, ["id", "recordId", "objectId"]))?.trim();
  const inner = Object.keys(fields).find((k) => key(k) === "id");
  if (inner !== undefined) { id ??= str(fields[inner])?.trim(); delete fields[inner]; }
  // With the fields in a box, any other key is something the hub does not compare (a second box, a flag, a header...)
  const extra = box ? Object.keys(o).filter((k) => k !== boxKey && !meta.has(key(k))) : [];
  return { kind: "crm", object, op, ...(id ? { id } : {}), fields, ...(extra.length ? { unparsed: `the request also sets ${extra.slice(0, 4).map((k) => clip(k, 30)).join(", ")}${extra.length > 4 ? " and more" : ""}` } : {}) };
}

/** A delete draft from an object naming what goes. */
export function deleteFrom(o: Obj, base?: string): TwoKeyDraft | undefined {
  const list: unknown[] = [];
  for (const k of ["targets", "paths", "files", "path", "file", "filename", "ids", "messageIds", "threadIds", "messageId", "threadId", "id", "eventId", "name"]) {
    const v = pick(o, [k]);
    if (v === undefined) continue;
    if (Array.isArray(v)) list.push(...v); else list.push(v);
  }
  const targets = targetsOf(list, base);
  return targets.length ? { kind: "delete", targets } : undefined;
}

/** `Key: value` lines, the way an agent writes an email in plain text. The body is everything after `Body:` or the first blank line. */
function emailFromText(t: string): TwoKeyDraft | undefined {
  const m = (name: string) => t.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "im"))?.[1]?.trim();
  const to = m("to"); if (!to) return undefined;
  const bodyAt = t.search(/^\s*body\s*:/im);
  let body = "";
  if (bodyAt >= 0) body = t.slice(bodyAt).replace(/^\s*body\s*:\s*/i, "");
  else { const blank = t.search(/\n\s*\n/); body = blank >= 0 ? t.slice(blank) : ""; }
  return emailFrom({ to, cc: m("cc") ?? "", bcc: m("bcc") ?? "", subject: m("subject") ?? "", body });
}

export interface RequestDraft {
  /** null: the request could not be read as a draft. */
  draft: TwoKeyDraft | null;
  /** The request as it came in, secrets removed, cut short. */
  raw: string;
}

/** The first agent's draft, read from its request. */
export function draftFromRequest(cls: TwoKeyClass, tool: string, action: string, detail: string, input: unknown, cwd?: string): RequestDraft {
  const kind = cls.kind as TwoKeyKind;
  const parsedDetail = (() => { const j = detail.trim().startsWith("{") ? extractJson<Obj>(detail) : null; return j ?? undefined; })();
  const obj = asObj(input) ?? parsedDetail;
  const raw = clip(redact(obj ? JSON.stringify(obj) : detail || action), 1500);
  let draft: TwoKeyDraft | undefined;
  if (kind === "delete") {
    const scan = cls.shell ?? (cls.command ? scanShell(cls.command) : undefined);
    if (scan) {
      const targets = targetsOf(scan.deletes.flatMap((d) => d.targets), cwd);
      const opaque = scan.deletes.some((d) => d.opaque) || scan.unsure.length > 0;
      draft = { kind: "delete", targets, ...(opaque ? { unparsed: scan.unsure[0] ?? scan.deletes.find((d) => d.opaque)?.program ?? "a command that deletes things it does not list" } : {}) };
    } else if (obj) draft = deleteFrom(obj, cwd);
  } else if (kind === "email") {
    if (obj) draft = emailFrom(obj);
    else if (detail) draft = emailFromText(detail);
  } else if (kind === "crm") {
    const hint = [...words(tool), ...words(action)].join(" ");
    if (obj) draft = crmFrom(obj, hint);
  }
  return { draft: draft ?? null, raw };
}

/** What a second agent said: a draft, "no action", or something that is neither. */
export type Reply = { draft: TwoKeyDraft } | { none: string } | { error: string };

/** Read the second agent's reply as a draft of `kind`. `cwd` resolves delete targets the way the first draft's were. */
export function parseReply(kind: TwoKeyKind, text: string, cwd?: string): Reply {
  const t = text.trim();
  if (/^["'`*_\s]*no[\s_-]*action\b/i.test(t) && !t.includes("{")) return { none: clip(t.replace(/^["'`*_\s]*no[\s_-]*action[:.\s-]*/i, ""), 300) || "no reason given" };
  const o = extractJson<Obj>(t);
  if (!o) return { error: "the reply is not JSON" };
  const act = str(pick(o, ["action"])), none = pick(o, ["no_action", "noAction", "none"]);
  if (none === true || (act && /^(none|no[\s_-]*action|no|skip|nothing)$/i.test(act.trim()))) return { none: clip(str(pick(o, ["reason", "why", "explanation"])) ?? "no reason given", 300) };
  const inner = asObj(pick(o, ["draft"])) ?? o;
  let d: TwoKeyDraft | undefined;
  if (kind === "email") d = emailFrom(inner);
  else if (kind === "crm") d = crmFrom(inner, str(pick(inner, ["op", "operation"])));
  else {
    const list = pick(inner, ["targets", "paths", "files"]);
    if (Array.isArray(list)) { const targets = targetsOf(list, cwd); d = { kind: "delete", targets }; }
    else d = deleteFrom(inner, cwd);
    if (d && d.kind === "delete" && !d.targets.length) return { none: "it listed nothing to delete" };
  }
  // What the second agent adds to its reply (a reason, an action word) is not part of the draft; only the first request's extra fields count against a match.
  if (d && d.kind !== "delete") delete d.unparsed;
  return d ? { draft: d } : { error: `the reply has no ${kind} draft in it` };
}

// ---- keeping secrets out

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(password|passwd|pwd|passcode|secret|token|api[_-]?key|access[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
];
/** A Salesforce session id: the 15 or 18 character org id (it starts 00D), a bang, then the token. */
const SALESFORCE_SESSION = /\b00[Dd][A-Za-z0-9]{12,15}![A-Za-z0-9._-]{16,}/g;
/** A long run of base64 or hex characters: a token, a key or a session secret whatever its prefix. It needs digits and letters, and mixed case or hex only, so words and identifiers survive. */
const LONG_TOKEN = /[A-Za-z0-9+_-]{32,}={0,2}/g;
const looksRandom = (t: string) => /\d/.test(t) && /[A-Za-z]/.test(t) && ((/[a-z]/.test(t) && /[A-Z]/.test(t)) || /^[0-9a-f]+$/i.test(t.replace(/=+$/, "")));
/** Replace anything that looks like a credential. */
export function redact(s: string): string {
  let out = s;
  for (const re of SECRETS) out = out.replace(re, (m, k, sep) => (typeof k === "string" && typeof sep === "string" ? `${k}${sep}[secret removed]` : "[secret removed]"));
  out = out.replace(SALESFORCE_SESSION, "[secret removed]");
  return out.replace(LONG_TOKEN, (t) => (looksRandom(t) ? "[secret removed]" : t));
}
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 3))}...` : s);

/** A draft as it may be kept and shown: secrets removed, long bodies and field values cut. */
export function safeDraft(d: TwoKeyDraft | null, maxBody = 6000): TwoKeyDraft | null {
  if (!d) return null;
  if (d.kind === "email") return { ...d, subject: clip(redact(d.subject), 300), body: clip(redact(d.body), maxBody) };
  if (d.kind === "crm") return { ...d, fields: JSON.parse(redact(JSON.stringify(d.fields, (_k, v) => (typeof v === "string" ? clip(v, 2000) : v)))) as Obj };
  return { ...d, targets: d.targets.slice(0, 200).map((t) => clip(redact(t), 500)) };
}

/** One line for the audit log. An email's body is cut to a few words. */
export function brief(d: TwoKeyDraft | null): string {
  if (!d) return "(no draft)";
  if (d.kind === "email") return `to=${d.to.join(",") || "-"}${d.cc.length ? ` cc=${d.cc.join(",")}` : ""} subject=${JSON.stringify(clip(redact(d.subject), 60))} body=${JSON.stringify(clip(redact(d.body).replace(/\s+/g, " "), 80))}`;
  if (d.kind === "crm") return `${d.op} ${d.object}${d.id ? ` ${d.id}` : ""} fields=${clip(redact(Object.keys(d.fields).join(",")), 120)}`;
  return `delete ${clip(redact(d.targets.join(", ")), 200)}${d.unparsed ? ` (+ ${d.unparsed})` : ""}`;
}

// ---- running the other agent's draft

const actualKey = (o: Obj, names: string[]) => { const want = new Set(names.map(key)); return Object.keys(o).find((k) => want.has(key(k))); };

/**
 * The tool input of a request with draft B's content put in, for Claude Code's `updatedInput` when the owner picked the other agent's draft.
 * Only when the whole input is B's: every key of the input is one the draft covers, each part has exactly one place, and B has a place for everything it says.
 * An input that carries anything else (html beside a body, attachments, from, replyTo, headers, a second recipient key) would run as a mix of A and B:
 * undefined, and the agent is told what to run instead. `hint` is the tool's name, which says the CRM operation when the input doesn't.
 */
export function overlayDraft(input: Obj, d: TwoKeyDraft, hint?: string): Obj | undefined {
  const out: Obj = { ...input };
  const once = (names: string[]) => Object.keys(input).filter((k) => names.map(key).includes(key(k))).length <= 1;
  const setList = (names: string[], values: string[], required: boolean): boolean => {
    const k = actualKey(out, names);
    if (k === undefined) return !required || !values.length;
    out[k] = Array.isArray(input[k]) ? values : values.join(", ");
    return true;
  };
  const setText = (names: string[], value: string): boolean => {
    const k = actualKey(out, names);
    if (k === undefined) return !value;
    out[k] = value;
    return true;
  };
  if (d.kind === "email") {
    if (keysOutside(input, EMAIL_KEYS.to, EMAIL_KEYS.cc, EMAIL_KEYS.bcc, EMAIL_KEYS.body, EMAIL_KEYS.subject).length) return undefined;
    if (!(Object.values(EMAIL_KEYS).every(once))) return undefined;
    const ok = setList(EMAIL_KEYS.to, d.to, true) && setList(EMAIL_KEYS.cc, d.cc, true) && setList(EMAIL_KEYS.bcc, d.bcc ?? [], true)
      && setText(EMAIL_KEYS.subject, d.subject) && setText(EMAIL_KEYS.body, d.body);
    return ok ? out : undefined;
  }
  if (d.kind === "crm") {
    const boxKey = actualKey(out, CRM_BOX.filter((x) => x !== "body"));
    if (boxKey === undefined || !asObj(out[boxKey])) return undefined;
    const meta = new Set(CRM_META.map(key));
    if (Object.keys(input).some((k) => k !== boxKey && !meta.has(key(k)))) return undefined;
    // the operation is A's: if B's differs, running B's fields under A's operation would be a third action
    const opKey = actualKey(input, ["op", "operation", "action", "method", "verb"]);
    if ((opKey !== undefined ? crmOp(input[opKey]) : crmOp(hint)) !== d.op) return undefined;
    // the record id sits beside the fields or inside them (Salesforce's Id), where A put it; B must name one when A's request did
    const innerId = Object.keys(asObj(input[boxKey])!).find((k) => key(k) === "id");
    const outerId = actualKey(input, ["id", "recordId", "objectId"]);
    if ((innerId !== undefined || outerId !== undefined) && d.id === undefined) return undefined;
    out[boxKey] = innerId !== undefined && d.id !== undefined ? { ...d.fields, [innerId]: d.id } : d.fields;
    const set =(names: string[], v: string | undefined) => { const k = actualKey(out, names); if (k !== undefined && v !== undefined) out[k] = v; };
    set(["object", "sobject", "sobjectType", "objectType", "objectName"], d.object);
    set(["id", "recordId"], d.id);
    return out;
  }
  return undefined;
}
