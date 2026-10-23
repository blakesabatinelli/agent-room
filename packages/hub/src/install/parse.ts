// 1.7 Reading what the agent CLIs print while they sign in. Pure functions; no I/O.
// Output shapes (see test/fixtures/signin-*.txt for which samples are from docs and which are reconstructed):
//   claude auth login       prints (or opens) a https://claude.ai/... authorize URL; "Paste code here if prompted" when the browser
//                           can't reach its local callback.        https://code.claude.com/docs/en/authentication
//   codex login             starts a local server on port 1455, opens the browser, and prints the https://auth.openai.com/... URL
//                           ("If your browser did not open, navigate to this URL ...").   https://developers.openai.com/codex/auth
//   codex login --device-auth  prints a device page URL and a one-time code like ABCD-12345 (valid 15 minutes).
//                           https://mintlify.wiki/openai/codex/cli/login

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Sign-in pages are only ever on the provider's own domain, over https. A URL anywhere else in a CLI's output is ignored. */
const HOSTS: Record<string, RegExp> = {
  "claude-code": /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/i,
  codex: /(^|\.)(openai\.com|chatgpt\.com)$/i,
};

export function allowedSignInUrl(adapter: string, raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && (HOSTS[adapter]?.test(u.hostname) ?? false);
  } catch { return false; }
}

const URL_RE = /https:\/\/[^\s"'<>`\\]+/g;
const trimUrl = (u: string) => u.replace(/[.,;:)\]}]+$/, "");

/** A device code such as ABCD-1234 or AAAAB-BB6TU. */
const CODE_RE = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/;

export interface ParsedSignIn { url?: string; code?: string; needsPaste: boolean }

export function parseSignIn(adapter: string, output: string): ParsedSignIn {
  const text = stripAnsi(output);
  const url = (text.match(URL_RE) ?? []).map(trimUrl).find((u) => allowedSignInUrl(adapter, u));
  // Look for the code outside any URL, preferring the lines around the words "code".
  const lines = text.replace(URL_RE, " ").split("\n");
  let code: string | undefined;
  for (let i = 0; i < lines.length && !code; i++) {
    if (/\bcode\b/i.test(lines[i])) code = lines.slice(i, i + 3).join("\n").match(CODE_RE)?.[0];
  }
  if (!code) code = lines.join("\n").match(CODE_RE)?.[0]; // fallback: any code-shaped token
  if (code && !/\d/.test(code) && !lines.some((l) => /\bcode\b/i.test(l) && l.includes(code!))) code = undefined;
  return { url, code, needsPaste: /paste (the )?code/i.test(text) };
}

/** True when the CLI says it needs a terminal (so the caller can retry it inside a pseudo-terminal). */
export const needsTty = (output: string) => /raw mode is not supported|not a tty|stdin is not a tty|inappropriate ioctl|must be run in a terminal|requires an interactive terminal/i.test(stripAnsi(output));

/** True when the browser sign-in's local callback port is taken (Codex listens on 1455). */
export const callbackPortBusy = (output: string) => /address already in use|eaddrinuse|port 1455.*(in use|busy)|(in use|busy).*port 1455/i.test(stripAnsi(output));

/** For the log file: the sign-in link and code are for the owner's eyes only. */
export const redactSignIn = (s: string) => stripAnsi(s).replace(URL_RE, "<url>").replace(new RegExp(CODE_RE.source, "g"), (m) => (/\d/.test(m) ? "<code>" : m));
