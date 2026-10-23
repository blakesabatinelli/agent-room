import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.js";
import { calibrationOf, listJuries } from "./records.js";

/** 2.2 HTTP: the jury records and how far the judges are from the owner's spot ratings. Registered once from api/server.ts. */
export function registerJuryRoutes(app: FastifyInstance, store: Store) {
  const q = z.object({
    taskId: z.string().optional(), goalId: z.string().optional(), since: z.coerce.number().optional(),
    limit: z.coerce.number().int().min(1).max(100_000).optional(),
  });
  app.get("/juries", async (req) => listJuries(store, q.parse(req.query ?? {})));
  /** Kill-criterion data: jury vs single-judge vs same-family distance from the owner, by family. */
  app.get("/jury/stats", async () => {
    const all = listJuries(store);
    return {
      calibration: calibrationOf(store),
      juries: all.length,
      byKind: { jury: all.filter((j) => j.kind === "jury").length, second: all.filter((j) => j.kind === "second").length, fallback: all.filter((j) => j.kind === "fallback").length },
      splits: all.filter((j) => j.split).length,
      fallbackReasons: all.filter((j) => j.kind === "fallback").reduce<Record<string, number>>((m, j) => { const k = j.reason ?? "unknown"; m[k] = (m[k] ?? 0) + 1; return m; }, {}),
    };
  });
}
