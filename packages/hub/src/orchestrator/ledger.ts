import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { AgentConfig, Goal, GoalProgress, Requirement, Task } from "@agent-room/shared";

/**
 * The orchestration layer's shared state, kept outside any one agent's context:
 *  - the requirement list (the request expanded into everything "done" must include),
 *  - plan checks that run before any work starts,
 *  - LEDGER.md in the goal folder, rewritten by the orchestrator (never by agents) after every change,
 *  - failure classification, so a flaky CLI isn't mistaken for a bad agent.
 */

export const LEDGER_FILE = "LEDGER.md";
export const MAX_TASKS = 10;

export interface RawPlanTask {
  key: string; owner?: string; title: string; description: string; taskType?: string; acceptance?: string;
  criteria?: unknown; scope?: string; outOfScope?: string[]; role?: string; files?: string[]; dependsOn?: string[];
  output?: string; covers?: string[];
  /** 1.3: data sources or connectors this task needs ("salesforce", "gmail"). Cleaned in buildTasks. */
  needs?: unknown;
}

export function newProgress(): GoalProgress { return { runs: 0, stall: 0, goalReplans: 0, verifyRounds: 0 }; }

/** Requirements from the planner, or (older plans) from the deliverables, or the objective itself. */
export function normaliseRequirements(raw: unknown, deliverables: string[], objective: string): Requirement[] {
  const texts = (Array.isArray(raw) ? raw : [])
    .map((r) => (typeof r === "string" ? r : String((r as { text?: string })?.text ?? "")).trim()).filter(Boolean);
  const list = texts.length ? texts : deliverables.length ? deliverables : [objective];
  return list.slice(0, 15).map((text, i) => ({ id: `G${i + 1}`, text, status: "open" as const }));
}

/**
 * Structural problems the planner must fix before anyone starts. Each message is written so it can be
 * handed straight back to the planner.
 */
export function validatePlan(tasks: RawPlanTask[], requirements: Requirement[], agentIds: Set<string>): string[] {
  const errors: string[] = [];
  if (!tasks.length) return ["The plan has no tasks."];
  if (tasks.length > MAX_TASKS) errors.push(`The plan has ${tasks.length} tasks; merge it down to ${MAX_TASKS} or fewer. Don't drop any requirement.`);
  const keys = new Set<string>();
  for (const t of tasks) {
    if (!t.key) errors.push(`A task ("${t.title}") has no key.`);
    else if (keys.has(t.key)) errors.push(`Two tasks share the key "${t.key}".`);
    keys.add(t.key);
    if (!t.description || t.description.trim().length < 20) errors.push(`Task ${t.key} needs a self-contained description: what to do, with what inputs, and what to hand back.`);
    if (!t.output?.trim()) errors.push(`Task ${t.key} doesn't say what it hands back ("output": a file name or exact format).`);
    if (t.owner && !agentIds.has(t.owner)) errors.push(`Task ${t.key} is owned by "${t.owner}", which isn't one of the available agents.`);
    const crit = Array.isArray(t.criteria) ? t.criteria : [];
    if (!crit.length && !t.acceptance) errors.push(`Task ${t.key} has no acceptance criteria.`);
  }
  for (const t of tasks) for (const d of t.dependsOn ?? []) if (!keys.has(d)) errors.push(`Task ${t.key} depends on "${d}", which isn't a task in this plan.`);
  const cycle = findCycle(tasks);
  if (cycle) errors.push(`Tasks depend on each other in a circle: ${cycle.join(" → ")}.`);
  // One writer per file, so parallel tasks can't overwrite each other.
  const writers = new Map<string, string>();
  for (const t of tasks) for (const f of t.files ?? []) {
    const k = normalize(f.trim());
    const prev = writers.get(k);
    if (prev && prev !== t.key) errors.push(`Tasks ${prev} and ${t.key} both write ${f}. Give each file one owner; later tasks can read it.`);
    else writers.set(k, t.key);
  }
  const ids = new Set(requirements.map((r) => r.id));
  for (const t of tasks) for (const c of t.covers ?? []) if (!ids.has(c)) errors.push(`Task ${t.key} covers "${c}", which isn't a requirement.`);
  const covered = new Set(tasks.flatMap((t) => t.covers ?? []));
  const missing = requirements.filter((r) => !covered.has(r.id));
  if (missing.length) errors.push(`No task delivers ${missing.map((r) => `${r.id} ("${r.text}")`).join(", ")}. Every requirement needs a task that covers it.`);
  return errors;
}

function findCycle(tasks: RawPlanTask[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn ?? []]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (k: string): string[] | undefined => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) return [...stack.slice(stack.indexOf(k)), k];
    state.set(k, 1); stack.push(k);
    for (const d of deps.get(k) ?? []) { if (!deps.has(d)) continue; const c = visit(d); if (c) return c; }
    stack.pop(); state.set(k, 2);
  };
  for (const k of deps.keys()) { const c = visit(k); if (c) return c; }
}

/** Last resort after a repair round: uncovered requirements go to the final task(s) nobody depends on. */
export function coverLeftovers(tasks: RawPlanTask[], requirements: Requirement[]) {
  const covered = new Set(tasks.flatMap((t) => t.covers ?? []));
  const left = requirements.filter((r) => !covered.has(r.id)).map((r) => r.id);
  if (!left.length || !tasks.length) return;
  const depended = new Set(tasks.flatMap((t) => t.dependsOn ?? []));
  const sinks = tasks.filter((t) => !depended.has(t.key));
  const target = sinks[sinks.length - 1] ?? tasks[tasks.length - 1];
  target.covers = [...new Set([...(target.covers ?? []), ...left])];
}

