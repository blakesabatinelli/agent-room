import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentConfig, RoutingRecord, Task } from "@agent-room/shared";
import { Store } from "../src/db/store.js";
import { Approvals } from "../src/orchestrator/approvals.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { CapacityGovernor } from "../src/capacity/governor.js";
import { ControlFolder } from "../src/control/folder.js";
import { lint } from "../src/control/lint.js";
import { buildServer } from "../src/api/server.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { inbox } from "../src/adapters/mcp.js";
import { quotaFor } from "../src/quota/index.js";
import { discover, defaultEnv, type DiscoveryEnv } from "../src/discovery/index.js";
import { applyDiscovery, platformBlock } from "../src/discovery/apply.js";
import { connectHermes, hermesSnippet, installHermesSkill, SKILL_MARKER } from "../src/discovery/connect.js";
import { canonicalConnector, cleanNeeds, coversNeed, emptyCapabilities } from "../src/discovery/connectors.js";
import { parseClaudeMcpList } from "../src/discovery/claude.js";
import { parseCodexToml } from "../src/discovery/toml.js";
import { needsGate, needsMessage } from "../src/discovery/routing.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { ensureMcpToken } from "../src/discovery/tokens.js";
import { localModelsFor, normalizeMcpReport, sameModel } from "../src/discovery/usage.js";
import { HW, localPairHeaders, setup } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await sleep(15); }
}

// ---------------------------------------------------------------- a fake Mac

interface MachineSpec {
  /** Programs on PATH. */
  bins?: string[];
  /** Output of `<bin> <args>`. Anything not listed fails like a missing command. */
  cmds?: Record<string, { code?: number; stdout?: string; stderr?: string }>;
  /** Answers by full URL, for http://127.0.0.1:<port>/... Anything not listed doesn't answer. */
  http?: Record<string, { status: number; json?: unknown }>;
  /** Files under the fake home folder. */
  files?: Record<string, string>;
  vars?: Record<string, string | undefined>;
}

function machine(spec: MachineSpec = {}): { env: DiscoveryEnv; home: string; asked: string[] } {
  const home = mkdtempSync(join(tmpdir(), "ar-home-"));
  for (const [rel, text] of Object.entries(spec.files ?? {})) { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), text); }
  const asked: string[] = [];
  const env = defaultEnv({
    home, vars: spec.vars ?? {},
    which: async (b) => (spec.bins?.includes(b) ? `/fake/bin/${b}` : undefined),
    run: async (bin, args) => {
      const c = spec.cmds?.[[bin, ...args].join(" ")];
      return c ? { code: c.code ?? 0, stdout: c.stdout ?? "", stderr: c.stderr ?? "" } : { code: 127, stdout: "", stderr: "not found" };
    },
    fetchJson: async (url) => { asked.push(url); return spec.http?.[url]; },
  });
  return { env, home, asked };
}

const CLAUDE_JSON = JSON.stringify({
  oauthAccount: { emailAddress: "blake@example.com" },
  mcpServers: { "claude.ai Gmail": { type: "http" } },
  projects: { "/work/x": { mcpServers: { salesforce: { command: "sf" } } } },
});
const SKILL = (name: string) => `---\nname: ${name}\ndescription: x\n---\nbody\n`;
const SIGNED_IN: MachineSpec = {
  bins: ["claude", "codex"],
  cmds: {
    "claude mcp list": { stdout: "Checking MCP server health...\n\nclaude.ai Snowflake - Cortex Analyst: https://mcp.example.com/sf - ✓ Connected\nramp: https://ramp.example.com - ! Needs authentication\n" },
    "codex login status": { stdout: "Logged in using ChatGPT\n" },
  },
  files: {
    ".claude.json": CLAUDE_JSON,
    ".claude/skills/review/SKILL.md": SKILL("review"),
    ".codex/config.toml": `model = "gpt-5"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n\n[mcp_servers.slack]\ncommand = "x"\nenabled = false\n`,
    ".codex/prompts/ship.md": "ship it\n",
  },
};

const HERMES_YAML = `# Hermes config. Keep this comment.
model:
  default: bonsai-8b
  provider: custom
  base_url: http://localhost:8080/v1
fallback_providers:
  - provider: minimax
    model: MiniMax-M3
mcp_servers:
  # the CRM
  salesforce:
    command: sf-mcp
  old-thing:
    command: nope
    enabled: false
skills:
  external_dirs:
    - ~/shared-skills
`;
const LLAMA: MachineSpec["http"] = {
  "http://127.0.0.1:8080/health": { status: 200, json: { status: "ok" } },
  "http://127.0.0.1:8080/v1/models": { status: 200, json: { data: [{ id: "Bonsai-8B-Q4_0.gguf" }] } },
};
const HERMES_MAC: MachineSpec = {
  bins: ["hermes"], http: LLAMA,
  files: {
    ".hermes/config.yaml": HERMES_YAML,
    ".hermes/skills/research/web-dive/SKILL.md": SKILL("web-dive"),
    "shared-skills/team/brief/SKILL.md": SKILL("brief"),
  },
};

function bare() {
  const dir = mkdtempSync(join(tmpdir(), "ar-disc-"));
  return { dir, store: new Store(join(dir, "t.db")) };
}

// ---------------------------------------------------------------- AC1: Claude Code and Codex, no setup

