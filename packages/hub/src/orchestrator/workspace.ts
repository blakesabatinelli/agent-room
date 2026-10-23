import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CheckRun } from "@agent-room/shared";
import { runProc } from "../adapters/proc.js";

/**
 * Every task in a goal works in one shared folder, so files pass from task to task.
 * Snapshots let the orchestrator see exactly which files a task changed and hold it to
 * the files it was given (the work contract's scope gate, at file level).
 */
export function goalFolder(dataDir: string, goalId: string) {
  const dir = join(dataDir, "goals", goalId, "files");
  mkdirSync(dir, { recursive: true }); return dir;
}

// LEDGER.md is the orchestrator's own progress file; agents read it but its changes are never theirs.
const SKIP = new Set([".git", "node_modules", ".DS_Store", "LEDGER.md"]);
const hidden = (name: string) => name.startsWith(".agent-room") || SKIP.has(name);

export type Snapshot = Map<string, string>; // relative path -> content hash

export function snapshot(root: string, limit = 3000): Snapshot {
  const out: Snapshot = new Map();
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (hidden(name) || out.size >= limit) continue;
      const full = join(dir, name);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        // big files: hash size+mtime instead of reading them
        const sig = st.size > 20_000_000 ? `${st.size}:${st.mtimeMs}` : createHash("sha1").update(readFileSync(full)).digest("hex");
        out.set(relative(root, full), sig);
      }
    }
  };
  walk(root);
  return out;
}

export function changedFiles(before: Snapshot, after: Snapshot) {
  const changed: string[] = [];
  for (const [p, h] of after) if (before.get(p) !== h) changed.push(p);
  for (const p of before.keys()) if (!after.has(p)) changed.push(p);
  return changed.sort();
}

/** "deck.pptx", "drafts/*.md", "out/**" */
function globToRe(g: string) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${esc.replace(/^\.\//, "")}$`);
}
export function outsideScope(changed: string[], allowed: string[] | undefined) {
  if (!allowed?.length) return [];
  const res = allowed.map((g) => globToRe(g.trim().replace(/^\.\//, "")));
  return changed.filter((p) => !res.some((r) => r.test(p)));
}

export function listFiles(root: string) {
  return [...snapshot(root).keys()].sort();
}

/** Run one acceptance check in the shared folder. Exit 0 = PASS. */
export async function runCheck(criterionId: string, command: string, cwd: string, timeoutMs = 60_000): Promise<CheckRun> {
  const r = await runProc("/bin/sh", ["-c", command], { cwd, timeoutMs });
  const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  return { criterionId, command, ok: r.code === 0, exitCode: r.code, output: output.slice(-1500), at: Date.now() };
}
