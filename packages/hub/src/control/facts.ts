/**
 * Room MEMORY.md facts (CONTROL.md section 2): one bullet each,
 * `<fact> — source: <goal or owner>, expires: YYYY-MM-DD`.
 */
export interface Fact { text: string; source?: string; expires?: string; /** 1-based file line */ line: number }

const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;
const TAIL = /^(.*?)\s+(?:—|–|--)\s+source:\s*(.*?)\s*(?:,\s*expires:\s*(\d{4}-\d{2}-\d{2}))?\s*$/;

export function parseFacts(body: string, bodyLine: number): Fact[] {
  const out: Fact[] = [];
  body.split("\n").forEach((raw, i) => {
    const m = BULLET.exec(raw.replace(/\r$/, ""));
    if (!m) return;
    const t = TAIL.exec(m[1]);
    out.push(t ? { text: t[1].trim(), source: t[2] || undefined, expires: t[3], line: bodyLine + i } : { text: m[1].trim(), line: bodyLine + i });
  });
  return out;
}

export const expired = (f: Fact, today: string) => !!f.expires && f.expires < today;

const NEG = /\b(?:not|no|never|isn't|aren't|doesn't|don't|won't|cannot|can't|without)\b/gi;
const core = (t: string) => t.toLowerCase().replace(NEG, " ").replace(/[^a-z0-9: ]+/g, " ").replace(/\s+/g, " ").trim();
const negated = (t: string) => ((t.match(NEG) ?? []).length % 2) === 1;
const KEYED = /^([^:=]{2,60})[:=]\s*(.+)$/;

/**
 * Two facts contradict when they say the same thing with opposite polarity ("Budget is approved" and
 * "Budget is not approved"), or give different values for the same `key: value` ("Deadline: May 3" and
 * "Deadline: May 9"). A plain-text heuristic: it can miss contradictions, and it only flags clear ones.
 */
export function contradicts(a: string, b: string): boolean {
  const ca = core(a), cb = core(b);
  if (ca && ca === cb && negated(a) !== negated(b)) return true;
  const ka = KEYED.exec(a.trim()), kb = KEYED.exec(b.trim());
  if (ka && kb && ka[1].trim().toLowerCase() === kb[1].trim().toLowerCase()) return core(ka[2]) !== core(kb[2]) || negated(ka[2]) !== negated(kb[2]);
  return false;
}
