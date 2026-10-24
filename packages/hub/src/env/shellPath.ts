// Apps opened from Finder get launchd's thin PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the one Terminal has. Agent CLIs live wherever the owner
// installed them: the native installers' ~/.local/bin, Homebrew, an npm global folder, nvm/volta/asdf/fnm, pnpm, bun, or Claude Code's older
// "local" install (~/.claude/local, reached in Terminal through a shell alias, so never on PATH). Without this the hub can't start `claude`
// ("spawn claude ENOENT") even though `claude` works in Terminal.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MARK = "__AGENT_ROOM_PATH__";

/** The PATH between the markers in a login shell's output (rc files may print other things around it). */
export function parseShellPath(out: string): string | undefined {
  const i = out.indexOf(MARK), j = out.indexOf(MARK, i + MARK.length);
  if (i < 0 || j < 0) return undefined;
  const p = out.slice(i + MARK.length, j).trim();
  return p.includes("/") ? p : undefined;
}

/** The owner's PATH as their login, interactive shell sets it (zsh reads .zprofile and .zshrc, where nvm and friends hook in). Five seconds at most. */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh", timeoutMs = 5000): string | undefined {
  try {
    const r = spawnSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
    return r.stdout ? parseShellPath(r.stdout) : undefined;
  } catch { return undefined; }
}

/** Folders agent CLIs are commonly installed in, that exist on this Mac. nvm and fnm: every installed Node's bin, newest first. */
export function knownCliDirs(home: string, exists: (p: string) => boolean = existsSync, list: (p: string) => string[] = (p) => { try { return readdirSync(p); } catch { return []; } }): string[] {
  const fixed = [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin", ".asdf/shims", "Library/pnpm", ".cargo/bin", ".deno/bin", ".yarn/bin"].map((d) => join(home, d));
  const versions = (base: string, tail: string) => list(base).filter((v) => /^v?\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((v) => join(base, v, tail));
  const managed = [...versions(join(home, ".nvm/versions/node"), "bin"), ...versions(join(home, "Library/Application Support/fnm/node-versions"), "installation/bin")];
  return [...fixed, ...managed, "/opt/homebrew/bin", "/usr/local/bin"].filter(exists);
}

/** PATH for the hub: what it was started with, then the login shell's, then the known folders. No duplicates, order kept. */
export function hubPath(current: string | undefined, shell: string | undefined, known: string[]): string {
  const parts = [current, shell].flatMap((p) => (p ?? "").split(":")).concat(known).filter(Boolean);
  return [...new Set(parts)].join(":");
}
