import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ForkFileChange } from "@agent-room/shared";
import { tooLargeToDiff, unifiedDiff } from "../files/diff.js";

/**
 * 4.4 What a fork side delivered, as files against the shared start.
 * Two kinds of side: a hub folder (compared to the copy of the start state the fork kept) and a branch in the owner's repository
 * (compared to the owner's head when the fork began, with git). Nothing here follows a symlink or reads a hard link: an agent can
 * write into its own folder, and what is read from it may be copied to the owner's.
 */

export interface FileDelta { path: string; change: "added" | "modified" | "deleted" }
export interface ReadChange { relPath: string; /** null = deleted */ content: Buffer | null }

const SKIP = new Set([".git", "node_modules", ".DS_Store", "LEDGER.md"]);
const skip = (name: string) => SKIP.has(name) || name.startsWith(".agent-room");
const MAX_FILES = 3000;
const MAX_READ = 2 * 1024 * 1024;
const BIG = 20_000_000;
const DIFF_CHARS = 20_000;
const MAX_SHOWN = 40;

/** relative path -> content hash, for plain files only (no symlinks, no hard links). */
export function scan(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (skip(name) || out.size >= MAX_FILES) continue;
      const full = join(dir, name);
      let st; try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.nlink <= 1) {
        try { out.set(relative(root, full), st.size > BIG ? `${st.size}:${st.mtimeMs}` : createHash("sha1").update(readFileSync(full)).digest("hex")); } catch { /* unreadable */ }
      }
    }
  };
  walk(root);
  return out;
}

/** What a folder changed against the folder it started as. */
export function folderDeltas(start: string, folder: string): FileDelta[] {
  const a = scan(start), b = scan(folder);
  const out: FileDelta[] = [];
  for (const [p, h] of b) { if (!a.has(p)) out.push({ path: p, change: "added" }); else if (a.get(p) !== h) out.push({ path: p, change: "modified" }); }
  for (const p of a.keys()) if (!b.has(p)) out.push({ path: p, change: "deleted" });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);
function readPlain(full: string): Buffer | undefined {
  try { const st = lstatSync(full); return st.isFile() && !st.isSymbolicLink() && st.nlink <= 1 ? readFileSync(full) : undefined; } catch { return undefined; }
}

/** One file's change with its unified diff. A file that isn't text, or is too large to show, has no diff. */
export function folderChange(start: string, folder: string, d: FileDelta): ForkFileChange {
  const before = d.change === "added" ? undefined : readPlain(join(start, d.path));
  const after = d.change === "deleted" ? undefined : readPlain(join(folder, d.path));
  const bytes = (after ?? before)?.length ?? 0;
  if ((before && !isText(before)) || (after && !isText(after))) return { path: d.path, change: d.change, bytes, diff: "", binary: true };
  if ((before?.length ?? 0) > MAX_READ || (after?.length ?? 0) > MAX_READ) return { path: d.path, change: d.change, bytes, diff: "", truncated: true };
  const o = before ? before.toString("utf8") : null, n = after ? after.toString("utf8") : null;
  if (tooLargeToDiff(o, n)) return { path: d.path, change: d.change, bytes, diff: "", truncated: true };
  const full = unifiedDiff(d.path, o, n);
  return { path: d.path, change: d.change, bytes, diff: full.length > DIFF_CHARS ? `${full.slice(0, DIFF_CHARS)}\n... (cut)\n` : full, ...(full.length > DIFF_CHARS ? { truncated: true } : {}) };
}

/** The first files of a side's changes, and how many more there are. */
export function folderDeliverables(start: string, folder: string): { files: ForkFileChange[]; more: number } {
  const all = folderDeltas(start, folder);
  return { files: all.slice(0, MAX_SHOWN).map((d) => folderChange(start, folder, d)), more: Math.max(0, all.length - MAX_SHOWN) };
}

