import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { runProc } from "../adapters/proc.js";
import { changedFiles, snapshot } from "./workspace.js";

/**
 * 1.4 Worktree per task.
 *
 * A goal's folder is the BASE. Every task attempt works in its own isolated copy of it:
 *   - kind "git":  a git worktree of the base repo on its own branch `ar/<taskId>`, under <data>/worktrees/<goalId>/<taskId>.
 *                  A base that is not a repo yet is `git init`ed with one base commit (hub identity).
 *   - kind "copy": a plain folder copy, used when git is missing or fails. It remembers the base snapshot it was cut from.
 *
 * Lifecycle (all calls for one goal run one at a time, so two tasks finishing together never race in the base repo):
 *   open     cut a fresh worktree from the base head. The SAME agent revising the SAME task gets its worktree back
 *            (its work in progress is kept); a different agent gets a fresh one.
 *   accept   commit the work (author = the agent), then merge into the base: fast-forward when the base has not moved,
 *            else a real merge. On a conflict nothing is changed in the base. The merge is aborted there, and the latest base
 *            is MERGED INTO THE TASK'S WORKTREE instead, leaving conflict markers in the conflicting files for the agent to
 *            resolve (the agent's own edits are never reset or lost). The caller sends the task back with the file names.
 *            Accepting again refuses while the markers are still there.
 *            Copy kind: changed files are copied back only if each target is unchanged since the copy was cut; otherwise it is
 *            a conflict, and the copy is refreshed with the latest base files (conflicting ones as whole-file markers).
 *   discard  remove the worktree and its branch (or the copy). Idempotent.
 *   cleanup  discard everything a goal still holds.   prune   at hub start: drop worktrees whose task is no longer open.
 *
 * Git is run through runProc with an injectable binary, never through a shell. Hooks and the user's git config are bypassed
 * so the hub's commits are deterministic.
 */

export const HUB_IDENTITY = { name: "Agent Room", email: "hub@agent-room.local" };

export interface WorkspaceOptions { dataDir: string; /** git binary; default $AGENT_ROOM_GIT or "git" */ git?: string }
export interface GoalRef { id: string; folder: string }
export interface TaskWorkspace {
  goalId: string; taskId: string; agentId: string;
  kind: "git" | "copy";
  /** The task's own directory: the agent's cwd. */
  path: string;
  /** The goal folder this was cut from. */
  base: string;
  branch?: string;
  /** copy kind: base snapshot (path -> hash) the copy was cut from. */
  snap?: Record<string, string>;
  /** Files left with conflict markers by the last failed accept. */
  conflicted?: string[];
}
export type AcceptResult =
  | { ok: true; merged: string[]; how: "empty" | "fast-forward" | "merge" | "copy" }
  | { ok: false; conflict: string[]; /** true when the files still carry the markers from last time */ markers?: boolean };

/** Hooks other items plug into (1.9 writes/restores the agent's context file here). Errors are logged, never fatal. */
export interface WorkspaceHookContext { goalId: string; taskId: string; agentId: string; path: string; kind: "git" | "copy" }
export interface WorkspaceHooks {
  /** Just before the agent runs in the worktree (before the "files before" snapshot, so hub-written files are not the agent's change). */
  beforeRun?(c: WorkspaceHookContext): void | Promise<void>;
  /** Just before the worktree is committed and merged into the base (restore anything the hub added). */
  beforeMerge?(c: WorkspaceHookContext): void | Promise<void>;
}

const BRANCH = (taskId: string) => `ar/${taskId}`;
const EXCLUDES = ["LEDGER.md", ".agent-room*", "node_modules", ".DS_Store"];
const hasMarkers = (text: string) => /^<{7}(?: .*)?$/m.test(text) && /^>{7}(?: .*)?$/m.test(text);

export class TaskWorkspaces {
  private chains = new Map<string, Promise<unknown>>();
  private copyOnly = new Set<string>();
  private gitBin: string;
  constructor(private o: WorkspaceOptions) { this.gitBin = o.git ?? process.env.AGENT_ROOM_GIT ?? "git"; }

