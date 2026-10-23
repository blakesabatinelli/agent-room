import type { Store } from "../db/store.js";
import type { ControlFolder } from "../control/folder.js";

/**
 * 4.3 A standing room is one whose ROOM.md gives it a definition of its own: a schedule or standing goal, narrowed tools,
 * its own folders, or a roster smaller than everyone. What such a room learns stays in the room: it is not copied into an
 * agent's own memory file or the context files the hub exports to the agents' tools, which every other room would then read.
 */
export function isStandingRoom(store: Store, control: ControlFolder | undefined, roomId: string): boolean {
  const slug = control?.slugFor(roomId);
  const fm = slug ? control?.snapshot().rooms[slug]?.room?.fm : undefined;
  if (!fm) return false;
  const smaller = fm.roster.length > 0 && store.listAgents().some((a) => !fm.roster.includes(a.id));
  return fm.schedule !== undefined || !!fm.standing_goal?.trim() || Object.keys(fm.tools).length > 0 || fm.folders.length > 0 || smaller;
}
