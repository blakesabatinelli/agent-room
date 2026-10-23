// 4.7 The two background jobs: the weekly telemetry batch and the daily look at the appcast. Both are timers that do nothing unless their
// switch is on (and, for telemetry, an endpoint is configured). `tick` functions take `now` so tests don't wait.
import type { UpdateOffer, VersionInfo } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { offerFrom, parseAppcast } from "./appcast.js";
import { crashCountSince } from "./crash.js";
import { KV_TELEMETRY_SENT, KV_TELEMETRY_SINCE, KV_TELEMETRY_TRIED, WEEK_MS, reportEndpoint, telemetryOn, updateChecksOn, upload, type UploadDeps } from "./reporting.js";
import { buildTelemetry, sanitizeTelemetry } from "./telemetry.js";
import { appVersion, infoPlistText, macosVersion, plistString } from "./version.js";

const HOUR = 3600_000;
const RETRY_AFTER = 6 * HOUR;

export interface TelemetrySchedulerOpts extends UploadDeps { dataDir: string; version?: string; macos?: string }

/** The batch as it would go right now. The same function feeds the preview and the upload. */
export function currentTelemetry(store: Store, o: { dataDir: string; version?: string; macos?: string; now?: number }) {
  const now = o.now ?? Date.now();
  return sanitizeTelemetry(buildTelemetry(store, { version: o.version ?? appVersion(), macos: o.macos ?? macosVersion(), crashCount: crashCountSince(o.dataDir, now - WEEK_MS), now }));
}

/** One pass: send the weekly batch if it is on, due, and an endpoint exists. Returns whether a batch went. */
export async function telemetryTick(store: Store, o: TelemetrySchedulerOpts, now = Date.now()): Promise<boolean> {
  if (!telemetryOn(store) || !reportEndpoint(o.env)) return false;
  const last = store.getKV<number | null>(KV_TELEMETRY_SENT, null) ?? store.getKV<number | null>(KV_TELEMETRY_SINCE, null) ?? now;
  if (now - last < WEEK_MS) return false;
  const tried = store.getKV<number | null>(KV_TELEMETRY_TRIED, null);
  if (tried && now - tried < RETRY_AFTER) return false;
  store.setKV(KV_TELEMETRY_TRIED, now);
  const r = await upload(store, "telemetry", currentTelemetry(store, { ...o, now }), o);
  if (!r.sent) { store.audit("hub", "report.telemetry.failed", r.why ?? ""); return false; }
  store.setKV(KV_TELEMETRY_SENT, now);
  store.audit("hub", "report.telemetry.sent", "weekly counts");
  return true;
}

export function startTelemetryTimer(store: Store, o: TelemetrySchedulerOpts): () => void {
  const t = setInterval(() => { void telemetryTick(store, o).catch(() => undefined); }, HOUR);
  t.unref();
  return () => clearInterval(t);
}

// ---- updates

export type TextFetch = (url: string, init: { signal?: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The appcast address: AGENT_ROOM_APPCAST_URL, else SUFeedURL from the app's own Info.plist (Contents/Info.plist, two folders above Hub/). Placeholders count as unset. */
export function feedUrl(env: NodeJS.ProcessEnv = process.env, plistText?: string): string | undefined {
  const raw = env.AGENT_ROOM_APPCAST_URL?.trim() || plistString(plistText ?? infoPlistText(), "SUFeedURL");
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    if (u.hostname.endsWith(".invalid") || /REPLACE|PLACEHOLDER/i.test(raw)) return undefined;
    return u.href;
  } catch { return undefined; }
}

export interface UpdateCheckerOpts { fetch?: TextFetch; env?: NodeJS.ProcessEnv; plistText?: string; version?: string; macos?: string; timeoutMs?: number }
const KV_UPDATE = "updates.last"; // { at, offer?, error? }

export class UpdateChecker {
  constructor(private store: Store, private o: UpdateCheckerOpts = {}) {}
  private version() { return this.o.version ?? appVersion(); }

  /** What the app shows. Reads the last result; never touches the network. */
  info(): VersionInfo {
    const last = this.store.getKV<{ at?: number; offer?: UpdateOffer; error?: string }>(KV_UPDATE, {});
    const current = this.version();
    // An offer saved before an update installed is stale: only show it while it is still newer than the running version.
    const offer = last.offer && offerFrom([{ version: last.offer.version }], current) ? last.offer : undefined;
    return {
      version: current, macos: this.o.macos ?? macosVersion(), feedConfigured: !!feedUrl(this.o.env, this.o.plistText), checksOn: updateChecksOn(this.store),
      ...(last.at ? { checkedAt: last.at } : {}), ...(offer ? { update: offer } : {}), ...(last.error ? { error: last.error } : {}),
    };
  }

  /** Fetch the appcast and remember what it says. `force` ignores the owner's automatic-check switch (the "Check now" button). */
  async check(force = false, now = Date.now()): Promise<VersionInfo> {
    const url = feedUrl(this.o.env, this.o.plistText);
    if (!url || (!force && !updateChecksOn(this.store))) return this.info();
    try {
      const doFetch = this.o.fetch ?? (globalThis.fetch as unknown as TextFetch);
      const res = await doFetch(url, { signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000), headers: { "user-agent": `AgentRoom/${this.version()}`, accept: "application/xml, text/xml" } });
      if (!res.ok) throw new Error(`The update server answered ${res.status}.`);
      const offer = offerFrom(parseAppcast(await res.text()), this.version(), this.o.macos ?? macosVersion());
      this.store.setKV(KV_UPDATE, { at: now, ...(offer ? { offer } : {}) });
      if (offer) this.store.audit("hub", "update.available", offer.version);
    } catch (e) {
      const msg = (e as Error).name === "TimeoutError" ? "The update server didn't answer in time." : (e as Error).message;
      this.store.setKV(KV_UPDATE, { at: now, error: msg.slice(0, 200) });
    }
    return this.info();
  }

  /** A day-by-day check, the first one a minute after start. Does nothing while the switch is off or no feed is set. */
  start(): () => void {
    const first = setTimeout(() => { void this.check().catch(() => undefined); }, 60_000);
    const t = setInterval(() => { void this.check().catch(() => undefined); }, 24 * HOUR);
    first.unref(); t.unref();
    return () => { clearTimeout(first); clearInterval(t); };
  }
}
