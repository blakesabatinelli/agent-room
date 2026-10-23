import { z } from "zod";
import { TOOLS } from "@agent-room/shared";

/**
 * Control file schemas (CONTROL.md section 2) and size caps (section 5).
 * Lists and maps that are omitted default to empty; scalar fields without a `?` in the spec are required.
 */

export const SCHEMA_VERSION = 1;

export const KINDS = [
  "agents", "user", "policy", "soul", "tools", "resume", "lessons", "agent-memory",
  "room", "room-memory", "goal", "ledger", "decisions", "playbook",
] as const;
export type Kind = (typeof KINDS)[number];

export type Level = "on" | "ask" | "off";
export const LEVELS: readonly Level[] = ["on", "ask", "off"];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
export const todayString = (d = new Date()) => d.toISOString().slice(0, 10);

const date = z.string().refine(isRealDate, "must be a real YYYY-MM-DD date");

// 4.2: a rule's `expires` is a date (good through that day, UTC) or, for a permission lease, a UTC moment like 2026-10-23T14:30:00Z.
const INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
export function isRealInstant(s: string): boolean {
  const m = INSTANT.exec(s);
  return !!m && isRealDate(m[1]) && !Number.isNaN(Date.parse(s));
}
/** When a rule's `expires` passes, in epoch ms: the end of that day for a date, the moment itself for a lease. */
export function expiryMs(expires: string): number {
  return isRealInstant(expires) ? Date.parse(expires) : Date.parse(`${expires}T00:00:00Z`) + 86_400_000;
}
const expiry = z.string().refine((s) => isRealDate(s) || isRealInstant(s), "must be a real YYYY-MM-DD date, or a UTC time like 2026-10-23T14:30:00Z");
// YAML 1.1 habits: `shell: true` / `shell: false` read as on / off.
const level = z.preprocess((v) => (v === true ? "on" : v === false ? "off" : v), z.enum(["on", "ask", "off"]));
const str = z.string().min(1);
const strList = z.array(z.string()).default([]);
const levelMap = z.record(level).default({});

/** Fields every control file carries. */
export const common = {
  kind: z.enum(KINDS),
  schema: z.number().int().min(1),
  updated: date,
  updated_by: str,
};

const profile = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(40),
  label: z.string().min(1).max(60),
  role: z.enum(["explorer", "researcher", "worker", "reviewer"]),
  model: z.string().max(100).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

const rule = z.object({
  id: str,
  effect: z.enum(["allow", "ask", "deny"]),
  tool: str,
  match: str,
  scope: str,
  expires: expiry.optional(),
  source: z.enum(["owner", "learned"]),
  accepted: z.boolean(),
});

const base = <K extends Kind>(kind: K) => z.object({ ...common, kind: z.literal(kind) });

export const schemas = {
  agents: base("agents").extend({ hard_limits: strList }),
  user: base("user").extend({ name: str, timezone: str, working_hours: z.string().optional() }),
  policy: base("policy").extend({ defaults: levelMap, rules: z.array(rule).default([]) }),
  soul: base("soul").extend({
    name: str, color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a hex colour like #6B4FD8"),
    avatar: z.string().optional(), role: str, tone: str,
  }),
  tools: base("tools").extend({
    runtime: z.object({
      adapter: z.enum(["claude-code", "codex", "mcp", "command", "openai-api", "mock", "acp"]),
      provider: str, enabled: z.boolean(),
      binary: z.string().optional(), model: z.string().optional(), profiles: z.array(profile).max(8).optional(),
    }),
    platform: z.object({ connectors: strList, data_sources: strList, skills: strList, tools: strList }).default({}),
    room_allows: levelMap,
    discovered: date.optional(),
  }),
  resume: base("resume").extend({
    runs: z.number().int().min(0).default(0), strengths: strList, weaknesses: strList, model_versions: strList,
    probation: z.boolean().default(false),
  }),
  lessons: base("lessons").extend({ task_types: strList }),
  "agent-memory": base("agent-memory"),
  room: base("room").extend({
    name: str, roster: strList, tools: levelMap, folders: strList,
    schedule: z.string().optional(), in_scope: strList, out_of_scope: strList,
    // 4.3 standing rooms: the calendar trigger runs `standing_goal` on `schedule` (5-field cron) in `timezone` (default: USER.md's).
    standing_goal: z.string().max(2000).optional(), timezone: z.string().optional(), catch_up_hours: z.number().min(0).max(168).optional(),
  }),
  "room-memory": base("room-memory"),
  goal: base("goal").extend({
    id: str, room: str,
    status: z.enum(["planning", "awaiting_approval", "running", "done", "failed", "paused", "superseded"]),
    locked: date.optional(),
    requirements: z.array(z.object({ id: str, text: str })).default([]),
    in_scope: strList, out_of_scope: strList,
  }),
  ledger: base("ledger").extend({ goal: str }),
  decisions: base("decisions").extend({ goal: str }),
  playbook: base("playbook").extend({ task_type: str, applies_to: z.union([z.literal("*"), z.array(z.string())]) }),
} as const;

