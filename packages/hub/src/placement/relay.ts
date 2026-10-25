import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PathDenied, assertPlainPath, resolveInGrant, touchesGit } from "../files/paths.js";
import { needsWorkspace } from "./index.js";

/**
 * Save relay: let an agent that runs on another machine do a task that works on the task folder.
 *
 * An off-machine agent has no task folder of its own, so it cannot write files. When the task only needs files written (no command
 * check that has to RUN on this Mac), the agent instead hands each deliverable file back inside its reply, and a local step writes
 * those contents into the task's worktree through the same path guards every other write uses. A task whose acceptance is decided by a
 * runnable command stays local: that command needs the live machine, not just the file contents.
 */

/** Does this task carry an acceptance criterion a shell command decides? Such a check must run on this Mac, so the task is not relay-eligible. */
export function hasRunnableChecks(t: { criteria?: unknown }): boolean {
  return Array.isArray(t.criteria)
    && t.criteria.some((c) => typeof c === "object" && c !== null && typeof (c as { check?: unknown }).check === "string" && (c as { check: string }).check.trim().length > 0);
}

/** The smallest predicate: a task works on the folder and nothing about it has to run on this Mac, so an off-machine agent can do it and a local step saves the result. */
export function relayEligible(t: { needs?: string[]; criteria?: unknown }): boolean {
  return needsWorkspace(t) && !hasRunnableChecks(t);
}

/** The exact shape an off-machine agent hands a file back in. One block per file; the path is relative to the task folder. */
export const RELAY_EXAMPLE = "=== FILE: relative/path.md\n<full verbatim file contents>\n=== END FILE";

/** What an off-machine agent is told to do instead of writing files (used in the task prompt and in the send-back when it forgets). */
export const RELAY_RULE = `You have no task folder on your machine, so you cannot write files yourself. Produce each deliverable file's full contents in your reply and the hub will save it into the task folder for you. Hand back every file as its own block, in this exact form:\n${RELAY_EXAMPLE}\nOne block per file. Put the path relative to the task folder between "FILE:" and the newline (never an absolute path such as /tmp or /Users, and never "..") and the complete, verbatim file contents between the markers. Still write your STATUS block after the files.`;

/** A line matching the opening of a file block, and the closing marker. The delimiter is distinctive enough not to collide with ordinary prose. */
const OPEN = /^===[ \t]*FILE:[ \t]*(.+?)[ \t]*\r?$/;
const CLOSE = /^===[ \t]*END[ \t]+FILE[ \t]*\r?$/;

export interface FileBlock { path: string; content: string }

/**
 * Pull the file blocks out of an agent's reply. Robust to a reply that also holds prose and a STATUS block: only the text between a
 * `=== FILE: <path>` line and the next `=== END FILE` line is taken, and that span is one file's verbatim contents.
 */
export function parseFileBlocks(reply: string | undefined): FileBlock[] {
  if (!reply) return [];
  const lines = reply.split("\n");
  const out: FileBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m) continue;
    const path = m[1].trim();
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !CLOSE.test(lines[j]); j++) body.push(lines[j]);
    if (j >= lines.length) break; // no closing marker: not a complete block, stop
    if (path) out.push({ path, content: body.join("\n") });
    i = j; // continue after the END marker
  }
  return out;
}

export interface SaveResult { saved: string[]; refused: { path: string; reason: string }[] }

/**
 * Write each parsed file into the task's worktree, reusing the hub's own path guards (resolveInGrant, assertPlainPath, touchesGit), so an
 * absolute path, a `..` that escapes, a .git write or a deceptive name is refused here exactly as it is for a local agent. The worktree
 * is the hub's to write; accepted work then merges back through the normal path.
 */
export function saveRelayFiles(worktree: string, blocks: FileBlock[]): SaveResult {
  const saved: string[] = [];
  const refused: { path: string; reason: string }[] = [];
  for (const b of blocks) {
    try {
      assertPlainPath(b.path);
      if (touchesGit(b.path)) throw new PathDenied("writes inside .git are not allowed");
      const target = resolveInGrant(worktree, b.path); // refuses absolute paths and traversal out of the worktree
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, b.content.endsWith("\n") ? b.content : `${b.content}\n`);
      saved.push(b.path);
    } catch (e) {
      refused.push({ path: b.path, reason: e instanceof PathDenied ? e.message : "could not be saved" });
    }
  }
  return { saved, refused };
}
