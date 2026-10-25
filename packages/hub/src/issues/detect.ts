import type { Approval, FailureTag, Issue, IssueKind, RoutingRecord } from "@agent-room/shared";
import type { ReplyTurn } from "../turns/turns.js";
import { slotFor, slotOf, type Slot } from "../trace/attribute.js";
import { nextStep } from "./steps.js";

/**
 * Issues: recurring problems from the last 7 days, grouped and named. Everything comes from what the hub already records
 * (routing log, reply turns, approvals); nothing here writes. The rules:
 *  - the same failure tag from the same agent, seen at least twice (placement problems are their own issue: "blocked by its environment")
 *  - the same failure tag on the same kind of task, from at least two agents, seen at least twice
 *  - "couldn't reply" errors from one agent, at least twice
 *  - repeat posts that reply turns kept out of the room, at least twice
 *  - judges whose review could not be read, at least twice
 *  - approvals left waiting more than an hour (one is enough: it is a person who has not answered)
 */
export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 7;
export const LONG_WAIT_MS = 60 * 60_000;
export const MIN_SEEN = 2;
const LIST_CAP = 10;

export interface IssueInput {
  now: number;
  days?: number;
  /** Routing records from at least the window's start (older ones are ignored). */
  routing: RoutingRecord[];
  /** Reply turns from every room. */
  turns: ReplyTurn[];
  approvals: Approval[];
  /** Only this room's problems. */
  roomId?: string;
  agentName: (id: string) => string;
  goalInfo: (goalId: string) => { text: string; roomId: string } | undefined;
  taskInfo: (taskId: string) => { title: string; goalId: string } | undefined;
  /** Issue id -> when the owner dismissed it. */
  dismissed: Record<string, number>;
}

interface Evidence { at: number; weight: number; agentId?: string; taskType?: string; goalId?: string; taskId?: string; roomId?: string }
interface Group { id: string; kind: IssueKind; tag?: FailureTag; agentId?: string; taskType?: string; min: number; evidence: Evidence[] }

const JUDGE_UNREADABLE = /the check couldn't be read/i;
const times = (n: number) => `${n} time${n === 1 ? "" : "s"} this week`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const BY_AGENT: Record<FailureTag, string> = {
  spec: "hit unclear instructions", misalignment: "drifted off its task", verification: "said done before it was", placement: "blocked by its environment", other: "failed to finish a task",
};
const BY_TYPE: Record<FailureTag, string> = {
  spec: "were unclear to the agents", misalignment: "drifted off task", verification: "were reported done too early", placement: "were blocked by where the agent runs", other: "failed to finish",
};

function title(g: Group, count: number, name: (id: string) => string): string {
  const who = g.agentId ? name(g.agentId) : "";
  switch (g.kind) {
    case "failure": return g.agentId ? `${who} ${BY_AGENT[g.tag ?? "other"]}, ${times(count)}` : `${cap(g.taskType ?? "other")} tasks ${BY_TYPE[g.tag ?? "other"]}, ${times(count)}`;
    case "placement": return `${who} blocked by its environment, ${times(count)}`;
    case "reply": return `${who} couldn't reply, ${times(count)}`;
    case "repeat_post": return `Repeat posts from ${who} were kept out, ${times(count)}`;
    case "judge": return `${who}'s reviews could not be read, ${times(count)}`;
    case "approval_wait": return count === 1 ? "An approval waited over an hour for you" : `${count} approvals waited over an hour for you this week`;
  }
}

