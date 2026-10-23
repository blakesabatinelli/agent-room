// 4.6 A2A agent card and an ACP adapter.
//   AC1: The Room publishes an A2A agent card.
//   AC2: At least one agent that speaks ACP joins with no custom adapter.
//
// Nothing here calls a real CLI or the network. The Tailscale CLI, the ACP agent and the `gemini` command are fakes in test/fixtures or written to a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, Goal, Task } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { AcpAdapter, acpUsage, confineToWorktree, pickOption, toolForKind } from "../src/adapters/acp.js";
import { adapters } from "../src/adapters/index.js";
import { buildAgentCard, messageText, readVersion, renderTask } from "../src/interop/a2a.js";
import { a2aRemoteOpen, A2A_PATH, CARD_PATH } from "../src/interop/paths.js";
import { ACP_CLIS, acpLaunchArgs, probeAcpAgents } from "../src/interop/acpDiscovery.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { defaultEnv, discover } from "../src/discovery/index.js";
import { onProbation, endProbation } from "../src/resume/index.js";
import { Tailscale, readFunnel } from "../src/remote/tailscale.js";
import { newProgress } from "../src/orchestrator/ledger.js";
import { goalFolder } from "../src/orchestrator/workspace.js";
import { McpTokens } from "../src/mcp/tokens.js";
import { id, now } from "../src/util.js";
import { localPairHeaders, setup } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const FAKE_ACP = join(FIXTURES, "fake-acp-agent.mjs");
const until = async (fn: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 20 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };
const tmp = (p = "ar-interop-") => mkdtempSync(join(tmpdir(), p));

// ================================================================ a checker for the A2A schema, driven by the vendored proto

/**
 * The A2A protocol publishes its data model as a protobuf file, and its JSON schema is only generated from it at docs-build time (not committed:
 * https://github.com/a2aproject/A2A/blob/main/specification/json/README.md). So the vendored file is the .proto itself, pinned to the v1.0.0 tag:
 *   https://raw.githubusercontent.com/a2aproject/A2A/v1.0.0/specification/a2a.proto   (fixtures/a2a-v1.0.0.proto, sha256 4b74c0ba...3a2257f, fetched 2026-10-23)
 * This reads messages, fields, enums, oneofs, maps and `field_behavior = REQUIRED` from it, and checks a JSON value the way ProtoJSON reads it:
 * camelCase names, enum names as strings, one member per oneof, required fields present, no field the message doesn't have.
 */
interface Field { name: string; json: string; type: string; repeated: boolean; map?: string; required: boolean; oneof?: string }
interface Proto { messages: Map<string, Field[]>; enums: Map<string, string[]> }
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function parseProto(text: string): Proto {
  const messages = new Map<string, Field[]>(), enums = new Map<string, string[]>();
  const lines = text.replace(/\/\/.*$/gm, "").split("\n");
  const stack: { kind: "message" | "enum" | "oneof" | "other"; name: string }[] = [];
  const fields = new Map<string, Field[]>();
  let current: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^message (\w+) \{$/.exec(line))) { stack.push({ kind: "message", name: m[1] }); current = m[1]; fields.set(m[1], []); continue; }
    if ((m = /^enum (\w+) \{$/.exec(line))) { stack.push({ kind: "enum", name: m[1] }); enums.set(m[1], []); continue; }
    if ((m = /^oneof (\w+) \{$/.exec(line))) { stack.push({ kind: "oneof", name: m[1] }); continue; }
    if (/\{$/.test(line)) { stack.push({ kind: "other", name: "" }); continue; }
    if (line === "}" || line === "};") { const t = stack.pop(); if (t?.kind === "message") current = stack.filter((s) => s.kind === "message").at(-1)?.name; continue; }
    const top = stack.at(-1);
    if (top?.kind === "enum" && (m = /^(\w+) = \d+/.exec(line))) { enums.get(top.name)!.push(m[1]); continue; }
    if (top && (top.kind === "message" || top.kind === "oneof") && current && (m = /^(repeated |optional )?(map<\s*\w+\s*,\s*([\w.]+)\s*>|[\w.]+) (\w+) = \d+(?: \[(.*)\])?;/.exec(line))) {
      const mapValue = m[3];
      fields.get(current)!.push({
        name: m[4], json: camel(m[4]), type: mapValue ?? m[2], repeated: m[1] === "repeated ", map: mapValue, required: /REQUIRED/.test(m[5] ?? ""),
        oneof: top.kind === "oneof" ? top.name : undefined,
      });
    }
  }
  for (const [k, v] of fields) messages.set(k, v);
  return { messages, enums };
}

const SCALARS = new Set(["string", "bool", "int32", "int64", "bytes", "google.protobuf.Struct", "google.protobuf.Value", "google.protobuf.Timestamp"]);
function check(p: Proto, type: string, v: unknown, path: string, extra: ReadonlySet<string>, errs: string[]) {
  if (type === "string") { if (typeof v !== "string") errs.push(`${path}: not a string`); return; }
  if (type === "bool") { if (typeof v !== "boolean") errs.push(`${path}: not a boolean`); return; }
  if (type === "int32" || type === "int64") { if (typeof v !== "number") errs.push(`${path}: not a number`); return; }
  if (type === "google.protobuf.Timestamp") { if (typeof v !== "string" || Number.isNaN(Date.parse(v)) || !/Z$/.test(v)) errs.push(`${path}: not an RFC 3339 UTC timestamp`); return; }
  if (SCALARS.has(type)) return;
  if (p.enums.has(type)) { if (typeof v !== "string" || !p.enums.get(type)!.includes(v)) errs.push(`${path}: ${JSON.stringify(v)} is not a ${type} name`); return; }
  const fields = p.messages.get(type);
  if (!fields) { errs.push(`${path}: unknown type ${type}`); return; }
  if (!v || typeof v !== "object" || Array.isArray(v)) { errs.push(`${path}: not an object`); return; }
  const o = v as Record<string, unknown>;
  const byJson = new Map(fields.map((f) => [f.json, f]));
  for (const k of Object.keys(o)) if (!byJson.has(k) && !extra.has(k)) errs.push(`${path}.${k}: not a field of ${type}`);
  const groups = new Map<string, number>();
  for (const f of fields) {
    const val = o[f.json];
    if (f.oneof) groups.set(f.oneof, (groups.get(f.oneof) ?? 0) + (val !== undefined ? 1 : 0));
    if (val === undefined) { if (f.required) errs.push(`${path}.${f.json}: required by ${type}`); continue; }
    if (f.map) {
      if (!val || typeof val !== "object" || Array.isArray(val)) { errs.push(`${path}.${f.json}: not a map`); continue; }
      for (const [mk, mv] of Object.entries(val)) check(p, f.map, mv, `${path}.${f.json}[${mk}]`, extra, errs);
    } else if (f.repeated) {
      if (!Array.isArray(val)) { errs.push(`${path}.${f.json}: not a list`); continue; }
      if (f.required && val.length === 0) errs.push(`${path}.${f.json}: required by ${type} and empty`);
      val.forEach((x, i) => check(p, f.type, x, `${path}.${f.json}[${i}]`, extra, errs));
    } else check(p, f.type, val, `${path}.${f.json}`, extra, errs);
  }
  for (const [g, n] of groups) if (n !== 1) errs.push(`${path}: oneof ${g} of ${type} needs exactly one member, has ${n}`);
}
const PROTO = parseProto(readFileSync(join(FIXTURES, "a2a-v1.0.0.proto"), "utf8"));
/** Validate against a message in the vendored proto. `extra` names top-level fields that belong to the older 0.3 card and are allowed on purpose. */
const validate = (type: string, v: unknown, extra: string[] = []) => { const errs: string[] = []; check(PROTO, type, v, type, new Set(extra), errs); return errs; };

/** A2A 0.3 AgentCard: the fields its specification requires (https://a2a-protocol.org/v0.3.0/specification/#55-agentcard-object-structure). */
const V03_REQUIRED = ["protocolVersion", "name", "description", "url", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"];
const LEGACY_CARD_FIELDS = ["protocolVersion", "url", "preferredTransport"];

test("the schema checker itself: the vendored proto is the real one and the checker catches a bad card", () => {
  assert.ok(PROTO.messages.get("AgentCard")!.filter((f) => f.required).map((f) => f.json).sort().join() === "capabilities,defaultInputModes,defaultOutputModes,description,name,skills,supportedInterfaces,version");
  assert.ok(PROTO.enums.get("TaskState")!.includes("TASK_STATE_COMPLETED"));
  const good = buildAgentCard({ version: "1", endpointUrl: "https://x.example/a2a" });
  assert.deepEqual(validate("AgentCard", good, LEGACY_CARD_FIELDS), []);
  assert.ok(validate("AgentCard", { ...good, skills: undefined }, LEGACY_CARD_FIELDS).some((e) => /skills.*required/.test(e)));
  assert.ok(validate("AgentCard", { ...good, bogus: 1 }, LEGACY_CARD_FIELDS).some((e) => /bogus/.test(e)));
  assert.ok(validate("AgentCard", { ...good, securitySchemes: { k: { httpAuthSecurityScheme: { scheme: "Bearer" }, apiKeySecurityScheme: { location: "header", name: "x" } } } }, LEGACY_CARD_FIELDS).some((e) => /oneof/.test(e)));
  assert.ok(validate("Task", { id: "t", status: { state: "completed" } }).some((e) => /TaskState/.test(e)));
});

// ================================================================ a hub to talk to

const HOST = "mac.tail1234.ts.net";
const RUNNING = {
  BackendState: "Running", MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "blake@example.com", MagicDNSEnabled: true },
  Self: { DNSName: `${HOST}.`, TailscaleIPs: ["100.101.102.103"], Online: true },
};
/** A fake `tailscale` CLI: canned status, a serve config it edits when asked to funnel a path or turn one off, and an argv log. */
const FAKE_TS = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.FAKE_TS_DIR, args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(args) + "\\n");
const read = (n) => { try { return fs.readFileSync(path.join(dir, n), "utf8"); } catch { return null; } };
const sub = args[0];
if (sub === "status") { process.stdout.write(read("status.json")); process.exit(0); }
if (sub === "funnel" || sub === "serve") {
  if (args[1] === "status") { process.stdout.write(read("serve.json") || "{}"); process.exit(0); }
  if (read("path-fails") && args.some((a) => a === "--set-path=" + read("path-fails"))) { process.stderr.write("could not serve that path\\n"); process.exit(1); }
  const off = args.includes("off");
  const sp = (args.find((a) => a.startsWith("--set-path=")) || "--set-path=/").slice(11);
  const port = (args.find((a) => a.startsWith("--https=")) || "--https=443").slice(8);
  const target = args.filter((a) => !a.startsWith("--") && a !== "off" && a !== sub).pop();
  const hp = ${JSON.stringify(HOST)} + ":" + port;
  const cfg = JSON.parse(read("serve.json") || "{}");
  cfg.TCP ||= {}; cfg.Web ||= {}; cfg.AllowFunnel ||= {};
  if (off) {
    if (cfg.Web[hp]) { delete cfg.Web[hp].Handlers[sp]; if (!Object.keys(cfg.Web[hp].Handlers).length) { delete cfg.Web[hp]; delete cfg.AllowFunnel[hp]; delete cfg.TCP[port]; } }
  } else {
    cfg.TCP[port] = { HTTPS: true };
    (cfg.Web[hp] ||= { Handlers: {} }).Handlers[sp] = { Proxy: target };
    if (sub === "funnel") cfg.AllowFunnel[hp] = true;
  }
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify(cfg));
  process.exit(0);
}
process.exit(2);
`;
function fakeCli() {
  const dir = tmp("ar-ts-");
  const bin = join(dir, "tailscale");
  writeFileSync(bin, FAKE_TS); chmodSync(bin, 0o755);
  writeFileSync(join(dir, "status.json"), JSON.stringify(RUNNING));
  const put = (name: string, v: unknown) => writeFileSync(join(dir, name), typeof v === "string" ? v : JSON.stringify(v));
  const argv = (): string[][] => (existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const serve = () => JSON.parse(readFileSync(join(dir, "serve.json"), "utf8") || "{}");
  return { dir, put, argv, serve, ts: () => new Tailscale({ bin, env: { FAKE_TS_DIR: dir }, ttlMs: 0 }) };
}
const mcpServe = (port: number) => ({ TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/mcp": { Proxy: `http://127.0.0.1:${port}/mcp` } } } }, AllowFunnel: { [`${HOST}:443`]: true } });
const PROXY = { "x-forwarded-for": "203.0.113.7", "x-forwarded-host": HOST, "x-forwarded-proto": "https" };

