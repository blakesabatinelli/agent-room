// 4.7 Crash reports. An uncaught exception or unhandled rejection is written, scrubbed, to <data dir>/crashes/<timestamp>.json, and the hub
// exits. launchd restarts it (the LaunchAgent has KeepAlive on; the app starts it again otherwise). Writing the file is local, like a log.
// Whether it ever leaves this Mac is a separate choice, see reporting.ts: off by default, and only with an endpoint configured.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { CrashEntry } from "@agent-room/shared";
import { macosVersion } from "./version.js";
import { safeFrames, safeMessage, safeName } from "./scrub.js";

export interface CrashReport {
  schema: 1;
  type: "crash";
  at: string;
  kind: "uncaughtException" | "unhandledRejection";
  name: string;
  code?: string;
  message: string;
  stack: string[];
  appVersion: string;
  node: string;
  platform: string;
  arch: string;
  macosVersion: string;
  uptimeSeconds: number;
}

const KEEP = 50;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,60}$/;

export function crashDir(dataDir: string) { return join(dataDir, "crashes"); }

/** Builds the report for whatever was thrown. Nothing but code and platform facts goes in. */
export function buildCrashReport(error: unknown, kind: CrashReport["kind"], ctx: { version: string; now?: number; uptimeSeconds?: number; homes?: string[]; macos?: string }): CrashReport {
  const e = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown } | null;
  const isObj = typeof error === "object" && error !== null;
  const name = isObj ? safeName(e?.name) : "NonError";
  const code = isObj && typeof e?.code === "string" && SAFE_CODE.test(e.code) ? e.code : undefined;
  const message = isObj && typeof e?.message === "string" ? safeMessage(name, code, e.message, ctx.homes) : "(message withheld)";
  return {
    schema: 1, type: "crash", at: new Date(ctx.now ?? Date.now()).toISOString(), kind,
    name, ...(code ? { code } : {}), message,
    stack: isObj && typeof e?.stack === "string" ? safeFrames(e.stack, ctx.homes) : [],
    appVersion: ctx.version, node: process.version, platform: platform(), arch: arch(), macosVersion: ctx.macos ?? macosVersion(),
    uptimeSeconds: Math.round(ctx.uptimeSeconds ?? process.uptime()),
  };
}

/** Writes the report (mode 0600 in a 0700 folder) and keeps the newest KEEP. Synchronous: it runs while the process is dying. Returns the file name. */
export function writeCrashReport(dataDir: string, report: CrashReport, now = Date.now()): string {
  const dir = crashDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let name = `${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`;
  if (existsSync(join(dir, name))) name = name.replace(/\.json$/, `-${Math.floor(Math.random() * 1e4)}.json`);
  writeFileSync(join(dir, name), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(join(dir, name), 0o600); } catch { /* best effort */ }
  const all = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) rmSync(join(dir, old), { force: true });
  return name;
}

interface ProcLike { on(ev: string, fn: (...a: unknown[]) => void): unknown; off(ev: string, fn: (...a: unknown[]) => void): unknown }

/**
 * Catches what would otherwise kill the hub without a trace. Call once, first thing in main.ts, before anything can throw.
 * `exit` is injectable so a test can watch it instead of dying. Returns a function that removes the handlers.
 */
export function installCrashHandlers(opts: { dataDir: string; version: string; proc?: ProcLike; exit?: (code: number) => void; log?: (m: string) => void }): () => void {
  const proc = opts.proc ?? (process as unknown as ProcLike);
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const log = opts.log ?? ((m: string) => console.error(m));
  let handling = false;
  const handle = (kind: CrashReport["kind"]) => (error: unknown) => {
    if (handling) return; // a crash inside the crash handler must not loop
    handling = true;
    let file = "(not written)";
    try { file = writeCrashReport(opts.dataDir, buildCrashReport(error, kind, { version: opts.version })); } catch { /* the disk may be the problem */ }
    // The hub log is the owner's own file. It gets the full error so a developer can fix it; the report file stays scrubbed.
    log(`Agent Room hub crashed (${kind}). Report: ${file}\n${(error as Error)?.stack ?? String(error)}`);
    exit(1);
  };
  const onException = handle("uncaughtException"), onRejection = handle("unhandledRejection");
  proc.on("uncaughtException", onException);
  proc.on("unhandledRejection", onRejection);
  return () => { proc.off("uncaughtException", onException); proc.off("unhandledRejection", onRejection); };
}

/** What the app lists: newest first. `sent` files are kept in crashes/sent so a re-upload never happens. */
export function listCrashReports(dataDir: string): CrashEntry[] {
  const dir = crashDir(dataDir);
  const out: CrashEntry[] = [];
  for (const [sub, sent] of [["", false], ["sent", true]] as const) {
    let files: string[] = [];
    try { files = readdirSync(join(dir, sub)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      try {
        const r = JSON.parse(readFileSync(join(dir, sub, f), "utf8")) as Partial<CrashReport>;
        out.push({ name: f, at: Date.parse(r.at ?? "") || statSync(join(dir, sub, f)).mtimeMs, kind: String(r.kind ?? "unknown"), message: `${r.name ?? "Error"}: ${r.message ?? ""}`.slice(0, 200), sent });
      } catch { /* a damaged file is left alone */ }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Reports not yet uploaded, as parsed objects, oldest first. */
export function pendingCrashReports(dataDir: string): { name: string; report: CrashReport }[] {
  const dir = crashDir(dataDir);
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const out: { name: string; report: CrashReport }[] = [];
  for (const f of files) {
    try { const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as CrashReport; if (r?.type === "crash") out.push({ name: f, report: r }); } catch { /* skip */ }
  }
  return out;
}

export function markCrashSent(dataDir: string, name: string) {
  const dir = crashDir(dataDir);
  mkdirSync(join(dir, "sent"), { recursive: true, mode: 0o700 });
  renameSync(join(dir, name), join(dir, "sent", name));
}

/** Deletes every crash report this hub wrote (the owner's "Delete crash reports"). */
export function clearCrashReports(dataDir: string): number {
  const dir = crashDir(dataDir);
  let n = 0;
  for (const sub of ["", "sent"]) {
    let files: string[] = [];
    try { files = readdirSync(join(dir, sub)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) { rmSync(join(dir, sub, f), { force: true }); n++; }
  }
  return n;
}

/** Crashes in the last `days` days (reports waiting and already sent), for the telemetry count. */
export function crashCountSince(dataDir: string, sinceMs: number): number {
  return listCrashReports(dataDir).filter((c) => c.at >= sinceMs).length;
}