export function detectIssues(inp: IssueInput): { issues: Issue[]; dismissed: number } {
  const days = inp.days ?? WINDOW_DAYS;
  const since = inp.now - days * DAY_MS;
  const inRoom = (roomId?: string) => !inp.roomId || roomId === inp.roomId;
  const groups = new Map<string, Group>();
  const add = (id: string, make: Omit<Group, "id" | "evidence">, e: Evidence) => {
    let g = groups.get(id);
    if (!g) { g = { id, ...make, evidence: [] }; groups.set(id, g); }
    g.evidence.push(e);
  };

  // What was running when: lets a reply turn or an approval point at a goal and a task.
  const records = inp.routing.filter((r) => r.kind !== "shadow" && !r.shadow);
  const slots: (Slot & { goalId: string; taskId: string })[] = records.filter((r) => r.kind === "task" || r.kind === "subagent")
    .map((r) => ({ ...slotOf(r, inp.now), goalId: r.goalId, taskId: r.taskId }));
  const where = (agentId: string, roomId: string | undefined, at: number) => {
    const s = slotFor(slots, { agentId, roomId, at }) as (Slot & { goalId: string; taskId: string }) | undefined;
    return s ? { goalId: s.goalId, taskId: s.taskId } : {};
  };

  // ---- the routing log: failures, placement blocks, direct answers that failed, judges that couldn't be read
  for (const r of records) {
    const at = r.completedAt ?? r.at;
    if (at < since || !inRoom(r.roomId)) continue;
    const base: Evidence = { at, weight: 1, agentId: r.chosen, taskType: r.taskType, goalId: r.goalId, taskId: r.taskId, roomId: r.roomId };
    if (r.kind === "direct") {
      if (r.outcome === "run_failed") add(`reply:agent:${r.chosen}`, { kind: "reply", agentId: r.chosen, min: MIN_SEEN }, base);
      continue;
    }
    if (r.kind !== "task" || !r.failureTag) continue;
    if (JUDGE_UNREADABLE.test(r.failureNote ?? "")) {
      const judge = r.judgment?.judgeAgentId.split(",")[0]?.trim();
      if (judge && judge !== "checks" && judge !== "owner") add(`judge:agent:${judge}`, { kind: "judge", agentId: judge, min: MIN_SEEN }, base);
      continue;
    }
    if (r.failureTag === "placement") { add(`placement:agent:${r.chosen}`, { kind: "placement", tag: "placement", agentId: r.chosen, min: MIN_SEEN }, base); continue; }
    add(`failure:${r.failureTag}:agent:${r.chosen}`, { kind: "failure", tag: r.failureTag, agentId: r.chosen, min: MIN_SEEN }, base);
    add(`failure:${r.failureTag}:type:${r.taskType}`, { kind: "failure", tag: r.failureTag, taskType: r.taskType, min: MIN_SEEN }, base);
  }
  // A kind of task is an issue only when more than one agent hit it; one agent hitting it all the time is that agent's issue.
  for (const [id, g] of groups) if (g.kind === "failure" && g.taskType && new Set(g.evidence.map((e) => e.agentId)).size < 2) groups.delete(id);

  // ---- reply turns: couldn't reply, repeat posts kept out
  for (const t of inp.turns) {
    if (t.startedAt < since || !inRoom(t.roomId)) continue;
    const link = where(t.agentId, t.roomId, t.startedAt);
    const base: Evidence = { at: t.startedAt, weight: 1, agentId: t.agentId, roomId: t.roomId, ...link };
    if (t.status === "failed") add(`reply:agent:${t.agentId}`, { kind: "reply", agentId: t.agentId, min: MIN_SEEN }, base);
    if (t.dropped > 0) add(`repeat_post:agent:${t.agentId}`, { kind: "repeat_post", agentId: t.agentId, min: MIN_SEEN }, { ...base, weight: t.dropped });
  }

  // ---- approvals left waiting
  for (const a of inp.approvals) {
    if (a.auto || !inRoom(a.roomId)) continue;
    const waited = (a.decidedAt ?? inp.now) - a.createdAt;
    const open = a.status === "pending";
    if (waited < LONG_WAIT_MS || (!open && a.createdAt < since)) continue; // a card still waiting counts however old it is
    add("approval_wait", { kind: "approval_wait", min: 1 }, { at: a.createdAt, weight: 1, agentId: a.agentId, roomId: a.roomId, ...where(a.agentId, a.roomId, a.createdAt) });
  }

  // ---- name them
  const out: Issue[] = []; let hidden = 0;
  for (const g of groups.values()) {
    const ev = g.evidence.sort((x, y) => x.at - y.at);
    const count = ev.reduce((n, e) => n + e.weight, 0);
    if (count < g.min) continue;
    const goalIds = [...new Set(ev.map((e) => e.goalId).filter((x): x is string => !!x))];
    const taskIds = [...new Set(ev.map((e) => e.taskId).filter((x): x is string => !!x))];
    const goals = goalIds.map((id) => { const x = inp.goalInfo(id); return x ? { id, text: x.text.slice(0, 160), roomId: x.roomId } : undefined; }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, LIST_CAP);
    const tasks = taskIds.map((id) => { const x = inp.taskInfo(id); return x ? { id, title: x.title.slice(0, 120), goalId: x.goalId } : undefined; }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, LIST_CAP);
    const rooms = [...new Set([...ev.map((e) => e.roomId), ...goals.map((x) => x.roomId)].filter((x): x is string => !!x))];
    const lastSeen = ev[ev.length - 1].at;
    const d = inp.dismissed[g.id];
    if (d !== undefined && lastSeen <= d) { hidden++; continue; }
    out.push({
      id: g.id, kind: g.kind, title: title(g, count, inp.agentName), count, firstSeen: ev[0].at, lastSeen,
      ...(g.tag ? { tag: g.tag } : {}), ...(g.agentId ? { agentId: g.agentId } : {}), ...(g.taskType ? { taskType: g.taskType } : {}),
      goals, tasks, rooms, next: nextStep(g.kind, g.tag),
      ...(d !== undefined ? { reappeared: true } : {}),
    });
  }
  out.sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.id.localeCompare(b.id));
  return { issues: out, dismissed: hidden };
}
