import { createHash } from "node:crypto";
import type { Goal } from "@agent-room/shared";
import { checkFile } from "../control/lint.js";
import type { ControlFolder } from "../control/folder.js";
import { todayString, type FileMeta } from "../control/schema.js";
import type { Store } from "../db/store.js";
import { retroDb, type LessonRow, type RetroDb } from "./db.js";
import { mechanicalLessons, type DraftLesson } from "./floor.js";
import { planLessons, planPlaybook, type AgentPlan, type LessonInput, type PlaybookPlan } from "./files.js";
import { buildRetroInput, hasSignal, retroPrompt, type RetroInput } from "./input.js";
import { LESSON_MAX, PLAYBOOK_LINE_MAX, cleanLine, cleanType, playbookSlug } from "./text.js";

/**
 * 2.1 Retros. When a goal ends (done or failed), the orchestrator reads what happened and writes lessons for each agent and
 * task type, and playbook lines for each task type. Written to the control folder when there is one (agents/<id>/LESSONS.md,
 * playbooks/<type>.md, one commit "Retro for <goal>") and always to the `lessons` and `playbooks` tables, so it works without one.
 */

export interface RetroDeps {
  store: Store;
  control?: ControlFolder;
  /** One JSON-only call to the orchestrator agent (Orchestrator.callJson). Null when it fails or isn't JSON. */
  callJson: <T>(prompt: string, role: "quick" | "lead") => Promise<T | null>;
  /** One quiet line in the goal's room. */
  post: (text: string) => void;
  now?: () => number;
}

export interface RetroResult {
  goalId: string;
  source: "orchestrator" | "mechanical" | "none";
  /** New lessons by agent and task type. */
  lessons: { agentId: string; taskType: string; count: number }[];
  lessonCount: number;
  playbookUpdates: number;
  retired: number;
  files: string[];
}

interface Output { lessons?: unknown; playbook?: unknown }
interface PlaybookOp { taskType: string; add: string[]; remove: string[] }

/** What the orchestrator said, kept only where it is well formed and about someone who was in this goal. */
export function acceptOutput(raw: unknown, input: RetroInput, names: Map<string, string> = new Map()): { lessons: DraftLesson[]; playbook: PlaybookOp[] } {
  const out: Output = raw && typeof raw === "object" ? (raw as Output) : {};
  const pairs = new Set(input.pairs.map((p) => `${p.agentId}\u0000${p.taskType}`));
  const types = new Set(input.pairs.map((p) => p.taskType));
  const lessons: DraftLesson[] = [];
  const perPair = new Map<string, number>();
  for (const l of Array.isArray(out.lessons) ? out.lessons.slice(0, 30) : []) {
    if (!l || typeof l !== "object") continue;
    const r = l as Record<string, unknown>;
    const agentId = typeof r.agentId === "string" ? (names.get(r.agentId.trim().toLowerCase()) ?? r.agentId.trim()) : "";
    const taskType = cleanType(r.taskType);
    const text = cleanLine(r.lesson, LESSON_MAX);
    const evidence = typeof r.evidence === "string" ? r.evidence.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    if (!pairs.has(`${agentId}\u0000${taskType}`) || !text || !evidence) continue;
    const k = `${agentId}\u0000${taskType}`;
    if ((perPair.get(k) ?? 0) >= 3) continue;
    perPair.set(k, (perPair.get(k) ?? 0) + 1);
    lessons.push({ agentId, taskType, text, evidence });
  }
  const playbook: PlaybookOp[] = [];
  for (const p of Array.isArray(out.playbook) ? out.playbook.slice(0, 12) : []) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const taskType = cleanType(r.taskType);
    if (!types.has(taskType)) continue;
    const lines = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => cleanLine(x, PLAYBOOK_LINE_MAX)).filter((x): x is string => !!x).slice(0, 3);
    const add = lines(r.add), remove = lines(r.remove);
    if (add.length || remove.length) playbook.push({ taskType, add, remove });
  }
  return { lessons, playbook };
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const LESSONS_META = (agent: string): FileMeta => ({ kind: "lessons", agent });
const PLAYBOOK_META = (taskType: string): FileMeta => ({ kind: "playbook", taskType });

