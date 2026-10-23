// 4.7 HTTP side of 1.0 distribution. Every route here needs a paired device (the hub's global hook) and none is open through Funnel.
//   GET  /version            the running version, and the update the appcast offers (if any)
//   POST /version/check      ask the appcast now
//   GET  /privacy            the switches (crash reports, usage counts, update checks), whether an endpoint exists, and the exact field list
//   PUT  /privacy            { crashReports?, telemetry?, updateChecks? }
//   GET  /telemetry/preview  the exact JSON the next weekly batch would carry
//   GET  /crashes            hub crash reports and macOS crash reports (names and dates only)
//   POST /crashes/seen       mark the macOS reports as looked at
//   POST /crashes/clear      delete every crash report this hub wrote
import { homedir } from "node:os";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CrashList } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { clearCrashReports, crashDir, listCrashReports } from "./crash.js";
import { diagnosticsDir, listMacReports } from "./diagnostics.js";
import { privacyState, setPrivacy, type UploadDeps } from "./reporting.js";
import { UpdateChecker, currentTelemetry } from "./schedule.js";

const KV_MAC_SEEN = "crashes.mac.seen";

export interface DistributionDeps extends UploadDeps {
  dataDir: string;
  updates?: UpdateChecker;
  /** Where macOS keeps its crash reports. Tests point it at a temp folder. */
  macReportsDir?: string;
  version?: string;
  macos?: string;
}

export function registerDistributionRoutes(app: FastifyInstance, store: Store, d: DistributionDeps) {
  const updates = d.updates ?? new UpdateChecker(store, { env: d.env, version: d.version, macos: d.macos });
  const macDir = d.macReportsDir ?? diagnosticsDir();

  app.get("/version", async () => updates.info());
  app.post("/version/check", async () => updates.check(true));

  app.get("/privacy", async () => privacyState(store, d.env));
  app.put("/privacy", async (req, reply) => {
    const b = z.object({ crashReports: z.boolean().optional(), telemetry: z.boolean().optional(), updateChecks: z.boolean().optional() }).strict().safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "crashReports, telemetry and updateChecks are true or false." });
    setPrivacy(store, b.data);
    return privacyState(store, d.env);
  });

  app.get("/telemetry/preview", async () => ({
    payload: currentTelemetry(store, { dataDir: d.dataDir, version: d.version, macos: d.macos }),
    ...(({ endpointConfigured, endpointHost, telemetry, telemetryLastSentAt, telemetryNextAt }) => ({ endpointConfigured, endpointHost, on: telemetry, lastSentAt: telemetryLastSentAt, nextAt: telemetryNextAt }))(privacyState(store, d.env)),
  }));

  app.get("/crashes", async (): Promise<CrashList> => ({
    hub: listCrashReports(d.dataDir).slice(0, 30),
    mac: listMacReports(macDir, store.getKV<number>(KV_MAC_SEEN, 0)),
    dir: crashDir(d.dataDir).replace(homedir(), "~"),
    macDir: macDir.replace(homedir(), "~"),
  }));
  app.post("/crashes/seen", async () => { store.setKV(KV_MAC_SEEN, Date.now()); return { ok: true }; });
  app.post("/crashes/clear", async () => {
    const n = clearCrashReports(d.dataDir);
    store.audit("owner", "crashes.clear", `${n} report${n === 1 ? "" : "s"}`);
    return { ok: true, deleted: n };
  });
}
