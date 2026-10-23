import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { PathDenied, isInside, resolveInGrant } from "./paths.js";

/**
 * 1.1 Local agents are confined to their task worktree.
 *
 * Claude Code (settings and permission rules: https://code.claude.com/docs/en/permissions and /sandboxing, checked Oct 23, 2026):
 *  - cwd is the worktree and `--add-dir` names only the worktree.
 *  - `--setting-sources ""` ignores user, project and local settings files, so nothing inside the worktree
 *    (an agent can write `.claude/settings.json` there) or in the owner's own settings can widen access or add hooks.
 *  - `--settings <json>` sets `permissions.blockReadsOutsideWorkingDirectories` (the file tools refuse reads outside the working
 *    directories in every permission mode), an empty `permissions.additionalDirectories`, `permissions.deny` rules for credential
 *    folders and the hub's own data, and turns the Bash sandbox on (`sandbox.enabled`, `failIfUnavailable`, no unsandboxed retry),
 *    which is OS-level and also covers child processes that the Read and Edit rules cannot see.
 *  - `--allowedTools` names Read and Edit for the worktree only (`Read(//<abs path>/**)`, `Edit(//<abs path>/**)`: `//` is an absolute
 *    path in permission rules, and Edit rules cover the Write tool). A bare `Read`, `Write`, `Glob` or `Grep` would allow any path.
 *  - Anything else that would ask goes to the hub's approval_prompt tool, which refuses file tools aimed outside the worktree (checkFileToolRequest).
 * Codex: `-C <worktree>`, `--sandbox workspace-write`, no extra writable roots, /tmp not writable.
 * Command adapters: cwd only.
 */

/** Per-user folders that hold credentials, settings and app data. Denied for Read and Edit (a Read deny also blocks Write and Edit). */
export const SECRET_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".claude", ".codex", ".gemini", "Library"];
export const SECRET_HOME_FILES = [".npmrc", ".netrc", ".git-credentials", ".claude.json", ".zsh_history", ".bash_history"];

export interface ConfineOptions {
  /** The worktree (the agent's cwd). */
  cwd: string;
  /** The hub's data folder: its database and other tasks' folders are off limits. */
  dataDir?: string;
  home?: string;
  /** Turn the Bash sandbox on (default true). Off only if the owner's Claude Code cannot sandbox. */
  bashSandbox?: boolean;
}

const real = (p: string) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
/** Permission-rule spelling of an absolute path: a leading `//`. */
const abs = (p: string) => `//${p.replace(/^\/+/, "")}`;

/** Folders and files (absolute) that must stay off limits, minus any that contain the worktree itself (a deny would also deny the worktree). */
export function protectedPaths(o: ConfineOptions): { dirs: string[]; globs: string[] } {
  const wt = real(o.cwd);
  const home = o.home ?? homedir();
  const dirs = SECRET_HOME_DIRS.map((d) => `${home}/${d}`);
  const globs = SECRET_HOME_FILES.map((f) => `${home}/${f}`);
  if (o.dataDir) {
    dirs.push(`${o.dataDir}/goals`, `${o.dataDir}/workspaces`, `${o.dataDir}/Library`);
    globs.push(`${o.dataDir}/*.db`, `${o.dataDir}/*.db-wal`, `${o.dataDir}/*.db-shm`);
  }
  return { dirs: dirs.filter((d) => !isInside(real(d), wt)), globs };
}

export function claudeConfinementSettings(o: ConfineOptions) {
  const { dirs, globs } = protectedPaths(o);
  const deny = [...dirs.map((d) => `Read(${abs(d)}/**)`), ...globs.map((g) => `Read(${abs(g)})`)];
  return {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      additionalDirectories: [] as string[],
      deny,
    },
    ...(o.bashSandbox === false ? {} : {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        // The owner's rule that shell commands ask first must keep working: the sandbox limits what a command can reach, it does not approve it.
        autoAllowBashIfSandboxed: false,
        filesystem: { denyRead: [...dirs, ...globs] },
      },
    }),
  };
}

/** File tools the worktree rules govern. Bare names are replaced by path-scoped rules; other tools keep their bare names. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Replace bare file-tool names in an allow list with rules for the worktree only. */
export function scopeAllowedTools(allowed: string[], cwd: string): string[] {
  const wt = abs(real(cwd));
  const out: string[] = [];
  for (const t of allowed) {
    if (READ_TOOLS.has(t)) out.push(`Read(${wt}/**)`);
    else if (EDIT_TOOLS.has(t)) out.push(`Edit(${wt}/**)`);
    else out.push(t);
  }
  return [...new Set(out)];
}

/** Extra argv for a confined Claude Code run. Spread after the permission args. */
export function claudeConfinementArgs(o: ConfineOptions): string[] {
  return ["--add-dir", o.cwd, "--setting-sources", "", "--settings", JSON.stringify(claudeConfinementSettings(o))];
}

/** Codex: no extra writable roots (nothing but the -C folder), and /tmp is not one either. */
export function codexConfinementArgs(): string[] {
  return ["-c", "sandbox_workspace_write.writable_roots=[]", "-c", "sandbox_workspace_write.exclude_slash_tmp=true"];
}

// ---------- the hub's own check, for what Claude Code sends to approval_prompt

const FILE_TOOLS = new Set([...READ_TOOLS, ...EDIT_TOOLS]);

/**
 * Claude Code asks approval_prompt before a tool that no rule decided. A file tool aimed anywhere but the worktree is refused here,
 * whatever the owner's approval settings say. Paths are resolved through symlinks (the same code that confines MCP file access).
 * Tools that are not file tools (Bash, WebFetch, MCP tools) are not this function's business.
 */
export function checkFileToolRequest(toolName: string, input: Record<string, unknown> | undefined, worktree: string, home = homedir()): { allow: true } | { allow: false; reason: string } {
  if (!FILE_TOOLS.has(toolName)) return { allow: true };
  let root: string;
  try { root = realpathSync.native(worktree); } catch { return { allow: false, reason: "the task folder is not available" }; }
  const candidates: string[] = [];
  for (const k of ["file_path", "notebook_path", "path", "pattern"]) {
    const v = input?.[k];
    if (typeof v !== "string" || !v) continue;
    // A Glob/Grep pattern is only a path when it is anchored (absolute, home-relative) or climbs out with "..".
    if (k === "pattern" && !(/^[/~]/.test(v) || v.split(/[\\/]/).includes(".."))) continue;
    candidates.push(v);
  }
  if (!candidates.length && (toolName === "Read" || EDIT_TOOLS.has(toolName))) return { allow: false, reason: "no file path was given" };
  for (const c of candidates) {
    const expanded = c === "~" ? home : c.startsWith("~/") ? resolve(home, c.slice(2)) : c;
    const target = isAbsolute(expanded) ? expanded : resolve(root, expanded);
    const rel = relative(root, resolve(target));
    try {
      if (rel === "") continue; // the worktree itself
      if (rel.startsWith("..") || isAbsolute(rel)) throw new PathDenied("outside the task folder");
      resolveInGrant(root, rel); // follows symlinks: a link that points out of the worktree is refused
    } catch (e) {
      return { allow: false, reason: `${toolName} is limited to this task's own folder (${e instanceof PathDenied ? e.message : "path not allowed"}).` };
    }
  }
  return { allow: true };
}
