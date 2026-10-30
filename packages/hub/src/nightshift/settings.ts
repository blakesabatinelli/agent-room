import { NIGHT_SHIFT_DEFAULTS, type NightShiftSettings } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { dayKey, inQuiet, minuteOfDay, parseClock, prevDay } from "../attention/time.js";

/**
 * 4.5 The night window and its settings. `nightShift` in the owner's settings; anything unset or out of range takes the default.
 * Times are local, in the zone the attention gate uses, so the digest, quiet hours and the night all agree on what "night" means.
 */

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt);

export function nightSettings(store: Pick<Store, "getSettings">): NightShiftSettings {
  const s = store.getSettings().nightShift ?? {};
  const d = NIGHT_SHIFT_DEFAULTS;
  return {
    enabled: s.enabled === true,
    from: parseClock(s.from) === undefined ? d.from : s.from!,
    to: parseClock(s.to) === undefined ? d.to : s.to!,
    maxRunsPerNight: Math.floor(clamp(s.maxRunsPerNight, 0, 200, d.maxRunsPerNight)),
    minExpiringShare: clamp(s.minExpiringShare, 0, 1, d.minExpiringShare),
    weight: clamp(s.weight, 0, 1, d.weight),
    ...(s.allowLabeledData === true ? { allowLabeledData: true } : {}), // S12: present only when the owner turned it on
  };
}

/**
 * The night a moment belongs to: the local date the window opened on ("YYYY-MM-DD"), or undefined outside the window.
 * A window that ends before it starts runs across midnight (23:00 to 06:00 is one night, named for the evening it began).
 * Equal ends: there is no window.
 */
export function nightOf(now: number, tz: string, from: string, to: string): string | undefined {
  const f = parseClock(from), t = parseClock(to);
  if (f === undefined || t === undefined || f === t || !inQuiet(now, tz, f, t)) return undefined;
  const day = dayKey(now, tz);
  return f < t || minuteOfDay(now, tz) >= f ? day : prevDay(day);
}