test("AC1: Claude Code and Codex are found, signed in, with what each can reach", async () => {
  const m = machine(SIGNED_IN);
  const found = await discover(m.env, 1000);
  assert.equal(found.summary, "Found: Claude Code (signed in), Codex (signed in)");
  const claude = found.agents.find((a) => a.id === "claude")!, codex = found.agents.find((a) => a.id === "codex")!;
  assert.deepEqual([claude.installed, claude.signedIn, claude.adapter, claude.defaultEnabled], [true, true, "claude-code", true]);
  assert.match(claude.detail, /blake@example\.com/);
  // User-level and per-project MCP servers, and the account connectors from `claude mcp list`.
  for (const c of ["gmail", "salesforce", "snowflake", "ramp"]) assert.ok(claude.capabilities.connectors.includes(c), `claude has ${c}`);
  assert.ok(claude.capabilities.dataSources.includes("salesforce"));
  assert.deepEqual(claude.capabilities.skills, ["review"]);
  assert.equal(claude.capabilitiesKnown, true);
  // Codex: enabled servers only, prompts as /name.
  assert.deepEqual(codex.capabilities.connectors, ["github"]);
  assert.deepEqual(codex.capabilities.skills, ["/ship"]);
  assert.equal(codex.signedIn, true);
});

test("AC1: nothing installed means nothing is added; an unsigned CLI is reported as such", async () => {
  const none = await discover(machine().env);
  assert.equal(none.summary, "Nothing found yet.");
  const out = machine({ bins: ["claude", "codex"], cmds: { "codex login status": { code: 1, stdout: "Not logged in\n" } }, files: { ".claude.json": "{}" } });
  const f = await discover(out.env);
  assert.equal(f.summary, "Found: Claude Code (not signed in), Codex (not signed in)");
  // When Claude's config can't be read, its capabilities are not claimed (that would switch Room connector tools off).
  const blind = await discover(machine({ bins: ["claude"] }).env);
  assert.equal(blind.agents.find((a) => a.id === "claude")!.capabilitiesKnown, false);
});

test("AC1: applying discovery to a fresh install adds both agents, switched on, and a re-run changes nothing", async () => {
  const { store } = bare();
  const found = await discover(machine(SIGNED_IN).env, 1000);
  const first = await applyDiscovery(store, found);
  assert.deepEqual(first.created.sort(), ["claude", "codex"]);
  for (const id of ["claude", "codex"]) assert.equal(store.getAgent(id)!.enabled, true, `${id} is on with no manual setup`);
  assert.equal(store.getAgent("claude")!.adapter, "claude-code");
  assert.ok(store.getAgent("claude")!.capabilities!.connectors.includes("salesforce"));
  assert.ok(store.listAudit().some((a) => a.action === "discovery.agent.created"));
  const again = await applyDiscovery(store, await discover(machine(SIGNED_IN).env, 2000));
  assert.deepEqual(again, { created: [], updated: [] });
});

test("AC1 end to end: with the real adapters, a fake claude and codex on PATH and a fake home, both are ready in the room", async (t) => {
  const bin = mkdtempSync(join(tmpdir(), "ar-bin-"));
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  script("claude", `if [ "$1" = "mcp" ]; then echo "github: https://x - ✓ Connected"; fi`);
  script("codex", `echo "Logged in using ChatGPT"`);
  const home = mkdtempSync(join(tmpdir(), "ar-home-"));
  writeFileSync(join(home, ".claude.json"), CLAUDE_JSON);
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home; process.env.PATH = `${bin}:/usr/bin:/bin`;
  t.after(() => { process.env.HOME = saved.HOME; process.env.PATH = saved.PATH; });

  const { dir, store } = bare();
  store.setKV("practice_mode", false);
  const found = await discover(defaultEnv({ ports: { "llama.cpp": 1, ollama: 1, "lm-studio": 1, "vllm-mlx": 1 }, probeTimeoutMs: 300 }));
  assert.equal(found.summary, "Found: Claude Code (signed in), Codex (signed in)");
  await applyDiscovery(store, found);
  const orch = new Orchestrator(store, new Approvals(store, 2000), { dataDir: dir, mcpUrl: () => undefined, governor: new CapacityGovernor(store, HW.large) });
  const ready = (await orch.readyAgents()).map((a) => a.id).sort();
  assert.deepEqual(ready, ["claude", "codex"]);
});

test("a switched-off agent stays off, a removed one is not brought back, and nothing is deleted", async () => {
  const { store } = bare();
  await applyDiscovery(store, await discover(machine(SIGNED_IN).env));
  store.saveAgent({ ...store.getAgent("codex")!, enabled: false, name: "My Codex" });
  store.deleteAgent("claude");
  const r = await applyDiscovery(store, await discover(machine(SIGNED_IN).env));
  assert.deepEqual(r.created, [], "the owner's removal is respected");
  assert.equal(store.getAgent("claude"), undefined);
  assert.equal(store.getAgent("codex")!.enabled, false);
  assert.equal(store.getAgent("codex")!.name, "My Codex");
  // Codex disappears from the machine: still there.
  await applyDiscovery(store, await discover(machine().env));
  assert.ok(store.getAgent("codex"));
});

// ---------------------------------------------------------------- AC2: Hermes

test("AC2: Hermes and the llama.cpp server it uses are found; the server is not offered as a second agent", async () => {
  const found = await discover(machine(HERMES_MAC).env);
  const h = found.agents.find((a) => a.id === "hermes")!;
  assert.deepEqual([h.installed, h.adapter, h.defaultEnabled], [true, "mcp", true]);
  assert.deepEqual(h.capabilities.connectors, ["salesforce"], "the disabled server is left out");
  assert.deepEqual(h.capabilities.skills, ["brief", "web-dive"], "its own skills and the external folder");
  assert.match(h.detail, /llama\.cpp/);
  assert.match(h.detail, /minimax/);
  assert.equal(found.servers.length, 1);
  assert.equal(found.servers[0].usedBy, "hermes");
  assert.deepEqual(found.servers[0].models, ["Bonsai-8B-Q4_0.gguf"]);
  assert.ok(!found.agents.some((a) => a.id.startsWith("local-")), "Hermes already uses it");
  assert.equal(found.summary, "Found: Hermes, llama.cpp with Bonsai-8B-Q4_0.gguf (used by Hermes)");
});

