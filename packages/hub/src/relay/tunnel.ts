import { WebSocket } from "ws";

/**
 * Outbound tunnel to the relay (spike 0.3). The hub dials out; nothing listens for the relay.
 * Each framed request is replayed against the hub's own loopback HTTP server, so the hub's normal
 * auth (MCP bearer tokens) runs on every call. Frame format is documented in packages/relay/src/relay.ts.
 */

export type TunnelState = "connecting" | "connected" | "disconnected";

export interface TunnelOptions {
  relayUrl: string; // ws(s)://relay.example/hub/connect
  hubId: string;
  secret: string;
  localBase: string; // http://127.0.0.1:<port>
  allowPaths?: string[];
  onState?: (state: TunnelState, detail?: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);
const METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const WATCHDOG_MS = 75_000; // the relay pings every 25 s; silence for three intervals means the link is dead
const BUFFER_HIGH_WATER = 1024 * 1024;

type ReqFrame = { t: "req"; id: string; method: string; path: string; headers: Record<string, string | string[]>; body?: string };

export function connectTunnel(opts: TunnelOptions): { close(): void } {
  const allow = new Set(opts.allowPaths ?? ["/mcp"]);
  const minBackoff = opts.minBackoffMs ?? 1000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  let ws: WebSocket | undefined;
  let closed = false;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  const inflight = new Map<string, AbortController>();
  const state = (s: TunnelState, detail?: string) => { try { opts.onState?.(s, detail); } catch { /* observer errors never break the tunnel */ } };

  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    const base = Math.min(maxBackoff, minBackoff * 2 ** attempt);
    attempt++;
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    retryTimer = setTimeout(() => { retryTimer = undefined; dial(); }, delay);
  };

  const send = async (sock: WebSocket, frame: unknown) => {
    if (sock.readyState !== WebSocket.OPEN) return false;
    while (sock.bufferedAmount > BUFFER_HIGH_WATER) {
      await new Promise((r) => setTimeout(r, 10));
      if (sock.readyState !== WebSocket.OPEN) return false;
    }
    sock.send(JSON.stringify(frame));
    return true;
  };

  const onFrame = async (sock: WebSocket, text: string) => {
    let f: { t?: string; id?: string };
    try { f = JSON.parse(text); } catch { return; }
    if (typeof f.id !== "string") return;
    if (f.t === "cancel") { inflight.get(f.id)?.abort(); return; }
    if (f.t !== "req") return;
    const req = f as ReqFrame;
    const { id } = req;
    let url: URL | undefined;
    try { if (typeof req.path === "string" && req.path.startsWith("/") && !req.path.startsWith("//")) url = new URL("http://hub.invalid" + req.path); } catch { /* falls through */ }
    // Defence in depth: this allowlist is enforced here too, whatever the relay says.
    if (!url || url.host !== "hub.invalid" || !allow.has(url.pathname) || !METHODS.has(req.method)) {
      await send(sock, { t: "err", id, message: "Path not allowed by the hub tunnel." });
      return;
    }
    const ctl = new AbortController();
    inflight.set(id, ctl);
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        for (const one of Array.isArray(v) ? v : [v]) headers.append(k, String(one));
      }
      headers.set("x-agent-room-via", "relay");
      headers.set("accept-encoding", "identity");
      const body = req.method === "GET" || req.method === "HEAD" || !req.body ? undefined : Buffer.from(req.body, "base64");
      const res = await fetch(opts.localBase + url.pathname + url.search, { method: req.method, headers, body, signal: ctl.signal, redirect: "manual" });
      const out: Record<string, string | string[]> = {};
      res.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k) && k !== "content-encoding" && k !== "set-cookie") out[k] = v; });
      const cookies = res.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      if (!(await send(sock, { t: "head", id, status: res.status, headers: out }))) return;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!(await send(sock, { t: "data", id, chunk: Buffer.from(value).toString("base64") }))) { ctl.abort(); return; }
        }
      }
      await send(sock, { t: "end", id });
    } catch (e) {
      if (!ctl.signal.aborted) await send(sock, { t: "err", id, message: `Local hub request failed: ${(e as Error).name}` });
    } finally {
      if (inflight.get(id) === ctl) inflight.delete(id);
    }
  };

  const dial = () => {
    if (closed) return;
    state("connecting");
    const sock = new WebSocket(opts.relayUrl, { headers: { "x-hub-id": opts.hubId, authorization: `Bearer ${opts.secret}` }, maxPayload: 32 * 1024 * 1024 });
    ws = sock;
    const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => sock.terminate(), WATCHDOG_MS); };
    let lost = false;
    const lose = (detail?: string) => {
      if (lost) return;
      lost = true;
      clearTimeout(watchdog);
      for (const c of inflight.values()) c.abort();
      inflight.clear();
      state("disconnected", detail);
      scheduleRetry();
    };
    sock.on("open", () => { attempt = 0; arm(); state("connected"); });
    sock.on("ping", arm);
    sock.on("message", (raw) => { arm(); void onFrame(sock, raw.toString()); });
    sock.on("unexpected-response", (_req, res) => { res.resume(); lose(`relay refused the connection (HTTP ${res.statusCode})`); });
    sock.on("error", (e) => { if (sock.readyState !== WebSocket.OPEN) lose(e.message); });
    sock.on("close", () => lose());
  };

  dial();
  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(watchdog);
      for (const c of inflight.values()) c.abort();
      inflight.clear();
      ws?.terminate();
    },
  };
}
