import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "./db/store.js";
import { Approvals } from "./orchestrator/approvals.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { buildServer } from "./api/server.js";
import { seed } from "./seed.js";
import { tailscaleIp } from "./net.js";
import { connectTunnel } from "./relay/tunnel.js";
import { ControlFolder, defaultControlRoot } from "./control/folder.js";

// Apps launched from Finder get a thin PATH; make sure the agent CLIs are findable.
const home = homedir();
const extraPath = [join(home, ".local/bin"), join(home, ".npm-global/bin"), join(home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
process.env.PATH = [...new Set([...(process.env.PATH ?? "").split(":"), ...extraPath].filter(Boolean))].join(":");

const dataDir = process.env.AGENT_ROOM_DATA ?? join(homedir(), ".agent-room");
const port = Number(process.env.AGENT_ROOM_PORT ?? 4747);
const demo = process.env.AGENT_ROOM_DEMO === "1";
const ownerName = process.env.AGENT_ROOM_OWNER ?? "Blake";
mkdirSync(dataDir, { recursive: true });

const store = new Store(join(dataDir, demo ? "demo.db" : "agent-room.db"));
seed(store, demo);
const approvals = new Approvals(store);
// 1.9: the control folder (~/Agent Room, or $AGENT_ROOM_HOME). Demo mode keeps its own so mock agents never write to the real one.
let control: ControlFolder | undefined = new ControlFolder(process.env.AGENT_ROOM_HOME || (demo ? join(dataDir, "Agent Room (demo)") : defaultControlRoot()), store, { ownerName });
try { await control.init(); control.start(); } catch (e) { console.error(`Control folder unavailable (${(e as Error).message}); running without it.`); control = undefined; }
const orch = new Orchestrator(store, approvals, { dataDir, mcpUrl: () => `http://127.0.0.1:${port}/mcp`, control });
const app = await buildServer({ store, orch, approvals, ownerName });
// 1.5: record what the hub found, so a surprising schedule can be explained later.
const cap = orch.governor.snapshot();
store.audit("hub", "capacity.detected", `${cap.summary}. ${cap.plan.reason}`);
console.log(`Capacity: ${cap.summary}`);

await app.listen({ host: "0.0.0.0", port });
// 1.4: drop worktrees left behind by tasks that are no longer open, then pick up any work that was running when the hub last stopped.
await orch.pruneWorktrees().catch(() => undefined);
const resumed = orch.recover();
if (resumed.length) console.log(`Resumed ${resumed.length} goal${resumed.length > 1 ? "s" : ""} after restart.`);
const ts = await tailscaleIp();
const code = (app as unknown as { pairingCode: () => string }).pairingCode();
console.log(`
Agent Room hub ${demo ? "(demo mode, mock agents)" : ""}
  Local:      http://127.0.0.1:${port}
  Tailscale:  ${ts ? `http://${ts}:${port}` : "not detected (install Tailscale or set AGENT_ROOM_TAILSCALE_IP)"}
  Pair code:  ${code}   (valid 10 minutes, one use; restart for a new one)
  Data:       ${dataDir}
  Control:    ${control?.root ?? "not available"}
Only localhost and Tailscale addresses are served.`);

// Optional outbound relay: cloud agents reach /mcp through it; nothing on this Mac listens for the relay.
const { AGENT_ROOM_RELAY_URL: relayUrl, AGENT_ROOM_RELAY_HUB_ID: relayHubId, AGENT_ROOM_RELAY_SECRET: relaySecret } = process.env;
if (relayUrl && relayHubId && relaySecret) {
  connectTunnel({ relayUrl, hubId: relayHubId, secret: relaySecret, localBase: `http://127.0.0.1:${port}` });
  console.log(`Relay: dialing out to ${new URL(relayUrl).host} as hub "${relayHubId}" (exposes /mcp only).`);
}
