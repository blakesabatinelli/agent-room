import type { MemoryEntry, MemoryKind, MemorySource, MemoryTtlDays, OrchestratorSettings } from "@agent-room/shared";
import { MEMORY_TTL_DEFAULTS } from "@agent-room/shared";

/**
 * 2.5: what a memory fact is made of. Every fact has a source and an expiry (PRODUCT.md 6.8: stale context is worse than none).
 * An expiry is the end of a UTC day, so the date in a MEMORY.md line and the instant in the database always agree.
 */

export const DAY_MS = 86_400_000;
/** An expired fact stays in the database this long (so a re-assertion can revive it and the owner can see what lapsed), then it goes. */
export const PRUNE_AFTER_DAYS = 30;

export const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The last millisecond of the UTC day `ms` falls in. */
export const endOfDay = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999); };
export const endOfDate = (yyyyMmDd: string) => Date.parse(`${yyyyMmDd}T23:59:59.999Z`);

export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "preference", "status"];
export const isMemoryKind = (v: unknown): v is MemoryKind => typeof v === "string" && (MEMORY_KINDS as readonly string[]).includes(v);

/** The owner's days-by-kind setting with defaults for anything missing or nonsense. */
export function ttlSetting(s?: Pick<OrchestratorSettings, "memoryTtlDays">): MemoryTtlDays {
  const t = s?.memoryTtlDays ?? ({} as Partial<MemoryTtlDays>);
  const ok = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 3650 ? Math.round(v) : d);
  return { fact: ok(t.fact, MEMORY_TTL_DEFAULTS.fact), preference: ok(t.preference, MEMORY_TTL_DEFAULTS.preference), status: ok(t.status, MEMORY_TTL_DEFAULTS.status) };
}

/** An expiry `days` from `at`. */
export const expiryFrom = (at: number, days: number) => endOfDay(at + days * DAY_MS);

/** A number of days the keeper or an agent suggested, if it is a sane one. */
export const validDays = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 3650 ? Math.round(v) : undefined);

/** Expired: its last day has passed. A row with no expiry at all is a pre-2.5 row that hasn't been migrated yet; it counts as live. */
export const isExpired = (e: Pick<MemoryEntry, "expiresAt">, at: number) => typeof e.expiresAt === "number" && e.expiresAt < at;
export const isLive = (e: Pick<MemoryEntry, "expiresAt">, at: number) => !isExpired(e, at);

/** A memory row as a caller may hand it over: source and expiry are filled in when missing. */
export type Bare = Omit<MemoryEntry, "source" | "expiresAt"> & Partial<Pick<MemoryEntry, "source" | "expiresAt">>;

/** Fill in a source and an expiry where a row has none, so nothing without them is ever stored. */
export function ensureProvenance(e: Bare, o: { at: number; ttl: MemoryTtlDays }): MemoryEntry {
  const source: MemorySource = e.source ?? { kind: "agent", agentId: e.sourceAgentId, at: e.createdAt ?? o.at };
  const kind = e.memKind && isMemoryKind(e.memKind) ? e.memKind : "fact";
  const expiresAt = typeof e.expiresAt === "number" && Number.isFinite(e.expiresAt) ? e.expiresAt : expiryFrom(o.at, o.ttl[kind]);
  return { ...e, source, expiresAt };
}

/** "Oct 20" for a UTC instant. */
export const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Who or what a fact came from, in words: "goal g_12", "you", "codex". */
export function describeSource(s: MemorySource, agentName: (id: string) => string = (x) => x): string {
  if (s.kind === "goal") return `goal ${s.id ?? "?"}`;
  if (s.kind === "owner") return "you";
  return s.agentId ? agentName(s.agentId) : "an agent";
}

/** One line for an agent reading memory: "text (source: goal g_12, Oct 20; expires 2026-11-20)". */
export function annotate(e: MemoryEntry): string {
  const s = e.source ?? { kind: "agent" as const, agentId: e.sourceAgentId, at: 0 };
  const src = s.kind === "goal" ? `goal ${s.id ?? "?"}` : s.kind === "owner" ? "owner" : `agent ${s.agentId ?? "unknown"}${s.id ? `, ${s.id}` : ""}`;
  const when = s.at ? `, ${shortDate(s.at)}` : "";
  return `${e.text} (source: ${src}${when}; expires ${Number.isFinite(e.expiresAt) ? dateOf(e.expiresAt) : "unknown"})`;
}