test("AC2: Hermes joins over MCP with no manual setup, keeping the owner's comments, with a backup and a private file", async () => {
  const m = machine(HERMES_MAC);
  const cfg = join(m.home, ".hermes/config.yaml");
  chmodSync(cfg, 0o644);
  const url = "http://127.0.0.1:4010/mcp";
  const a = connectHermes(m.env, { url, token: "tok_one", now: new Date("2026-10-23T10:00:00Z") });
  assert.equal(a.status, "connected");
  const text = readFileSync(cfg, "utf8");
  assert.ok(text.includes("# Hermes config. Keep this comment.") && text.includes("# the CRM"), "comments survive");
  const y = parse(text) as { mcp_servers: Record<string, any>; model: { default: string } };
  assert.equal(y.model.default, "bonsai-8b");
  assert.deepEqual(y.mcp_servers["agent-room"], { url, headers: { Authorization: "Bearer tok_one" }, timeout: 120 });
  assert.ok(y.mcp_servers.salesforce, "the owner's other servers are untouched");
  assert.equal(statSync(cfg).mode & 0o777, 0o600, "the file now holds a key, so only the owner reads it");
  const backups = () => readdirSync(join(m.home, ".hermes")).filter((f) => f.includes("agent-room-backup"));
  assert.equal(backups().length, 1);
  assert.equal(readFileSync(join(m.home, ".hermes", backups()[0]), "utf8"), HERMES_YAML);

  // The same again: nothing changes.
  const b = connectHermes(m.env, { url, token: "tok_one", now: new Date("2026-10-23T10:05:00Z") });
  assert.equal(b.status, "unchanged");
  assert.equal(backups().length, 1);
  assert.equal(readFileSync(cfg, "utf8"), text);
  // A new key replaces only the hub's entry, after another backup.
  const c = connectHermes(m.env, { url, token: "tok_two", now: new Date("2026-10-23T10:10:00Z") });
  assert.equal(c.status, "updated");
  assert.equal(backups().length, 2);
  assert.equal((parse(readFileSync(cfg, "utf8")) as any).mcp_servers["agent-room"].headers.Authorization, "Bearer tok_two");
  assert.ok(readFileSync(cfg, "utf8").includes("# the CRM"));
});

test("AC2: a Hermes config that can't be edited safely is left alone and the snippet is handed back", () => {
  const url = "http://127.0.0.1:4010/mcp";
  for (const bad of ["model: [unclosed\n  - x\n", "mcp_servers:\n  - just\n  - a list\n"]) {
    const m = machine({ files: { ".hermes/config.yaml": bad } });
    const r = connectHermes(m.env, { url, token: "tok" });
    assert.equal(r.status, "failed");
    assert.equal(readFileSync(join(m.home, ".hermes/config.yaml"), "utf8"), bad, "untouched");
    assert.ok(r.snippet.includes("agent-room:") && r.snippet.includes("Bearer tok"));
    assert.equal(r.snippet, hermesSnippet(url, "tok"));
  }
  assert.equal(connectHermes(machine().env, { url, token: "t" }).status, "skipped", "no Hermes on this Mac");
  const fresh = machine({ files: { ".hermes/skills/.keep": "" } });
  assert.equal(connectHermes(fresh.env, { url, token: "t" }).status, "connected", "a Hermes with no config yet gets one");
});

test("AC2: the Hermes skill is written once and never over the owner's own edits", () => {
  const m = machine({ files: { ".hermes/config.yaml": "{}\n" } });
  assert.equal(installHermesSkill(m.env), "written");
  assert.equal(installHermesSkill(m.env), "unchanged");
  const p = join(m.home, ".hermes/skills/agent-room/SKILL.md");
  assert.ok(readFileSync(p, "utf8").includes(SKILL_MARKER) && readFileSync(p, "utf8").includes("submit_result"));
  writeFileSync(p, "my own version\n");
  assert.equal(installHermesSkill(m.env), "kept");
  assert.equal(readFileSync(p, "utf8"), "my own version\n");
});

test("AC2: the service joins Hermes with the hub's own key at hub start, honours the setting, and never logs the key", async () => {
  const { store } = bare();
  const m = machine(HERMES_MAC);
  const svc = new DiscoveryService(store, { env: m.env, mcpUrl: () => "http://127.0.0.1:4010/mcp" });
  const cfg = join(m.home, ".hermes/config.yaml");
  const r = await svc.run();
  assert.deepEqual(r.applied!.created, ["hermes"]);
  assert.equal(store.getAgent("hermes")!.enabled, true);
  assert.equal(r.applied!.hermes!.status, "connected");
  const key = Object.entries(store.getKV<Record<string, { agentId: string }>>("mcp_tokens", {})).find(([, v]) => v.agentId === "hermes")![0];
  assert.equal((parse(readFileSync(cfg, "utf8")) as any).mcp_servers["agent-room"].headers.Authorization, `Bearer ${key}`, "the same key the MCP server accepts");
  assert.ok(!JSON.stringify(store.listAudit()).includes(key), "the key is never audited");
  assert.ok(!JSON.stringify(svc.state()).includes(key), "or shown to the apps");
  assert.ok(existsSync(join(m.home, ".hermes/skills/agent-room/SKILL.md")));
  assert.equal(store.listAudit().filter((a) => a.action === "hermes.connected").length, 1);
  // A second run changes nothing.
  assert.equal((await svc.run()).applied!.hermes!.status, "unchanged");
  assert.equal(store.listAudit().filter((a) => a.action === "hermes.connected").length, 1, "quiet when nothing changed");

  // "Connect automatically" off: Hermes is found but its config is not touched.
  const off = machine(HERMES_MAC), s2 = bare().store;
  const svc2 = new DiscoveryService(s2, { env: off.env, mcpUrl: () => "http://127.0.0.1:4010/mcp" });
  svc2.saveSettings({ connectAutomatically: false });
  const r2 = await svc2.run();
  assert.equal(r2.applied!.hermes, undefined);
  assert.equal(readFileSync(join(off.home, ".hermes/config.yaml"), "utf8"), HERMES_YAML);
  // The owner's own button works anyway, and returns the snippet.
  const manual = svc2.connectHermes("owner");
  assert.equal(manual.status, "connected");
  assert.ok(manual.snippet.includes("Bearer"));
  // A Hermes the owner switched off isn't touched by the automatic step.
  const s3 = bare().store, m3 = machine(HERMES_MAC);
  const svc3 = new DiscoveryService(s3, { env: m3.env, mcpUrl: () => "http://127.0.0.1:4010/mcp" });
  svc3.saveSettings({ connectAutomatically: false });
  await svc3.run();
  s3.saveAgent({ ...s3.getAgent("hermes")!, enabled: false });
  svc3.saveSettings({ connectAutomatically: true });
  assert.equal((await svc3.run()).applied!.hermes, undefined);
  assert.equal(readFileSync(join(m3.home, ".hermes/config.yaml"), "utf8"), HERMES_YAML);
});