async function boot(opts: { tailscale?: boolean; burst?: number } = {}) {
  const ctx = setup();
  const cli = fakeCli();
  const app = await buildServer({ ...ctx, ownerName: "Blake", tailscale: opts.tailscale === false ? undefined : cli.ts(), remoteAuth: { burst: opts.burst ?? 3, refillMs: 60_000 } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const pr = await fetch(`${base}/pair/local`, { method: "POST", headers: localPairHeaders(ctx.dir), body: "{}" });
  const { token } = (await pr.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) => {
    const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => undefined)) as any };
  };
  const newKey = async (name = "Contoso agent", extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/a2a/keys", { name, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as { id: string; token: string; url: string; scope: string };
  };
  const rpc = async (key: string | undefined, method: string, params?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/a2a`, {
      method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
    });
    return { status: r.status, body: (await r.json().catch(() => undefined)) as any };
  };
  return { ...ctx, cli, app, base, port, auth, call, newKey, rpc };
}
type Hub = Awaited<ReturnType<typeof boot>>;
const fast = (h: Hub) => { h.store.setSettings({ ...h.store.getSettings(), planApproval: "never", autoRunChecks: true }); };
const ask = (text: string, extra: Record<string, unknown> = {}) => ({ message: { messageId: id("m"), role: "ROLE_USER", parts: [{ text }] }, ...extra });
const GOAL = "Summarize the venue TV market";

// ================================================================ AC1: the card

test("4.6 AC1: GET /.well-known/agent-card.json is an A2A 1.0 agent card with every required field, valid against the vendored schema", async () => {
  const h = await boot();
  const r = await fetch(`${h.base}${CARD_PATH}`); // no key, no paired device: the card is public discovery on the tailnet
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
  const card = (await r.json()) as Record<string, any>;

  // every field A2A 1.0 requires on an AgentCard (a2a.proto field_behavior REQUIRED), checked by the vendored proto
  assert.deepEqual(validate("AgentCard", card, LEGACY_CARD_FIELDS), []);
  // and the spec's fields by name, so a failure says what is missing
  for (const k of ["name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills", "securitySchemes"]) assert.ok(card[k] !== undefined, `missing ${k}`);
  // 0.3 clients: its required list
  for (const k of V03_REQUIRED) assert.ok(card[k] !== undefined, `0.3 field ${k} missing`);

  assert.equal(card.name, "Agent Room");
  assert.equal(card.version, readFileSync(join(HERE, "../../../VERSION"), "utf8").trim().split(/\s+/)[0], "version comes from the VERSION file");
  assert.equal(card.version, readVersion());
  // the endpoint is on the tailnet name, at /a2a, and the first (preferred) interface is 1.0 JSON-RPC
  const url = `http://${HOST}:${h.port}/a2a`;
  assert.equal(card.url, url);
  assert.deepEqual(card.supportedInterfaces[0], { url, protocolBinding: "JSONRPC", protocolVersion: "1.0" });
  assert.deepEqual(card.supportedInterfaces[1], { url, protocolBinding: "JSONRPC", protocolVersion: "0.3" });
  assert.equal(card.preferredTransport, "JSONRPC");
  // auth: a bearer key, named in securityRequirements
  assert.deepEqual(Object.keys(card.securitySchemes), ["agentRoomKey"]);
  assert.equal(card.securitySchemes.agentRoomKey.httpAuthSecurityScheme.scheme, "Bearer");
  assert.deepEqual(card.securityRequirements, [{ schemes: { agentRoomKey: { list: [] } } }]);
  // what it can't do is said, not implied
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  // skills: a generic "run a goal", and one per room command an outside caller may send
  const ids = card.skills.map((s: { id: string }) => s.id);
  assert.ok(ids.includes("run-goal"));
  assert.deepEqual(ids.filter((s: string) => s.startsWith("command-")).sort(), ["command-digest", "command-pause", "command-resume", "command-stop"]);
  for (const s of card.skills) assert.ok(s.tags.length && s.description && s.name, `skill ${s.id} is complete`);
  // the old path was dropped from the spec in 0.3 and is not served
  assert.equal((await fetch(`${h.base}/.well-known/agent.json`)).status, 401);
  await h.app.close();
});

