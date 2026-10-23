// 4.7 Opt-in usage counts. What the batch holds is decided here and nowhere else: buildTelemetry() reads counts from the store, and
// sanitizeTelemetry() rebuilds the object from the allow-list, so a field added by mistake upstream cannot reach the wire. The owner's
// "See what would be sent" view shows exactly sanitizeTelemetry(buildTelemetry()).
//
// Never in it: names (of people, agents, rooms, goals, tasks), text of any kind, paths, prompts, emails, tokens, addresses, or any id
// that could tie a batch to one Mac or one person (there is no install id).
import type { AdapterKind, TelemetryField, TelemetryPayload } from "@agent-room/shared";
import type { Store } from "../db/store.js";

const DAY = 24 * 3600_000;

/** The exact list shown to the owner, in the same order as the payload. */
export const TELEMETRY_FIELDS: TelemetryField[] = [
  { key: "appVersion", label: "Agent Room version", example: "1.0.0" },
  { key: "macosVersion", label: "macOS version", example: "15.1" },
  { key: "agentsByKind", label: "How many agents you have of each kind (Claude Code, Codex, and so on). Counts only, never names", example: '{"claude-code":1,"codex":1}' },
  { key: "goalsPerDay", label: "How many goals you started on each of the last 7 days", example: "[2,0,3,1,0,0,4]" },
  { key: "taskAcceptanceRate", label: "The share of finished tasks you accepted, as a number from 0 to 1", example: "0.82" },
  { key: "crashCount", label: "How many times the hub crashed in the last 7 days", example: "0" },
];

const ADAPTER_KINDS: AdapterKind[] = ["claude-code", "codex", "mcp", "command", "openai-api", "mock", "acp"];
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(1_000_000, Math.floor(n)) : 0);

/** Rebuilds a payload from the allow-list. Unknown keys, unknown adapter kinds and anything of the wrong type are dropped or zeroed. */
export function sanitizeTelemetry(raw: unknown): TelemetryPayload {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const kinds = (typeof r.agentsByKind === "object" && r.agentsByKind !== null ? r.agentsByKind : {}) as Record<string, unknown>;
  const agentsByKind: Record<string, number> = {};
  for (const k of ADAPTER_KINDS) if (count(kinds[k]) > 0) agentsByKind[k] = count(kinds[k]);
  const days = Array.isArray(r.goalsPerDay) ? r.goalsPerDay.slice(0, 7).map(count) : [];
  while (days.length < 7) days.push(0);
  const rate = typeof r.taskAcceptanceRate === "number" && Number.isFinite(r.taskAcceptanceRate) ? Math.round(Math.min(1, Math.max(0, r.taskAcceptanceRate)) * 100) / 100 : null;
  return {
    type: "telemetry", schema: 1, periodDays: 7,
    appVersion: typeof r.appVersion === "string" && VERSION_RE.test(r.appVersion) ? r.appVersion : "unknown",
    macosVersion: typeof r.macosVersion === "string" && VERSION_RE.test(r.macosVersion) ? r.macosVersion : "unknown",
    agentsByKind, goalsPerDay: days, taskAcceptanceRate: rate, crashCount: count(r.crashCount),
  };
}

/** The keys a payload may have, for tests and for the owner-facing list's cross-check. */
export const TELEMETRY_KEYS = ["type", "schema", "periodDays", "appVersion", "macosVersion", "agentsByKind", "goalsPerDay", "taskAcceptanceRate", "crashCount"] as const;

export interface TelemetryInputs { version: string; macos: string; crashCount: number; now?: number }

/** Counts from the store for the last 7 days. Reads ids, statuses and dates only; no text field is touched. */
export function buildTelemetry(store: Store, inputs: TelemetryInputs): TelemetryPayload {
  const now = inputs.now ?? Date.now();
  const since = now - 7 * DAY;
  const agentsByKind: Record<string, number> = {};
  for (const a of store.listAgents()) if (a.enabled) agentsByKind[a.adapter] = (agentsByKind[a.adapter] ?? 0) + 1;
  // Day buckets end at `now`: index 6 is the last 24 hours, index 0 the day a week ago.
  const goalsPerDay = [0, 0, 0, 0, 0, 0, 0];
  let accepted = 0, finished = 0;
  for (const room of store.listRooms()) {
    for (const g of store.listGoals(room.id)) {
      if (g.createdAt >= since && g.createdAt <= now) goalsPerDay[6 - Math.min(6, Math.floor((now - g.createdAt) / DAY))]++;
    }
    for (const t of store.listTasks({ roomId: room.id })) {
      if ((t.updatedAt ?? 0) < since) continue;
      if (t.status === "done") { accepted++; finished++; } else if (t.status === "failed") finished++;
    }
  }
  return sanitizeTelemetry({
    appVersion: inputs.version, macosVersion: inputs.macos, agentsByKind, goalsPerDay,
    taskAcceptanceRate: finished ? accepted / finished : null, crashCount: inputs.crashCount,
  });
}
