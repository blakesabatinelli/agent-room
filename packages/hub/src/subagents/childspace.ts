import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskWorkspace, TaskWorkspaces } from "../orchestrator/worktree.js";
import { ADD_EXCLUDES_TOP, hardLinkedFiles, inNodeModules } from "../orchestrator/worktree.js";
import { changedFiles, snapshot } from "../orchestrator/workspace.js";

/**
 * 3.3 A subagent that writes gets its OWN worktree, cut from its parent's worktree as it is at that moment, and what it did merges back
 * into the PARENT's worktree (never into the goal's base: that only happens when the parent's own task is accepted, as always).
 *
 * Cutting: the parent's work in progress (committed or not) is written to a commit on a temporary ref `refs/ar/snap/<child>` through a
 * throwaway index, so the parent's own index, branch and files are not touched. The child's worktree is created from that commit on
 * branch `ar/<child>`, in the same repository, next to the parent's. With no git (folder copies) the child gets a copy of the parent's folder.
 *
 * Merging back (the parent calls accept_subagent): the child's work is committed on its branch, the parent's work in progress is
 * committed on the parent's branch, and the child's branch is merged in. A conflict is first sent back to the CHILD (the parent's latest
 * work is merged into the child's worktree, leaving conflict markers there for it to resolve, one round); if it clashes again the markers are
 * left in the PARENT's worktree for the parent to resolve, and the parent's own accept refuses until they are gone (the same rule as any task).
 * Everything runs under the goal's lock, so it never races a task being merged. The same hardening as every hub git call applies
 * (TaskWorkspaces.git): the agents' `.git` pointers are put back, hard links are left out.
 */

const HUB_FILES = ADD_EXCLUDES_TOP; // 1.1 round 2: includes nested node_modules, and never relies on .git/info/exclude
const names = (stdout: string) => stdout.split("\0").filter(Boolean).sort();
const hasMarkers = (text: string) => /^<{7}(?: .*)?$/m.test(text) && /^>{7}(?: .*)?$/m.test(text);
const BRANCH = (id: string) => `ar/${id}`;
const SNAP = (id: string) => `refs/ar/snap/${id}`;

export type MergeResult =
  | { ok: true; merged: string[]; how: "empty" | "merge" | "copy" }
  /** `to`: who has to resolve it. "child" = the child's folder holds the markers; "parent" = the parent's does. */
  | { ok: false; conflict: string[]; to: "child" | "parent"; markers?: boolean };

export interface ChildWork { files: string[]; stat: string; diff: string }

export class ChildSpaces {
  constructor(private ws: TaskWorkspaces, private dataDir: string) {}

  /** The parent's own workspace, when it has one (a direct answer has none). */
  parent(goalId: string, parentTaskId: string): TaskWorkspace | undefined { return this.ws.find(goalId, parentTaskId); }
  find(goalId: string, childId: string): TaskWorkspace | undefined { return this.ws.find(goalId, childId); }

  /** Cut a child's worktree from the parent's current state. Undefined when the parent has no worktree. */
  open(goalId: string, parentTaskId: string, childId: string, agentId: string): Promise<TaskWorkspace | undefined> {
    return this.ws.locked(goalId, async () => {
      const parent = this.ws.find(goalId, parentTaskId);
      if (!parent) return undefined;
      const path = this.ws.pathFor(goalId, childId);
      mkdirSync(this.ws.root(goalId), { recursive: true });
      if (parent.kind === "git") {
        const m = await this.cutGit(goalId, parent, childId, agentId, path);
        if (m) return m;
        rmSync(path, { recursive: true, force: true });
      }
      // No git, or git could not cut it: a folder copy of what the parent has now.
      const snap = snapshot(parent.path);
      mkdirSync(path, { recursive: true });
      for (const rel of snap.keys()) { const to = join(path, rel); mkdirSync(dirname(to), { recursive: true }); cpSync(join(parent.path, rel), to); }
      const m: TaskWorkspace = { goalId, taskId: childId, agentId, kind: "copy", path, base: parent.path, snap: Object.fromEntries(snap), parentTaskId };
      this.ws.save(m);
      return m;
    });
  }

