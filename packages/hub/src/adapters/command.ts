import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, RunRequest, RunResult } from "./types.js";
import { runProc, which } from "./proc.js";
import { confineCommand } from "../security/sandbox.js"; // S4

/**
 * Generic adapter for any CLI or local runner (Hermes, Muse, local models...).
 * settings.command: binary; settings.args: array where "{prompt}" and "{promptFile}"
 * are substituted, plus "{model}" and "{effort}" from the profile in use. stdout is the reply. If settings.stdin is true, prompt goes to stdin.
 */
export class CommandAdapter implements Adapter {
  async status(agent: RunRequest["agent"]) {
    const cmd = agent.settings.command as string | undefined;
    if (!cmd) return { ready: false, state: "not_installed" as const, detail: "No command configured." };
    const p = await which(cmd);
    return p ? { ready: true, state: "ready" as const, detail: `${cmd} at ${p}` } : { ready: false, state: "not_installed" as const, detail: `${cmd} not found on PATH.` };
  }

  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    const s = req.agent.settings as { command: string; args?: string[]; stdin?: boolean };
    const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
    const promptFile = join(req.cwd, ".agent-room-prompt.md");
    writeFileSync(promptFile, prompt);
    const args = (s.args ?? ["{prompt}"]).map((a) => a.replace("{promptFile}", promptFile).replace("{prompt}", prompt)
      .replace("{model}", req.model ?? (req.agent.settings.model as string | undefined) ?? "").replace("{effort}", req.effort ?? ""));
    const env = req.mcp ? { AGENT_ROOM_MCP_URL: req.mcp.url, AGENT_ROOM_MCP_TOKEN: req.mcp.token } : undefined;
    // S4: confined on macOS unless the owner switched it off for this agent (settings.sandbox = false).
    const set = req.agent.settings as { sandbox?: boolean; writablePaths?: string[]; ownCredentials?: string[] };
    const run = confineCommand(s.command, args, { cwd: req.cwd, dataDir: req.dataDir, protectedPaths: req.protectedPaths, writablePaths: set.writablePaths, ownCredentials: set.ownCredentials, enabled: set.sandbox !== false });
    const r = await runProc(run.cmd, run.args, {
      cwd: req.cwd, env, keepAllVendors: true /* S4: the owner configured this command and its keys */, signal: req.signal, stdin: s.stdin ? prompt : undefined, timeoutMs: 30 * 60_000,
      onLine: (l) => req.onChunk?.(l + "\n"),
    });
    const text = r.stdout.trim();
    const ok = r.code === 0 && !!text;
    return { ok, text, durationMs: Date.now() - t0, error: ok ? undefined : (r.stderr || `exit ${r.code}`).slice(0, 2000) };
  }
}
