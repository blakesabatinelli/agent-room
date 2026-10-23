import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TwoKey } from "./service.js";

/** 4.1 HTTP: the two-key checks (GET /twokey, GET /twokey/:id). The owner's pick on a card goes through POST /approvals/:id { choice: "a" | "b" | "neither" }. */
export function registerTwoKeyRoutes(app: FastifyInstance, twoKey: () => TwoKey) {
  const q = z.object({ taskId: z.string().optional(), verdict: z.enum(["match", "mismatch", "no_action", "unavailable"]).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() });
  app.get("/twokey", async (req) => twoKey().list(q.parse(req.query ?? {})));
  app.get("/twokey/:id", async (req, reply) => twoKey().get((req.params as { id: string }).id) ?? reply.code(404).send({ error: "No such two-key check." }));
}
