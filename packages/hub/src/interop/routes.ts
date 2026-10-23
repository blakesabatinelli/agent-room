// 4.6 Routes: GET /.well-known/agent-card.json, POST /a2a, and the owner's side (keys and the Funnel setting).
//
// Who can reach what (1.2 keeps /mcp as the only path through Funnel; this adds two, and only on the owner's say-so):
//  - The card is public discovery. It is served to anyone who can reach the hub (this Mac, the tailnet, a paired device) without a key.
//    Through Funnel it is served only while "A2A through Funnel" is on.
//  - POST /a2a needs an "a2a" key (mcp/tokens.ts, scope "a2a"), the same way on every route in. Through Funnel it is open only while the setting is on, and
//    callers that fail the key check are counted and locked out like /mcp callers (remote/guard.ts AuthLimiter).
//  - /a2a/keys and /a2a/settings need a paired device, and are never reachable through Funnel: the gate opens the two exact paths and nothing else.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { A2aSettings, A2aStatus, McpTokenInfo } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { McpTokens } from "../mcp/tokens.js";
import type { Tailscale } from "../remote/tailscale.js";
import { AuthLimiter, forwardedIp, isRemoteRequest, rpcSummary, stripControl } from "../remote/guard.js";
import { remoteHost } from "../remote/status.js";
import { A2A_FUNNEL_PATHS, A2A_PATH, CARD_PATH } from "./paths.js";
import { A2aService, RPC, RpcError, buildAgentCard, readVersion } from "./a2a.js";

/** The owner's "A2A through Funnel" switch. Off unless the owner turned it on. */
export const a2aFunnelOn = (store: Store): boolean => store.getKV<boolean>("a2a_funnel", false);

/** The agent id keys for outside A2A callers are filed under. It has a colon, so no real agent (ids are [a-z0-9-]) can share it. */
export const A2A_KEY_AGENT = "a2a:external";

export interface InteropDeps {
  store: Store;
  orch: Orchestrator;
  tokens: McpTokens;
  tailscale: Tailscale;
  limiter: AuthLimiter;
  /** The port the hub listens on. */
  port: () => number;
  service?: A2aService;
}

const bearer = (h?: string) => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);
const cleanHost = (h: string | undefined) => (h ?? "").replace(/[^A-Za-z0-9.:\-[\]]/g, "");

