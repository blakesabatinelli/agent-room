// 1.2 Remote access over Tailscale: find the CLI, read its status, and switch Funnel for /mcp on and off.
// CLI syntax (checked 2026-10-23):
//   https://tailscale.com/docs/reference/tailscale-cli/funnel  (--bg, --https, --set-path, --yes, `off`, `status --json`)
//   https://tailscale.com/docs/reference/tailscale-cli/serve   (same flags; `off` needs the original flags)
//   https://tailscale.com/docs/features/tailscale-funnel       (needs MagicDNS, HTTPS certs, the `funnel` node attribute; ports 443/8443/10000)
import { runProc, type ProcResult } from "../adapters/proc.js";
import type { TailscaleState, TailscaleStatus } from "@agent-room/shared";

export const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export const FUNNEL_PATH = "/mcp";
const ALLOWED_FUNNEL_PORTS = [443, 8443, 10000];

type Run = (cmd: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ProcResult>;

export interface TailscaleOptions {
  /** Explicit CLI. Defaults to $AGENT_ROOM_TAILSCALE_BIN; when set, no other location is tried. */
  bin?: string;
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

export interface FunnelReading { on: boolean; url?: string; extraPaths: string[] }

const portOf = (hostPort: string) => Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
const hostOf = (hostPort: string) => hostPort.slice(0, hostPort.lastIndexOf(":"));

/** Pure: what Funnel is exposing, from `funnel status --json` / `serve status --json` output. */
export function readFunnel(raw: unknown): FunnelReading {
  const root = (raw && typeof raw === "object" ? raw : {}) as ServeConfig;
  const cfgs = [root, ...Object.values(root.Foreground ?? {})];
  let on = false; let url: string | undefined; const extra = new Set<string>();
  for (const cfg of cfgs) {
    for (const [hp, allowed] of Object.entries(cfg.AllowFunnel ?? {})) {
      if (!allowed) continue;
      const port = portOf(hp);
      if (cfg.TCP?.[String(port)]?.TCPForward) extra.add(`tcp:${port}`);
      for (const [path, h] of Object.entries(cfg.Web?.[hp]?.Handlers ?? {})) {
        if (path === FUNNEL_PATH && h.Proxy) { on = true; url = `https://${hostOf(hp)}${port === 443 ? "" : `:${port}`}${FUNNEL_PATH}`; }
        else extra.add(path);
      }
    }
  }
  return { on, url, extraPaths: [...extra].sort() };
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
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly ttlMs: number;
  private readonly run: Run;
  private readonly openAppImpl: () => Promise<{ ok: boolean; message: string }>;
  readonly funnelPort: number;
  private found: string | undefined;
  private cache: TailscaleStatus | undefined;
  private inflight: Promise<TailscaleStatus> | undefined;
  private generation = 0;

  constructor(opts: TailscaleOptions = {}) {
    this.pinned = opts.bin ?? (process.env.AGENT_ROOM_TAILSCALE_BIN || undefined);
    this.env = opts.env;
    this.ttlMs = opts.ttlMs ?? 10_000;
    const fp = opts.funnelPort ?? Number(process.env.AGENT_ROOM_FUNNEL_PORT ?? 443);
    this.funnelPort = ALLOWED_FUNNEL_PORTS.includes(fp) ? fp : 443;
    this.run = opts.run ?? ((cmd, args, o) => runProc(cmd, args, o));
    this.openAppImpl = opts.openApp ?? (async () => {
      if (process.platform !== "darwin") return { ok: false, message: "Open the Tailscale app on this computer and sign in." };
      const r = await runProc("/usr/bin/open", ["-a", "Tailscale"], { timeoutMs: 5000 });
      return r.code === 0 ? { ok: true, message: "Opened Tailscale. Sign in there, then come back." } : { ok: false, message: "Couldn't open Tailscale. Install it first." };
    });
  }

  /** Where the CLI may live, in order: the explicit override alone, or PATH then the Mac app bundle. */
  candidates(): string[] { return this.pinned ? [this.pinned] : ["tailscale", MAC_APP_CLI]; }

  private async exec(args: string[], timeoutMs = 6000): Promise<{ missing: boolean; r: ProcResult }> {
    for (const bin of this.found ? [this.found] : this.candidates()) {
      const r = await this.run(bin, args, { timeoutMs, env: this.env });
      // A binary that can't be started: ENOENT / EACCES. Try the next place.
      if (r.code !== 0 && /ENOENT|EACCES|not found/i.test(r.stderr) && !r.stdout.trim()) continue;
      this.found = bin;
      return { missing: false, r };
    }
    this.found = undefined;
    return { missing: true, r: { code: -1, stdout: "", stderr: "tailscale not found" } };
  }

  /** Cached 10 s. Pass fresh to re-read now. */
  async status(fresh = false): Promise<TailscaleStatus> {
    if (!fresh && this.cache && Date.now() - this.cache.checkedAt < this.ttlMs) return this.cache;
    if (this.inflight && !fresh) return this.inflight;
    const gen = this.generation;
    const p = this.read().then((s) => { if (gen === this.generation) this.cache = s; return s; }).finally(() => { if (this.inflight === p) this.inflight = undefined; });
    this.inflight = p;
    return p;
  }

  private invalidate() { this.generation++; this.cache = undefined; this.inflight = undefined; }

  private async read(): Promise<TailscaleStatus> {
    const base = { funnel: { on: false, extraPaths: [] as string[] }, checkedAt: Date.now() };
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
    const funnel = await this.readFunnel();
    return { state, ip, dnsName, tailnet, funnel, detail: `Connected${tailnet ? ` to ${tailnet}` : ""}.`, checkedAt: Date.now() };
  }

  private async serveConfig(): Promise<unknown> {
    for (const sub of ["funnel", "serve"]) {
      const { r } = await this.exec([sub, "status", "--json"]);
      if (r.code !== 0) continue;
      try { const v = JSON.parse(r.stdout || "{}"); if (v && typeof v === "object") return v; } catch { /* try the next */ }
    }
    return {};
  }
  private async readFunnel(): Promise<FunnelReading> { return readFunnel(await this.serveConfig()); }

  /** Expose the hub's /mcp (and nothing else) at https://<magicdns>/mcp. */
  async enableFunnel(hubPort: number): Promise<FunnelResult> {
    const st = await this.status(true);
    if (st.state === "not_installed") return { ok: false, error: "Install Tailscale first.", status: st };
    if (st.state !== "running") return { ok: false, error: "Sign in to Tailscale first.", status: st };
    if (!st.dnsName) return { ok: false, error: "Funnel needs MagicDNS and HTTPS certificates turned on for your tailnet in the Tailscale admin console.", status: st };
    // Funnel is on or off for a whole port. If anything else is served there, switching it on would make that public too.
    const others = pathsOnPort(await this.serveConfig(), this.funnelPort).filter((p) => p !== FUNNEL_PATH);
    if (others.length) return { ok: false, status: st, error: `Port ${this.funnelPort} on this Mac already serves ${others.join(", ")}. Funnel would make that public too, so it stays off. Remove it with "tailscale serve reset" or use another port.` };
    const target = `http://127.0.0.1:${hubPort}${FUNNEL_PATH}`;
    const { r } = await this.exec(["funnel", "--bg", "--yes", `--https=${this.funnelPort}`, `--set-path=${FUNNEL_PATH}`, target], 25_000);
    this.invalidate();
    const after = await this.status(true);
    if (after.funnel.on) return { ok: true, status: after };
    const text = `${r.stdout}\n${r.stderr}`;
    const approvalUrl = text.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
    const error = approvalUrl ? "Your tailnet hasn't allowed Funnel yet. Approve it in the Tailscale admin console, then try again."
      : firstLine(r.stderr) || firstLine(r.stdout) || "Tailscale didn't turn Funnel on.";
    return { ok: false, error, approvalUrl, status: after };
  }

  /** Remove only the /mcp handler. Never `reset`: that would wipe the owner's other serve settings. */
  async disableFunnel(): Promise<FunnelResult> {
    const { missing, r } = await this.exec(["funnel", `--https=${this.funnelPort}`, `--set-path=${FUNNEL_PATH}`, "off"], 15_000);
    this.invalidate();
    const after = await this.status(true);
    if (missing) return { ok: false, error: "Tailscale isn't installed.", status: after };
    if (!after.funnel.on) return { ok: true, status: after };
    return { ok: false, status: after, error: firstLine(r.stderr) || firstLine(r.stdout) || "Tailscale didn't turn Funnel off. Run: tailscale funnel reset" };
  }

  openApp() { return this.openAppImpl(); }
}

/** The process-wide instance used where no server is in play (startup banner, net.ts). */
let shared: Tailscale | undefined;
export function defaultTailscale(): Tailscale { return (shared ??= new Tailscale()); }
