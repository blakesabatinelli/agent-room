import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlCommit } from "@agent-room/shared";
import { hardenedGitArgs, hardenedGitEnv } from "../files/gitSafe.js";

/** execFile wants no undefined values. */
const cleanEnv = (e: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));

/** Who made a change. Agents appear by id. */
export type Writer = "owner" | "orchestrator" | "hub" | (string & {});

export class GitError extends Error {
  constructor(message: string, public code?: number | string) { super(message); }
}

const HEX = /^[0-9a-f]{7,40}$/i;

/**
 * The control folder's history: one commit per change, authored by whoever made it.
 * Runs `git` with an argument list (never a shell). The binary is injectable (AGENT_ROOM_GIT or the option).
 */
export class ControlGit {
  private available: boolean | undefined;
  constructor(readonly root: string, private bin = process.env.AGENT_ROOM_GIT || "git") {}

  private run(args: string[], writer?: Writer, timeoutMs = 30_000): Promise<string> {
    const id = writer ? ["-c", `user.name=${writer}`, "-c", `user.email=${writer}@agent-room.local`] : [];
    return new Promise((resolve, reject) => {
      // 1.1: the same hardening as every hub git call (no config option can make this run a command). The owner's own git config is still read.
      execFile(this.bin, [...hardenedGitArgs(), ...id, "-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args],
        { cwd: this.root, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: cleanEnv({ ...process.env, ...hardenedGitEnv(), GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }) },
        (err, stdout, stderr) => {
          if (err) return reject(new GitError((stderr || err.message).trim().split("\n")[0] || "git failed", (err as { code?: number | string }).code));
          resolve(stdout);
        });
    });
  }

  /** True when the git binary runs. Without it the folder still works; there is just no history. */
  async isAvailable(): Promise<boolean> {
    if (this.available === undefined) {
      try { await this.run(["--version"]); this.available = true; } catch { this.available = false; }
    }
    return this.available;
  }

  isRepo() { return existsSync(join(this.root, ".git")); }

  /** Keep Library/ out of the repository (documents can be large and have their own index). Works without git. */
  ensureIgnore() {
    mkdirSync(this.root, { recursive: true });
    const ignore = join(this.root, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "Library/\n.DS_Store\n");
    else if (!/^\/?Library\/?\s*$/m.test(readFileSync(ignore, "utf8"))) writeFileSync(ignore, `${readFileSync(ignore, "utf8").replace(/\n?$/, "\n")}Library/\n`);
  }

  /** Create the repository if needed. Returns true when it created one. */
  async init(): Promise<boolean> {
    this.ensureIgnore();
    if (this.isRepo()) return false;
    await this.run(["-c", "init.defaultBranch=main", "init", "-q"]);
    return true;
  }

  /** Paths with uncommitted changes (new, edited or deleted). */
  async pending(): Promise<string[]> {
    const out = await this.run(["status", "--porcelain=v1", "-z", "-uall"]);
    const paths: string[] = [];
    const parts = out.split("\0").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i].slice(0, 2); paths.push(parts[i].slice(3));
      if (code[0] === "R" || code[0] === "C") i++; // rename: the next entry is the old path
    }
    return paths;
  }

  /** Commit exactly these paths as one change. Returns the commit id, or null when nothing differed. */
  async commit(paths: string[], message: string, writer: Writer): Promise<string | null> {
    if (!paths.length) return null;
    await this.run(["add", "-A", "--", ...paths]);
    const staged = (await this.run(["diff", "--cached", "--name-only", "-z", "--", ...paths])).split("\0").filter(Boolean);
    if (!staged.length) return null;
    await this.run(["commit", "-q", "--no-verify", "-m", message, "--only", "--", ...staged], writer);
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  /** Newest first. With a path, only the changes that touched it. */
  async history(path?: string, limit = 100): Promise<ControlCommit[]> {
    if (!this.isRepo()) return [];
    const args = ["log", `--max-count=${Math.max(1, Math.min(500, limit))}`, "--format=%H%x1f%an%x1f%aI%x1f%s"];
    if (path) args.push("--", path);
    let out = "";
    try { out = await this.run(args); } catch { return []; } // no commits yet
    return out.split("\n").filter(Boolean).map((l) => {
      const [commit, author, at, message] = l.split("\x1f");
      return { commit, author, at, message };
    });
  }

  /** Paths a commit touched. */
  async files(commit: string): Promise<string[]> {
    this.checkHex(commit);
    return (await this.run(["show", "--name-only", "--format=", "-z", commit])).split("\0").filter(Boolean);
  }

  /** Undo one commit with a new commit. Throws when later changes get in the way. */
  async revert(commit: string, writer: Writer = "owner"): Promise<{ commit: string; files: string[] }> {
    this.checkHex(commit);
    const full = (await this.run(["rev-parse", "--verify", `${commit}^{commit}`])).trim();
    const parents = (await this.run(["rev-list", "--parents", "-n", "1", full])).trim().split(" ").length - 1;
    if (parents === 0) throw new GitError("This is the first change. There is nothing before it to go back to.");
    if (parents > 1) throw new GitError("This change merged two histories and can't be undone from here.");
    const files = await this.files(full);
    try {
      await this.run(["revert", "--no-edit", full], writer);
    } catch (e) {
      await this.run(["revert", "--abort"], writer).catch(() => {});
      throw new GitError(`Later edits touch the same lines, so this can't be undone automatically (${(e as Error).message}).`);
    }
    return { commit: (await this.run(["rev-parse", "HEAD"])).trim(), files };
  }

  private checkHex(commit: string) { if (!HEX.test(commit)) throw new GitError("That isn't a commit id."); }
}

export { HEX as COMMIT_ID };
