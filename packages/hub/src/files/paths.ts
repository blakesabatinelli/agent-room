import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Thrown for any path the hub refuses. The message is safe to show to an agent. */
export class PathDenied extends Error {}

export const MAX_REL_PATH = 1024;

const real = (p: string) => realpathSync.native(p);

/** Characters that make a name look like something else in an approval card: format (Cf: bidi overrides, zero-width), line and paragraph separators. */
const DECEPTIVE_NAME = /[\p{Cf}\p{Zl}\p{Zp}]/u;
/**
 * 1.1 round 2 (L3). More ways a name can read as a different one on the owner's card, none of which has a use in a file an agent writes:
 *  - U+034F (combining grapheme joiner), U+FE00 to U+FE0F (variation selectors), U+180B to U+180D (Mongolian free variation selectors): invisible nonspacing marks;
 *  - U+00A0 (no-break space) and U+3000 (ideographic space): a space that is not the space it looks like;
 *  - a nonspacing mark (Mn) after a character that is not a letter (it floats over a dot or a slash), or after a Latin letter or digit at the end of a
 *    name or just before the dot of an extension (`report.pdf` + a mark reads as `report.pdf`).
 * Whatever else NFKC would rewrite (full-width letters, ligatures, other exotic spaces) is refused by the last check in assertPlainPath.
 */
const LOOKALIKE_NAME = /[\u034F\uFE00-\uFE0F\u180B-\u180D\u00A0\u3000]|(?<![\p{L}\p{Mn}])\p{Mn}|[A-Za-z0-9]\p{Mn}+(?=$|[./\\])/u;

/** Throws PathDenied for a path whose spelling could mislead the owner reading it. */
export function assertPlainPath(relPath: string): void {
  if (DECEPTIVE_NAME.test(relPath) || LOOKALIKE_NAME.test(relPath) || relPath.normalize("NFKC") !== relPath) {
    throw new PathDenied("invisible, look-alike or direction-changing characters in a path are not allowed");
  }
}

/** True when p is root or lies below it. Both must already be absolute and normalised. */
export function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolve `relPath` against a granted folder and return the absolute path to use on disk.
 * The result never contains a symlink or `..`: it is the real path of the longest existing
 * ancestor plus the (not yet existing) remainder. Throws PathDenied for anything that is, or
 * could end up, outside the folder.
 */
export function resolveInGrant(grantRoot: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) throw new PathDenied("empty path");
  if (relPath.length > MAX_REL_PATH) throw new PathDenied(`path longer than ${MAX_REL_PATH} characters`);
  if (relPath.includes("\0")) throw new PathDenied("path contains a NUL byte");
  if (isAbsolute(relPath)) throw new PathDenied("absolute paths are not allowed; use a path relative to the granted folder");

  let root: string;
  try { root = real(grantRoot); } catch { throw new PathDenied("the granted folder is not available"); }

  const lexical = resolve(root, relPath);
  if (!isInside(root, lexical)) throw new PathDenied("path escapes the granted folder");

  // Longest ancestor that exists (lstat, so a dangling symlink counts as existing and is then rejected below).
  let cur = lexical;
  for (;;) {
    try { lstatSync(cur); break; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new PathDenied("path cannot be accessed");
      const up = dirname(cur);
      if (up === cur || !isInside(root, up)) throw new PathDenied("path cannot be accessed");
      cur = up;
    }
  }
  let resolved: string;
  try { resolved = real(cur); } catch { throw new PathDenied("path cannot be resolved (broken symlink?)"); }
  if (!isInside(root, resolved)) throw new PathDenied("path resolves outside the granted folder");
  return join(resolved, relative(cur, lexical));
}

/** Thrown for a folder the hub refuses to grant. `canForce` = the owner may still grant it with `force` and a reason. */
export class GrantRefused extends PathDenied {
  constructor(message: string, readonly canForce: boolean, readonly because?: string) { super(message); }
}