test("4.6 AC1: the card points at the right address for where the caller came from", async () => {
  // no Tailscale on this Mac: the address the caller used
  const bare = await boot();
  bare.cli.put("status.json", { BackendState: "Stopped" });
  const c1 = (await (await fetch(`${bare.base}${CARD_PATH}`)).json()) as { url: string };
  assert.equal(c1.url, `http://127.0.0.1:${bare.port}/a2a`);
  await bare.app.close();

  // through Funnel (setting on): the public name and https the proxy saw
  const h = await boot();
  const on = await h.call("PUT", "/a2a/settings", { funnel: true });
  assert.equal(on.status, 200);
  const c2 = (await (await fetch(`${h.base}${CARD_PATH}`, { headers: PROXY })).json()) as { url: string; supportedInterfaces: { url: string }[] };
  assert.equal(c2.url, `https://${HOST}/a2a`);
  assert.equal(c2.supportedInterfaces[0].url, `https://${HOST}/a2a`);
  assert.deepEqual(validate("AgentCard", c2, LEGACY_CARD_FIELDS), []);
  await h.app.close();
});

// ================================================================ the key: scope "a2a"

test("4.6: an A2A key opens /a2a and nothing else; an MCP key never opens /a2a; bad keys are refused and audited without the key", async () => {
  const h = await boot();
  const k = await h.newKey("Contoso");
  assert.equal(k.scope, "a2a");
  assert.equal(k.url, `http://${HOST}:${h.port}/a2a`);
  assert.match(k.token, /\S{20,}/);

  // no key, a wrong key
  const none = await h.rpc(undefined, "GetTask", { id: "x" });
  assert.equal(none.status, 401);
  assert.equal((await fetch(`${h.base}/a2a`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).headers.get("www-authenticate"), 'Bearer realm="agent-room"');
  assert.equal((await h.rpc("not-a-key", "GetTask", { id: "x" })).status, 401);

  // an ordinary MCP key is not an A2A key
  const mcp = await h.call("POST", "/mcp-tokens", { agentId: "claude", name: "Claude" });
  assert.equal((await h.rpc(mcp.body.token, "GetTask", { id: "x" })).status, 401);
  // and an A2A key is not an MCP key: /mcp refuses it
  const m = await fetch(`${h.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(m.status, 401);
  // the key works
  const ok = await h.rpc(k.token, "GetTask", { id: "nope" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.error.code, -32001, "TaskNotFound");

  // listed without the key; only a hash is stored
  const list = (await h.call("GET", "/a2a/keys")).body as { id: string; scope: string; token?: string }[];
  assert.equal(list.length, 1);
  assert.equal(list[0].token, undefined);
  assert.ok(!JSON.stringify(h.store.getKV("mcp_tokens_v2", [])).includes(k.token));
  assert.ok(!h.store.listAudit().some((a) => JSON.stringify(a).includes(k.token)), "the key is never in the audit log");
  assert.ok(h.store.listAudit().some((a) => a.action === "a2a.denied"));

  // revoked keys stop working at once; rotating makes a new one
  const r = (await h.call("POST", `/a2a/keys/${k.id}/rotate`)).body as { token: string };
  assert.equal((await h.rpc(k.token, "GetTask", { id: "x" })).status, 401);
  assert.equal((await h.rpc(r.token, "GetTask", { id: "x" })).status, 200);
  assert.equal((await h.call("DELETE", `/a2a/keys/${k.id}`)).status, 200);
  assert.equal((await h.rpc(r.token, "GetTask", { id: "x" })).status, 401);
  assert.equal((await h.call("DELETE", `/a2a/keys/${mcp.body.id}`)).status, 404, "this list only holds A2A keys");

  // McpTokens keeps the scopes apart
  const t = new McpTokens(h.store);
  const a = t.create({ agentId: "a2a:external", name: "x", scope: "a2a" });
  assert.ok(t.lookup(a.token, "a2a") && !t.lookup(a.token) && !t.lookup(a.token, "mcp"));
  await h.app.close();
});

// ================================================================ message/send, tasks/get, tasks/cancel

test("4.6 AC1: SendMessage starts a goal as an outside requester; GetTask reports it, its summary and its Library documents", async () => {
  const h = await boot();
  fast(h);
  const k = await h.newKey("Contoso");
  const sent = await h.rpc(k.token, "SendMessage", ask(GOAL, { configuration: { returnImmediately: true } }));
  assert.equal(sent.status, 200);
  const task = sent.body.result.task;
  assert.deepEqual(validate("Task", task), [], "a Task as the 1.0 schema defines it");
  assert.match(task.id, /^goal_/);
  assert.equal(task.contextId, h.room.id, "context is the room");
  assert.ok(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"].includes(task.status.state));

  // it is a real goal in the room, started by an outside requester (not as the owner), and audited
  const goal = h.store.getGoal(task.id)!;
  assert.equal(goal.text, GOAL);
  const note = h.store.listMessages(h.room.id).find((m) => /outside agent/.test(m.text))!;
  assert.equal(note.author.kind, "system");
  assert.ok(!h.store.listMessages(h.room.id).some((m) => m.author.kind === "human" && m.text === GOAL), "not posted as the owner");
  const started = h.store.listAudit().find((a) => a.action === "a2a.goal.started")!;
  assert.match(started.detail, new RegExp(`key=${k.id}`));
  // attention-gated: the owner's gate got it (an "info" item for the digest, not a push)
  assert.ok(h.orch.attention.state().queue.some((q) => /outside agent started a goal/i.test(q.title)));

  // a Library document the agents saved shows up as an artifact
  h.orch.library.save({ title: "Venue brief", body: "# Venue brief\n\nBars, gyms and waiting rooms.", roomId: h.room.id, goalId: goal.id, author: "claude" });
  await until(() => h.store.getGoal(task.id)!.status === "done");
  const got = await h.rpc(k.token, "GetTask", { id: task.id });
  const t = got.body.result;
  assert.deepEqual(validate("Task", t), []);
  assert.equal(t.status.state, "TASK_STATE_COMPLETED");
  assert.match(t.status.message.parts[0].text, /complete/i, "the final summary rides on the status");
  const names = t.artifacts.map((a: { name: string }) => a.name);
  assert.deepEqual(names, ["Summary", "Venue brief"]);
  assert.match(t.artifacts[1].parts[0].text, /Bars, gyms and waiting rooms/);
  assert.ok(!/---\s*\nid:/.test(t.artifacts[1].parts[0].text), "front matter is not part of the document text");

  // another key can't see it
  const other = await h.newKey("Other");
  assert.equal((await h.rpc(other.token, "GetTask", { id: task.id })).body.error.code, -32001);
  await h.app.close();
});

test("4.6: a blocking SendMessage answers when the goal is done; the 0.3 method names get 0.3-shaped answers", async () => {
  const h = await boot();
  fast(h);
  const k = await h.newKey();
  const done = await h.rpc(k.token, "SendMessage", ask(GOAL));
  assert.equal(done.body.result.task.status.state, "TASK_STATE_COMPLETED");
  assert.ok(done.body.result.task.artifacts[0].parts[0].text);

  // A2A 0.3: message/send, tasks/get; parts carry "kind", states are lower case, the result is the Task itself
  const legacy = await h.rpc(k.token, "message/send", { message: { kind: "message", messageId: id("m"), role: "user", parts: [{ kind: "text", text: GOAL }] }, configuration: { blocking: false } });
  const lt = legacy.body.result;
  assert.equal(lt.kind, "task");
  assert.ok(["submitted", "working"].includes(lt.status.state), lt.status.state);
  await until(() => h.store.getGoal(lt.id)!.status === "done");
  const g = (await h.rpc(k.token, "tasks/get", { id: lt.id })).body.result;
  assert.equal(g.kind, "task");
  assert.equal(g.status.state, "completed");
  assert.equal(g.artifacts[0].parts[0].kind, "text");
  assert.equal(g.status.message.role, "agent");
  // the same task through the 1.0 name
  assert.equal((await h.rpc(k.token, "GetTask", { id: lt.id })).body.result.status.state, "TASK_STATE_COMPLETED");
  await h.app.close();
});

test("4.6: the plan approval rule applies to an outside goal; CancelTask stops it; a finished task can't be cancelled", async () => {
  const h = await boot();
  h.store.setSettings({ ...h.store.getSettings(), planApproval: "always" });
  const k = await h.newKey();
  // the blocking send returns as soon as the goal needs the owner
  const sent = await h.rpc(k.token, "SendMessage", ask(GOAL));
  const task = sent.body.result.task;
  assert.equal(task.status.state, "TASK_STATE_WORKING");
  assert.match(task.status.message.parts[0].text, /approve the plan/i);
  assert.equal(h.store.getGoal(task.id)!.status, "awaiting_approval", "nothing runs until the owner says so");
  assert.ok(h.store.listMessages(h.room.id).some((m) => m.planGoalId === task.id), "the plan card is in the room");

  // the room is busy while it waits
  const busy = await h.rpc(k.token, "SendMessage", ask("Another goal"));
  assert.equal(busy.body.error.code, -32602);
  assert.match(busy.body.error.message, /busy/);

  const cancelled = await h.rpc(k.token, "CancelTask", { id: task.id });
  assert.equal(cancelled.body.result.status.state, "TASK_STATE_CANCELED");
  assert.equal(h.store.getGoal(task.id)!.status, "failed");
  assert.ok(h.store.listAudit().some((a) => a.action === "a2a.task.canceled"));
  assert.equal((await h.rpc(k.token, "GetTask", { id: task.id })).body.result.status.state, "TASK_STATE_CANCELED");
  const again = await h.rpc(k.token, "CancelTask", { id: task.id });
  assert.equal(again.body.error.code, -32002, "TaskNotCancelable");

  // approve one the owner is happy with: it runs to the end
  const t2 = (await h.rpc(k.token, "SendMessage", ask(GOAL))).body.result.task;
  assert.equal(t2.status.state, "TASK_STATE_WORKING");
  h.orch.decidePlan(t2.id, "approve");
  await until(() => h.store.getGoal(t2.id)!.status === "done");
  assert.equal((await h.rpc(k.token, "GetTask", { id: t2.id })).body.result.status.state, "TASK_STATE_COMPLETED");
  assert.equal((await h.rpc(k.token, "CancelTask", { id: t2.id })).body.error.code, -32002);
  await h.app.close();
});

test("4.6: cancelling a running goal stops its agents (0.3 name too)", async () => {
  const h = await boot();
  fast(h);
  for (const a of h.store.listAgents()) { const x = h.store.getAgent(a.id)!; x.settings.delayMs = 5000; h.store.saveAgent(x); }
  const k = await h.newKey();
  const t = (await h.rpc(k.token, "message/send", { message: { kind: "message", messageId: id("m"), role: "user", parts: [{ kind: "text", text: GOAL }] }, configuration: { blocking: false } })).body.result;
  await until(() => h.store.getGoal(t.id)!.status === "running" && h.store.listTasks({ goalId: t.id }).some((x) => x.status === "running"));
  const c = (await h.rpc(k.token, "tasks/cancel", { id: t.id })).body.result;
  assert.equal(c.status.state, "canceled");
  assert.equal(h.store.getGoal(t.id)!.status, "failed");
  await until(() => h.store.listTasks({ goalId: t.id }).every((x) => x.status === "cancelled"));
  assert.ok(h.store.listTasks({ goalId: t.id }).every((x) => x.status === "cancelled"));
  await h.orch.idle();
  await h.app.close();
});

test("4.6: rooms (default general, by name, pinned keys), room commands, and what is refused", async () => {
  const h = await boot();
  fast(h);
  const ops = h.store.createRoom("ops");
  const k = await h.newKey();
  // by name
  const named = (await h.rpc(k.token, "SendMessage", ask(GOAL, { metadata: { room: "#ops" }, configuration: { returnImmediately: true } }))).body.result.task;
  assert.equal(named.contextId, ops.id);
  await until(() => h.store.getGoal(named.id)!.status === "done");
  assert.equal((await h.rpc(k.token, "SendMessage", ask(GOAL, { metadata: { room: "nowhere" } }))).body.error.code, -32602);
  // a key pinned to a room can't be pointed elsewhere
  const pinned = await h.newKey("Pinned", { roomId: ops.id });
  const p = (await h.rpc(pinned.token, "SendMessage", ask(GOAL, { metadata: { room: "general" }, configuration: { returnImmediately: true } }))).body.result.task;
  assert.equal(p.contextId, ops.id);
  await until(() => h.store.getGoal(p.id)!.status === "done");

  // room commands come back as a Message, not a Task
  const pause = (await h.rpc(k.token, "SendMessage", ask("/pause"))).body.result;
  assert.match(pause.message.parts[0].text, /Paused #general/);
  assert.equal(h.store.getRoom(h.room.id)!.paused, true);
  assert.match((await h.rpc(k.token, "message/send", { message: { kind: "message", messageId: "m", role: "user", parts: [{ kind: "text", text: "/resume" }] } })).body.result.parts[0].text, /Resumed/);
  assert.equal(h.store.getRoom(h.room.id)!.paused, false);
  assert.ok(h.store.listAudit().some((a) => a.action === "a2a.command" && /\/pause/.test(a.detail)));

  // refused
  assert.equal((await h.rpc(k.token, "SendMessage", { message: { messageId: "m", role: "ROLE_USER", parts: [] } })).body.error.code, -32602);
  assert.equal((await h.rpc(k.token, "SendMessage", ask(GOAL, { message: undefined }))).body.error?.code ?? -1, -32602, "message needs text parts");
  const reply = await h.rpc(k.token, "SendMessage", { message: { messageId: "m", role: "ROLE_USER", taskId: named.id, parts: [{ text: "more" }] } });
  assert.equal(reply.body.error.code, -32004, "UnsupportedOperation: replying into a task");
  assert.equal((await h.rpc(k.token, "SendStreamingMessage", ask(GOAL))).body.error.code, -32004);
  assert.equal((await h.rpc(k.token, "CreateTaskPushNotificationConfig", {})).body.error.code, -32003);
  assert.equal((await h.rpc(k.token, "nope")).body.error.code, -32601);
  assert.equal((await h.rpc(k.token, "GetTask", { id: "x" }, { "a2a-version": "2.0" })).body.error.code, -32009);
  const bad = await fetch(`${h.base}/a2a`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "GetTask" }]) });
  assert.equal((await bad.json() as any).error.code, -32600, "batches aren't supported");
  assert.equal((await h.rpc(k.token, "GetTask", {})).body.error.code, -32602);
  await h.orch.idle();
  await h.app.close();
});

test("4.6: unit: card, task and message shapes", () => {
  assert.equal(messageText({ parts: [{ text: "a" }, { kind: "text", text: "b" }, { kind: "file", text: "no" }, { raw: "x" }] }), "a\nb");
  assert.equal(messageText({ parts: [] }), undefined);
  const t = renderTask({ id: "g", contextId: "r", state: "failed", text: "No.", artifacts: [{ id: "a", name: "A", text: "body" }], at: 0 }, "v0.3") as any;
  assert.equal(t.status.state, "failed");
  assert.equal(t.artifacts[0].parts[0].kind, "text");
  const v1 = renderTask({ id: "g", contextId: "r", state: "canceled", artifacts: [], at: 0 }, "v1") as any;
  assert.equal(v1.status.state, "TASK_STATE_CANCELED");
  assert.equal(v1.status.message, undefined);
  assert.equal(a2aRemoteOpen("GET", CARD_PATH, true), true);
  assert.equal(a2aRemoteOpen("POST", CARD_PATH, true), false);
  assert.equal(a2aRemoteOpen("GET", A2A_PATH, true), false);
  assert.equal(a2aRemoteOpen("POST", `${A2A_PATH}/`, true), false);
  assert.equal(a2aRemoteOpen("POST", A2A_PATH, false), false);
});

// ================================================================ the 1.2 gate: Funnel

test("4.6: through Funnel the card and /a2a are 404 unless the setting is on, and only those two paths open when it is", async () => {
  const h = await boot();
  fast(h);
  const k = await h.newKey();
  const proxiedRpc = (key: string | undefined, method = "GetTask", params: unknown = { id: "x" }) => h.rpc(key, method, params, PROXY);
  const card = () => fetch(`${h.base}${CARD_PATH}`, { headers: PROXY });
  assert.equal((await h.call("GET", "/a2a/settings")).body.funnel, false, "off by default");

  // off: both are 404, a valid key changes nothing
  assert.equal((await card()).status, 404);
  assert.equal((await proxiedRpc(k.token)).status, 404);
  // the same two answer on the tailnet
  assert.equal((await fetch(`${h.base}${CARD_PATH}`)).status, 200);
  assert.equal((await h.rpc(k.token, "GetTask", { id: "x" })).status, 200);

  // the owner turns it on (a paired device; never through Funnel)
  assert.equal((await h.call("PUT", "/a2a/settings", { funnel: true }, { ...PROXY, ...h.auth })).status, 404, "the switch is not reachable through Funnel");
  assert.equal((await h.call("PUT", "/a2a/settings", { funnel: "yes" })).status, 400);
  assert.equal((await h.call("PUT", "/a2a/settings", { funnel: true })).body.funnel, true);
  assert.ok(h.store.listAudit().some((a) => a.action === "a2a.funnel.on"));

  assert.equal((await card()).status, 200);
  assert.equal((await proxiedRpc(k.token)).status, 200);
  // a key is still required through Funnel; bad keys are counted and locked out (burst 3), like /mcp
  assert.equal((await proxiedRpc(undefined)).status, 401);
  assert.equal((await proxiedRpc("wrong")).status, 401);
  assert.equal((await proxiedRpc("wrong-again")).status, 401);
  assert.equal((await proxiedRpc(k.token)).status, 429, "locked out even with the right key");
  assert.ok(h.store.listAudit().some((a) => a.action === "a2a.remote.denied"));
  assert.ok(h.store.listAudit().some((a) => a.action === "a2a.remote.locked_out"));
  assert.ok(!h.store.listAudit().some((a) => JSON.stringify(a).includes(k.token) || JSON.stringify(a).includes("wrong-again")));

  // exactly two routes open, by method and exact path. Every registered route is tried through the proxy, with a paired device's token, setting on.
  const routes = (h.app as unknown as { routeTable: () => { method: string; url: string }[] }).routeTable();
  let checked = 0; const opened: string[] = [];
  for (const r of routes) {
    if (r.url.includes("*") || r.method === "HEAD") continue;
    const url = r.url.replace(/:[A-Za-z]+/g, "x");
    const res = await fetch(`${h.base}${url}`, { method: r.method, headers: { ...h.auth, ...PROXY, "x-forwarded-for": `198.51.100.${checked + 1}` }, body: ["GET", "HEAD"].includes(r.method) ? undefined : "{}" });
    const expectOpen = (r.method === "GET" && r.url === CARD_PATH) || (r.method === "POST" && r.url === A2A_PATH) || (r.url === "/mcp" && (r.method === "POST" || r.method === "GET"));
    if (!expectOpen) assert.equal(res.status, 404, `proxied ${r.method} ${r.url} must stay closed`);
    else opened.push(`${r.method} ${r.url}`);
    checked++;
  }
  assert.deepEqual(opened.sort(), [`GET ${CARD_PATH}`, "GET /mcp", `POST ${A2A_PATH}`, "POST /mcp"].sort());
  assert.ok(checked > 60);
  // lookalikes stay closed
  for (const [m, p] of [["POST", "/a2a/"], ["POST", "/a2a/keys"], ["GET", "/a2a/keys"], ["GET", "/a2a/settings"], ["GET", "/a2a"], ["GET", "/.well-known/agent.json"], ["POST", CARD_PATH], ["GET", `${CARD_PATH}/`], ["GET", "/.well-known/"]]) {
    const r = await fetch(`${h.base}${p}`, { method: m, headers: { ...h.auth, ...PROXY, "x-forwarded-for": "198.51.100.200" }, body: m === "POST" ? "{}" : undefined });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  // upgrades through the proxy are still refused before anything else
  const upgraded = await new Promise<number>((resolve, reject) => {
    const r = request(`${h.base}${CARD_PATH}`, { method: "GET", headers: { ...PROXY, upgrade: "websocket", connection: "Upgrade" }, agent: false }, (res) => { res.resume(); resolve(res.statusCode!); });
    r.on("error", reject); r.end();
  });
  assert.equal(upgraded, 404);

  // off again: closed again
  assert.equal((await h.call("PUT", "/a2a/settings", { funnel: false })).body.funnel, false);
  assert.equal((await card()).status, 404);
  assert.equal((await proxiedRpc(k.token)).status, 404);
  await h.app.close();
});

test("4.6: Tailscale serves the two A2A paths only while the setting and Funnel are both on, and they are never reported as stray paths then", async () => {
  const h = await boot();
  h.cli.put("serve.json", mcpServe(h.port));
  assert.equal((await h.call("POST", "/remote/funnel", { on: true })).status, 200);
  const status = async () => (await h.call("GET", "/remote/status?fresh=1")).body as { funnel: { on: boolean; extraPaths: string[]; url?: string } };
  assert.deepEqual((await status()).funnel.extraPaths, []);

  // on: a handler per path, each proxying to the hub's same path
  assert.equal((await h.call("PUT", "/a2a/settings", { funnel: true })).status, 200);
  const handlers = () => h.cli.serve().Web[`${HOST}:443`].Handlers as Record<string, { Proxy: string }>;
  assert.equal(handlers()[A2A_PATH].Proxy, `http://127.0.0.1:${h.port}/a2a`);
  assert.equal(handlers()[CARD_PATH].Proxy, `http://127.0.0.1:${h.port}${CARD_PATH}`);
  assert.equal(handlers()["/mcp"].Proxy, `http://127.0.0.1:${h.port}/mcp`);
  const s = await status();
  assert.equal(s.funnel.on, true);
  assert.deepEqual(s.funnel.extraPaths, [], "our own two paths are not 'extra'");
  const st = (await h.call("GET", "/a2a/status")).body;
  assert.equal(st.reach, "funnel");
  assert.equal(st.endpointUrl, `https://${HOST}/a2a`);
  assert.equal(st.cardUrl, `https://${HOST}${CARD_PATH}`);

  // off: handlers removed, /mcp untouched
  assert.equal((await h.call("PUT", "/a2a/settings", { funnel: false })).status, 200);
  assert.deepEqual(Object.keys(handlers()), ["/mcp"]);
  assert.equal((await status()).funnel.on, true);

  // the same two handlers with the setting off are strays (the owner is told), and the pure reader agrees
  const raw = { ...mcpServe(h.port) } as any;
  raw.Web[`${HOST}:443`].Handlers[A2A_PATH] = { Proxy: `http://127.0.0.1:${h.port}/a2a` };
  assert.deepEqual(readFunnel(raw, h.port).extraPaths, [A2A_PATH]);
  assert.deepEqual(readFunnel(raw, h.port, [A2A_PATH, CARD_PATH]).extraPaths, []);
  raw.Web[`${HOST}:443`].Handlers[A2A_PATH] = { Proxy: "http://127.0.0.1:9999/a2a" };
  assert.deepEqual(readFunnel(raw, h.port, [A2A_PATH]).extraPaths, [A2A_PATH], "a handler aimed anywhere else is never ours");

  // switching Funnel off takes the A2A handlers with it: nothing public is left on the port
  assert.equal((await h.call("PUT", "/a2a/settings", { funnel: true })).status, 200);
  assert.equal((await h.call("POST", "/remote/funnel", { on: false })).status, 200);
  assert.equal(h.cli.serve().Web?.[`${HOST}:443`], undefined);
  assert.equal(h.cli.serve().AllowFunnel?.[`${HOST}:443`], undefined);
  // and Funnel on again brings them back, because the owner's setting is still on
  assert.equal((await h.call("POST", "/remote/funnel", { on: true })).status, 200);
  assert.ok(handlers()[A2A_PATH] && handlers()[CARD_PATH]);
  await h.app.close();
});

test("4.6: if Tailscale won't serve the paths the setting stays off", async () => {
  const h = await boot();
  h.cli.put("serve.json", mcpServe(h.port));
  await h.call("POST", "/remote/funnel", { on: true });
  h.cli.put("path-fails", A2A_PATH);
  const r = await h.call("PUT", "/a2a/settings", { funnel: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /could not serve/);
  assert.equal((await h.call("GET", "/a2a/settings")).body.funnel, false);
  assert.equal((await fetch(`${h.base}${CARD_PATH}`, { headers: PROXY })).status, 404);
  await h.app.close();
});

// ================================================================ ACP: the adapter

const agentFor = (args: string[], over: Partial<AgentConfig> = {}): AgentConfig => ({
  id: "acpfake", name: "Fake ACP", provider: "acp", adapter: "acp", enabled: true, color: "#123456",
  settings: { command: process.execPath, args: [FAKE_ACP, "--acp", ...args] },
  tools: { web: false, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false },
  ...over,
});
const report = (text: string) => JSON.parse(/FAKE_REPORT (\{.*\})/.exec(text)![1]);
const adapter = new AcpAdapter();

test("4.6 AC2: the registry maps the 'acp' kind to the generic adapter", () => {
  assert.ok(adapters.acp instanceof AcpAdapter);
});

test("4.6 AC2: the adapter runs initialize, session/new, session/prompt; the agent reads and writes through us, confined to the task folder", async () => {
  const cwd = tmp("ar-acp-cwd-");
  const chunks: string[] = [];
  const r = await adapter.run({ agent: agentFor([]), prompt: "Do the thing.\n", cwd, onChunk: (c) => chunks.push(c), mcp: { url: "http://127.0.0.1:1/mcp", token: "tok-secret" } });
  assert.equal(r.ok, true, r.error);
  const rep = report(r.text);
  // initialize: fs capabilities declared, no terminal
  assert.deepEqual(rep.caps, { fs: { readTextFile: true, writeTextFile: true } });
  // session/new: cwd is the task folder; the room's MCP server is offered because the agent advertised http MCP
  assert.equal(rep.cwd, cwd);
  assert.deepEqual(rep.mcp, [{ type: "http", name: "agent-room", url: "http://127.0.0.1:1/mcp" }]);
  // streamed chunks reach onChunk, tool calls are logged
  assert.ok(chunks.join("").startsWith("Looking at it. "));
  assert.ok(chunks.some((c) => /\[tool: Writing the deliverable\]/.test(c)));
  assert.ok(chunks.join("").includes("Done. FAKE_REPORT"));
  // the final text is what the agent said; model and usage are what it reported
  assert.match(r.text, /^Looking at it\. Done\./);
  assert.equal(r.model, "fake-model-1");
  assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 45, cacheReadTokens: undefined, costUsd: undefined });
  // confinement: nothing escaped, each refusal is an error to the agent
  assert.equal(rep.outside.dotdot, -32602);
  assert.equal(rep.outside.absolute, -32602);
  assert.equal(rep.outside.git, -32602);
  assert.equal(rep.outside.relative, -32602);
  assert.equal(rep.missing, -32002, "a missing file is 'resource not found'");
  assert.ok(!existsSync(join(cwd, "..", "escape-dotdot.txt")) && !existsSync("/tmp/escape-absolute.txt") && !existsSync(join(cwd, ".git", "config")));
});

test("4.6 AC2: with files switched off, or for a planning call, the agent is told it has no file access; a read gets only what is in the folder", async () => {
  const cwd = tmp("ar-acp-cwd-");
  const off = await adapter.run({ agent: agentFor([], { tools: { web: false, filesystem: false, shell: false, gmail: false, slack: false, drive: false, salesforce: false } }), prompt: "x", cwd });
  assert.equal(off.ok, true, off.error);
  assert.deepEqual(report(off.text).caps, { fs: { readTextFile: false, writeTextFile: false } });
  assert.equal(report(off.text).write, undefined);
  const json = await adapter.run({ agent: agentFor([]), prompt: "x", cwd, jsonOnly: true, mcp: { url: "http://127.0.0.1:1/mcp", token: "t" } });
  assert.deepEqual(report(json.text).caps, { fs: { readTextFile: false, writeTextFile: false } });
  assert.deepEqual(report(json.text).mcp, [], "a planning call gets no tools, MCP included");
});

test("4.6: confineToWorktree: the rules, including a symlink out and the real path of a symlinked worktree", () => {
  const root = tmp("ar-acp-root-");
  const outside = tmp("ar-acp-out-");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(outside, join(root, "link"));
  assert.equal(confineToWorktree(root, join(root, "sub", "a.txt")), join(realpathSync.native(root), "sub", "a.txt"));
  assert.equal(confineToWorktree(root, join(root, "new", "deep", "a.txt")), join(realpathSync.native(root), "new", "deep", "a.txt"));
  for (const bad of ["", undefined, 5, "relative.txt", "../x", join(root, "..", "x"), join(root, "sub", "..", "..", "x"), outside, join(outside, "secret.txt"), join(root, "link", "secret.txt"), join(root, "link"), join(root, ".git", "config"), join(root, "sub", ".GIT", "x"), root, `${root}‮fdp.txt`, join(root, "a\0b")])
    assert.throws(() => confineToWorktree(root, bad), /./, `should refuse ${JSON.stringify(bad)}`);
  // a worktree reached through a symlink: the agent may use either spelling
  const via = join(tmp("ar-acp-via-"), "wt");
  symlinkSync(root, via);
  assert.equal(confineToWorktree(via, join(via, "sub", "a.txt")), join(realpathSync.native(root), "sub", "a.txt"));
  assert.equal(confineToWorktree(via, join(realpathSync.native(root), "sub", "a.txt")), join(realpathSync.native(root), "sub", "a.txt"));
});

test("4.6 AC2: a permission request for a sensitive tool goes to the approvals queue; a switched-off tool is refused; files and web just run", async () => {
  const cwd = tmp("ar-acp-cwd-");
  const asked: { tool: string; action: string; detail: string }[] = [];
  const approve = (yes: boolean) => async (tool: string, action: string, detail: string) => { asked.push({ tool, action, detail }); return yes; };
  const shellOn = { web: false, filesystem: true, shell: true, gmail: false, slack: false, drive: false, salesforce: false };

  const yes = await adapter.run({ agent: agentFor(["--perm"], { tools: shellOn }), prompt: "x", cwd, approve: approve(true) });
  assert.deepEqual(report(yes.text).permission, { outcome: "selected", optionId: "allow-once" }, "never 'always'");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool, "shell");
  assert.equal(asked[0].action, "Run the test suite", "the title the agent gave the tool call");
  assert.match(asked[0].detail, /npm test/);

  const no = await adapter.run({ agent: agentFor(["--perm"], { tools: shellOn }), prompt: "x", cwd, approve: approve(false) });
  assert.deepEqual(report(no.text).permission, { outcome: "selected", optionId: "reject-once" });

  // shell is off for this agent: refused without asking anyone
  asked.length = 0;
  const off = await adapter.run({ agent: agentFor(["--perm"]), prompt: "x", cwd, approve: approve(true) });
  assert.deepEqual(report(off.text).permission, { outcome: "selected", optionId: "reject-once" });
  assert.equal(asked.length, 0);
  // no way to ask (a run that can't): refused
  const mute = await adapter.run({ agent: agentFor(["--perm"], { tools: shellOn }), prompt: "x", cwd });
  assert.deepEqual(report(mute.text).permission, { outcome: "selected", optionId: "reject-once" });
  // a planning call never gets a tool
  const plan = await adapter.run({ agent: agentFor(["--perm"], { tools: shellOn }), prompt: "x", cwd, jsonOnly: true, approve: approve(true) });
  assert.deepEqual(report(plan.text).permission, { outcome: "selected", optionId: "reject-once" });
  assert.equal(asked.length, 0);

  assert.equal(toolForKind("execute"), "shell");
  assert.equal(toolForKind("fetch"), "web");
  assert.equal(toolForKind("edit"), "filesystem");
  assert.equal(toolForKind("think"), undefined);
  assert.equal(pickOption([{ optionId: "a", kind: "allow_always" }, { optionId: "b", kind: "reject_always" }], true), "a");
  assert.equal(pickOption([{ optionId: "a", kind: "allow_once" }], false), undefined);
});

