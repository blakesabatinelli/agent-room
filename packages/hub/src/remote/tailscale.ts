// 1.2 Remote access over Tailscale: find the CLI, read its status, and switch Funnel for /mcp on and off.
// CLI syntax (checked 2026-10-23):
//   https://tailscale.com/docs/reference/tailscale-cli/funnel  (--bg, --https, --set-path, --yes, `off`, `status --json`)
//   https://tailscale.com/docs/reference/tailscale-cli/serve   (same flags; `off` needs the original flags)
//   https://tailscale.com/docs/features/tailscale-funnel       (needs MagicDNS, HTTPS certs, the `funnel` node attribute; ports 443/8443/10000)
import { isAbsolute } from "node:path";
import { runProc, type ProcResult } from "../adapters/proc.js";
import type { TailscaleState, TailscaleStatus } from "@agent-room/shared";
import { defaultIsWritable, pathFallbacks, resolveBin, type IsWritable } from "./bin.js";
import { A2A_FUNNEL_PATHS } from "../interop/paths.js"; // 4.6

export const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/** Where the CLI is looked for after $AGENT_ROOM_TAILSCALE_BIN. Fixed absolute paths only; PATH is a guarded fallback (see bin.ts). */
export const FIXED_CLI_PATHS = [MAC_APP_CLI, "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];
export const FUNNEL_PATH = "/mcp";
const ALLOWED_FUNNEL_PORTS = [443, 8443, 10000];

type Run = (cmd: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ProcResult>;

export interface TailscaleOptions {
  /** Explicit CLI: when set, no other location is tried. Without it: $AGENT_ROOM_TAILSCALE_BIN, the fixed paths, then PATH (see candidates()). */
  bin?: string;
  /** Tests: replaces the fixed install locations tried before PATH (defaults to FIXED_CLI_PATHS). */
  fixedPaths?: string[];
  /** Tests: stands in for "this user can write this path" when deciding whether a PATH entry is safe to run. */
  isWritable?: IsWritable;
  /** Extra environment for the CLI (tests point PATH at a fake). */
  env?: NodeJS.ProcessEnv;
  /** How long a status answer is reused. */
  ttlMs?: number;
  /** Which of Funnel's three ports to use. */
  funnelPort?: number;
  /** Opens the Tailscale app so the owner can sign in. Injectable; the default runs `open -a Tailscale` on macOS. */
  openApp?: () => Promise<{ ok: boolean; message: string }>;
  run?: Run;
}

export type FunnelResult =
  | { ok: true; status: TailscaleStatus }
  | { ok: false; error: string; approvalUrl?: string; status?: TailscaleStatus };

/** The parts of tailscale's ServeConfig JSON we read. */
interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string; TerminateTLS?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
}

/** A raw TCP forward in Tailscale's serve config that ends at the hub's own port. */
export interface HubForward { port: number; target: string; /** also reachable from the internet (Funnel) */ public: boolean }

export interface FunnelReading {
  /** Funnel exposes /mcp AND that handler proxies to this hub's /mcp. */
  on: boolean;
  url?: string;
  extraPaths: string[];
  /** A funneled /mcp handler that proxies somewhere other than this hub's /mcp (the target as Tailscale has it). */
  wrongTarget?: string;
  /** TCPForward entries aimed at the hub's port. Their traffic reaches the hub from 127.0.0.1 with nothing marking it as remote. */
  forwards: HubForward[];
}

const portOf = (hostPort: string) => Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
const hostOf = (hostPort: string) => hostPort.slice(0, hostPort.lastIndexOf(":"));
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True when a serve handler's proxy target is this hub's /mcp over loopback (127.0.0.1, localhost or ::1). */
export function proxiesToHubMcp(proxy: string, hubPort: number, path: string = FUNNEL_PATH): boolean {
  let u: URL;
  try { u = new URL(proxy); } catch { return false; }
  return u.protocol === "http:" && LOOPBACK_NAMES.has(u.hostname.toLowerCase()) && Number(u.port || 80) === hubPort && u.pathname === path && !u.search;
}

/** True when a TCPForward target ("127.0.0.1:4747", "localhost:4747", "[::1]:4747", "0.0.0.0:4747") is the hub's port on this Mac. */
export function forwardsToHub(target: string, hubPort: number): boolean {
  const i = target.lastIndexOf(":");
  if (i < 0 || Number(target.slice(i + 1)) !== hubPort) return false;
  const host = target.slice(0, i).toLowerCase();
  return host === "" || host === "0.0.0.0" || LOOPBACK_NAMES.has(host);
}

/**
 * Pure: what Funnel is exposing, from `funnel status --json` / `serve status --json` output. `hubPort` is the port this hub listens on:
 * a funneled /mcp handler only counts as "on" when it proxies to that hub, so a hand-made handler aimed at another service can't pass for ours.
 */
export function readFunnel(raw: unknown, hubPort: number, ours: readonly string[] = []): FunnelReading {
  const root = (raw && typeof raw === "object" ? raw : {}) as ServeConfig;
  const cfgs = [root, ...Object.values(root.Foreground ?? {})];
  let on = false; let url: string | undefined; let wrongTarget: string | undefined; const extra = new Set<string>();
  const forwards: HubForward[] = [];
  for (const cfg of cfgs) {
    const funneledPorts = new Set(Object.entries(cfg.AllowFunnel ?? {}).filter(([, v]) => v).map(([hp]) => portOf(hp)));
    for (const [port, t] of Object.entries(cfg.TCP ?? {})) {
      if (t?.TCPForward && forwardsToHub(t.TCPForward, hubPort)) forwards.push({ port: Number(port), target: t.TCPForward, public: funneledPorts.has(Number(port)) });
    }
    for (const [hp, allowed] of Object.entries(cfg.AllowFunnel ?? {})) {
      if (!allowed) continue;
      const port = portOf(hp);
      if (cfg.TCP?.[String(port)]?.TCPForward) extra.add(`tcp:${port}`);
      for (const [path, h] of Object.entries(cfg.Web?.[hp]?.Handlers ?? {})) {
        if (path === FUNNEL_PATH && h.Proxy) {
          if (proxiesToHubMcp(h.Proxy, hubPort)) { on = true; url = `https://${hostOf(hp)}${port === 443 ? "" : `:${port}`}${FUNNEL_PATH}`; }
          else wrongTarget = h.Proxy;
        } else if (ours.includes(path) && h.Proxy && proxiesToHubMcp(h.Proxy, hubPort, path)) {
          // 4.6: a path the owner switched on ("A2A through Funnel") that proxies to this hub's same path is ours, not an extra.
        } else extra.add(path);
      }
    }
  }
  return { on, url, extraPaths: [...extra].sort(), wrongTarget, forwards };
}

/** Pure: every path (and raw TCP forward) configured on one port, funneled or not. Funnel is switched per port, not per path. */
export function pathsOnPort(raw: unknown, port: number): string[] {
  const root = (raw && typeof raw === "object" ? raw : {}) as ServeConfig;
  const out = new Set<string>();
  for (const cfg of [root, ...Object.values(root.Foreground ?? {})]) {
    for (const [hp, web] of Object.entries(cfg.Web ?? {})) if (portOf(hp) === port) for (const path of Object.keys(web.Handlers ?? {})) out.add(path);
    if (cfg.TCP?.[String(port)]?.TCPForward) out.add(`tcp:${port}`);
  }
  return [...out].sort();
}

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export class Tailscale {
  private readonly pinned: string | undefined;
  private readonly envBin: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly ttlMs: number;
  private readonly run: Run;
  private readonly isWritable: IsWritable;
  private readonly fixed: string[];
  private readonly openAppImpl: () => Promise<{ ok: boolean; message: string }>;
  readonly funnelPort: number;
  /** 4.6: extra paths that are expected on the funneled port right now (the A2A card and endpoint while "A2A through Funnel" is on). The server sets it. */
  allowedExtraPaths: () => readonly string[] = () => [];
  private found: string | undefined;
  private cache: TailscaleStatus | undefined;
  private cachePort = 0;
  private inflight: Promise<TailscaleStatus> | undefined;
  private generation = 0;

  constructor(opts: TailscaleOptions = {}) {
    this.pinned = opts.bin;
    const envBin = process.env.AGENT_ROOM_TAILSCALE_BIN;
    this.envBin = envBin && isAbsolute(envBin) ? envBin : undefined; // a relative override would be a PATH lookup in disguise
    this.env = opts.env;
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.isWritable = opts.isWritable ?? defaultIsWritable;
    this.fixed = opts.fixedPaths ?? FIXED_CLI_PATHS;
    const fp = opts.funnelPort ?? Number(process.env.AGENT_ROOM_FUNNEL_PORT ?? 443);
    this.funnelPort = ALLOWED_FUNNEL_PORTS.includes(fp) ? fp : 443;
    this.run = opts.run ?? ((cmd, args, o) => runProc(cmd, args, o));
    this.openAppImpl = opts.openApp ?? (async () => {
      if (process.platform !== "darwin") return { ok: false, message: "Open the Tailscale app on this computer and sign in." };
      // Fixed /usr/bin/open first; a PATH entry only when nobody but an administrator can change it.
      const bin = resolveBin("open", ["/usr/bin/open"], (opts.env?.PATH ?? process.env.PATH), this.isWritable);
      if (!bin) return { ok: false, message: "Couldn't open Tailscale. Open it from Applications." };
      const r = await runProc(bin, ["-a", "Tailscale"], { timeoutMs: 5000 });
      return r.code === 0 ? { ok: true, message: "Opened Tailscale. Sign in there, then come back." } : { ok: false, message: "Couldn't open Tailscale. Install it first." };
    });
  }

  /** Fixed absolute locations, in order: the explicit `bin` alone, or $AGENT_ROOM_TAILSCALE_BIN, the Mac app, /usr/local/bin, /opt/homebrew/bin. */
  candidates(): string[] { return this.pinned ? [this.pinned] : [...(this.envBin ? [this.envBin] : []), ...this.fixed]; }

  /** After the fixed locations: `tailscale` on PATH, but only an entry that neither its folder nor the file lets this user write. */
  pathCandidates(): string[] {
    if (this.pinned) return [];
    return pathFallbacks("tailscale", (this.env?.PATH ?? process.env.PATH), this.isWritable).filter((p) => !this.candidates().includes(p));
  }

  private async exec(args: string[], timeoutMs = 6000): Promise<{ missing: boolean; r: ProcResult }> {
    for (const bin of this.found ? [this.found] : [...this.candidates(), ...this.pathCandidates()]) {
      const r = await this.run(bin, args, { timeoutMs, env: this.env });
      // A binary that can't be started: ENOENT / EACCES. Try the next place.
      if (r.code !== 0 && /ENOENT|EACCES|not found/i.test(r.stderr) && !r.stdout.trim()) continue;
      this.found = bin;
      return { missing: false, r };
    }
    this.found = undefined;
    return { missing: true, r: { code: -1, stdout: "", stderr: "tailscale not found" } };
  }

  /**
   * Cached 10 s. Pass fresh to re-read now. `hubPort` is the port the hub listens on: Funnel only reads as "on" when /mcp proxies to it.
   * Without it, $AGENT_ROOM_PORT (default 4747) is assumed; there is no "any port" mode.
   */
  async status(fresh = false, hubPort: number = Number(process.env.AGENT_ROOM_PORT ?? 4747)): Promise<TailscaleStatus> {
    if (this.cachePort !== hubPort) { this.cache = undefined; this.inflight = undefined; this.cachePort = hubPort; }
    if (!fresh && this.cache && Date.now() - this.cache.checkedAt < this.ttlMs) return this.cache;
    if (this.inflight && !fresh) return this.inflight;
    const gen = this.generation;
    const p = this.read(hubPort).then((s) => { if (gen === this.generation) this.cache = s; return s; }).finally(() => { if (this.inflight === p) this.inflight = undefined; });
    this.inflight = p;
    return p;
  }

  private invalidate() { this.generation++; this.cache = undefined; this.inflight = undefined; }

  private async read(hubPort: number): Promise<TailscaleStatus> {
    const base = { funnel: { on: false, extraPaths: [] as string[], forwards: [] as HubForward[] }, checkedAt: Date.now() };
    const { missing, r } = await this.exec(["status", "--json"]);
    if (missing) return { state: "not_installed", detail: "Tailscale isn't installed on this Mac.", ...base };
    let j: Record<string, any> | undefined;
    try { j = r.code === 0 ? JSON.parse(r.stdout) : undefined; } catch { j = undefined; }
    if (!j) {
      const why = firstLine(r.stderr) || firstLine(r.stdout);
      return { state: "stopped", detail: why ? `Tailscale isn't running: ${why}` : "Tailscale is installed but isn't running. Open it and turn it on.", ...base };
    }
    const backend = String(j.BackendState ?? "");
    const state: TailscaleState = backend === "Running" ? "running" : backend === "NeedsLogin" || backend === "NeedsMachineAuth" ? "needs_login" : "stopped";
    if (state !== "running") {
      const detail = backend === "NeedsMachineAuth" ? "This Mac needs approval in your Tailscale admin console."
        : state === "needs_login" ? "Tailscale is installed but not signed in." : "Tailscale is installed but turned off.";
      return { state, detail, ...base };
    }
    const self = (j.Self ?? {}) as { DNSName?: string; TailscaleIPs?: string[] };
    const ips = (self.TailscaleIPs?.length ? self.TailscaleIPs : (j.TailscaleIPs as string[] | undefined)) ?? [];
    const ip = ips.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)) ?? ips[0];
    const magic = (j.CurrentTailnet as { MagicDNSEnabled?: boolean } | undefined)?.MagicDNSEnabled !== false;
    const dns = String(self.DNSName ?? "").replace(/\.$/, "");
    const dnsName = magic && dns.includes(".") ? dns : undefined;
    const tailnet = (j.CurrentTailnet as { Name?: string } | undefined)?.Name || (j.MagicDNSSuffix as string | undefined) || undefined;
    const funnel = readFunnel(await this.serveConfig(), hubPort, this.allowedExtraPaths());
    return { state, ip, dnsName, tailnet, funnel, detail: `Connected${tailnet ? ` to ${tailnet}` : ""}.`, checkedAt: Date.now() };
  }

  /** The serve config as of the last read (4.6: setFunnelPaths checks what is left). */
  private lastServe: unknown = {};
  private async serveConfig(): Promise<unknown> {
    for (const sub of ["funnel", "serve"]) {
      const { r } = await this.exec([sub, "status", "--json"]);
      if (r.code !== 0) continue;
      try { const v = JSON.parse(r.stdout || "{}"); if (v && typeof v === "object") return (this.lastServe = v); } catch { /* try the next */ }
    }
    return (this.lastServe = {});
  }

  /** Expose the hub's /mcp (and nothing else) at https://<magicdns>/mcp. */
  async enableFunnel(hubPort: number): Promise<FunnelResult> {
    const st = await this.status(true, hubPort);
    if (st.state === "not_installed") return { ok: false, error: "Install Tailscale first.", status: st };
    if (st.state !== "running") return { ok: false, error: "Sign in to Tailscale first.", status: st };
    if (!st.dnsName) return { ok: false, error: "Funnel needs MagicDNS and HTTPS certificates turned on for your tailnet in the Tailscale admin console.", status: st };
    // Funnel is on or off for a whole port. If anything else is served there, switching it on would make that public too.
    const others = pathsOnPort(await this.serveConfig(), this.funnelPort).filter((p) => p !== FUNNEL_PATH && !this.allowedExtraPaths().includes(p));
    if (others.length) return { ok: false, status: st, error: `Port ${this.funnelPort} on this Mac already serves ${others.join(", ")}. Funnel would make that public too, so it stays off. Remove it with "tailscale serve reset" or use another port.` };
    const target = `http://127.0.0.1:${hubPort}${FUNNEL_PATH}`;
    const { r } = await this.exec(["funnel", "--bg", "--yes", `--https=${this.funnelPort}`, `--set-path=${FUNNEL_PATH}`, target], 25_000);
    this.invalidate();
    const after = await this.status(true, hubPort);
    if (after.funnel.on) return { ok: true, status: after };
    const text = `${r.stdout}\n${r.stderr}`;
    const approvalUrl = text.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
    const error = approvalUrl ? "Your tailnet hasn't allowed Funnel yet. Approve it in the Tailscale admin console, then try again."
      : firstLine(r.stderr) || firstLine(r.stdout) || "Tailscale didn't turn Funnel on.";
    return { ok: false, error, approvalUrl, status: after };
  }

  /**
   * 4.6: add (or remove) handlers for exact paths on the funneled port, each proxying to the hub's same path. Used for the two A2A paths only.
   * Adding needs Funnel to be on already. Stops at the first failure and says why.
   */
  async setFunnelPaths(hubPort: number, paths: readonly string[], on: boolean): Promise<FunnelResult> {
    const st = await this.status(true, hubPort);
    if (on && !st.funnel.on) return { ok: false, error: "Turn Funnel on first.", status: st };
    for (const path of paths) {
      const args = on
        ? ["funnel", "--bg", "--yes", `--https=${this.funnelPort}`, `--set-path=${path}`, `http://127.0.0.1:${hubPort}${path}`]
        : ["funnel", `--https=${this.funnelPort}`, `--set-path=${path}`, "off"];
      const { r } = await this.exec(args, 25_000);
      if (on && r.code !== 0) {
        this.invalidate();
        return { ok: false, error: firstLine(r.stderr) || firstLine(r.stdout) || `Tailscale didn't serve ${path}.`, status: await this.status(true, hubPort) };
      }
    }
    this.invalidate();
    const after = await this.status(true, hubPort);
    if (on) return { ok: true, status: after };
    const left = paths.filter((p) => pathsOnPort(this.lastServe, this.funnelPort).includes(p));
    return left.length ? { ok: false, error: `Tailscale still serves ${left.join(", ")}.`, status: after } : { ok: true, status: after };
  }

  /** Remove only the /mcp handler (and the A2A ones). Never `reset`: that would wipe the owner's other serve settings. */
  async disableFunnel(hubPort: number = Number(process.env.AGENT_ROOM_PORT ?? 4747)): Promise<FunnelResult> {
    for (const p of A2A_FUNNEL_PATHS) await this.exec(["funnel", `--https=${this.funnelPort}`, `--set-path=${p}`, "off"], 15_000); // 4.6: nothing public may be left on the port
    const { missing, r } = await this.exec(["funnel", `--https=${this.funnelPort}`, `--set-path=${FUNNEL_PATH}`, "off"], 15_000);
    this.invalidate();
    const after = await this.status(true, hubPort);
    if (missing) return { ok: false, error: "Tailscale isn't installed.", status: after };
    if (!after.funnel.on) return { ok: true, status: after };
    return { ok: false, status: after, error: firstLine(r.stderr) || firstLine(r.stdout) || "Tailscale didn't turn Funnel off. Run: tailscale funnel reset" };
  }

  openApp() { return this.openAppImpl(); }
}

/** The process-wide instance used where no server is in play (startup banner, net.ts). */
let shared: Tailscale | undefined;
export function defaultTailscale(): Tailscale { return (shared ??= new Tailscale()); }
