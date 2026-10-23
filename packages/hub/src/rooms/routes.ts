import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runProc } from "../adapters/proc.js";
import { readDefinition, writeDefinition, type DefinitionHost } from "./definition.js";

/** 4.3 HTTP. Registered once from api/server.ts. */
export function registerRoomRoutes(app: FastifyInstance, host: () => DefinitionHost) {
  /** What ROOM.md says about the room: roster, narrowed tools, folders, schedule and its next run. Read live. */
  app.get("/rooms/:id/definition", async (req, reply) => {
    const d = readDefinition(host(), (req.params as { id: string }).id);
    return d ?? reply.code(404).send({ error: "Room not found." });
  });

  /** "Edit ROOM.md": open the file in the owner's editor (the hub runs on their Mac). Always answers with the path so the app can show it; `ok` says whether it opened. */
  app.post("/rooms/:id/definition/open", async (req, reply) => {
    const d = readDefinition(host(), (req.params as { id: string }).id);
    if (!d) return reply.code(404).send({ error: "Room not found." });
    if (!d.path || !d.hasFile) return reply.code(404).send({ error: "This room has no ROOM.md yet." });
    const r = await runProc("/usr/bin/open", [d.path], { timeoutMs: 5000 }).catch(() => undefined);
    return { ok: !!r && r.code === 0, path: d.path };
  });

  const body = z.object({
    roster: z.array(z.string().min(1).max(80)).max(40).optional(),
    schedule: z.string().max(120).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
    standingGoal: z.string().max(2000).nullable().optional(),
    catchUpHours: z.number().min(0).max(168).nullable().optional(),
  }).strict();

  /** Change the roster or the schedule. The hub edits ROOM.md and commits it as the owner; 400 with the linter's message when the result isn't valid. */
  app.put("/rooms/:id/definition", async (req, reply) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: `${parsed.error.issues[0].path.join(".") || "request"}: ${parsed.error.issues[0].message}` });
    const r = await writeDefinition(host(), (req.params as { id: string }).id, parsed.data);
    if (r.ok) return r.definition;
    return reply.code(r.error === "Room not found." ? 404 : 400).send({ error: r.error, ...(r.line ? { line: r.line } : {}) });
  });
}