// ---------------------------------------------------------------- AC4: local model servers

test("AC4: llama.cpp, Ollama, LM Studio and an OpenAI-compatible server on 8000 are found, with their models", async () => {
  const m = machine({
    http: {
      ...LLAMA,
      "http://127.0.0.1:11434/api/tags": { status: 200, json: { models: [{ name: "qwen2.5-coder:7b" }, { name: "llama3.2:3b" }] } },
      "http://127.0.0.1:1234/v1/models": { status: 200, json: { data: [{ id: "gemma-3-4b" }] } },
      "http://127.0.0.1:8000/v1/models": { status: 200, json: { data: [{ id: "mlx-community/Qwen3-4B" }] } },
    },
  });
  const f = await discover(m.env);
  const by = Object.fromEntries(f.servers.map((s) => [`${s.id}:${s.port}`, s]));
  assert.deepEqual(by["llama.cpp:8080"].models, ["Bonsai-8B-Q4_0.gguf"]);
  assert.deepEqual(by["ollama:11434"].models, ["qwen2.5-coder:7b", "llama3.2:3b"]);
  assert.deepEqual(by["lm-studio:1234"].models, ["gemma-3-4b"]);
  assert.deepEqual(by["openai-compatible:8000"].models, ["mlx-community/Qwen3-4B"]);
  assert.equal(by["llama.cpp:8080"].baseUrl, "http://127.0.0.1:8080/v1");
  assert.match(f.summary, /llama\.cpp with Bonsai-8B-Q4_0\.gguf, Ollama with qwen2\.5-coder:7b and 1 more, LM Studio with gemma-3-4b/);
  // No Hermes: each server is offered as an agent that is off until the owner switches it on.
  const ids = f.agents.map((a) => a.id).sort();
  assert.deepEqual(ids, ["claude", "codex", "hermes", "local-llamacpp", "local-lm-studio", "local-ollama", "local-openai-8000"]);
  const { store } = bare();
  await applyDiscovery(store, f);
  const a = store.getAgent("local-llamacpp")!;
  assert.deepEqual([a.adapter, a.enabled, a.settings.locality, a.settings.baseUrl, a.settings.model], ["openai-api", false, "local-model", "http://127.0.0.1:8080/v1", "Bonsai-8B-Q4_0.gguf"]);
  const sub = quotaFor(store).subscriptions().find((s) => s.agentIds.includes("local-llamacpp"))!;
  assert.equal(sub.kind, "local", "free, so the router can prefer it");
});

test("AC4: llama.cpp still loading, the /props fallback, a non-llama server on 8080, and silence", async () => {
  const loading = await discover(machine({ http: { "http://127.0.0.1:8080/health": { status: 503, json: { error: { message: "Loading model" } } } } }).env);
  assert.equal(loading.servers[0].id, "llama.cpp");
  assert.deepEqual(loading.servers[0].models, []);
  assert.equal(loading.agents.some((a) => a.id.startsWith("local-")), false, "no model to offer yet");
  const props = await discover(machine({ http: {
    "http://127.0.0.1:8080/health": { status: 200, json: { status: "ok" } },
    "http://127.0.0.1:8080/props": { status: 200, json: { model_path: "/Users/b/models/qwen2.5-7b-q4.gguf" } },
  } }).env);
  assert.deepEqual(props.servers[0].models, ["qwen2.5-7b-q4.gguf"]);
  const other = await discover(machine({ http: { "http://127.0.0.1:8080/v1/models": { status: 200, json: { data: [{ id: "x-model" }] } } } }).env);
  assert.equal(other.servers[0].id, "openai-compatible");
  assert.equal((await discover(machine().env)).servers.length, 0);
  const junk = await discover(machine({ http: { "http://127.0.0.1:11434/api/tags": { status: 200, json: { nope: true } }, "http://127.0.0.1:1234/v1/models": { status: 404 } } }).env);
  assert.equal(junk.servers.length, 0, "an answer that isn't a model list is not a server");
});

test("AC4: real HTTP on ephemeral ports works, and a server that never answers can't stall discovery", async (t) => {
  const open: Server[] = [];
  const listen = (h: (url: string) => [number, unknown] | undefined) => new Promise<number>((res) => {
    const s = createServer((req, rsp) => { const r = h(req.url ?? ""); if (!r) return; rsp.writeHead(r[0], { "content-type": "application/json" }); rsp.end(JSON.stringify(r[1])); }).listen(0, "127.0.0.1", () => res((s.address() as { port: number }).port));
    open.push(s);
  });
  t.after(() => open.forEach((s) => { s.closeAllConnections(); s.close(); }));
  const llama = await listen((u) => (u === "/health" ? [200, { status: "ok" }] : u === "/v1/models" ? [200, { data: [{ id: "tiny" }] }] : [404, {}]));
  const hung = await listen(() => undefined); // accepts the connection, never replies
  const t0 = Date.now();
  const f = await discover(defaultEnv({ home: mkdtempSync(join(tmpdir(), "ar-home-")), vars: {}, which: async () => undefined, ports: { "llama.cpp": llama, ollama: hung, "lm-studio": 1, "vllm-mlx": 1 }, probeTimeoutMs: 400 }));
  assert.ok(Date.now() - t0 < 3000, "bounded by the probe timeout");
  assert.deepEqual(f.servers.map((s) => [s.id, s.models]), [["llama.cpp", ["tiny"]]]);
});

