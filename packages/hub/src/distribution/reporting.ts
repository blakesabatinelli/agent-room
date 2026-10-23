// 4.7 The two switches that decide whether anything leaves this Mac, and the one place that sends it.
// Rule: nothing is uploaded unless the owner turned that switch on AND AGENT_ROOM_REPORT_URL names a usable endpoint. Both default to off/unset.
// Every upload goes through `upload()`, which checks both, so a new caller cannot forget.
import type { PrivacyState } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { markCrashSent, pendingCrashReports } from "./crash.js";
import { TELEMETRY_FIELDS } from "./telemetry.js";
import { infoPlistText, plistString } from "./version.js";

export const KV_CRASH = "reports.crash";            // boolean, default false
export const KV_TELEMETRY = "reports.telemetry";    // boolean, default false
export const KV_TELEMETRY_SINCE = "reports.telemetry.since"; // when it was switched on (the first batch goes a week later)
export const KV_TELEMETRY_SENT = "reports.telemetry.sent";   // when the last batch went
export const KV_TELEMETRY_TRIED = "reports.telemetry.tried"; // last attempt, so a failing endpoint isn't hit every hour
export const KV_UPDATES = "updates.check";          // boolean, default true: fetches the appcast file only
export const WEEK_MS = 7 * 24 * 3600_000;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/**
 * The upload address, or undefined when it isn't set or isn't safe (https, or http only to this Mac for a local collector).
 * AGENT_ROOM_REPORT_URL wins; otherwise the app's own Info.plist key AgentRoomReportURL, which scripts/package-mac.sh --release writes from
 * the same variable at build time (empty unless the owner set one), so an installed app can have an address its users never type.
 */
export function reportEndpoint(env: NodeJS.ProcessEnv = process.env, plistText?: string): URL | undefined {
  const raw = env.AGENT_ROOM_REPORT_URL?.trim() || plistString(plistText ?? infoPlistText(), "AgentRoomReportURL");
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.username || u.password) return undefined;
    if (u.protocol === "https:") return u;
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u;
  } catch { /* not a URL */ }
  return undefined;
}

export const crashReportsOn = (store: Store) => store.getKV<boolean>(KV_CRASH, false) === true;
export const telemetryOn = (store: Store) => store.getKV<boolean>(KV_TELEMETRY, false) === true;
export const updateChecksOn = (store: Store) => store.getKV<boolean>(KV_UPDATES, true) !== false;

export function privacyState(store: Store, env: NodeJS.ProcessEnv = process.env, now = Date.now()): PrivacyState {
  const ep = reportEndpoint(env);
  const sent = store.getKV<number | null>(KV_TELEMETRY_SENT, null) ?? undefined;
  const since = store.getKV<number | null>(KV_TELEMETRY_SINCE, null) ?? undefined;
  const on = telemetryOn(store);
  return {
    crashReports: crashReportsOn(store), telemetry: on, updateChecks: updateChecksOn(store),
    endpointConfigured: !!ep, ...(ep ? { endpointHost: ep.host } : {}),
    telemetryFields: TELEMETRY_FIELDS,
    ...(sent ? { telemetryLastSentAt: sent } : {}),
    ...(on ? { telemetryNextAt: Math.max(now, (sent ?? since ?? now) + WEEK_MS) } : {}),
  };
}

export function setPrivacy(store: Store, patch: { crashReports?: boolean; telemetry?: boolean; updateChecks?: boolean }, now = Date.now()) {
  if (patch.crashReports !== undefined && patch.crashReports !== crashReportsOn(store)) {
    store.setKV(KV_CRASH, patch.crashReports);
    store.audit("owner", patch.crashReports ? "reports.crash.on" : "reports.crash.off", "crash reports");
  }
  if (patch.telemetry !== undefined && patch.telemetry !== telemetryOn(store)) {
    store.setKV(KV_TELEMETRY, patch.telemetry);
    if (patch.telemetry) store.setKV(KV_TELEMETRY_SINCE, now);
    store.audit("owner", patch.telemetry ? "reports.telemetry.on" : "reports.telemetry.off", "usage counts");
  }
  if (patch.updateChecks !== undefined && patch.updateChecks !== updateChecksOn(store)) {
    store.setKV(KV_UPDATES, patch.updateChecks);
    store.audit("owner", patch.updateChecks ? "updates.check.on" : "updates.check.off", "appcast");
  }
}

export interface UploadDeps { fetch?: FetchLike; env?: NodeJS.ProcessEnv; timeoutMs?: number }

/**
 * Sends one JSON body to the report endpoint if (and only if) `kind`'s switch is on and an endpoint is configured.
 * Never throws: the answer says whether it went and, if not, why in plain words.
 */
export async function upload(store: Store, kind: "crash" | "telemetry", body: unknown, deps: UploadDeps = {}): Promise<{ sent: boolean; why?: string }> {
  if (!(kind === "crash" ? crashReportsOn(store) : telemetryOn(store))) return { sent: false, why: "The switch is off." };
  const ep = reportEndpoint(deps.env);
  if (!ep) return { sent: false, why: "No report endpoint is configured." };
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await doFetch(ep.href, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    return res.ok ? { sent: true } : { sent: false, why: `The endpoint answered ${res.status}.` };
  } catch (e) {
    return { sent: false, why: `Couldn't reach the endpoint (${(e as Error).name}).` };
  }
}

/** At start: send crash reports waiting from earlier runs, if the switch and endpoint allow. Sent files move to crashes/sent. */
export async function sendPendingCrashes(store: Store, dataDir: string, deps: UploadDeps = {}): Promise<number> {
  if (!crashReportsOn(store) || !reportEndpoint(deps.env)) return 0;
  let n = 0;
  for (const { name, report } of pendingCrashReports(dataDir).slice(-20)) {
    const r = await upload(store, "crash", report, deps);
    if (!r.sent) break; // the endpoint is down or off: try again at the next start
    markCrashSent(dataDir, name);
    store.audit("hub", "report.crash.sent", name);
    n++;
  }
  return n;
}
