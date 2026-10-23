import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { TOOLS, type RunUsage } from "@agent-room/shared";
import type { Adapter, AdapterStatus, RunRequest, RunResult } from "./types.js";
import { which } from "./proc.js";
import { PathDenied, assertPlainPath, isInside, resolveInGrant, touchesGit } from "../files/paths.js";

/**
 * 4.6 Generic adapter for any agent that speaks the Agent Client Protocol (ACP, Zed's open protocol between a client and a coding agent).
 * One adapter, no per-agent glue: settings.command is the program and settings.args how to start it in ACP mode, for example
 * `gemini --acp`, `qwen --acp`, `opencode acp`, `goose acp`, `kimi acp`.
 *
 * Sources (read 2026-10-23):
 *  - Overview, initialization, session setup, prompt turn, tool calls, file system, transports (stdio):
 *      https://agentclientprotocol.com/protocol/overview   (and /initialization, /session-setup, /prompt-turn, /tool-calls, /file-system, /transports)
 *  - Agents that speak it, and how each is started (the registry): https://agentclientprotocol.com/overview/agents
 *      https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json  (gemini: --acp, qwen-code: --acp, opencode / goose / kimi: acp)
 *      Claude Code and Codex speak it through Zed's adapters (claude-agent-acp, codex-acp); the hub drives those two directly instead.
 *
 * Wire: JSON-RPC 2.0 over the child's stdin and stdout, one JSON message per line (UTF-8, no embedded newlines); stderr is the agent's log.
 *
 * What the room does as the ACP client:
 *  - initialize (protocolVersion 1) declaring fs.readTextFile and fs.writeTextFile, so the agent reads and writes files through us. No terminal capability:
 *    shell work happens inside the agent's own process, behind the permission gate below.
 *  - session/new with cwd = the task's worktree, and the room's MCP server when the agent can take an HTTP one.
 *  - session/prompt with the task prompt. session/update chunks stream to onChunk; tool calls are logged as "[tool: title]".
 *  - fs/read_text_file and fs/write_text_file only inside the worktree (files/paths.ts: no `..`, no symlink out, no .git). Writes land in the
 *    worktree, so the judge and the merge treat them like any other agent's work.
 *  - session/request_permission goes through the hub's approvals (RunRequest.approve): a tool that is switched off is refused, a sensitive one asks the owner.
 *  - session/cancel when the run is aborted.
 */

export const ACP_PROTOCOL_VERSION = 1;
const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 5 * 1024 * 1024;
const GRACE_MS = 5000;

class RpcFail extends Error { constructor(public code: number, message: string) { super(message); } }
const INVALID_PARAMS = -32602, METHOD_NOT_FOUND = -32601, NOT_FOUND = -32002, AUTH_REQUIRED = -32000;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The room tool an ACP tool call counts as. `undefined` for kinds that say nothing about what they touch (other, think, switch_mode). */
export function toolForKind(kind: string): string | undefined {
  switch (kind) {
    case "execute": return "shell";
    case "fetch": return "web";
    case "read": case "search": case "edit": case "delete": case "move": return "filesystem";
    default: return undefined;
  }
}

export interface PermissionOption { optionId: string; name?: string; kind?: string }
/** The option to answer with: an "allow once" for yes (never an "always": the owner's yes is for this call), a "reject" for no. */
export function pickOption(options: PermissionOption[], allow: boolean): string | undefined {
  const order = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of order) { const o = options.find((x) => x.kind === k); if (o) return o.optionId; }
  return undefined;
}

