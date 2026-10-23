import { basename } from "node:path";
import type { AgentConfig, Goal, Task } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { GoalRef, SourceOutcome } from "../orchestrator/worktree.js";
import type { FileBroker } from "./broker.js";

/** Where accepted work lands for a git folder. The owner merges it; the hub never touches their checked-out branch. */
export const branchFor = (goalId: string) => `agent-room/${goalId}`;

/**
 * 1.1: goals that work on a folder the owner granted.
 *
 * The owner points a goal at a grant (POST /rooms/:id/messages with folderGrantId, or POST /goals/:id/folder-grant). Then:
 *  - git repository, writable grant: tasks get worktrees cut from branch agent-room/<goal>; accepted work is merged into that branch.
 *    The owner's checked-out branch and working tree are never touched.
 *  - any other folder, or a read-only grant: tasks get copies of a private copy of the folder (see worktree.ts); nothing is written to the
 *    real folder except, for a writable grant, one diff proposal per accepted task that the owner approves or rejects.
 * This class holds the glue the orchestrator calls: resolving the grant, the note for prompts, and what to do once a task is accepted.
 */
export class GoalSources {
  constructor(private files: FileBroker, private store: Store) {}

  /** Can this grant be the folder of a goal started in this room? */
  usable(grantId: string, roomId: string): { ok: true } | { ok: false; reason: string } {
    const g = this.files.grant(grantId);
    if (!g) return { ok: false, reason: "That folder grant doesn't exist." };
    if (g.roomId && g.roomId !== roomId) return { ok: false, reason: "That folder is granted to a different room." };
    // A goal's tasks go to whichever agent suits them, so the folder must be open to every agent. A grant for one agent stays that agent's.
    if (g.agentId !== "*") return { ok: false, reason: "That folder is granted to one agent only. Grant it to every agent to start a goal on it." };
    if (!g.read) return { ok: false, reason: "That folder isn't readable, so a goal can't work on it." };
    return { ok: true };
  }

  /** The GoalRef the workspaces use: the hub's goal folder, plus the granted folder when the goal has one. */
  ref(goal: Goal, folder: string): GoalRef {
    if (!goal.sourceGrantId) return { id: goal.id, folder };
    const g = this.files.grant(goal.sourceGrantId);
    const branch = goal.sourceBranch ?? branchFor(goal.id);
    // A removed grant leaves the goal with the base it already has (if any) and writes nothing anywhere.
    if (!g) return { id: goal.id, folder, source: { grantId: goal.sourceGrantId, path: "", write: false, branch, revoked: true } };
    return { id: goal.id, folder, source: { grantId: g.id, path: g.path, write: g.write, label: g.label ?? basename(g.path), branch } };
  }

  /** What the planner and the agents are told about the folder. Only its label, never its location on the disk. */
  note(goal: Goal): string {
    if (!goal.sourceGrantId) return "";
    const g = this.files.grant(goal.sourceGrantId);
    if (!g) return "";
    const name = g.label ?? basename(g.path);
    return `\n\n[Folder: the owner pointed this goal at their folder "${name}" (${g.write ? "read and write" : "read only"}). Every task works in its own copy of it, as it was when the goal started. `
      + (g.write
        ? "Accepted work goes back to the folder only after the owner approves it (for a git repository it is committed to a separate branch the owner merges). Don't plan work that needs files outside this folder."
        : "Nothing is ever written back to the folder, so produce the results as files in your own copy and describe them in your report.")
      + "]";
  }

  /**
   * A task's work was accepted and merged into the goal's base. Tell the owner what happened to their folder, and for a
   * non-git folder with a writable grant hand the task's changes to the file broker as ONE proposal (every file, the whole diff).
   */
  afterAccept(goal: Goal, task: Task, agent: AgentConfig, out: SourceOutcome, say: (text: string) => void): void {
    const g = goal.sourceGrantId ? this.files.grant(goal.sourceGrantId) : undefined;
    const name = g ? g.label ?? basename(g.path) : "the folder";
    if (out.withheld) {
      this.store.audit(agent.id, "file.writeback.withheld", `${task.id} ${goal.sourceGrantId}: the grant no longer allows writing`);
      say(`"${task.title}" is accepted, but ${name} is no longer open for writing, so nothing was written to it.`);
      return;
    }
    if (out.mode === "granted-git") {
      this.store.audit(agent.id, "goal.source.merged", `${task.id} -> branch ${out.branch} in ${goal.sourceGrantId}`);
      say(`"${task.title}" is committed to the branch ${out.branch} in ${name}. Your own branch and files are untouched; merge ${out.branch} when you're ready.`);
      return;
    }
    if (!g || !out.changes) return; // read-only grant: the work stayed in the private copy
    const r = this.files.proposeTask({
      grantId: g.id, agentId: agent.id, roomId: goal.roomId, goalId: goal.id, taskId: task.id, title: task.title,
      changes: out.changes, skipped: out.skipped,
    });
    if (!r.ok) { say(`"${task.title}" is accepted, but its changes could not be prepared for ${name}: ${r.reason}`); return; }
    const skipped = r.skipped.length ? ` ${r.skipped.length} file${r.skipped.length === 1 ? "" : "s"} can't be written back (${r.skipped.slice(0, 3).map((s) => s.relPath).join(", ")}${r.skipped.length > 3 ? ", ..." : ""}); the approval lists them.` : "";
    if (!r.proposal) { say(`"${task.title}" is accepted. It changed nothing in ${name} that can be written back.${skipped}`); return; }
    const n = r.proposal.files?.length ?? 1;
    say(`"${task.title}": ${n} file${n === 1 ? "" : "s"} in ${name} wait for your approval. Open Approvals to see the whole diff; nothing changes until you approve.${skipped}`);
  }
}
