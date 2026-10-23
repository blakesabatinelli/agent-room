import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { attentionFor } from "../attention/index.js";
import type { Store } from "../db/store.js";
import { isoWeek } from "../retro/metrics.js";
import { buildKillReview } from "./kill.js";
import { buildLedger } from "./ledger.js";
import { monthOf } from "./periods.js";
import { buildScorecard } from "./scorecard.js";

/**
 * 2.7 HTTP: the weekly scorecard, the monthly return ledger, the kill-criteria review, and what the attention gate is holding.
 * Registered once from api/server.ts. Each report is JSON with its Markdown rendering in `markdown`; add `format=md` for the Markdown alone.
 */
export function registerReportRoutes(app: FastifyInstance, store: Store) {
  const fmt = z.enum(["json", "md"]).default("json");
  const send = (reply: FastifyReply, format: "json" | "md", r: { markdown: string }) =>
    format === "md" ? reply.header("content-type", "text/markdown; charset=utf-8").send(r.markdown) : r;
  const bad = (reply: FastifyReply, e: unknown) => reply.code(400).send({ error: (e as Error).message });

  app.get("/reports/scorecard", async (req, reply) => {
    const q = z.object({ week: z.string().regex(/^\d{4}-W\d{2}$/, "Week must look like 2026-W43.").default(() => isoWeek(Date.now())), format: fmt }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0].message });
    try { return send(reply, q.data.format, buildScorecard(store, q.data.week)); } catch (e) { return bad(reply, e); }
  });
  app.get("/reports/ledger", async (req, reply) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, "Month must look like 2026-10.").default(() => monthOf(Date.now())), format: fmt }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0].message });
    try { return send(reply, q.data.format, buildLedger(store, q.data.month)); } catch (e) { return bad(reply, e); }
  });
  app.get("/reports/kill-review", async (req, reply) => {
    const q = z.object({ force: z.enum(["1"]).optional(), format: fmt }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "Use force=1 and/or format=md." });
    return send(reply, q.data.format, buildKillReview(store, { force: q.data.force === "1" }));
  });
  /** Today's interruption count against the cap, what is waiting for the digest, and the settings that govern both. */
  app.get("/attention", async () => attentionFor(store).state());
}