/** Token and cost figures an agent reported, in whichever spelling it used. ACP's PromptResponse has no usage field, so this reads `usage` or `_meta.usage` when an agent adds one. */
export function acpUsage(u: unknown): RunUsage | undefined {
  const x = obj(u);
  const cost = obj(x.cost);
  const out = {
    inputTokens: num(x.inputTokens) ?? num(x.input_tokens), outputTokens: num(x.outputTokens) ?? num(x.output_tokens),
    cacheReadTokens: num(x.cachedReadTokens) ?? num(x.cacheReadTokens) ?? num(x.cached_read_tokens),
    costUsd: num(x.costUsd) ?? (cost.currency === "USD" ? num(cost.amount) : undefined),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/**
 * A path the agent sent, as a real path inside the task's worktree, or PathDenied. The agent was told the worktree as its cwd, so an absolute path under it
 * (under its real path too, for a worktree that sits behind a symlink such as /var on a Mac) is the only thing accepted.
 */
export function confineToWorktree(cwd: string, p: unknown): string {
  if (typeof p !== "string" || !p) throw new PathDenied("a path is required");
  if (!isAbsolute(p)) throw new PathDenied("the path must be absolute");
  assertPlainPath(p);
  const lexicalRoot = resolve(cwd);
  let root: string;
  try { root = realpathSync.native(lexicalRoot); } catch { throw new PathDenied("the task folder is not available"); }
  const target = resolve(p);
  const base = isInside(lexicalRoot, target) ? lexicalRoot : isInside(root, target) ? root : undefined;
  if (!base) throw new PathDenied("the path is outside the task folder");
  const rel = relative(base, target);
  if (!rel) throw new PathDenied("that is the task folder itself, not a file");
  if (touchesGit(rel)) throw new PathDenied("version-control files are off limits");
  return resolveInGrant(root, rel);
}

/** What an ACP agent said in the last turn that we keep: nothing here leaves the run. */
interface Turn { sessionId: string; text: string; usage?: RunUsage; model?: string; cancelled: boolean; tools: Map<string, { title: string; kind: string }> }

/** JSON-RPC 2.0 over a child's stdio, both directions. */
class Peer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  closed = false;
  constructor(
    private child: ChildProcess,
    private onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    private onNotify: (method: string, params: Record<string, unknown>) => void,
  ) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (line) this.line(line); }
    });
    child.stdin!.on("error", () => { /* the agent went away; close() reports it */ });
    const end = () => this.close(new Error("The agent stopped before it answered."));
    child.on("close", end); child.on("error", end);
  }

  private close(why: Error) {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(why);
    this.pending.clear();
  }

  private write(m: object) { if (!this.closed) { try { this.child.stdin!.write(JSON.stringify(m) + "\n"); } catch { /* closed */ } } }

  request<T = Record<string, unknown>>(method: string, params: object): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("The agent stopped before it answered."));
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: object) { this.write({ jsonrpc: "2.0", method, params }); }

  private line(line: string) {
    let m: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try { m = JSON.parse(line); } catch { return; } // not JSON-RPC: ignore (an agent must not print anything else to stdout, but some do)
    if (!m || typeof m !== "object") return;
    if (typeof m.method === "string") {
      const params = obj(m.params);
      if (m.id === undefined || m.id === null) { try { this.onNotify(m.method, params); } catch { /* a bad update never stops the run */ } return; }
      const id = m.id;
      this.onRequest(m.method, params).then(
        (result) => this.write({ jsonrpc: "2.0", id, result: result ?? {} }),
        (e) => this.write({ jsonrpc: "2.0", id, error: { code: e instanceof RpcFail ? e.code : e instanceof PathDenied ? INVALID_PARAMS : -32603, message: e instanceof Error ? e.message : "Error" } }),
      );
      return;
    }
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message ?? "The agent reported an error."), { code: m.error.code }));
      else p.resolve(m.result ?? {});
    }
  }
}

/** Agents that last said they need signing in, so the sidebar can say so. Cleared by the next good run. */
const needsSignIn = new Map<string, string>();

export class AcpAdapter implements Adapter {
  async status(agent: RunRequest["agent"]): Promise<AdapterStatus> {
    const cmd = str(agent.settings.command);
    if (!cmd) return { ready: false, state: "not_installed", detail: "No command configured." };
    const p = await which(cmd);
    if (!p) return { ready: false, state: "not_installed", detail: `${cmd} not found on PATH.` };
    const auth = needsSignIn.get(agent.id);
    if (auth) return { ready: false, state: "signed_out", detail: auth };
    return { ready: true, state: "ready", detail: `${cmd} at ${p}. Speaks ACP.` };
  }

  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    const s = req.agent.settings as { command?: string; args?: unknown; timeoutMinutes?: number };
    const fail = (error: string, extra: Partial<RunResult> = {}): RunResult => ({ ok: false, text: "", durationMs: Date.now() - t0, error: error.slice(0, 2000), ...extra });
    if (!str(s.command)) return fail("No command configured.");
    const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [];
    const cwd = resolve(req.cwd);

    let child: ChildProcess;
    let stderr = "";
    try { child = spawn(s.command!, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return fail(String(e)); }
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => { stderr = (stderr + d).slice(-4000); });
    child.on("error", (e) => { stderr += String(e); });
    const exited = new Promise<void>((r) => { child.once("close", () => r()); child.once("error", () => r()); });

    const turn: Turn = { sessionId: "", text: "", cancelled: false, tools: new Map() };
    const fsOn = !req.jsonOnly && !!req.agent.tools.filesystem;
    let aborted: () => void = () => {};
    const abortedP = new Promise<"aborted">((r) => { aborted = () => r("aborted"); });

