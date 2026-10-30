import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "./db/store.js";
import { Approvals } from "./orchestrator/approvals.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { buildServer } from "./api/server.js";
import { seed } from "./seed.js";
import { defaultTailscale } from "./remote/tailscale.js";
import { remoteHost } from "./remote/status.js";
import { connectTunnel } from "./relay/tunnel.js";
import { ControlFolder, defaultControlRoot } from "./control/folder.js";
import { DiscoveryService } from "./discovery/service.js"; // 1.3
import { ensurePhaseStart } from "./retro/index.js"; // 2.1
import { startScheduled } from "./report/schedule.js"; // 2.7
import { joinOpenRosters } from "./rooms/index.js"; // 4.3
import { installCrashHandlers } from "./distribution/crash.js"; // 4.7
import { sendPendingCrashes } from "./distribution/reporting.js"; // 4.7
import { UpdateChecker, startTelemetryTimer } from "./distribution/schedule.js"; // 4.7
import { appVersion } from "./distribution/version.js"; // 4.7
import { cachedShellPath, hubPath, knownCliDirs } from "./env/shellPath.js";
import { takeHubLock } from "./main/hublock.js";

// Apps launched from Finder get a thin PATH; make sure the agent CLIs are findable.
const home = homedir();
const dataDir = process.env.AGENT_ROOM_DATA ?? join(homedir(), ".agent-room");
const port = Number(process.env.AGENT_ROOM_PORT ?? 4747);
const demo = process.env.AGENT_ROOM_DEMO === "1";
const ownerName = process.env.AGENT_ROOM_OWNER ?? "Blake";
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try { chmodSync(dataDir, 0o700); } catch { /* S6: best effort; the folder holds the database and keys, so only the owner reads it */ }
// The owner's own PATH (from their login shell) plus the usual install folders, so `claude`, `codex` and the rest are found from a Finder launch.
// Speed: the login-shell PATH is cached to <dataDir>/shell-path.json so a restart doesn't pay the ~5s shell probe; it is refreshed in the background.
const shellPath = demo ? undefined : cachedShellPath({ file: join(dataDir, "shell-path.json"), onRefresh: (p) => { process.env.PATH = hubPath(process.env.PATH, p, knownCliDirs(home)); } });
process.env.PATH = hubPath(process.env.PATH, shellPath, knownCliDirs(home));
// Work from the data folder, not the folder the hub was started in. Updating the app replaces its bundle, which deletes the folder an older hub
// is still running in; every program it then starts without a folder of its own inherits a folder that no longer exists, and Codex refuses to
// start ("Error loading configuration: No such file or directory").
process.chdir(dataDir);
// Which hub files this process runs, and their date: the Mac app compares them with what's on disk now and restarts a hub left running from an
// older build (the files were replaced since it started).
{
  const script = fileURLToPath(import.meta.url);
  let scriptMtimeMs = 0;
  try { scriptMtimeMs = Math.round(statSync(script).mtimeMs); } catch { /* run from source */ }
  try { writeFileSync(join(dataDir, "hub.json"), JSON.stringify({ pid: process.pid, script, scriptMtimeMs, startedAt: Date.now() }) + "\n", { mode: 0o600 }); } catch { /* best effort */ }
}
// Single-hub guard: if another live hub already drives this data folder, don't run a second set of orchestrator loops against the same DB. Exit cleanly; the launcher restarts a hub it replaced.
{
  const lock = takeHubLock({ file: join(dataDir, "hub.lock"), port });
  console.log(lock.message);
  if (!lock.ok) process.exit(0);
}
// 4.7: an uncaught exception or unhandled rejection is written (scrubbed) to <data>/crashes/ and the hub exits; launchd or the app starts it again.
installCrashHandlers({ dataDir, version: appVersion() });

const store = new Store(join(dataDir, demo ? "demo.db" : "agent-room.db"));
seed(store, demo);
ensurePhaseStart(store); // 2.1: first-pass acceptance is measured from the first run with retros
const approvals = new Approvals(store);
// 1.9: the control folder (~/Agent Room, or $AGENT_ROOM_HOME). Demo mode keeps its own so mock agents never write to the real one.
let control: ControlFolder | undefined = new ControlFolder(process.env.AGENT_ROOM_HOME || (demo ? join(dataDir, "Agent Room (demo)") : defaultControlRoot()), store, { ownerName });
try { await control.init(); control.start(); } catch (e) { console.error(`Control folder unavailable (${(e as Error).message}); running without it.`); control = undefined; }
const orch = new Orchestrator(store, approvals, { dataDir, mcpUrl: () => `http://127.0.0.1:${port}/mcp`, control });
// 2.5: put the MEMORY.md files and the opted-in agents' context files in step with shared memory, then check for expired facts every hour.
await orch.memory.init().catch((e) => console.error(`Memory files not synced: ${(e as Error).message}`));
orch.memory.startTimer();
// 2.7: the evening digest (and the one a sleeping hub missed, sent once now), plus the weekly scorecard and monthly ledger saved to the Library.
startScheduled(store, orch.library);
const tailscale = defaultTailscale();
// 1.3: finds the agents, tools and local model servers on this Mac and joins Hermes to the hub.
const discovery = new DiscoveryService(store, { control: () => orch.control, mcpUrl: () => `http://127.0.0.1:${port}/mcp` });
const updates = new UpdateChecker(store); // 4.7: reads the appcast once a day, only when a feed address is set and the owner hasn't turned update checks off
const app = await buildServer({ store, orch, approvals, ownerName, tailscale, discovery, distribution: { updates } });
// 1.5: record what the hub found, so a surprising schedule can be explained later.
const cap = orch.governor.snapshot();
store.audit("hub", "capacity.detected", `${cap.summary}. ${cap.plan.reason}`);
console.log(`Capacity: ${cap.summary}`);

