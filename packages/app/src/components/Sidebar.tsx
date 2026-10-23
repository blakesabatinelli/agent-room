import { useShallow } from "zustand/react/shallow";
import React, { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { presence, useRoom, type Page } from "../state/store";
import { Dot } from "./ui";
import { agentTone } from "@agent-room/shared/src/colors";
import { SidebarSurface } from "./SidebarSurface"; // 3.1: translucent on the Mac
import { useCommandPalette } from "../state/commandPalette";
import { radius, space, type as t, usePalette } from "../theme";

function Row({ label, prefix, active, bold, badge, onPress, right }: {
  label: string; prefix: React.ReactNode; active?: boolean; bold?: boolean; badge?: number; onPress: () => void; right?: React.ReactNode;
}) {
  const p = usePalette();
  const [hover, setHover] = useState(false);
  return (
    <Pressable onPress={onPress} onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} accessibilityRole="button" accessibilityState={{ selected: active }}
      style={{ flexDirection: "row", alignItems: "center", gap: space(2), height: 28, paddingHorizontal: space(2.5), marginHorizontal: space(2), borderRadius: radius.md,
        backgroundColor: active ? p.sidebarActive : hover ? p.sidebarHover : "transparent" }}>
      <View style={{ width: 16, alignItems: "center" }}>{prefix}</View>
      <Text numberOfLines={1} style={[t.body, { flex: 1, color: active ? p.accent : bold ? p.inkStrong : p.sidebarInk, fontWeight: bold || active ? "600" : "400" }]}>{label}</Text>
      {right}
      {badge ? (
        <View style={{ minWidth: 20, height: 18, paddingHorizontal: 6, borderRadius: 9, backgroundColor: p.accent, alignItems: "center", justifyContent: "center" }}>
          <Text style={[t.tiny, { color: p.onAccent, fontWeight: "700" }]}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** A room's marker: a small ring, filled when there is something new in it. */
function RoomMark({ unread }: { unread: boolean }) {
  const p = usePalette();
  return <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: unread ? p.accent : p.sidebarMuted, backgroundColor: unread ? p.accent : "transparent" }} />;
}

/** The way into ⌘K, in the sidebar for anyone who hasn't learned the shortcut yet. */
function GoToRow() {
  const p = usePalette();
  const [hover, setHover] = useState(false);
  const show = useCommandPalette((s) => s.show);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Go to, Command K" onPress={show} onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)}
      style={{ flexDirection: "row", alignItems: "center", gap: space(2), height: 28, marginHorizontal: space(3), marginTop: space(2.5), marginBottom: space(1), paddingHorizontal: space(2.5), borderRadius: radius.md, borderWidth: 1, borderColor: p.line, backgroundColor: hover ? p.sidebarHover : "transparent" }}>
      <Text style={[t.small, { color: p.sidebarMuted }]}>⌕</Text>
      <Text style={[t.small, { color: p.sidebarMuted, flex: 1 }]}>Go to…</Text>
      <Text style={[t.tiny, { color: p.sidebarMuted }]}>⌘K</Text>
    </Pressable>
  );
}

function Heading({ label, onAdd, open, toggle }: { label: string; onAdd?: () => void; open: boolean; toggle: () => void }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space(4), marginTop: space(4), marginBottom: space(1) }}>
      <Pressable onPress={toggle} style={{ flex: 1, flexDirection: "row", gap: space(1.5), alignItems: "center" }}>
        <Text style={[t.tiny, { color: p.sidebarMuted, width: 10 }]}>{open ? "▾" : "▸"}</Text>
        <Text style={[t.small, { color: p.sidebarMuted, fontWeight: "600" }]}>{label}</Text>
      </Pressable>
      {onAdd ? (
        <Pressable onPress={onAdd} accessibilityLabel={`Add to ${label}`} style={{ paddingHorizontal: space(1.5), borderRadius: radius.sm }}>
          <Text style={[t.body, { color: p.sidebarMuted, fontWeight: "700" }]}>＋</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const p = usePalette();
  const s = useRoom(useShallow((s) => ({ rooms: s.rooms, roomId: s.roomId, view: s.view, agents: s.agents, approvals: s.approvals, unread: s.unread, hub: s.hub, online: s.online, statuses: s.statuses, working: s.working, openDm: s.openDm, openPage: s.openPage, ownerName: s.ownerName, proposals: s.proposals, selectRoom: s.selectRoom, setError: s.setError })));
  const { rooms, roomId, view, agents, approvals, unread, hub, online } = s;
  const [openCh, setOpenCh] = useState(true);
  const [openDm, setOpenDm] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const channels = rooms.filter((r) => !r.dmAgentId);
  const go = (fn: () => void) => { fn(); onNavigate?.(); };
  const page = (pg: Page) => go(() => s.openPage(pg));
  const isPage = (pg: Page) => view.kind === "page" && view.page === pg;
  const create = async () => {
    const v = name.trim(); if (!v || !hub) return setCreating(false);
    try { const r = await hub.createRoom(v); setName(""); setCreating(false); useRoom.setState({ rooms: [...useRoom.getState().rooms.filter((x) => x.id !== r.id), r] }); go(() => void s.selectRoom(r.id)); }
    catch (e) { s.setError((e as Error).message); }
  };

  return (
    <SidebarSurface>
      <View style={{ height: 58, flexDirection: "row", alignItems: "center", paddingHorizontal: space(4), borderBottomWidth: 1, borderColor: p.line, gap: space(2) }}>
        <View style={{ flex: 1 }}>
          <Text style={[t.heading, { color: p.inkStrong, fontSize: 17 }]}>Agent Room</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Dot state={online ? "ready" : "off"} size={7} />
            <Text style={[t.tiny, { color: p.sidebarMuted }]}>{online ? `${s.ownerName}'s hub` : "Reconnecting…"}</Text>
          </View>
        </View>
      </View>

      <GoToRow />
      <ScrollView contentContainerStyle={{ paddingVertical: space(2) }}>
        <Row label="Approvals" prefix={<Text style={[t.small, { color: p.sidebarMuted }]}>✓</Text>} active={isPage("approvals")} bold={approvals.length > 0} badge={approvals.length || undefined} onPress={() => page("approvals")} />
        <Row label="Memory" prefix={<Text style={[t.small, { color: p.sidebarMuted }]}>◇</Text>} active={isPage("memory")} badge={s.proposals.length || undefined} onPress={() => page("memory")} />
        <Row label="Office" prefix={<Text style={[t.small, { color: p.sidebarMuted }]}>▦</Text>} active={isPage("office")} onPress={() => page("office")} />

        <Heading label="Rooms" open={openCh} toggle={() => setOpenCh(!openCh)} onAdd={() => { setOpenCh(true); setCreating(true); }} />
        {openCh ? channels.map((r) => (
          <Row key={r.id} label={r.name} prefix={<RoomMark unread={!!unread[r.id]} />}
            active={view.kind === "room" && roomId === r.id} bold={!!unread[r.id]} badge={undefined}
            onPress={() => go(() => void s.selectRoom(r.id))} />
        )) : null}
        {creating ? (
          <View style={{ marginHorizontal: space(3), marginTop: space(1) }}>
            <TextInput autoFocus value={name} onChangeText={setName} onSubmitEditing={create} onBlur={() => !name && setCreating(false)}
              placeholder="new-room" placeholderTextColor={p.sidebarMuted}
              style={[t.small, { color: p.inkStrong, backgroundColor: p.canvas, borderWidth: 1, borderColor: p.accent, borderRadius: radius.md, paddingHorizontal: space(2), paddingVertical: space(1.5) }]} />
          </View>
        ) : null}

        <Heading label="Agents" open={openDm} toggle={() => setOpenDm(!openDm)} onAdd={() => page("agents")} />
        {openDm ? agents.map((a) => {
          const dm = rooms.find((r) => r.dmAgentId === a.id);
          const pres = presence(s, a.id);
          return (
            <Row key={a.id} label={a.name}
              prefix={<View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: agentTone(a.color, p.sidebar).bg, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: agentTone(a.color, p.sidebar).ink, fontSize: 10, fontWeight: "700" }}>{a.avatar || a.name[0]}</Text>
                <View style={{ position: "absolute", right: -3, bottom: -3 }}><Dot state={pres} size={8} ring={p.sidebar} /></View>
              </View>}
              active={view.kind === "room" && !!dm && roomId === dm.id} bold={!!dm && !!unread[dm.id]} badge={dm ? unread[dm.id] || undefined : undefined}
              right={!a.enabled ? <Text style={[t.tiny, { color: p.sidebarMuted }]}>off</Text> : pres === "off" || pres === "error" ? <Text style={[t.tiny, { color: pres === "error" ? p.danger : p.sidebarMuted }]}>connect</Text> : null}
              onPress={() => go(() => (pres === "off" || pres === "error") && a.enabled ? s.openPage("agents") : void s.openDm(a.id))} />
          );
        }) : null}
        <Row label="Add an agent" prefix={<Text style={[t.body, { color: p.sidebarMuted }]}>＋</Text>} onPress={() => page("agents")} />
      </ScrollView>

      <View style={{ borderTopWidth: 1, borderColor: p.line, paddingVertical: space(2) }}>
        <Row label="Scorecard" prefix={<Text style={[t.small, { color: p.sidebarMuted }]}>▥</Text>} active={isPage("scorecard")} onPress={() => page("scorecard")} />
        <Row label="Résumés" prefix={<Text style={[t.small, { color: p.sidebarMuted }]}>☰</Text>} active={isPage("resumes")} onPress={() => page("resumes")} />
        <Row label="Agents & connections" prefix={<Text style={[t.small, { color: p.sidebarMuted }]}>⚇</Text>} active={isPage("agents")} onPress={() => page("agents")} />
        <Row label="Permissions" prefix={<Text style={[t.small, { color: p.sidebarMuted }]}>⚿</Text>} active={isPage("permissions")} onPress={() => page("permissions")} />
        <Row label="Folders" prefix={<Text style={[t.small, { color: p.sidebarMuted }]}>▤</Text>} active={isPage("folders")} onPress={() => page("folders")} />
        <Row label="Settings" prefix={<Text style={[t.small, { color: p.sidebarMuted }]}>⚙</Text>} active={isPage("settings")} onPress={() => page("settings")} />
      </View>
    </SidebarSurface>
  );
}
