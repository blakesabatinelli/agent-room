import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

/**
 * Outbound-only relay (spike 0.3). The hub dials out to /hub/connect and keeps that WebSocket open.
 * Cloud clients call /h/<hubId>/<path>; the relay frames the request over the hub's own socket and
 * streams the answer back. The relay never inspects MCP traffic: the hub authenticates every call.
 *
 * Frames (JSON text, bodies base64):
 *   relay -> hub: {t:"req", id, method, path, headers, body} | {t:"cancel", id}
 *   hub -> relay: {t:"head", id, status, headers} | {t:"data", id, chunk} | {t:"end", id} | {t:"err", id, message}
 */

export type HubSecrets = Record<string, string> | ((hubId: string, secret: string) => boolean);

export interface RelayOptions {
  port: number;
  /** hubId -> sha256 hex of the hub's secret, or a custom check. */
  hubSecrets: HubSecrets;
  host?: string;
  allowPaths?: string[];
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  pingIntervalMs?: number;
}

export interface Relay { port: number; close(): Promise<void> }

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);
const HUB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const WS_MAX_PAYLOAD = 32 * 1024 * 1024;

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

interface Pending {
  res: ServerResponse;
  headSent: boolean;
  timer: NodeJS.Timeout | undefined;
}
interface HubConn { ws: WebSocket; pending: Map<string, Pending>; alive: boolean; nextId: number }

function secretChecker(hubSecrets: HubSecrets): (hubId: string, secret: string) => boolean {
  if (typeof hubSecrets === "function") return hubSecrets;
  const table = new Map(Object.entries(hubSecrets));
  const dummy = Buffer.alloc(32);
  return (hubId, secret) => {
    const expectedHex = table.get(hubId);
    const expected = expectedHex && SHA256_HEX.test(expectedHex) ? Buffer.from(expectedHex, "hex") : undefined;
    // Compare digests so the comparison is constant-time whatever the secret's length; unknown hubs still do one compare.
    const ok = timingSafeEqual(Buffer.from(sha256Hex(secret), "hex"), expected ?? dummy);
    return !!expected && ok;
  };
}

/** Normalise "/mcp?x=1" style input; returns undefined for anything that is not a plain absolute path. */
export function normalisePath(raw: string): { pathname: string; search: string } | undefined {
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  try {
    const u = new URL("http://relay.invalid" + raw);
    if (u.host !== "relay.invalid") return undefined;
    return { pathname: u.pathname, search: u.search };
  } catch { return undefined; }
}

