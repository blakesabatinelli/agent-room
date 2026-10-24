import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProc } from "./adapters/proc.js";

const PATHS = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
const LOGF = (name: string) => `"$HOME/.agent-room/signin-${name}.log"`;
export const LOGIN: Record<string, { cmd: string; note: string }> = {
  "claude-code": {
    cmd: [
      PATHS,
      `: > ${LOGF("claude")}`,
      // "Installed" means it starts: an old npm install can leave a `claude` link whose target is gone, and the native installer's clean-up of
      // that old install can remove the link it just made. So check with --version, and run the installer a second time if the first left none.
      'claude_ok() { hash -r; command -v claude >/dev/null && claude --version >/dev/null 2>&1; }',
      'install_claude() { curl -fsSL --http1.1 --retry 3 https://claude.ai/install.sh | bash; }',
      'if ! claude_ok; then',
      `  { echo "Installing Claude Code…"; install_claude || npm install -g @anthropic-ai/claude-code || npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code; } 2>&1 | tee -a ${LOGF("claude")}`,
      `  claude_ok || { echo; echo "Finishing the install…"; install_claude; } 2>&1 | tee -a ${LOGF("claude")}`,
      'fi',
      `claude_ok || { echo "Claude Code didn't install. Agent Room can show you this log."; echo "Found: $(ls -la "$HOME/.local/bin/claude" 2>&1)"; } 2>&1 | tee -a ${LOGF("claude")}`,
      `claude_ok || { read; exit 1; }`,
      `echo "Claude Code: $(command -v claude) $(claude --version 2>&1)" | tee -a ${LOGF("claude")}`,
      'echo; echo "Type /login if Claude doesn\'t ask you to sign in, then /exit and go back to Agent Room."; echo',
      'claude',
    ].join("\n"),
    note: "Terminal opened. Sign in to Claude there (type /login if it doesn't ask), then come back. Agent Room checks again on its own.",
  },
  codex: {
    cmd: [
      PATHS,
      `: > ${LOGF("codex")}`,
      'echo "Setting up Codex (your ChatGPT plan) for Agent Room…"; echo',
      // A half-finished npm install leaves a `codex` launcher whose native binary is missing (spawn ENOENT).
      'if command -v codex >/dev/null && ! codex --version >/dev/null 2>&1; then',
      // Remove it from whichever Node install owns it (Homebrew and ~/.local each have their own global folder).
      `  { echo "Codex is installed but broken; removing it and reinstalling…"; for n in /opt/homebrew/bin/npm /usr/local/bin/npm "$HOME/.local/bin/npm"; do [ -x "$n" ] && "$n" uninstall -g @openai/codex; done; rm -rf /opt/homebrew/lib/node_modules/@openai/codex /usr/local/lib/node_modules/@openai/codex "$HOME/.local/lib/node_modules/@openai/codex"; for c in $(which -a codex); do codex_ok=0; "$c" --version >/dev/null 2>&1 || rm -f "$c"; done; hash -r; } 2>&1 | tee -a ${LOGF("codex")}`,
      'fi',
      'if ! command -v codex >/dev/null; then',
      `  { brew install --cask codex || npm install -g @openai/codex@latest || npm install -g --prefix "$HOME/.local" @openai/codex@latest; hash -r; } 2>&1 | tee -a ${LOGF("codex")}`,
      'fi',
      `codex --version >/dev/null 2>&1 || { echo "Codex still won't start. Agent Room can show you this log." | tee -a ${LOGF("codex")}; read; exit 1; }`,
      `echo "Codex: $(command -v codex) $(codex --version 2>&1)" | tee -a ${LOGF("codex")}`,
      'if ! codex login status >/dev/null 2>&1 || codex login status 2>&1 | grep -qi "not logged in"; then codex login; fi',
      `echo; echo "Status:"; codex login status 2>&1 | tee -a ${LOGF("codex")}`,
      'echo; echo "If it says Logged in, you\'re done; Agent Room checks again on its own. Press Return to close."; read',
    ].join("\n"),
    note: "Terminal opened. Choose “Sign in with ChatGPT” in the browser window. Agent Room checks again on its own.",
  },
};

/** Last lines of a sign-in attempt, so the app can show why it failed. */
export function signInLog(adapter: string): string | null {
  const name = adapter === "claude-code" ? "claude" : adapter;
  try { return readFileSync(join(homedir(), ".agent-room", `signin-${name}.log`), "utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim().split("\n").slice(-25).join("\n"); }
  catch { return null; }
}

/** Opens Terminal with the CLI's own install + sign-in flow (macOS only). */
export async function openSignIn(adapter: string): Promise<{ ok: boolean; message: string }> {
  const flow = LOGIN[adapter];
  if (!flow) return { ok: false, message: "This agent doesn't have a sign-in step." };
  if (process.platform !== "darwin") return { ok: false, message: `Run this in a terminal: ${flow.cmd.split("\n").pop()}` };
  const dir = join(homedir(), ".agent-room");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `signin-${adapter}.command`);
  writeFileSync(file, `#!/bin/zsh -l\n${flow.cmd}\n`);
  chmodSync(file, 0o755);
  const r = await runProc("/usr/bin/open", ["-a", "Terminal", file], { timeoutMs: 10_000 });
  return r.code === 0 ? { ok: true, message: flow.note } : { ok: false, message: r.stderr || "Couldn't open Terminal." };
}