test("4.6 AC2: cancel sends session/cancel and the run ends as cancelled, also while it waits on the owner", async () => {
  const cwd = tmp("ar-acp-cwd-");
  const ctl = new AbortController();
  const t0 = Date.now();
  const run = adapter.run({ agent: agentFor(["--hang"]), prompt: "x", cwd, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 300);
  const r = await run;
  assert.equal(r.ok, false);
  assert.equal(r.error, "Cancelled.");
  assert.ok(Date.now() - t0 < 4000, "the agent answered session/cancel, so nobody waited for the kill timer");
  assert.match(r.text, /Looking at it\./, "what it had said is kept");

  // aborted before it starts
  const pre = new AbortController(); pre.abort();
  assert.equal((await adapter.run({ agent: agentFor(["--hang"]), prompt: "x", cwd, signal: pre.signal })).error, "Cancelled.");

  // aborted while an approval is pending: the permission request is answered 'cancelled' and the run ends
  const ctl2 = new AbortController();
  const shellOn = { web: false, filesystem: true, shell: true, gmail: false, slack: false, drive: false, salesforce: false };
  const waiting = adapter.run({ agent: agentFor(["--perm"], { tools: shellOn }), prompt: "x", cwd, signal: ctl2.signal, approve: () => new Promise<boolean>(() => {}) });
  setTimeout(() => ctl2.abort(), 400);
  const w = await Promise.race([waiting, new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 8000))]);
  assert.notEqual(w, "stuck");
});

