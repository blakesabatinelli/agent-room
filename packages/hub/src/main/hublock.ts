// Single-hub guard. We've seen stale hubs: two hub processes driving the goal loops against one SQLite DB step on each
// other. On start the hub takes an exclusive lock (a lock file holding its pid under dataDir). If another LIVE hub already
// holds it, the second hub does not run the orchestrator loops; it exits with a clear message, since the launcher restarts
// a hub it replaced. A lock left by a dead process is stale and is taken over. This is called only from main.ts, never the
// Orchestrator constructor, so tests (which build Orchestrators directly on temp dirs) never trip it.
import { readFileSync, writeFileSync } from "node:fs";

export interface HubLock { pid: number; at: number; port?: number }
export interface LockResult {
  /** True when this process now holds the lock (took it fresh, took over a stale one, or it is already ours). */
  ok: boolean;
  /** The live lock another hub holds, when ok is false. */
  held?: HubLock;
  /** A plain line to print, whether the lock was taken or refused. */
  message: string;
}

/** Is a process with this pid alive? `process.kill(pid, 0)` throws ESRCH when it isn't. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Take the single-hub lock. Pure enough to test: the pid, reader, writer, liveness check and clock are all injectable,
 * so a test never spawns a process or touches a real pid.
 */
export function takeHubLock(o: {
  file: string;
  pid?: number;
  port?: number;
  read?: (f: string) => string;
  write?: (f: string, s: string) => void;
  alive?: (pid: number) => boolean;
  now?: () => number;
}): LockResult {
  const pid = o.pid ?? process.pid;
  const alive = o.alive ?? pidAlive;
  const read = o.read ?? ((f) => readFileSync(f, "utf8"));
  const write = o.write ?? ((f, s) => writeFileSync(f, s, { mode: 0o600 }));
  const now = o.now ?? Date.now;

  let existing: HubLock | undefined;
  try {
    const v = JSON.parse(read(o.file)) as Partial<HubLock>;
    if (typeof v.pid === "number") existing = { pid: v.pid, at: Number(v.at) || 0, ...(v.port !== undefined ? { port: Number(v.port) } : {}) };
  } catch { /* no lock, or unreadable: treat as free */ }

  if (existing && existing.pid !== pid && alive(existing.pid)) {
    return { ok: false, held: existing, message: `Another Agent Room hub is already running (pid ${existing.pid}${existing.port ? ` on port ${existing.port}` : ""}). This one will exit; close the other hub first if you meant to replace it.` };
  }
  const mine: HubLock = { pid, at: now(), ...(o.port !== undefined ? { port: o.port } : {}) };
  try { write(o.file, JSON.stringify(mine) + "\n"); } catch { /* best effort: the loops still run, we just couldn't record the lock */ }
  const took = existing && existing.pid !== pid ? "took over a stale lock" : "took the hub lock";
  return { ok: true, message: `Single-hub guard: ${took} (pid ${pid}).` };
}