    const peer = new Peer(child, (method, params) => this.clientRequest(method, params, req, turn, fsOn, abortedP), (method, params) => this.update(method, params, req, turn));

    let killTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      if (turn.cancelled) return;
      turn.cancelled = true; aborted();
      if (turn.sessionId) peer.notify("session/cancel", { sessionId: turn.sessionId });
      // The agent should answer the prompt with stopReason "cancelled"; one that doesn't is stopped.
      killTimer = setTimeout(() => child.kill("SIGTERM"), turn.sessionId ? GRACE_MS : 0);
      killTimer.unref?.();
    };
    req.signal?.addEventListener("abort", cancel);
    const limit = setTimeout(cancel, Math.max(1, Number(s.timeoutMinutes ?? 30)) * 60_000);
    limit.unref?.();
    if (req.signal?.aborted) cancel();

    let stop = "";
    try {
      const init = await peer.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: fsOn, writeTextFile: fsOn } },
        clientInfo: { name: "agent-room", title: "Agent Room", version: "1" },
      });
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) return fail(`The agent speaks ACP version ${String(init.protocolVersion)}; Agent Room speaks ${ACP_PROTOCOL_VERSION}.`);
      const caps = obj(init.agentCapabilities);
      const http = obj(caps.mcpCapabilities).http === true;
      const created = await peer.request("session/new", {
        cwd,
        mcpServers: !req.jsonOnly && req.mcp && http ? [{ type: "http", name: "agent-room", url: req.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${req.mcp.token}` }] }] : [],
      });
      turn.sessionId = str(created.sessionId) ?? "";
      if (!turn.sessionId) return fail("The agent didn't start a session.");
      turn.model = str(obj(created.models).currentModelId) ?? str(obj(created._meta).model);
      if (turn.cancelled) peer.notify("session/cancel", { sessionId: turn.sessionId });
      const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
      const done = await peer.request("session/prompt", { sessionId: turn.sessionId, prompt: [{ type: "text", text: prompt }] });
      stop = str(done.stopReason) ?? "";
      turn.usage = acpUsage(done.usage) ?? acpUsage(obj(done._meta).usage) ?? turn.usage;
      turn.model = str(obj(done._meta).model) ?? turn.model;
      needsSignIn.delete(req.agent.id);
    } catch (e) {
      const err = e as Error & { code?: number };
      if (err.code === AUTH_REQUIRED) {
        const detail = `${s.command} needs you to sign in. Open Terminal, run ${s.command}${args.length ? "" : ""} once and sign in, then try again.`;
        needsSignIn.set(req.agent.id, detail);
        return fail(detail);
      }
      if (turn.cancelled) return fail("Cancelled.", { text: turn.text.trim() });
      return fail(`${err.message}${stderr.trim() ? `\n${stderr.trim().split("\n").slice(-6).join("\n")}` : ""}`);
    } finally {
      clearTimeout(limit); clearTimeout(killTimer);
      req.signal?.removeEventListener("abort", cancel);
      try { child.stdin!.end(); } catch { /* already closed */ }
      const kill = setTimeout(() => child.kill("SIGTERM"), 2000); kill.unref?.();
      await exited; clearTimeout(kill);
    }

    const text = turn.text.trim();
    const meta = { ...(turn.usage ? { usage: turn.usage } : {}), ...(turn.model ? { model: turn.model } : {}) };
    if (stop === "cancelled" || turn.cancelled) return fail("Cancelled.", { text, ...meta });
    if (stop !== "end_turn") return fail(`The agent stopped early (${stop || "no reason given"}).`, { text, ...meta });
    if (!text) return fail("The agent finished without an answer.", meta);
    return { ok: true, text, durationMs: Date.now() - t0, ...meta };
  }

  /** session/update: the agent's text, its tool calls, and what it says about itself. */
  private update(method: string, params: Record<string, unknown>, req: RunRequest, turn: Turn) {
    if (method !== "session/update") return;
    const u = obj(params.update);
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = obj(u.content);
        if (c.type === "text" && typeof c.text === "string") { turn.text += c.text; req.onChunk?.(c.text); }
        break;
      }
      case "tool_call": {
        const id = str(u.toolCallId); const title = str(u.title) ?? "tool";
        if (id) turn.tools.set(id, { title, kind: str(u.kind) ?? "other" });
        req.onChunk?.(`\n[tool: ${title}]\n`);
        break;
      }
      case "tool_call_update": {
        const id = str(u.toolCallId); const known = id ? turn.tools.get(id) : undefined;
        if (id && known) turn.tools.set(id, { title: str(u.title) ?? known.title, kind: str(u.kind) ?? known.kind });
        if (u.status === "failed") req.onChunk?.(`\n[tool failed: ${str(u.title) ?? known?.title ?? "tool"}]\n`);
        break;
      }
      case "usage_update": turn.usage = acpUsage(u.usage ?? u) ?? turn.usage; break;
      default: break; // agent_thought_chunk, plan, available_commands_update, current_mode_update: nothing the room keeps
    }
  }

  /** Requests from the agent to us, the client. */
  private async clientRequest(method: string, params: Record<string, unknown>, req: RunRequest, turn: Turn, fsOn: boolean, aborted: Promise<"aborted">): Promise<unknown> {
    switch (method) {
      case "fs/read_text_file": {
        if (!fsOn) throw new RpcFail(METHOD_NOT_FOUND, "File access isn't available to this agent.");
        this.session(params, turn);
        const path = confineToWorktree(req.cwd, params.path);
        let st; try { st = statSync(path); } catch { throw new RpcFail(NOT_FOUND, "No such file."); }
        if (!st.isFile()) throw new RpcFail(INVALID_PARAMS, "That is not a file.");
        if (st.size > MAX_READ) throw new RpcFail(INVALID_PARAMS, `The file is larger than ${MAX_READ / 1024 / 1024} MB.`);
        let content = readFileSync(path, "utf8");
        const line = num(params.line), limit = num(params.limit);
        if (line !== undefined || limit !== undefined) {
          const lines = content.split("\n");
          const from = Math.max(0, (line ?? 1) - 1);
          content = lines.slice(from, limit !== undefined ? from + Math.max(0, limit) : undefined).join("\n");
        }
        return { content };
      }
      case "fs/write_text_file": {
        if (!fsOn) throw new RpcFail(METHOD_NOT_FOUND, "File access isn't available to this agent.");
        this.session(params, turn);
        const path = confineToWorktree(req.cwd, params.path);
        if (typeof params.content !== "string") throw new RpcFail(INVALID_PARAMS, "content must be text.");
        if (Buffer.byteLength(params.content) > MAX_WRITE) throw new RpcFail(INVALID_PARAMS, `The file is larger than ${MAX_WRITE / 1024 / 1024} MB.`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, params.content);
        req.onChunk?.(`\n[tool: write ${relative(resolve(req.cwd), resolve(String(params.path)))}]\n`);
        return {};
      }
      case "session/request_permission": return this.permission(params, req, turn, aborted);
      default: throw new RpcFail(METHOD_NOT_FOUND, "Method not found.");
    }
  }

  private session(params: Record<string, unknown>, turn: Turn) {
    if (params.sessionId !== turn.sessionId) throw new RpcFail(INVALID_PARAMS, "Unknown session.");
  }

  /**
   * The agent asks to run a tool. A tool the owner switched off for this agent is refused. A tool that isn't sensitive and is switched on (files in the
   * task folder, web) just runs. A sensitive one (shell, Gmail, Slack, CRM), or a call that doesn't say what it touches, asks the owner through the
   * approvals queue and waits, exactly as Claude Code's permission prompt does. A run that can't ask (no hook, practice run, planning call) is refused.
   */
  private async permission(params: Record<string, unknown>, req: RunRequest, turn: Turn, aborted: Promise<"aborted">) {
    this.session(params, turn);
    const call = obj(params.toolCall);
    const id = str(call.toolCallId);
    const known = id ? turn.tools.get(id) : undefined;
    const title = (str(call.title) ?? known?.title ?? "a tool").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
    const kind = str(call.kind) ?? known?.kind ?? "other";
    const options = (Array.isArray(params.options) ? params.options : []).map(obj).filter((o) => str(o.optionId)).map((o) => ({ optionId: String(o.optionId), name: str(o.name), kind: str(o.kind) }));
    const answer = (allow: boolean) => {
      const optionId = pickOption(options, allow);
      return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
    };
    if (turn.cancelled) return { outcome: { outcome: "cancelled" } };

    const tool = toolForKind(kind);
    if (req.jsonOnly) return answer(false);
    if (tool && !req.agent.tools[tool]) {
      req.onChunk?.(`\n[refused: ${title} (${tool} is off for this agent)]\n`);
      return answer(false);
    }
    if (tool && !TOOLS.find((t) => t.id === tool)?.sensitive) return answer(true);
    if (!req.approve) return answer(false);
    const raw = call.rawInput === undefined ? "" : JSON.stringify(call.rawInput).slice(0, 300);
    const decided = await Promise.race([req.approve(tool ?? "other", title, raw ? `${title}: ${raw}` : title), aborted]);
    if (decided === "aborted") return { outcome: { outcome: "cancelled" } };
    return answer(decided);
  }
}