  // ---------- paths and metadata
  root(goalId?: string) { return goalId ? join(this.o.dataDir, "worktrees", goalId) : join(this.o.dataDir, "worktrees"); }
  pathFor(goalId: string, taskId: string) { return join(this.root(goalId), taskId); }
  private metaFile(goalId: string, taskId: string) { return join(this.root(goalId), `${taskId}.json`); }
  /** The task's live workspace, if it has one. */
  find(goalId: string, taskId: string): TaskWorkspace | undefined {
    try {
      const m = JSON.parse(readFileSync(this.metaFile(goalId, taskId), "utf8")) as TaskWorkspace;
      return existsSync(m.path) ? m : undefined;
    } catch { return undefined; }
  }
  private save(m: TaskWorkspace) { mkdirSync(this.root(m.goalId), { recursive: true }); writeFileSync(this.metaFile(m.goalId, m.taskId), JSON.stringify(m)); }
  private listMeta(goalId: string): TaskWorkspace[] {
    let names: string[] = [];
    try { names = readdirSync(this.root(goalId)); } catch { return []; }
    return names.filter((n) => n.endsWith(".json")).flatMap((n) => {
      try { return [JSON.parse(readFileSync(join(this.root(goalId), n), "utf8")) as TaskWorkspace]; } catch { return []; }
    });
  }

  // ---------- git
  private git(cwd: string, args: string[], stdin?: string) {
    return runProc(this.gitBin, [
      "-c", `user.name=${HUB_IDENTITY.name}`, "-c", `user.email=${HUB_IDENTITY.email}`,
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "core.quotepath=off",
      "-c", "init.defaultBranch=main", "-c", "merge.ff=true", "-c", "gc.auto=0",
      ...args,
    ], {
      cwd, stdin, timeoutMs: 120_000,
      env: {
        GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C",
        GIT_AUTHOR_NAME: HUB_IDENTITY.name, GIT_AUTHOR_EMAIL: HUB_IDENTITY.email,
        GIT_COMMITTER_NAME: HUB_IDENTITY.name, GIT_COMMITTER_EMAIL: HUB_IDENTITY.email,
      },
    });
  }
  private async gitOk(cwd: string, args: string[]) { const r = await this.git(cwd, args); return r.code === 0; }
  private async out(cwd: string, args: string[]) { const r = await this.git(cwd, args); return r.code === 0 ? r.stdout.trim() : ""; }
  private names(stdout: string) { return stdout.split("\0").filter(Boolean).sort(); }

