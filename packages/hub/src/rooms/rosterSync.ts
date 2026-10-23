import type { ServerEvent } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { ControlFolder } from "../control/folder.js";
import { editFrontMatter, seqNode } from "../control/parse.js";

/**
 * 4.3 A room's ROOM.md lists who works there. The hub writes that list for a new room from the agents it has at that moment, so an agent
 * that joins later (a new connector, Muse) would be left out of every room. This puts a new agent into each room that already had everyone,
 * as one commit by the hub, and leaves any room the owner narrowed on purpose alone.
 */
export function joinOpenRosters(store: Store, control: () => ControlFolder | undefined, log: (m: string) => void = () => undefined): () => void {
  const known = new Set(store.listAgents().map((a) => a.id));
  const onEvent = (e: ServerEvent) => {
    if (e.type !== "agent" || known.has(e.agent.id)) return;
    known.add(e.agent.id);
    const c = control(); const id = e.agent.id, name = e.agent.name;
    if (!c) return;
    const others = [...known].filter((x) => x !== id);
    const rooms = Object.entries(c.snapshot().rooms).filter(([, d]) => d.room && d.room.fm.roster.length && !d.room.fm.roster.includes(id) && others.every((o) => d.room!.fm.roster.includes(o)));
    if (!rooms.length) return;
    void c.update((read) => {
      const files: { rel: string; text: string }[] = [];
      if (read(`agents/${id}/TOOLS.md`) === undefined) return { files }; // the agent's own folder comes first: a roster can't name an agent that has none
      for (const [slug] of rooms) {
        const rel = `rooms/${slug}/ROOM.md`; const cur = read(rel);
        if (cur === undefined) continue;
        try {
          const text = editFrontMatter(cur, (doc) => {
            const now = (doc.get("roster") as { toJSON?: () => string[] } | undefined)?.toJSON?.() ?? [];
            if (!now.includes(id)) { doc.set("roster", seqNode(doc, [...now, id])); doc.set("updated", new Date().toISOString().slice(0, 10)); doc.set("updated_by", "hub"); }
          });
          if (text !== cur) files.push({ rel, text });
        } catch { /* a ROOM.md with a problem is the owner's to fix */ }
      }
      return { files };
    }, `Add ${name} to the rooms that include everyone`, "hub").catch((err) => log(`couldn't add ${id} to the room rosters: ${(err as Error).message}`));
  };
  store.on("event", onEvent);
  return () => { store.off("event", onEvent); };
}
