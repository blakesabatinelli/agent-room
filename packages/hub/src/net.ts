import { defaultTailscale } from "./remote/tailscale.js";

/** Loopback or Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) only. */
export function isAllowedLocalAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  if (a === "127.0.0.1" || a === "::1") return true;
  if (a.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
  const m = a.match(/^100\.(\d+)\.\d+\.\d+$/);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** The Mac's tailnet IP. Sourced from the Tailscale status (remote/tailscale.ts); AGENT_ROOM_TAILSCALE_IP overrides it. */
export async function tailscaleIp(): Promise<string | undefined> {
  if (process.env.AGENT_ROOM_TAILSCALE_IP) return process.env.AGENT_ROOM_TAILSCALE_IP;
  const st = await defaultTailscale().status();
  return st.state === "running" ? st.ip : undefined;
}

/** Optional phone push via ntfy (set AGENT_ROOM_NTFY_TOPIC; use a long random topic). */
export async function pushNotify(title: string, body: string) {
  const topic = process.env.AGENT_ROOM_NTFY_TOPIC;
  if (!topic) return;
  const server = process.env.AGENT_ROOM_NTFY_SERVER || "https://ntfy.sh";
  try { await fetch(`${server}/${topic}`, { method: "POST", headers: { Title: title, Priority: "high" }, body }); } catch { /* best effort */ }
}
