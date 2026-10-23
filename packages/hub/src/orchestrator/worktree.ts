import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { runProc } from "../adapters/proc.js";
import { GitConfigGuard, hardenedGitArgs, hardenedGitEnv } from "../files/gitSafe.js"; // 1.1
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
 * so the hub's commits are deterministic, and (1.1) every call is hardened against config an agent wrote into the repository: see files/gitSafe.ts.
 * A goal on a granted repo works in the hub's own clone of it (<goal>/_repo); accepted work is pushed to agent-room/<goal> in the owner's repo.
 */

export const HUB_IDENTITY = { name: "Agent Room", email: "hub@agent-room.local" };

export interface WorkspaceOptions {
  dataDir: string; /** git binary; default $AGENT_ROOM_GIT or "git" */ git?: string;
  /** 1.1: the hub's audit log, for security-relevant events (a git config put back, a hard link left out). */
  onSecurity?: (action: string, detail: string) => void;
}
/**
 * 1.1: a goal that works on a folder the owner granted. `path` is the real, granted folder.
 * `write` false (or `revoked`) means nothing is ever written to it: tasks work in a private copy.
 */
export interface GoalSource { grantId: string; path: string; write: boolean; label?: string; /** git folders: where accepted work lands, agent-room/<goal-id> */ branch: string; revoked?: boolean; /** 4.4: a branch of the owner's repo to start `branch` from when it does not exist yet (a fork starts from the forked goal's work) */ from?: string }
export interface GoalRef { id: string; folder: string; /** 1.1 */ source?: GoalSource }
/** 1.1: what `_source.json` holds for a goal on a granted folder. */
export interface SourceMeta {
  mode: "granted-git" | "shadow"; /** the owner's real folder */ path: string; branch?: string;
  /** granted-git: the hub's own clone of the owner's repo (the agents never see the owner's .git), and its worktree on `branch` */
  clone?: string; integration?: string; shadow?: string;
  /** granted-git: the last push of `branch` to the owner's repo failed, so the clone holds work the owner does not have yet */
  unpushed?: boolean;
}
/** What the base of a goal is: the hub's own folder (plain), the owner's repo through a branch (granted-git), or a private copy of the owner's folder (shadow). */
export type BaseMode = "plain" | "granted-git" | "shadow";
export interface TaskWorkspace {
  goalId: string; taskId: string; agentId: string;
  kind: "git" | "copy";
  /** 1.1: how this task's base relates to the owner's granted folder. Absent = plain (the hub's own goal folder). */
  mode?: BaseMode;
  /** 1.1 granted-git: the hub's worktree on branch agent-room/<goal>, where accepted work is merged. The owner's checkout is never touched. */
  integration?: string;
  /** 1.1 git kind: what git wrote in the work folder's `.git` file, put back before the hub runs git there (an agent can overwrite it). */
  gitdir?: string;
  /** The task's own directory: the agent's cwd. */
  path: string;
  /** The goal folder this was cut from. */
  base: string;
  branch?: string;
  /** copy kind: base snapshot (path -> hash) the copy was cut from. */
  snap?: Record<string, string>;
  /** Files left with conflict markers by the last failed accept. */
  conflicted?: string[];
  /** 3.3: set on a subagent's workspace: it was cut from this task's worktree, and accepted work merges back into it (never into the goal base). */
  parentTaskId?: string;
}
export interface WritebackChange { relPath: string; /** null = deleted */ content: Buffer | null }
/** 1.1: what an accepted task did to a granted folder, for the caller to act on. */
export interface SourceOutcome {
  mode: "granted-git" | "shadow";
  /** granted-git: the branch the work was merged into, and whether it reached the owner's repo (false: it waits in the hub's clone; `pushError` says why). */
  branch?: string; pushed?: boolean; pushError?: string;
  /** The grant no longer allows writing: nothing was merged or collected. */
  withheld?: boolean;
  /** shadow with a writable grant: the files this task changed, read under the goal's lock, to be proposed to the owner as one diff. */
  changes?: WritebackChange[];
  skipped?: { relPath: string; reason: string }[];
}
export type AcceptResult =
  | { ok: true; merged: string[]; how: "empty" | "fast-forward" | "merge" | "copy"; source?: SourceOutcome; /** 1.1: files left out because they are hard links */ hardLinks?: string[] }
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
const isDir = (p: string) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
const firstLine = (s: string) => s.trim().split("\n")[0].slice(0, 300);
const EXCLUDES = ["LEDGER.md", ".agent-room*", "node_modules", ".DS_Store"];
const hasMarkers = (text: string) => /^<{7}(?: .*)?$/m.test(text) && /^>{7}(?: .*)?$/m.test(text);

