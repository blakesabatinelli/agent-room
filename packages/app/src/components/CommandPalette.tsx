import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { filterPalette, paletteItems, PALETTE_SCREENS, type PaletteItem } from "@agent-room/shared/src/goalview";
import { useRoom, type Page } from "../state/store";
import { useCommandPalette } from "../state/commandPalette";
import { Avatar } from "./ui";
import { lift, radius, space, type as t, usePalette } from "../theme";

const ROW = 34, HEAD = 26, MAX_H = 380;

/** The id a screen has as a Mac page, or undefined when the app has no such page. */
export const macPage = (screen: string): Page | undefined => PALETTE_SCREENS.find((s) => s.id === screen)?.mac as Page | undefined;

/**
 * 3.1: ⌘K. One box to jump to a room or an agent, run a command in the room you are in, open a screen, or start a goal.
 * Keyboard first: type to filter, up and down to move, Return to run, Escape to close. `pages` are the screens this build has.
 */
export function CommandPalette({ pages, onNavigate }: { pages: Page[]; onNavigate?: () => void }) {
  const open = useCommandPalette((s) => s.open);
  const hide = useCommandPalette((s) => s.hide);
  if (!open) return null;
  return <Panel pages={pages} onNavigate={onNavigate} close={hide} />;
}