  /** Run one goal's workspace operations one at a time. */
  private locked<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(goalId) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.chains.set(goalId, next.catch(() => undefined));
    return next;
  }

  /** Commit anything sitting uncommitted in the base (a check that wrote a file, say), so merges never trip on it. */
  private async syncBase(base: string) {
    await this.git(base, ["add", "-A"]);
    if (!(await this.gitOk(base, ["diff", "--cached", "--quiet"]))) await this.git(base, ["commit", "--no-verify", "-m", "Agent Room: changes made in the goal folder"]);
  }

  /**
   * Make the goal folder a git repo with a base commit. Returns "git" (ready) or "copy" (git unusable).
   * LEDGER.md and .agent-room* are excluded locally (.git/info/exclude), never in the owner's .gitignore.
   */
  async base(goal: GoalRef): Promise<"git" | "copy"> {
    if (this.copyOnly.has(goal.id)) return "copy";
    mkdirSync(goal.folder, { recursive: true });
    if (!existsSync(join(goal.folder, ".git"))) {
      const init = await this.git(goal.folder, ["init", "-q"]);
      if (init.code !== 0) { this.copyOnly.add(goal.id); return "copy"; }
    }
    try {
      const exclude = join(goal.folder, ".git", "info", "exclude");
      mkdirSync(dirname(exclude), { recursive: true });
      const have = existsSync(exclude) ? readFileSync(exclude, "utf8").split("\n") : [];
      const missing = EXCLUDES.filter((e) => !have.includes(e));
      if (missing.length) appendFileSync(exclude, `${have.length && have.at(-1) !== "" ? "\n" : ""}${missing.join("\n")}\n`);
    } catch { /* an unwritable exclude only means the ledger may show up as a change */ }
    if (await this.gitOk(goal.folder, ["rev-parse", "--verify", "-q", "HEAD"])) await this.syncBase(goal.folder);
    else {
      await this.git(goal.folder, ["add", "-A"]);
      const c = await this.git(goal.folder, ["commit", "--no-verify", "--allow-empty", "-q", "-m", "Agent Room: base"]);
      if (c.code !== 0) { this.copyOnly.add(goal.id); return "copy"; }
    }
    return "git";
  }

  // ---------- open
  /** The task's workspace for this attempt: reused for the same agent, otherwise fresh from the current base. */
  open(goal: GoalRef, task: { id: string }, agentId: string): Promise<TaskWorkspace & { reused: boolean }> {
    return this.locked(goal.id, async () => {
      const have = this.find(goal.id, task.id);
      if (have && have.agentId === agentId) return { ...have, reused: true };
      await this.discardNow(goal, task.id);
      mkdirSync(this.root(goal.id), { recursive: true });
      const path = this.pathFor(goal.id, task.id);
      if ((await this.base(goal)) === "git") {
        const head = await this.out(goal.folder, ["rev-parse", "HEAD"]);
        const add = head ? await this.git(goal.folder, ["worktree", "add", "-q", "-B", BRANCH(task.id), path, head]) : undefined;
        if (add?.code === 0) {
          const m: TaskWorkspace = { goalId: goal.id, taskId: task.id, agentId, kind: "git", path, base: goal.folder, branch: BRANCH(task.id) };
          this.save(m); return { ...m, reused: false };
        }
        rmSync(path, { recursive: true, force: true });
        await this.git(goal.folder, ["worktree", "prune"]);
      }
      // No git: a plain folder copy that remembers what it was cut from.
      const snap = snapshot(goal.folder);
      mkdirSync(path, { recursive: true });
      for (const rel of snap.keys()) { const to = join(path, rel); mkdirSync(dirname(to), { recursive: true }); cpSync(join(goal.folder, rel), to); }
      const m: TaskWorkspace = { goalId: goal.id, taskId: task.id, agentId, kind: "copy", path, base: goal.folder, snap: Object.fromEntries(snap) };
      this.save(m); return { ...m, reused: false };
    });
  }

  // ---------- accept
  accept(goal: GoalRef, task: { id: string; title?: string }): Promise<AcceptResult> {
    return this.locked(goal.id, async () => {
      const m = this.find(goal.id, task.id);
      if (!m) return { ok: true, merged: [], how: "empty" };
      // Markers left from the last conflict must be resolved before anything merges.
      const stuck = (m.conflicted ?? []).filter((f) => { try { return hasMarkers(readFileSync(join(m.path, f), "utf8")); } catch { return false; } });
      if (stuck.length) return { ok: false, conflict: stuck, markers: true };
      if (m.conflicted?.length) { m.conflicted = []; this.save(m); }
      return m.kind === "git" ? this.acceptGit(m, task) : this.acceptCopy(m);
    });
  }

  private async acceptGit(m: TaskWorkspace, task: { id: string; title?: string }): Promise<AcceptResult> {
    const wt = m.path, base = m.base, branch = m.branch!;
    // 1. commit the agent's work on its branch (author = the agent)
    await this.git(wt, ["add", "-A"]);
    const merging = await this.gitOk(wt, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    const dirty = !(await this.gitOk(wt, ["diff", "--cached", "--quiet"]));
    if (dirty || merging) {
      const c = await this.git(wt, ["commit", "--no-verify", "--allow-empty", "-m", task.title ? `Task: ${task.title}` : `Task ${task.id}`, "--author", `${m.agentId} <${m.agentId}@agent-room.local>`]);
      if (c.code !== 0) return { ok: false, conflict: [] };
    }
    // 2. merge into the base
    await this.syncBase(base);
    const before = await this.out(base, ["rev-parse", "HEAD"]);
    if (await this.gitOk(base, ["merge-base", "--is-ancestor", branch, "HEAD"])) return { ok: true, merged: [], how: "empty" };
    const fastForward = await this.gitOk(base, ["merge-base", "--is-ancestor", "HEAD", branch]);
    const r = await this.git(base, ["merge", "--no-edit", "-m", task.title ? `Merge task: ${task.title}` : `Merge task ${task.id}`, branch]);
    if (r.code === 0) {
      const files = this.names((await this.git(base, ["diff", "--name-only", "-z", before, "HEAD"])).stdout);
      return { ok: true, merged: files, how: fastForward ? "fast-forward" : "merge" };
    }
    // 3. conflict: leave the base exactly as it was, bring the latest base into the task's worktree for the agent to resolve
    let conflict = this.names((await this.git(base, ["diff", "--name-only", "-z", "--diff-filter=U"])).stdout);
    if (!conflict.length) conflict = this.names((await this.git(base, ["diff", "--name-only", "-z", `${before}...${branch}`])).stdout);
    await this.git(base, ["merge", "--abort"]);
    await this.git(wt, ["merge", "--no-edit", "-m", "Bring in accepted work from other tasks", before]);
    m.conflicted = conflict; this.save(m);
    return { ok: false, conflict };
  }

  private async acceptCopy(m: TaskWorkspace): Promise<AcceptResult> {
    const was = new Map(Object.entries(m.snap ?? {}));
    const mine = snapshot(m.path), theirs = snapshot(m.base);
    const changed = changedFiles(was, mine);
    const clash = changed.filter((p) => theirs.get(p) !== was.get(p) && theirs.get(p) !== mine.get(p));
    if (!clash.length) {
      const merged: string[] = [];
      for (const p of changed) {
        const to = join(m.base, p);
        if (mine.has(p)) { mkdirSync(dirname(to), { recursive: true }); cpSync(join(m.path, p), to); merged.push(p); }
        else if (existsSync(to)) { unlinkSync(to); merged.push(p); }
      }
      return { ok: true, merged, how: "copy" };
    }
    // Conflict: refresh the copy with the base's newer files so the agent sees them; conflicting files get whole-file markers.
    const snap = { ...(m.snap ?? {}) };
    for (const p of new Set([...theirs.keys(), ...was.keys()])) {
      if (theirs.get(p) === was.get(p) || clash.includes(p)) continue;
      if (mine.get(p) !== was.get(p)) continue; // the task changed it too, but identically or without a clash: leave it
      const to = join(m.path, p);
      if (theirs.has(p)) { mkdirSync(dirname(to), { recursive: true }); cpSync(join(m.base, p), to); } else rmSync(to, { force: true });
      if (theirs.has(p)) snap[p] = theirs.get(p)!; else delete snap[p];
    }
    for (const p of clash) {
      const read = (f: string) => { try { return readFileSync(f); } catch { return Buffer.alloc(0); } };
      const yours = read(join(m.path, p)), base = read(join(m.base, p));
      const to = join(m.path, p);
      mkdirSync(dirname(to), { recursive: true });
      if (yours.includes(0) || base.includes(0)) { if (theirs.has(p)) writeFileSync(to, base); else rmSync(to, { force: true }); }
      else writeFileSync(to, `<<<<<<< yours\n${yours.toString("utf8")}${yours.length && !yours.toString("utf8").endsWith("\n") ? "\n" : ""}=======\n${base.toString("utf8")}${base.length && !base.toString("utf8").endsWith("\n") ? "\n" : ""}>>>>>>> accepted work\n`);
      if (theirs.has(p)) snap[p] = theirs.get(p)!; else delete snap[p];
    }
    m.snap = snap; m.conflicted = clash; this.save(m);
    return { ok: false, conflict: clash };
  }

  // ---------- discard, cleanup, prune
  discard(goal: GoalRef, taskId: string): Promise<void> { return this.locked(goal.id, () => this.discardNow(goal, taskId)); }

  private async discardNow(goal: GoalRef, taskId: string) {
    const m = this.find(goal.id, taskId);
    const path = m?.path ?? this.pathFor(goal.id, taskId);
    const base = m?.base ?? goal.folder;
    if (m?.kind !== "copy" && existsSync(join(base, ".git"))) {
      await this.git(base, ["worktree", "remove", "--force", "--force", path]);
      await this.git(base, ["branch", "-D", BRANCH(taskId)]);
      await this.git(base, ["worktree", "prune"]);
    }
    rmSync(path, { recursive: true, force: true });
    rmSync(this.metaFile(goal.id, taskId), { force: true });
  }

  /** Remove every worktree and branch a goal still holds. `taskIds` also covers branches whose worktree is already gone. */
  cleanup(goal: GoalRef, taskIds: string[] = []): Promise<void> {
    return this.locked(goal.id, async () => {
      const ids = new Set([...this.listMeta(goal.id).map((m) => m.taskId), ...taskIds]);
      try { for (const n of readdirSync(this.root(goal.id))) if (!n.endsWith(".json")) ids.add(n); } catch { /* none */ }
      for (const t of ids) await this.discardNow(goal, t);
      if (existsSync(join(goal.folder, ".git"))) await this.git(goal.folder, ["worktree", "prune"]);
      try { rmSync(this.root(goal.id), { recursive: true, force: true }); } catch { /* best effort */ }
    });
  }

  /** Hub start: remove worktrees whose task is no longer open (or unknown). Returns the task ids removed. */
  async prune(keep: (goalId: string, taskId: string) => boolean): Promise<string[]> {
    const removed: string[] = [];
    let goals: string[] = [];
    try { goals = readdirSync(this.root()); } catch { return removed; }
    for (const goalId of goals) {
      const metas = this.listMeta(goalId);
      const base = metas[0]?.base;
      for (const m of metas) {
        if (keep(goalId, m.taskId) && existsSync(m.path)) continue;
        await this.locked(goalId, () => this.discardNow({ id: goalId, folder: m.base }, m.taskId));
        removed.push(m.taskId);
      }
      // directories with no metadata are leftovers
      try {
        for (const n of readdirSync(this.root(goalId))) {
          if (n.endsWith(".json") || this.listMeta(goalId).some((m) => m.taskId === n)) continue;
          rmSync(join(this.root(goalId), n), { recursive: true, force: true }); removed.push(n);
        }
      } catch { /* none */ }
      if (base && existsSync(join(base, ".git"))) await this.git(base, ["worktree", "prune"]);
      if (!this.listMeta(goalId).length) try { rmSync(this.root(goalId), { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return removed;
  }
}
