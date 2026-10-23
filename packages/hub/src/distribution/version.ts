// 4.7 What version this hub is, what macOS it runs on, and how versions compare.
import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { fileURLToPath } from "node:url";

/** The Info.plist form of a VERSION line: first word, dashes to dots ("2026-10-23.1 (notes)" is "2026.10.23.1"). Same rule as scripts/package-mac.sh. */
export function plistVersion(versionFileText: string): string {
  return (versionFileText.trim().split(/\s+/)[0] ?? "").replace(/-/g, ".");
}

/**
 * Where VERSION lives: next to hub.mjs inside the app (scripts/stage-hub.sh copies it), the repo root when run from source (src/distribution)
 * or from dist/hub.mjs. AGENT_ROOM_VERSION overrides all of them (tests, and a packager that wants to force one).
 */
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_ROOM_VERSION && /^[0-9A-Za-z.+-]{1,40}$/.test(env.AGENT_ROOM_VERSION)) return env.AGENT_ROOM_VERSION;
  for (const rel of ["./VERSION", "../../../../VERSION", "../../../VERSION"]) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(p)) { const v = plistVersion(readFileSync(p, "utf8")); if (v) return v; }
    } catch { /* try the next place */ }
  }
  return "0.0.0";
}

/** The text of the app's own Info.plist (Contents/Info.plist, two folders above Hub/hub.mjs). Empty when run from source, where there is none. */
export function infoPlistText(): string {
  try { return readFileSync(fileURLToPath(new URL("../../Info.plist", import.meta.url)), "utf8"); } catch { return ""; }
}

/** One <string> value from an Info.plist's text by key, trimmed; undefined when the key is missing or empty. */
export function plistString(plistText: string, key: string): string | undefined {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plistText);
  return m?.[1]?.trim() || undefined;
}

/** "24.1.0" (Darwin's kernel number, which is what os.release() reports on a Mac) as "15.1". macOS 26 is Darwin 25. Anything else is "not-mac". */
export function macosVersionFromDarwin(darwinRelease: string, platform: string = process.platform): string {
  if (platform !== "darwin") return "not-mac";
  const m = /^(\d+)\.(\d+)/.exec(darwinRelease);
  if (!m) return "unknown";
  const major = Number(m[1]);
  if (major >= 25) return `${major + 1}.${m[2]}`;
  if (major >= 20) return `${major - 9}.${m[2]}`;
  return "unknown";
}

export function macosVersion(): string { return macosVersionFromDarwin(release()); }

/**
 * Sparkle-style comparison: split into numeric and alphabetic runs, numbers compare as numbers, a number beats letters ("1.0" is newer than
 * "1.0b1"), and a missing part counts as 0. Good enough for dotted release numbers; negative when a is older.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (s: string) => s.match(/\d+|[A-Za-z]+/g) ?? [];
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], q = y[i];
    if (p === q) continue;
    if (p === undefined) return /^\d+$/.test(q) ? (Number(q) === 0 ? 0 : -1) : 1; // "1.0" vs "1.0b1": the plain release is newer
    if (q === undefined) return /^\d+$/.test(p) ? (Number(p) === 0 ? 0 : 1) : -1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { const d = Number(p) - Number(q); if (d) return d < 0 ? -1 : 1; continue; }
    if (pn !== qn) return pn ? 1 : -1;
    const d = p.localeCompare(q);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