export function registerInteropRoutes(app: FastifyInstance, deps: InteropDeps) {
  const { store, orch, tokens, tailscale, limiter } = deps;
  const service = deps.service ?? new A2aService(store, orch);
  const version = readVersion();

  /** Where the A2A endpoint is reached, from where the caller came in: the public name for a proxied request, else the tailnet name, else the Host header. */
  const endpointFor = async (req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }): Promise<{ url: string; reach: A2aStatus["reach"] }> => {
    const st = await tailscale.status(false, deps.port());
    if (isRemoteRequest(req)) {
      const proto = String(req.headers["x-forwarded-proto"] ?? "https").split(",")[0].trim() === "http" ? "http" : "https";
      const host = cleanHost(String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim());
      return { url: `${proto}://${host}${A2A_PATH}`, reach: "funnel" };
    }
    const host = remoteHost(st);
    if (host) return { url: `http://${host.includes(":") ? `[${host}]` : host}:${deps.port()}${A2A_PATH}`, reach: "tailnet" };
    return { url: `http://${cleanHost(String(req.headers.host ?? `127.0.0.1:${deps.port()}`))}${A2A_PATH}`, reach: "local" };
  };

  app.get(CARD_PATH, async (req, reply) => {
    const { url } = await endpointFor(req);
    return reply.header("cache-control", "no-cache").header("x-content-type-options", "nosniff").type("application/json").send(buildAgentCard({ version, endpointUrl: url }));
  });

  const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
  const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

  app.post(A2A_PATH, async (req, reply) => {
    const remote = isRemoteRequest(req);
    const from = remote ? forwardedIp(req) : "";
    if (remote && limiter.blocked(from)) return reply.code(429).send({ error: "Too many failed attempts. Try again in a minute." });
    const t = bearer(req.headers.authorization);
    const hit = t ? tokens.lookup(t, "a2a") : undefined;
    if (!hit || hit.expired) {
      if (hit) store.audit("a2a", "a2a.key.expired", `${hit.record.id} was used after it expired${remote ? ` from ${from}` : ""}`);
      if (remote) {
        const lockedOut = limiter.fail(from);
        store.audit("remote", "a2a.remote.denied", `from ${from}`);
        if (lockedOut) store.audit("remote", "a2a.remote.locked_out", `from ${from}: too many failed attempts, locked out`);
      } else store.audit("a2a", "a2a.denied", "A2A call without a valid key");
      return reply.code(401).header("www-authenticate", 'Bearer realm="agent-room"').send(rpcError(null, -32000, "Send a valid Agent Room key as Authorization: Bearer <key>."));
    }
    const rec: McpTokenInfo = hit.record;
    tokens.touch(rec.id);

    const body = req.body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | unknown[] | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string")
      return reply.send(rpcError((body as { id?: unknown } | undefined)?.id, RPC.invalidRequest, "Send one JSON-RPC 2.0 request."));
    const ver = req.headers["a2a-version"];
    if (typeof ver === "string" && ver.trim() && !/^(1\.0|0\.3)(\.\d+)?$/.test(ver.trim()))
      return reply.send(rpcError(body.id, RPC.versionNotSupported, "This server speaks A2A 1.0 and 0.3.", { supported: ["1.0", "0.3"] }));
    if (remote) store.audit("a2a", "a2a.remote", `key=${rec.id} ${rpcSummary(body)} from ${from}`);
    try {
      const result = await service.call(rec, body.method, body.params);
      if (body.id === undefined) return reply.code(204).send(); // a notification: nothing to answer
      return reply.send(rpc(body.id, result));
    } catch (e) {
      if (e instanceof RpcError) return reply.send(rpcError(body.id, e.code, e.message, e.data));
      store.audit("a2a", "a2a.error", stripControl(String((e as Error)?.message ?? e)).slice(0, 200));
      return reply.send(rpcError(body.id, RPC.internal, "Internal error"));
    }
  });

  // ---------- the owner's side (paired devices only; the remote gate never opens these)
  const funnelPaths = async (on: boolean) => {
    const st = await tailscale.status(true, deps.port());
    if (!st.funnel.on) return { ok: true as const }; // Funnel itself is off: nothing to change in Tailscale. Turning Funnel on adds the paths (server.ts).
    return tailscale.setFunnelPaths(deps.port(), A2A_FUNNEL_PATHS, on);
  };
  const settings = (): A2aSettings => ({ funnel: a2aFunnelOn(store) });
  app.get("/a2a/settings", async () => settings());
  app.put("/a2a/settings", async (req, reply) => {
    const b = z.object({ funnel: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Send funnel: true or false." });
    const r = await funnelPaths(b.data.funnel);
    if (!r.ok && b.data.funnel) {
      store.audit("owner", "a2a.funnel.failed", r.error);
      return reply.code(409).send({ error: r.error });
    }
    store.setKV("a2a_funnel", b.data.funnel);
    store.audit("owner", b.data.funnel ? "a2a.funnel.on" : "a2a.funnel.off", b.data.funnel ? `${CARD_PATH} and ${A2A_PATH} open through Funnel` : "closed to Funnel");
    return { ...settings(), ...(!r.ok ? { warning: `Closed here, but Tailscale still serves the paths: ${r.error}` } : {}) };
  });
  app.get("/a2a/status", async (req): Promise<A2aStatus> => {
    const e = await endpointFor(req);
    const st = await tailscale.status(false, deps.port());
    const funnelUrl = a2aFunnelOn(store) && st.funnel.on && st.funnel.url ? new URL(st.funnel.url).origin : undefined;
    const url = funnelUrl ? `${funnelUrl}${A2A_PATH}` : e.url;
    return { settings: settings(), cardUrl: url.slice(0, -A2A_PATH.length) + CARD_PATH, endpointUrl: url, reach: funnelUrl ? "funnel" : e.reach };
  });

  const keyBody = z.object({ name: z.string().min(1).max(80), roomId: z.string().optional(), expiresInDays: z.number().min(0.01).max(3650).optional() });
  const a2aKeys = () => tokens.list().filter((k) => k.scope === "a2a");
  app.get("/a2a/keys", async () => a2aKeys());
  // The key is in this response and nowhere else (only its hash is stored). roomId pins it to one room.
  app.post("/a2a/keys", async (req, reply) => {
    const b = keyBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Send name (and optionally roomId or expiresInDays)." });
    if (b.data.roomId && !store.getRoom(b.data.roomId)) return reply.code(400).send({ error: "Room not found." });
    const made = tokens.create({ agentId: A2A_KEY_AGENT, name: b.data.name, roomId: b.data.roomId, scope: "a2a", expiresAt: b.data.expiresInDays ? Date.now() + Math.round(b.data.expiresInDays * 86_400_000) : undefined });
    const e = await endpointFor(req);
    return { ...made.info, token: made.token, url: e.url };
  });
  app.post("/a2a/keys/:id/rotate", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!a2aKeys().some((k) => k.id === id)) return reply.code(404).send({ error: "Key not found." });
    const r = tokens.rotate(id)!;
    return { ...r.info, token: r.token, url: (await endpointFor(req)).url };
  });
  app.delete("/a2a/keys/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!a2aKeys().some((k) => k.id === id)) return reply.code(404).send({ error: "Key not found." });
    tokens.revoke(id);
    return { ok: true };
  });
  return service;
}