test("4.6: the agent's failures come back as errors, never a hang: sign-in, wrong protocol version, stopped early, no command, missing program", async () => {
  const cwd = tmp("ar-acp-cwd-");
  const auth = await adapter.run({ agent: agentFor(["--auth"]), prompt: "x", cwd });
  assert.equal(auth.ok, false);
  assert.match(auth.error!, /sign in/i);
  assert.equal((await adapter.status(agentFor(["--auth"]))).state, "signed_out", "the sidebar says so");
  assert.equal((await adapter.run({ agent: agentFor([]), prompt: "x", cwd })).ok, true);
  assert.equal((await adapter.status(agentFor([]))).state, "ready", "and clears after a good run");

  const old = await adapter.run({ agent: agentFor(["--old-protocol"]), prompt: "x", cwd });
  assert.match(old.error!, /version 99/);
  const max = await adapter.run({ agent: agentFor(["--max-tokens"]), prompt: "x", cwd });
  assert.equal(max.ok, false);
  assert.match(max.error!, /max_tokens/);
  assert.match((await adapter.run({ agent: agentFor([], { settings: {} }), prompt: "x", cwd })).error!, /No command/);
  const gone = await adapter.run({ agent: agentFor([], { settings: { command: join(cwd, "no-such-program"), args: [] } }), prompt: "x", cwd });
  assert.equal(gone.ok, false);
  assert.equal((await adapter.status(agentFor([], { settings: { command: "definitely-not-installed-acp" } }))).state, "not_installed");
  assert.equal((await adapter.status(agentFor([], { settings: {} }))).state, "not_installed");
  // usage in the spellings agents use
  assert.deepEqual(acpUsage({ input_tokens: 3, output_tokens: 4, cost: { amount: 0.5, currency: "USD" } }), { inputTokens: 3, outputTokens: 4, cacheReadTokens: undefined, costUsd: 0.5 });
  assert.equal(acpUsage({}), undefined);
});

