import type { TwoKeyDiff, TwoKeyDraft, TwoKeyWords } from "@agent-room/shared";
import { addressesOf, clip as rawClip, redact } from "./draft.js";
import { contentTokens, entitiesOf, entityDiff, maskEntities, similarity, squash, stripSignoff, wordDiff, type Entities, type EntityType } from "./text.js";

/**
 * 4.1 Do two independent drafts say the same thing?
 *
 * Exact where a difference is a different action: recipients, the CRM object, operation, record and every field and value, the delete targets.
 * Semantic where wording is free: an email's subject and body must be alike (similarity at or above the threshold) AND must carry the very same
 * numbers, dates, times, amounts, links and names. One date in one draft and not the other is a different email, however alike the words are.
 */

export interface Comparison {
  match: boolean;
  /** Email text, or the longest free-text CRM field: how alike the wording is, 0 to 1. */
  similarity?: number;
  diffs: TwoKeyDiff[];
  /** One plain sentence on what differs (or "The two drafts agree."). */
  why: string;
  words?: { a: TwoKeyWords[]; b: TwoKeyWords[] };
}

/** Everything this file puts on a card or in the table has its secrets removed first, then is cut. */
const clip = (s: string, n: number) => rawClip(redact(s), n);
const list = (xs: string[]) => (xs.length ? xs.join(", ") : "(none)");
const ENTITY_WORDS: Record<EntityType, string> = { number: "numbers", date: "dates", time: "times", amount: "amounts", link: "links or addresses", name: "names" };

/** Free text: similar enough, with the same entities. Returns the diffs and what to say. */
function compareText(a: { subject?: string; body: string }, b: { subject?: string; body: string }, threshold: number, field: string): { sim: number; diffs: TwoKeyDiff[]; problems: string[]; words?: { a: TwoKeyWords[]; b: TwoKeyWords[] } } {
  const bodyA = stripSignoff(a.body), bodyB = stripSignoff(b.body);
  const textA = `${a.subject ?? ""}\n${bodyA}`, textB = `${b.subject ?? ""}\n${bodyB}`;
  const sim = similarity(textA, textB);
  const merge = (x: Entities, y: Entities): Entities => ({ number: new Set([...x.number, ...y.number]), date: new Set([...x.date, ...y.date]), time: new Set([...x.time, ...y.time]), amount: new Set([...x.amount, ...y.amount]), link: new Set([...x.link, ...y.link]), name: new Set([...x.name, ...y.name]) });
  const ea = merge(entitiesOf(a.subject ?? ""), entitiesOf(bodyA, { names: true })), eb = merge(entitiesOf(b.subject ?? ""), entitiesOf(bodyB, { names: true }));
  const diffs: TwoKeyDiff[] = [], problems: string[] = [];
  const ok = sim >= threshold;
  const level = ok ? "minor" : "text";
  if (a.subject !== undefined && b.subject !== undefined && squash(a.subject) !== squash(b.subject)) diffs.push({ field: "subject", a: clip(squash(a.subject), 300), b: clip(squash(b.subject), 300), level });
  const sameBody = squash(bodyA) === squash(bodyB);
  if (!sameBody) diffs.push({ field, a: clip(squash(bodyA), 600), b: clip(squash(bodyB), 600), level });
  if (!ok) problems.push(`the wording is too different (${Math.round(sim * 100)}% alike, ${Math.round(threshold * 100)}% needed)`);
  for (const d of entityDiff(ea, eb)) {
    diffs.push({ field: `${d.label} in ${field}`, a: d.onlyA.join(", ") || "(none)", b: d.onlyB.join(", ") || "(none)", level: "entity" });
    problems.push(`the ${ENTITY_WORDS[d.type]} differ (${d.onlyA.length ? `only the first has ${clip(d.onlyA.join(", "), 60)}` : ""}${d.onlyA.length && d.onlyB.length ? "; " : ""}${d.onlyB.length ? `only the second has ${clip(d.onlyB.join(", "), 60)}` : ""})`);
  }
  const words = sameBody ? undefined : wordDiff(redact(bodyA), redact(bodyB)) ?? undefined;
  return { sim, diffs, problems, words };
}