// ---------------------------------------------------------------- AC5: TOOLS.md lists what each agent can reach

test("AC5: each agent's TOOLS.md lists what it can reach, written once and committed by the hub", async () => {
  const ctx = setup();
  const root = join(ctx.dir, "Agent Room");
  const control = new ControlFolder(root, ctx.store, { watch: false, ownerName: "Blake" });
  await control.init(); control.start();
  ctx.orch.control = control;
  const svc = new DiscoveryService(ctx.store, { env: machine({ ...SIGNED_IN, ...HERMES_MAC, bins: ["claude", "codex", "hermes"], files: { ...SIGNED_IN.files, ...HERMES_MAC.files }, http: LLAMA }).env, control: () => control, mcpUrl: () => undefined });
  svc.saveSettings({ connectAutomatically: false });
  await svc.run();
  const tools = (id: string) => {
    const text = readFileSync(join(root, `agents/${id}/TOOLS.md`), "utf8");
    return { text, fm: parse(/^---\n([\s\S]*?)\n---/.exec(text)![1]) as { platform: Record<string, string[]>; discovered: string } };
  };
  const claude = tools("claude");
  for (const c of ["gmail", "salesforce", "snowflake"]) assert.ok(claude.fm.platform.connectors.includes(c), c);
  assert.ok(claude.fm.platform.data_sources.includes("salesforce"));
  assert.deepEqual(claude.fm.platform.skills, ["review"]);
  assert.deepEqual(claude.fm.platform.tools, ["web", "filesystem", "shell"]);
  assert.ok(claude.fm.discovered, "dated");
  assert.deepEqual(tools("codex").fm.platform.connectors, ["github"]);
  assert.deepEqual(tools("hermes").fm.platform.connectors, ["salesforce"]);
  assert.deepEqual(tools("hermes").fm.platform.skills, ["brief", "web-dive"]);
  assert.deepEqual(lint(root).blocks, [], "the folder is still valid");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  const log = git("log", "--format=%an|%s");
  assert.match(log, /hub\|Discovery: what claude can reach/);
  // A second run with the same facts writes and commits nothing.
  const before = git("rev-list", "--count", "HEAD");
  await svc.run();
  assert.equal(git("rev-list", "--count", "HEAD"), before);
  // The owner's declaration (Muse can't be looked inside) lands in data_sources too.
  assert.equal(await control.setPlatform("claude", platformBlock({ ...emptyCapabilities(), declared: ["ramp"] })), "written");
  assert.deepEqual(tools("claude").fm.platform.data_sources, ["ramp"]);
  control.close();
});

test("AC5: a platform list narrows what the agent may use, so a partial list is a real decision", async () => {
  const ctx = setup();
  ctx.store.saveAgent({ ...ctx.store.getAgent("hermes")!, tools: { ...ctx.store.getAgent("hermes")!.tools, slack: true, salesforce: true } });
  const control = new ControlFolder(join(ctx.dir, "Agent Room"), ctx.store, { watch: false, ownerName: "Blake" });
  await control.init(); control.start();
  ctx.orch.control = control;
  assert.notEqual(control.effectivePermissions("hermes").slack, "off", "the owner has Slack on for Hermes");
  await control.setPlatform("hermes", { connectors: ["salesforce"], data_sources: ["salesforce"], skills: [], tools: [] });
  assert.equal(control.effectivePermissions("hermes").slack, "off", "slack is not in its platform");
  assert.notEqual(control.effectivePermissions("hermes").salesforce, "off");
  control.close();
});

// ---------------------------------------------------------------- AC3: MCP agents report the model and tokens

test("AC3: normalizeMcpReport caps junk, keeps real numbers, and makes a local model free", () => {
  const local = ["Bonsai-8B-Q4_0.gguf", "qwen2.5-coder:7b"];
  const a = normalizeMcpReport("MiniMax-M3", { inputTokens: 1200.9, outputTokens: 300, costUsd: 0.02 }, local);
  assert.deepEqual(a, { model: "MiniMax-M3", usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.02 } });
  const b = normalizeMcpReport("bonsai-8b", { inputTokens: 10, outputTokens: 5, costUsd: 0.37 }, local);
  assert.deepEqual(b, { model: "bonsai-8b", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 } }, "an agent can't bill a local model");
  assert.equal(normalizeMcpReport("qwen2.5-coder:7b", undefined, local).usage?.costUsd, 0);
  assert.deepEqual(normalizeMcpReport(undefined, undefined, local), { model: undefined, usage: undefined });
  const junk = normalizeMcpReport("<script>alert(1)</script>x".repeat(20), { inputTokens: -5, outputTokens: Number.NaN, costUsd: 1e12 }, local);
  assert.ok(junk.model!.length <= 120 && !/[<>]/.test(junk.model!));
  assert.deepEqual(junk.usage, { costUsd: 10_000 });
  assert.ok(sameModel("Bonsai-8B-Q4_0.gguf", "bonsai-8b-q4_0") && sameModel("qwen2.5-coder:7b", "Qwen2.5-Coder:7B"));
  assert.ok(!sameModel("MiniMax-M3", "bonsai-8b") && !sameModel("ab", "ab"), "too short to compare");
});

