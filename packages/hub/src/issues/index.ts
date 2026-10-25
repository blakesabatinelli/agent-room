import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { IssuesResponse } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { ReplyTurns } from "../turns/turns.js";
import { agentNamer } from "../trace/index.js";
import { DAY_MS, WINDOW_DAYS, detectIssues } from "./detect.js";

export { detectIssues, LONG_WAIT_MS, MIN_SEEN, WINDOW_DAYS, DAY_MS, type IssueInput } from "./detect.js";
export { NEXT_STEP, nextStep } from "./steps.js";

const KEY = "issues_dismissed";
/** Dismissals older than this are forgotten: by then every piece of evidence has left the window. */
const KEEP_MS = (WINDOW_DAYS + 7) * DAY_MS;

/** Issue id -> when the owner dismissed it. Kept in the settings table; an issue stays dismissed until it happens again after that moment. */
export const readDismissed = (store: Store): Record<string, number> => store.getKV<Record<string, number>>(KEY, {});

export function loadIssues(store: Store, turns: ReplyTurns, o: { roomId?: string; now?: number } = {}): IssuesResponse {
  const now = o.now ?? Date.now();
  const rooms = o.roomId ? [o.roomId] : store.listRooms().map((r) => r.id);
  const { issues, dismissed } = detectIssues({
    now, roomId: o.roomId,
    routing: store.listRouting({ since: now - (WINDOW_DAYS + 1) * DAY_MS }), // a day earlier than the window, so an event on its edge still finds the attempt it happened in
    turns: rooms.flatMap((id) => turns.list(id, 500)),
    approvals: store.listApprovals(),
    agentName: agentNamer(store),
    goalInfo: (id) => { const g = store.getGoal(id); return g ? { text: g.contract?.objective || g.text, roomId: g.roomId } : undefined; },
    taskInfo: (id) => { const t = store.getTask(id); return t ? { title: t.title, goalId: t.goalId } : undefined; },
    dismissed: readDismissed(store),
  });
  return { at: now, days: WINDOW_DAYS, issues, dismissed };
}

/** Dismiss one open issue. It stays gone until the same problem happens again. Returns false when no such issue is open. */
export function dismissIssue(store: Store, turns: ReplyTurns, issueId: string, o: { roomId?: string; now?: number } = {}): boolean {
  const now = o.now ?? Date.now();
  if (!loadIssues(store, turns, { roomId: undefined, now }).issues.some((i) => i.id === issueId)) return false;
  const kept = Object.fromEntries(Object.entries(readDismissed(store)).filter(([, at]) => now - at < KEEP_MS));
  store.setKV(KEY, { ...kept, [issueId]: now });
  store.audit("owner", "issue.dismissed", issueId);
  return true;
}

/** GET /issues?roomId=, POST /issues/:id/dismiss. Both need a paired device. */
export function registerIssueRoutes(app: FastifyInstance, store: Store, turns: () => ReplyTurns) {
  app.get("/issues", async (req, reply) => {
    const q = z.object({ roomId: z.string().min(1).max(100).optional() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "roomId must be a room id." });
    if (q.data.roomId && !store.getRoom(q.data.roomId)) return reply.code(404).send({ error: "Room not found." });
    return loadIssues(store, turns(), { roomId: q.data.roomId });
  });
  app.post("/issues/:id/dismiss", async (req, reply) => {
    const issueId = (req.params as { id: string }).id;
    if (!dismissIssue(store, turns(), issueId)) return reply.code(404).send({ error: "That issue isn't open anymore." });
    return { ok: true };
  });
}