// ================================================================ ACP: an agent joins a room

function seedGoal(e: ReturnType<typeof setup>, owner: string, files: string[]) {
  const goalId = id("goal");
  const goal: Goal = {
    id: goalId, roomId: e.room.id, text: "Write the notes", status: "running", createdAt: now(), approvedAt: now(), folder: goalFolder(e.dir, goalId),
    contract: { objective: "Write the notes", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: now(), amendments: [], requirements: [] },
    state: { decisions: [], nextAction: "", progress: newProgress() },
  };
  e.store.saveGoal(goal);
  const task: Task = {
    id: id("task"), roomId: e.room.id, goalId, title: "Write the notes", description: "Write the notes file, carefully.", taskType: "other",
    acceptance: "AC1: Done.", criteria: [{ id: "AC1", text: "Done." }], dependsOn: [], owner, role: "worker",
    files, status: "pending", attempts: 0, history: [], createdAt: now(), updatedAt: now(),
  };
  e.store.saveTask(task);
  return { goalId, taskId: task.id, base: goal.folder! };
}

test("4.6 AC2: an ACP agent joins as an agent, gets a task, writes through us, asks permission (owner approves), and its work is judged and merged like any agent's", async () => {
  const e = setup();
  e.store.saveAgent(agentFor(["--perm"], { tools: { web: false, filesystem: true, shell: true, gmail: false, slack: false, drive: false, salesforce: false } }));
  const { goalId, taskId, base } = seedGoal(e, "acpfake", ["notes.md"]);

  const run = e.orch.advance(goalId).then(async (g) => { await e.orch.idle(); return g; });
  await until(() => e.store.listApprovals("pending").length > 0);
  const pending = e.store.listApprovals("pending");
  assert.equal(pending.length, 1, "the permission request is in the approvals queue");
  assert.equal(pending[0].agentId, "acpfake");
  assert.equal(pending[0].tool, "shell");
  assert.equal(pending[0].action, "Run the test suite");
  assert.equal(pending[0].roomId, e.room.id);
  e.approvals.decide(pending[0].id, "approved");
  const g = await run;

  assert.equal(g.status, "done", g.summary);
  const t = e.store.getTask(taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.assignee, "acpfake");
  assert.ok(t.judgment && t.judgment.verdict === "accept" && t.judgment.judgeAgentId !== "acpfake", "judged by another agent");
  assert.equal(readFileSync(join(base, "notes.md"), "utf8"), "fake-acp wrote notes.md\n", "merged into the goal folder from the task's worktree");
  const rep = report(t.result ?? "");
  assert.equal(rep.write, "ok");
  assert.equal(rep.readBack, "fake-acp wrote notes.md\n");
  assert.equal(rep.readLine, "fake-acp wrote notes.md");
  assert.deepEqual(rep.permission, { outcome: "selected", optionId: "allow-once" });
  assert.deepEqual(Object.values(rep.outside), [-32602, -32602, -32602, -32602], "every path outside the worktree was refused");
  assert.ok(!existsSync(join(base, "..", "escape-dotdot.txt")));
  // reported model and usage reach the routing log and the quota ledger like any agent's
  const rec = e.store.listRouting({ goalId }).find((r) => r.chosen === "acpfake")!;
  assert.equal(rec.modelVersion, "fake-model-1");
  assert.equal(rec.usage?.inputTokens, 120);
  assert.ok(e.store.listAudit().some((a) => a.actor === "acpfake" && a.action === "approval.requested"));
});

