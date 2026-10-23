#!/usr/bin/env node
// A small ACP agent for tests (item 4.6): JSON-RPC 2.0 over stdio, one JSON message per line, written from the protocol pages at
// https://agentclientprotocol.com/protocol/ (initialization, session-setup, prompt-turn, tool-calls, file-system, transports).
//
// Modes, from its arguments (the hub starts it as `node fake-acp-agent.mjs --acp [--mode=...]`):
//   (none)           reads the task, writes the files the task allows through fs/write_text_file, reads one back, tries two writes outside the folder,
//                    and ends with the STATUS block the orchestrator expects.
//   --perm           also asks session/request_permission for an `execute` tool and reports what it was told.
//   --perm-kind=K    with --perm: the permission request is for a tool of kind K (delete, move, ...) with a path as its input, not for `npm test`.
//   --perm-long      with --perm: the shell command is a long one that hides `rm -rf x` after 400 characters of padding.
//   --hang           streams one chunk, then waits for session/cancel and answers the prompt with stopReason "cancelled".
//   --auth           session/new fails with "authentication required" (-32000).
//   --max-tokens     ends the turn with stopReason "max_tokens".
//   --help           prints what a real CLI prints when it can speak ACP.
// The report of what the client allowed goes into the reply as one line: FAKE_REPORT {json}.
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write("fake-acp-agent\n\nOptions:\n  --acp   Start the agent in Agent Client Protocol mode\n  --help  Show help\n");
  process.exit(0);
}
const flag = (f) => argv.includes(f);

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
const notify = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

const state = { cwd: "", caps: {}, mcp: [], cancelWake: null, cancelled: false };
const SESSION = "sess_fake_1";

async function prompt(params) {
  const text = (params.prompt ?? []).map((b) => b.text ?? "").join("\n");
  notify(SESSION, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking at it. " } });
  if (flag("--hang")) {
    await new Promise((r) => { state.cancelWake = r; });
    return { stopReason: "cancelled" };
  }
  if (flag("--max-tokens")) return { stopReason: "max_tokens" };

  const report = { caps: state.caps, mcp: state.mcp.map((m) => ({ type: m.type, name: m.name, url: m.url })), cwd: state.cwd };
  const isTask = text.includes("# Your task:");
  const allowed = isTask ? (text.match(/You may create or change only: (.+?)\. Read anything else/)?.[1]?.split(", ") ?? []) : [];
  const ids = [...new Set([...text.matchAll(/^(AC\d+):/gm)].map((m) => m[1]))];

  notify(SESSION, { sessionUpdate: "tool_call", toolCallId: "call_fs", title: "Writing the deliverable", kind: "edit", status: "pending" });
  for (const f of allowed) {
    const r = await ask("fs/write_text_file", { sessionId: SESSION, path: join(state.cwd, f), content: `fake-acp wrote ${f}\n` });
    report.write = r.error ? { error: r.error.code } : "ok";
  }
  if (allowed[0]) {
    const r = await ask("fs/read_text_file", { sessionId: SESSION, path: join(state.cwd, allowed[0]) });
    report.readBack = r.result?.content ?? { error: r.error?.code };
    const part = await ask("fs/read_text_file", { sessionId: SESSION, path: join(state.cwd, allowed[0]), line: 1, limit: 1 });
    report.readLine = part.result?.content ?? { error: part.error?.code };
  }
  const missing = await ask("fs/read_text_file", { sessionId: SESSION, path: join(state.cwd, "no-such-file.txt") });
  report.missing = missing.error ? missing.error.code : "read";
  const up = await ask("fs/write_text_file", { sessionId: SESSION, path: join(state.cwd, "..", "escape-dotdot.txt"), content: "x" });
  const abs = await ask("fs/write_text_file", { sessionId: SESSION, path: "/tmp/escape-absolute.txt", content: "x" });
  const git = await ask("fs/write_text_file", { sessionId: SESSION, path: join(state.cwd, ".git", "config"), content: "x" });
  const rel = await ask("fs/read_text_file", { sessionId: SESSION, path: "relative/path.txt" });
  report.outside = { dotdot: up.error ? up.error.code : "written", absolute: abs.error ? abs.error.code : "written", git: git.error ? git.error.code : "written", relative: rel.error ? rel.error.code : "read" };
  notify(SESSION, { sessionUpdate: "tool_call_update", toolCallId: "call_fs", status: "completed" });

  if (flag("--perm")) {
    const kindArg = argv.find((a) => a.startsWith("--perm-kind="))?.slice("--perm-kind=".length);
    const kind = kindArg ?? "execute";
    const rawInput = kindArg ? { path: "notes/old.md" } : { command: flag("--perm-long") ? `echo ${"x".repeat(400)}; rm -rf important` : "npm test" };
    const title = kindArg ? "Tidy up" : "Run the test suite";
    notify(SESSION, { sessionUpdate: "tool_call", toolCallId: "call_sh", title, kind, status: "pending" });
    const r = await ask("session/request_permission", {
      sessionId: SESSION,
      toolCall: { toolCallId: "call_sh", rawInput },
      options: [{ optionId: "allow-always", name: "Always allow", kind: "allow_always" }, { optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
    });
    report.permission = r.result?.outcome ?? { error: r.error?.code };
  }

  const block = isTask ? `\nSTATUS: done\n${ids.map((k) => `${k}: PASS — see FAKE_REPORT`).join("\n")}\nOUT_OF_SCOPE: none` : "";
  const out = `Done. FAKE_REPORT ${JSON.stringify(report)}${block}`;
  notify(SESSION, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: out } });
  return { stopReason: "end_turn", _meta: { usage: { inputTokens: 120, outputTokens: 45 } } };
}

async function handle(m) {
  switch (m.method) {
    case "initialize":
      state.caps = m.params?.clientCapabilities ?? {};
      return { protocolVersion: flag("--old-protocol") ? 99 : 1, agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: { http: true, sse: false } }, agentInfo: { name: "fake-acp-agent", title: "Fake ACP agent", version: "0.0.1" }, authMethods: [] };
    case "session/new":
      if (flag("--auth")) throw Object.assign(new Error("Authentication required"), { code: -32000 });
      state.cwd = m.params.cwd; state.mcp = m.params.mcpServers ?? [];
      return { sessionId: SESSION, models: { currentModelId: "fake-model-1", availableModels: [{ modelId: "fake-model-1", name: "Fake model" }] } };
    case "session/prompt": return prompt(m.params);
    default: throw Object.assign(new Error("Method not found"), { code: -32601 });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "session/cancel") { state.cancelled = true; state.cancelWake?.(); return; }
  if (m.method) {
    handle(m).then(
      (result) => send({ jsonrpc: "2.0", id: m.id, result }),
      (e) => send({ jsonrpc: "2.0", id: m.id, error: { code: e.code ?? -32603, message: e.message } }),
    );
    return;
  }
  const w = waiting.get(m.id);
  if (w) { waiting.delete(m.id); w(m); }
});
rl.on("close", () => process.exit(0));
