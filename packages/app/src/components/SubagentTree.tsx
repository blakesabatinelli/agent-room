import React from "react";
import type { Task } from "@agent-room/shared";
import { Pill } from "./ui";

/**
 * 3.3 Subagents in the task list. A helper (a task another agent started with spawn_agent, or one an agent's own tool launched) is a child of
 * the task that started it. The panels show each child right under its parent, indented, in its own agent's colour.
 */

export interface TreeRow { task: Task; depth: number }

/** The goal's tasks in tree order: plan tasks by creation time, each followed by its helpers (and theirs). A child whose parent is missing is shown at the top. */
export function treeRows(tasks: Task[]): TreeRow[] {
  const byParent = new Map<string, Task[]>();
  const ids = new Set(tasks.map((t) => t.id));
  const top: Task[] = [];
  for (const t of tasks) {
    if (t.parentTaskId && ids.has(t.parentTaskId)) byParent.set(t.parentTaskId, [...(byParent.get(t.parentTaskId) ?? []), t]);
    else top.push(t);
  }
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (t: Task, depth: number) => {
    if (seen.has(t.id)) return; // a cycle would be a bug elsewhere; never loop on it
    seen.add(t.id);
    out.push({ task: t, depth });
    for (const c of (byParent.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)) walk(c, depth + 1);
  };
  for (const t of top.sort((a, b) => a.createdAt - b.createdAt)) walk(t, 0);
  return out;
}

/** What a helper is: "built in" (the agent's own subagent), "read-only", or "writes". Nothing for an ordinary task. */
export function helperKind(t: Task): "built-in" | "read-only" | "writes" | undefined {
  if (t.kind !== "subagent") return undefined;
  return t.native ? "built-in" : t.readOnly === false ? "writes" : "read-only";
}

/** A helper's status in plain words. A writing helper that finished waits for its parent to take (or drop) the change. */
export function helperStatus(t: Task, base: string): string {
  if (t.kind === "subagent" && t.status === "review") return "Waiting for its parent to take the change";
  return base;
}

/** The small badge next to a helper's name. */
export function HelperBadge({ task }: { task: Task }) {
  const kind = helperKind(task);
  return kind ? <Pill text={kind} /> : null;
}