const COPY_SKIP = new Set([".git", "node_modules", ".DS_Store", "LEDGER.md"]);
const COPY_MAX_FILES = 20_000, COPY_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * 1.1: copy a granted folder into the hub's private area. Only plain files and folders are copied: a symlink is never followed or
 * recreated (a link inside the folder could point at ~/.ssh, and the copy is handed to an agent), and version-control internals,
 * dependencies and the ledger are left out. Refuses a folder too large to copy rather than copying half of it.
 */
export function copyGrantedTree(src: string, dst: string): { files: number; skippedLinks: number; skippedHardLinks: number; skipped: { relPath: string; reason: string }[] } {
  let files = 0, bytes = 0, skippedLinks = 0, skippedHardLinks = 0;
  const skipped: { relPath: string; reason: string }[] = [];
  mkdirSync(dst, { recursive: true });
  const walk = (from: string, to: string) => {
    for (const name of readdirSync(from)) {
      if (COPY_SKIP.has(name) || name.startsWith(".agent-room")) continue;
      const a = join(from, name), b = join(to, name);
      const st = lstatSync(a);
      if (st.isSymbolicLink()) { skippedLinks++; skipped.push({ relPath: relative(src, a), reason: "symlink" }); continue; }
      if (st.isDirectory()) { mkdirSync(b, { recursive: true }); walk(a, b); }
      else if (st.isFile()) {
        // A second name for a file that may live anywhere (a hard link to ~/.ssh/id_rsa looks like any file): never copied.
        if (st.nlink > 1) { skippedHardLinks++; skipped.push({ relPath: relative(src, a), reason: "hard link" }); continue; }
        if (++files > COPY_MAX_FILES || (bytes += st.size) > COPY_MAX_BYTES) throw new Error("The granted folder is too large to work on as a copy (over 20,000 files or 1 GB). Grant a smaller folder.");
        copyFileSync(a, b);
      }
    }
  };
  try { walk(src, dst); } catch (e) { rmSync(dst, { recursive: true, force: true }); throw e; }
  return { files, skippedLinks, skippedHardLinks, skipped };
}

/** 1.1: regular files under `root` that have more than one name (hard links). `.git` and `node_modules` are not looked into. */
export function hardLinkedFiles(root: string, limit = 5000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (out.length >= limit) return;
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name);
      let st; try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.nlink > 1) out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

export class TaskWorkspaces {
  private chains = new Map<string, Promise<unknown>>();
  private copyOnly = new Set<string>();
  private gitBin: string;
  /** 1.1: the common .git/config of every repository the hub owns, put back before each git call (see files/gitSafe.ts). */
  readonly guard: GitConfigGuard;
  /** 1.1: for a folder the hub runs git in: the repository whose config is guarded, and the exact git dirs (so a rewritten `.git` pointer or `commondir` is never believed). */
  private bound = new Map<string, { repo?: string; env?: Record<string, string>; fix?: () => void }>();
  constructor(private o: WorkspaceOptions) {
    this.gitBin = o.git ?? process.env.AGENT_ROOM_GIT ?? "git";
    this.guard = new GitConfigGuard(join(o.dataDir, "gitguard"), (repo, why) => o.onSecurity?.("git.config.restored", `${repo}: ${why}`));
  }

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
  save(m: TaskWorkspace) { mkdirSync(this.root(m.goalId), { recursive: true }); writeFileSync(this.metaFile(m.goalId, m.taskId), JSON.stringify(m)); }
  private listMeta(goalId: string): TaskWorkspace[] {
    let names: string[] = [];
    try { names = readdirSync(this.root(goalId)); } catch { return []; }
    return names.filter((n) => n.endsWith(".json") && !n.startsWith("_")).flatMap((n) => {
      try { return [JSON.parse(readFileSync(join(this.root(goalId), n), "utf8")) as TaskWorkspace]; } catch { return []; }
    });
  }

