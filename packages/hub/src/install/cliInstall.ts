// 1.7 Installing the agent CLIs without Terminal. Each script is run headless by the hub (bash -c), never typed by the owner.
//   Claude Code: the official native installer, https://code.claude.com/docs/en/setup  (curl -fsSL --http1.1 --retry 3 --retry-all-errors https://claude.ai/install.sh | bash)
//   Codex:       the macOS binary from the latest GitHub release, https://github.com/openai/codex/releases
//                (asset codex-<arch>-apple-darwin.tar.gz holds one file, codex-<arch>-apple-darwin)
// Both end up in ~/.local/bin, which the hub already puts on its PATH.
import { runProc } from "../adapters/proc.js";

export const INSTALL_SCRIPTS: Record<string, string> = {
  "claude-code": `set -e
curl -fsSL https://claude.ai/install.sh | bash
`,
  codex: `set -e
case "$(uname -m)" in
  arm64|aarch64) T=aarch64-apple-darwin ;;
  x86_64) T=x86_64-apple-darwin ;;
  *) echo "Unsupported Mac: $(uname -m)"; exit 1 ;;
esac
mkdir -p "$HOME/.local/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL --http1.1 --retry 3 --retry-all-errors "https://github.com/openai/codex/releases/latest/download/codex-$T.tar.gz" | tar -xz -C "$TMP"
mv "$TMP/codex-$T" "$HOME/.local/bin/codex"
chmod +x "$HOME/.local/bin/codex"
"$HOME/.local/bin/codex" --version
`,
};

export type InstallResult = { ok: boolean; output: string };
export type CliInstaller = (adapter: string) => Promise<InstallResult>;

/** Default installer: bash -c <script>, five minutes at most. */
export const installCli: CliInstaller = async (adapter) => {
  const script = INSTALL_SCRIPTS[adapter];
  if (!script) return { ok: false, output: "No installer for this agent." };
  const r = await runProc("/bin/bash", ["-c", script], { timeoutMs: 5 * 60_000 });
  return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim() };
};
