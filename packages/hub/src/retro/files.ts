import { CAPS } from "../control/schema.js";
import { editFrontMatter, emitFile, replaceBody, seqNode, splitDoc } from "../control/parse.js";
import type { LessonRow, PlaybookRow } from "./db.js";
import { SAME, bytes, cleanLine, cleanType, normalize, similarity, PLAYBOOK_LINE_MAX } from "./text.js";

/**
 * 2.1 LESSONS.md and playbook files: reading what the owner left, working out what a retro changes, and condensing.
 * Everything here is pure: it takes the text on disk and the rows in the database and returns the new text and rows.
 * The caller writes them (through the control folder when there is one) and only then saves the rows, so a failed
 * write never leaves the database ahead of the files.
 */

export const LESSONS_CAP = CAPS.lessons!;      // 12 KB
export const PLAYBOOK_CAP = CAPS.playbook!;    // 8 KB
/** Condense at this share of the cap, down to CALM. */
export const CONDENSE_AT = 0.8;
export const CONDENSE_TO = 0.7;
/** More lessons than this for one task type also triggers condensing. */
export const MAX_PER_TYPE = 20;
/** Near-duplicates found while condensing (looser than the check a new lesson passes). */
export const MERGE = 0.55;

const BULLET = /^\s*[-*]\s+(\S.*?)\s*$/;
const TAG = /\s*\(from ([^)]+)\)\s*$/;

// ---------------------------------------------------------------- LESSONS.md

type Item = { raw: string } | { rowId: string; line: string };
interface Section { heading: string; type: string; items: Item[] }
export interface LessonsDoc { pre: string[]; sections: Section[] }

const isRow = (i: Item): i is { rowId: string; line: string } => "rowId" in i;
const bulletText = (line: string) => (BULLET.exec(line)?.[1] ?? line).replace(TAG, "").trim();
const bulletGoal = (line: string) => TAG.exec(BULLET.exec(line)?.[1] ?? "")?.[1]?.trim();

/** Bullets under `## <task-type>` headings. Anything else (intro text, notes, other headings) is kept as it is. */
function parseBody(body: string): { pre: string[]; sections: { heading: string; type: string; lines: string[] }[] } {
  const pre: string[] = []; const sections: { heading: string; type: string; lines: string[] }[] = [];
  for (const l of body.replace(/\s+$/, "").split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) { sections.push({ heading: h[1], type: cleanType(h[1]), lines: [] }); continue; }
    (sections.length ? sections[sections.length - 1].lines : pre).push(l);
  }
  return { pre, sections };
}

const render = (d: LessonsDoc) => {
  const out: string[] = [...d.pre];
  for (const s of d.sections) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(`## ${s.heading}`, "");
    for (const i of s.items) out.push(isRow(i) ? i.line : i.raw);
    while (out.length && out[out.length - 1].trim() === "") out.pop();
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
};

const INTRO = ["# Lessons", "", "What earlier goals taught this agent, by task type. Edit or delete any line; a line you delete stays deleted."];

export interface LessonInput { taskType: string; text: string; goalId: string; evidence?: string }

export interface AgentPlan {
  /** The rows after this retro (all states). */
  rows: LessonRow[];
  /** New file text, or undefined when the file needn't change. */
  fileText?: string;
  /** What happened, for the room line and the audit log. */
  added: LessonRow[];
  repeated: number;
  skippedDeleted: number;
  retired: number;
  merged: number;
  /** The owner's own edits found in the file. */
  ownerAdded: number;
  ownerDeleted: number;
}

const clone = (r: LessonRow): LessonRow => ({ ...r });

/**
 * Work out what a retro does to one agent's LESSONS.md and lesson rows.
 * `fileText` is the file as it is on disk (undefined when there is none, or no control folder); when it is there it wins:
 * a lesson whose line is gone was deleted by the owner, and a line that has no row is the owner's own.
 */