  private async cutGit(goalId: string, parent: TaskWorkspace, childId: string, agentId: string, path: string): Promise<TaskWorkspace | undefined> {
    const ws = this.ws;
    ws.bindTask(parent); ws.restorePointer(parent);
    const head = (await ws.git(parent.path, ["rev-parse", "HEAD"])).stdout.trim();
    if (!head) return undefined;
    const idx = join(this.dataDir, `snap-${childId}.index`);
    const env = { GIT_INDEX_FILE: idx };
    try {
      const links = hardLinkedFiles(parent.path).filter((l) => !inNodeModules(l)).map((l) => `:(exclude,literal)${l}`);
      if ((await ws.git(parent.path, ["read-tree", "HEAD"], undefined, false, env)).code !== 0) return undefined;
      if ((await ws.git(parent.path, ["add", "-A", "--", ".", ...HUB_FILES, ...links], undefined, false, env)).code !== 0) return undefined;
      const tree = (await ws.git(parent.path, ["write-tree"], undefined, false, env)).stdout.trim();
      if (!tree) return undefined;
      const sha = (await ws.git(parent.path, ["commit-tree", tree, "-p", head, "-m", `Agent Room: ${parent.taskId} work in progress for helper ${childId}`], undefined, false, env)).stdout.trim();
      if (!sha) return undefined;
      if ((await ws.git(parent.path, ["update-ref", SNAP(childId), sha])).code !== 0) return undefined;
      await ws.git(parent.base, ["worktree", "prune"]);
      const add = await ws.git(parent.base, ["worktree", "add", "-q", "-B", BRANCH(childId), path, sha]);
      if (add.code !== 0) return undefined;
      ws.guard.reconcile(parent.base); // 1.1 round 2: only keys git itself sets for a worktree are accepted; anything else written meanwhile is put back
      const m: TaskWorkspace = { goalId, taskId: childId, agentId, kind: "git", path, base: parent.base, branch: BRANCH(childId), gitdir: this.pointer(path), parentTaskId: parent.taskId };
      ws.save(m); ws.bindTask(m);
      return m;
    } finally { rmSync(idx, { force: true }); }
  }

  private pointer(path: string): string | undefined { try { return readFileSync(join(path, ".git"), "utf8"); } catch { return undefined; } }

  /** Commit what the child did on its own branch (git), and say what it changed against the state it was cut from. */
  finish(goalId: string, childId: string, agentId: string, title: string): Promise<ChildWork> {
    return this.ws.locked(goalId, async () => {
      const m = this.ws.find(goalId, childId);
      if (!m) return { files: [], stat: "", diff: "" };
      if (m.kind === "copy") return { files: changedFiles(new Map(Object.entries(m.snap ?? {})), snapshot(m.path)), stat: "", diff: "" };
      await this.commitChild(m, agentId, title);
      const ws = this.ws;
      const files = names((await ws.git(m.path, ["diff", "--name-only", "-z", SNAP(childId), "HEAD"])).stdout);
      const stat = (await ws.git(m.path, ["diff", "--stat", SNAP(childId), "HEAD"])).stdout.trim();
      const diff = (await ws.git(m.path, ["diff", "--no-color", SNAP(childId), "HEAD"])).stdout.slice(0, 6000);
      return { files, stat, diff };
    });
  }