export type Fm<K extends Kind> = z.infer<(typeof schemas)[K]>;
export type PolicyRule = z.infer<typeof rule>;

/** Size caps in bytes (section 5). Kinds not listed have no cap. */
const KB = 1024;
export const CAPS: Partial<Record<Kind, number>> = {
  agents: 8 * KB, user: 8 * KB, policy: 8 * KB, room: 8 * KB, soul: 8 * KB, tools: 8 * KB,
  lessons: 12 * KB, resume: 8 * KB, playbook: 8 * KB, "room-memory": 16 * KB, "agent-memory": 8 * KB, goal: 16 * KB,
};
/** Built context per task. */
export const CONTEXT_CAP = 24 * KB;

// ---- where a file sits tells what kind it must be

export interface FileMeta { kind: Kind; agent?: string; room?: string; goal?: string; taskType?: string }
export type Classified = { ignored: true } | { unknown: true } | { meta: FileMeta };

const ID = /^[a-z0-9][a-z0-9_-]*$/i;
const AGENT_FILES: Record<string, Kind> = { "SOUL.md": "soul", "TOOLS.md": "tools", "RESUME.md": "resume", "LESSONS.md": "lessons", "MEMORY.md": "agent-memory" };
const ROOM_FILES: Record<string, Kind> = { "ROOM.md": "room", "MEMORY.md": "room-memory" };
const GOAL_FILES: Record<string, Kind> = { "GOAL.md": "goal", "LEDGER.md": "ledger", "DECISIONS.md": "decisions" };
const TOP_FILES: Record<string, Kind> = { "AGENTS.md": "agents", "USER.md": "user", "POLICY.md": "policy" };

/** Every file name the spec knows, for "did you mean" hints. */
export const KNOWN_NAMES = [...new Set([...Object.keys(TOP_FILES), ...Object.keys(AGENT_FILES), ...Object.keys(ROOM_FILES), ...Object.keys(GOAL_FILES)])];

/** Classify a path relative to the control folder (forward slashes). */
export function classify(rel: string): Classified {
  const parts = rel.split("/");
  if (parts[0] === "Library" || parts[0] === ".git") return { ignored: true };
  if (parts.some((p) => p.startsWith(".")) || /(~|\.swp|\.swx|\.tmp)$/.test(rel)) return { ignored: true };
  const name = parts[parts.length - 1];
  if (parts.length === 1 && TOP_FILES[name]) return { meta: { kind: TOP_FILES[name] } };
  if (parts.length === 3 && parts[0] === "agents" && ID.test(parts[1]) && AGENT_FILES[name]) return { meta: { kind: AGENT_FILES[name], agent: parts[1] } };
  if (parts.length === 3 && parts[0] === "rooms" && ID.test(parts[1]) && ROOM_FILES[name]) return { meta: { kind: ROOM_FILES[name], room: parts[1] } };
  if (parts.length === 3 && parts[0] === "goals" && ID.test(parts[1]) && GOAL_FILES[name]) return { meta: { kind: GOAL_FILES[name], goal: parts[1] } };
  if (parts.length === 2 && parts[0] === "playbooks" && /^[a-z0-9][a-z0-9_-]*\.md$/i.test(name)) return { meta: { kind: "playbook", taskType: name.slice(0, -3) } };
  return { unknown: true };
}

// ---- tool catalogue helpers shared by the permission code

export const SENSITIVE = new Set(TOOLS.filter((t) => t.sensitive).map((t) => t.id));
/** Tools that come from a connected account; a platform that lists connectors must list these to grant them. */
export const CONNECTOR_TOOLS = new Set(["gmail", "slack", "drive", "salesforce"]);
