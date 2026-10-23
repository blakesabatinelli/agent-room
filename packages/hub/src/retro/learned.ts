import type { AgentConfig } from "@agent-room/shared";
import type { ControlFolder } from "../control/folder.js";
import type { Store } from "../db/store.js";
import { retroDb } from "./db.js";
import { lessonLines, playbookLines } from "./files.js";
import { bytes, cleanType } from "./text.js";

/**
 * 2.1 What an agent is told from earlier goals when it starts a task, for the paths that don't go through the control
 * folder's context file (CONTROL.md section 3, layers 6 and 7): a hub without a control folder, and agents whose adapter
 * doesn't read a native context file. Capped at about 2 KB. The file wins when it is there: a line the owner deleted is gone.
 */

export const LEARNED_CAP = 2048;
/** Adapters whose CLI reads the context file the hub writes into the worktree (CLAUDE.md, AGENTS.md). */
const NATIVE_CONTEXT = new Set(["claude-code", "codex"]);

/** Active lessons for an agent and task type, newest first. */
export function lessonsFor(store: Store, control: ControlFolder | undefined, agentId: string, taskType: string): string[] {
  const type = cleanType(taskType);
  const doc = control?.snapshot().agents[agentId]?.lessons;
  if (doc) return lessonLines(doc.body, type).reverse(); // the file lists oldest first
  return retroDb(store).active(agentId, type).map((l) => l.text);
}

/** The playbook for a task type, in file order. */
export function playbookFor(store: Store, control: ControlFolder | undefined, agentId: string, taskType: string): string[] {
  const pb = control && Object.values(control.snapshot().playbooks).find((p) => p.fm.task_type === taskType && (p.fm.applies_to === "*" || p.fm.applies_to.includes(agentId)));
  if (pb) return playbookLines(pb.body);
  return retroDb(store).playbook(cleanType(taskType))?.lines ?? [];
}

/**
 * The block `taskPrompt` shows an agent, or undefined when there is nothing to say or the control folder's context file
 * already carries it. Oldest lessons are dropped first, then the end of the playbook, to stay under the cap.
 */
export function learnedBlock(store: Store, control: ControlFolder | undefined, agent: Pick<AgentConfig, "id" | "adapter">, taskType: string): string | undefined {
  if (control && NATIVE_CONTEXT.has(agent.adapter)) return undefined;
  const lessons = lessonsFor(store, control, agent.id, taskType);
  const playbook = playbookFor(store, control, agent.id, taskType);
  if (!lessons.length && !playbook.length) return undefined;
  const text = () => [
    `# Learned from earlier ${taskType} work (retros; follow these unless the task says otherwise)`,
    ...(playbook.length ? [`Playbook for ${taskType}:`, ...playbook.map((l) => `- ${l}`)] : []),
    ...(lessons.length ? [`Lessons for you on ${taskType}:`, ...lessons.map((l) => `- ${l}`)] : []),
  ].join("\n");
  while (bytes(text()) > LEARNED_CAP && lessons.length) lessons.pop();
  while (bytes(text()) > LEARNED_CAP && playbook.length) playbook.pop();
  return lessons.length || playbook.length ? text() : undefined;
}