test("4.6 AC2: the owner can say no: the agent is told so, and the room goes on", async () => {
  const e = setup();
  e.store.saveAgent(agentFor(["--perm"], { tools: { web: false, filesystem: true, shell: true, gmail: false, slack: false, drive: false, salesforce: false } }));
  const { goalId, taskId } = seedGoal(e, "acpfake", ["notes.md"]);
  const run = e.orch.advance(goalId).then(async (g) => { await e.orch.idle(); return g; });
  await until(() => e.store.listApprovals("pending").length > 0);
  e.approvals.decide(e.store.listApprovals("pending")[0].id, "rejected");
  await run;
  assert.deepEqual(report(e.store.getTask(taskId)!.result ?? "").permission, { outcome: "selected", optionId: "reject-once" });
});

test("4.6 AC2: a task that is stopped cancels the ACP agent", async () => {
  const e = setup();
  e.store.saveAgent(agentFor(["--hang"]));
  const { goalId, taskId } = seedGoal(e, "acpfake", ["notes.md"]);
  const run = e.orch.advance(goalId);
  await until(() => e.store.getTask(taskId)?.status === "running");
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  e.orch.stopRoom(e.room.id);
  await run; await e.orch.idle();
  assert.ok(Date.now() - t0 < 5000, "the run ended on session/cancel");
  assert.equal(e.store.getGoal(goalId)!.status, "failed");
});