export function planLessons(agentId: string, rows: LessonRow[], fileText: string | undefined, input: LessonInput[], now: number, today: string): AgentPlan {
  const work = rows.map(clone);
  const stats = { repeated: 0, skippedDeleted: 0, retired: 0, merged: 0, ownerAdded: 0, ownerDeleted: 0 };
  let nextId = 0;
  const fresh = (r: Omit<LessonRow, "id">): LessonRow => { const row = { ...r, id: `new-${nextId++}` } as LessonRow; work.push(row); return row; };

  // ---- the document: the file's own structure, or one built from the active rows
  let doc: LessonsDoc;
  let frontText: string | undefined; let bodyBefore = "";
  if (fileText !== undefined) {
    const sp = splitDoc(fileText);
    frontText = sp.raw === null ? undefined : fileText;
    bodyBefore = sp.raw === null ? fileText : sp.body;
    const parsed = parseBody(bodyBefore);
    const claimed = new Set<string>();
    doc = { pre: parsed.pre, sections: [] };
    for (const s of parsed.sections) {
      const sec: Section = { heading: s.heading, type: s.type, items: [] };
      for (const line of s.lines) {
        if (!BULLET.test(line)) { sec.items.push({ raw: line }); continue; }
        const text = bulletText(line);
        const same = (r: LessonRow) => !claimed.has(r.id) && r.taskType === s.type && normalize(r.text) === normalize(text);
        const row = work.find((r) => r.active && same(r)) ?? work.find(same);
        if (row) {
          claimed.add(row.id);
          if (!row.active) { row.active = true; row.retired = false; row.reason = undefined; stats.ownerAdded++; } // the owner put a retired or deleted line back
          sec.items.push({ rowId: row.id, line });
        } else {
          const r = fresh({ agentId, taskType: s.type, text, goalId: bulletGoal(line) ?? "owner", at: now, confirmedAt: now, seen: 1, active: true, retired: false, source: bulletGoal(line) ? "orchestrator" : "owner" });
          claimed.add(r.id); stats.ownerAdded++;
          sec.items.push({ rowId: r.id, line });
        }
      }
      doc.sections.push(sec);
    }
    // Rows in use whose line is no longer in the file: the owner deleted them. They stay deleted.
    for (const r of work) if (r.active && !claimed.has(r.id)) { r.active = false; r.reason = "deleted"; stats.ownerDeleted++; }
  } else {
    doc = { pre: [...INTRO], sections: [] };
    for (const r of work.filter((x) => x.active).sort((a, b) => a.at - b.at)) addBullet(doc, r);
    doc.sections.sort((a, b) => a.type.localeCompare(b.type));
  }

  // ---- this retro's lessons
  const added: LessonRow[] = [];
  for (const l of input) {
    const type = cleanType(l.taskType);
    const same = work.filter((r) => r.taskType === type && similarity(r.text, l.text) >= SAME);
    const live = same.find((r) => r.active);
    if (live) { live.confirmedAt = now; live.seen++; stats.repeated++; continue; }
    if (same.some((r) => r.reason === "deleted")) { stats.skippedDeleted++; continue; }
    const row = fresh({ agentId, taskType: type, text: l.text, goalId: l.goalId, at: now, confirmedAt: now, seen: 1, active: true, retired: false, source: "orchestrator", ...(l.evidence ? { evidence: l.evidence.slice(0, 300) } : {}) });
    addBullet(doc, row); added.push(row);
  }

  // ---- condense
  const text = () => fileOut(doc, frontText, today);
  const types = () => [...new Set(work.filter((r) => r.active).map((r) => r.taskType))];
  const count = (t: string) => work.filter((r) => r.active && r.taskType === t).length;
  const over = () => types().some((t) => count(t) > MAX_PER_TYPE) || bytes(text()) >= LESSONS_CAP * CONDENSE_AT;
  if (over()) {
    const retire = (r: LessonRow, reason: "merged" | "old") => {
      r.active = false; r.retired = true; r.reason = reason; stats.retired++; if (reason === "merged") stats.merged++;
      for (const s of doc.sections) s.items = s.items.filter((i) => !(isRow(i) && i.rowId === r.id));
    };
    // 1. merge near-duplicates, keeping the one a retro saw most recently
    for (const t of types()) {
      const rs = work.filter((r) => r.active && r.taskType === t).sort((a, b) => b.confirmedAt - a.confirmedAt || b.at - a.at);
      for (let i = 0; i < rs.length; i++) {
        if (!rs[i].active) continue;
        for (let j = i + 1; j < rs.length; j++) if (rs[j].active && similarity(rs[i].text, rs[j].text) >= MERGE) { rs[i].seen += rs[j].seen; retire(rs[j], "merged"); }
      }
    }
    // 2. too many in one type: the oldest go first (the owner's own lines last)
    const oldest = (rs: LessonRow[]) => [...rs].sort((a, b) => Number(a.source === "owner") - Number(b.source === "owner") || a.confirmedAt - b.confirmedAt || a.at - b.at)[0];
    for (const t of types()) while (count(t) > MAX_PER_TYPE) retire(oldest(work.filter((r) => r.active && r.taskType === t)), "old");
    // 3. still near the cap: the oldest overall, down to CONDENSE_TO
    if (bytes(text()) >= LESSONS_CAP * CONDENSE_AT) {
      while (bytes(text()) > LESSONS_CAP * CONDENSE_TO && work.some((r) => r.active)) retire(oldest(work.filter((r) => r.active)), "old");
    }
    doc.sections = doc.sections.filter((s) => s.items.length);
  }

  const body = render(doc);
  const hasLessons = doc.sections.some((s) => s.items.some(isRow));
  const unchanged = fileText !== undefined ? body.trim() === bodyBefore.trim() : !hasLessons; // no file and nothing to put in one: don't make an empty one
  return { rows: work, fileText: unchanged ? undefined : text(), added, ...stats };
}

