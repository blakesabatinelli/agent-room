/**
 * 2.1 Text helpers for lessons and playbook lines: cleaning what a model wrote so it is safe as one Markdown bullet,
 * and a normalised similarity used to deduplicate and merge.
 */

export const LESSON_MAX = 200;
export const PLAYBOOK_LINE_MAX = 240;

const STOP = new Set(["the", "and", "for", "that", "this", "with", "from", "when", "then", "than", "into", "your", "you", "are", "was", "were", "has", "have", "had", "not", "but", "its", "any", "all", "each", "before", "after", "always", "never", "task", "tasks", "agent"]);

/** Light stemming so "claiming", "claimed" and "claims" meet at "claim". */
function stem(w: string): string {
  let s = w;
  for (const suf of ["ing", "ed", "es", "ly", "s"]) if (s.length > suf.length + 3 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  return s;
}

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/\(from [^)]*\)/g, " ").split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

/** Lower-case, collapsed text without the `(from <goal>)` tail: what two bullets are compared on. */
export const normalize = (text: string) => text.toLowerCase().replace(/\(from [^)]*\)\s*$/, "").replace(/[^a-z0-9]+/g, " ").trim();

/** 0..1. Jaccard on stemmed words; a short line that sits inside a longer one counts nearly as much. */
export function similarity(a: string, b: string): number {
  if (normalize(a) === normalize(b)) return 1;
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  const jaccard = both / (A.size + B.size - both);
  const contained = Math.min(A.size, B.size) >= 3 ? 0.85 * (both / Math.min(A.size, B.size)) : 0;
  return Math.max(jaccard, contained);
}

/** Two lessons or lines this alike are the same thing. */
export const SAME = 0.7;

/**
 * One safe bullet: a single line, no Markdown structure, no tail that looks like our own `(from <goal>)` marker, and nothing that
 * could close or spoof the context block the hub wraps lessons in. Returns undefined when nothing usable is left.
 */
export function cleanLine(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/^[-*>#\d.)\s]+/, "").replace(/\s*\(from [^)]*\)\s*$/i, "").trim();
  if (s.length < 8) return undefined;
  if (/<!--|-->|agent-room:|^---$|```/.test(s)) return undefined;
  if (/ignore (all |any |the )?(previous|prior|above) (instructions|rules)/i.test(s)) return undefined;
  if (s.length > max) {
    const cut = s.slice(0, max);
    const at = cut.lastIndexOf(" ");
    s = (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:(-]+$/, "");
  }
  return s.length >= 8 ? s : undefined;
}

/** A task type as it is written in a `## heading` and matched against a task's type. */
export const cleanType = (t: unknown): string => String(t ?? "other").replace(/\s+/g, " ").replace(/[#\n\r]/g, "").trim().toLowerCase() || "other";

/** The playbook's file name for a task type, or undefined when the type can't be a file name. */
export function playbookSlug(taskType: string): string | undefined {
  const s = cleanType(taskType);
  return /^[a-z0-9][a-z0-9_-]*$/.test(s) ? s : undefined;
}

export const bytes = (s: string) => Buffer.byteLength(s);