/** Drop dependencies that would make the plan unrunnable (unknown keys, cycles), keeping everything else. */
export function repairDeps(tasks: RawPlanTask[]) {
  const keys = new Set(tasks.map((t) => t.key));
  for (const t of tasks) t.dependsOn = (t.dependsOn ?? []).filter((d) => keys.has(d) && d !== t.key);
  for (let guard = 0; guard < tasks.length; guard++) {
    const c = findCycle(tasks); if (!c) return;
    const from = tasks.find((t) => t.key === c[c.length - 2]);
    if (from) from.dependsOn = (from.dependsOn ?? []).filter((d) => d !== c[c.length - 1]);
  }
}

/** Failures worth retrying on the same agent without counting an attempt: the CLI, not the work. */
export function isTransient(error?: string): boolean {
  return /rate.?limit|429|overloaded|529|503|502|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|temporarily unavailable|try again/i.test(error ?? "");
}

/** Same feedback twice in a row means the task is looping, not progressing. */
export function sameFeedback(a?: string, b?: string): boolean {
  const n = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const wa = new Set(x.split(" ")), wb = new Set(y.split(" "));
  const inter = [...wa].filter((w) => wb.has(w)).length;
  return inter / Math.max(wa.size, wb.size) > 0.85;
}

/** Contents of the task's deliverable files, so reviewers judge the artifact, not the chat message. */
export function readDeliverables(folder: string | undefined, files: string[], budget = 16000): string {
  if (!folder) return "";
  const out: string[] = [];
  let left = budget;
  for (const f of files) {
    if (left <= 0) { out.push(`(more files not shown: read them in ${folder})`); break; }
    const full = join(folder, f);
    if (!full.startsWith(folder) || !existsSync(full)) continue;
    try {
      if (!statSync(full).isFile()) continue;
      const body = readFileSync(full, "utf8");
      const cut = body.slice(0, Math.min(left, 6000));
      out.push(`--- ${f}${cut.length < body.length ? ` (first ${cut.length} of ${body.length} chars)` : ""}\n${cut}`);
      left -= cut.length;
    } catch { /* unreadable: skip */ }
  }
  return out.join("\n");
}

const mark = (s: Task["status"]) => s === "done" ? "x" : s === "failed" || s === "cancelled" ? "-" : " ";

/** The progress ledger as Markdown. Agents read it; only the orchestrator writes it. */
export function ledgerMarkdown(goal: Goal, tasks: Task[], agents: AgentConfig[], subagentBudget = 6 /* 3.3 */): string {
  const name = (id?: string) => agents.find((a) => a.id === id)?.name ?? id ?? "unassigned";
  const c = goal.contract;
  const reqs = c?.requirements ?? [];
  const p = goal.state?.progress;
  const lines = [
    `# ${c?.objective ?? goal.text}`,
    ``,
    `Status: ${goal.status}${p ? ` · ${p.runs} task runs · ${goal.state?.progress?.goalReplans ?? 0} replans` : ""}`,
    `Next: ${goal.state?.nextAction || "—"}`,
    ...(p?.subagents && (p.subagents.spawned || p.subagents.native) ? [`Helpers: ${p.subagents.spawned} of ${subagentBudget} started${p.subagents.native ? `, ${p.subagents.native} built-in (not counted)` : ""}`] : []), // 3.3
    ``,
    `## Requirements (what done means)`,
    ...(reqs.length ? reqs.map((r) => `- [${r.status === "met" ? "x" : " "}] ${r.id} ${r.text}${r.status === "unmet" ? ` — NOT MET${r.evidence ? `: ${r.evidence}` : ""}` : ""}  (${tasks.filter((t) => t.covers?.includes(r.id) && t.status !== "cancelled").map((t) => t.title).join(", ") || "no task yet"})`) : ["- (none)"]),
    ``,
    `## Tasks`,
    ...tasks.filter((t) => t.status !== "cancelled" || t.origin !== "plan").map((t) => {
      const last = t.history?.at(-1);
      return `- [${mark(t.status)}] ${t.title} — ${name(t.assignee ?? t.owner)}, ${t.status}${t.attempts ? `, attempt ${t.attempts}` : ""}${t.output ? `; hands back ${t.output}` : ""}`
        + (t.status !== "done" && last && last.outcome !== "ok" ? `\n  last: ${last.outcome} — ${last.note.slice(0, 200)}` : "")
        + (t.flagged?.length ? `\n  unverified: ${t.flagged.join(", ")}` : "");
    }),
    ``,
    `## Decisions everyone follows`,
    ...[...(c?.decisions ?? []).map((d) => `- ${d}`), ...(goal.state?.shared ?? []).map((d) => `- ${d.text} (from "${d.taskTitle}")`)],
    ...((c?.decisions?.length || goal.state?.shared?.length) ? [] : ["- (none yet)"]),
    ...(c?.amendments?.length ? [``, `## Owner amendments`, ...c.amendments.map((a) => `- ${a.text}`)] : []),
  ];
  return lines.join("\n") + "\n";
}

export function writeLedger(folder: string | undefined, md: string) {
  if (!folder || !existsSync(folder)) return;
  try { writeFileSync(join(folder, LEDGER_FILE), md); } catch { /* best effort; the ledger is also in every prompt */ }
}