/** A hub with only Hermes on, joined over MCP, and a fake Mac running Bonsai on llama.cpp. */
async function bootHermes(t: { after: (f: () => void) => void }) {
  const ctx = setup();
  for (const a of ctx.store.listAgents()) ctx.store.saveAgent({ ...a, enabled: a.id === "hermes", adapter: a.id === "hermes" ? "mcp" : a.adapter });
  const m = machine(HERMES_MAC);
  const svc = new DiscoveryService(ctx.store, { env: m.env, mcpUrl: () => undefined });
  svc.saveSettings({ connectAutomatically: false });
  await svc.run();
  const app = await buildServer({ ...ctx, ownerName: "Blake", discovery: svc });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const key = ensureMcpToken(ctx.store, { id: "hermes", name: "Hermes" }).token;
  const client = new Client({ name: "hermes", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  t.after(() => { void client.close(); void app.close(); });
  inbox.seen("hermes");
  /** One piece of work handed to Hermes and handed back with this report. */
  const work = async (goalText: string, report: Record<string, unknown>) => {
    const p = ctx.orch.runGoal(ctx.room.id, goalText);
    const got = JSON.parse(((await client.callTool({ name: "wait_for_assignment", arguments: { timeoutSeconds: 5 } })).content as { text: string }[])[0].text) as { assignmentId: string };
    assert.ok(got.assignmentId, "an assignment arrived");
    await client.callTool({ name: "submit_result", arguments: { assignmentId: got.assignmentId, text: `Done: ${goalText}\n\nSTATUS: done`, ...report } });
    const goal = await p;
    const rec = ctx.store.listRouting({ goalId: goal.id }).at(-1) as RoutingRecord;
    return { goal, rec };
  };
  return { ...ctx, app, base, client, work, svc };
}

test("AC3: Hermes reports MiniMax-M3 and the routing log and the MiniMax subscription see it", async (t) => {
  const e = await bootHermes(t);
  const tools = (await e.client.listTools()).tools;
  const props = (tools.find((x) => x.name === "submit_result")!.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok("model" in props && "usage" in props, "submit_result takes model and usage");
  const { goal, rec } = await e.work("Draft a tagline about venue TV", { model: "MiniMax-M3", usage: { inputTokens: 1500, outputTokens: 400, costUsd: 0.011 } });
  assert.equal(goal.status, "done");
  assert.equal(rec.chosen, "hermes");
  assert.equal(rec.modelVersion, "MiniMax-M3");
  assert.deepEqual([rec.usage?.inputTokens, rec.usage?.outputTokens, rec.usage?.costUsd], [1500, 400, 0.011]);
  const rows = quotaFor(e.store).ledger.since("hermes-minimax", 0);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].tokensIn, rows[0].tokensOut, rows[0].model], [1500, 400, "MiniMax-M3"]);
  assert.equal(quotaFor(e.store).ledger.since("hermes-local", 0).length, 0);
});

test("AC3: Hermes on the local Bonsai model logs $0 even if it claims a price, and lands on the free subscription", async (t) => {
  const e = await bootHermes(t);
  assert.deepEqual(localModelsFor(e.store), ["Bonsai-8B-Q4_0.gguf", "bonsai-8b"]);
  const { rec } = await e.work("Draft a short slogan", { model: "bonsai-8b", usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.37 } });
  assert.equal(rec.modelVersion, "bonsai-8b");
  assert.equal(rec.usage?.costUsd, 0);
  assert.equal(rec.usage?.inputTokens, 900);
  const local = quotaFor(e.store).ledger.since("hermes-local", 0);
  assert.equal(local.length, 1);
  assert.equal(local[0].tokensIn, 900);
  assert.equal(quotaFor(e.store).ledger.since("hermes-minimax", 0).length, 0);
  const sub = quotaFor(e.store).subscriptions().find((s) => s.id === "hermes-local")!;
  assert.equal(quotaFor(e.store).status(sub).free, true);
});

test("AC3: an agent that reports nothing still hands its work back (the ledger estimates, as before)", async (t) => {
  const e = await bootHermes(t);
  const { goal, rec } = await e.work("Say hello in four words", {});
  assert.equal(goal.status, "done");
  assert.equal(rec.modelVersion, undefined);
  assert.ok(e.store.listMessages(e.room.id).some((m) => m.author.id === "hermes"));
});

// ---------------------------------------------------------------- AC6: a task that needs a source only goes to agents that have it

test("AC6: the pure rules: names are matched the way agents name them, and a need is covered or not", () => {
  assert.equal(canonicalConnector("claude.ai Gmail"), "gmail");
  assert.equal(canonicalConnector("Snowflake - Cortex Analyst"), "snowflake");
  assert.equal(canonicalConnector("google-drive"), "drive");
  assert.equal(canonicalConnector("Salesforce - Beta"), "salesforce");
  assert.equal(canonicalConnector("Ramp"), "ramp");
  const caps = { ...emptyCapabilities(), connectors: ["snowflake-cortex-analyst", "gmail"], declared: ["Ramp"] };
  assert.ok(coversNeed(caps, "snowflake") && coversNeed(caps, "Gmail") && coversNeed(caps, "ramp"));
  assert.ok(!coversNeed(caps, "salesforce") && !coversNeed(undefined, "salesforce"));
  assert.deepEqual(cleanNeeds(["Salesforce", "salesforce", 4, "", "Google Drive", { a: 1 }]), ["salesforce", "drive"]);
  assert.deepEqual(cleanNeeds("salesforce"), []);
  assert.equal(cleanNeeds(Array.from({ length: 30 }, (_, i) => `src${i}`)).length, 8);
  assert.deepEqual(parseClaudeMcpList("Checking MCP server health...\n\nclaude.ai Gmail: https://g.example/mcp - ✓ Connected\nlocal one: npx x - ✗ Failed to connect\n"), ["claude.ai Gmail", "local one"]);
  const toml = parseCodexToml(`model = "gpt-5"\n# c\n[mcp_servers.github]\ncommand = "x"\n[mcp_servers."my server"]\nenabled = false\n[mcp_servers.github.env]\nTOKEN = "x"\n[profiles.fast]\nmodel = "other"\n`);
  assert.deepEqual(toml.mcpServers, [{ name: "github", enabled: true }, { name: "my server", enabled: false }]);
  assert.equal(toml.model, "gpt-5");
  assert.deepEqual(parseCodexToml("this is [not toml").mcpServers, []);
});

