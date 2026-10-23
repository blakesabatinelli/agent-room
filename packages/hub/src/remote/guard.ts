// 1.2 Funnel hardening. Tailscale serve/funnel proxies requests to the hub from 127.0.0.1, so the hub's
// interface check can't tell them from the Mac's own traffic. Anything that looks proxied is "remote":
// it may reach POST /mcp (and its 405 GET) and nothing else.

/** Headers a reverse proxy adds. Tailscale's own are listed in https://tailscale.com/docs/features/tailscale-serve (identity headers) and
 *  the Go reverse proxy it uses (X-Forwarded-*, Tailscale-Funnel-Request). A direct tailnet client never sends any of them. */
export const PROXY_HEADERS = [
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "forwarded", "via",
  "tailscale-funnel-request", "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-app-capabilities",
];

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

interface ReqLike { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }

/** True when the request came through a proxy such as Tailscale Funnel. Fails closed: a missing header is covered by the Host check. */
export function isRemoteRequest(req: ReqLike): boolean {
  for (const h of PROXY_HEADERS) if (req.headers[h] !== undefined) return true;
  // Backstop if a header were ever missing: the proxy forwards the public Host, and Funnel only serves names under ts.net
  // (https://tailscale.com/docs/features/tailscale-funnel, limitations). A genuine loopback client says 127.0.0.1 or localhost.
  if (LOOPBACK.has(req.socket.remoteAddress ?? "")) {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (host.endsWith(".ts.net")) return true;
  }
  return false;
}

/** The address the proxy saw. Only the LAST entry is trusted: the proxy appends the peer it saw; earlier entries are client-supplied. */
export function forwardedIp(req: ReqLike): string {
  const raw = req.headers["x-forwarded-for"];
  const v = (Array.isArray(raw) ? raw.join(",") : raw) ?? "";
  const last = v.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last ?? "unknown";
}

/** "tools/call:read_file" for a JSON-RPC body (batches joined), for the audit log. Cheap and never throws. */
export function rpcSummary(body: unknown): string {
  const one = (m: unknown): string => {
    if (!m || typeof m !== "object") return "?";
    const { method, params } = m as { method?: unknown; params?: { name?: unknown } };
    if (typeof method !== "string") return "?";
    const name = method === "tools/call" && typeof params?.name === "string" ? `:${params.name.slice(0, 80)}` : "";
    return `${method.slice(0, 60)}${name}`;
  };
  return (Array.isArray(body) ? body.slice(0, 5).map(one) : [one(body)]).join(", ");
}

/**
 * Failed-auth allowance per caller. Checked BEFORE the token is looked at, so a caller who has used up
 * its failures gets 429 even with a correct guess, which is what makes guessing pointless.
 */
export class AuthLimiter {
  private buckets = new Map<string, { left: number; at: number }>();
  constructor(private burst = 10, private refillMs = 6000, private now: () => number = Date.now) {}

  private fill(key: string) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) { b = { left: this.burst, at: t }; this.buckets.set(key, b); }
    else { b.left = Math.min(this.burst, b.left + (t - b.at) / this.refillMs); b.at = t; }
    if (this.buckets.size > 5000) for (const [k, v] of this.buckets) if (v.left >= this.burst) this.buckets.delete(k);
    return b;
  }
  blocked(key: string): boolean { return this.fill(key).left < 1; }
  fail(key: string): void { this.fill(key).left -= 1; }
}
