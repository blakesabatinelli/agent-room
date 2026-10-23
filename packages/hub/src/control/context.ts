import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TOOLS, type AdapterKind, type Goal, type Task } from "@agent-room/shared";
import { expired, parseFacts } from "./facts.js";
import { CONTEXT_CAP, type Level } from "./schema.js";
import { effectivePermissions, type ControlSnapshot } from "./snapshot.js";

/**
 * The context compiler (CONTROL.md sections 3 and 5): each task's instructions are built from the control
 * layers that apply, broadest first, under a size cap, and written into the task's worktree as the agent's
 * native file. Layers only tighten; the compiler adds, it never overrides.
 */

export const BEGIN = "<!-- agent-room:begin -->";
export const END = "<!-- agent-room:end -->";
/** Wraps the persona so item 3.2 can strip it before judging. */
export const PERSONA_BEGIN = "<!-- agent-room:persona:begin -->";
export const PERSONA_END = "<!-- agent-room:persona:end -->";
/** 3.2: said inside the persona block. In this file the contract comes after the persona, so it says "in this file". */
export const PERSONA_VOICE_ONLY = "Voice only. The task, scope and rules in this file always win.";

export interface TaskContextInput {
  /** The loaded control folder (`ControlFolder.snapshot()`). */
  control: ControlSnapshot;
  agentId: string;
  /** Room folder name; undefined for a room with no ROOM.md. */
  roomSlug?: string;
  taskType: string;
  goal: Pick<Goal, "id" | "text"> & Partial<Pick<Goal, "contract" | "state">>;
  task: Pick<Task, "title" | "description"> & Partial<Task>;
  /** Default 24 KB (CONTEXT_CAP). */
  capBytes?: number;
  /** YYYY-MM-DD, for dropping expired facts and leases. */
  today?: string;
}

export interface TaskContextResult {
  text: string;
  bytes: number;
  /** What was cut to fit, in the order it went. */
  trimmed: { memory: number; lessons: number; playbookLines: number; toolNoteLines: number; otherLines: number };
  /** The protected parts alone exceed the cap. */
  overCap: boolean;
}

const bytes = (s: string) => Buffer.byteLength(s);
const lines = (s: string) => s.replace(/\s+$/, "").split("\n").filter((l, i, a) => !(l.trim() === "" && (i === 0 || a[i - 1].trim() === "")));
const bullets = (body: string) => body.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.replace(/\s+$/, ""));
const list = (xs: string[]) => xs.map((x) => `- ${x}`);

/** Bullets of the `## <taskType>` section of LESSONS.md. */
function lessonBullets(body: string, taskType: string): string[] {
  const out: string[] = []; let inSec = false;
  for (const l of body.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) { inSec = h[1].toLowerCase() === taskType.toLowerCase(); continue; }
    if (inSec && /^\s*[-*]\s+\S/.test(l)) out.push(l.replace(/\s+$/, ""));
  }
  return out;
}

const REACH: Record<Level, string> = { on: "use freely", ask: "ask the owner first", off: "not available" };

