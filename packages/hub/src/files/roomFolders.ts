import type { Room } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { GoalSources } from "./goalSource.js";

/**
 * Room folders: a room can name one folder grant as its default. A goal started in the room with no folder chosen works on it.
 * The apps send folderGrantId "" for "No folder for this message", which beats the default.
 */
export class RoomFolders {
  constructor(private store: Store, private sources: GoalSources) {}

  /** Set (grantId) or clear (null) a room's default folder. A grant this room's goals can't use is refused with a plain reason. */
  set(roomId: string, grantId: string | null, actor = "owner"): { ok: true; room: Room } | { ok: false; status: number; reason: string } {
    const room = this.store.getRoom(roomId);
    if (!room) return { ok: false, status: 404, reason: "Room not found." };
    if (room.dmAgentId) return { ok: false, status: 400, reason: "A direct message can't have a folder. Use a room." };
    if (grantId) {
      const u = this.sources.usable(grantId, roomId);
      if (!u.ok) return { ok: false, status: 400, reason: u.reason };
    }
    const { folderGrantId: _old, ...rest } = room;
    const next: Room = grantId ? { ...rest, folderGrantId: grantId } : rest;
    this.store.saveRoom(next);
    this.store.audit(actor, grantId ? "room.folder.set" : "room.folder.cleared", `${room.name} ${grantId ?? _old ?? ""}`.trim());
    return { ok: true, room: next };
  }

  /**
   * Which folder a new goal in this room starts on. explicit undefined = the client said nothing (use the default), "" = no folder,
   * an id = that grant (the caller has already checked it). A default that has stopped working is skipped, with a notice for the room.
   */
  resolve(roomId: string, explicit: string | undefined): { grantId?: string; notice?: string } {
    if (explicit !== undefined) return explicit ? { grantId: explicit } : {};
    const room = this.store.getRoom(roomId);
    const def = room?.folderGrantId;
    if (!def) return {};
    const u = this.sources.usable(def, roomId);
    if (u.ok) return { grantId: def };
    this.store.audit("system", "room.folder.skipped", `${room?.name} ${def} ${u.reason}`);
    return { notice: `Starting without the room's folder: ${u.reason}` };
  }
}

/** A removed grant is no longer anyone's default. */
export function clearRoomDefaults(store: Store, grantId: string) {
  for (const r of store.listRooms()) {
    if (r.folderGrantId !== grantId) continue;
    const { folderGrantId: _gone, ...rest } = r;
    store.saveRoom(rest);
    store.audit("system", "room.folder.cleared", `${r.name} ${grantId} (folder removed)`);
  }
}