/** The changes as the file broker takes them: contents read under the size limit, links and oversized files left out with the reason. */
export function readChanges(folder: string, deltas: FileDelta[], maxBytes = MAX_READ): { changes: ReadChange[]; skipped: { relPath: string; reason: string }[] } {
  const changes: ReadChange[] = [], skipped: { relPath: string; reason: string }[] = [];
  for (const d of deltas) {
    if (d.change === "deleted") { changes.push({ relPath: d.path, content: null }); continue; }
    const full = join(folder, d.path);
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) { skipped.push({ relPath: d.path, reason: "symlink; not written back" }); continue; }
      if (!st.isFile()) continue;
      if (st.nlink > 1) { skipped.push({ relPath: d.path, reason: "hard link; not written back" }); continue; }
      if (st.size > maxBytes) { skipped.push({ relPath: d.path, reason: `larger than ${maxBytes} bytes` }); continue; }
      changes.push({ relPath: d.path, content: readFileSync(full) });
    } catch { skipped.push({ relPath: d.path, reason: "could not be read" }); }
  }
  return { changes, skipped };
}

/** Copy a side's changes into the target folder: new and changed files are copied, deleted ones removed. Returns how many files were touched. */
export function applyDeltas(from: string, to: string, deltas: FileDelta[]): number {
  let n = 0;
  for (const d of deltas) {
    const dest = join(to, d.path);
    if (relative(to, dest).startsWith("..")) continue; // paths come from a directory walk, never from an agent, but never write outside anyway
    if (d.change === "deleted") { rmSync(dest, { force: true }); n++; continue; }
    const src = join(from, d.path);
    try {
      const st = lstatSync(src);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) continue;
      mkdirSync(dirname(dest), { recursive: true });
      rmSync(dest, { force: true });
      copyFileSync(src, dest); n++;
    } catch { /* gone since it was scanned */ }
  }
  return n;
}

// ---------------------------------------------------------------- a branch in the owner's repository

export type GitFn = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** One `diff --git` section per file. */
export function splitGitDiff(raw: string): { path: string; change: FileDelta["change"]; binary: boolean; diff: string }[] {
  const out: { path: string; change: FileDelta["change"]; binary: boolean; diff: string }[] = [];
  for (const part of raw.split(/^diff --git /m).slice(1)) {
    const head = part.split("\n", 1)[0];
    const m = /^a\/(.*) b\/(.*)$/.exec(head);
    const path = m ? m[2] : head;
    const change: FileDelta["change"] = /^new file mode/m.test(part) ? "added" : /^deleted file mode/m.test(part) ? "deleted" : "modified";
    const binary = /^Binary files /m.test(part) || /^GIT binary patch/m.test(part);
    const at = part.search(/^--- /m);
    out.push({ path, change, binary, diff: binary || at < 0 ? "" : part.slice(at) });
  }
  return out;
}

/** What `branch` changed in the owner's repository since `start` (the owner's head when the fork began). Null when the branch isn't there. */
export async function gitDeliverables(git: GitFn, start: string, branch: string): Promise<{ files: ForkFileChange[]; more: number; tip: string } | null> {
  const tip = await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  if (tip.code !== 0) return null;
  const sha = tip.stdout.trim();
  const mb = await git(["merge-base", start, sha]);
  const base = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : start;
  const d = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U3", base, sha]);
  if (d.code !== 0) return { files: [], more: 0, tip: sha };
  const parts = splitGitDiff(d.stdout);
  const files: ForkFileChange[] = [];
  for (const p of parts.slice(0, MAX_SHOWN)) {
    const size = p.change === "deleted" ? 0 : Number((await git(["cat-file", "-s", `${sha}:${p.path}`])).stdout.trim()) || 0;
    files.push({ path: p.path, change: p.change, bytes: size, diff: p.diff.length > DIFF_CHARS ? `${p.diff.slice(0, DIFF_CHARS)}\n... (cut)\n` : p.diff, ...(p.binary ? { binary: true } : {}), ...(p.diff.length > DIFF_CHARS ? { truncated: true } : {}) });
  }
  return { files, more: Math.max(0, parts.length - MAX_SHOWN), tip: sha };
}
