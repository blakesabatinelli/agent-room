import type { RoutingRecord } from "@agent-room/shared";
import type { Store } from "../db/store.js";

/**
 * 2.3 The agent's graded runs, read from the routing log (0.2). A graded run is a planned-task attempt or a shadow run
 * (2.3) that a judge scored. Direct answers carry no judgment and are not graded. Reading from the log (and not from
 * the `scores` roll-up) keeps the evidence behind every résumé line: each number can be traced to records.
 */

/** Every task or shadow attempt `agentId` took, oldest first, graded or not. */
export function attemptsOf(store: Store, agentId: string): RoutingRecord[] {
  const rows = store.db.prepare(
    "SELECT data FROM routing WHERE json_extract(data,'$.chosen')=? AND json_extract(data,'$.kind') IN ('task','shadow') ORDER BY at ASC, rowid ASC",
  ).all(agentId) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as RoutingRecord);
}

/** The attempts a judge scored. */
export const isGraded = (r: RoutingRecord) => r.judgment !== undefined && typeof r.judgment.score === "number";

export function gradedOf(store: Store, agentId: string): RoutingRecord[] {
  return attemptsOf(store, agentId).filter(isGraded);
}