/** Save the rows a plan produced: new ones inserted, changed ones updated. */
function persist(db: RetroDb, before: LessonRow[], plan: AgentPlan) {
  const old = new Map(before.map((r) => [r.id, r]));
  db.tx(() => {
    for (const r of plan.rows) {
      const b = old.get(r.id);
      if (!b) { db.insert({ ...r, id: undefined }); continue; }
      if (b.active !== r.active || b.retired !== r.retired || b.reason !== r.reason || b.confirmedAt !== r.confirmedAt || b.seen !== r.seen) {
        db.patch(r.id, { active: r.active, retired: r.retired, reason: r.reason, confirmedAt: r.confirmedAt, seen: r.seen });
      }
    }
  });
}

/** "Retro: 3 lessons for Codex on coding, 1 playbook update" */
export function retroLine(store: Store, r: Pick<RetroResult, "lessons" | "playbookUpdates">): string {
  const name = (id: string) => store.getAgent(id)?.name ?? id;
  const parts = r.lessons.slice(0, 3).map((l, i) => `${l.count}${i === 0 ? ` ${l.count === 1 ? "lesson" : "lessons"}` : ""} for ${name(l.agentId)} on ${l.taskType}`);
  if (r.lessons.length > 3) parts.push("more");
  if (r.playbookUpdates) parts.push(`${r.playbookUpdates} playbook update${r.playbookUpdates === 1 ? "" : "s"}`);
  return `Retro: ${parts.join(", ")}`;
}

/** Run the retro for a goal that has ended. Never throws; a retro must not be able to hurt the goal it describes. */
export async function runRetro(deps: RetroDeps, goalId: string): Promise<RetroResult | undefined> {
  const { store } = deps;
  try {
    const goal = store.getGoal(goalId);
    if (!goal || (goal.status !== "done" && goal.status !== "failed")) return undefined; // superseded, paused or gone: no retro
    if (store.getKV("practice_mode", false)) return undefined; // practice agents teach nothing worth keeping
    const input = buildRetroInput(store, goal);
    if (!input.tasks.length) return undefined;
    const digest = hash(JSON.stringify(input));
    if (store.getKV<string | null>(`retro_done:${goalId}`, null) === digest) return undefined; // the same goal state was already studied

    // ---- ask the orchestrator; fall back to what the failure tags and repeated feedback say
    const names = new Map(store.listAgents().flatMap((a) => [[a.id.toLowerCase(), a.id], [a.name.toLowerCase(), a.id]] as [string, string][]));
    let said: unknown = null;
    try { said = await deps.callJson<Output>(retroPrompt(input), hasSignal(input) ? "lead" : "quick"); } catch { said = null; }
    const accepted = acceptOutput(said, input, names);
    let drafts = accepted.lessons;
    let source: RetroResult["source"] = drafts.length || accepted.playbook.length ? "orchestrator" : "none";
    if (!drafts.length && hasSignal(input)) {
      drafts = mechanicalLessons(input);
      if (drafts.length) source = "mechanical";
    }

    const result = await write(deps, goal, drafts, accepted.playbook, source);
    store.setKV(`retro_done:${goalId}`, digest);
    return result;
  } catch (e) {
    try { store.audit("orchestrator", "retro.failed", `${goalId}: ${(e as Error).message}`.slice(0, 400)); } catch { /* nothing more to do */ }
    return undefined;
  }
}

