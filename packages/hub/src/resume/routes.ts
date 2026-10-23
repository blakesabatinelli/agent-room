import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.js";
import type { Resumes } from "./service.js";

/**
 * 2.3 HTTP: an agent's résumé and its probation. Registered once from api/server.ts. The routes sit behind the same
 * paired-device check as every other route; nothing here is ever reachable by an agent (no MCP tool reads a résumé).
 */
export function registerResumeRoutes(app: FastifyInstance, store: Store, resumes: Resumes) {
  /** The résumé as the record stands now (strengths, weaknesses, table, probation progress, and the RESUME.md text). */
  app.get("/agents/:id/resume", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getAgent(id)) return reply.code(404).send({ error: "Agent not found." });
    return resumes.live(id);
  });
  /** Everyone's résumé, for the lists in both apps. */
  app.get("/resumes", async () => store.listAgents().map((a) => resumes.live(a.id)));
  /** The owner ends probation (on: false) or starts it again (on: true, counting graded runs from now). */
  app.post("/agents/:id/probation", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getAgent(id)) return reply.code(404).send({ error: "Agent not found." });
    const { on } = z.object({ on: z.boolean() }).parse(req.body ?? {});
    const status = resumes.setProbation(id, on);
    return { agentId: id, probation: status };
  });
}
