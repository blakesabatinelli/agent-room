import { runProc } from "./adapters/proc.js";

/** Loopback or Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) only. */
export function isAllowedLocalAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  if (a === "127.0.0.1" || a === "::1") return true;
  if (a.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
  const m = a.match(/^100\.(\d+)\.\d+\.\d+$/);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

export async function tailscaleIp(): Promise<string | undefined> {
  if (process.env.AGENT_ROOM_TAILSCALE_IP) return process.env.AGENT_ROOM_TAILSCALE_IP;
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    const r = await runProc(bin, ["ip", "-4"], { timeoutMs: 3000 });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().split("\n")[0];
  }
  return undefined;
}

/** Optional phone push via ntfy (set AGENT_ROOM_NTFY_TOPIC; use a long random topic). */
export async function pushNotify(title: string, body: string) {
  const topic = process.env.AGENT_ROOM_NTFY_TOPIC;
  if (!topic) return;
  const server = process.env.AGENT_ROOM_NTFY_SERVER || "https://ntfy.sh";
  try { await fetch(`${server}/${topic}`, { method: "POST", headers: { Title: title, Priority: "high" }, body }); } catch { /* best effort */ }
}
