/**
 * S4: the environment an agent CLI is started with.
 *
 * The hub's own process may hold secrets an agent has no business seeing: its signing and release keys, cloud and package-registry tokens,
 * and other vendors' API keys. Every spawn goes through scrubEnv: those names are removed, and only the vendor's own key family is kept
 * (`keep`). Names are matched, not values, so nothing secret is read here. What is removed is listed by name only, for the audit log.
 *
 * A denylist, not an allowlist, on purpose: the CLIs read many ordinary variables (HOME, PATH, TMPDIR, LANG, proxy settings, XDG_*) that
 * differ per Mac, and dropping one breaks sign-in in ways only a real Mac shows. The OS sandbox (S4, adapters) is the boundary; this is depth.
 */

/** Always removed: the hub's own secrets, release and signing keys, cloud and registry credentials. */
const ALWAYS = [
  /^AGENT_ROOM_(?!MCP_URL$|MCP_TOKEN$)/,            // hub settings and secrets; the two MCP values are set per run by the adapter itself
  /^(SPARKLE|NOTARY|NOTARIZE|APPLE_ID|APPLE_TEAM|APP_SPECIFIC|CODESIGN|DEVELOPER_ID)/,
  /^(AWS|AZURE|GOOGLE_APPLICATION_CREDENTIALS|GCLOUD|GCP|CLOUDSDK|DO_|DIGITALOCEAN|HEROKU|FLY_|VERCEL|NETLIFY|CLOUDFLARE|SUPABASE)/,
  /^(GH|GITHUB|GITLAB|BITBUCKET|NPM|NODE_AUTH|YARN_NPM|PYPI|TWINE|CARGO_REGISTRY|DOCKER|HOMEBREW_GITHUB)_?(API_)?(TOKEN|PAT|PASSWORD|AUTH|KEY)/,
  /^(SSH_AUTH_SOCK|GPG_AGENT_INFO|GNUPGHOME)$/,
  /^(SLACK|STRIPE|TWILIO|SENDGRID|MAILGUN|SALESFORCE|SF_|HUBSPOT|NOTION|LINEAR|ATLASSIAN|JIRA|DATADOG|SENTRY)_/,
  /(^|_)(SECRET|PASSWORD|PASSWD|PRIVATE_KEY|SESSION_TOKEN)(_|$)/,
];
/** Removed unless the adapter keeps that vendor's family: model API keys. */
const VENDOR_KEYS = /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|AZURE_OPENAI|GEMINI|GOOGLE_API|GROQ|MISTRAL|COHERE|TOGETHER|FIREWORKS|DEEPSEEK|XAI|PERPLEXITY|OPENROUTER|MINIMAX|HF|HUGGING)_?/;

export interface ScrubResult { env: NodeJS.ProcessEnv; removed: string[] }

/**
 * `keep`: variable names (regex) this spawn may keep even if they look like a vendor key (Claude Code keeps ANTHROPIC_/CLAUDE_, Codex keeps
 * OPENAI_/CODEX_, a command agent configured by the owner keeps every vendor key). `keepAllVendors` keeps every vendor key family.
 */
export function scrubEnv(base: NodeJS.ProcessEnv, o: { keep?: RegExp; keepAllVendors?: boolean } = {}): ScrubResult {
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const kept = o.keep?.test(k);
    if (!kept && ALWAYS.some((r) => r.test(k))) { removed.push(k); continue; }
    if (!kept && !o.keepAllVendors && VENDOR_KEYS.test(k)) { removed.push(k); continue; }
    env[k] = v;
  }
  return { env, removed };
}

export const KEEP_CLAUDE = /^(ANTHROPIC|CLAUDE)_/;
export const KEEP_OPENAI = /^(OPENAI|CODEX)_/;