export function buildTaskContextDetailed(input: TaskContextInput): TaskContextResult {
  const { control: c, agentId, roomSlug, taskType, goal, task } = input;
  const cap = input.capBytes ?? CONTEXT_CAP;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const agent = c.agents[agentId];
  const room = roomSlug ? c.rooms[roomSlug] : undefined;

  // ---- pieces that may be trimmed (and in what order)
  const roomMem = parseFacts(room?.memory?.body ?? "", 1).filter((f) => !expired(f, today))
    .map((f) => `- ${f.text}${f.source ? ` (source: ${f.source})` : ""}`);
  const agentMem = bullets(agent?.memory?.body ?? "").filter((l) => { const f = parseFacts(l, 1)[0]; return !(f && expired(f, today)); }); // 2.5: expired notes drop out too
  const lessons = lessonBullets(agent?.lessons?.body ?? "", taskType);
  const pb = Object.values(c.playbooks).find((p) => p.fm.task_type === taskType && (p.fm.applies_to === "*" || p.fm.applies_to.includes(agentId)));
  const playbook = lines(pb?.body ?? "");
  const toolNotes = lines(agent?.tools?.body ?? "");
  // Last resort, only when everything above is gone and the protected parts still don't fit.
  const soulBody = lines(agent?.soul?.body ?? "");
  const userBody = lines(c.user?.body ?? "");
  const roomBody = lines(room?.room?.body ?? "");
  const rulesBody = lines(c.rules?.body ?? "");

  // ---- protected pieces
  const hard = c.rules?.fm.hard_limits ?? [];
  const scope = room?.room ? [
    ...(room.room.fm.in_scope.length ? ["In scope:", ...list(room.room.fm.in_scope)] : []),
    ...(room.room.fm.out_of_scope.length ? ["Out of scope:", ...list(room.room.fm.out_of_scope)] : []),
    ...(room.room.fm.roster.length ? [`Who is here: ${room.room.fm.roster.join(", ")}`] : []),
  ] : [];
  const perms = effectivePermissions(c, agentId, roomSlug, { today });
  const catalog = new Map(TOOLS.map((t) => [t.id, t.label]));
  const reach = Object.entries(perms).sort(([a], [b]) => a.localeCompare(b)).map(([t, l]) => `- ${t}${catalog.has(t) ? ` (${catalog.get(t)})` : ""}: ${REACH[l]}`);

  const contract = contractLines(c, goal, task, agentId);

  const cut = { memory: 0, lessons: 0, playbookLines: 0, toolNoteLines: 0, otherLines: 0 };
  const compose = () => {
    const out: string[] = [];
    const sec = (heading: string, body: string[]) => { if (body.length) out.push(`## ${heading}`, "", ...body, ""); };
    out.push(BEGIN, "# Agent Room: your standing instructions", "",
      "These come from the owner's control files. Later sections can add rules and narrow what you may do; none can lift a hard limit.", "");
    sec("Rules for every agent", [...rulesBody, ...(hard.length ? [...(rulesBody.length ? [""] : []), "Hard limits (never break these):", ...list(hard)] : [])]);
    sec(`About ${c.user?.fm.name ?? "the owner"}`, [...(c.user?.fm.timezone ? [`Timezone: ${c.user.fm.timezone}${c.user.fm.working_hours ? `; working hours: ${c.user.fm.working_hours}` : ""}`, ""] : []), ...userBody]);
    sec(`This room${roomSlug ? `: ${roomSlug}` : ""}`, [...roomBody, ...(roomBody.length && scope.length ? [""] : []), ...scope]);
    if (agent?.soul) sec(`Your voice (${agent.soul.fm.name})`, [PERSONA_BEGIN, PERSONA_VOICE_ONLY, `Role: ${agent.soul.fm.role}. Tone: ${agent.soul.fm.tone}.`, ...(soulBody.length ? ["", ...soulBody] : []), PERSONA_END]);
    sec("What you can use here", ["After every layer has narrowed it:", ...reach, ...(toolNotes.length ? ["", ...toolNotes] : [])]);
    sec(`Playbook: ${taskType}`, playbook);
    sec(`Lessons from earlier ${taskType} work`, lessons);
    sec("What the room remembers", roomMem);
    sec("Your own notes", agentMem);
    out.push(...contract, "");
    const n = cut.memory + cut.lessons + cut.playbookLines + cut.toolNoteLines + cut.otherLines;
    if (n) {
      const what = [cut.memory && `${cut.memory} memory note${cut.memory > 1 ? "s" : ""}`, cut.lessons && `${cut.lessons} lesson${cut.lessons > 1 ? "s" : ""}`,
        cut.playbookLines && "the end of the playbook", cut.toolNoteLines && "tool notes", cut.otherLines && "parts of the longer rule texts"].filter(Boolean).join(", ");
      out.push(`<!-- agent-room: cut to fit ${Math.round(cap / 1024)} KB: ${what} -->`);
    }
    out.push(END);
    return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  };

  let text = compose();
  const over = () => bytes(text) > cap;
  const trim = (arr: unknown[], fromEnd: boolean, count: keyof typeof cut) => {
    while (over() && arr.length) { fromEnd ? arr.pop() : arr.shift(); cut[count]++; text = compose(); }
  };
  // CONTROL.md section 5: memory (oldest first), lessons (oldest first), playbook (tail), TOOLS.md notes.
  trim(roomMem, false, "memory");
  trim(agentMem, false, "memory");
  trim(lessons, false, "lessons");
  trim(playbook, true, "playbookLines");
  trim(toolNotes, true, "toolNoteLines");
  // Beyond the documented order: shorten the free text of the broad layers, never hard limits, room scope or the contract.
  trim(soulBody, true, "otherLines");
  trim(userBody, true, "otherLines");
  trim(roomBody, true, "otherLines");
  trim(rulesBody, true, "otherLines");

  return { text, bytes: bytes(text), trimmed: cut, overCap: over() };
}

