import { isLocalUrl } from "../capacity/locality.js";
import type { Adapter, RunRequest, RunResult } from "./types.js";

/** Fallback for agents only reachable by API (OpenAI-compatible chat completions). */
export class OpenAIApiAdapter implements Adapter {
  async status(agent: RunRequest["agent"]) {
    const env = (agent.settings.apiKeyEnv as string) || "OPENAI_API_KEY";
    if (process.env[env]) return { ready: true, state: "ready" as const, detail: `API key from $${env}` };
    // 1.3: a model server on this Mac (llama.cpp, Ollama, LM Studio) needs no key: it is ready when it answers.
    const base = agent.settings.baseUrl as string | undefined;
    if (isLocalUrl(base)) {
      try {
        const res = await fetch(`${base!.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(1500) });
        return res.ok ? { ready: true, state: "ready" as const, detail: `Local model server at ${base}` }
          : { ready: false, state: "error" as const, detail: `The model server at ${base} answered ${res.status}.` };
      } catch { return { ready: false, state: "offline" as const, detail: `Nothing is answering at ${base}. Start the model server.` }; }
    }
    return { ready: false, state: "signed_out" as const, detail: `Set $${env} on the Mac to use this agent.` };
  }

  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    const s = req.agent.settings as { baseUrl?: string; model?: string; apiKeyEnv?: string };
    const key = process.env[s.apiKeyEnv || "OPENAI_API_KEY"];
    const local = isLocalUrl(s.baseUrl);
    try {
      const res = await fetch(`${s.baseUrl || "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST", signal: req.signal,
        headers: { "Content-Type": "application/json", ...(key || !local ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: req.model || s.model || "gpt-4o",
          messages: [
            ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
            { role: "user", content: req.prompt },
          ],
        }),
      });
      const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message: string } };
      const text = data.choices?.[0]?.message?.content ?? "";
      // 1.3: tokens as the server reports them; a model on this Mac costs nothing.
      const u = data.usage;
      const usage = u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number")
        ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, ...(local ? { costUsd: 0 } : {}) } : undefined;
      return { ok: res.ok && !!text, text, durationMs: Date.now() - t0, error: data.error?.message, ...(usage ? { usage } : {}), ...(typeof data.model === "string" ? { model: data.model } : {}) };
    } catch (e) {
      return { ok: false, text: "", durationMs: Date.now() - t0, error: String(e) };
    }
  }
}
