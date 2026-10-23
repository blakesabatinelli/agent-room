import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 1.1 Hardening for every git command the hub runs.
 *
 * The hub runs git OUTSIDE any agent sandbox (commit, merge, worktree add, push). An agent that is not under an OS sandbox
 * (a command adapter, or Claude Code with `bashSandbox: false`) can write to the repository's shared `.git/config` from its
 * worktree (`git config core.fsmonitor '<cmd>'`), and the hub's next git call would run that command as the owner.
 * Two layers:
 *   (a) every call passes command-line `-c` overrides (they outrank every config file) for each option that can name a command,
 *       plus environment that closes the same doors; and
 *   (b) for repositories the hub owns, the common `.git/config` is snapshotted when the hub creates the repository and put back
 *       byte for byte before every hub git call (GitConfigGuard). That also neutralises `filter.<name>.clean/smudge/process`,
 *       `merge.<name>.driver` and `diff.<name>.command/textconv` drivers, which cannot be switched off by name from the command line.
 *
 * Options that execute a command, from git-config(1) (https://git-scm.com/docs/git-config), the variable index checked Oct 23, 2026:
 *   core.fsmonitor            hook path or built-in daemon: a command run on every status/add/diff
 *   core.hooksPath            directory of hooks (pre-commit, post-merge, reference-transaction, pre-push, ...)
 *   core.sshCommand           command used instead of ssh                   (GIT_SSH_COMMAND, GIT_SSH)
 *   core.askPass              program that asks for a password              (GIT_ASKPASS, SSH_ASKPASS)
 *   core.editor, sequence.editor   editor command                          (GIT_EDITOR, GIT_SEQUENCE_EDITOR)
 *   core.pager, pager.<cmd>   pager command (only on a terminal; --no-pager is passed as well)
 *   core.gitProxy             proxy command for git:// URLs                  (GIT_PROXY_COMMAND)
 *   core.alternateRefsCommand command run to list refs of an alternate object store
 *   credential.helper, credential.<url>.helper    credential helper programs (an empty value resets the whole list)
 *   diff.external             external diff program                          (GIT_EXTERNAL_DIFF)
 *   diff.<driver>.command, diff.<driver>.textconv       per-driver; need a driver name, so config restore (b) handles them
 *   filter.<driver>.clean/smudge/process                per-driver; same
 *   merge.<driver>.driver                               per-driver; same
 *   gpg.program, gpg.<format>.program, gpg.ssh.defaultKeyCommand   signing/verification programs
 *   uploadpack.packObjectsHook   command that replaces pack-objects while serving a fetch/clone from a local path
 *   protocol.ext.allow        the `ext::<command>` transport (also closed by GIT_ALLOW_PROTOCOL=file)
 *   remote.<name>.vcs, remote.<name>.receivepack/uploadpack, url.<base>.insteadOf   per-remote; hub repos have no remotes, and only the file protocol is allowed
 *   trailer.<token>.command, submodule.<name>.update=!cmd, alias.<name>=!cmd, browser/man/web.* tools   never invoked by the hub
 *   include.path, includeIf.*.path   pull in another config file: only the restored config (b) is trusted
 *   maintenance.auto, gc.auto, gc.autoDetach   background `git maintenance`/gc runs
 * Hooks in `.git/hooks` are closed by core.hooksPath; `.git/info/attributes` and `.gitattributes` can only select drivers that (b) keeps undefined.
 */
export const HARDENED_GIT_CONFIG: [key: string, value: string][] = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["diff.external", ""],
  ["core.sshCommand", ""],
  ["credential.helper", ""],
  ["core.askPass", ""],
  ["protocol.ext.allow", "never"],
  ["uploadpack.packObjectsHook", ""],
  ["core.editor", "true"],
  ["sequence.editor", "true"],
  ["core.pager", "cat"],
  ["core.gitProxy", ""],
  ["core.alternateRefsCommand", ""],
  ["core.attributesFile", "/dev/null"],
  ["gpg.program", "false"],
  ["gpg.ssh.program", "false"],
  ["gpg.x509.program", "false"],
  ["gpg.openpgp.program", "false"],
  ["gpg.ssh.defaultKeyCommand", ""],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["fetch.recurseSubmodules", "false"],
  ["submodule.recurse", "false"],
];

/** `git` global options for every hub call: no pager, plus the -c overrides above. */
export function hardenedGitArgs(): string[] {
  return ["--no-pager", ...HARDENED_GIT_CONFIG.flatMap(([k, v]) => ["-c", `${k}=${v}`])];
}

/** Environment for every hub git call. `undefined` removes a variable the hub itself inherited. */
export function hardenedGitEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    // Only local paths: no ssh, http, git:// or ext:: transport can be used, whatever a config or URL says.
    GIT_ALLOW_PROTOCOL: "file",
    GIT_EXTERNAL_DIFF: undefined, GIT_SSH: undefined, GIT_SSH_COMMAND: undefined, GIT_ASKPASS: undefined, SSH_ASKPASS: undefined,
    GIT_PROXY_COMMAND: undefined, GIT_SEQUENCE_EDITOR: undefined, GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG_COUNT: undefined,
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_NAMESPACE: undefined, GIT_TEMPLATE_DIR: undefined,
  };
}