// ================================================================ ACP: discovery

const HELP_GEMINI = "Usage: gemini [options]\n\nOptions:\n  --acp   Starts the agent in Agent Client Protocol mode\n  -m, --model  Model\n";
const HELP_OLD_GEMINI = "Usage: gemini [options]\n\nOptions:\n  --experimental-acp   Starts the agent in Agent Client Protocol mode\n";
const HELP_NO_ACP = "Usage: gemini [options]\n\nOptions:\n  -m, --model  Model\n";

test("4.6 AC2: acpLaunchArgs reads how a CLI is started in ACP mode from its --help", () => {
  const gemini = ACP_CLIS.find((c) => c.id === "gemini")!, opencode = ACP_CLIS.find((c) => c.id === "opencode")!;
  assert.deepEqual(acpLaunchArgs(gemini, HELP_GEMINI), ["--acp"]);
  assert.deepEqual(acpLaunchArgs(gemini, HELP_OLD_GEMINI), ["--experimental-acp"]);
  assert.equal(acpLaunchArgs(gemini, HELP_NO_ACP), undefined, "an older CLI without ACP is left alone");
  assert.deepEqual(acpLaunchArgs(opencode, "Commands:\n  opencode acp   start ACP server\n"), ["acp"]);
  assert.equal(acpLaunchArgs(opencode, "Commands:\n  opencode run\n"), undefined);
});

function fakeBin(dir: string, name: string, help: string) {
  // The fake CLI: `--help` prints `help`; `--acp` (or anything else) is the fake ACP agent.
  const helpFile = join(dir, `${name}.help`);
  writeFileSync(helpFile, help);
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in --help) cat "${helpFile}";; *) exec "${process.execPath}" "${FAKE_ACP}" "$@";; esac\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("4.6 AC2: discovery finds a fake `gemini` that advertises ACP and adds it as an 'acp' agent, off and on probation; nothing else claims ACP", async () => {
  const bins = tmp("ar-bins-");
  fakeBin(bins, "gemini", HELP_GEMINI);
  fakeBin(bins, "goose", "goose: no protocol server here\n"); // installed, but no ACP: left alone
  const env = defaultEnv({ home: tmp("ar-home-"), vars: {}, which: async (b) => (existsSync(join(bins, b)) ? join(bins, b) : undefined), ports: { "llama.cpp": 1, ollama: 1, "lm-studio": 1, "vllm-mlx": 1 }, probeTimeoutMs: 300 });

  const found = await probeAcpAgents(env);
  assert.deepEqual(found.map((a) => a.id), ["gemini"]);
  assert.equal(found[0].adapter, "acp");
  assert.deepEqual(found[0].settings, { command: "gemini", args: ["--acp"], protocol: "acp" });
  assert.equal(found[0].defaultEnabled, false);
  const all = await discover(env);
  assert.ok(all.agents.some((a) => a.id === "gemini" && a.installed));
  assert.match(all.summary, /Gemini CLI/);

  const e = setup();
  const svc = new DiscoveryService(e.store, { env, mcpUrl: () => undefined });
  const res = await svc.run();
  assert.ok(res.applied!.created.includes("gemini"));
  const a = e.store.getAgent("gemini")!;
  assert.equal(a.adapter, "acp");
  assert.equal(a.enabled, false, "off until the owner switches it on");
  assert.deepEqual(a.settings, { command: "gemini", args: ["--acp"], protocol: "acp" });
  assert.equal(a.tools.shell, false);
  assert.equal(a.tools.filesystem, true);
  assert.equal(onProbation(e.store, "gemini"), true, "a new agent starts on probation (2.3)");
  assert.ok(!e.store.getAgent("goose"));
  assert.ok(e.store.listAudit().some((x) => x.action === "discovery.agent.created" && /gemini \(acp\)/.test(x.detail)));
  // running discovery again changes nothing
  assert.deepEqual((await svc.run()).applied!.created, []);
});

test("4.6 AC2: the discovered agent does a task, with no adapter written for it: switch it on, and its work is merged", async () => {
  const bins = tmp("ar-bins-");
  fakeBin(bins, "gemini", HELP_GEMINI);
  const env = defaultEnv({ home: tmp("ar-home-"), vars: {}, which: async (b) => (existsSync(join(bins, b)) ? join(bins, b) : undefined), ports: { "llama.cpp": 1, ollama: 1, "lm-studio": 1, "vllm-mlx": 1 }, probeTimeoutMs: 300 });
  const e = setup();
  await new DiscoveryService(e.store, { env, mcpUrl: () => undefined }).run();
  // The owner switches it on and ends its probation (the practice runs are 2.3's business). `gemini` is found on PATH when the task starts.
  const a = e.store.getAgent("gemini")!; e.store.saveAgent({ ...a, enabled: true });
  endProbation(e.store, "gemini", "owner");
  const oldPath = process.env.PATH;
  process.env.PATH = `${bins}${delimiter}${oldPath}`;
  try {
    assert.equal((await adapters.acp.status(e.store.getAgent("gemini")!)).ready, true);
    const { goalId, taskId, base } = seedGoal(e, "gemini", ["gemini-notes.md"]);
    const g = await e.orch.advance(goalId); await e.orch.idle();
    assert.equal(g.status, "done", g.summary);
    assert.equal(e.store.getTask(taskId)!.assignee, "gemini");
    assert.equal(readFileSync(join(base, "gemini-notes.md"), "utf8"), "fake-acp wrote gemini-notes.md\n");
  } finally { process.env.PATH = oldPath; }
});