  // ---------- git
  /**
   * 1.1: every hub git call is hardened (files/gitSafe.ts): command-line overrides for each option that can run a command, a
   * clean environment, and, for a repository the hub owns, its config put back first. `owner: true` is for the OWNER's repository
   * (reading its head, fetching from it, pushing to it): its config is the owner's and is never rewritten.
   */
  git(cwd: string, args: string[], stdin?: string, owner = false, extraEnv?: Record<string, string> /* 3.3: GIT_INDEX_FILE for a snapshot that leaves the real index alone */) {
    const b = this.bound.get(cwd);
    if (!owner) {
      const repo = b?.repo ?? (isDir(join(cwd, ".git")) ? cwd : undefined);
      if (repo) this.guard.restore(repo);
      b?.fix?.();
    }
    return runProc(this.gitBin, [
      ...hardenedGitArgs(),
      "-c", `user.name=${HUB_IDENTITY.name}`, "-c", `user.email=${HUB_IDENTITY.email}`,
      "-c", "core.autocrlf=false", "-c", "core.quotepath=off",
      "-c", "init.defaultBranch=main", "-c", "merge.ff=true",
      ...args,
    ], {
      cwd, stdin, timeoutMs: 120_000,
      env: {
        ...hardenedGitEnv(), ...(b?.env ?? {}), ...(extraEnv ?? {}),
        GIT_AUTHOR_NAME: HUB_IDENTITY.name, GIT_AUTHOR_EMAIL: HUB_IDENTITY.email,
        GIT_COMMITTER_NAME: HUB_IDENTITY.name, GIT_COMMITTER_EMAIL: HUB_IDENTITY.email,
      },
    });
  }
  /** Tell the guard (and git) which repository a folder belongs to. For a task worktree git is pointed at its git dirs directly, so a rewritten `.git` file or `commondir` cannot redirect the hub to another repository. */
  private bind(folder: string, repo: string, gitdirPointer?: string) {
    const admin = /^gitdir:\s*(.+?)\s*$/m.exec(gitdirPointer ?? "")?.[1];
    // The admin folder of a worktree (<repo>/.git/worktrees/<name>) is writable by the agent too. Its `commondir` file says where the shared
    // repository is (objects, refs, config), and git reads it even when GIT_COMMON_DIR is set for some paths, so it is put back as git wrote it.
    const fix = admin ? () => {
      try { const f = join(admin, "commondir"); if (readFileSync(f, "utf8") !== "../..\n") writeFileSync(f, "../..\n"); } catch { try { writeFileSync(join(admin, "commondir"), "../..\n"); } catch { /* admin folder gone */ } }
      try { rmSync(join(admin, "config.worktree"), { force: true }); } catch { /* none */ }
    } : undefined;
    this.bound.set(folder, { repo, fix, ...(admin ? { env: { GIT_DIR: admin, GIT_COMMON_DIR: join(repo, ".git"), GIT_WORK_TREE: folder } } : {}) });
  }
  private security(action: string, detail: string) { this.o.onSecurity?.(action, detail); }
  private async gitOk(cwd: string, args: string[], owner = false) { const r = await this.git(cwd, args, undefined, owner); return r.code === 0; }
  private async out(cwd: string, args: string[], owner = false) { const r = await this.git(cwd, args, undefined, owner); return r.code === 0 ? r.stdout.trim() : ""; }
  private names(stdout: string) { return stdout.split("\0").filter(Boolean).sort(); }

