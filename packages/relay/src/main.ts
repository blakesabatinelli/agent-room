import { startRelay } from "./relay.js";

const port = Number(process.env.PORT ?? 8080);
const hubSecrets: Record<string, string> = {};
for (const entry of (process.env.RELAY_HUBS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const i = entry.indexOf(":");
  const hubId = entry.slice(0, i);
  const hash = entry.slice(i + 1).toLowerCase();
  if (i < 1 || !/^[0-9a-f]{64}$/.test(hash)) { console.error(`RELAY_HUBS entry "${hubId || entry}" must look like hubId:<sha256 hex of the secret>`); process.exit(1); }
  hubSecrets[hubId] = hash;
}
if (!Object.keys(hubSecrets).length) { console.error("Set RELAY_HUBS=hubId:sha256hex[,hubId2:sha256hex]. Hash a secret with: printf %s \"$SECRET\" | sha256sum"); process.exit(1); }

const relay = await startRelay({ port, hubSecrets });
console.log(`Agent Room relay listening on :${relay.port} for ${Object.keys(hubSecrets).length} hub(s). Hubs connect to /hub/connect; clients call /h/<hubId>/mcp.`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void relay.close().then(() => process.exit(0)); });
