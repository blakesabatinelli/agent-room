import type { RoomDeleteCounts } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";

/**
 * DELETE /rooms/:id. Removes a room and everything scoped to it (Store.deleteRoom). Refuses while work is going unless `force`, which stops
 * the room first. Worktrees the room's goals still hold go through the orchestrator's own clean-up; nothing outside the hub's data is touched
 * (not the control folder, not a granted folder).
 */
export type RoomDeleteResult = { ok: true; counts: RoomDeleteCounts } | { ok: false; status: 400 | 404; error: string };

/** A goal that is running or planning, or a task being reviewed or revised, in the room or one of its fork lanes. */
function busy(store: Store, roomId: string): boolean {
  const lanes = store.listRooms().filter((r) => r.forkOf === roomId).map((r) => r.id);
  return [roomId, ...lanes].some((id) =>
    store.listGoals(id).some((g) => g.status === "running" || g.status === "planning")
    || store.listTasks({ roomId: id }).some((t) => t.status === "review" || t.status === "revising"));
}

const NAMES: Record<Exclude<keyof RoomDeleteCounts, "rooms">, string> = {
  goals: "goals", tasks: "tasks", messages: "messages", routing: "routing rows", approvals: "approvals", documents: "documents",
  replyTurns: "reply turns", goalSteps: "goal steps", memory: "memory", proposals: "memory proposals", forks: "forks", writeProposals: "write proposals",
};

export async function deleteRoom(store: Store, orch: Orchestrator, roomId: string, force: boolean): Promise<RoomDeleteResult> {
  const room = store.getRoom(roomId);
  if (!room) return { ok: false, status: 404, error: "Room not found." };
  if (!room.dmAgentId && store.listRooms().filter((r) => !r.dmAgentId).length <= 1) return { ok: false, status: 400, error: "Keep at least one channel." };
  if (busy(store, roomId)) {
    if (!force) return { ok: false, status: 400, error: "Work is still going in this room. Stop it first, or delete the room anyway to stop it and remove everything in it." };
    orch.stopRoom(roomId);
  }
  const lanes = store.listRooms().filter((r) => r.forkOf === roomId);
  await orch.dropRoomWorktrees(roomId);
  for (const l of lanes) await orch.dropRoomWorktrees(l.id);
  const counts = store.deleteRoom(roomId);
  const what = (Object.keys(NAMES) as (keyof typeof NAMES)[]).filter((k) => counts[k] > 0).map((k) => `${NAMES[k]} ${counts[k]}`).join(", ");
  store.audit("owner", "room.deleted", `${room.name}: removed ${what || "nothing else"}${force ? " (forced)" : ""}`);
  store.emit("event", { type: "room_deleted", roomId });
  return { ok: true, counts };
}
