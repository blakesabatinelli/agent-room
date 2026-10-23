import { spawn } from "node:child_process";

export interface ProcResult { code: number | null; stdout: string; stderr: string }

/** Spawn a process, stream stdout lines, honour abort, never use a shell. */
export function runProc(
  cmd: string, args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onLine?: (l: string) => void; stdin?: string; timeoutMs?: number },
): Promise<ProcResult> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", buf = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e) }); return;
    }
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort);
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString(); stdout += s; buf += s;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); opts.onLine?.(line); }
    });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code) => {
      if (buf) opts.onLine?.(buf);
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin); else child.stdin.end();
  });
}

export async function which(bin: string): Promise<string | null> {
  const r = await runProc("/usr/bin/env", ["which", bin], {});
  return r.code === 0 ? r.stdout.trim() : null;
}