function Panel({ pages, onNavigate, close }: { pages: Page[]; onNavigate?: () => void; close: () => void }) {
  const p = usePalette();
  const s = useRoom(useShallow((s) => ({ hub: s.hub, rooms: s.rooms, agents: s.agents, roomId: s.roomId, view: s.view, selectRoom: s.selectRoom, openDm: s.openDm, openPage: s.openPage, focusComposer: s.focusComposer, setError: s.setError })));
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const scroll = useRef<ScrollView>(null);
  const scrollY = useRef(0);

  const items = useMemo(() => {
    const screens = PALETTE_SCREENS.filter((x) => x.mac && (pages as string[]).includes(x.mac)).map((x) => x.id);
    return paletteItems({ rooms: s.rooms, agents: s.agents, currentRoomId: s.view.kind === "room" ? s.roomId : undefined, screens, platform: "mac" });
  }, [s.rooms, s.agents, s.roomId, s.view.kind, pages]);
  const shown = useMemo(() => filterPalette(items, query).slice(0, 60), [items, query]);
  const sel = Math.min(idx, Math.max(0, shown.length - 1));

  // Where each row sits, so the highlighted one can be kept in view when moving with the arrow keys.
  const ys = useMemo(() => {
    let y = 0, last = "";
    return shown.map((it) => { if (it.group !== last) { y += HEAD; last = it.group; } const at = y; y += ROW; return at; });
  }, [shown]);
  useEffect(() => {
    const y = ys[sel]; if (y === undefined) return;
    if (y - HEAD < scrollY.current) scroll.current?.scrollTo({ y: Math.max(0, y - HEAD), animated: false });
    else if (y + ROW > scrollY.current + MAX_H) scroll.current?.scrollTo({ y: y + ROW - MAX_H, animated: false });
  }, [sel, ys]);

  const run = (it?: PaletteItem) => {
    if (!it) return;
    close();
    const a = it.action;
    if (a.kind === "room") void s.selectRoom(a.roomId);
    else if (a.kind === "dm") void s.openDm(a.agentId);
    else if (a.kind === "page") { const pg = macPage(a.screen); if (pg) s.openPage(pg); }
    else if (a.kind === "command") { if (s.roomId) void s.hub?.post(s.roomId, a.text).catch((e) => s.setError((e as Error).message)); }
    else if (a.kind === "goal") { void Promise.resolve(a.roomId === s.roomId && s.view.kind === "room" ? undefined : s.selectRoom(a.roomId)).then(() => s.focusComposer()); }
    onNavigate?.();
  };
  const onKey = (e: { nativeEvent: { key: string; metaKey?: boolean } }) => {
    const k = e.nativeEvent.key;
    if (k === "ArrowDown") setIdx((sel + 1) % Math.max(1, shown.length));
    else if (k === "ArrowUp") setIdx((sel + Math.max(1, shown.length) - 1) % Math.max(1, shown.length));
    else if (k === "Escape" || (k === "k" && e.nativeEvent.metaKey)) close();
  };

  return (
    <View accessibilityViewIsModal style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 50, alignItems: "center" }}>
      <Pressable accessibilityLabel="Close" onPress={close} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: p.scrim }} />
      <View {...({ keyDownEvents: [{ key: "ArrowDown" }, { key: "ArrowUp" }, { key: "Escape" }, { key: "k", metaKey: true }], onKeyDown: onKey } as object)}
        accessibilityLabel="Go to" style={{ marginTop: 90, width: "92%", maxWidth: 580, borderRadius: radius.lg, borderWidth: 1, borderColor: p.lineStrong, backgroundColor: p.canvas, overflow: "hidden", ...lift(0.18, 24, 8) }}>
        <TextInput autoFocus value={query} onChangeText={(v) => { setQuery(v); setIdx(0); }} onSubmitEditing={() => run(shown[sel])}
          placeholder="Go to a room, an agent or a screen, or run a command" placeholderTextColor={p.faint} accessibilityLabel="Go to"
          style={[t.body, { color: p.inkStrong, paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: 1, borderColor: p.line }]} />
        <ScrollView ref={scroll} style={{ maxHeight: MAX_H }} keyboardShouldPersistTaps="handled" onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }} scrollEventThrottle={50}>
          {shown.length ? shown.map((it, i) => (
            <View key={it.id}>
              {i === 0 || shown[i - 1].group !== it.group ? <Text style={[t.tiny, { height: HEAD, color: p.muted, fontWeight: "700", paddingHorizontal: space(4), paddingTop: space(2) }]}>{it.group.toUpperCase()}</Text> : null}
              <Row it={it} on={i === sel} onPress={() => run(it)} />
            </View>
          )) : <Text style={[t.small, { color: p.muted, padding: space(4) }]}>Nothing matches “{query}”.</Text>}
        </ScrollView>
        <View style={{ flexDirection: "row", gap: space(4), paddingHorizontal: space(4), paddingVertical: space(2), borderTopWidth: 1, borderColor: p.line }}>
          <Text style={[t.tiny, { color: p.muted }]}>↑↓ move</Text>
          <Text style={[t.tiny, { color: p.muted }]}>↵ open</Text>
          <Text style={[t.tiny, { color: p.muted }]}>esc close</Text>
          <Text style={[t.tiny, { color: p.muted, marginLeft: "auto" }]}>{Platform.OS === ("macos" as string) ? "⌘K" : ""}</Text>
        </View>
      </View>
    </View>
  );
}

function Row({ it, on, onPress }: { it: PaletteItem; on: boolean; onPress: () => void }) {
  const p = usePalette();
  const agent = useRoom((s) => (it.action.kind === "dm" ? s.agents.find((a) => a.id === (it.action as { agentId: string }).agentId) : undefined));
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={it.title} accessibilityState={{ selected: on }} onPress={onPress}
      style={{ height: ROW, flexDirection: "row", alignItems: "center", gap: space(2.5), paddingHorizontal: space(4), backgroundColor: on ? p.tint : "transparent" }}>
      {agent ? <Avatar name={agent.name} color={agent.color} glyph={agent.avatar} size={18} /> : <View style={{ width: 18 }} />}
      <Text numberOfLines={1} style={[t.body, { color: p.inkStrong, flex: 1, fontWeight: on ? "600" : "400" }]}>{it.title}</Text>
      {it.hint ? <Text numberOfLines={1} style={[t.tiny, { color: p.muted }]}>{it.hint}</Text> : null}
    </Pressable>
  );
}
