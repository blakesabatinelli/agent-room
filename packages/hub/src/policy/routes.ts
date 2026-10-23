import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { runProc } from "../adapters/proc.js";
import type { Store } from "../db/store.js";
import type { Approvals } from "../orchestrator/approvals.js";
import type { PolicyEngine } from "./engine.js";

/** 4.2 HTTP. Registered once from api/server.ts. */
export interface PolicyRoutesHost {
  policy: () => PolicyEngine;
  store: Store;
  approvals: Approvals;
}

const bad = (reply: FastifyReply, e: { status: number; error: string }) => reply.code(e.status).send({ error: e.error });
const first = (e: z.ZodError) => `${e.issues[0].path.join(".") || "request"}: ${e.issues[0].message}`;

export function registerPolicyRoutes(app: FastifyInstance, host: PolicyRoutesHost) {
  /** POLICY.md as the apps show it: every rule in plain words (grouped by `kind`), the active leases, and how many learned rules wait. */
  app.get("/policy", async () => host.policy().state());

  /** Look at the approval history now. Proposes at most one batch a day, so asking twice is harmless. */
  app.post("/policy/learn", async () => host.policy().learn());

  /** "Edit POLICY.md": open the file in the owner's editor (the hub runs on their Mac). Always answers with the path. */
  app.post("/policy/open", async (_req, reply) => {
    const path = host.policy().filePath();
    if (!path) return reply.code(404).send({ error: "The control folder isn't available on this hub." });
    const r = await runProc("/usr/bin/open", [path], { timeoutMs: 5000 }).catch(() => undefined);
    return { ok: !!r && r.code === 0, path };
  });

  app.post("/policy/rules/:id/accept", async (req, reply) => {
    const r = await host.policy().accept((req.params as { id: string }).id);
    return r.ok ? { ok: true } : bad(reply, r);
  });

  const patch = z.object({
    effect: z.enum(["allow", "ask", "deny"]).optional(),
    match: z.string().min(1).max(300).optional(),
    scope: z.string().min(1).max(200).optional(),
    expires: z.string().max(40).nullable().optional(),
    accepted: z.boolean().optional(),
  }).strict();
  /** Edit a rule's effect, match, scope or end date, or accept it. The hub writes POLICY.md and commits it as the owner. */
  app.patch("/policy/rules/:id", async (req, reply) => {
    const p = patch.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: first(p.error) });
    const r = await host.policy().edit((req.params as { id: string }).id, p.data);
    return r.ok ? { ok: true } : bad(reply, r);
  });

  /** Delete a rule. A learned one isn't proposed again for 30 days; a lease is revoked. */
  app.delete("/policy/rules/:id", async (req, reply) => {
    const r = await host.policy().remove((req.params as { id: string }).id);
    return r.ok ? { ok: true } : bad(reply, r);
  });

  // ---- leases
  app.get("/leases", async () => host.policy().leases());

  const lease = z.object({
    agentId: z.string().min(1).max(60),
    tool: z.string().min(1).max(40),
    minutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
    goalId: z.string().min(1).max(80).optional(),
    roomId: z.string().min(1).max(80).optional(),
    action: z.string().min(1).max(60).optional(),
  }).strict();
  /** Grant a lease: a temporary allow that ends at a time, or when a goal ends, whichever is first. */
  app.post("/leases", async (req, reply) => {
    const p = lease.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: first(p.error) });
    const r = await host.policy().grant(p.data);
    return r.ok ? reply.code(201).send({ lease: r.lease, notes: r.notes }) : bad(reply, r);
  });

  app.delete("/leases/:id", async (req, reply) => {
    const r = await host.policy().revoke((req.params as { id: string }).id);
    return r.ok ? { ok: true } : bad(reply, r);
  });

  const card = z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60).optional(), forGoal: z.boolean().optional() }).strict();
  /** An approval card's "Allow for 30 minutes" / "Allow for this goal": approves this request and grants the lease for what it asked. */
  app.post("/approvals/:id/lease", async (req, reply) => {
    const p = card.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: first(p.error) });
    if (!p.data.forGoal && p.data.minutes === undefined) return reply.code(400).send({ error: "Say how many minutes, or forGoal." });
    const a = host.store.getApproval((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: "Approval not found." });
    const r = await host.policy().leaseFromApproval(a, p.data, (id) => host.approvals.decide(id, "approved", "owner"));
    return r.ok ? reply.code(201).send({ lease: r.lease, notes: r.notes, approval: host.store.getApproval(a.id) }) : bad(reply, r);
  });
}
