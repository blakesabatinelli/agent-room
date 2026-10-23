# Agent Room relay (spike 0.3 prototype)

An outbound-only relay so a cloud agent can reach a hub's MCP endpoint without anything on the Mac listening on the internet.

```
cloud agent --HTTPS--> relay  <==WebSocket (dialled out by the hub)==  hub (Mac)
   POST /h/<hubId>/mcp            frames: req / head / data / end / err / cancel      -> http://127.0.0.1:<port>/mcp
```

The hub opens the WebSocket to the relay. The relay frames each client request over that socket; the hub's tunnel replays it against its own loopback server, so the hub's normal MCP bearer-token check runs on every call. The relay forwards `authorization` untouched and never validates, stores or logs MCP tokens.

## Run it

```sh
# 1. Pick a hub id and a long random secret; give the relay only the hash.
SECRET=$(openssl rand -hex 32)
printf %s "$SECRET" | sha256sum | cut -d' ' -f1          # -> <hash>

# 2. Relay (anywhere with a public HTTPS front)
PORT=8080 RELAY_HUBS="blakes-mac:<hash>" pnpm --filter @agent-room/relay start
# or: docker build -f packages/relay/Dockerfile -t agent-room-relay .   (from the repo root)
#     docker run -p 8080:8080 -e RELAY_HUBS="blakes-mac:<hash>" agent-room-relay

# 3. Hub (on the Mac)
AGENT_ROOM_RELAY_URL=wss://relay.example.com/hub/connect \
AGENT_ROOM_RELAY_HUB_ID=blakes-mac \
AGENT_ROOM_RELAY_SECRET=$SECRET \
pnpm hub:start

# 4. Cloud agent MCP URL (use an MCP token made in the hub, e.g. via the connection snippets)
https://relay.example.com/h/blakes-mac/mcp
```

| Env (relay) | Meaning |
|---|---|
| `PORT` | Listen port (default 8080). |
| `RELAY_HUBS` | Comma list of `hubId:sha256hex(secret)`. Required. |

| Env (hub) | Meaning |
|---|---|
| `AGENT_ROOM_RELAY_URL` | `ws(s)://<relay>/hub/connect`. All three must be set or the tunnel stays off. |
| `AGENT_ROOM_RELAY_HUB_ID` | Your hub id. |
| `AGENT_ROOM_RELAY_SECRET` | The secret whose sha256 the relay holds. |

Library options (`startRelay`): `allowPaths` (default `/mcp`, `/health`), `maxBodyBytes` (5 MB), `requestTimeoutMs` (120 s to first byte and between chunks), `pingIntervalMs` (25 s).

## Security model

- The Mac opens no inbound port. The hub dials out; the tunnel reconnects with exponential backoff (1 s to 30 s, jittered) and drops a link that goes silent for 75 s.
- Hub to relay: `x-hub-id` plus `Authorization: Bearer <secret>`; the relay stores only sha256(secret) and compares digests in constant time. One live connection per hub id; a newer one replaces the older.
- Client to relay: no relay-level auth at all. Anyone who can reach the relay URL can send `/mcp` requests to the hub; the hub rejects them unless they carry a valid MCP token. Treat the MCP token as the only credential.
- Allowlist, enforced twice (relay and hub tunnel): only `/mcp` and `/health`. Paths are normalised before matching, so `..`, `//`, and encoded tricks do not reach other routes. `/agents`, `/rooms`, `/pair`, `/mcp-tokens`, `/ws` and the phone web app are not reachable through the relay.
- Hop-by-hop headers and `host` are stripped; `x-forwarded-for` is overwritten with the socket peer; any client-sent `x-agent-room-via` is dropped and the tunnel sets `x-agent-room-via: relay`.
- Nothing logs headers or bodies. The relay logs nothing per request.

## Not done yet

- **End-to-end encryption.** TLS must be terminated in front of the relay, so the relay operator (and anything between TLS and the process) sees MCP traffic in the clear: file contents, tool arguments, tokens. This is the biggest gap.
- **Phone web app paths.** Only `/mcp` and `/health` are allowed. Device pairing, REST and `/ws` for the phone are not relayed.
- **Rate limiting and abuse controls.** No limits on failed hub or MCP auth, request rate, concurrent requests per hub, or WebSocket connections per IP. No backpressure from slow clients onto the hub.
- **Multi-tenant accounts.** Hubs are a static env list; no signup, rotation, revocation or per-hub quotas. Secrets in `RELAY_HUBS` are unsalted sha256 of a high-entropy secret, fine for random 256-bit values, wrong for user-chosen ones.
- **Real client IPs behind a proxy.** `x-forwarded-for` is the immediate peer, which will be the TLS proxy.
- **Pinned container build.** The Dockerfile runs `npm install` rather than using the workspace lockfile, and it has not been built in CI (no Docker daemon was available when this was written).
- **Streaming of large request bodies.** Request bodies are buffered (5 MB cap) and sent as one base64 frame.
