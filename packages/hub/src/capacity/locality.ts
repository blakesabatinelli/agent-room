import type { AgentConfig, AgentLocality } from "@agent-room/shared";

/** Hosts that mean "this machine". A model server on another box is a remote agent as far as this Mac goes. */
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|[\w-]+\.local)$/i;
/** Binaries that run a model on this machine (llama.cpp, Ollama, LM Studio, MLX, llamafile, vLLM, koboldcpp). */
const LOCAL_RUNNER = /(llama|ollama|lmstudio|^lms$|koboldcpp|mlx[-_]?lm|llamafile|vllm)/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"']+/gi;

export function isLocalUrl(u: string | undefined): boolean {
  if (!u) return false;
  try { return LOCAL_HOST.test(new URL(u).hostname); } catch { return false; }
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * Where an agent's work runs, for scheduling:
 * - local-model: openai-api or command pointed at localhost, or a known local model runner or .gguf file
 * - local-cli: claude-code, codex, and any other command (a process here; the model is usually in the cloud)
 * - remote: mcp agents and openai-api on a real endpoint
 * agent.settings.locality overrides all of it.
 */
export function classifyAgent(agent: AgentConfig): AgentLocality {
  const s = agent.settings ?? {};
  const forced = s.locality;
  if (forced === "local-model" || forced === "local-cli" || forced === "remote") return forced;
  switch (agent.adapter) {
    case "mcp": return "remote";
    case "claude-code": case "codex": return "local-cli";
    case "openai-api": return isLocalUrl(s.baseUrl as string | undefined) ? "local-model" : "remote";
    case "command": {
      const cmd = typeof s.command === "string" ? s.command : "";
      const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [];
      const urls = [cmd, ...args].flatMap((x) => x.match(URL_IN_TEXT) ?? []);
      if (LOCAL_RUNNER.test(basename(cmd)) || urls.some(isLocalUrl) || args.some((a) => /\.gguf\b/i.test(a))) return "local-model";
      return "local-cli";
    }
    // Practice agents stand in for CLI agents.
    default: return "local-cli";
  }
}

/**
 * Memory a local model needs, in GB: settings.modelGB when the owner says, else guessed from a size in the
 * model name ("qwen3-0.6b", "llama-3.1-8b-instruct": about 0.65 GB per billion parameters at 4-bit).
 * undefined when it can't be told.
 */
export function estimateModelGB(agent: AgentConfig): number | undefined {
  const s = agent.settings ?? {};
  if (typeof s.modelGB === "number" && s.modelGB > 0) return s.modelGB;
  const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [];
  const name = [s.model, ...args].filter((x): x is string => typeof x === "string").join(" ");
  const moe = name.match(/(?:^|[^a-z\d.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/i); // mixtral-8x7b: counted as 8 x 7 (a safe overestimate)
  const m = moe ?? name.match(/(?:^|[^a-z\d.])(\d+(?:\.\d+)?)\s*b(?![a-z])/i);
  const params = moe ? Number(moe[1]) * Number(moe[2]) : m ? Number(m[1]) : undefined;
  return params === undefined ? undefined : Math.round(params * 0.65 * 10) / 10;
}
