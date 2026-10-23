// ---- 1.1 Reading a unified diff, shared by the Mac app and (as a hand port in hub/web/diff.js) the phone app.
// The hub writes the diff (hub/src/files/diff.ts). The apps only read it, and they refuse to treat
// anything they cannot read completely as something the owner can approve. No imports, so Metro and tsx both load it.

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its +, - or space marker. */
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Followed by "\ No newline at end of file". */
  noNewline?: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export interface ParsedDiff {
  oldPath: string | null;
  newPath: string | null;
  /** "--- /dev/null": the file does not exist yet. */
  isNew: boolean;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** Every shown line, context included. */
  lineCount: number;
  /** Text that is not a header or a hunk line: the hub's "too large to diff" note, a cut-off diff, anything unexpected. */
  stray: string[];
  /** Set when this cannot stand in for the whole change. An app must not offer Approve while it is set. */
  problem?: string;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const META = /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index )/;
const stripPrefix = (s: string) => (s === "/dev/null" ? null : s.replace(/^[ab]\//, ""));

/** Linear in the size of the diff. Never throws: odd input ends up in `stray` and sets `problem`. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const out: ParsedDiff = { oldPath: null, newPath: null, isNew: false, hunks: [], added: 0, removed: 0, lineCount: 0, stray: [] };
  const lines = diff.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let cur: DiffHunk | undefined;
  let remOld = 0, remNew = 0, oldNo = 0, newNo = 0;
  let sawOld = false, sawNew = false;

  for (const raw of lines) {
    if (cur && (remOld > 0 || remNew > 0)) {
      // Inside a hunk the first character decides, whatever the rest looks like ("--- x" is a removed line "-- x").
      const c = raw.charAt(0);
      if (c === "+") { cur.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ }); cur.added++; remNew--; continue; }
      if (c === "-") { cur.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ }); cur.removed++; remOld--; continue; }
      if (c === " " || raw === "") { cur.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ }); remOld--; remNew--; continue; }
      if (c === "\\") { const last = cur.lines[cur.lines.length - 1]; if (last) last.noNewline = true; continue; }
      out.stray.push(raw); continue;
    }
    if (raw.startsWith("\\") && cur && cur.lines.length) { cur.lines[cur.lines.length - 1].noNewline = true; continue; }
    const h = HUNK.exec(raw);
    if (h) {
      cur = {
        header: raw, oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]), newCount: h[4] === undefined ? 1 : Number(h[4]), lines: [], added: 0, removed: 0,
      };
      out.hunks.push(cur);
      remOld = cur.oldCount; remNew = cur.newCount; oldNo = cur.oldStart; newNo = cur.newStart;
      continue;
    }
    if (!out.hunks.length && raw.startsWith("--- ") && !sawOld) { sawOld = true; out.oldPath = stripPrefix(raw.slice(4)); out.isNew = raw.slice(4) === "/dev/null"; continue; }
    if (!out.hunks.length && raw.startsWith("+++ ") && !sawNew) { sawNew = true; out.newPath = stripPrefix(raw.slice(4)); continue; }
    if (META.test(raw) && !out.hunks.length) continue;
    out.stray.push(raw);
  }

  for (const hk of out.hunks) { out.added += hk.added; out.removed += hk.removed; out.lineCount += hk.lines.length; }
  const open = cur && (remOld > 0 || remNew > 0);
  if (open) out.problem = "This diff is cut off before the end, so it is not the whole change.";
  else if (out.stray.length) out.problem = "Part of this change can't be shown as lines. Reject it and ask the agent for smaller edits.";
  else if (!out.hunks.length) out.problem = "There are no changed lines to show.";
  return out;
}

export type DiffRow =
  | { type: "hunk"; hunk: number; header: string }
  | { type: "line"; hunk: number; line: DiffLine };

/** One flat list (hunk headers and lines in order) for a virtualised list. */
export function flattenDiff(d: ParsedDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  d.hunks.forEach((h, i) => { rows.push({ type: "hunk", hunk: i, header: h.header }); for (const line of h.lines) rows.push({ type: "line", hunk: i, line }); });
  return rows;
}

/** Slack in pixels: fractional scroll positions and rubber-banding never leave the last line just out of reach. */
export const SCROLL_SLACK = 16;
/** True when the content is taller than the window, so the owner has to scroll to see all of it. */
export const needsScrollGate = (viewportH: number, contentH: number, slack = SCROLL_SLACK) => contentH > viewportH + slack;
/** True when the last pixel of the content has been in view. */
export const scrolledToEnd = (offsetY: number, viewportH: number, contentH: number, slack = SCROLL_SLACK) => offsetY + viewportH >= contentH - slack;

export interface ApprovalLike { id: string; agentId: string; proposalId?: string; detail?: string }
export interface ProposalLike { id: string; agentId: string; approvalId?: string; status: string }

/** A file write the owner is asked about. Agents can ask for approvals with any tool name; only the hub's own are shown as diffs. */
export const isFileWriteApproval = (a: { tool: string; action: string }) => a.tool === "filesystem" && a.action.startsWith("write ");

/**
 * Which write proposal an approval is about. The hub's own link wins (proposalId, then the proposal's approvalId).
 * Last resort is the id the hub puts at the top of the preview text. An agent can write that text itself, so it only
 * counts for a pending proposal from the same agent that no other approval already owns.
 * Returns undefined when nothing safe matches: the app then has no diff to show and must not offer Approve.
 */
export function findProposalForApproval<P extends ProposalLike>(a: ApprovalLike, proposals: P[]): P | undefined {
  if (a.proposalId) { const p = proposals.find((x) => x.id === a.proposalId); if (p) return p; }
  const linked = proposals.find((x) => x.approvalId === a.id);
  if (linked) return linked;
  const m = /^(?:!! [^\n]*\n)?Write proposal (\S+?):/.exec(a.detail ?? "");
  if (!m) return undefined;
  return proposals.find((x) => x.id === m[1] && x.status === "pending" && x.agentId === a.agentId && (x.approvalId === undefined || x.approvalId === a.id));
}

// ---- 1.1 integration: one proposal, possibly several files

/**
 * What a file approval opens: the proposal fetched whole, by id (GET /write-proposals/:id). The list route leaves the
 * diff out, so the guarded fallbacks (the proposal's own approvalId, the preview text) work on that list and then fetch the one they find.
 */
export async function fetchProposalForApproval<P extends ProposalLike>(
  a: ApprovalLike,
  api: { one: (id: string) => Promise<P>; list: () => Promise<ProposalLike[]> },
): Promise<P | undefined> {
  let first: unknown;
  if (a.proposalId) { try { return await api.one(a.proposalId); } catch (e) { first = e; } }
  let list: ProposalLike[];
  try { list = await api.list(); } catch (e) { throw first ?? e; }
  const found = findProposalForApproval({ ...a, proposalId: undefined }, list);
  if (found) return api.one(found.id);
  if (first) throw first;
  return undefined;
}

export type FileOp = "create" | "edit" | "delete";

export interface DiffSection { path: string | null; op: FileOp; parsed: ParsedDiff }
export interface ParsedChange {
  sections: DiffSection[];
  added: number;
  removed: number;
  /** Number of places (hunks) over all files. */
  places: number;
  /** Set when this cannot stand in for the whole change. An app must not offer Approve while it is set. */
  problem?: string;
}

/**
 * A task's write-back is one diff with a `--- a/x` / `+++ b/x` header per file. Cuts it into one piece per file.
 * Hunk-aware: a removed line that reads "-- x" inside a hunk is a line, not the start of the next file.
 */
export function splitFileDiffs(diff: string): string[] {
  const lines = diff.split("\n");
  const parts: string[][] = [[]];
  let remOld = 0, remNew = 0, hasHunk = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const cur = parts[parts.length - 1];
    if (remOld > 0 || remNew > 0) {
      const c = raw.charAt(0);
      if (c === "+") remNew--; else if (c === "-") remOld--; else if (c === " " || raw === "") { remOld--; remNew--; }
      cur.push(raw); continue;
    }
    const h = HUNK.exec(raw);
    if (h) { remOld = h[2] === undefined ? 1 : Number(h[2]); remNew = h[4] === undefined ? 1 : Number(h[4]); hasHunk = true; cur.push(raw); continue; }
    if (hasHunk && raw.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      while (cur.length && cur[cur.length - 1] === "") cur.pop();
      parts.push([raw]); hasHunk = false; continue;
    }
    cur.push(raw);
  }
  return parts.map((p) => p.join("\n"));
}

/** Reads a proposal's diff as one section per file. `files` (a task proposal's list) names each file's operation and must match what the diff shows. */
export function parseChangeDiff(diff: string, files?: { relPath: string; op: FileOp }[]): ParsedChange {
  const sections: DiffSection[] = splitFileDiffs(diff).map((text) => {
    const parsed = parseUnifiedDiff(text);
    const path = parsed.newPath ?? parsed.oldPath;
    const listed = files?.find((f) => f.relPath === path);
    return { path, op: listed?.op ?? (parsed.isNew ? "create" : parsed.newPath === null && parsed.oldPath !== null ? "delete" : "edit"), parsed };
  });
  const out: ParsedChange = { sections, added: 0, removed: 0, places: 0 };
  for (const s of sections) { out.added += s.parsed.added; out.removed += s.parsed.removed; out.places += s.parsed.hunks.length; }
  const bad = sections.find((s) => s.parsed.problem);
  if (bad) out.problem = bad.parsed.problem;
  else if (files && files.length !== sections.length) out.problem = `This change lists ${files.length} file${files.length === 1 ? "" : "s"} but the diff shows ${sections.length}, so it is not the whole change.`;
  else if (files && sections.some((s) => !files.some((f) => f.relPath === s.path))) out.problem = "The diff shows a file the change doesn't list, so it is not safe to approve here.";
  return out;
}

export type ChangeRow = DiffRow | { type: "file"; path: string; op: FileOp; added: number; removed: number };

/** One flat list for a virtualised list: a header per file (only when there is more than one), then its hunks and lines. */
export function flattenChange(c: ParsedChange): ChangeRow[] {
  const rows: ChangeRow[] = [];
  c.sections.forEach((s, si) => {
    if (c.sections.length > 1) rows.push({ type: "file", path: s.path ?? "?", op: s.op, added: s.parsed.added, removed: s.parsed.removed });
    s.parsed.hunks.forEach((h, i) => {
      rows.push({ type: "hunk", hunk: si * 100000 + i, header: h.header });
      for (const line of h.lines) rows.push({ type: "line", hunk: si * 100000 + i, line });
    });
  });
  return rows;
}

/** A file's operation in plain words. */
export const opWords = (op: FileOp) => (op === "create" ? "New file" : op === "delete" ? "Deleted" : "Changed");