function addBullet(doc: LessonsDoc, r: LessonRow) {
  let s = doc.sections.find((x) => x.type === r.taskType);
  if (!s) { s = { heading: r.taskType, type: r.taskType, items: [] }; doc.sections.push(s); }
  s.items.push({ rowId: r.id, line: `- ${r.text} (from ${r.goalId})` });
}

function fileOut(doc: LessonsDoc, existing: string | undefined, today: string): string {
  const types = doc.sections.filter((s) => s.items.some(isRow)).map((s) => s.type);
  const body = render(doc);
  if (existing === undefined) return emitFile({ kind: "lessons", schema: 1, updated: today, updated_by: "orchestrator", task_types: types }, body);
  const edited = editFrontMatter(existing, (d) => {
    d.set("updated", today); d.set("updated_by", "orchestrator");
    if (d.has("task_types") || types.length) d.set("task_types", seqNode(d, types));
  });
  return replaceBody(edited, body);
}

/** The bullets of one task type in a LESSONS.md text (what the owner left in the file). */
export function lessonLines(fileText: string, taskType: string): string[] {
  const sp = splitDoc(fileText);
  const parsed = parseBody(sp.raw === null ? fileText : sp.body);
  return parsed.sections.filter((s) => s.type === cleanType(taskType)).flatMap((s) => s.lines.filter((l) => BULLET.test(l)).map(bulletText));
}

// ---------------------------------------------------------------- playbooks

type PbItem = { raw: string } | { bullet: string };

export interface PlaybookPlan {
  row: PlaybookRow;
  fileText?: string;
  added: number;
  removed: number;
  retired: number;
}

const pbParse = (body: string): PbItem[] => body.replace(/\s+$/, "").split("\n").map((l) => (BULLET.test(l) ? { bullet: bulletText(l) } : { raw: l }));
const pbRender = (items: PbItem[]) => items.map((i) => ("bullet" in i ? `- ${i.bullet}` : i.raw)).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
const isBullet = (i: PbItem): i is { bullet: string } => "bullet" in i;

/**
 * What a retro does to one playbook. `fileText` is the playbook file on disk when there is one (it wins over the
 * database copy); otherwise the database copy is the base. `add` and `remove` are the orchestrator's proposals.
 */