/** Config keys git itself may set while it adds a worktree (lower-cased, as `git config --list` prints them). Everything else is put back. */
export const REPO_CONFIG_ALLOWED = ["extensions.worktreeconfig", "core.repositoryformatversion"] as const;

/**
 * Layer (b). Keeps the bytes of the common `.git/config` of each repository the hub owns and puts them back before every hub git call.
 * The snapshots are also kept on disk (outside the repositories) so a hub restart does not forget them. A repository the hub
 * has no snapshot for (made before this existed) is snapshotted the first time it is used: trust on first use.
 */
export class GitConfigGuard {
  private mem = new Map<string, Buffer>();
  constructor(private dir: string, private onRestore: (repo: string, why: string) => void = () => undefined, private gitBin = "git") {}

  private configPath(repo: string) { return join(repo, ".git", "config"); }
  private snapPath(repo: string) { return join(this.dir, `${createHash("sha256").update(repo).digest("hex").slice(0, 24)}.config`); }

  /** Remember the repository's config as it is now. Call right after the hub creates or sets up the repository. */
  snapshot(repo: string) {
    let buf: Buffer;
    try { buf = readFileSync(this.configPath(repo)); } catch { return; }
    this.mem.set(repo, buf);
    try { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.snapPath(repo), buf, { mode: 0o600 }); } catch { /* memory copy still works */ }
  }

  has(repo: string) { return this.mem.has(repo) || existsSync(this.snapPath(repo)); }

  /**
   * 1.1 round 2 (M2). Call after a hub git command that may legitimately have touched the config of a repository that already has a
   * snapshot (`git worktree add`). The snapshot is NEVER simply retaken: anything an agent wrote into the config during that window
   * would become trusted. The current config is compared with the snapshot key by key (`git config --file --list`, which runs nothing):
   * when the only differences are keys git itself sets for worktrees (REPO_CONFIG_ALLOWED) the new config becomes the snapshot,
   * otherwise the snapshot is put back and the restore is reported. A repository with no snapshot yet is snapshotted (first use).
   */
  reconcile(repo: string, allowed: readonly string[] = REPO_CONFIG_ALLOWED): "same" | "accepted" | "restored" {
    const want = this.mem.get(repo) ?? (() => { try { return readFileSync(this.snapPath(repo)); } catch { return undefined; } })();
    if (!want) { this.snapshot(repo); return "same"; }
    this.mem.set(repo, want);
    let cur: Buffer;
    try { cur = readFileSync(this.configPath(repo)); } catch { this.restore(repo); return "restored"; }
    if (cur.equals(want)) return "same";
    const before = this.entries(want), after = this.entries(cur);
    if (before && after) {
      const keys = new Set([...before.keys(), ...after.keys()]);
      const changed = [...keys].filter((k) => JSON.stringify(before.get(k) ?? null) !== JSON.stringify(after.get(k) ?? null));
      if (changed.length > 0 && changed.every((k) => allowed.includes(k))) {
        this.mem.set(repo, cur);
        try { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.snapPath(repo), cur, { mode: 0o600 }); } catch { /* memory copy still works */ }
        return "accepted";
      }
    }
    this.restore(repo);
    return "restored";
  }

  /** key -> values of a config file's bytes, read by git itself without running anything (`git config --file`). undefined when it cannot be parsed. */
  private entries(buf: Buffer): Map<string, string[]> | undefined {
    const tmp = join(this.dir, `.parse-${process.pid}-${createHash("sha256").update(buf).digest("hex").slice(0, 12)}`);
    try {
      mkdirSync(this.dir, { recursive: true }); writeFileSync(tmp, buf, { mode: 0o600 });
      const out = execFileSync(this.gitBin, [...hardenedGitArgs(), "config", "--file", tmp, "--list", "-z"], { encoding: "utf8", env: { ...process.env, ...hardenedGitEnv() } as NodeJS.ProcessEnv, timeout: 20_000 });
      const m = new Map<string, string[]>();
      for (const rec of out.split("\0").filter(Boolean)) {
        const i = rec.indexOf("\n"); const k = i < 0 ? rec : rec.slice(0, i), v = i < 0 ? "" : rec.slice(i + 1);
        m.set(k, [...(m.get(k) ?? []), v]);
      }
      return m;
    } catch { return undefined; }
    finally { try { rmSync(tmp, { force: true }); } catch { /* none */ } }
  }

  /** Put the config back if anything changed it. Returns true when it had to. */
  restore(repo: string): boolean {
    let want = this.mem.get(repo);
    if (!want) {
      try { want = readFileSync(this.snapPath(repo)); this.mem.set(repo, want); } catch { this.snapshot(repo); return false; }
    }
    const p = this.configPath(repo);
    let same = false;
    try {
      const st = lstatSync(p);
      same = st.isFile() && !st.isSymbolicLink() && readFileSync(p).equals(want);
    } catch { /* missing: written below */ }
    if (same) return false;
    try {
      rmSync(p, { recursive: true, force: true });
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.hub-${process.pid}`;
      writeFileSync(tmp, want, { mode: 0o644 });
      renameSync(tmp, p);
    } catch { /* best effort: layer (a) still holds */ }
    this.onRestore(repo, "the repository's config was changed outside the hub and has been put back");
    return true;
  }

  forget(repo: string) { this.mem.delete(repo); try { rmSync(this.snapPath(repo), { force: true }); } catch { /* none */ } }
}
