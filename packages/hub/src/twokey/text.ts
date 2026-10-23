import type { TwoKeyWords } from "@agent-room/shared";

/**
 * 4.1 Comparing free text. Two drafts of the same email are never word for word, so the check has two halves:
 *  - similarity: content words (no stop words, light stemming), Dice coefficient over the multisets, 0 to 1;
 *  - entities: every number, date, time, amount, link and name in one text must be in the other, and the other way round. Compared exactly.
 * A draft passes only if the similarity clears the threshold AND no entity is in one text and not the other.
 */

export type EntityType = "number" | "date" | "time" | "amount" | "link" | "name";
export type Entities = Record<EntityType, Set<string>>;

const STOP = new Set(("a an the and or but if so of to in on at by for with from as is are was were be been being am do does did have has had i me my we our you your he she it its they them their this that these those " +
  "there here will would can could should may might shall just also very really please thanks thank hi hello hey dear regards best kind sincerely cheers let know get got any some all not no yes then than too out up about into over after before").split(" "));

const clean = (s: string) => s.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ /g, " ");

/** Drop a closing line ("Best regards, Claude") and the name under it: the agents sign with their own names. */
export function stripSignoff(body: string): string {
  const lines = clean(body).split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
    if (/^\s*(best|best regards|kind regards|warm regards|warmest regards|regards|warmly|sincerely|yours sincerely|yours truly|yours|thanks|thank you|thanks again|thanks so much|many thanks|cheers|respectfully|all the best|talk soon|take care|with thanks|best wishes)\s*[,!.\-]?\s*$/i.test(lines[i])) {
      const tail = lines.slice(i + 1).filter((l) => l.trim());
      // only a name and a title under it: a link, a number, an address or a P.S. after the closing is content, and is compared
      if (tail.length <= 3 && tail.every((l) => l.trim().length <= 60 && l.trim().split(/\s+/).length <= 6 && !/[\d@$%]|https?:|www\.|^\s*p\.?\s?s\b/i.test(l))) return lines.slice(0, i).join("\n");
    }
  }
  return lines.join("\n");
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const monthNum = (m: string) => String(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m.slice(0, 3).toLowerCase()) + 1).padStart(2, "0");
const p2 = (n: string | number) => String(n).padStart(2, "0");
const year = (y?: string) => (y ? (y.length === 2 ? `20${y}` : y) : "");
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const CUR: Record<string, string> = { $: "usd", "€": "eur", "£": "gbp", "¥": "jpy", dollar: "usd", dollars: "usd", usd: "usd", euro: "eur", euros: "eur", eur: "eur", pound: "gbp", pounds: "gbp", gbp: "gbp" };
const num = (s: string) => { const n = parseFloat(s.replace(/,/g, "")); return Number.isFinite(n) ? String(n) : s; };
const money = (cur: string, n: string, mult?: string) => `${CUR[cur.toLowerCase()] ?? cur}${String(Math.round(parseFloat(n.replace(/,/g, "")) * (mult ? MULT[mult.toLowerCase()] ?? 1 : 1) * 1e4) / 1e4)}`;

const ACRONYMS = new Set(["FYI", "ASAP", "PDF", "API", "URL", "OK", "EOD", "ETA", "FAQ", "AM", "PM", "UTC", "PST", "EST", "CST", "PT", "ET", "GMT", "TBD", "TBA", "RSVP", "PTO", "NB", "PS", "CC", "BCC", "RE", "FW", "FWD", "TLDR", "AI"]);
const NOT_NAMES = new Set(["Please", "Thanks", "Thank", "Hi", "Hello", "Hey", "Dear", "Best", "Regards", "Kind", "Sincerely", "Cheers", "Note", "Also", "Again", "Sorry", "Yes", "No", "Ok", "Okay", "Sure", "Great", "Good", "Let", "If", "When", "We", "I", "You", "The", "This", "That", "These", "Those", "And", "But", "So", "As", "At", "In", "On", "Our", "My", "Your", "It", "He", "She", "They"]);

/** Every number, date, time, amount, link and name in a text, in a canonical form. Names are only looked for with `names`. */
export function entitiesOf(raw: string, o: { names?: boolean } = {}): Entities { return scan(raw, o.names).out; }

/** The text with every entity replaced by its canonical form, so "$1.2M" and "$1,200,000", "3pm" and "3 pm" are the same word when similarity is counted. */
export function maskEntities(raw: string): string { return scan(raw, false).masked; }

