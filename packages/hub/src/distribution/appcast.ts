// 4.7 A tiny reader for Sparkle's appcast.xml, and the "is there a newer version" check built on it.
// The hub only reads: Sparkle itself (inside the Mac app) downloads and installs. This feeds the in-app "a new version is available" banner.
// Not a general XML parser. It finds <item> blocks and the handful of tags Sparkle writes, never expands entities or DTDs, and refuses
// anything that is not https for the links it returns.
import type { UpdateOffer } from "@agent-room/shared";
import { compareVersions } from "./version.js";

export interface AppcastItem {
  /** sparkle:version, the build number Sparkle compares. */
  version: string;
  shortVersion?: string;
  title?: string;
  pubDate?: string;
  /** https only. */
  url?: string;
  notesUrl?: string;
  minimumSystemVersion?: string;
  /** A channel name means a beta or other opt-in channel. Those items are not offered to everyone. */
  channel?: string;
}

const MAX_XML = 1_000_000;

const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
    .replace(/&amp;/g, "&").trim();

/** The text of the first <tag>…</tag> in a block (namespace prefix included in the tag name, e.g. sparkle:version). */
function tagText(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag.replace(":", "\\:")}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag.replace(":", "\\:")}>`).exec(block);
  const v = m ? decode(m[1]) : undefined;
  return v || undefined;
}

function attrs(tagSource: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tagSource.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3] ?? "");
  return out;
}

const httpsOnly = (u?: string): string | undefined => {
  if (!u) return undefined;
  try { const p = new URL(u); return p.protocol === "https:" && !p.username && !p.password ? p.href : undefined; } catch { return undefined; }
};

export function parseAppcast(xml: string): AppcastItem[] {
  if (xml.length > MAX_XML) throw new Error("The appcast is too large to read.");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("The appcast has a DTD, which isn't allowed.");
  const items: AppcastItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const enc = /<enclosure\b([^>]*?)\/?>/.exec(block);
    const ea = enc ? attrs(enc[1]) : {};
    const version = tagText(block, "sparkle:version") ?? ea["sparkle:version"];
    if (!version) continue;
    items.push({
      version,
      shortVersion: tagText(block, "sparkle:shortVersionString") ?? ea["sparkle:shortVersionString"],
      title: tagText(block, "title"),
      pubDate: tagText(block, "pubDate"),
      url: httpsOnly(ea.url),
      notesUrl: httpsOnly(tagText(block, "sparkle:releaseNotesLink")),
      minimumSystemVersion: tagText(block, "sparkle:minimumSystemVersion"),
      channel: tagText(block, "sparkle:channel"),
    });
  }
  return items;
}

/**
 * The newest item on the default channel that this Mac can run, if it is newer than `current`.
 * `macos` is "15.1"; leave it out to skip the minimum-system check.
 */
export function offerFrom(items: AppcastItem[], current: string, macos?: string): UpdateOffer | undefined {
  const knownMac = !!macos && /^\d/.test(macos);
  const usable = items.filter((i) => !i.channel && (!knownMac || !i.minimumSystemVersion || compareVersions(macos!, i.minimumSystemVersion) >= 0));
  usable.sort((a, b) => compareVersions(b.version, a.version));
  const best = usable[0];
  if (!best || compareVersions(best.version, current) <= 0) return undefined;
  return { version: best.version, shortVersion: best.shortVersion, title: best.title, pubDate: best.pubDate, downloadUrl: best.url, notesUrl: best.notesUrl };
}
