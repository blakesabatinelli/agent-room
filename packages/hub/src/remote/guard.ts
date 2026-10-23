// 1.2 Funnel hardening. Tailscale serve/funnel proxies requests to the hub from 127.0.0.1, so the hub's
// interface check can't tell them from the Mac's own traffic. Anything that looks proxied is "remote":
// it may reach POST /mcp (and its 405 GET) and nothing else.
//
// This is a DENYLIST of proxy markers, not an allowlist, so it does NOT fail closed. A forwarder that adds no marker and keeps the
// caller's Host off *.ts.net (a raw TCP forward such as `tailscale funnel --tls-terminated-tcp`, `ssh -L`, `socat`) looks exactly like
// the Mac's own traffic. So nothing loopback-only may rely on this check alone: POST /pair/local also needs the secret in
// <data dir>/local-pair.secret, which a remote caller can't read. Tailscale's serve config is checked for such forwards (remote/tailscale.ts).

/** Headers a reverse proxy adds. Tailscale's own are listed in https://tailscale.com/docs/features/tailscale-serve (identity headers) and
 *  the Go reverse proxy it uses (X-Forwarded-*, Tailscale-Funnel-Request). A direct tailnet client never sends any of them. */
export const PROXY_HEADERS = [
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "forwarded", "via",
  "tailscale-funnel-request", "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-app-capabilities",
  "x-agent-room-via", // set by the hub's own relay tunnel (relay/tunnel.ts) on every request it replays
];

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

interface ReqLike { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }

/** A Host header reduced to its name: no port, no trailing dot(s), lower case. "Mac.Tail1.TS.NET.:443" becomes "mac.tail1.ts.net". */
export function hostName(raw: unknown): string {
  return String((Array.isArray(raw) ? raw[0] : raw) ?? "").trim().toLowerCase().replace(/:\d*$/, "").replace(/\.+$/, "");
}

/**
 * True when the request looks like it came through a proxy such as Tailscale Funnel: a proxy header, or (backstop) a loopback connection
 * that asks for a *.ts.net name. Best effort, see the note at the top: a forwarder that sets neither is not detected.
 */
export function isRemoteRequest(req: ReqLike): boolean {
  for (const h of PROXY_HEADERS) if (req.headers[h] !== undefined) return true;
  // The proxy forwards the public Host, and Funnel only serves names under ts.net (https://tailscale.com/docs/features/tailscale-funnel,
  // limitations). A genuine loopback client says 127.0.0.1 or localhost. DNS ignores case and allows a trailing dot, so "X.TS.NET.:443" counts.
  if (LOOPBACK.has(req.socket.remoteAddress ?? "") && hostName(req.headers.host).endsWith(".ts.net")) return true;
  return false;
}

/** Drops C0/C1 control characters, DEL and the Unicode line separators, so caller-supplied text can't forge audit lines. */
export const stripControl = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "");

/** The address the proxy saw. Only the LAST entry is trusted: the proxy appends the peer it saw; earlier entries are client-supplied. */
export function forwardedIp(req: ReqLike): string {
  const raw = req.headers["x-forwarded-for"];
  const v = (Array.isArray(raw) ? raw.join(",") : raw) ?? "";
  const last = stripControl(v).split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last ? last.slice(0, 64) : "unknown";
}

/** "tools/call:read_file" for a JSON-RPC body (batches joined), for the audit log. Cheap and never throws. */
export function rpcSummary(body: unknown): string {
  const one = (m: unknown): string => {
    if (!m || typeof m !== "object") return "?";
    const { method, params } = m as { method?: unknown; params?: { name?: unknown } };
    if (typeof method !== "string") return "?";
    // Both are caller-supplied: strip control characters (\r \n \t ...) before they reach an audit detail, then cap the length.
    const name = method === "tools/call" && typeof params?.name === "string" ? `:${stripControl(params.name).slice(0, 80)}` : "";
    return `${stripControl(method).slice(0, 60)}${name}`;
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
  /** Records one failure. True when this failure is the one that locks the caller out, so a lockout can be audited once. */
  fail(key: string): boolean { const b = this.fill(key); const was = b.left >= 1; b.left -= 1; return was && b.left < 1; }
}