async function write(deps: RetroDeps, goal: Goal, drafts: DraftLesson[], ops: PlaybookOp[], source: RetroResult["source"]): Promise<RetroResult> {
  const { store, control } = deps;
  const db = retroDb(store);
  const now = (deps.now ?? Date.now)();
  const today = todayString(new Date(now));
  const result: RetroResult = { goalId: goal.id, source, lessons: [], lessonCount: 0, playbookUpdates: 0, retired: 0, files: [] };
  const skipped: string[] = [];

  const byAgent = new Map<string, LessonInput[]>();
  for (const d of drafts) {
    if (!store.getAgent(d.agentId)) continue;
    byAgent.set(d.agentId, [...(byAgent.get(d.agentId) ?? []), { taskType: d.taskType, text: d.text, goalId: goal.id, evidence: d.evidence }]);
  }

  /** Plan everything against the files as they are now; returns what to write and what to save once it is written. */
  const build = (read: (rel: string) => string | undefined) => {
    const files: { rel: string; text: string }[] = [];
    const saves: (() => void)[] = [];
    const tally: typeof result.lessons = [];
    let retired = 0, playbooks = 0;
    // A file the owner is mid-way through breaking is theirs to fix: leave it, and leave its lessons out of the database too.
    const usable = (rel: string, meta: FileMeta, existing: string | undefined) => existing === undefined || !checkFile(rel, meta, existing).blocks.length;
    const fits = (rel: string, meta: FileMeta, text: string) => { const f = checkFile(rel, meta, text); if (f.blocks.length) { skipped.push(`${rel}: ${f.blocks[0].message}`); return false; } return true; };

    for (const [agentId, inputs] of byAgent) {
      const rel = `agents/${agentId}/LESSONS.md`;
      const existing = control ? read(rel) : undefined;
      if (control && !usable(rel, LESSONS_META(agentId), existing)) { skipped.push(`${rel}: has a problem, left as it is`); continue; }
      const before = db.forAgent(agentId);
      const plan = planLessons(agentId, before, existing, inputs, now, today);
      if (control && plan.fileText !== undefined) { if (!fits(rel, LESSONS_META(agentId), plan.fileText)) continue; files.push({ rel, text: plan.fileText }); }
      saves.push(() => persist(db, before, plan));
      retired += plan.retired;
      for (const t of new Set(plan.added.map((r) => r.taskType))) tally.push({ agentId, taskType: t, count: plan.added.filter((r) => r.taskType === t).length });
    }

    for (const op of ops) {
      const slug = playbookSlug(op.taskType);
      const rel = slug ? `playbooks/${slug}.md` : undefined;
      const existing = control && rel ? read(rel) : undefined;
      if (control && rel && !usable(rel, PLAYBOOK_META(slug!), existing)) { skipped.push(`${rel}: has a problem, left as it is`); continue; }
      const plan: PlaybookPlan = planPlaybook(op.taskType, db.playbook(op.taskType), existing, op, goal.id, now, today);
      const changed = plan.added || plan.removed || plan.retired;
      if (!changed && plan.fileText === undefined) continue;
      if (control && rel && plan.fileText !== undefined) { if (!fits(rel, PLAYBOOK_META(slug!), plan.fileText)) continue; files.push({ rel, text: plan.fileText }); }
      saves.push(() => db.savePlaybook(plan.row));
      if (changed) playbooks++;
      retired += plan.retired;
    }
    return { files, tally, retired, playbooks, done: () => { for (const s of saves) s(); } };
  };

  if (control) {
    const built: { f?: ReturnType<typeof build> } = {};
    result.files = await control.update((read) => { built.f = build(read); return { files: built.f.files, done: built.f.done }; }, `Retro for ${goal.id}`, "orchestrator");
    if (built.f) { result.lessons = built.f.tally; result.retired = built.f.retired; result.playbookUpdates = built.f.playbooks; }
  } else {
    const f = build(() => undefined);
    f.done();
    result.lessons = f.tally; result.retired = f.retired; result.playbookUpdates = f.playbooks;
  }
  result.lessonCount = result.lessons.reduce((n, l) => n + l.count, 0);

  const detail = `${goal.id}: ${result.lessonCount} lesson${result.lessonCount === 1 ? "" : "s"}${result.lessons.length ? ` (${result.lessons.map((l) => `${l.agentId}/${l.taskType} ${l.count}`).join(", ")})` : ""}, ${result.playbookUpdates} playbook update${result.playbookUpdates === 1 ? "" : "s"}${result.retired ? `, ${result.retired} retired` : ""} [${source}${control ? "" : ", no control folder"}]${skipped.length ? `; skipped: ${skipped.join("; ")}` : ""}`;
  store.audit("orchestrator", "retro.written", detail.slice(0, 600));
  if (result.lessonCount || result.playbookUpdates) deps.post(retroLine(store, result));
  return result;
}