// ---- CRM values

const NUMERIC = /^[$€£¥]?\s*-?\d[\d,]*(?:\.\d+)?\s*%?$/;
/** A CRM field value in a form two drafts agree on: numbers without commas or symbols, booleans, dates as ISO, text without extra spaces or case. */
export function normValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(normValue).sort().join("|")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).map((k) => `${k.toLowerCase().replace(/[^a-z0-9]/g, "")}=${normValue(o[k])}`).sort().join(",")}}`;
  }
  const s = squash(String(v));
  if (/^(true|false)$/i.test(s)) return s.toLowerCase();
  if (NUMERIC.test(s)) { const n = parseFloat(s.replace(/[$€£¥,%\s]/g, "")); if (Number.isFinite(n)) return `${n}${s.endsWith("%") ? "%" : ""}`; }
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})(?:[t ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(z|[+-]\d{2}:?\d{2})?)?$/i);
  if (iso) return iso[2] ? `${iso[1]}T${iso[2]}${(iso[3] ?? "").toLowerCase()}` : iso[1];
  if (s.length <= 24) { const e = entitiesOf(s); if (e.date.size === 1 && !e.number.size && !e.time.size && !e.amount.size) return [...e.date][0]; }
  return s.toLowerCase();
}
const fieldKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const show = (v: unknown) => (v === undefined ? "(not set)" : v === null || v === "" ? "(empty)" : clip(typeof v === "string" ? v : JSON.stringify(v), 300));
const FREE_TEXT = 80;

function compareCrm(a: Extract<TwoKeyDraft, { kind: "crm" }>, b: Extract<TwoKeyDraft, { kind: "crm" }>, threshold: number): Comparison {
  const diffs: TwoKeyDiff[] = [], problems: string[] = [];
  const obj = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (obj(a.object) !== obj(b.object)) { diffs.push({ field: "object", a: a.object, b: b.object, level: "critical" }); problems.push("they write to different CRM objects"); }
  if (a.op !== b.op) { diffs.push({ field: "operation", a: a.op, b: b.op, level: "critical" }); problems.push("they do different operations"); }
  const sameId = (x?: string, y?: string) => (x ?? "") === (y ?? "") || (!!x && !!y && x.length >= 15 && y.length >= 15 && x.slice(0, 15) === y.slice(0, 15));
  if (!sameId(a.id, b.id)) { diffs.push({ field: "record id", a: a.id ?? "(none)", b: b.id ?? "(none)", level: "critical" }); problems.push("they name different records"); }
  const fa = new Map(Object.entries(a.fields).map(([k, v]) => [fieldKey(k), [k, v] as const])), fb = new Map(Object.entries(b.fields).map(([k, v]) => [fieldKey(k), [k, v] as const]));
  let sim: number | undefined, words: Comparison["words"];
  for (const k of new Set([...fa.keys(), ...fb.keys()])) {
    const x = fa.get(k), y = fb.get(k);
    const name = (x ?? y)![0];
    if (!x || !y) { diffs.push({ field: `field ${name}`, a: show(x?.[1]), b: show(y?.[1]), level: "critical" }); problems.push(`only one sets ${name}`); continue; }
    const nx = normValue(x[1]), ny = normValue(y[1]);
    if (nx === ny) continue;
    if (typeof x[1] === "string" && typeof y[1] === "string" && nx.length >= FREE_TEXT && ny.length >= FREE_TEXT) {
      const t = compareText({ body: x[1] }, { body: y[1] }, threshold, `field ${name}`);
      sim = Math.min(sim ?? 1, t.sim); words ??= t.words;
      for (const d of t.diffs) diffs.push(d);
      problems.push(...t.problems);
      continue;
    }
    diffs.push({ field: `field ${name}`, a: show(x[1]), b: show(y[1]), level: "critical" });
    problems.push(`${name} differs`);
  }
  const blocking = diffs.some((d) => d.level !== "minor");
  return { match: !blocking, similarity: sim, diffs, why: blocking ? sentence(problems) : "The two drafts agree.", words };
}

function compareDelete(a: Extract<TwoKeyDraft, { kind: "delete" }>, b: Extract<TwoKeyDraft, { kind: "delete" }>): Comparison {
  const diffs: TwoKeyDiff[] = [];
  if (a.unparsed) {
    diffs.push({ field: "targets", a: `${list(a.targets)} (and whatever ${a.unparsed} reaches)`, b: list(b.targets), level: "critical" });
    return { match: false, diffs, why: `The first request deletes more than it lists (${a.unparsed}), so it can't be checked against a list.` };
  }
  const sa = new Set(a.targets), sb = new Set(b.targets);
  const onlyA = a.targets.filter((t) => !sb.has(t)), onlyB = b.targets.filter((t) => !sa.has(t));
  if (onlyA.length || onlyB.length) {
    diffs.push({ field: "targets", a: list(onlyA), b: list(onlyB), level: "critical" });
    return { match: false, diffs, why: `They don't delete the same things (${onlyA.length ? `only the first deletes ${clip(onlyA.join(", "), 80)}` : ""}${onlyA.length && onlyB.length ? "; " : ""}${onlyB.length ? `only the second deletes ${clip(onlyB.join(", "), 80)}` : ""}).` };
  }
  return { match: true, diffs, why: "The two drafts agree." };
}

