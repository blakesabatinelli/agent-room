import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Forks } from "./service.js";
import { listPreferences } from "./records.js";
import type { Store } from "../db/store.js";

/** 4.4 HTTP: start a fork, read both sides, merge one. Registered once from api/server.ts. */
export function registerForkRoutes(app: FastifyInstance, store: Store, forks: () => Forks) {
  const names = z.array(z.string().min(1).max(60)).max(12);
  app.post("/goals/fork", async (req, reply) => {
    const b = z.object({
      roomId: z.string().min(1).max(80),
      text: z.string().max(20000).optional(), goalId: z.string().max(80).optional(),
      rosterA: names.optional(), rosterB: names.optional(), folderGrantId: z.string().max(80).optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Send roomId, and a goal text or a goalId (rosterA and rosterB are optional)." });
    const r = await forks().start(b.data);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return forks().view(r.fork.id);
  });
  app.get("/forks", async (req) => {
    const q = z.object({ roomId: z.string().optional() }).parse(req.query ?? {});
    return Promise.all(forks().list(q.roomId).map((f) => forks().view(f.id)));
  });
  // Static path first, so "preferences" is never read as a fork id.
  app.get("/forks/preferences", async (req) => listPreferences(store, z.object({ agentId: z.string().optional() }).parse(req.query ?? {}).agentId));
  app.get("/forks/:id", async (req, reply) => (await forks().view((req.params as { id: string }).id)) ?? reply.code(404).send({ error: "Fork not found." }));
  app.post("/forks/:id/merge", async (req, reply) => {
    const b = z.object({ side: z.enum(["a", "b"]) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Choose side a or b." });
    const r = await forks().merge((req.params as { id: string }).id, b.data.side);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.view;
  });
  /** Approve the plans of the sides that are waiting for one. */
  app.post("/forks/:id/plan", async (req, reply) => {
    const r = forks().approvePlans((req.params as { id: string }).id);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r;
  });
  /** Ask the judges again (the comparison failed, or the owner wants a second look). */
  app.post("/forks/:id/compare", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await forks().recompare(id);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return forks().view(id);
  });
}
