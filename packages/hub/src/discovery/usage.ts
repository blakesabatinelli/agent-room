import { z } from "zod";
import type { DiscoveryResult, RunUsage } from "@agent-room/shared";
import type { Store } from "../db/store.js";

/**
 * 1.3 (AC3): agents that join over MCP say which model did a piece of work and what it used, in submit_result.
 * The hub validates and caps what they send, and logs a run on a local model at $0.
 */
/** Loose on purpose: a hand-back must never fail over a cosmetic field. The values are cleaned and capped in normalizeMcpReport. */
export const mcpReportShape = {
  model: z.string().max(300).optional()
    .describe("The model that did this work, as you know it, for example MiniMax-M3 or the name of your local model."),
  usage: z.object({
    inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional(),
  }).optional().describe("Tokens used for this piece of work, and the cost in USD if you know it."),
};

const MAX_TOKENS = 1_000_000_000, MAX_COST = 10_000;
const cap = (v: unknown, max: number, whole: boolean) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? (whole ? Math.floor(Math.min(v, max)) : Math.round(Math.min(v, max) * 1e6) / 1e6) : undefined);
/** Printable model name, at most 120 characters. */
export const cleanModel = (m: string | undefined) => m?.replace(/[^\w .:/@+()\[\],-]/g, "").trim().slice(0, 120) || undefined;

const norm = (s: string) => s.toLowerCase().replace(/\.(gguf|bin|safetensors)$/, "").replace(/[^a-z0-9]+/g, "");

/** Do two model names point at the same model? Case, punctuation, file extensions and extra quantization tags are ignored. */
export function sameModel(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (x.length < 3 || y.length < 3) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}

/** Models the last discovery found running on this Mac (the servers' models, plus the one Hermes names when it uses a local server). */
export function localModelsOf(found: Pick<DiscoveryResult, "servers" | "agents"> | undefined): string[] {
  if (!found) return [];
  const out = new Set(found.servers.flatMap((s) => s.models));
  const h = found.agents.find((a) => a.id === "hermes")?.settings.discovered as { model?: string | null; localServer?: string | null } | undefined;
  if (h?.localServer && h.model) out.add(h.model);
  return [...out];
}

/** The same, read from the Store (the service keeps its last result under "discovery_last"). */
export function localModelsFor(store: Pick<Store, "getKV">): string[] {
  return localModelsOf(store.getKV<DiscoveryResult | null>("discovery_last", null) ?? undefined);
}

export interface McpReport { model?: string; usage?: RunUsage }

/**
 * What goes on the run: the model and usage as reported, except that a model matching one of this Mac's local models costs $0.
 * Returns undefined usage when the agent reported none (the quota ledger then estimates from text length, as before).
 */
export function normalizeMcpReport(model: string | undefined, usage: RunUsage | undefined, localModels: string[]): McpReport {
  const m = cleanModel(model);
  const local = !!m && localModels.some((l) => sameModel(l, m));
  const clean: RunUsage = { inputTokens: cap(usage?.inputTokens, MAX_TOKENS, true), outputTokens: cap(usage?.outputTokens, MAX_TOKENS, true), costUsd: cap(usage?.costUsd, MAX_COST, false) };
  for (const k of Object.keys(clean) as (keyof RunUsage)[]) if (clean[k] === undefined) delete clean[k];
  const u: RunUsage | undefined = Object.keys(clean).length ? clean : undefined;
  if (local) return { model: m, usage: { ...(u ?? {}), costUsd: 0 } };
  return { model: m, usage: u };
}
