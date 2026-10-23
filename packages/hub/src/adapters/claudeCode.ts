import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "@agent-room/shared";
import type { Adapter, RunRequest, RunResult } from "./types.js";
import { runProc, which } from "./proc.js";
import { claudeConfinementArgs, scopeAllowedTools } from "../files/confine.js";
import { NativeTracker } from "../subagents/native.js"; // 3.3

/**
 * Drives the Claude Code CLI, signed in with the owner's Claude subscription.
 * Permissions are enforced by Claude Code itself:
 *  - enabled, non-sensitive tools -> --allowedTools
 *  - disabled tools               -> --disallowedTools
 *  - enabled, sensitive tools     -> left out of both, so Claude Code asks our
 *    MCP permission-prompt tool, which creates an owner approval and waits.
 */
export const CLAUDE_TOOL_MAP: Record<string, string[]> = {
  web: ["WebFetch", "WebSearch"],
  filesystem: ["Read", "Write", "Edit", "Glob", "Grep", "LS"],
  shell: ["Bash"],
  gmail: ["mcp__gmail"],
  slack: ["mcp__slack"],
  drive: ["mcp__google-drive"],
  salesforce: ["mcp__salesforce"],
};

export function claudePermissionArgs(tools: Record<string, boolean>, map = CLAUDE_TOOL_MAP, autoApprove: Record<string, boolean> = {}) {
  const allowed = ["mcp__agent-room"];
  const disallowed: string[] = [];
  for (const t of TOOLS) {
    const names = map[t.id] ?? [];
    if (!tools[t.id]) disallowed.push(...names);
    else if (!t.sensitive || autoApprove[t.id]) allowed.push(...names);
    // enabled + sensitive, not auto-approved: routed to the approval prompt tool
  }
  return { allowed, disallowed };
}

/** 3.3: what a read-only helper may not use. Bash is out entirely: its sandbox confines writes to the working folder, which is a copy of the parent's, but a command can still change it. */
export const CLAUDE_WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];
/** 3.3: the permission lists with every write tool taken out of the allowed list and put in the denied one. */
export function claudeReadOnly(p: { allowed: string[]; disallowed: string[] }) {
  return { allowed: p.allowed.filter((t) => !CLAUDE_WRITE_TOOLS.includes(t.replace(/\(.*$/, ""))) /* "Bash(ls)" is Bash too */, disallowed: [...new Set([...p.disallowed, ...CLAUDE_WRITE_TOOLS])] };
}

export class ClaudeCodeAdapter implements Adapter {
  async status() {
    const p = await which("claude");
    if (!p) return { ready: false, state: "not_installed" as const, detail: "Claude Code isn't installed." };
    // Claude Code records the signed-in account in ~/.claude.json after /login.
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
      const email = cfg?.oauthAccount?.emailAddress;
      if (email) return { ready: true, state: "ready" as const, detail: `Signed in as ${email}` };
      if (process.env.ANTHROPIC_API_KEY) return { ready: true, state: "ready" as const, detail: "Using ANTHROPIC_API_KEY" };
      return { ready: false, state: "signed_out" as const, detail: "Installed, but not signed in." };
    } catch {
      return { ready: true, state: "ready" as const, detail: "Installed. Sign-in couldn't be confirmed." };
    }
  }

  buildArgs(req: RunRequest): string[] {
    const s = req.agent.settings as { model?: string; toolMap?: Record<string, string[]>; bashSandbox?: boolean; sandboxReadAllow?: string[] };
    const args = ["-p", req.prompt, "--output-format", "stream-json", "--verbose"];
    const model = req.model ?? s.model;
    if (model) args.push("--model", model);
    if (req.effort && !req.jsonOnly) args.push("--effort", req.effort);
    if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
    if (req.jsonOnly) {
      args.push("--disallowedTools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch", "--max-turns", "1");
      return args;
    }
    if (req.mcp) {
      args.push("--mcp-config", JSON.stringify({
        mcpServers: { "agent-room": { type: "http", url: req.mcp.url, headers: { Authorization: `Bearer ${req.mcp.token}` } } },
      }));
      args.push("--permission-prompt-tool", "mcp__agent-room__approval_prompt");
    }
    const { allowed, disallowed } = req.readOnly ? claudeReadOnly(claudePermissionArgs(req.agent.tools, s.toolMap, req.agent.autoApprove)) : claudePermissionArgs(req.agent.tools, s.toolMap, req.agent.autoApprove); // 3.3
    // 1.1: file tools reach the task folder only (cwd), never a bare `Read`/`Write` that would allow any path. See files/confine.ts.
    args.push("--allowedTools", ...scopeAllowedTools(allowed, req.cwd));
    if (disallowed.length) args.push("--disallowedTools", disallowed.join(","));
    args.push(...claudeConfinementArgs({ cwd: req.cwd, dataDir: req.dataDir, bashSandbox: s.bashSandbox !== false, readAllow: Array.isArray(s.sandboxReadAllow) ? s.sandboxReadAllow.filter((x) => typeof x === "string") : undefined }));
    return args;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    let finalText = "", streamed = "", isError = false;
    let model: string | undefined, usage: RunResult["usage"];
    const bin = (req.agent.settings.binary as string) || "claude";
    const native = req.onSubagent ? new NativeTracker(req.onSubagent) : undefined; // 3.3: subagents the run launches
    const r = await runProc(bin, this.buildArgs(req), {
      cwd: req.cwd, signal: req.signal, timeoutMs: 30 * 60_000,
      onLine: (line) => {
        if (!line.trim()) return;
        try {
          const ev = JSON.parse(line);
          native?.claude(ev); // 3.3
          if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") model = ev.model;
          if (ev.type === "assistant") {
            for (const c of ev.message?.content ?? []) {
              if (c.type === "text") { streamed += c.text; req.onChunk?.(c.text); }
              if (c.type === "tool_use") req.onChunk?.(`\n[tool: ${c.name}]\n`);
            }
          } else if (ev.type === "result") {
            finalText = typeof ev.result === "string" ? ev.result : finalText;
            isError = !!ev.is_error;
            usage = claudeUsage(ev);
            // modelUsage is keyed by the model ids that actually ran; the biggest one is the worker.
            const mu = ev.modelUsage && typeof ev.modelUsage === "object" ? Object.entries(ev.modelUsage as Record<string, { outputTokens?: number }>) : [];
            if (mu.length) model = mu.sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0))[0][0];
          }
        } catch { /* non-JSON noise */ }
      },
    });
    const text = finalText || streamed;
    const ok = r.code === 0 && !isError && !!text;
    native?.finish(ok); // 3.3
    return { ok, text, durationMs: Date.now() - t0, error: ok ? undefined : (r.stderr || text || `exit ${r.code}`).slice(0, 2000), usage, model };
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Token and cost figures from Claude Code's final `result` event. */
export function claudeUsage(ev: { usage?: Record<string, unknown>; total_cost_usd?: unknown }): RunResult["usage"] {
  const u = ev.usage ?? {};
  const out = {
    inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens),
    costUsd: num(ev.total_cost_usd),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}
