import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, RunRequest, RunResult } from "./types.js";
import { runProc, which } from "./proc.js";
import { KEEP_OPENAI } from "../security/env.js"; // S4
import { codexConfinementArgs } from "../files/confine.js";
import { NativeTracker } from "../subagents/native.js"; // 3.3

/**
 * Drives OpenAI's Codex CLI (`codex exec`), signed in with the owner's ChatGPT plan.
 * Permissions map onto Codex's sandbox: shell+filesystem off -> read-only,
 * otherwise workspace-write; web toggles sandbox network access.
 * Codex exec cannot pause mid-run for approvals, so sensitive connectors are
 * only exposed through the hub's request_approval MCP tool.
 */
export function codexSandboxArgs(tools: Record<string, boolean>, ask: string[] = []): string[] {
  // 4.3: Codex can't stop to ask, so a tool the room says to ask about is off for it.
  const on = (t: string) => tools[t] && !ask.includes(t);
  const writable = on("filesystem") || on("shell");
  const args = ["--sandbox", writable ? "workspace-write" : "read-only"];
  if (writable) args.push("-c", `sandbox_workspace_write.network_access=${on("web") ? "true" : "false"}`);
  return args;
}

/**
 * Everything before the prompt for `codex exec`. 1.1 confinement: `-C <task folder>` and the workspace-write sandbox with no extra
 * writable roots (no --add-dir, writable_roots empty, /tmp excluded), so writes stay inside the task's worktree.
 */
export function codexBaseArgs(req: Pick<RunRequest, "agent" | "cwd" | "model" | "effort" | "jsonOnly" | "readOnly" | "ask">, outFile: string): string[] {
  const s = req.agent.settings as { model?: string };
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", req.cwd, "--output-last-message", outFile];
  const model = req.model ?? s.model;
  if (model) args.push("-m", model);
  // Codex calls the top rung "xhigh"; it has no "max".
  if (req.effort) args.push("-c", `model_reasoning_effort="${req.effort === "max" ? "xhigh" : req.effort}"`);
  if (req.jsonOnly || req.readOnly) {
    args.push("--sandbox", "read-only"); // 3.3: a read-only helper is sandboxed whatever its tools are
    // 1.1 round 3 (N13): a planning, judging or drafting call runs no tools, so it gets none of the owner's own Codex config either: no MCP servers
    // (each one is a program Codex would start) and no `notify` program (run when a turn ends). `-c key=value` takes TOML: an empty table, an empty list.
    if (req.jsonOnly) args.push("-c", "mcp_servers={}", "-c", "notify=[]");
  } else {
    const sandbox = codexSandboxArgs(req.agent.tools, req.ask);
    args.push(...sandbox);
    if (sandbox.includes("workspace-write")) args.push(...codexConfinementArgs());
  }
  return args;
}

export class CodexAdapter implements Adapter {
  async status(agent?: RunRequest["agent"]) {
    const bin = (agent?.settings as { binary?: string } | undefined)?.binary || "codex";
    const p = await which(bin);
    if (!p) return { ready: false, state: "not_installed" as const, detail: "Codex isn't installed." };
    const r = await runProc(bin, ["login", "status"], { timeoutMs: 8000, keepEnv: KEEP_OPENAI });
    const out = `${r.stdout}\n${r.stderr}`.trim();
    if (/not logged in/i.test(out)) return { ready: false, state: "signed_out" as const, detail: "Installed, but not signed in." };
    if (r.code === 0) return { ready: true, state: "ready" as const, detail: out.split("\n")[0] || "Signed in" };
    return { ready: false, state: "error" as const, detail: out.split("\n").slice(-2).join(" ") || `codex login status exited ${r.code}` };
  }

  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    const tmp = mkdtempSync(join(tmpdir(), "codex-"));
    const outFile = join(tmp, "last.txt");
    const s = req.agent.settings as { model?: string; binary?: string };
    const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
    const args = codexBaseArgs(req, outFile);
    // The token travels in an env var; Codex reads it via bearer_token_env_var.
    const mcpArgs = !req.jsonOnly && req.mcp
      ? ["-c", `mcp_servers.agent_room.url="${req.mcp.url}"`, "-c", `mcp_servers.agent_room.bearer_token_env_var="AGENT_ROOM_MCP_TOKEN"`]
      : [];
    const attempt = async (extra: string[]) => {
      let streamed = "", evError = "";
      const native = req.onSubagent ? new NativeTracker(req.onSubagent) : undefined; // 3.3
      let usage: RunResult["usage"], model: string | undefined;
      const r = await runProc(s.binary || "codex", [...args, ...extra, prompt], {
        cwd: req.cwd, signal: req.signal, timeoutMs: 30 * 60_000,
        env: req.mcp ? { AGENT_ROOM_MCP_TOKEN: req.mcp.token } : undefined, keepEnv: KEEP_OPENAI, // S4
        onLine: (line) => {
          try {
            const ev = JSON.parse(line);
            native?.codex(ev); // 3.3
            const msg = ev.item?.type === "agent_message" ? ev.item.text
              : ev.msg?.type === "agent_message" ? ev.msg.message : undefined;
            if (msg) { streamed += msg; req.onChunk?.(msg); }
            const err = ev.type === "error" ? ev.message : ev.msg?.type === "error" ? ev.msg.message : ev.type === "turn.failed" ? ev.error?.message : undefined;
            if (err) evError = String(err);
            usage = codexUsage(ev) ?? usage;
            const m = ev.model ?? ev.msg?.model ?? ev.item?.model;
            if (typeof m === "string") model = m;
          } catch { /* ignore */ }
        },
      });
      native?.finish(r.code === 0); // 3.3
      let text = "";
      try { text = readFileSync(outFile, "utf8").trim(); } catch { text = streamed; }
      return { r, text, evError, usage, model };
    };
    let { r, text, evError, usage, model: ranModel } = await attempt(mcpArgs);
    // If the room's MCP server is what broke this Codex version, answer without it rather than fail.
    if ((r.code !== 0 || !text) && mcpArgs.length && !req.signal?.aborted && /mcp|config|bearer/i.test(`${r.stderr}\n${evError}`)) {
      ({ r, text, evError, usage, model: ranModel } = await attempt([]));
    }
    rmSync(tmp, { recursive: true, force: true });
    const ok = r.code === 0 && !!text;
    const detail = evError || r.stderr.trim().split("\n").slice(-6).join("\n") || `exit ${r.code}`;
    return { ok, text, durationMs: Date.now() - t0, error: ok ? undefined : detail.slice(0, 2000), usage, model: ranModel };
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Token usage from a Codex `--json` event: `turn.completed` (current) or a `token_count` message (older). */
export function codexUsage(ev: { type?: string; usage?: Record<string, unknown>; msg?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } } }): RunResult["usage"] {
  const u = ev.type === "turn.completed" ? ev.usage : ev.msg?.type === "token_count" ? ev.msg.info?.total_token_usage : undefined;
  if (!u) return undefined;
  const cached = num(u.cached_input_tokens);
  const input = num(u.input_tokens);
  return { inputTokens: input !== undefined && cached !== undefined ? input - cached : input, outputTokens: num(u.output_tokens), cacheReadTokens: cached };
}