function sentence(problems: string[]): string {
  const s = problems.slice(0, 3).join("; ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}${problems.length > 3 ? `; and ${problems.length - 3} more` : ""}.`;
}

/** Compare two drafts of the same kind. */
export function compareDrafts(a: TwoKeyDraft, b: TwoKeyDraft, threshold: number): Comparison {
  // An email or CRM request that carries fields the hub does not compare (attachments, headers, a second body...) can't be checked against a draft: the owner decides.
  if ((a.kind === "email" || a.kind === "crm") && a.unparsed) return { match: false, diffs: [{ field: "request", a: a.unparsed, b: "(the other draft has no such fields)", level: "critical" }], why: `The first request has more in it than the drafts compare (${a.unparsed}), so the owner decides.` };
  if (a.kind === "email" && b.kind === "email") {
    const diffs: TwoKeyDiff[] = [], problems: string[] = [];
    for (const [f, label] of [["to", "recipients"], ["cc", "cc"], ["bcc", "bcc"]] as const) {
      const x = addressesOf(a[f] ?? []), y = addressesOf(b[f] ?? []);
      if (x.join("\0") !== y.join("\0")) { diffs.push({ field: f, a: list(x), b: list(y), level: "critical" }); problems.push(`the ${label} differ`); }
    }
    const t = compareText(a, b, threshold, "body");
    diffs.push(...t.diffs); problems.push(...t.problems);
    const blocking = diffs.some((d) => d.level !== "minor");
    return { match: !blocking, similarity: t.sim, diffs, why: blocking ? sentence(problems) : "The two drafts agree.", words: t.words };
  }
  if (a.kind === "crm" && b.kind === "crm") return compareCrm(a, b, threshold);
  if (a.kind === "delete" && b.kind === "delete") return compareDelete(a, b);
  return { match: false, diffs: [{ field: "kind", a: a.kind, b: b.kind, level: "critical" }], why: "The drafts are not the same kind of action." };
}

/** A stable key for a draft: what a one-time permit is matched on. Wording, case and spacing don't change it; recipients, records and targets do. */
export function draftKey(d: TwoKeyDraft): string {
  // Every compared field, and the words as written (case and spacing aside): "do not" and "do" are not the same draft.
  if (d.kind === "email") return `email|${addressesOf(d.to).join(",")}|${addressesOf(d.cc).join(",")}|${addressesOf(d.bcc ?? []).join(",")}|${squash(d.subject).toLowerCase()}|${squash(stripSignoff(d.body)).toLowerCase()}|${d.unparsed ?? ""}`;
  if (d.kind === "crm") return `crm|${d.object.toLowerCase().replace(/[^a-z0-9]/g, "")}|${d.op}|${d.id ?? ""}|${Object.entries(d.fields).map(([k, v]) => `${fieldKey(k)}=${normValue(v)}`).sort().join(";")}|${d.unparsed ?? ""}`;
  return `delete|${[...d.targets].sort().join("\0")}|${d.unparsed ?? ""}`;
}