export async function startRelay(opts: RelayOptions): Promise<Relay> {
  const allow = new Set(opts.allowPaths ?? ["/mcp", "/health"]);
  const maxBody = opts.maxBodyBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.requestTimeoutMs ?? 120_000;
  const checkSecret = secretChecker(opts.hubSecrets);
  const hubs = new Map<string, HubConn>();

  const json = (res: ServerResponse, status: number, error: string) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": "no-store" });
    res.end(JSON.stringify({ error }));
  };

  const send = (hub: HubConn, frame: unknown) => { if (hub.ws.readyState === WebSocket.OPEN) hub.ws.send(JSON.stringify(frame)); };

  const finish = (hub: HubConn, id: string) => {
    const p = hub.pending.get(id);
    if (p?.timer) clearTimeout(p.timer);
    hub.pending.delete(id);
    return p;
  };

  const armTimer = (hub: HubConn, id: string, p: Pending) => {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (!hub.pending.has(id)) return;
      finish(hub, id);
      send(hub, { t: "cancel", id });
      json(p.res, 504, "The hub did not answer in time.");
    }, timeoutMs);
  };

  // ---------- client side: /h/<hubId>/<path>
  const onClientRequest = (req: IncomingMessage, res: ServerResponse) => {
    const target = normalisePath(req.url ?? "");
    const m = target && /^\/h\/([A-Za-z0-9_-]{1,64})(\/.*)$/.exec(target.pathname);
    if (!target || !m) return json(res, 404, "Not found.");
    const [, hubId, innerPath] = m;
    if (!allow.has(innerPath)) return json(res, 404, "Not found.");
    const hub = hubs.get(hubId);
    if (!hub || hub.ws.readyState !== WebSocket.OPEN) return json(res, 503, "That hub is not connected.");

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBody) { res.setHeader("connection", "close"); return json(res, 413, "Request body too large."); }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBody) {
        if (!aborted) {
          aborted = true;
          chunks.length = 0;
          res.setHeader("connection", "close");
          res.once("finish", () => req.destroy());
          json(res, 413, "Request body too large.");
        }
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => { aborted = true; });
    req.on("end", () => {
      if (aborted) return;
      if (hub.ws.readyState !== WebSocket.OPEN) return json(res, 503, "That hub is not connected.");
      const id = String(hub.nextId++);
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k) || k === "x-forwarded-for" || k === "x-agent-room-via") continue;
        headers[k] = v;
      }
      headers["x-forwarded-for"] = req.socket.remoteAddress ?? "unknown"; // overwritten, never appended: clients cannot spoof it
      const pending: Pending = { res, headSent: false, timer: undefined };
      hub.pending.set(id, pending);
      armTimer(hub, id, pending);
      // Client went away before the answer finished: tell the hub to stop.
      res.on("close", () => {
        if (!hub.pending.has(id)) return;
        finish(hub, id);
        send(hub, { t: "cancel", id });
      });
      const hasBody = !["GET", "HEAD"].includes(req.method ?? "GET");
      send(hub, { t: "req", id, method: req.method, path: innerPath + target.search, headers, body: hasBody ? Buffer.concat(chunks).toString("base64") : "" });
    });
  };

  // ---------- hub side: frames coming back
  const onHubFrame = (hub: HubConn, raw: RawData) => {
    let f: { t?: string; id?: string; status?: number; headers?: Record<string, string | string[]>; chunk?: string; message?: string };
    try { f = JSON.parse(raw.toString()); } catch { return; }
    if (!f || typeof f.id !== "string") return;
    const p = hub.pending.get(f.id);
    if (!p) return; // finished or cancelled already
    const { res } = p;
    switch (f.t) {
      case "head": {
        if (p.headSent || typeof f.status !== "number" || f.status < 200 || f.status > 599) return;
        const headers: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(f.headers ?? {})) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
        headers["x-content-type-options"] = "nosniff";
        p.headSent = true;
        res.writeHead(f.status, headers);
        res.flushHeaders();
        armTimer(hub, f.id, p);
        return;
      }
      case "data":
        if (!p.headSent || typeof f.chunk !== "string") return;
        res.write(Buffer.from(f.chunk, "base64"));
        armTimer(hub, f.id, p);
        return;
      case "end":
        finish(hub, f.id);
        if (!p.headSent) return json(res, 502, "The hub sent no response.");
        res.end();
        return;
      case "err":
        finish(hub, f.id);
        // The message is the hub's own text about a transport failure; never headers or bodies.
        json(res, 502, typeof f.message === "string" ? f.message.slice(0, 200) : "The hub failed to answer.");
        return;
    }
  };

  const dropHub = (hubId: string, hub: HubConn) => {
    if (hubs.get(hubId) === hub) hubs.delete(hubId);
    for (const id of [...hub.pending.keys()]) {
      const p = finish(hub, id);
      if (p) json(p.res, 502, "The hub disconnected.");
    }
  };

  // ---------- WebSocket upgrade with authentication
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  const reject = (socket: Duplex, status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  };
  const server = createServer(onClientRequest);
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path !== "/hub/connect") return reject(socket, 404, "Not Found");
    const hubId = String(req.headers["x-hub-id"] ?? "");
    const auth = String(req.headers.authorization ?? "");
    const secret = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!HUB_ID.test(hubId) || !secret || !checkSecret(hubId, secret)) return reject(socket, 401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => {
      const hub: HubConn = { ws, pending: new Map(), alive: true, nextId: 1 };
      const old = hubs.get(hubId);
      hubs.set(hubId, hub);
      if (old) { dropHub(hubId, old); old.ws.close(4000, "replaced by a newer connection"); }
      ws.on("pong", () => { hub.alive = true; });
      ws.on("message", (raw) => onHubFrame(hub, raw));
      ws.on("close", () => dropHub(hubId, hub));
      ws.on("error", () => ws.terminate());
    });
  });

  const pingTimer = setInterval(() => {
    for (const hub of hubs.values()) {
      if (!hub.alive) { hub.ws.terminate(); continue; }
      hub.alive = false;
      hub.ws.ping();
    }
  }, opts.pingIntervalMs ?? 25_000);
  pingTimer.unref();

  await new Promise<void>((resolve, reject2) => {
    server.once("error", reject2);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => { server.off("error", reject2); resolve(); });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    port,
    async close() {
      clearInterval(pingTimer);
      for (const [hubId, hub] of [...hubs]) { hub.ws.terminate(); dropHub(hubId, hub); }
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