/** Parts of the machine that hold credentials, settings or the system itself. Granting inside one needs the owner's explicit override. */
const SYSTEM_ROOTS = ["/System", "/Library", "/private", "/etc", "/usr", "/bin", "/sbin", "/Applications", "/var", "/dev", "/proc", "/sys", "/boot", "/lib", "/lib64"];

export interface GrantRootOptions {
  /** The hub's data folder (database, worktrees). */
  dataDir?: string;
  home?: string;
  /** Other paths that may not be granted, each with the words shown to the owner (the control folder's version history). */
  extraProtected?: { path: string; because: string }[];
  /** Replaces the system folder list (tests). */
  systemRoots?: string[];
}

const realIfExists = (p: string | undefined) => { if (!p) return undefined; try { return existsSync(p) ? real(p) : undefined; } catch { return undefined; } };

/**
 * Check a folder the owner wants to grant and say how it is protected.
 * Throws GrantRefused (canForce false) for the ones that can never be granted: missing paths, non-directories, `/`, and the home folder
 * or any folder that contains it. Returns `because` for the ones that need an explicit override (every dot-folder under home, ~/Library,
 * system folders, the hub's data folder, the control folder's version history), and nothing for an ordinary folder.
 */
export function inspectGrantRoot(input: string, opts: GrantRootOptions = {}): { root: string; because?: string } {
  const hard = (m: string) => new GrantRefused(m, false);
  if (typeof input !== "string" || !input || input.includes("\0")) throw hard("a folder path is required");
  if (!isAbsolute(input)) throw hard("the folder path must be absolute");
  let root: string;
  try { root = real(input); } catch { throw hard("that folder does not exist"); }
  if (!statSync(root).isDirectory()) throw hard("that path is not a folder");
  if (root === sep || dirname(root) === root) throw hard("the filesystem root cannot be granted");
  // 1.1 round 2 (L1): a version-control folder is never reachable through the broker (touchesGit), so a grant that is one, or lies inside one, is a mistake or an attack.
  if (touchesGit(root)) throw hard("a .git folder (or a folder inside one) cannot be granted");

  const home = realIfExists(opts.home ?? homedir());
  if (home && isInside(root, home)) throw hard("the home folder (or a folder containing it) cannot be granted; pick a subfolder");

  const reasons: string[] = [];
  if (home && isInside(home, root)) {
    const first = relative(home, root).split(sep)[0];
    if (first.startsWith(".")) reasons.push(`~/${first} holds settings, credentials or app data`);
    else if (first === "Library") reasons.push("~/Library holds app data and credentials");
  }
  // The user's temp folder lives under /var or /private on a Mac. It is scratch space, not system.
  const tmp = realIfExists(tmpdir());
  if (!(tmp && isInside(tmp, root))) {
    for (const s of opts.systemRoots ?? SYSTEM_ROOTS) {
      const r = realIfExists(s);
      if (r && (isInside(r, root) || isInside(s, root))) { reasons.push(`${s} is part of the system`); break; }
    }
  }
  const data = realIfExists(opts.dataDir);
  if (data && (isInside(root, data) || isInside(data, root))) reasons.push("the Agent Room data folder holds the database and keys");
  for (const x of opts.extraProtected ?? []) {
    const r = realIfExists(x.path);
    if (r && isInside(r, root)) reasons.push(x.because);
  }
  return { root, because: reasons.length ? reasons.join("; ") : undefined };
}

/** inspectGrantRoot, refusing every protected folder. The owner's override goes through inspectGrantRoot and is audited by the broker. */
export function validateGrantRoot(input: string, opts: GrantRootOptions = {}): string {
  const { root, because } = inspectGrantRoot(input, opts);
  if (because) throw new GrantRefused(`${because}, so it cannot be granted without an explicit override`, true, because);
  return root;
}

/** True when a path (relative, any spelling) goes through a `.git` folder. Agents never read or write version-control internals: .git/config can hold credentials. */
export function touchesGit(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((part) => part.toLowerCase() === ".git");
}