await app.listen({ host: "0.0.0.0", port });
// 1.3: look around in the background (it can take a few seconds) and again every half hour. Not in demo mode, which uses practice agents.
if (!demo) {
  // 4.7: all three do nothing unless their switch is on (update checks default on, crash reports and usage counts default off) and an address is set.
  updates.start();
  startTelemetryTimer(store, { dataDir });
  void sendPendingCrashes(store, dataDir).catch(() => undefined);
  void discovery.run().then((r) => console.log(`Discovery: ${r.summary}`)).catch((e) => console.error(`Discovery failed: ${(e as Error).message}`));
  discovery.startTimer();
}
// 1.4: drop worktrees left behind by tasks that are no longer open, then pick up any work that was running when the hub last stopped.
await orch.pruneWorktrees().catch(() => undefined);
const resumed = orch.recover();
orch.resumes.sweep(); // 2.3: close practice runs the last stop cut short, graduate agents that have the runs, write missing RESUME.md files
// 4.3: standing rooms. New agents join the rooms that include everyone; scheduled goals start from ROOM.md (a sleeping hub catches up once, within its window).
joinOpenRosters(store, () => orch.control, (m) => console.warn(`[rooms] ${m}`));
orch.standing.tick();
orch.standing.start();
orch.nightshift.start(); // 4.5: every 15 minutes inside the night window (off until the owner turns nightShift on)
orch.policy.start(); // 4.2: expired leases are removed every 30 seconds; steady approvals become proposed rules once a day
if (resumed.length) console.log(`Resumed ${resumed.length} goal${resumed.length > 1 ? "s" : ""} after restart.`);
const tsStatus = await tailscale.status(true, port);
const ts = remoteHost(tsStatus);
// 1.2: report (never change) any difference between Tailscale's Funnel setting and the owner's.
const remote = await (app as unknown as { remoteCheck: () => Promise<import("@agent-room/shared").RemoteStatus | undefined> }).remoteCheck();
const code = (app as unknown as { pairingCode: () => string }).pairingCode();
console.log(`
Agent Room hub ${demo ? "(demo mode, mock agents)" : ""}
  Local:      http://127.0.0.1:${port}
  Tailscale:  ${ts ? `http://${ts}:${port}` : tsStatus.detail + " Phones and other devices need it."}
  Funnel:     ${remote?.funnel.on ? `ON, ${remote.funnel.url} (/mcp only)` : "off"}${remote?.funnel.drift ? `   WARNING: ${remote.funnel.drift === "on_in_tailscale" ? "on in Tailscale but off in Agent Room" : remote.funnel.drift === "wrong_target" ? `/mcp points at ${remote.funnel.wrongTarget}, not this hub` : "off in Tailscale but on in Agent Room"}` : ""}
  Pair code:  ${code}   (valid 10 minutes, one use; restart for a new one)
  Data:       ${dataDir}
  Control:    ${control?.root ?? "not available"}
Only localhost and Tailscale addresses are served.`);
// 1.2: loud, once at start (and in the audit log): a raw TCP forward to the hub makes remote callers look local.
for (const w of remote?.warnings ?? []) console.warn(`WARNING: ${w}`);

// Optional outbound relay: cloud agents reach /mcp through it; nothing on this Mac listens for the relay.
const { AGENT_ROOM_RELAY_URL: relayUrl, AGENT_ROOM_RELAY_HUB_ID: relayHubId, AGENT_ROOM_RELAY_SECRET: relaySecret } = process.env;
if (relayUrl && relayHubId && relaySecret) {
  connectTunnel({ relayUrl, hubId: relayHubId, secret: relaySecret, localBase: `http://127.0.0.1:${port}` });
  console.log(`Relay: dialing out to ${new URL(relayUrl).host} as hub "${relayHubId}" (exposes /mcp only).`);
}
