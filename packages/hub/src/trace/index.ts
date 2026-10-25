import type { FastifyInstance } from "fastify";
import type { GoalTrace } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { ReplyTurns } from "../turns/turns.js";
import { retroDb } from "../retro/index.js";
import { buildTrace } from "./build.js";

export { buildTrace, EVENT_CAP, type TraceInput } from "./build.js";
export { slotFor, slotOf, GRACE_MS, type Slot } from "./attribute.js";

/** Things that act in the hub but are not agents. Shown by name. */
const ACTORS: Record<string, string> = { owner: "You", checks: "Checks", orchestrator: "Orchestrator", system: "Agent Room", hub: "Agent Room", jury: "Jury" };

export const agentNamer = (store: Store) => (id: string) => ACTORS[id] ?? store.getAgent(id)?.name ?? id;

/** Read everything the trace needs from the store and build it, or undefined when the goal doesn't exist. */
export function loadTrace(store: Store, turns: ReplyTurns, goalId: string, now = Date.now()): GoalTrace | undefined {
  const goal = store.getGoal(goalId);
  if (!goal) return undefined;
  return buildTrace({
    goal, now,
    tasks: store.listTasks({ goalId, subagents: true }),
    routing: store.listRouting({ goalId }),
    messages: store.listMessages(goal.roomId, 2000, goal.createdAt - 1000),
    approvals: store.listApprovals(),
    turns: turns.list(goal.roomId, 500),
    lessons: retroDb(store).list({ goalId }).map((l) => ({ id: l.id, agentId: l.agentId, taskType: l.taskType, text: l.text, at: l.at })),
    agentName: agentNamer(store),
  });
}

/** GET /goals/:id/trace. Needs a paired device like every other route; it only reads. */
export function registerTraceRoutes(app: FastifyInstance, store: Store, turns: () => ReplyTurns) {
  app.get("/goals/:id/trace", async (req, reply) => {
    const t = loadTrace(store, turns(), (req.params as { id: string }).id);
    return t ?? reply.code(404).send({ error: "Goal not found." });
  });
}
