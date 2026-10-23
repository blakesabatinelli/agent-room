import type { LocalModelServer } from "@agent-room/shared";
import { DEFAULT_PORTS, type DiscoveryEnv } from "./env.js";

const ids = (j: unknown): string[] => {
  const data = (j as { data?: unknown })?.data;
  return Array.isArray(data) ? data.map((m) => (m as { id?: unknown })?.id).filter((x): x is string => typeof x === "string" && !!x).slice(0, 30) : [];
};
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * Model servers answering on localhost (AC4): llama.cpp (8080: /health, then /v1/models or /props), Ollama (11434: /api/tags),
 * LM Studio (1234: /v1/models), and MLX or vLLM (8000: /v1/models). Short timeouts; a port nobody answers on is simply absent.
 */
export async function probeServers(env: DiscoveryEnv): Promise<LocalModelServer[]> {
  const port = (k: keyof typeof DEFAULT_PORTS) => env.ports?.[k] ?? DEFAULT_PORTS[k];
  const t = env.probeTimeoutMs ?? 800;
  const get = (p: number, path: string) => env.fetchJson(`http://127.0.0.1:${p}${path}`, t);
  const server = (id: LocalModelServer["id"], label: string, p: number, models: string[]): LocalModelServer => ({ id, label, baseUrl: `http://127.0.0.1:${p}/v1`, port: p, models });

  const llama = async (): Promise<LocalModelServer | undefined> => {
    const p = port("llama.cpp");
    const [health, models] = await Promise.all([get(p, "/health"), get(p, "/v1/models")]);
    const found = ids(models?.json);
    if (health?.status === 200 || health?.status === 503) {
      // 503 means llama.cpp is up and still loading its model: it is there, with nothing to list yet.
      let list = found;
      if (!list.length) {
        const props = (await get(p, "/props"))?.json as { model_alias?: string; model_path?: string; default_generation_settings?: { model?: string } } | undefined;
        const n = props?.model_alias || props?.default_generation_settings?.model || (props?.model_path ? base(props.model_path) : "");
        if (n) list = [n];
      }
      return server("llama.cpp", "llama.cpp", p, list);
    }
    // Something else speaks the OpenAI API on llama.cpp's usual port.
    return found.length ? server("openai-compatible", `OpenAI-compatible server on ${p}`, p, found) : undefined;
  };
  const ollama = async () => {
    const p = port("ollama");
    const r = await get(p, "/api/tags");
    const models = (r?.json as { models?: { name?: string }[] } | undefined)?.models;
    if (r?.status !== 200 || !Array.isArray(models)) return undefined;
    return server("ollama", "Ollama", p, models.map((m) => m.name).filter((x): x is string => !!x).slice(0, 30));
  };
  const openai = (key: "lm-studio" | "vllm-mlx") => async () => {
    const p = port(key);
    const r = await get(p, "/v1/models");
    if (r?.status !== 200) return undefined;
    const list = ids(r.json);
    if (!Array.isArray((r.json as { data?: unknown })?.data)) return undefined;
    return key === "lm-studio" ? server("lm-studio", "LM Studio", p, list) : server("openai-compatible", "MLX or vLLM", p, list);
  };
  const all = await Promise.all([llama(), ollama(), openai("lm-studio")(), openai("vllm-mlx")()]);
  return all.filter((s): s is LocalModelServer => !!s);
}
