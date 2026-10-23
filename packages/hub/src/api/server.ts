import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { TOOLS, type AgentConfig, type GrantRefusal, type McpConnection, type RemoteStatus, type ServerEvent } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Approvals } from "../orchestrator/approvals.js";
import { adapters, inbox } from "../adapters/index.js";
import { handleMcp } from "../mcp/server.js";
import { isAllowedLocalAddress, pushNotify } from "../net.js";
import { signInLog } from "../setup.js";
import { pairingCode, token } from "../util.js";
import { listFiles } from "../orchestrator/workspace.js";
import { routingJsonl } from "../orchestrator/routing.js";
import { quotaFor } from "../quota/index.js";
import { runProc } from "../adapters/proc.js";
import { PathDenied, GrantRefused } from "../files/paths.js";
import { McpTokens } from "../mcp/tokens.js";
import type { McpGrant } from "../orchestrator/orchestrator.js";
import { defaultTailscale, type Tailscale } from "../remote/tailscale.js";
import { AuthLimiter, forwardedIp, isRemoteRequest, rpcSummary } from "../remote/guard.js";
import { composeRemote, remoteHost } from "../remote/status.js";
import { LOCAL_SECRET_HEADER, localSecretMatches, writeLocalSecret } from "../remote/localpair.js";
import { DiscoveryService } from "../discovery/service.js"; // 1.3
import { issueKey } from "../discovery/tokens.js"; // 1.3
import { buildInvite, presetAgent } from "../discovery/invite.js"; // 1.3
import { emptyCapabilities, cleanNeeds } from "../discovery/connectors.js"; // 1.3
import { platformBlock } from "../discovery/apply.js"; // 1.3
import { SignInManager } from "../install/signin.js";
import { registerInstallRoutes } from "../install/routes.js";
import { setupTimer } from "../install/timer.js";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerDeps {
  store: Store; orch: Orchestrator; approvals: Approvals; ownerName: string; restrictInterfaces?: boolean;
  /** 1.2: the Tailscale CLI wrapper (tests inject one pointed at a fake CLI). */
  tailscale?: Tailscale;
  /** 1.2: failed-auth allowance for proxied (Funnel) /mcp callers. Default 10 failures, one more every 6 s. */
  remoteAuth?: { burst?: number; refillMs?: number };
  /** 1.3: agent discovery. Defaults to one that looks at the real machine and joins Hermes to the hub on this port. */
  discovery?: DiscoveryService;
  /** 1.7: in-app CLI sign-in (tests inject one with scripted CLIs). */
  signin?: SignInManager;
}

