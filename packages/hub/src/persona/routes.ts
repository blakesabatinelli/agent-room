import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.js";
import type { ControlFolder } from "../control/folder.js";
import { readPersona, writePersona } from "./persona.js";
import { PERSONA_TEMPLATES } from "./templates/index.js";

/** 3.2 HTTP. Registered once from api/server.ts; `control` is read per request because the control folder may be attached after the server starts. */
export function registerPersonaRoutes(app: FastifyInstance, store: Store, control: () => ControlFolder | undefined) {
  /** The starter personas. */
  app.get("/personas/templates", async () => PERSONA_TEMPLATES);

  /** The persona: front matter fields, the body, where it lives and which starter it still matches. */
  app.get("/agents/:id/persona", async (req, reply) => {
    const p = readPersona(store, control(), (req.params as { id: string }).id);
    return p ?? reply.code(404).send({ error: "Agent not found." });
  });

  // Fields are checked for type here and for content by the SOUL.md linter, so the owner sees the linter's message.
  const body = z.object({
    name: z.string().max(200), color: z.string().max(40), avatar: z.string().max(40), role: z.string().max(1000), tone: z.string().max(1000),
    body: z.string().max(20_000), template: z.string().max(60),
  }).partial().strict();

  /** Save the persona. Without a control folder it is kept in the agent's record. Invalid: 400 with the linter's message and line. */
  app.put("/agents/:id/persona", async (req, reply) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: `${parsed.error.issues[0].path.join(".") || "persona"}: ${parsed.error.issues[0].message}` });
    const r = await writePersona(store, control(), (req.params as { id: string }).id, parsed.data);
    if (r.ok) return r.persona;
    return reply.code(r.error === "Agent not found." ? 404 : 400).send({ error: r.error, ...(r.line ? { line: r.line } : {}) });
  });
}
