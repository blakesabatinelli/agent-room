// 1.2: the hub's view of remote access = Tailscale's status + what the owner asked for.
import type { RemoteStatus, TailscaleStatus } from "@agent-room/shared";

/** Best host for other devices: an explicit AGENT_ROOM_TAILSCALE_IP, else the MagicDNS name, else the tailnet IP. */
export function remoteHost(st: Pick<TailscaleStatus, "state" | "dnsName" | "ip">): string | undefined {
  const forced = process.env.AGENT_ROOM_TAILSCALE_IP;
  if (forced) return forced;
  return st.state === "running" ? st.dnsName ?? st.ip : undefined;
}

/** One loud sentence per raw TCP forward that ends at the hub. Such traffic reaches the hub from 127.0.0.1 with no proxy header. */
export function forwardWarnings(st: Pick<TailscaleStatus, "funnel">, hubPort: number): string[] {
  return (st.funnel.forwards ?? []).map((f) =>
    `Tailscale forwards ${f.public ? "PUBLIC (Funnel) " : ""}port ${f.port} straight to this hub (${f.target}). The hub can't tell that traffic from this Mac's own, so ` +
    `anyone who can reach port ${f.port} is treated as local on port ${hubPort}. Remove the forward in Tailscale ("tailscale serve status" shows it).`);
}

export function composeRemote(st: TailscaleStatus, intent: boolean, hubPort: number): RemoteStatus {
  const host = remoteHost(st);
  // A /mcp handler pointed somewhere else is the most serious: it is public (or about to be) and isn't the hub. It outranks the on/off mismatch.
  const drift = st.funnel.wrongTarget ? "wrong_target" as const
    : st.funnel.on && !intent ? "on_in_tailscale" as const
    : !st.funnel.on && intent && st.state === "running" ? "off_in_tailscale" as const : undefined;
  return {
    state: st.state, ip: st.ip, dnsName: st.dnsName, tailnet: st.tailnet, detail: st.detail, checkedAt: st.checkedAt,
    host, hubUrl: host ? `http://${host.includes(":") ? `[${host}]` : host}:${hubPort}` : undefined,
    funnel: { on: st.funnel.on, url: st.funnel.url, intent, drift, wrongTarget: st.funnel.wrongTarget, extraPaths: st.funnel.extraPaths },
    warnings: forwardWarnings(st, hubPort),
  };
}
