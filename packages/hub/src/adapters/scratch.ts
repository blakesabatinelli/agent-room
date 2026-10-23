import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, RunRequest, RunResult } from "./types.js";

/**
 * 1.1 round 2 (M1). Planning, judging and drafting calls (`jsonOnly`) run no tools, but the CLI they start still reads project files from its
 * working folder (`.claude/settings.json` hooks, `AGENTS.md`, `.codex/config.toml`). They used to run in `<data>/workspaces/<agent>/<room>`, a
 * folder that confined runs of the same agent also write, so a room run could plant a hook there that the next planner call executed
 * outside any sandbox. A jsonOnly run now gets a fresh, empty, private folder that no agent run ever writes, and it is deleted afterwards.
 * The folder is under the hub's data folder when there is one (a confined run may not read or write there), else in the system temp folder.
 */
export async function inJsonScratch<T>(req: Pick<RunRequest, "dataDir">, run: (cwd: string) => Promise<T>): Promise<T> {
  const base = req.dataDir ? join(req.dataDir, "scratch") : join(tmpdir(), "agent-room-scratch");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(base, "json-"));
  try { return await run(cwd); } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } }
}

/**
 * Makes an adapter that starts a CLI or a command run its jsonOnly calls in a scratch folder; every other run is untouched. The adapter object
 * itself is returned (its `run` is replaced), so it is still an instance of its own class.
 */
export function withJsonScratch<A extends Adapter>(a: A): A {
  const run = a.run.bind(a);
  a.run = (req: RunRequest): Promise<RunResult> => (req.jsonOnly ? inJsonScratch(req, (cwd) => run({ ...req, cwd })) : run(req));
  return a;
}