export async function buildServer({ store, orch, approvals, ownerName, restrictInterfaces = true, tailscale = defaultTailscale(), remoteAuth, discovery: discoveryDep, signin }: ServerDeps) {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  // Accept POSTs that say "JSON" but carry no body (e.g. button actions with nothing to send).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString();
    if (!text.trim()) return done(null, {});
    try { done(null, JSON.parse(text)); } catch (e) { (e as Error & { statusCode?: number }).statusCode = 400; done(e as Error, undefined); }
  });
  await app.register(websocket);
  // 1.2: the first hook after the websocket plugin's own (which must run first: it marks the upgraded socket so the plugin closes it after the
  // reply). A proxied (Funnel) request that carries an Upgrade header of any kind is 404 here, whatever path it names and before any route,
  // websocket or otherwise, can act on it. Only a plain POST/GET /mcp is served to a remote caller.
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.upgrade !== undefined && isRemoteRequest(req)) return reply.code(404).send({ error: "Not found." });
  });

  let code = pairingCode();
  let codeIssued = Date.now();
  // 1.2: failed guesses are counted per source address and start again whenever the code changes (10 minutes, or after a successful pairing).
  const pairFailures = new Map<string, number>();
  const rotateCode = () => { code = pairingCode(); codeIssued = Date.now(); pairFailures.clear(); };
  const currentCode = () => { if (Date.now() - codeIssued > 10 * 60_000) rotateCode(); return code; };
  app.decorate("pairingCode", () => currentCode());
  // 1.2: the Mac app's proof that it is the Mac app (see remote/localpair.ts). New on every hub start, read from the data folder by the app.
  const localSecret = writeLocalSecret(orch.dataDir);
  let lastLocalDenied = 0;

  const authLimiter = new AuthLimiter(remoteAuth?.burst ?? 10, remoteAuth?.refillMs ?? 6000);

  const bearer = (h?: string) => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);
  // 1.1: external MCP keys are kept as SHA-256 hashes (legacy plaintext keys are migrated on start), may expire, and may be pinned to a room.
  const mcpTokens = new McpTokens(store);
  // 1.1: every route, so a test can prove none but /mcp answers a proxied (Funnel) request and none answers an unpaired one.
  const routeTable: { method: string; url: string }[] = [];
  app.addHook("onRoute", (r) => { for (const m of ([] as string[]).concat(r.method)) routeTable.push({ method: m, url: r.url }); });
  app.decorate("routeTable", () => routeTable);

  app.addHook("onRequest", async (req, reply) => {
    if (restrictInterfaces && !isAllowedLocalAddress(req.socket.localAddress)) return reply.code(403).send({ error: "Only reachable over localhost or Tailscale." });
    const path = req.url.split("?")[0];
    // 1.2: a request that came through Tailscale Funnel (or any proxy) reaches POST /mcp and its 405 GET, and nothing else.
    if (isRemoteRequest(req)) {
      if (path !== "/mcp" || (req.method !== "POST" && req.method !== "GET")) return reply.code(404).send({ error: "Not found." });
      return; // /mcp authenticates every call itself
    }
    if (path === "/health" || path === "/pair" || path === "/pair/local" || path === "/mcp") return;
    if (path === "/" || path.startsWith("/web/")) return; // the phone web app itself; everything it calls still needs a token
    const t = bearer(req.headers.authorization) ?? (path === "/ws" ? new URL(req.url, "http://x").searchParams.get("token") ?? undefined : undefined);
    if (!t || !store.hasDevice(t)) return reply.code(401).send({ error: "Pair this device first." });
  });

  app.get("/health", async () => ({ ok: true, name: "agent-room" }));

  // ---------- phone web app (open the Tailscale address in Safari, pair, Add to Home Screen)
  // A fixed list of files read once at startup; request paths never touch the filesystem.
  // src/api/server.ts when run from source, dist/hub.mjs when run from the prebuilt bundle.
  // 1.7: Hub/hub.mjs inside the app bundle keeps web/ next to it.
  const webDir = [new URL("../../web/", import.meta.url), new URL("../web/", import.meta.url), new URL("./web/", import.meta.url)]
    .find((u) => existsSync(fileURLToPath(new URL("index.html", u)))) ?? new URL("../../web/", import.meta.url);
  const webFiles = new Map<string, { type: string; body: Buffer }>();
  for (const [name, type] of [
    ["index.html", "text/html; charset=utf-8"], ["app.js", "text/javascript; charset=utf-8"], ["app.css", "text/css; charset=utf-8"],
    ["manifest.webmanifest", "application/manifest+json"], ["icon-180.png", "image/png"], ["icon-512.png", "image/png"],
    ["favicon-32.png", "image/png"],
    ["diff.js", "text/javascript; charset=utf-8"], // 1.1: reads the full diff of a file write
  ] as const) {
    try { webFiles.set(name, { type, body: readFileSync(new URL(name, webDir)) }); } catch { /* missing asset: that route 404s */ }
  }
  const sendWeb = (name: string, req: { headers: { host?: string } }, reply: import("fastify").FastifyReply) => {
    const f = webFiles.get(name);
    if (!f) return reply.code(404).send({ error: "Not found." });
    const host = (req.headers.host ?? "").replace(/[^A-Za-z0-9.:\-[\]]/g, "");
    return reply
      .header("content-type", f.type)
      .header("cache-control", name === "index.html" ? "no-cache" : "no-cache, max-age=0")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("x-frame-options", "DENY")
      .header("content-security-policy",
        `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://${host} wss://${host}; ` +
        "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'")
      .send(f.body);
  };
  app.get("/", async (req, reply) => sendWeb("index.html", req, reply));
  app.get("/web/:file", async (req, reply) => sendWeb((req.params as { file: string }).file, req, reply));

  app.post("/pair", async (req, reply) => {
    const b = z.object({ code: z.string(), deviceName: z.string().min(1).max(80) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Send code and deviceName." });
    const current = currentCode(); // may rotate the code, which also clears the failure counts
    const from = req.socket.remoteAddress ?? "unknown";
    if ((pairFailures.get(from) ?? 0) >= 10) return reply.code(429).send({ error: "Too many wrong codes from this device. Wait for the code to change, then try again." });
    if (b.data.code !== current) {
      if (pairFailures.size >= 1000 && !pairFailures.has(from)) pairFailures.clear(); // bounded memory; a flood of addresses just starts the count over
      pairFailures.set(from, (pairFailures.get(from) ?? 0) + 1);
      return reply.code(403).send({ error: "That pairing code is wrong or expired." });
    }
    const t = token();
    store.addDevice(t, b.data.deviceName);
    rotateCode(); // one-time
    store.audit("owner", "device.paired", b.data.deviceName);
    return { token: t, ownerName };
  });

  /**
   * Zero-step pairing for the Mac app itself. Only answers a native client on this Mac:
   * loopback connection, a localhost Host header (blocks DNS rebinding), no Origin
   * header (browsers always send one on POST, so web pages can't use this) and, above all,
   * the secret the hub wrote to <data dir>/local-pair.secret (x-agent-room-local-secret).
   * The first three are cheap filters. They prove nothing against a local TCP forwarder
   * (`tailscale funnel --tls-terminated-tcp`, `ssh -L`, `socat`), which the hub sees as 127.0.0.1; the secret does.
   */
  // 1.2: a proxied request (Tailscale Funnel/serve) arrives from 127.0.0.1 too; it is never "the app on this Mac".
  const isLoopback = (req: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }) =>
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") && !isRemoteRequest(req);
  app.post("/pair/local", async (req, reply) => {
    const host = (req.headers.host ?? "").split(":")[0];
    if (!isLoopback(req) || !["127.0.0.1", "localhost"].includes(host) || req.headers.origin)
      return reply.code(403).send({ error: "Local pairing only works from the app on this Mac." });
    if (!localSecretMatches(localSecret, req.headers[LOCAL_SECRET_HEADER])) {
      // Audited, but at most once a minute: a flood of guesses must not flood the log.
      if (Date.now() - lastLocalDenied > 60_000) { lastLocalDenied = Date.now(); store.audit("hub", "device.pair_local.denied", "Local pairing refused: missing or wrong local secret"); }
      return reply.code(403).send({ error: "Local pairing only works from the app on this Mac." });
    }
    const t = token();
    store.addDevice(t, (req.body as { deviceName?: string } | undefined)?.deviceName ?? "This Mac");
    store.audit("owner", "device.paired", "This Mac (local)");
    return { token: t, ownerName };
  });

  // ---------- onboarding
  app.get("/setup", async () => {
    const agents = store.listAgents();
    const status = await Promise.all(agents.map(async (a) => ({ id: a.id, name: a.name, enabled: a.enabled, color: a.color, adapter: a.adapter, ...(await adapters[a.adapter].status(a)) })));
    for (const a of agents) orch.forgetStatus(a.id);
    const host = remoteHost(await tailscale.status(false, port()));
    const timer = setupTimer(store);
    return {
      agents: status,
      practiceMode: store.getKV("practice_mode", false),
      onboarded: store.getKV("onboarded", false),
      // 1.7: the setup timer (first launch to first finished goal)
      timer, elapsedSeconds: timer.elapsedSeconds ?? null,
      phone: { url: host ? `http://${host}:${(app.server.address() as { port: number } | null)?.port ?? 4747}` : null, code: currentCode() },
    };
  });
  app.put("/setup", async (req) => {
    const b = z.object({ practiceMode: z.boolean().optional(), onboarded: z.boolean().optional() }).parse(req.body);
    if (b.practiceMode !== undefined) store.setKV("practice_mode", b.practiceMode);
    if (b.onboarded !== undefined) store.setKV("onboarded", b.onboarded);
    return { ok: true };
  });
  // 1.7: in-app sign-in (POST/GET /setup/signin/:agent, .../code, .../cancel) and the setup timer hook
  registerInstallRoutes(app, {
    store, orch, isLoopback,
    signin: signin ?? new SignInManager({ logDir: join(homedir(), ".agent-room"), audit: (a, d) => store.audit("owner", a, d), onDone: (a) => orch.forgetStatus(a.id) }),
  });

  app.get("/setup/signin/:agent/log", async (req, reply) => {
    const a = store.getAgent((req.params as { agent: string }).agent);
    if (!a) return reply.code(404).send({ error: "Agent not found." });
    return { log: signInLog(a.adapter) };
  });

  // ---------- 1.2 remote access over Tailscale (paired devices only; a proxied/Funnel request never gets here)
  const funnelIntent = () => store.getKV<boolean>("remote_funnel", false);
  // Every status read runs the checks below (drift, extra paths, a /mcp handler aimed elsewhere, raw TCP forwards to the hub). Each problem is
  // audited once per change, so a later read of the same problem is silent and a new or returning one is recorded.
  let lastDrift = "";
  const noteRemote = (r: RemoteStatus) => {
    const f = r.funnel;
    const forwards = r.warnings.length ? `forward:${r.warnings.join("|")}` : "";
    const now = [f.drift ?? "", f.wrongTarget ?? "", ...f.extraPaths, forwards].join(",");
    if (now && now !== lastDrift) {
      if (f.drift === "wrong_target") store.audit("hub", "remote.funnel.drift", `Funnel serves /mcp from Tailscale but it points at ${f.wrongTarget}, not this hub (wrong_target)`);
      else if (f.drift) store.audit("hub", "remote.funnel.drift", f.drift === "on_in_tailscale" ? "Funnel is on in Tailscale but off in Agent Room" : "Funnel is off in Tailscale but on in Agent Room");
      if (f.extraPaths.length) store.audit("hub", "remote.funnel.extra_paths", `Funnel also exposes: ${f.extraPaths.join(", ")}`);
      for (const w of r.warnings) store.audit("hub", "remote.tcp_forward", w);
    }
    lastDrift = now;
  };
  const remoteNow = async (fresh = false) => {
    const r = composeRemote(await tailscale.status(fresh, port()), funnelIntent(), port());
    try { noteRemote(r); } catch { /* the audit log never breaks a status read */ }
    return r;
  };
  app.get("/remote/status", async (req) => remoteNow((req.query as { fresh?: string }).fresh === "1"));
  // Funnel is the owner's call: { on: true } exposes /mcp at a public https address; { on: false } removes it.
  app.post("/remote/funnel", async (req, reply) => {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Send on: true or false." });
    const r = b.data.on ? await tailscale.enableFunnel(port()) : await tailscale.disableFunnel(port());
    if (!b.data.on) store.setKV("remote_funnel", false); // the owner asked for off; if Tailscale still has it on, that shows up as drift
    if (!r.ok) {
      store.audit("owner", "remote.funnel.failed", `${b.data.on ? "on" : "off"}: ${r.error}`);
      if (r.status) { try { noteRemote(composeRemote(r.status, funnelIntent(), port())); } catch { /* audit only */ } } // what Tailscale shows after the failed switch
      return reply.code(409).send({ error: r.error, approvalUrl: r.approvalUrl });
    }
    if (b.data.on) store.setKV("remote_funnel", true);
    store.audit("owner", b.data.on ? "remote.funnel.on" : "remote.funnel.off", r.status.funnel.url ?? "/mcp");
    return remoteNow(true);
  });
  // Opens the Tailscale app on this Mac so the owner can sign in. Only the Mac app may ask.
  app.post("/remote/open", async (req, reply) => {
    if (!isLoopback(req)) return reply.code(403).send({ error: "Open Tailscale from the Mac app." });
    return tailscale.openApp();
  });
  // Start-up check (main.ts calls it): the hub reports when Tailscale and the owner's setting disagree, and never changes either.
  app.decorate("remoteCheck", async () => {
    try { return await remoteNow(true); } catch { return undefined; }
  });

  // ---------- MCP (agents + external MCP apps)
  app.post("/mcp", async (req, reply) => {
    // 1.2: callers that came through Funnel get a failed-auth limit (checked first, so guessing gains nothing) and every call is audited.
    const remote = isRemoteRequest(req);
    const from = remote ? forwardedIp(req) : "";
    if (remote && authLimiter.blocked(from)) return reply.code(429).send({ error: "Too many failed attempts. Try again in a minute." });
    const t = bearer(req.headers.authorization);
    // 1.2: the orchestrator's short-lived task grants are for agents the hub itself started on this Mac. A proxied caller never gets one, even
    // if it somehow holds one: it can only use an external MCP key (below), which the owner made on purpose and can revoke.
    let grant: McpGrant | undefined = t && !remote ? orch.grants.get(t) : undefined;
    if (!grant && t) {
      const hit = mcpTokens.lookup(t); // by hash
      if (hit && !hit.expired) { grant = { agentId: hit.record.agentId, roomId: hit.record.roomId, locked: !!hit.record.roomId, tokenId: hit.record.id }; mcpTokens.touch(hit.record.id); }
      else if (hit) store.audit(hit.record.agentId, "mcp.token.expired", `${hit.record.id} was used after it expired${remote ? ` from ${from}` : ""}`);
    }
    if (!grant || (grant.expiresAt && grant.expiresAt < Date.now())) {
      if (remote) {
        const lockedOut = authLimiter.fail(from);
        store.audit("remote", "mcp.remote.denied", `from ${from}`);
        // Once per lockout, at the failure that causes it. Never carries the token. Calls refused while locked out are not audited.
        if (lockedOut) store.audit("remote", "mcp.remote.locked_out", `from ${from}: too many failed attempts, locked out`);
      }
      return reply.code(401).send({ error: "Invalid MCP token." });
    }
    if (remote) store.audit(grant.agentId, "mcp.remote", `agent=${grant.agentId}${grant.tokenId ? ` key=${grant.tokenId}` : ""} ${rpcSummary(req.body)} from ${from}`);
    reply.hijack();
    await handleMcp(store, orch, grant, req.raw, reply.raw, req.body);
  });
  app.get("/mcp", async (_req, reply) => reply.code(405).send({ error: "Use POST (stateless Streamable HTTP)." }));

  // 1.1: external MCP keys. The key is in the response that makes or rotates it and nowhere else (only its hash is stored).
  // Body: { agentId, name, roomId?, expiresAt? (ms) | expiresInDays? }. roomId pins the key to a room, so room-scoped folder grants reach it.
  const tokenBody = z.object({
    agentId: z.string().min(1).max(80), name: z.string().min(1).max(80), roomId: z.string().optional(),
    expiresAt: z.number().int().positive().optional(), expiresInDays: z.number().min(0.01).max(3650).optional(),
  });
  const expiryOf = (b: { expiresAt?: number; expiresInDays?: number }) => b.expiresAt ?? (b.expiresInDays ? Date.now() + Math.round(b.expiresInDays * 86_400_000) : undefined);
  app.post("/mcp-tokens", async (req, reply) => {
    const parsed = tokenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Send agentId and name (and optionally roomId, expiresAt or expiresInDays)." });
    const b = parsed.data;
    if (b.roomId && !store.getRoom(b.roomId)) return reply.code(400).send({ error: "Room not found." });
    const expiresAt = expiryOf(b);
    if (expiresAt && expiresAt <= Date.now()) return reply.code(400).send({ error: "The expiry must be in the future." });
    if (!store.getAgent(b.agentId)) {
      store.saveAgent({ id: b.agentId, name: b.name, provider: "mcp", adapter: "mcp", enabled: true, color: "#5A6B7D", settings: {}, tools: { web: false, filesystem: false, shell: false, gmail: false, slack: false, drive: false, salesforce: false } });
    }
    const made = mcpTokens.create({ agentId: b.agentId, name: b.name, roomId: b.roomId, expiresAt });
    return { ...made.info, token: made.token, url: "/mcp" };
  });
  app.get("/mcp-tokens", async () => mcpTokens.list());
  app.post("/mcp-tokens/:id/rotate", async (req, reply) => {
    const b = z.object({ expiresAt: z.number().int().positive().nullable().optional(), expiresInDays: z.number().min(0.01).max(3650).optional() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "Send expiresAt (ms) or expiresInDays, or nothing." });
    const expiresAt = b.data.expiresAt === null ? null : expiryOf({ expiresAt: b.data.expiresAt, expiresInDays: b.data.expiresInDays });
    if (expiresAt && expiresAt <= Date.now()) return reply.code(400).send({ error: "The expiry must be in the future." });
    const r = mcpTokens.rotate((req.params as { id: string }).id, expiresAt === undefined ? {} : { expiresAt });
    if (!r) return reply.code(404).send({ error: "Key not found." });
    return { ...r.info, token: r.token, url: "/mcp" };
  });
  app.delete("/mcp-tokens/:id", async (req, reply) => {
    if (!mcpTokens.revoke((req.params as { id: string }).id)) return reply.code(404).send({ error: "Key not found." });
    return { ok: true };
  });

  // ---------- rooms & chat
  app.get("/rooms", async () => store.listRooms());
  app.post("/rooms", async (req) => {
    const b = z.object({ name: z.string().min(1).max(80), topic: z.string().max(250).optional() }).parse(req.body);
    const name = b.name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "") || "room";
    store.audit("owner", "room.created", name);
    return store.createRoom(name, { topic: b.topic });
  });
  app.post("/rooms/dm/:agentId", async (req, reply) => {
    const a = store.getAgent((req.params as { agentId: string }).agentId);
    if (!a) return reply.code(404).send({ error: "Agent not found." });
    return store.dmRoom(a.id, a.name);
  });
  app.put("/rooms/:id", async (req, reply) => {
    const r = store.getRoom((req.params as { id: string }).id);
    if (!r) return reply.code(404).send({ error: "Room not found." });
    const b = z.object({ name: z.string().min(1).max(80).optional(), topic: z.string().max(250).optional() }).parse(req.body);
    const next = { ...r, ...b }; store.saveRoom(next); return next;
  });
  app.delete("/rooms/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const channels = store.listRooms().filter((r) => !r.dmAgentId);
    const r = store.getRoom(id);
    if (!r) return reply.code(404).send({ error: "Room not found." });
    if (!r.dmAgentId && channels.length <= 1) return reply.code(400).send({ error: "Keep at least one channel." });
    orch.stopRoom(id); store.deleteRoom(id); store.audit("owner", "room.deleted", r.name);
    store.emit("event", { type: "room_deleted", roomId: id });
    return { ok: true };
  });
  // Where the owner has read up to in each room. Shared by every paired device.
  const readMarks = () => store.getKV<Record<string, number>>("read_marks", {});
  app.get("/rooms/read", async () => readMarks());
  app.get("/rooms/:id/read", async (req) => ({ at: readMarks()[(req.params as { id: string }).id] ?? 0 }));
  app.put("/rooms/:id/read", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getRoom(id)) return reply.code(404).send({ error: "Room not found." });
    const { at } = z.object({ at: z.number().int().nonnegative() }).parse(req.body);
    const marks = readMarks();
    if (at > (marks[id] ?? 0)) { // only ever moves forward
      marks[id] = Math.min(at, Date.now() + 60_000); store.setKV("read_marks", marks);
      store.emit("event", { type: "read", roomId: id, at: marks[id] } satisfies ServerEvent);
    }
    return { at: marks[id] ?? 0 };
  });
  app.get("/rooms/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { since?: string; limit?: string };
    return store.listMessages(id, Number(q.limit ?? 200), Number(q.since ?? 0));
  });
  app.post("/rooms/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getRoom(id)) return reply.code(404).send({ error: "Room not found." });
    const { text, folderGrantId } = z.object({ text: z.string().min(1).max(20000), folderGrantId: z.string().max(80).optional() }).parse(req.body);
    // 1.1: a goal on a granted folder. A grant that can't carry a goal is refused up front, never silently dropped.
    if (folderGrantId) {
      const u = orch.goalSources.usable(folderGrantId, id);
      if (!u.ok) return reply.code(400).send({ error: u.reason });
    }
    await orch.handleOwnerMessage(id, text, ownerName, { folderGrantId });
    return { ok: true };
  });
  // 1.1: point a goal that hasn't started work at a granted folder ({ grantId }), or clear it ({ grantId: null }).
  app.post("/goals/:id/folder-grant", async (req, reply) => {
    const b = z.object({ grantId: z.string().max(80).nullable() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Send grantId (or null to clear it)." });
    const r = orch.setGoalFolder((req.params as { id: string }).id, b.data.grantId);
    if (!r.ok) return reply.code(r.reason === "No such goal." ? 404 : 409).send({ error: r.reason });
    return r.goal;
  });
  app.post("/rooms/:id/pause", async (req) => { const { id } = req.params as { id: string }; orch.setPaused(id, z.object({ paused: z.boolean() }).parse(req.body).paused); return { ok: true }; });
  app.post("/rooms/:id/stop", async (req) => { orch.stopRoom((req.params as { id: string }).id); return { ok: true }; });
  app.get("/rooms/:id/goals", async (req) => store.listGoals((req.params as { id: string }).id));
  app.get("/rooms/:id/tasks", async (req) => store.listTasks({ roomId: (req.params as { id: string }).id }));
  // Plan approval: { decision: "approve" | "revise" | "cancel", text? }
  app.post("/goals/:id/plan", async (req, reply) => {
    const b = z.object({ decision: z.enum(["approve", "revise", "cancel"]), text: z.string().max(4000).optional() }).parse(req.body);
    if (b.decision === "revise" && !b.text?.trim()) return reply.code(400).send({ error: "Say what to change." });
    const r = orch.decidePlan((req.params as { id: string }).id, b.decision, b.text ?? "");
    if (!r.ok) return reply.code(409).send({ error: r.why });
    store.audit("owner", `plan.${b.decision}`, (req.params as { id: string }).id);
    return r;
  });
  // The goal's shared folder: what the agents have produced.
  // 1.1 audit: this, /goals/:id/reveal and /documents show the hub's own goal folders and library, behind a paired device. The onRequest hook
  // answers a proxied (Funnel/serve) request 404 before it gets here, so nothing that reads files is reachable except through /mcp.
  app.get("/goals/:id/files", async (req, reply) => {
    const g = store.getGoal((req.params as { id: string }).id);
    if (!g) return reply.code(404).send({ error: "Goal not found." });
    return { folder: g.folder ?? null, files: g.folder ? listFiles(g.folder) : [] };
  });
  // Show the folder in Finder (the hub runs on the owner's Mac).
  app.post("/goals/:id/reveal", async (req, reply) => {
    const g = store.getGoal((req.params as { id: string }).id);
    if (!g?.folder) return reply.code(404).send({ error: "This goal has no folder yet." });
    await runProc("/usr/bin/open", [g.folder], { timeoutMs: 5000 });
    return { ok: true };
  });
  // The Library index: documents agents saved with save_document.
  app.get("/documents", async (req) => {
    const q = req.query as { roomId?: string; goalId?: string };
    return orch.library.list({ roomId: q.roomId || undefined, goalId: q.goalId || undefined });
  });
  app.post("/tasks/:id/rate", async (req) => { orch.rateJudgment((req.params as { id: string }).id, z.object({ score: z.number().min(0).max(1) }).parse(req.body).score); return { ok: true }; });

  // ---------- agents & permissions
  const agentSchema = z.object({
    id: z.string().regex(/^[a-z0-9-]+$/), name: z.string(), provider: z.string(),
    adapter: z.enum(["claude-code", "codex", "mcp", "command", "openai-api", "mock"]), enabled: z.boolean(),
    color: z.string(), settings: z.record(z.unknown()), tools: z.record(z.boolean()), canBeOrchestrator: z.boolean().optional(),
    profiles: z.array(z.object({
      id: z.string().regex(/^[a-z0-9-]+$/).max(40), label: z.string().min(1).max(60),
      role: z.enum(["explorer", "researcher", "worker", "reviewer"]),
      model: z.string().max(100).optional(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    })).max(8).optional(),
    autoApprove: z.record(z.boolean()).optional(),
  });
  app.get("/agents", async () => store.listAgents());
  app.get("/tools", async () => TOOLS);
  app.post("/agents", async (req) => { const a = agentSchema.parse(req.body) as AgentConfig; store.saveAgent(a); store.audit("owner", "agent.saved", a.id); return a; });
  app.put("/agents/:id", async (req, reply) => {
    const cur = store.getAgent((req.params as { id: string }).id);
    if (!cur) return reply.code(404).send({ error: "Agent not found." });
    const next = { ...cur, ...(agentSchema.partial().parse(req.body) as Partial<AgentConfig>), id: cur.id };
    store.saveAgent(next); orch.forgetStatus(next.id); store.audit("owner", "agent.updated", next.id); return next;
  });
  app.put("/agents/:id/tools", async (req, reply) => {
    const cur = store.getAgent((req.params as { id: string }).id);
    if (!cur) return reply.code(404).send({ error: "Agent not found." });
    cur.tools = { ...cur.tools, ...z.record(z.boolean()).parse(req.body) };
    store.saveAgent(cur); store.audit("owner", "agent.tools", `${cur.id}: ${JSON.stringify(cur.tools)}`); return cur;
  })
  // "Run without asking" for a sensitive tool, per agent: { shell: true }
  app.put("/agents/:id/auto-approve", async (req, reply) => {
    const cur = store.getAgent((req.params as { id: string }).id);
    if (!cur) return reply.code(404).send({ error: "Agent not found." });
    const sensitive = new Set(TOOLS.filter((t) => t.sensitive).map((t) => t.id));
    const body = z.record(z.boolean()).parse(req.body);
    const bad = Object.keys(body).filter((k) => !sensitive.has(k));
    if (bad.length) return reply.code(400).send({ error: `Only tools that normally ask first can be set to run without asking (not ${bad.join(", ")}).` });
    const next = { ...cur, autoApprove: { ...(cur.autoApprove ?? {}), ...body } };
    store.saveAgent(next);
    for (const [k, v] of Object.entries(body)) store.audit("owner", v ? "auto_approve.on" : "auto_approve.off", `${cur.id}: ${k}`);
    return next;
  });;
  app.delete("/agents/:id", async (req) => {
    const agentId = (req.params as { id: string }).id;
    mcpTokens.revokeAgent(agentId); store.deleteAgent(agentId); orch.forgetStatus(agentId);
    store.audit("owner", "agent.deleted", agentId);
    store.emit("event", { type: "agent_status", status: { id: agentId, ready: false, state: "offline", detail: "deleted", checkedAt: Date.now() } });
    return { ok: true };
  });
  app.get("/agents/status", async (req) => {
    const fresh = (req.query as { fresh?: string }).fresh === "1";
    return Promise.all(store.listAgents().map((a) => orch.agentStatus(a, fresh)));
  });
  app.get("/agents/:id/status", async (req, reply) => {
    const a = store.getAgent((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: "Agent not found." });
    return orch.agentStatus(a, true);
  });

  // ---------- connecting agents that join over MCP (Hermes, Muse, any MCP client)
  const port = () => (app.server.address() as { port: number } | null)?.port ?? 4747;
  app.get("/agents/:id/mcp-connection", async (req, reply) => {
    const a = store.getAgent((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: "Agent not found." });
    return { exists: mcpTokens.forAgent(a.id).length > 0, connected: inbox.connected(a.id), lastSeen: inbox.lastSeenAt(a.id) ?? null };
  });
  /** The agent's connection key (the unscoped one the Connect screen manages). Room-scoped keys made through /mcp-tokens are separate. */
  const connectionKey = (agentId: string) => mcpTokens.forAgent(agentId).filter((k) => !k.roomId).sort((x, y) => y.createdAt - x.createdAt)[0];
  /** Builds the config snippets and start message for a key. Same key in, same text out. */
  const connectionFor = async (a: AgentConfig, shown: string | undefined): Promise<McpConnection> => {
    // 1.1: only a hash of the key is stored, so after a hub restart the key can't be shown again. The snippets keep a placeholder; rotating makes a key that can be shown.
    const t = shown ?? "YOUR_KEY";
    const st = await tailscale.status(false, port());
    const host = remoteHost(st); // MagicDNS name first, then the tailnet IP
    const ip = process.env.AGENT_ROOM_TAILSCALE_IP ?? (st.state === "running" ? st.ip : undefined);
    const localUrl = `http://127.0.0.1:${port()}/mcp`;
    const tailscaleUrl = host ? `http://${host}:${port()}/mcp` : undefined;
    const tailscaleIpUrl = ip && ip !== host ? `http://${ip}:${port()}/mcp` : undefined;
    const funnelUrl = st.funnel.on ? st.funnel.url : undefined;
    const yaml = (url: string) => [
      "mcp_servers:",
      "  agent-room:",
      `    url: "${url}"`,
      "    headers:",
      `      Authorization: "Bearer ${t}"`,
      "    timeout: 120",
    ].join("\n");
    const json = (url: string) => JSON.stringify({ mcpServers: { "agent-room": { type: "http", url, headers: { Authorization: `Bearer ${t}` } } } }, null, 2);
    const snippets: NonNullable<McpConnection["snippets"]> = [
      { id: "hermes", label: "Hermes Agent", where: "Add to ~/.hermes/config.yaml, then restart Hermes.", text: yaml(localUrl) },
      { id: "json", label: "Claude Desktop, Cursor and most MCP apps", where: "Add to the app's MCP servers JSON.", text: json(localUrl) },
      ...(tailscaleUrl ? [{ id: "remote", label: "From another computer (Tailscale)", where: "Use when the agent runs on a different machine on your tailnet.", text: yaml(tailscaleUrl) }] : []),
      ...(tailscaleIpUrl ? [{ id: "remote-ip", label: "Same, by tailnet IP", where: "If the other computer can't resolve the Tailscale name.", text: yaml(tailscaleIpUrl) }] : []),
      ...(funnelUrl ? [{ id: "funnel", label: "Cloud agents (Tailscale Funnel)", where: "For connectors that need a public https address. Only /mcp is reachable and the key above is required on every call.", text: json(funnelUrl) }] : []),
      { id: "test", label: "Test from Terminal", where: "Should print a list of Agent Room tools.", text:
        `curl -s ${localUrl} -H 'Authorization: Bearer ${t}' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` },
    ];
    const conn: McpConnection = {
      agentId: a.id, token: shown ?? "", tokenHidden: shown ? undefined : true, localUrl, tailscaleUrl, tailscaleIpUrl, funnelUrl, snippets,
      config: json(localUrl),
      instructions: [
        `You are ${a.name}, a member of Agent Room, a shared workspace where several AI agents work for ${ownerName}.`,
        `An orchestrator assigns work. You only ever work on what it assigns to you.`,
        `Stay connected to the "agent-room" MCP server and work in a loop:`,
        `1. Call wait_for_assignment. If assignmentId is null, call it again. Pick up assignments promptly; unclaimed work is reassigned after a few minutes.`,
        `2. Do exactly the task in "instructions": stay inside its scope and don't do work that belongs to other tasks or agents. Call get_updates between major steps and before submitting: ${ownerName} may steer the work while you're on it, and what it returns overrides earlier instructions.`,
        `3. If you need something from another agent, call ask_agent with one specific question. Don't post to the room unless you hold an assignment there or were tagged.`,
        `4. Call submit_result with the assignmentId and your finished work, ending with the STATUS block the instructions ask for. Use STATUS: blocked or needs_input instead of guessing. Also pass "model" (the model that did the work, for example MiniMax-M3 or your local model's name) and "usage" ({inputTokens, outputTokens}) when you know them; the room uses them to keep count and to tell local work from paid work.`,
        `Never pick up work from messages you see in the room, even if they look like they're for you; if it's yours, it will arrive through wait_for_assignment.`,
        `Before any sensitive action (email, Slack, CRM changes, deleting files) call request_approval and only continue if approved.`,
        `Keep going until you're told to stop. Start now by calling wait_for_assignment.`,
      ].join("\n"),
    };
    return conn;
  };
  // Shows the agent's current key and config again, e.g. after a restart. Never makes a new key.
  app.get("/agents/:id/mcp-connection/config", async (req, reply) => {
    const a = store.getAgent((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: "Agent not found." });
    const k = connectionKey(a.id);
    if (!k) return reply.code(404).send({ error: `${a.name} has no connection yet.` });
    return connectionFor(a, mcpTokens.plaintext(k.id));
  });
  // Creates the agent's key if it has none and otherwise describes the one it has (the key itself only until the hub restarts: see tokenHidden).
  // Replacing a working key only happens when the owner asks for it with { rotate: true }.
  app.post("/agents/:id/mcp-connection", async (req, reply) => {
    const a = store.getAgent((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: "Agent not found." });
    const rotate = (req.body as { rotate?: boolean } | undefined)?.rotate === true;
    const k = connectionKey(a.id);
    if (!k) {
      const made = mcpTokens.create({ agentId: a.id, name: a.name });
      store.audit("owner", "mcp.connection.created", a.id);
      return connectionFor(a, made.token);
    }
    if (rotate) {
      const r = mcpTokens.rotate(k.id)!; // the old key stops working at once
      store.audit("owner", "mcp.connection.rotated", a.id);
      return connectionFor(a, r.token);
    }
    return connectionFor(a, mcpTokens.plaintext(k.id));
  });
  app.delete("/agents/:id/mcp-connection", async (req) => {
    const agentId = (req.params as { id: string }).id;
    mcpTokens.revokeAgent(agentId); orch.forgetStatus(agentId); store.audit("owner", "mcp.connection.revoked", agentId);
    return { ok: true };
  });

  // ---------- 1.3 agent discovery, Muse's pairing step, declared data sources
  const discovery = discoveryDep ?? new DiscoveryService(store, { control: () => orch.control, mcpUrl: () => `http://127.0.0.1:${port()}/mcp`, tokens: mcpTokens });
  app.decorate("discovery", discovery);
  app.get("/discovery", async () => discovery.state());
  app.post("/discovery/run", async () => { await discovery.run(); return discovery.state(); });
  app.put("/discovery/settings", async (req, reply) => {
    const b = z.object({ connectAutomatically: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Send connectAutomatically: true or false." });
    discovery.saveSettings(b.data);
    return discovery.state();
  });
  // The owner's own button: connects Hermes whatever "Connect automatically" says. Returns what changed and the snippet to paste if it couldn't.
  app.post("/discovery/hermes/connect", async (_req, reply) => {
    if (!store.getAgent("hermes")) return reply.code(404).send({ error: "There is no Hermes agent yet." });
    return discovery.connectHermes("owner");
  });
  // One call is the whole pairing step for an agent on another tailnet device: its tailnet address and its key.
  app.post("/agents/:id/invite", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    let a = store.getAgent(id);
    if (!a) {
      a = presetAgent(id);
      if (!a) return reply.code(404).send({ error: "Agent not found." });
      store.saveAgent(a); store.audit("owner", "agent.saved", a.id);
    }
    const host = remoteHost(await tailscale.status(false, port()));
    if (!host) return reply.code(409).send({ error: `${a.name} joins from another device over Tailscale, and Tailscale isn't connected on this Mac yet. Connect it under Remote access, then ask again.` });
    // Keys are stored as hashes (1.1): the first invite makes the key and shows it once. A second one says so and leaves the key
    // alone, because a new key would cut off an agent that is already connected. { rotate: true } is the owner's "make a new key".
    const rotate = (req.body as { rotate?: boolean } | undefined)?.rotate === true;
    const k = issueKey(mcpTokens, a, { rotate, actor: "owner" });
    const conn = await connectionFor(a, k.token);
    store.audit("owner", "agent.invite", a.id);
    return buildInvite(a, conn, conn.tailscaleUrl ?? `http://${host}:${port()}/mcp`);
  });
  // Data sources the owner says an agent has (for an agent discovery can't look inside, like Muse). Discovery never overwrites these.
  app.put("/agents/:id/capabilities", async (req, reply) => {
    const cur = store.getAgent((req.params as { id: string }).id);
    if (!cur) return reply.code(404).send({ error: "Agent not found." });
    const b = z.object({ declared: z.array(z.string().max(60)).max(20) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Send declared: a list of data sources, like [\"salesforce\"]." });
    const capabilities = { ...(cur.capabilities ?? emptyCapabilities()), declared: cleanNeeds(b.data.declared) };
    const next = { ...cur, capabilities };
    store.saveAgent(next);
    store.audit("owner", "agent.capabilities", `${cur.id}: declared ${capabilities.declared.join(", ") || "none"}`);
    await orch.control?.setPlatform(cur.id, platformBlock(capabilities)).catch(() => undefined);
    return store.getAgent(cur.id);
  });
  app.get("/scores", async () => store.listScores());
  // 0.2 routing decision log (+ 0.5 failure tags on each record)
  const routingQuery = z.object({ goalId: z.string().optional(), since: z.coerce.number().optional(), limit: z.coerce.number().int().min(1).max(100_000).optional() });
  app.get("/routing", async (req) => store.listRouting(routingQuery.parse(req.query ?? {})));
  app.get("/routing/export.jsonl", async (req, reply) => {
    const rows = store.listRouting(routingQuery.parse(req.query ?? {}));
    store.audit("owner", "routing.exported", `${rows.length} records`);
    return reply
      .header("content-type", "application/x-ndjson; charset=utf-8")
      .header("content-disposition", `attachment; filename="agent-room-routing-${new Date().toISOString().slice(0, 10)}.jsonl"`)
      .send(routingJsonl(rows));
  });
  // 1.5: `capacity` holds the owner's overrides; `capacityProfile` is what was detected and what is running now.
  app.get("/settings", async () => ({ ...store.getSettings(), calibration: store.getKV("judge_calibration", { n: 0, absErr: 0 }), capacityProfile: orch.governor.snapshot() }));
  app.get("/capacity", async () => orch.governor.snapshot());
  app.put("/settings", async (req) => {
    const s = z.object({
      orchestratorAgentId: z.string(), judgeRotation: z.array(z.string()),
      explorationRate: z.number().min(0).max(1), maxAttempts: z.number().int().min(1).max(10),
      calibrationSampleRate: z.number().min(0).max(1),
      maxAgentHops: z.number().int().min(0).max(12).optional(),
      claimTimeoutMinutes: z.number().min(0.5).max(60).optional(),
      driftStrikes: z.number().int().min(1).max(5).optional(),
      planApproval: z.enum(["always", "big", "never"]).optional(),
      autoRunChecks: z.boolean().optional(),
      autoResume: z.boolean().optional(),
      capacity: z.object({
        maxConcurrentTasks: z.number().int().min(1).max(32).optional(),
        localModels: z.enum(["auto", "on", "off"]).optional(),
        maxLocalCliAgents: z.number().int().min(1).max(32).optional(),
        localModelMaxGB: z.number().min(0).max(512).optional(),
        minFreeGB: z.number().min(0).max(512).optional(),
        smallBelowGB: z.number().min(1).max(512).optional(),
        largeFromGB: z.number().min(1).max(512).optional(),
      }).optional(),
    }).parse({ ...store.getSettings(), ...(req.body as object) });
    store.setSettings(s); store.audit("owner", "settings.updated", JSON.stringify(s)); return s;
  });

  // ---------- 1.6 quota awareness
  const quota = quotaFor(store);
  const limit = z.object({ limitTokens: z.number().int().min(1).optional(), limitRuns: z.number().int().min(1).optional() });
  const subSchema = z.object({
    id: z.string().min(1).max(64), provider: z.string().max(64), label: z.string().min(1).max(120), plan: z.string().max(80).optional(),
    agentIds: z.array(z.string()), kind: z.enum(["subscription", "api", "local"]), modelMatch: z.string().max(120).optional(),
    windows: z.object({ fiveHour: limit.optional(), weekly: limit.optional() }),
    resetAnchor: z.object({ fiveHourStart: z.number().optional(), weekStart: z.number().optional() }).optional(),
  });
  app.get("/quota/subscriptions", async () => quota.statuses());
  app.put("/quota/subscriptions", async (req) => { quota.saveSubscriptions(z.array(subSchema).parse(req.body) as never); return quota.statuses(); });
  app.post("/quota/subscriptions/:id/forget", async (req) => { quota.forgetLearned((req.params as { id: string }).id); return quota.statuses(); });
  app.get("/quota/settings", async () => quota.settings());
  app.put("/quota/settings", async (req) => quota.saveSettings(z.object({ freeMargin: z.number(), expiryBonus: z.number(), nearLimit: z.number() }).partial().parse(req.body)));
  app.get("/quota/report", async (req) => quota.report(z.object({ days: z.coerce.number().min(1).max(365).default(7) }).parse(req.query ?? {}).days));

  // ---------- memory
  app.get("/memory", async (req) => {
    const q = req.query as { roomId?: string; agentId?: string };
    return q.agentId ? store.listPrivate(q.agentId) : store.listShared(q.roomId);
  });
  app.put("/memory/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = store.db.prepare("SELECT data FROM memory WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) return reply.code(404).send({ error: "Memory not found." });
    const e = { ...JSON.parse(row.data), text: z.object({ text: z.string().min(1) }).parse(req.body).text };
    store.saveMemory(e); store.audit("owner", "memory.edit", e.text.slice(0, 200)); return e;
  });
  app.delete("/memory/:id", async (req) => { store.deleteMemory((req.params as { id: string }).id); store.audit("owner", "memory.delete", (req.params as { id: string }).id); return { ok: true }; });
  app.get("/memory/proposals", async (req) => store.listProposals((req.query as { status?: string }).status));
  app.post("/memory/proposals/:id", async (req) => {
    const b = z.object({ accept: z.boolean(), text: z.string().optional() }).parse(req.body);
    orch.decideProposal((req.params as { id: string }).id, b.accept, b.text); return { ok: true };
  });

  // ---------- approvals & audit
  app.get("/approvals", async (req) => store.listApprovals((req.query as { status?: string }).status));
  app.post("/approvals/:id", async (req, reply) => {
    const { decision } = z.object({ decision: z.enum(["approved", "rejected"]) }).parse(req.body);
    const a = approvals.decide((req.params as { id: string }).id, decision);
    return a ?? reply.code(404).send({ error: "Approval not found." });
  });
  app.get("/audit", async () => store.listAudit());

  // ---------- 1.9 control files (the ~/Agent Room folder: rules, personas, permissions, scope)
  const control = () => orch.control;
  const noControl = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(404).send({ error: "The control folder isn't available on this hub." });
  app.get("/control/status", async (_req, reply) => control() ? control()!.status() : noControl(reply));
  app.get("/control/history", async (req, reply) => {
    if (!control()) return noControl(reply);
    const path = (req.query as { path?: string }).path;
    try { return await control()!.history(path || undefined); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.post("/control/revert/:commit", async (req, reply) => {
    if (!control()) return noControl(reply);
    const commit = (req.params as { commit: string }).commit;
    try {
      const r = await control()!.revert(commit);
      store.audit("owner", "control.revert", `${commit} -> ${r.commit}: ${r.files.join(", ")}`);
      return { ok: true, ...r };
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post("/control/lint", async (_req, reply) => control() ? control()!.lint() : noControl(reply));

  // ---------- 1.1 folder grants and write proposals (owner only; agents reach files through MCP). The broker audits every change.
  // A refused grant answers 400 with a GrantRefusal body: { error, code, canForce, because? }. canForce true = the UI may offer "Grant anyway", which asks for a reason.
  const refusal = (e: PathDenied): GrantRefusal => e instanceof GrantRefused
    ? { error: e.message, code: e.canForce ? "protected_folder" : "hard_refused", canForce: e.canForce, because: e.because }
    : { error: e.message, code: "invalid", canForce: false };
  const grantCheck = (b: { roomId?: string | null; agentId?: string }) => {
    if (b.roomId && !store.getRoom(b.roomId)) return "Room not found.";
    if (b.agentId && b.agentId !== "*" && !store.getAgent(b.agentId)) return "Agent not found.";
    return undefined;
  };
  // Filters: ?roomId= and ?agentId= keep grants that apply to that room/agent (a "*" grant applies to every agent, a grant with no room to every room).
  app.get("/folder-grants", async (req) => {
    const q = z.object({ roomId: z.string().optional(), agentId: z.string().optional() }).parse(req.query ?? {});
    return orch.files.listGrants().filter((g) => (!q.roomId || !g.roomId || g.roomId === q.roomId) && (!q.agentId || g.agentId === "*" || g.agentId === q.agentId));
  });
  // What one agent in one room can actually reach: the grants that apply to it. Same rule the file tools use.
  app.get("/folder-grants/effective", async (req, reply) => {
    const q = z.object({ agentId: z.string().min(1), roomId: z.string().optional() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "Send agentId (and optionally roomId)." });
    return orch.files.grantsFor(q.data.agentId, q.data.roomId);
  });
  // Would this folder be accepted? Nothing is stored. { ok: true, root, protected, because? } or { ok: false, error, canForce }.
  app.post("/folder-grants/check", async (req, reply) => {
    const b = z.object({ path: z.string().min(1).max(4096) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Send path (an absolute folder)." });
    return orch.files.checkFolder(b.data.path);
  });
  app.post("/folder-grants", async (req, reply) => {
    const parsed = z.object({
      path: z.string().min(1).max(4096), label: z.string().max(80).optional(), roomId: z.string().optional(),
      agentId: z.string().min(1).max(80), read: z.boolean().default(true), write: z.boolean().default(false),
      force: z.boolean().optional(), reason: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Send path (an absolute folder) and agentId, plus read/write.", code: "invalid", canForce: false } satisfies GrantRefusal);
    const b = parsed.data;
    const bad = grantCheck(b);
    if (bad) return reply.code(400).send({ error: bad, code: "invalid", canForce: false } satisfies GrantRefusal);
    try { return orch.files.addGrant(b); } // the broker audits grant.added (and grant.override)
    catch (e) {
      if (e instanceof PathDenied) return reply.code(400).send(refusal(e));
      throw e;
    }
  });
  // Change who a grant covers or what it allows: { label?, roomId? (null = every room), agentId?, read?, write? }. The path never changes.
  app.put("/folder-grants/:id", async (req, reply) => {
    const parsed = z.object({
      label: z.string().max(80).optional(), roomId: z.string().nullable().optional(),
      agentId: z.string().min(1).max(80).optional(), read: z.boolean().optional(), write: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Send label, roomId, agentId, read or write.", code: "invalid", canForce: false } satisfies GrantRefusal);
    const bad = grantCheck(parsed.data);
    if (bad) return reply.code(400).send({ error: bad, code: "invalid", canForce: false } satisfies GrantRefusal);
    try {
      const g = orch.files.updateGrant((req.params as { id: string }).id, parsed.data);
      return g ?? reply.code(404).send({ error: "Grant not found." });
    } catch (e) {
      if (e instanceof PathDenied) return reply.code(400).send(refusal(e));
      throw e;
    }
  });
  app.delete("/folder-grants/:id", async (req, reply) => {
    const g = orch.files.removeGrant((req.params as { id: string }).id);
    if (!g) return reply.code(404).send({ error: "Grant not found." });
    return { ok: true };
  });
  // Proposals, newest first, without their diffs (the list stays small): ?status= ?grantId= ?goalId= ?agentId=. The whole diff is GET /write-proposals/:id.
  app.get("/write-proposals", async (req) => {
    const q = z.object({ status: z.string().optional(), grantId: z.string().optional(), goalId: z.string().optional(), agentId: z.string().optional() }).parse(req.query ?? {});
    return orch.files.proposals()
      .filter((p) => (!q.status || p.status === q.status) && (!q.grantId || p.grantId === q.grantId) && (!q.goalId || p.goalId === q.goalId) && (!q.agentId || p.agentId === q.agentId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ diff, ...rest }) => ({ ...rest, diffBytes: Buffer.byteLength(diff) }));
  });
  // One proposal with its full stored diff: for a task proposal, every file's diff, the one the owner approves.
  app.get("/write-proposals/:id", async (req, reply) => orch.files.proposal((req.params as { id: string }).id) ?? reply.code(404).send({ error: "Proposal not found." }));
  app.get("/devices", async () => store.listDevices());

  // ---------- live events
  const sockets = new Set<{ send: (s: string) => void; readyState: number }>();
  const onEvent = (e: ServerEvent) => {
    const s = JSON.stringify(e);
    for (const ws of sockets) if (ws.readyState === 1) ws.send(s);
    if (e.type === "approval" && e.approval.status === "pending") void pushNotify("Approval needed", `${e.approval.agentId} wants to use ${e.approval.tool}: ${e.approval.action}`);
  };
  store.on("event", onEvent);
  inbox.onSeen = (agentId) => { const a = store.getAgent(agentId); if (a) void orch.agentStatus(a, true); };
  app.addHook("onClose", async () => { store.off("event", onEvent); });
  app.get("/ws", { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: "hello", ownerName }));
    socket.on("close", () => sockets.delete(socket));
  });

  return app;
}