function scan(raw: string, names?: boolean): { out: Entities; masked: string } {
  const out: Entities = { number: new Set(), date: new Set(), time: new Set(), amount: new Set(), link: new Set(), name: new Set() };
  let s = clean(raw);
  const take = (re: RegExp, f: (m: RegExpMatchArray) => string | undefined, into: EntityType) => {
    s = s.replace(re, (...a) => {
      const m = a.slice(0, -2) as unknown as RegExpMatchArray;
      const v = f(m); if (v) out[into].add(v);
      return v ? ` ${into}${v.replace(/[^a-z0-9]/gi, "")} ` : " ".repeat(String(a[0]).length);
    });
  };
  take(/\bhttps?:\/\/[^\s<>"')\]]+/gi, (m) => m[0].replace(/[.,;:!?]+$/, "").replace(/^(https?:\/\/[^/]+)/i, (h) => h.toLowerCase()).replace(/\/+$/, ""), "link");
  take(/\bwww\.[^\s<>"')\]]+/gi, (m) => `http://${m[0].replace(/[.,;:!?]+$/, "").replace(/\/+$/, "").toLowerCase()}`, "link");
  take(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => m[0].toLowerCase().replace(/[.]+$/, ""), "link");
  // dates
  take(/\b(\d{4})-(\d{2})-(\d{2})(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi, (m) => `${m[1]}-${m[2]}-${m[3]}`, "date");
  take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) => `${m[3] ? `${year(m[3])}-` : ""}${p2(m[1])}-${p2(m[2])}`, "date");
  take(new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{4})\\b`, "gi"), (m) => `${m[2]}-${monthNum(m[1])}`, "date");
  take(new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"), (m) => `${m[3] ? `${m[3]}-` : ""}${monthNum(m[1])}-${p2(m[2])}`, "date");
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})\\b\\.?(?:,?\\s+(\\d{4}))?`, "gi"), (m) => `${m[3] ? `${m[3]}-` : ""}${monthNum(m[2])}-${p2(m[1])}`, "date");
  take(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, (m) => `wd:${m[1].toLowerCase()}`, "date");
  take(/\b(today|tomorrow|tonight|yesterday|eod|eow|eom|end of (?:the )?(?:day|week|month|quarter|year)|(?:next|last|this) (?:week|month|quarter|year)|q[1-4])\b/gi, (m) => m[1].toLowerCase().replace(/\bthe /, ""), "date");
  // times
  take(/\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\b\.?/gi, (m) => { let h = Number(m[1]) % 12; if (m[3].toLowerCase() === "p") h += 12; return `${p2(h)}:${m[2] ?? "00"}`; }, "time");
  take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (m) => `${p2(m[1])}:${m[2]}`, "time");
  // amounts and percentages
  take(/([$€£¥])\s?(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|bn|b|million|billion|thousand)?\b/gi, (m) => money(m[1], m[2], m[3]), "amount");
  take(/(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|bn|b|million|billion|thousand)?\s?(usd|eur|gbp|dollars?|euros?|pounds?)\b/gi, (m) => money(m[3], m[1], m[2]), "amount");
  take(/(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/gi, (m) => `${num(m[1])}%`, "number");
  // names, before the numbers go: a capitalised word that does not start a sentence
  if (names) {
    for (const m of s.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)*|[A-Z]{2,}[a-z]*)\b/g)) {
      const w = m[1], i = m.index ?? 0;
      if (ACRONYMS.has(w) || NOT_NAMES.has(w)) continue;
      const before = s.slice(0, i).replace(/[ \t]+$/, "");
      if (!before || /[.!?:"(\n•*#-]$/.test(before) || /\n$/.test(s.slice(0, i).replace(/[ \t]+$/, ""))) continue;
      out.name.add(w.toLowerCase());
    }
  }
  take(/(?<![\w.])(\d[\d,]*(?:\.\d+)?)(?:st|nd|rd|th)?(?![\w])/g, (m) => num(m[1]), "number");
  return { out, masked: s };
}

const TYPE_LABEL: Record<EntityType, string> = { number: "number", date: "date", time: "time", amount: "amount", link: "link", name: "name" };
export interface EntityDiff { type: EntityType; label: string; onlyA: string[]; onlyB: string[] }
/** What is in one text's entities and not the other's. */
export function entityDiff(a: Entities, b: Entities): EntityDiff[] {
  const out: EntityDiff[] = [];
  for (const t of Object.keys(TYPE_LABEL) as EntityType[]) {
    const onlyA = [...a[t]].filter((x) => !b[t].has(x)).sort(), onlyB = [...b[t]].filter((x) => !a[t].has(x)).sort();
    if (onlyA.length || onlyB.length) out.push({ type: t, label: TYPE_LABEL[t], onlyA, onlyB });
  }
  return out;
}

const stem = (w: string) => (w.length > 5 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 4 && w.endsWith("ed") ? w.slice(0, -2) : w.length > 4 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
export function contentTokens(text: string): string[] {
  return (clean(text).toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []).map((w) => w.replace(/'s$/, "")).filter((w) => !STOP.has(w)).map(stem);
}
/** Dice coefficient over the content words of two texts: 1 for the same words, 0 for none in common. Two empty texts are alike. */
export function similarity(a: string, b: string): number {
  const ta = contentTokens(maskEntities(a)), tb = contentTokens(maskEntities(b));
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  const count = new Map<string, number>();
  for (const w of ta) count.set(w, (count.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of tb) { const n = count.get(w) ?? 0; if (n > 0) { common++; count.set(w, n - 1); } }
  return Math.round(((2 * common) / (ta.length + tb.length)) * 1000) / 1000;
}

/** Collapse whitespace and straighten quotes so formatting never counts as a difference. */
export const squash = (s: string) => clean(s).replace(/\s+/g, " ").trim();

/** Word-level diff for the card: the words each side has that the other does not. null when the texts are too long to line up cheaply. */
export function wordDiff(a: string, b: string): { a: TwoKeyWords[]; b: TwoKeyWords[] } | null {
  const wa = squash(a).split(" ").filter(Boolean), wb = squash(b).split(" ").filter(Boolean);
  if (wa.length * wb.length > 250_000) return null;
  const key = (w: string) => w.toLowerCase().replace(/[^a-z0-9$%@.:/-]+/g, "");
  const n = wa.length, m = wb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = key(wa[i]) === key(wb[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ra: TwoKeyWords[] = [], rb: TwoKeyWords[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (key(wa[i]) === key(wb[j])) { ra.push({ t: wa[i++] }); rb.push({ t: wb[j++] }); }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ra.push({ t: wa[i++], d: true });
    else rb.push({ t: wb[j++], d: true });
  }
  while (i < n) ra.push({ t: wa[i++], d: true });
  while (j < m) rb.push({ t: wb[j++], d: true });
  return { a: ra, b: rb };
}
