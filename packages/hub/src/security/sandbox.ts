import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * S4: OS-enforced confinement for agents the hub starts as plain commands (Hermes, local runners, ACP agents).
 *
 * Claude Code confines Bash with its own sandbox and Codex runs under its workspace-write Seatbelt profile; a command agent had nothing.
 * On macOS it now runs under sandbox-exec with a profile that:
 *   - denies every file write outside its task folder, the temp folders and paths the owner listed for it (settings.writablePaths);
 *   - denies reads AND writes of the hub's data folder (database, keys, other tasks' worktrees), the control files that steer agents,
 *     and the other CLIs' credential stores.
 * Reads elsewhere stay open: the agent needs its own install, libraries and models.
 *
 * sandbox-exec is deprecated by Apple but still what Codex and Chrome use; the profile language is SBPL. Off only when the owner sets
 * settings.sandbox = false on the agent, which the adapter audits on every run.
 */

/** SBPL string literal. Paths come from the hub and the owner's settings, never from an agent. */
const lit = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const realOr = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };

/** Credential stores of other agents' CLIs and common secret folders, relative to home. */
export const CREDENTIAL_PATHS = [
  ".claude", ".claude.json", ".codex", ".config/gh", ".ssh", ".aws", ".gnupg", ".netrc", ".git-credentials", ".npmrc", ".docker/config.json",
  ".config/gcloud", ".kube", "Library/Keychains", ".agent-room",
];

export interface SandboxOptions {
  /** The task folder: the only place the agent may write besides temp. */
  cwd: string;
  /** The hub's data folder: never readable or writable. */
  dataDir?: string;
  /** Control files (AGENTS.md, POLICY.md, agents/, rooms/, goals/...): never writable, never readable except through the hub. */
  protectedPaths?: string[];
  /** Extra folders the owner lets this agent write (its own home, e.g. ~/.hermes). */
  writablePaths?: string[];
  /** Credential folders this agent may read (its own). Relative to home, from CREDENTIAL_PATHS. */
  ownCredentials?: string[];
  home?: string;
}

export function sandboxProfile(o: SandboxOptions): string {
  const home = realOr(o.home ?? homedir());
  const writable = [o.cwd, tmpdir(), "/private/tmp", "/private/var/folders", ...(o.writablePaths ?? [])].map(realOr);
  const own = new Set(o.ownCredentials ?? []);
  const secret = [
    ...(o.dataDir ? [realOr(o.dataDir)] : []),
    ...(o.protectedPaths ?? []).map(realOr),
    ...CREDENTIAL_PATHS.filter((c) => !own.has(c)).map((c) => join(home, c)),
  ];
  return [
    "(version 1)",
    "(allow default)",
    // Writes: nowhere but the task folder, temp and the owner's list. /dev/null and ttys stay writable.
    "(deny file-write*)",
    `(allow file-write* ${writable.map((p) => `(subpath ${lit(p)})`).join(" ")} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty"))`,
    // Secrets: neither read nor written, even inside a writable folder. Deny rules listed last win in SBPL.
    ...(secret.length ? [`(deny file-read* file-write* ${secret.map((p) => `(subpath ${lit(p)})`).join(" ")})`] : []),
    // The task folder itself lives inside the data folder: open it again, and only it.
    `(allow file-read* file-write* (subpath ${lit(realOr(o.cwd))}))`,
  ].join("\n");
}

/** The command and arguments to run `cmd args` confined. Unchanged off macOS (no sandbox-exec) or when disabled. */
export function confineCommand(cmd: string, args: string[], o: SandboxOptions & { enabled?: boolean; platform?: NodeJS.Platform }): { cmd: string; args: string[]; confined: boolean } {
  if (o.enabled === false || (o.platform ?? process.platform) !== "darwin") return { cmd, args, confined: false };
  return { cmd: "/usr/bin/sandbox-exec", args: ["-p", sandboxProfile(o), cmd, ...args], confined: true };
}