export function planPlaybook(taskType: string, row: PlaybookRow | undefined, fileText: string | undefined, ops: { add: string[]; remove?: string[] }, goalId: string, now: number, today: string): PlaybookPlan {
  let items: PbItem[]; let bodyBefore = "";
  if (fileText !== undefined) {
    const sp = splitDoc(fileText);
    bodyBefore = sp.raw === null ? fileText : sp.body;
    items = pbParse(bodyBefore);
  } else {
    items = [{ raw: `# Playbook: ${taskType}` }, { raw: "" }, { raw: `How to do ${taskType} tasks well, from earlier goals. Edit or delete any line.` }, { raw: "" }, ...(row?.lines ?? []).map((bullet) => ({ bullet }))];
  }
  const retired = [...(row?.retired ?? [])];
  let removed = 0, added = 0, dropped = 0;

  for (const r of ops.remove ?? []) {
    const q = cleanLine(r, PLAYBOOK_LINE_MAX); if (!q) continue;
    let best = -1, score = 0.6;
    items.forEach((i, k) => { if (isBullet(i)) { const s = similarity(i.bullet, q); if (s >= score) { best = k; score = s; } } });
    if (best >= 0) { retired.push((items[best] as { bullet: string }).bullet); items.splice(best, 1); removed++; }
  }
  for (const a of ops.add.slice(0, 5)) {
    const line = cleanLine(a, PLAYBOOK_LINE_MAX); if (!line) continue;
    if (items.some((i) => isBullet(i) && similarity(i.bullet, line) >= SAME)) continue;
    if (retired.some((x) => normalize(x) === normalize(line))) continue; // taken out earlier, on purpose
    let at = -1; items.forEach((i, k) => { if (isBullet(i)) at = k; });
    const entry: PbItem = { bullet: line };
    if (at >= 0) items.splice(at + 1, 0, entry); else { while (items.length && isRawBlank(items[items.length - 1])) items.pop(); items.push({ raw: "" }, entry); }
    added++;
  }

  const out = () => pbFile(taskType, items, fileText, today);
  if (bytes(out()) >= PLAYBOOK_CAP * CONDENSE_AT) {
    const bullets = () => items.filter(isBullet);
    // merge near-duplicates (the later line stays), then let the oldest lines go
    const bs = bullets();
    for (let i = bs.length - 1; i >= 0; i--) for (let j = i - 1; j >= 0; j--) {
      if (similarity(bs[i].bullet, bs[j].bullet) >= MERGE && items.includes(bs[j]) && items.includes(bs[i])) { retired.push(bs[j].bullet); items.splice(items.indexOf(bs[j]), 1); dropped++; }
    }
    while (bytes(out()) > PLAYBOOK_CAP * CONDENSE_TO && bullets().length) { const first = bullets()[0]; retired.push(first.bullet); items.splice(items.indexOf(first), 1); dropped++; }
  }

  const lines = items.filter(isBullet).map((i) => i.bullet);
  const next: PlaybookRow = { taskType, lines, retired: retired.slice(-50), updatedAt: now, goalId };
  const body = pbRender(items);
  const unchanged = fileText !== undefined && body.trim() === bodyBefore.trim();
  return { row: next, fileText: unchanged ? undefined : out(), added, removed, retired: dropped };
}

const isRawBlank = (i: PbItem) => "raw" in i && i.raw.trim() === "";

function pbFile(taskType: string, items: PbItem[], existing: string | undefined, today: string): string {
  const body = pbRender(items);
  if (existing === undefined) return emitFile({ kind: "playbook", schema: 1, updated: today, updated_by: "orchestrator", task_type: taskType, applies_to: "*" }, body);
  const edited = editFrontMatter(existing, (d) => { d.set("updated", today); d.set("updated_by", "orchestrator"); });
  return replaceBody(edited, body);
}

/** The bullets of a playbook file's text. */
export const playbookLines = (fileText: string): string[] => {
  const sp = splitDoc(fileText);
  return pbParse(sp.raw === null ? fileText : sp.body).filter(isBullet).map((i) => i.bullet);
};
