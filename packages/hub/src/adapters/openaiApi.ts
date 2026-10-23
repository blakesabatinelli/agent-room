import type { Adapter, RunRequest, RunResult } from "./types.js";

/** Fallback for agents only reachable by API (OpenAI-compatible chat completions). */
export class OpenAIApiAdapter implements Adapter {
  async status(agent: RunRequest["agent"]) {
    const env = (agent.settings.apiKeyEnv as string) || "OPENAI_API_KEY";
    return process.env[env] ? { ready: true, state: "ready" as const, detail: `API key from $${env}` }
                            : { ready: false, state: "signed_out" as const, detail: `Set $${env} on the Mac to use this agent.` };
  }

  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    const s = req.agent.settings as { baseUrl?: string; model?: string; apiKeyEnv?: string };
    const key = process.env[s.apiKeyEnv || "OPENAI_API_KEY"];
    try {
      const res = await fetch(`${s.baseUrl || "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST", signal: req.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: req.model || s.model || "gpt-4o",
          messages: [
            ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
            { role: "user", content: req.prompt },
          ],
        }),
      });
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message: string } };
      const text = data.choices?.[0]?.message?.content ?? "";
      return { ok: res.ok && !!text, text, durationMs: Date.now() - t0, error: data.error?.message };
    } catch (e) {
      return { ok: false, text: "", durationMs: Date.now() - t0, error: String(e) };
    }
  }
}