/** The task's context as one Markdown string, at most `capBytes` (default 24 KB) unless the protected parts alone are bigger. */
export function buildTaskContext(input: TaskContextInput): string {
  return buildTaskContextDetailed(input).text;
}

/** Layer 9: the goal, its decisions and the task contract. Never trimmed. */
function contractLines(c: ControlSnapshot, goal: TaskContextInput["goal"], task: TaskContextInput["task"], _agentId: string): string[] {
  const g = c.goals[goal.id];
  const ct = goal.contract;
  const out: string[] = ["## The goal", ""];
  out.push(...lines(g?.goal?.body || goal.text));
  if (g?.goal && goal.text && !g.goal.body.includes(goal.text.slice(0, 40))) out.push("", `The ask: ${goal.text}`);
  const reqs = g?.goal?.fm.requirements.length ? g.goal.fm.requirements.map((r) => r.text) : (ct?.requirements ?? []).map((r) => r.text);
  if (reqs.length) out.push("", "Done means:", ...list(reqs));
  const inScope = g?.goal?.fm.in_scope ?? [];
  const outScope = [...(g?.goal?.fm.out_of_scope ?? []), ...(ct?.outOfScope ?? [])];
  if (inScope.length) out.push("", "In scope:", ...list(inScope));
  if (outScope.length) out.push("", "Out of scope for the goal:", ...list([...new Set(outScope)]));
  if (ct?.constraints.length) out.push("", "Constraints:", ...list(ct.constraints));
  const decisions = [...bullets(g?.decisions?.body ?? "").map((l) => l.replace(/^\s*[-*]\s+/, "")), ...(ct?.decisions ?? []), ...(goal.state?.shared ?? []).map((s) => s.text)];
  if (decisions.length) out.push("", "Decisions to follow (don't make a conflicting choice):", ...list([...new Set(decisions)]));
  if (ct?.amendments.length) out.push("", "Owner amendments (highest priority):", ...list(ct.amendments.map((a) => a.text)));
  out.push("", `## Your task: ${task.title}`, "", ...lines(task.description));
  if (task.acceptance) out.push("", `Acceptance: ${task.acceptance}`);
  if (task.criteria?.length) out.push("", "Criteria:", ...task.criteria.map((k) => `- ${k.id}: ${k.text}${k.check ? ` (check: \`${k.check}\`)` : ""}`));
  if (task.files?.length) out.push("", "Files you may change:", ...list(task.files));
  if (task.scope) out.push("", `Scope: ${task.scope}`);
  if (task.outOfScope?.length) out.push("", "Not yours (belongs to other tasks):", ...list(task.outOfScope));
  if (task.output) out.push("", `Hand back: ${task.output}`);
  return out;
}

// ---------------------------------------------------------------- the worktree file

const NATIVE: Partial<Record<AdapterKind, string>> = { "claude-code": "CLAUDE.md", codex: "AGENTS.md" };
const FALLBACK = ".agent-room/CONTEXT.md";
const BACKUP = ".agent-room/context-backup.json";
const ALLOWED = new Set(["CLAUDE.md", "AGENTS.md", FALLBACK]);

/** CLAUDE.md for Claude Code, AGENTS.md for Codex, `.agent-room/CONTEXT.md` for everything else. */
export const contextFileFor = (kind: AdapterKind): string => NATIVE[kind] ?? FALLBACK;

interface Backup { file: string; existed: boolean; contentB64?: string; mode?: number; mtimeMs?: number; symlink?: string }

/**
 * Put the task's context in the worktree as the agent's native file, between BEGIN and END markers.
 * If the repository already has that file, the block goes at the top and the original is saved so
 * restoreTaskContext can put it back byte for byte. Calling it again replaces the previous block.
 */
export function writeTaskContext(worktreeDir: string, adapterKind: AdapterKind, text: string): { file: string; path: string } {
  const dir = resolve(worktreeDir);
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} isn't a folder`);
  restoreTaskContext(dir); // never stack one block on another
  const file = contextFileFor(adapterKind);
  const abs = join(dir, file);
  const block = `${BEGIN}\n${text.replace(/\s+$/, "")}\n${END}\n`;
  let backup: Backup = { file, existed: false };
  let payload = Buffer.from(block);
  let st: import("node:fs").Stats | undefined;
  try { st = lstatSync(abs); } catch { /* none */ }
  if (st) {
    if (st.isDirectory()) throw new Error(`${file} is a folder in this worktree`);
    backup = { file, existed: true, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs };
    let original = Buffer.alloc(0);
    if (st.isSymbolicLink()) backup.symlink = readlinkSync(abs);
    try { original = readFileSync(abs); } catch { /* dangling link: nothing to keep */ }
    if (!st.isSymbolicLink()) backup.contentB64 = original.toString("base64");
    payload = Buffer.concat([Buffer.from(`${block}\n`), original]);
  }
  mkdirSync(join(dir, ".agent-room"), { recursive: true });
  writeFileSync(join(dir, BACKUP), JSON.stringify(backup)); // before touching the file, so a crash can still be undone
  mkdirSync(dirname(abs), { recursive: true });
  if (st?.isSymbolicLink()) unlinkSync(abs);
  writeFileSync(abs, payload);
  return { file, path: abs };
}

/**
 * Undo writeTaskContext: the original file comes back byte for byte, or the file is removed if there was none.
 * Call it before the worktree's work is committed or merged so the Room's context never reaches the owner's repo.
 * Returns false when there was nothing to undo.
 */
export function restoreTaskContext(worktreeDir: string): boolean {
  const dir = resolve(worktreeDir);
  const bpath = join(dir, BACKUP);
  if (!existsSync(bpath)) return false;
  let b: Backup;
  try { b = JSON.parse(readFileSync(bpath, "utf8")) as Backup; } catch { rmSync(bpath, { force: true }); return false; }
  if (!ALLOWED.has(b.file)) { rmSync(bpath, { force: true }); return false; }
  const abs = join(dir, b.file);
  rmSync(abs, { force: true });
  if (b.existed) {
    if (b.symlink !== undefined) symlinkSync(b.symlink, abs);
    else {
      writeFileSync(abs, Buffer.from(b.contentB64 ?? "", "base64"));
      if (b.mode !== undefined) chmodSync(abs, b.mode);
      if (b.mtimeMs !== undefined) { const t = new Date(b.mtimeMs); utimesSync(abs, t, t); }
    }
  }
  rmSync(bpath, { force: true });
  const ad = join(dir, ".agent-room");
  try { if (!readdirSync(ad).length) rmdirSync(ad); } catch { /* not empty or gone */ }
  return true;
}
