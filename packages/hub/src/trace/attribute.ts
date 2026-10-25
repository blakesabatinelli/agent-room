import type { RoutingRecord } from "@agent-room/shared";

/**
 * Which attempt something belongs to. The hub records approvals and reply turns by agent, room and time, not by task, so an
 * event belongs to the attempt of the same agent in the same room that was running when it happened. If two overlap, the one
 * that started last is the more specific (a helper started inside its parent's attempt).
 */
export interface Slot { id: string; agentId: string; roomId: string; from: number; to: number }

/** A little slack for clock rounding at the edges of an attempt. */
export const GRACE_MS = 250;

export function slotOf(r: Pick<RoutingRecord, "id" | "chosen" | "roomId" | "at" | "completedAt">, now: number): Slot {
  return { id: r.id, agentId: r.chosen, roomId: r.roomId, from: r.at, to: r.completedAt ?? now };
}

export function slotFor(slots: Slot[], probe: { agentId: string; roomId?: string; at: number }): Slot | undefined {
  let best: Slot | undefined;
  for (const s of slots) {
    if (s.agentId !== probe.agentId) continue;
    if (probe.roomId && s.roomId !== probe.roomId) continue;
    if (probe.at < s.from || probe.at > s.to + GRACE_MS) continue;
    if (!best || s.from > best.from) best = s;
  }
  return best;
}
