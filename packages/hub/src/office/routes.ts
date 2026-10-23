import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.js";
import { OfficeTracker } from "./state.js";

/**
 * 3.4 HTTP: GET /office?roomId= is the whole office (agents, helpers, whiteboard, approvals) for one room, or for every room when roomId is left out.
 * The page (web/office.html) calls it again whenever a task, goal, approval, working or subagent event arrives.
 * Needs a paired device like every other route; the page and its scripts are served by the web app's fixed file list.
 */
export function registerOfficeRoutes(app: FastifyInstance, store: Store) {
  const tracker = new OfficeTracker(store);
  app.addHook("onClose", async () => { tracker.dispose(); });
  app.get("/office", async (req, reply) => {
    const q = z.object({ roomId: z.string().min(1).max(100).optional() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "roomId must be a room id." });
    if (q.data.roomId && !store.getRoom(q.data.roomId)) return reply.code(404).send({ error: "Room not found." });
    return tracker.state(q.data.roomId);
  });
  return tracker;
}
