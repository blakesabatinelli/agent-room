import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { RoomDefinition } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Avatar, Button, Field, IconButton } from "./ui";
import { RoomFolders } from "./RoomFolders"; // room folders
import { radius, space, type as t, usePalette } from "../theme";

const when = (ms?: number, zone?: string) => {
  if (!ms) return "";
  try { return new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) }); }
  catch { return new Date(ms).toLocaleString(); }
};

interface Form { roster: string[]; schedule: string; timezone: string; standingGoal: string; catchUpHours: string }
const toForm = (d: RoomDefinition, everyone: string[]): Form => ({
  roster: d.open ? everyone : d.roster.map((r) => r.id),
  schedule: d.schedule?.cron ?? "",
  timezone: d.schedule?.timezone ?? "",
  standingGoal: d.schedule?.standingGoal ?? "",
  catchUpHours: d.schedule ? String(d.schedule.catchUpHours) : "",
});

/**
 * 4.3: what ROOM.md says about this room. Who works here, which tools it narrows, which folders its work may use,
 * and the calendar trigger with its next run. Read live from the hub. The roster and the schedule can be changed
 * here (the hub writes ROOM.md and commits it); everything else is edited in the file ("Edit ROOM.md").
 */
export function RoomSettings({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const p = usePalette();
  const { hub, agents } = useRoom(useShallow((s) => ({ hub: s.hub, agents: s.agents })));
  const [def, setDef] = useState<RoomDefinition>();
  const [form, setForm] = useState<Form>();
  const [saved, setSaved] = useState<Form>();
  const [err, setErr] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [delStage, setDelStage] = useState<"idle" | "confirm" | "force">("idle"); // delete a room: a second tap confirms; a busy room offers stop-and-delete
  const [delErr, setDelErr] = useState<string>();
  const dirty = useRef(false);
  const everyone = agents.map((a) => a.id);

  const load = () => hub?.roomDefinition(roomId).then((d) => {
    setDef(d); setErr(undefined);
    const f = toForm(d, everyone);
    setSaved(f);
    if (!dirty.current) setForm(f);
  }).catch((e) => setErr((e as Error).message));
  // The file can change under us (an editor, a git pull): read it again when the room or the agent list changes.
  useEffect(() => { dirty.current = false; setDef(undefined); setForm(undefined); setNote(undefined); void load(); }, [hub, roomId, agents.length]);

  const edit = (patch: Partial<Form>) => { dirty.current = true; setNote(undefined); setForm((f) => (f ? { ...f, ...patch } : f)); };
  const toggle = (id: string) => form && edit({ roster: form.roster.includes(id) ? form.roster.filter((x) => x !== id) : [...form.roster, id] });
  const changed = !!form && !!saved && JSON.stringify(form) !== JSON.stringify(saved);

  const save = async () => {
    if (!form || !saved || !hub) return;
    if (!form.roster.length) { setErr("Pick at least one agent for the roster."); return; }
    const hours = form.catchUpHours.trim() === "" ? null : Number(form.catchUpHours);
    if (hours !== null && !(hours >= 0 && hours <= 168)) { setErr("Catch up within needs a number of hours from 0 to 168."); return; }
    setBusy(true); setErr(undefined);
    try {
      // Only what changed is sent; an emptied field clears it.
      const input: Parameters<typeof hub.saveRoomDefinition>[1] = {};
      if (JSON.stringify([...form.roster].sort()) !== JSON.stringify([...saved.roster].sort())) input.roster = form.roster;
      if (form.schedule !== saved.schedule) input.schedule = form.schedule.trim() || null;
      if (form.timezone !== saved.timezone) input.timezone = form.timezone.trim() || null;
      if (form.standingGoal !== saved.standingGoal) input.standingGoal = form.standingGoal.trim() || null;
      if (form.catchUpHours !== saved.catchUpHours) input.catchUpHours = hours;
      const d = await hub.saveRoomDefinition(roomId, input);
      dirty.current = false;
      const f = toForm(d, everyone);
      setDef(d); setSaved(f); setForm(f); setNote("Saved to ROOM.md");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const openFile = async () => {
    if (!hub) return;
    setErr(undefined);
    try {
      const r = await hub.openRoomFile(roomId);
      setNote(r.ok ? `Opened ${r.path}` : `Open it from here: ${r.path}`);
    } catch (e) { setErr((e as Error).message); }
  };

  // Delete this room. The hub refuses while work is going (400); then offer to stop it and delete anyway (force).
  const remove = async (force: boolean) => {
    if (!hub) return;
    if (!force && delStage !== "confirm") { setDelStage("confirm"); setDelErr(undefined); return; }
    try {
      await hub.deleteRoom(roomId, force);
      onClose(); // the room_deleted event drops it and the store moves to another room
    } catch (e) {
      const msg = (e as Error).message;
      if (!force && /still going|work is/i.test(msg)) { setDelStage("force"); setDelErr(msg); return; }
      setDelErr(msg); setDelStage("idle");
    }
  };

  const h = (text: string) => <Text style={[t.heading, { color: p.inkStrong }]}>{text}</Text>;
  const sc = def?.schedule;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ height: 58, flexDirection: "row", alignItems: "center", paddingHorizontal: space(4), borderBottomWidth: 1, borderColor: p.line }}>
        <Text style={[t.heading, { color: p.inkStrong, flex: 1 }]}>Room settings</Text>
        <IconButton glyph="✕" label="Close" onPress={onClose} />
      </View>
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(5) }}>
        {!def || !form ? <Text style={[t.small, { color: err ? p.danger : p.muted }]}>{err ?? "Loading…"}</Text> : (
          <>
            <View style={{ gap: space(1) }}>
              <Text style={[t.small, { color: p.muted }]}>{def.hasFile ? "Set in this room's ROOM.md. The hub keeps to it." : "This room has no ROOM.md yet, so every agent works here with its usual tools."}</Text>
              {def.path ? <Text selectable style={[t.tiny, { color: p.ink, fontFamily: "Menlo" }]}>{def.path}</Text> : null}
              {def.hasFile ? <View style={{ flexDirection: "row" }}><Button small kind="plain" label="Edit ROOM.md" onPress={() => void openFile()} /></View> : null}
            </View>

            <View style={{ gap: space(2) }}>
              {h("Roster")}
              <Text style={[t.tiny, { color: p.muted }]}>{def.open ? "Everyone works here. Pick fewer to limit the room." : "Only these agents are planned, routed, judged and @mentioned here."}</Text>
              {!def.hasFile ? null : agents.map((a) => {
                const on = form.roster.includes(a.id);
                return (
                  <Pressable key={a.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={a.name} onPress={() => toggle(a.id)}
                    style={{ flexDirection: "row", alignItems: "center", gap: space(2), opacity: on ? 1 : 0.55 }}>
                    <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: on ? p.accent : p.lineStrong, backgroundColor: on ? p.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                      {on ? <Text style={{ color: p.onAccent, fontSize: 11, fontWeight: "700" }}>✓</Text> : null}
                    </View>
                    <Avatar name={a.name} color={a.color} glyph={a.avatar} size={20} />
                    <Text style={[t.small, { color: p.ink, flex: 1 }]}>{a.name}{a.enabled ? "" : " (off)"}</Text>
                  </Pressable>
                );
              })}
              {!def.hasFile ? def.roster.map((r) => (
                <View key={r.id} style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
                  <Avatar name={r.name} color={r.color} glyph={r.avatar} size={20} /><Text style={[t.small, { color: p.ink }]}>{r.name}</Text>
                </View>
              )) : null}
            </View>

            <View style={{ gap: space(1.5) }}>
              {h("Tools in this room")}
              {def.tools.length ? def.tools.map((x) => (
                <Text key={x.tool} style={[t.small, { color: p.ink }]}>{x.label}: <Text style={{ color: x.level === "off" ? p.danger : p.warn, fontWeight: "700" }}>{x.level === "off" ? "off" : "asks first"}</Text></Text>
              )) : <Text style={[t.small, { color: p.muted }]}>Nothing narrowed. Each agent has the tools it usually has.</Text>}
            </View>

            <RoomFolders roomId={roomId} />

            <View style={{ gap: space(1.5) }}>
              {h("Folders ROOM.md allows")}
              {def.folders.length ? def.folders.map((f) => (
                <View key={f.id} style={{ gap: 1 }}>
                  <Text style={[t.small, { color: f.missing ? p.danger : p.ink }]}>{f.label ?? f.id}{f.missing ? " (not granted)" : ""}</Text>
                  {f.path ? <Text selectable style={[t.tiny, { color: p.muted, fontFamily: "Menlo" }]}>{f.path}</Text> : null}
                </View>
              )) : <Text style={[t.small, { color: p.muted }]}>No limit. Any folder you have granted for this room.</Text>}
            </View>

            <View style={{ gap: space(2) }}>
              {h("Schedule")}
              {sc ? (
                <View style={{ gap: 2 }}>
                  <Text style={[t.small, { color: sc.active ? p.ink : p.danger }]}>
                    {sc.active ? (sc.nextRun ? `Next run ${when(sc.nextRun, sc.timezone)}` : "No run coming up") : `Off: ${sc.problem ?? "check the schedule"}`}
                  </Text>
                  {sc.lastRun ? <Text style={[t.tiny, { color: p.muted }]}>Last run {when(sc.lastRun, sc.timezone)}{sc.running ? ", still going" : ""}</Text> : null}
                  {sc.lastNote ? <Text style={[t.tiny, { color: p.muted }]}>{sc.lastNote}</Text> : null}
                </View>
              ) : <Text style={[t.small, { color: p.muted }]}>Nothing scheduled.</Text>}
              {def.hasFile ? (
                <>
                  <Field label="Schedule" value={form.schedule} onChangeText={(v) => edit({ schedule: v })} autoCapitalize="none" maxLength={120}
                    hint="Five fields: minute hour day month weekday. For example 0 9 * * 1-5 is weekdays at 9. Empty turns it off." />
                  <Field label="Time zone" value={form.timezone} onChangeText={(v) => edit({ timezone: v })} autoCapitalize="none" maxLength={64}
                    hint="Like America/Chicago. Empty uses the zone in USER.md." />
                  <Field label="Standing goal" value={form.standingGoal} onChangeText={(v) => edit({ standingGoal: v })} multiline numberOfLines={3} maxLength={2000}
                    style={{ minHeight: 70, textAlignVertical: "top" }} hint="What starts each time. It runs as you, and shows up as Scheduled." />
                  <Field label="Catch up within (hours)" value={form.catchUpHours} onChangeText={(v) => edit({ catchUpHours: v })} keyboardType="numeric" maxLength={3}
                    hint="If the hub was asleep, a missed run still starts once within this many hours. Empty uses the default." />
                </>
              ) : null}
            </View>

            {def.inScope.length || def.outOfScope.length ? (
              <View style={{ gap: space(1) }}>
                {h("Scope")}
                {def.inScope.map((x, i) => <Text key={`i${i}`} style={[t.small, { color: p.ink }]}>• {x}</Text>)}
                {def.outOfScope.length ? <Text style={[t.tiny, { color: p.muted }]}>Out of scope: {def.outOfScope.join("; ")}</Text> : null}
              </View>
            ) : null}

            {def.notices.length ? (
              <View style={{ backgroundColor: p.warnBg, borderRadius: radius.md, padding: space(3), gap: 2 }}>
                {def.notices.map((n, i) => <Text key={i} style={[t.tiny, { color: p.warn }]}>{n.message}</Text>)}
              </View>
            ) : null}

            {err ? <Text accessibilityRole="alert" style={[t.small, { color: p.danger }]}>{err}</Text> : null}
            {def.hasFile ? (
              <View style={{ flexDirection: "row", gap: space(2), alignItems: "center", flexWrap: "wrap" }}>
                <Button label={busy ? "Saving…" : "Save"} onPress={() => void save()} disabled={busy || !changed} />
                {changed ? <Button kind="ghost" label="Undo changes" onPress={() => { dirty.current = false; setForm(saved); setErr(undefined); }} /> : null}
              </View>
            ) : null}
            {note && !changed ? <Text selectable style={[t.small, { color: p.ok }]}>{note}</Text> : null}

            <View style={{ gap: space(2), marginTop: space(4), borderTopWidth: 1, borderColor: p.line, paddingTop: space(4) }}>
              {h("Delete room")}
              <Text style={[t.tiny, { color: p.muted }]}>Remove this room and everything in it. This cannot be undone.</Text>
              {delErr ? <Text accessibilityRole="alert" style={[t.small, { color: p.danger }]}>{delErr}</Text> : null}
              <View style={{ flexDirection: "row" }}>
                {delStage === "force"
                  ? <Button kind="danger" small label="Stop work and delete" onPress={() => void remove(true)} />
                  : <Button kind="danger" small label={delStage === "confirm" ? "Really delete this room?" : "Delete room"} onPress={() => void remove(false)} />}
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
