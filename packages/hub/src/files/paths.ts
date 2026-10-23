import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Thrown for any path the hub refuses. The message is safe to show to an agent. */
export class PathDenied extends Error {}

export const MAX_REL_PATH = 1024;

const real = (p: string) => realpathSync.native(p);

/** Characters that make a name look like something else in an approval card: format (Cf: bidi overrides, zero-width), line and paragraph separators. */
const DECEPTIVE_NAME = /[\p{Cf}\p{Zl}\p{Zp}]/u;

/** Throws PathDenied for a path whose spelling could mislead the owner reading it. */
export function assertPlainPath(relPath: string): void {
  if (DECEPTIVE_NAME.test(relPath)) throw new PathDenied("invisible or direction-changing characters in a path are not allowed");
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

/** The credential folders under the user's home that can never be granted. */
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube"];

/**
 * Check a folder the owner wants to grant and return its realpath. Refuses: missing paths, non-directories,
 * `/`, the home folder itself, any folder that contains the home folder or the hub's data folder,
 * anything inside the data folder, and the usual credential folders under home.
 */
export function validateGrantRoot(input: string, opts: { dataDir?: string; home?: string } = {}): string {
  if (typeof input !== "string" || !input || input.includes("\0")) throw new PathDenied("a folder path is required");
  if (!isAbsolute(input)) throw new PathDenied("the folder path must be absolute");
  let root: string;
  try { root = real(input); } catch { throw new PathDenied("that folder does not exist"); }
  if (!statSync(root).isDirectory()) throw new PathDenied("that path is not a folder");
  if (root === sep || dirname(root) === root) throw new PathDenied("the filesystem root cannot be granted");

  const protect = (p: string | undefined) => (p && existsSync(p) ? real(p) : undefined);
  const home = protect(opts.home ?? homedir());
  const data = protect(opts.dataDir);
  if (home) {
    if (isInside(root, home)) throw new PathDenied("the home folder (or a folder containing it) cannot be granted; pick a subfolder");
    for (const d of SECRET_DIRS) if (isInside(join(home, d), root)) throw new PathDenied(`${d} holds credentials and cannot be granted`);
  }
  if (data && (isInside(root, data) || isInside(data, root))) throw new PathDenied("the Agent Room data folder cannot be granted");
  return root;
}
