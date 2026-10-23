// 1.7 HTTP side of the installable app: in-app sign-in and the setup timer. Registered once from api/server.ts.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { openSignIn } from "../setup.js";
import type { SignInManager } from "./signin.js";
import { markFirstGoalDone, markSetupStarted } from "./timer.js";

export function registerInstallRoutes(app: FastifyInstance, d: { store: Store; orch: Orchestrator; signin: SignInManager; isLoopback: (req: FastifyRequest) => boolean }) {
  const { store, orch, signin, isLoopback } = d;

  // The timer starts at the hub's first start (the app starts the hub on first launch) and stops at the first finished goal.
  markSetupStarted(store);
  const onEvent = (e: { type: string; goal?: { status: string } }) => { if (e.type === "goal" && e.goal?.status === "done") markFirstGoalDone(store); };
  store.on("event", onEvent);
  app.addHook("onClose", async () => { store.off("event", onEvent); });

  // Sign-in links and codes are for the owner at this Mac only, so every one of these answers the Mac app and nobody else.
  const agentFor = (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    if (!isLoopback(req)) { void reply.code(403).send({ error: "Sign in from the Mac app." }); return undefined; }
    const a = store.getAgent((req.params as { agent: string }).agent);
    if (!a) { void reply.code(404).send({ error: "Agent not found." }); return undefined; }
    return a;
  };

  // Start. mode "terminal" is the fallback: open Terminal with the CLI's own flow, as before.
  app.post("/setup/signin/:agent", async (req, reply) => {
    const a = agentFor(req, reply); if (!a) return;
    const b = z.object({ mode: z.enum(["browser", "device", "terminal"]).optional(), force: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "mode is browser, device or terminal." });
    orch.forgetStatus(a.id);
    if (b.data.mode === "terminal") {
      store.audit("owner", "setup.signin.terminal", a.id);
      const r = await openSignIn(a.adapter);
      return { agent: a.id, state: r.ok ? "waiting" : "failed", terminal: true, ok: r.ok, message: r.message, updatedAt: Date.now() };
    }
    const v = await signin.start(a, { mode: b.data.mode, force: b.data.force });
    return { ...v, ok: v.state !== "failed" };
  });
  app.get("/setup/signin/:agent", async (req, reply) => {
    const a = agentFor(req, reply); if (!a) return;
    return signin.view(a.id);
  });
  // Claude Code may ask for a code pasted back. It goes to the CLI and nowhere else.
  app.post("/setup/signin/:agent/code", async (req, reply) => {
    const a = agentFor(req, reply); if (!a) return;
    const b = z.object({ code: z.string().min(1).max(2048) }).safeParse(req.body);
    if (!b.success || !signin.submitCode(a.id, b.data.code)) return reply.code(409).send({ error: "There's no sign-in waiting for a code." });
    return signin.view(a.id);
  });
  app.post("/setup/signin/:agent/cancel", async (req, reply) => {
    const a = agentFor(req, reply); if (!a) return;
    return signin.cancel(a.id);
  });
}