/** Demo store where only the named agents can reach Salesforce. Claude plans; its plan says every task needs it. */
function needsRoom(has: string[], plannerNeeds: string[] = ["salesforce"], off: string[] = []) {
  const ctx = setup();
  for (const a of ctx.store.listAgents()) {
    const reach = has.includes(a.id);
    ctx.store.saveAgent({
      ...a,
      settings: a.id === "claude" ? { ...a.settings, needs: plannerNeeds } : a.settings,
      capabilities: { ...emptyCapabilities(), ...(reach ? { connectors: ["salesforce"], dataSources: ["salesforce"] } : {}), discoveredAt: 1 },
      tools: { ...a.tools, salesforce: reach && !off.includes(a.id) },
    });
  }
  return ctx;
}

test("AC6: a task that needs Salesforce goes only to the agent that has it, and the routing log says who was left out", async () => {
  const ctx = needsRoom(["hermes"]);
  const base = MockAdapter.calls.length;
  const goal = await ctx.orch.runGoal(ctx.room.id, "Pull the open Salesforce deals and summarize the risks");
  assert.equal(goal.status, "done");
  const tasks = ctx.store.listTasks({ goalId: goal.id }).filter((t: Task) => t.origin === "plan");
  assert.ok(tasks.length >= 2);
  for (const t of tasks) { assert.deepEqual(t.needs, ["salesforce"]); assert.equal(t.assignee, "hermes", `${t.title} went to hermes`); }
  const runs = MockAdapter.calls.slice(base).filter((c) => c.kind === "TASK");
  assert.ok(runs.length >= 2 && runs.every((c) => c.agentId === "hermes"), "claude and codex never ran a task");
  const recs = ctx.store.listRouting({ goalId: goal.id }).filter((r) => r.kind === "task");
  assert.ok(recs.length >= 2);
  for (const r of recs) {
    assert.deepEqual(r.needs, ["salesforce"]);
    assert.deepEqual((r.needsFilteredOut ?? []).map((x) => x.agentId).sort(), ["claude", "codex"]);
    assert.deepEqual(r.needsFilteredOut![0].missing, ["salesforce"]);
    assert.equal(r.chosen, "hermes");
  }
  // The planner was told who can reach what, and asked for needs.
  const plan = MockAdapter.calls.slice(base).find((c) => c.kind === "PLAN" && c.agentId === "claude")!;
  assert.match(plan.prompt, /hermes: .*can reach: salesforce/);
  assert.match(plan.prompt, /"needs"/);
});

test("AC6: a task with no needs is routed as before, to anyone", async () => {
  const ctx = needsRoom(["hermes"], []);
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const recs = ctx.store.listRouting({ goalId: goal.id }).filter((r) => r.kind === "task");
  assert.ok(recs.every((r) => !r.needs && !r.needsFilteredOut));
});

test("AC6: when nobody has the source the task waits, the owner is told once, and nothing runs", async () => {
  const ctx = needsRoom([]);
  const base = MockAdapter.calls.length;
  const p = ctx.orch.runGoal(ctx.room.id, "Pull the open Salesforce deals and summarize the risks");
  const says = () => ctx.store.listMessages(ctx.room.id).filter((m) => m.author.kind === "system" && /Salesforce/.test(m.text));
  await until(() => says().length > 0, "the owner to be told");
  await sleep(700); // the goal keeps looking for an agent; the owner is still told only once
  assert.equal(says().length, 1, "one message");
  assert.match(says()[0].text, /Nobody in the room can reach Salesforce/);
  assert.equal(MockAdapter.calls.slice(base).filter((c) => c.kind === "TASK").length, 0, "no agent ran it");
  const goal = ctx.store.listGoals(ctx.room.id)[0];
  const held = ctx.store.listTasks({ goalId: goal.id }).filter((t: Task) => t.origin === "plan");
  assert.ok(held.length >= 2 && held.every((t: Task) => t.status === "pending"), "every planned task is still waiting");
  const noted = held.filter((t: Task) => t.history?.some((h) => h.outcome === "blocked" && h.agentId === "hub" && /salesforce/.test(h.note)));
  assert.ok(noted.length >= 1, "the task that could have started says why it didn't");
  ctx.orch.stopRoom(ctx.room.id);
  await p;
});

test("AC6: an agent that has the source but has it switched off is named, and switching it on lets the work through", async () => {
  const ctx = needsRoom(["hermes"], ["salesforce"], ["hermes"]);
  const p = ctx.orch.runGoal(ctx.room.id, "Pull the open Salesforce deals and summarize the risks");
  const says = () => ctx.store.listMessages(ctx.room.id).filter((m) => m.author.kind === "system" && /switched off/.test(m.text));
  await until(() => says().length > 0, "the owner to be told");
  assert.match(says()[0].text, /Hermes can reach Salesforce, but it is switched off for it/);
  ctx.store.saveAgent({ ...ctx.store.getAgent("hermes")!, tools: { ...ctx.store.getAgent("hermes")!.tools, salesforce: true } });
  const goal = await p;
  assert.equal(goal.status, "done");
  assert.ok(ctx.store.listTasks({ goalId: goal.id }).filter((t: Task) => t.origin === "plan").every((t: Task) => t.assignee === "hermes"));
});

