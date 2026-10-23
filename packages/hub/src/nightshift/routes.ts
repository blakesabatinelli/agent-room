import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.js";
import { headToHead } from "./headToHead.js";
import { listTournaments } from "./records.js";
import type { NightShift } from "./service.js";

/**
 * 4.5 HTTP: what the night shift did. Read-only; the switch and its limits are the `nightShift` settings (PUT /settings).
 * Registered once from api/server.ts, behind the same paired-device check as every other route. No MCP tool reads this.
 */
export function registerNightShiftRoutes(app: FastifyInstance, store: Store, night: NightShift) {
  /** The window and settings, the last nights, the latest re-runs with both results, and the head-to-head table. */
  app.get("/nightshift", async () => night.state());
  /** Every re-run, newest first (`night=YYYY-MM-DD` for one night, `task=` for one task) and the head-to-head table for a task type. */
  app.get("/nightshift/runs", async (req, reply) => {
    const q = z.object({ night: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), task: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "Use night=YYYY-MM-DD, task=<task id> and/or limit." });
    return listTournaments(store, { night: q.data.night, taskId: q.data.task, limit: 10_000 }).reverse().slice(0, q.data.limit);
  });
  app.get("/nightshift/head-to-head", async (req, reply) => {
    const q = z.object({ taskType: z.string().max(60).optional() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "Use taskType=<type>." });
    return headToHead(store, { taskType: q.data.taskType });
  });
}
