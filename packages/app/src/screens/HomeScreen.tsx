import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { Goal } from "@agent-room/shared";
import { pickGoal, goalCardModel } from "@agent-room/shared/src/goalview";
import { useRoom } from "../state/store";
import { Chip } from "../components/ui";
import { radius, space, type as t, usePalette } from "../theme";

/**
 * Simple by default: the home. A greeting, one box to say what you want done, what is in progress, and the rooms as cards.
 * Typing a goal starts it in the room you last worked in (or the first room). The full set of screens lives behind Advanced in the sidebar.
 */
const greet = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

export function HomeScreen() {
  const p = usePalette();
  const s = useRoom(useShallow((s) => ({
    hub: s.hub, rooms: s.rooms, roomId: s.roomId, agents: s.agents, working: s.working, unread: s.unread, ownerName: s.ownerName,
    approvals: s.approvals, selectRoom: s.selectRoom, openPage: s.openPage, setError: s.setError,
  })));
  const { rooms, agents, working, unread } = s;
  const channels = rooms.filter((r) => !r.dmAgentId).sort((a, b) => a.name.localeCompare(b.name));
  const [text, setText] = useState("");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  // Running or waiting goals, across every room (the room view only holds the open room's goals).
  useEffect(() => {
    let live = true;
    Promise.all(channels.map((r) => s.hub?.goals(r.id).catch(() => [] as Goal[]) ?? [])).then((lists) => { if (live) setGoals(lists.flat()); });
    return () => { live = false; };
  }, [s.hub, rooms.length]);

  const inProgress = goals
    .filter((g) => ["running", "planning", "awaiting_approval"].includes(g.status) || (g.status === "paused" && g.state?.waitingOnOwner))
    .sort((a, b) => b.createdAt - a.createdAt);

  const roomLine = (roomId: string): string => {
    const g = pickGoal(goals.filter((x) => x.roomId === roomId));
    if (g && ["running", "planning", "awaiting_approval", "paused"].includes(g.status)) return g.contract?.objective ?? g.text;
    const busy = Object.keys(working[roomId] ?? {}).map((id) => agents.find((a) => a.id === id)?.name).filter(Boolean);
    if (busy.length) return `${busy.join(" and ")} working`;
    if (unread[roomId]) return "New messages";
    const r = rooms.find((x) => x.id === roomId);
    return r?.topic || "Quiet";
  };

  const start = async () => {
    const v = text.trim(); if (!v || !s.hub) return;
    let target = channels.find((r) => r.id === s.roomId) ?? channels[0];
    if (!target) { s.setError("Make a room first."); return; }
    setText("");
    try { await s.hub.post(target.id, v); await s.selectRoom(target.id); }
    catch (e) { s.setError((e as Error).message); }
  };

  const create = async () => {
    const v = name.trim(); if (!v || !s.hub) return setCreating(false);
    try { const r = await s.hub.createRoom(v); setName(""); setCreating(false); useRoom.setState({ rooms: [...useRoom.getState().rooms.filter((x) => x.id !== r.id), r] }); await s.selectRoom(r.id); }
    catch (e) { s.setError((e as Error).message); }
  };

  const seen = new Set<string>();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: p.canvas }} contentContainerStyle={{ padding: space(6), gap: space(5), maxWidth: 720, width: "100%", alignSelf: "center" }}>
      <Text style={[t.title, { color: p.inkStrong }]}>{greet()}{s.ownerName ? `, ${s.ownerName}` : ""}.</Text>

      <View style={{ flexDirection: "row", gap: space(2), alignItems: "flex-end" }}>
        <TextInput value={text} onChangeText={setText} onSubmitEditing={() => void start()} placeholder="What do you want to get done?" placeholderTextColor={p.faint}
          multiline style={[t.body, { flex: 1, color: p.inkStrong, backgroundColor: p.canvas, borderWidth: 1, borderColor: p.lineStrong, borderRadius: radius.xl, paddingHorizontal: space(3.5), paddingVertical: space(3), minHeight: 48 }]} />
        <Pressable accessibilityRole="button" accessibilityLabel="Start" onPress={() => void start()}
          style={{ paddingHorizontal: space(4), paddingVertical: space(3), borderRadius: radius.xl, backgroundColor: p.accent }}>
          <Text style={[t.body, { color: p.onAccent, fontWeight: "700" }]}>Start</Text>
        </Pressable>
      </View>

      {inProgress.length ? (
        <View style={{ gap: space(2) }}>
          <Text style={[t.small, { color: p.muted, fontWeight: "600" }]}>In progress</Text>
          {inProgress.map((g) => {
            if (seen.has(g.roomId)) return null; seen.add(g.roomId);
            const r = rooms.find((x) => x.id === g.roomId); if (!r) return null;
            const m = goalCardModel(g, []);
            return (
              <Pressable key={g.id} accessibilityRole="button" onPress={() => void s.selectRoom(g.roomId)}
                style={{ flexDirection: "row", alignItems: "center", gap: space(3), padding: space(3), borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, backgroundColor: p.surface }}>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={1} style={[t.body, { color: p.inkStrong, fontWeight: "600" }]}>{m.objective}</Text>
                  <Text numberOfLines={1} style={[t.small, { color: p.muted }]}>{r.name} · {m.state.label}{m.total ? ` · ${m.met} of ${m.total} met` : ""}</Text>
                </View>
                <Chip label={m.state.label} tone={m.state.tone} />
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={{ gap: space(2) }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[t.small, { color: p.muted, fontWeight: "600", flex: 1 }]}>Rooms</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="New room" onPress={() => setCreating(true)}><Text style={[t.small, { color: p.accent, fontWeight: "600" }]}>+ New room</Text></Pressable>
        </View>
        {creating ? (
          <TextInput autoFocus value={name} onChangeText={setName} onSubmitEditing={() => void create()} onBlur={() => !name && setCreating(false)} placeholder="new-room" placeholderTextColor={p.faint}
            style={[t.body, { color: p.inkStrong, backgroundColor: p.canvas, borderWidth: 1, borderColor: p.accent, borderRadius: radius.md, paddingHorizontal: space(3), paddingVertical: space(2) }]} />
        ) : null}
        {channels.map((r) => (
          <Pressable key={r.id} accessibilityRole="button" onPress={() => void s.selectRoom(r.id)}
            style={{ flexDirection: "row", alignItems: "center", gap: space(3), padding: space(3), borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, backgroundColor: p.canvas }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: unread[r.id] ? p.accent : p.lineStrong, backgroundColor: unread[r.id] ? p.accent : "transparent" }} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text numberOfLines={1} style={[t.body, { color: p.inkStrong, fontWeight: "600" }]}>{r.name}{r.paused ? " (paused)" : ""}</Text>
              <Text numberOfLines={1} style={[t.small, { color: p.muted }]}>{roomLine(r.id)}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
