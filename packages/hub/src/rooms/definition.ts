import { join } from "node:path";
import { TOOLS, type RoomDefinition, type RoomDefinitionInput, type RoomToolView } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { ControlFolder } from "../control/folder.js";
import type { FileBroker } from "../files/broker.js";
import { checkFile } from "../control/lint.js";
import { editFrontMatter, seqNode } from "../control/parse.js";
import { roomSlug } from "../control/storemap.js";
import { parseCron } from "./cron.js";
import { DEFAULT_CATCH_UP_HOURS, type StandingRooms } from "./schedule.js";
import { validZone } from "./zone.js";

/**
 * 4.3 What ROOM.md says about a room, for the apps (GET /rooms/:id/definition), and the one way the apps change it
 * (PUT /rooms/:id/definition): the hub edits the front matter in place, keeps the owner's comments and body, checks the result with the
 * same linter an editor edit gets, and commits it as the owner. There is no second copy: the file is the room.
 */

export interface DefinitionHost {
  store: Store;
  control: () => ControlFolder | undefined;
  files: Pick<FileBroker, "grant">;
  standing: StandingRooms;
}

const roomRel = (slug: string) => `rooms/${slug}/ROOM.md`;
const toolLabel = (id: string) => TOOLS.find((t) => t.id === id)?.label ?? id;

export function readDefinition(d: DefinitionHost, roomId: string): RoomDefinition | undefined {
  const room = d.store.getRoom(roomId);
  if (!room) return undefined;
  const c = d.control();
  const slug = !room.dmAgentId && c ? c.slugFor(roomId) ?? roomSlug(room) : roomSlug(room);
  const doc = c && !room.dmAgentId ? c.snapshot().rooms[slug]?.room : undefined;
  const fm = doc?.fm;
  const base: RoomDefinition = {
    roomId, slug, name: room.name, ...(room.topic ? { topic: room.topic } : {}), hasFile: !!doc,
    ...(c && !room.dmAgentId ? { path: join(c.root, roomRel(slug)), memoryPath: join(c.root, "rooms", slug, "MEMORY.md") } : {}),
    open: true, roster: [], tools: [], folders: [], inScope: fm?.in_scope ?? [], outOfScope: fm?.out_of_scope ?? [], notices: [],
  };
  if (!fm) return base;

  const agents = d.store.listAgents();
  base.open = !fm.roster.length || agents.every((a) => fm.roster.includes(a.id)); // a roster that names everyone is the same as none
  base.roster = fm.roster.map((id) => agents.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => ({ id: a.id, name: a.name, color: a.color, ...(a.avatar ? { avatar: a.avatar } : {}), enabled: a.enabled }));
  base.tools = Object.entries(fm.tools).filter(([, l]) => l !== "on").map(([tool, level]): RoomToolView => ({ tool, label: toolLabel(tool), level }));
  base.folders = fm.folders.map((id) => {
    const g = d.files.grant(id);
    return g ? { id, ...(g.label ? { label: g.label } : {}), path: g.path } : { id, missing: true };
  });
  base.notices = (c?.status().notices ?? []).filter((n) => n.file === roomRel(slug));

  if (fm.schedule !== undefined) {
    const s = d.standing.scheduleOf(roomId);
    const st = d.standing.state(roomId);
    const parsed = parseCron(fm.schedule);
    base.schedule = {
      cron: fm.schedule.trim(),
      timezone: s.ok ? s.schedule.zone : [fm.timezone, c?.timezone()].find(validZone) ?? "UTC",
      ...(fm.standing_goal?.trim() ? { standingGoal: fm.standing_goal.trim() } : {}),
      catchUpHours: s.ok ? s.schedule.catchUpHours : fm.catch_up_hours ?? DEFAULT_CATCH_UP_HOURS,
      active: s.ok,
      ...(!s.ok ? { problem: s.problem ?? (parsed.ok ? undefined : `The schedule isn't valid: ${parsed.error}.`) } : {}),
      ...(s.ok ? { nextRun: d.standing.nextRun(roomId) } : {}),
      ...(st?.lastRunAt ? { lastRun: st.lastRunAt } : {}),
      ...(st?.lastGoalId ? { lastGoalId: st.lastGoalId, running: d.standing.running(roomId) } : {}),
      ...(st?.note ? { lastNote: st.note } : {}),
    };
  }
  return base;
}

export type WriteDefinition = { ok: true; definition: RoomDefinition; changed: boolean } | { ok: false; error: string; line?: number };

