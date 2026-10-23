// 1.2: the hub's view of remote access = Tailscale's status + what the owner asked for.
import type { RemoteStatus, TailscaleStatus } from "@agent-room/shared";

/** Best host for other devices: an explicit AGENT_ROOM_TAILSCALE_IP, else the MagicDNS name, else the tailnet IP. */
export function remoteHost(st: Pick<TailscaleStatus, "state" | "dnsName" | "ip">): string | undefined {
  const forced = process.env.AGENT_ROOM_TAILSCALE_IP;
  if (forced) return forced;
  return st.state === "running" ? st.dnsName ?? st.ip : undefined;
}

export function composeRemote(st: TailscaleStatus, intent: boolean, hubPort: number): RemoteStatus {
  const host = remoteHost(st);
  const drift = st.funnel.on && !intent ? "on_in_tailscale" : !st.funnel.on && intent && st.state === "running" ? "off_in_tailscale" : undefined;
  return {
    state: st.state, ip: st.ip, dnsName: st.dnsName, tailnet: st.tailnet, detail: st.detail, checkedAt: st.checkedAt,
    host, hubUrl: host ? `http://${host.includes(":") ? `[${host}]` : host}:${hubPort}` : undefined,
    funnel: { on: st.funnel.on, url: st.funnel.url, intent, drift, extraPaths: st.funnel.extraPaths },
  };
}