  private async commitChild(m: TaskWorkspace, agentId: string, title: string) {
    const ws = this.ws;
    ws.bindTask(m); ws.restorePointer(m);
    const links = hardLinkedFiles(m.path).filter((l) => !inNodeModules(l)).map((l) => `:(exclude,literal)${l}`);
    await ws.git(m.path, ["add", "-A", "--", ".", ...HUB_FILES, ...links]);
    const merging = (await ws.git(m.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
    const dirty = (await ws.git(m.path, ["diff", "--cached", "--quiet"])).code !== 0;
    if (dirty || merging) await ws.git(m.path, ["commit", "--no-verify", "--allow-empty", "-m", `Helper: ${title}`.slice(0, 200), "--author", `${agentId} <${agentId}@agent-room.local>`]);
  }

  /** Merge the child's work into the parent's worktree. `round` = how many times this child has already clashed with its parent. */
  merge(goalId: string, parentTaskId: string, childId: string, o: { childAgentId: string; parentAgentId: string; title: string; round: number }): Promise<MergeResult> {
    return this.ws.locked(goalId, async () => {
      const child = this.ws.find(goalId, childId), parent = this.ws.find(goalId, parentTaskId);
      if (!child || !parent) return { ok: true, merged: [], how: "empty" };
      // Markers the child was told to resolve must be gone before it merges.
      const stuck = (child.conflicted ?? []).filter((f) => { try { return hasMarkers(readFileSync(join(child.path, f), "utf8")); } catch { return false; } });
      if (stuck.length) return { ok: false, conflict: stuck, to: "child", markers: true };
      if (child.conflicted?.length) { child.conflicted = []; this.ws.save(child); }
      return child.kind === "git" ? this.mergeGit(child, parent, o) : this.mergeCopy(child, parent, o.round);
    });
  }

  private async mergeGit(child: TaskWorkspace, parent: TaskWorkspace, o: { childAgentId: string; parentAgentId: string; title: string; round: number }): Promise<MergeResult> {
    const ws = this.ws, wt = parent.path;
    await this.commitChild(child, o.childAgentId, o.title);
    ws.bindTask(parent); ws.restorePointer(parent);
    // the parent's own work in progress goes on its branch first, so the merge never trips on uncommitted files
    const links = hardLinkedFiles(wt).filter((l) => !inNodeModules(l)).map((l) => `:(exclude,literal)${l}`);
    await ws.git(wt, ["add", "-A", "--", ".", ...HUB_FILES, ...links]);
    if ((await ws.git(wt, ["diff", "--cached", "--quiet"])).code !== 0) await ws.git(wt, ["commit", "--no-verify", "-m", "Work in progress (before merging a helper)", "--author", `${o.parentAgentId} <${o.parentAgentId}@agent-room.local>`]);
    const before = (await ws.git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    if ((await ws.git(wt, ["merge-base", "--is-ancestor", child.branch!, "HEAD"])).code === 0) return { ok: true, merged: [], how: "empty" };
    const r = await ws.git(wt, ["merge", "--no-edit", "-m", `Merge helper: ${o.title}`.slice(0, 200), child.branch!]);
    if (r.code === 0) return { ok: true, merged: names((await ws.git(wt, ["diff", "--name-only", "-z", before, "HEAD"])).stdout), how: "merge" };
    let conflict = names((await ws.git(wt, ["diff", "--name-only", "-z", "--diff-filter=U"])).stdout);
    if (!conflict.length) conflict = names((await ws.git(wt, ["diff", "--name-only", "-z", `${before}...${child.branch}`])).stdout);
    if (o.round < 1) {
      // First clash: back to the child. The parent is left exactly as it was; the child's folder gets the parent's latest work, with markers.
      await ws.git(wt, ["merge", "--abort"]);
      await ws.git(child.path, ["merge", "--no-edit", "-m", "Bring in the parent's latest work", before]);
      child.conflicted = conflict; ws.save(child);
      return { ok: false, conflict, to: "child" };
    }
    // Second clash: the markers stay in the parent's worktree, for the parent to resolve. Its own accept refuses until they are gone.
    parent.conflicted = conflict; ws.save(parent);
    return { ok: false, conflict, to: "parent" };
  }

  private async mergeCopy(child: TaskWorkspace, parent: TaskWorkspace, round: number): Promise<MergeResult> {
    const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
    // the child's own versions, before a clash rewrites its files with markers
    const own = new Map(changedFiles(new Map(Object.entries(child.snap ?? {})), snapshot(child.path)).map((f) => [f, read(join(child.path, f))] as const));
    const r = await this.ws.acceptCopy(child); // base is the parent's folder
    if (r.ok) return { ok: true, merged: r.merged, how: r.merged.length ? "copy" : "empty" };
    if (round < 1) return { ok: false, conflict: r.conflict, to: "child" };
    // Second clash: whole-file markers in the parent's folder, the parent's version against the child's.
    for (const f of r.conflict) {
      const mine = read(join(parent.path, f)), theirs = own.get(f) ?? "";
      writeFileSync(join(parent.path, f), `<<<<<<< yours\n${mine}${mine.endsWith("\n") ? "" : "\n"}=======\n${theirs}${theirs.endsWith("\n") ? "" : "\n"}>>>>>>> helper\n`);
    }
    parent.conflicted = r.conflict; this.ws.save(parent);
    return { ok: false, conflict: r.conflict, to: "parent" };
  }

  /** Remove a child's worktree and branch (and its temporary snapshot ref). Idempotent. */
  async discard(goalId: string, childId: string): Promise<void> {
    const m = this.ws.find(goalId, childId);
    if (!m) return; // nothing was ever cut, or it is already gone
    if (m.kind === "git" && existsSync(join(m.base, ".git"))) await this.ws.git(m.base, ["update-ref", "-d", SNAP(childId)]);
    await this.ws.discard({ id: goalId, folder: m.base }, childId);
  }
}