/** Write the changes into ROOM.md (one commit by the owner) and return the room as it now reads. */
export async function writeDefinition(d: DefinitionHost, roomId: string, input: RoomDefinitionInput): Promise<WriteDefinition> {
  const room = d.store.getRoom(roomId);
  const c = d.control();
  if (!room) return { ok: false, error: "Room not found." };
  if (room.dmAgentId) return { ok: false, error: "A direct-message room has no ROOM.md." };
  if (!c) return { ok: false, error: "The control folder isn't available on this hub, so there is no ROOM.md to change." };
  const slug = c.slugFor(roomId) ?? roomSlug(room);
  const rel = roomRel(slug);

  // Everything the owner typed is checked before the file is touched.
  if (input.roster) {
    const known = new Set(d.store.listAgents().map((a) => a.id));
    const bad = input.roster.find((id) => !known.has(id));
    if (bad) return { ok: false, error: `There is no agent called "${bad}".` };
  }
  if (typeof input.schedule === "string") {
    const p = parseCron(input.schedule);
    if (!p.ok) return { ok: false, error: `The schedule isn't valid: ${p.error}.` };
  }
  if (typeof input.timezone === "string" && !validZone(input.timezone)) return { ok: false, error: `"${input.timezone}" isn't a time zone. Use a name like America/Chicago.` };

  // What changes, in words, for the commit message (read from what is loaded now).
  const was = c.snapshot().rooms[slug]?.room?.fm;
  const parts: string[] = [];
  if (input.roster && JSON.stringify(input.roster) !== JSON.stringify(was?.roster ?? [])) parts.push("roster");
  if (input.schedule !== undefined && (input.schedule?.trim().replace(/\s+/g, " ") ?? null) !== (was?.schedule ?? null)) parts.push(input.schedule === null ? "schedule cleared" : "schedule");
  if (input.timezone !== undefined && (input.timezone ?? null) !== (was?.timezone ?? null)) parts.push("time zone");
  if (input.standingGoal !== undefined && (input.standingGoal?.trim() ?? null) !== (was?.standing_goal ?? null)) parts.push("standing goal");
  if (input.catchUpHours !== undefined && (input.catchUpHours ?? null) !== (was?.catch_up_hours ?? null)) parts.push("catch-up window");

  let problem: { error: string; line?: number } | undefined;
  const wrote = await c.update((read) => {
    const cur = read(rel);
    if (cur === undefined) { problem = { error: `${rel} doesn't exist yet. Open the room once, then try again.` }; return { files: [] }; }
    let next: string;
    try {
      next = editFrontMatter(cur, (doc) => {
        let changed = false;
        const set = (key: string, v: unknown) => {
          if (v === null) { if (doc.has(key)) { doc.delete(key); changed = true; } return; }
          if (doc.get(key) !== v) { doc.set(key, v); changed = true; }
        };
        if (input.roster) {
          const now = (doc.get("roster") as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? [];
          if (JSON.stringify(now) !== JSON.stringify(input.roster)) { doc.set("roster", seqNode(doc, input.roster)); changed = true; }
        }
        if (input.schedule !== undefined) set("schedule", input.schedule === null ? null : input.schedule.trim().replace(/\s+/g, " "));
        if (input.timezone !== undefined) set("timezone", input.timezone);
        if (input.standingGoal !== undefined) set("standing_goal", input.standingGoal === null ? null : input.standingGoal.trim());
        if (input.catchUpHours !== undefined) set("catch_up_hours", input.catchUpHours);
        if (changed) { doc.set("updated", new Date().toISOString().slice(0, 10)); doc.set("updated_by", "owner"); }
      });
    } catch (e) {
      problem = { error: `${rel} has a problem, so it can't be changed from here: ${(e as Error).message}. Fix the file, then try again.` };
      return { files: [] };
    }
    if (next === cur) return { files: [] };
    const checked = checkFile(rel, { kind: "room", room: slug }, next);
    if (checked.blocks.length) { problem = { error: checked.blocks[0].message, line: checked.blocks[0].line }; return { files: [] }; }
    return { files: [{ rel, text: next }] };
  }, `Change #${room.name}: ${parts.join(", ") || "settings"} (from the app)`, "owner");
  if (problem) return { ok: false, ...problem };
  if (wrote.length) d.store.audit("owner", "room.definition.updated", `${room.name}: ${parts.join(", ")}`);
  const definition = readDefinition(d, roomId);
  return definition ? { ok: true, definition, changed: wrote.length > 0 } : { ok: false, error: "Room not found." };
}