test("AC6: needsGate and needsMessage on their own", () => {
  const mk = (id: string, connectors: string[], tools: Record<string, boolean> = {}): AgentConfig => ({ id, name: id.toUpperCase(), provider: id, adapter: "mock", enabled: true, color: "#000", settings: {}, tools: { web: true, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false, ...tools }, capabilities: { ...emptyCapabilities(), connectors, dataSources: connectors } });
  const agents = [mk("a", ["salesforce"], { salesforce: true }), mk("b", ["salesforce"]), mk("c", ["gmail"], { gmail: true }), { ...mk("d", []), capabilities: undefined }];
  assert.equal(needsGate({ roomId: "r" }, agents), undefined);
  assert.equal(needsGate({ roomId: "r", needs: [] }, agents), undefined);
  const g = needsGate({ roomId: "r", needs: ["Salesforce"] }, agents)!;
  assert.deepEqual([...g.ok], ["a"]);
  assert.deepEqual(g.switchedOff, [{ agentId: "b", need: "salesforce" }]);
  assert.deepEqual(g.filteredOut.map((f) => f.agentId).sort(), ["b", "c", "d"]);
  const two = needsGate({ roomId: "r", needs: ["salesforce", "gmail"] }, agents)!;
  assert.equal(two.ok.size, 0, "needs are all required");
  assert.deepEqual(two.nobody, []);
  const none = needsGate({ roomId: "r", needs: ["snowflake"] }, agents)!;
  assert.deepEqual(none.nobody, ["snowflake"]);
  assert.match(needsMessage(none, "Pull the numbers", agents), /Nobody in the room can reach Snowflake, which "Pull the numbers" needs/);
  assert.ok(!/—/.test(needsMessage(none, "x", agents)), "no em dashes in what the owner reads");
});

// ---------------------------------------------------------------- AC2: Muse joins with one pairing step; the API

async function bootApi(tailscaleState: "running" | "stopped" = "running") {
  const ctx = setup();
  const tailscale = { status: async () => ({ state: tailscaleState, ip: "100.64.0.9", dnsName: tailscaleState === "running" ? "blakes-mac.tail1234.ts.net" : undefined, funnel: { on: false, extraPaths: [] }, detail: "", checkedAt: Date.now() }) } as any;
  const svc = new DiscoveryService(ctx.store, { env: machine(SIGNED_IN).env, mcpUrl: () => undefined });
  svc.saveSettings({ connectAutomatically: false });
  const app = await buildServer({ ...ctx, ownerName: "Blake", tailscale, discovery: svc });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const { token } = (await (await fetch(`${base}/pair/local`, { method: "POST", headers: localPairHeaders(ctx.dir), body: "{}" })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { ...ctx, app, base, call, svc };
}

test("AC2: Muse joins from its tailnet device with one pairing step", async (t) => {
  const e = await bootApi();
  t.after(() => { void e.app.close(); });
  assert.equal(e.store.getAgent("muse"), undefined);
  const r = await e.call("POST", "/agents/muse/invite");
  assert.equal(r.status, 200);
  assert.equal(r.body.agentId, "muse");
  assert.ok(e.store.getAgent("muse"), "created by the invite");
  assert.equal(e.store.getAgent("muse")!.adapter, "mcp");
  assert.match(r.body.url, /^http:\/\/blakes-mac\.tail1234\.ts\.net:\d+\/mcp$/);
  assert.ok(r.body.block.includes(r.body.url) && r.body.block.includes(`Bearer ${r.body.token}`) && r.body.block.includes("wait_for_assignment"));
  assert.match(r.body.instructions, /model/);
  // The key is real: Muse can use it right away.
  const client = new Client({ name: "muse", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${e.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${r.body.token}` } } }));
  assert.ok((await client.listTools()).tools.some((x) => x.name === "submit_result"));
  await client.close();
  // Asking again hands back the same key, not a new one that would cut Muse off.
  assert.equal((await e.call("POST", "/agents/muse/invite")).body.token, r.body.token);
  assert.ok(e.store.listAudit().some((a) => a.action === "agent.invite" && a.detail === "muse"));
  assert.ok(!e.store.listAudit().some((a) => a.detail.includes(r.body.token)));
  assert.equal((await e.call("POST", "/agents/nobody/invite")).status, 404);
});

test("AC2: with Tailscale down the invite says what to do instead of handing out an address that won't work", async (t) => {
  const e = await bootApi("stopped");
  t.after(() => { void e.app.close(); });
  const r = await e.call("POST", "/agents/muse/invite");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Tailscale/);
});

test("discovery API: state, run, settings, the Hermes button, and declared data sources", async (t) => {
  const e = await bootApi();
  t.after(() => { void e.app.close(); });
  const s0 = await e.call("GET", "/discovery");
  assert.deepEqual([s0.body.last, s0.body.settings.connectAutomatically, s0.body.running], [null, false, false]);
  const run = await e.call("POST", "/discovery/run");
  assert.equal(run.status, 200);
  assert.match(run.body.last.summary, /^Found: Claude Code \(signed in\), Codex \(signed in\)/);
  assert.equal((await e.call("GET", "/discovery")).body.last.summary, run.body.last.summary);
  assert.equal((await e.call("PUT", "/discovery/settings", { connectAutomatically: true })).body.settings.connectAutomatically, true);
  assert.equal((await e.call("PUT", "/discovery/settings", { connectAutomatically: "yes" })).status, 400);
  // No Hermes on this fake Mac: the button explains rather than crashing.
  const hermes = await e.call("POST", "/discovery/hermes/connect");
  assert.ok([200, 404].includes(hermes.status));

  // The owner says Muse has Salesforce (discovery can't look inside it); routing and TOOLS.md follow.
  await e.call("POST", "/agents/muse/invite");
  const put = await e.call("PUT", "/agents/muse/capabilities", { declared: ["Salesforce", "salesforce", "Snowflake"] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.capabilities.declared, ["salesforce", "snowflake"]);
  assert.ok(coversNeed(e.store.getAgent("muse")!.capabilities, "salesforce"));
  assert.equal((await e.call("PUT", "/agents/muse/capabilities", { declared: "nope" })).status, 400);
  assert.equal((await e.call("PUT", "/agents/ghost/capabilities", { declared: [] })).status, 404);
  // A later discovery run does not wipe the declaration.
  await e.svc.run();
  assert.deepEqual(e.store.getAgent("muse")!.capabilities!.declared, ["salesforce", "snowflake"]);
  const rec = e.store.listAudit().find((a) => a.action === "agent.capabilities");
  assert.ok(rec && rec.actor === "owner");
});
