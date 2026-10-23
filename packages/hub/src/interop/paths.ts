// 4.6 The two public paths of the A2A server, kept in a file with no imports so the 1.2 remote gate, the Tailscale wrapper and the routes agree.

/**
 * Where an A2A server publishes its Agent Card: https://{server_domain}/.well-known/agent-card.json
 * (A2A v1.0.0, section 8.2: https://a2a-protocol.org/latest/specification/ and
 * https://github.com/a2aproject/A2A/blob/v1.0.0/docs/specification.md). The older `/.well-known/agent.json` was dropped in 0.3 and isn't served.
 */
export const CARD_PATH = "/.well-known/agent-card.json";
/** The JSON-RPC endpoint the card points at. */
export const A2A_PATH = "/a2a";
/** The only two paths that may ever reach the hub through Funnel, and only while the owner has "A2A through Funnel" on. */
export const A2A_FUNNEL_PATHS: readonly string[] = [CARD_PATH, A2A_PATH];

/** Paths that skip the paired-device check (the card is public discovery; /a2a checks its own key). Exact match: /a2a/keys is not one of them. */
export const isA2aOpenPath = (path: string): boolean => path === CARD_PATH || path === A2A_PATH;

/**
 * The 1.2 remote gate for a proxied (Funnel) request: may it reach the A2A server? Only when the setting is on, and only
 * GET on the card path or POST on /a2a. Everything else stays 404.
 */
export function a2aRemoteOpen(method: string, path: string, funnelOn: boolean): boolean {
  if (!funnelOn) return false;
  return (method === "GET" && path === CARD_PATH) || (method === "POST" && path === A2A_PATH);
}