  /** Run one goal's workspace operations one at a time. */
  locked<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
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
      const init = await this.git(goal.folder, ["init", "-q", "--template="]);
      if (init.code !== 0) { this.copyOnly.add(goal.id); return "copy"; }
      this.guard.snapshot(goal.folder); // 1.1: the config as the hub made it
    }
    this.bind(goal.folder, goal.folder);
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
  open(goalIn: GoalRef, task: { id: string }, agentId: string): Promise<TaskWorkspace & { reused: boolean }> {
    return this.locked(goalIn.id, async () => {
      // 1.1: a goal on a granted folder gets its base from the grant (the owner's repo through a branch, or a private copy). Otherwise the base is the hub's goal folder, as before.
      const src = await this.ensureSource(goalIn);
      const goal: GoalRef = src?.mode === "shadow" ? { id: goalIn.id, folder: src.shadow! } : { id: goalIn.id, folder: goalIn.folder };
      const mode: BaseMode = src?.mode ?? "plain";
      const have = this.find(goal.id, task.id);
      if (have && have.agentId === agentId) { this.bindTask(have); return { ...have, reused: true }; }
      await this.discardNow(goal, task.id);
      mkdirSync(this.root(goal.id), { recursive: true });
      const path = this.pathFor(goal.id, task.id);
      if (src?.mode === "granted-git") {
        // The task's branch comes from the head of agent-room/<goal> (all accepted work so far), in the hub's OWN clone of the owner's repo:
        // the agent's worktree shares that clone's .git, never the owner's. The owner's checked-out branch and files are never touched.
        const clone = src.clone!;
        const head = await this.out(src.integration!, ["rev-parse", "HEAD"]);
        await this.git(clone, ["worktree", "prune"]); // forget a work folder of the same task that a crash left registered
        const add = head ? await this.git(clone, ["worktree", "add", "-q", "-B", BRANCH(task.id), path, head]) : undefined;
        if (add?.code !== 0) { rmSync(path, { recursive: true, force: true }); await this.git(clone, ["worktree", "prune"]); throw new Error("Could not cut a work folder from the hub's copy of the granted folder's repository."); }
        this.guard.snapshot(clone); // anything git itself wrote into the config while adding the worktree is the hub's own
        const m: TaskWorkspace = { goalId: goal.id, taskId: task.id, agentId, kind: "git", path, base: clone, branch: BRANCH(task.id), mode, integration: src.integration, gitdir: this.pointerOf(path) };
        this.save(m); this.bindTask(m); return { ...m, reused: false };
      }
      if ((await this.base(goal)) === "git") {
        const head = await this.out(goal.folder, ["rev-parse", "HEAD"]);
        const add = head ? await this.git(goal.folder, ["worktree", "add", "-q", "-B", BRANCH(task.id), path, head]) : undefined;
        if (add?.code === 0) {
          this.guard.snapshot(goal.folder);
          const m: TaskWorkspace = { goalId: goal.id, taskId: task.id, agentId, kind: "git", path, base: goal.folder, branch: BRANCH(task.id), gitdir: this.pointerOf(path), ...(mode !== "plain" ? { mode } : {}) };
          this.save(m); this.bindTask(m); return { ...m, reused: false };
        }
        rmSync(path, { recursive: true, force: true });
        await this.git(goal.folder, ["worktree", "prune"]);
      }
      // No git: a plain folder copy that remembers what it was cut from.
      const snap = snapshot(goal.folder);
      mkdirSync(path, { recursive: true });
      for (const rel of snap.keys()) { const to = join(path, rel); mkdirSync(dirname(to), { recursive: true }); cpSync(join(goal.folder, rel), to); }
      const m: TaskWorkspace = { goalId: goal.id, taskId: task.id, agentId, kind: "copy", path, base: goal.folder, snap: Object.fromEntries(snap), ...(mode !== "plain" ? { mode } : {}) };
      this.save(m); return { ...m, reused: false };
    });
  }

  // ---------- 1.1 granted folders
  /** What the base of a goal on a granted folder is, written once when its first task opens. */
  private sourceFile(goalId: string) { return join(this.root(goalId), "_source.json"); }
  sourceOf(goalId: string): SourceMeta | undefined {
    try { return JSON.parse(readFileSync(this.sourceFile(goalId), "utf8")); } catch { return undefined; }
  }
  private saveSource(goalId: string, meta: SourceMeta) { mkdirSync(this.root(goalId), { recursive: true }); writeFileSync(this.sourceFile(goalId), JSON.stringify(meta)); }
  /** The folder holding a goal's accepted state, when it is not the goal folder: the integration worktree or the private copy. For checks and the final review. */
  stateFolder(goalId: string): string | undefined {
    const s = this.sourceOf(goalId);
    const p = s?.mode === "granted-git" ? s.integration : s?.shadow;
    return p && existsSync(p) ? p : undefined;
  }

  /** True when `dir` is the top level of a git repository with at least one commit. */
  private async isRepoRoot(dir: string): Promise<boolean> {
    const top = await this.out(dir, ["rev-parse", "--show-toplevel"], true); // the OWNER's repository: asked, never guarded or rewritten
    if (!top) return false;
    try { if (realpathSync(top) !== realpathSync(dir)) return false; } catch { return false; }
    return !!(await this.out(dir, ["rev-parse", "--verify", "-q", "HEAD"], true));
  }

  /** Bind a task's work folder to the repository it belongs to, from what git wrote when the hub made it (not from what is in the folder now). */
  bindTask(m: TaskWorkspace) { if (m.kind === "git") this.bind(m.path, m.base, m.gitdir); }

  /**
   * 1.1 granted-git: the hub's own clone of the owner's repo, at <goal>/_repo. Only the history of the owner's checked-out head is fetched
   * (or of agent-room/<goal> when the owner's repo already has it), over the file protocol, with no templates, tags, submodules, remote or
   * hooks. The clone has no remote, so nothing in it (or in what an agent can read of it) names the owner's repository.
   */
  private async makeClone(goalId: string, s: GoalSource): Promise<{ clone: string; integration: string } | undefined> {
    const clone = join(this.root(goalId), "_repo"), integration = join(this.root(goalId), "_integration");
    rmSync(clone, { recursive: true, force: true }); rmSync(integration, { recursive: true, force: true });
    mkdirSync(clone, { recursive: true });
    const fail = () => { rmSync(clone, { recursive: true, force: true }); rmSync(integration, { recursive: true, force: true }); return undefined; };
    if ((await this.git(clone, ["init", "-q", "--template="])).code !== 0) return fail();
    this.bind(clone, clone);
    const has = await this.gitOk(s.path, ["rev-parse", "--verify", "-q", `refs/heads/${s.branch}`], true);
    const hasFrom = !has && !!s.from && await this.gitOk(s.path, ["rev-parse", "--verify", "-q", `refs/heads/${s.from}`], true); // 4.4
    const from = has ? `refs/heads/${s.branch}` : hasFrom ? `refs/heads/${s.from}` : "HEAD";
    const got = await this.git(clone, ["-c", "core.logAllRefUpdates=false", "fetch", "-q", "--no-tags", "--no-recurse-submodules", s.path, `${from}:refs/heads/${s.branch}`]);
    if (got.code !== 0) return fail();
    // fetch records where it fetched from (FETCH_HEAD, reflog): an agent that can read the clone must not learn where the owner's repository is.
    rmSync(join(clone, ".git", "FETCH_HEAD"), { force: true }); rmSync(join(clone, ".git", "logs"), { recursive: true, force: true });
    if ((await this.git(clone, ["worktree", "add", "-q", integration, s.branch])).code !== 0) return fail();
    this.bind(integration, clone);
    this.guard.snapshot(clone);
    return { clone, integration };
  }

  private async ensureSource(goal: GoalRef) {
    const have = this.sourceOf(goal.id);
    const s = goal.source;
    if (have) {
      // The hub's clone or worktree on the branch may be gone (hub restart prunes idle ones): put it back, on the same branch, never reset.
      if (have.mode === "granted-git" && have.clone) {
        if (!existsSync(join(have.clone, ".git")) && s && !s.revoked) {
          const again = await this.makeClone(goal.id, s);
          if (!again) throw new Error("Could not reopen the hub's copy of the granted folder's repository.");
          this.saveSource(goal.id, { ...have, clone: again.clone, integration: again.integration });
          return this.sourceOf(goal.id)!;
        }
        this.bind(have.clone, have.clone);
        if (have.integration && !existsSync(have.integration)) {
          await this.git(have.clone, ["worktree", "prune"]);
          const r = await this.git(have.clone, ["worktree", "add", "-q", have.integration, have.branch!]);
          if (r.code !== 0) throw new Error("Could not reopen the branch for this goal in the hub's copy of the granted folder's repository.");
          this.guard.snapshot(have.clone);
        }
        if (have.integration) this.bind(have.integration, have.clone);
      }
      if (have.mode === "shadow" && have.shadow && !existsSync(have.shadow)) this.noteSkipped(goal.id, copyGrantedTree(have.path, have.shadow));
      return have;
    }
    if (!s || s.revoked) return undefined;
    mkdirSync(this.root(goal.id), { recursive: true });
    let meta: SourceMeta | undefined;
    // Writable git folder: the hub clones it, accepted work goes to a branch in the clone, and the branch is pushed to the owner's repo for the owner to merge.
    if (s.write && await this.isRepoRoot(s.path)) {
      const made = await this.makeClone(goal.id, s);
      if (made) meta = { mode: "granted-git", path: s.path, branch: s.branch, clone: made.clone, integration: made.integration };
    }
    // Anything else (not a repo, read-only grant, git unusable): a private copy. Accepted work stays in the copy; it reaches the owner's folder only as a reviewed diff.
    if (!meta) {
      const shadow = join(this.root(goal.id), "_shadow");
      this.noteSkipped(goal.id, copyGrantedTree(s.path, shadow));
      meta = { mode: "shadow", path: s.path, shadow };
    }
    this.saveSource(goal.id, meta);
    return meta;
  }

  private noteSkipped(goalId: string, r: ReturnType<typeof copyGrantedTree>) {
    if (r.skipped.length) this.security("goal.source.skipped", `${goalId}: ${r.skippedLinks} symlink(s) and ${r.skippedHardLinks} hard link(s) were not copied: ${r.skipped.slice(0, 8).map((x) => `${x.relPath} (${x.reason})`).join(", ")}`.slice(0, 600));
  }

  /** Push the goal's branch from the hub's clone to the owner's repository. Never forced: a branch the owner moved or has checked out is reported, and the work stays in the clone. */
  private async pushToOwner(goalId: string): Promise<{ pushed: true } | { pushed: false; error: string }> {
    const s = this.sourceOf(goalId);
    if (!s || s.mode !== "granted-git" || !s.clone) return { pushed: false, error: "no clone" };
    // git does not hand `-c` overrides to the receiving side of a local push, so the owner's server-side hooks (pre-receive, update,
    // post-receive) would run as unattended code from a hub-initiated push. The receiving git is started with hooks off, explicitly.
    const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
    const r = await this.git(s.clone, ["push", "-q", `--receive-pack=${q(this.gitBin)} -c core.hooksPath=/dev/null receive-pack`, s.path, `refs/heads/${s.branch}:refs/heads/${s.branch}`]);
    const ok = r.code === 0;
    if (!!s.unpushed !== !ok) this.saveSource(goalId, { ...s, unpushed: !ok });
    return ok ? { pushed: true } : { pushed: false, error: firstLine(r.stderr.replace(/^(remote: |error: |hint: )/gm, "")) || "git push failed" };
  }

  /**
   * Drop the hub's clone (granted-git) or private copy (shadow). A clone whose last push failed is not thrown away: it is moved to
   * <data>/unpushed/<goal> so the accepted work is not lost, and the owner is told through the audit log.
   */
  private async removeSource(goalId: string, tryPush = false) {
    const s = this.sourceOf(goalId);
    if (!s) return;
    if (s.mode === "granted-git" && s.clone) {
      if (tryPush) await this.pushToOwner(goalId);
      const left = this.sourceOf(goalId)?.unpushed;
      if (s.integration) await this.git(s.clone, ["worktree", "remove", "--force", "--force", s.integration]);
      await this.git(s.clone, ["worktree", "prune"]);
      if (s.integration) rmSync(s.integration, { recursive: true, force: true });
      if (left) {
        const keep = join(this.o.dataDir, "unpushed", goalId);
        try { rmSync(keep, { recursive: true, force: true }); mkdirSync(dirname(keep), { recursive: true }); renameSync(s.clone, keep); this.security("goal.source.unpushed", `${goalId}: the branch ${s.branch} could not be added to the owner's repository; the work is kept in the hub's data folder (unpushed/${goalId})`); } catch { rmSync(s.clone, { recursive: true, force: true }); }
      } else rmSync(s.clone, { recursive: true, force: true });
      this.guard.forget(s.clone); this.bound.delete(s.clone); if (s.integration) this.bound.delete(s.integration);
    } else if (s.shadow) rmSync(s.shadow, { recursive: true, force: true });
    rmSync(this.sourceFile(goalId), { force: true });
  }

  /**
   * Read what a task changed in the private copy, for writing back to the owner's folder. Runs under the goal's lock, so a later task
   * cannot change the copy between the merge and this read. Symlinks and anything that is not a plain file are skipped, with the reason.
   */
  private collectChanges(shadow: string, files: string[], maxBytes: number): { changes: WritebackChange[]; skipped: { relPath: string; reason: string }[] } {
    const changes: WritebackChange[] = [], skipped: { relPath: string; reason: string }[] = [];
    for (const rel of files) {
      const full = join(shadow, rel);
      try {
        if (relative(shadow, full).startsWith("..")) continue;
        let st; try { st = lstatSync(full); } catch { changes.push({ relPath: rel, content: null }); continue; }
        if (st.isSymbolicLink()) { skipped.push({ relPath: rel, reason: "symlink; not written back" }); continue; }
        if (!st.isFile()) continue;
        if (st.nlink > 1) { skipped.push({ relPath: rel, reason: "hard link; not written back" }); continue; }
        if (st.size > maxBytes) { skipped.push({ relPath: rel, reason: `larger than ${maxBytes} bytes` }); continue; }
        changes.push({ relPath: rel, content: readFileSync(full) });
      } catch { skipped.push({ relPath: rel, reason: "could not be read" }); }
    }
    return { changes, skipped };
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
      // 1.1: the grant may have lost its write access since the goal started. Then nothing is merged into the owner's repository or collected for them.
      if (m.mode === "granted-git" && (!goal.source?.write || goal.source.revoked)) return { ok: true, merged: [], how: "empty", source: { mode: "granted-git", withheld: true } };
      this.bindTask(m);
      const r = m.kind === "git" ? await this.acceptGit(m, task) : await this.acceptCopy(m);
      if (!r.ok || !m.mode || m.mode === "plain") return r;
      if (m.mode === "granted-git") {
        // The accepted work is on agent-room/<goal> in the hub's clone; now it goes to the owner's repository (never forced).
        const push = await this.pushToOwner(goal.id);
        const skipped = (r.hardLinks ?? []).map((relPath) => ({ relPath, reason: "hard link; not committed" }));
        return { ...r, source: { mode: "granted-git", branch: this.sourceOf(goal.id)?.branch, pushed: push.pushed, ...(push.pushed ? {} : { pushError: push.error }), ...(skipped.length ? { skipped } : {}) } };
      }
      // shadow: the work is merged into the private copy. When the grant is writable, read what this task changed so it can go to the owner as one diff.
      if (!goal.source?.write || goal.source.revoked) return { ...r, source: { mode: "shadow", withheld: true } };
      return { ...r, source: { mode: "shadow", ...this.collectChanges(m.base, r.merged, 2 * 1024 * 1024) } };
    });
  }

  private pointerOf(path: string): string | undefined { try { return readFileSync(join(path, ".git"), "utf8"); } catch { return undefined; } }

  /**
   * 1.1: the `.git` file in a work folder tells git where the repository is. An agent can overwrite it (or run `git init` there) so that
   * the hub's own git commands, which run outside the agent's sandbox, read a config the agent wrote (core.fsmonitor and friends run commands).
   * Before the hub runs git in a work folder the pointer is put back exactly as git wrote it.
   */
  restorePointer(m: TaskWorkspace) {
    if (m.kind !== "git" || !m.gitdir) return;
    const p = join(m.path, ".git");
    try { const st = lstatSync(p); if (st.isFile() && readFileSync(p, "utf8") === m.gitdir) return; rmSync(p, { recursive: true, force: true }); } catch { /* missing: written below */ }
    writeFileSync(p, m.gitdir);
  }

  private async acceptGit(m: TaskWorkspace, task: { id: string; title?: string }): Promise<AcceptResult> {
    // 1.1: for a granted repo the merge happens in the hub's own worktree on agent-room/<goal>, never in the owner's checkout.
    this.restorePointer(m);
    const wt = m.path, base = m.integration ?? m.base, branch = m.branch!;
    // 1.1: a second name for a file the agent could not read (a hard link to ~/.ssh/id_rsa) would be committed with its content. Left out, and reported.
    const links = hardLinkedFiles(wt);
    const leave = links.map((l) => `:(exclude,literal)${l}`);
    if (links.length) this.security("worktree.hardlink", `${m.taskId}: ${links.length} hard-linked file(s) not committed: ${links.slice(0, 8).join(", ")}`.slice(0, 600));
    // 1. commit the agent's work on its branch (author = the agent)
    // 1.1: the owner's repo has no local exclude file of ours, so the files the hub itself writes into a work folder are left out here.
    await this.git(wt, m.integration ? ["add", "-A", "--", ".", ":(exclude).agent-room*", ":(exclude)LEDGER.md", ":(exclude)node_modules", ":(exclude).DS_Store", ...leave] : links.length ? ["add", "-A", "--", ".", ...leave] : ["add", "-A"]);
    const merging = await this.gitOk(wt, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    const dirty = !(await this.gitOk(wt, ["diff", "--cached", "--quiet"]));
    if (dirty || merging) {
      const c = await this.git(wt, ["commit", "--no-verify", "--allow-empty", "-m", task.title ? `Task: ${task.title}` : `Task ${task.id}`, "--author", `${m.agentId} <${m.agentId}@agent-room.local>`]);
      if (c.code !== 0) return { ok: false, conflict: [] };
    }
    // 2. merge into the base
    if (m.integration) { await this.git(base, ["reset", "--hard", "-q", "HEAD"]); await this.git(base, ["clean", "-fdq"]); } // the hub's own worktree: a check may have left files in it
    else await this.syncBase(base);
    const before = await this.out(base, ["rev-parse", "HEAD"]);
    if (await this.gitOk(base, ["merge-base", "--is-ancestor", branch, "HEAD"])) return { ok: true, merged: [], how: "empty", ...(links.length ? { hardLinks: links } : {}) };
    const fastForward = await this.gitOk(base, ["merge-base", "--is-ancestor", "HEAD", branch]);
    const r = await this.git(base, ["merge", "--no-edit", "-m", task.title ? `Merge task: ${task.title}` : `Merge task ${task.id}`, branch]);
    if (r.code === 0) {
      const files = this.names((await this.git(base, ["diff", "--name-only", "-z", before, "HEAD"])).stdout);
      return { ok: true, merged: files, how: fastForward ? "fast-forward" : "merge", ...(links.length ? { hardLinks: links } : {}) };
    }
    // 3. conflict: leave the base exactly as it was, bring the latest base into the task's worktree for the agent to resolve
    let conflict = this.names((await this.git(base, ["diff", "--name-only", "-z", "--diff-filter=U"])).stdout);
    if (!conflict.length) conflict = this.names((await this.git(base, ["diff", "--name-only", "-z", `${before}...${branch}`])).stdout);
    await this.git(base, ["merge", "--abort"]);
    await this.git(wt, ["merge", "--no-edit", "-m", "Bring in accepted work from other tasks", before]);
    m.conflicted = conflict; this.save(m);
    return { ok: false, conflict };
  }

  async acceptCopy(m: TaskWorkspace): Promise<AcceptResult> {
    const was = new Map(Object.entries(m.snap ?? {}));
    const mine = snapshot(m.path), theirs = snapshot(m.base);
    // 1.1: hard-linked files are never copied into the base (see acceptGit).
    const links = new Set(hardLinkedFiles(m.path));
    if (links.size) this.security("worktree.hardlink", `${m.taskId}: ${links.size} hard-linked file(s) not copied: ${[...links].slice(0, 8).join(", ")}`.slice(0, 600));
    const changed = changedFiles(was, mine).filter((p) => !links.has(p));
    const clash = changed.filter((p) => theirs.get(p) !== was.get(p) && theirs.get(p) !== mine.get(p));
    if (!clash.length) {
      const merged: string[] = [];
      for (const p of changed) {
        const to = join(m.base, p);
        if (mine.has(p)) { mkdirSync(dirname(to), { recursive: true }); cpSync(join(m.path, p), to); merged.push(p); }
        else if (existsSync(to)) { unlinkSync(to); merged.push(p); }
      }
      return { ok: true, merged, how: "copy", ...(links.size ? { hardLinks: [...links] } : {}) };
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
    const base = m?.base ?? this.baseOf(goal); // 1.1: with no metadata left, the branch to delete is still in the owner's repo (granted-git) or the private copy
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
      try { for (const n of readdirSync(this.root(goal.id))) if (!n.endsWith(".json") && !n.startsWith("_")) ids.add(n); } catch { /* none */ }
      for (const t of ids) await this.discardNow(goal, t);
      if (existsSync(join(goal.folder, ".git"))) await this.git(goal.folder, ["worktree", "prune"]);
      await this.removeSource(goal.id, !!goal.source?.write && !goal.source.revoked); // 1.1: the hub's clone goes (after a last push of agent-room/<goal> to the owner's repo, which stays: it is the owner's result)
      try { rmSync(this.root(goal.id), { recursive: true, force: true }); } catch { /* best effort */ }
    });
  }

  /** 1.1: where git commands for a goal's tasks run when no task metadata is left. */
  private baseOf(goal: GoalRef): string {
    const s = this.sourceOf(goal.id);
    return s?.mode === "granted-git" && s.clone ? s.clone : s?.mode === "shadow" && s.shadow ? s.shadow : goal.folder;
  }

  /** Hub start: remove worktrees whose task is no longer open (or unknown). Returns the task ids removed. */
  async prune(keep: (goalId: string, taskId: string) => boolean, goalAlive: (goalId: string) => boolean = () => false): Promise<string[]> {
    const removed: string[] = [];
    let goals: string[] = [];
    try { goals = readdirSync(this.root()); } catch { return removed; }
    for (const goalId of goals) {
      const metas = this.listMeta(goalId);
      const so = this.sourceOf(goalId);
      const base = metas[0]?.base ?? (so?.mode === "granted-git" ? so.clone : undefined); // 1.1: never the owner's own folder
      for (const m of metas) {
        if (keep(goalId, m.taskId) && existsSync(m.path)) continue;
        await this.locked(goalId, () => this.discardNow({ id: goalId, folder: m.base }, m.taskId));
        removed.push(m.taskId);
      }
      // directories with no metadata are leftovers
      try {
        for (const n of readdirSync(this.root(goalId))) {
          if (n.endsWith(".json") || n.startsWith("_") || this.listMeta(goalId).some((m) => m.taskId === n)) continue; // "_" = 1.1 base of a goal on a granted folder, handled below
          rmSync(join(this.root(goalId), n), { recursive: true, force: true }); removed.push(n);
        }
      } catch { /* none */ }
      // 1.1: a goal that is still going keeps its integration worktree or private copy (accepted work lives there); a finished or gone goal does not.
      if (!goalAlive(goalId)) await this.locked(goalId, () => this.removeSource(goalId));
      if (base && existsSync(join(base, ".git"))) await this.git(base, ["worktree", "prune"]);
      if (!this.listMeta(goalId).length && !this.sourceOf(goalId)) try { rmSync(this.root(goalId), { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return removed;
  }
}
