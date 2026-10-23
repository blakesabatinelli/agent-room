import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
import type { CommandGroup, CommandRow, FolderGrant, Message, Task } from "@agent-room/shared";
import { presence, useRoom } from "../state/store";
import { DayDivider, MessageRow } from "../components/MessageRow";
import { Avatar, Button, Dot, IconButton } from "../components/ui";
import { JuryChips } from "../components/JuryChips"; // 2.2
import { GoalCard } from "../components/GoalCard"; // 3.1
import { TaskVerdict } from "../components/TaskVerdict"; // 3.1
import { chipMessageIds } from "@agent-room/shared/src/goalview";
import { lift, radius, space, type as t, usePalette } from "../theme";

type Row = { kind: "day"; id: string; at: number } | { kind: "new"; id: string } | { kind: "msg"; id: string; m: Message; grouped: boolean };

const STATUS: Record<Task["status"], string> = {
  pending: "Queued", assigned: "Assigned", running: "Working", review: "Being checked", revising: "Revising",
  waiting: "Needs your input", done: "Done", failed: "Failed", cancelled: "Cancelled",
};

export function RoomScreen({ onBack }: { onBack?: () => void }) {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const s = useRoom(useShallow((s) => ({ composerStamp: s.composerStamp, hub: s.hub, roomId: s.roomId, rooms: s.rooms, messages: s.messages, agents: s.agents, calibration: s.calibration, working: s.working, ownerName: s.ownerName, goals: s.goals, loaded: s.loaded, openDm: s.openDm, openPage: s.openPage, setError: s.setError, statuses: s.statuses })));
  const { hub, roomId, rooms, messages, agents, calibration, working, ownerName, goals } = s;
  const room = rooms.find((r) => r.id === roomId);
  const dmAgent = room?.dmAgentId ? agents.find((a) => a.id === room.dmAgentId) : undefined;
  const [text, setText] = useState("");
  const [details, setDetails] = useState(false);
  const [height, setHeight] = useState(22);
  const list = useRef<FlatList<Row>>(null);
  const input = useRef<TextInput>(null);
  const wide = width >= 1100;

  const mentionNames = useMemo(() => new Set(agents.flatMap((a) => [a.id.toLowerCase(), a.name.toLowerCase().replace(/\s+/g, "")])), [agents]);
  const visible = messages.filter((m) => !m.quiet && m.author.kind !== "orchestrator" && m.type !== "directive");
  const chipIds = useMemo(() => chipMessageIds(visible), [visible.length, visible.at(-1)?.id]); // 3.1: the verdict chip sits on the last message of each task
  const log = messages.filter((m) => m.quiet || m.author.kind === "orchestrator" || m.type === "directive" || m.type === "task_update");

  // Where the owner had read up to when this room opened. Frozen for the visit so the "New" line stays put.
  const ready = s.loaded?.roomId === roomId;
  const readAt = ready ? s.loaded!.readAt : 0;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let prev: Message | undefined;
    let marked = false;
    for (const m of visible) {
      if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) out.push({ kind: "day", id: `day-${m.id}`, at: m.createdAt });
      if (!marked && readAt > 0 && m.createdAt > readAt && m.author.kind !== "human") { out.push({ kind: "new", id: "new" }); marked = true; }
      const grouped = !!prev && prev.author.id === m.author.id && m.type !== "system" && prev.type !== "system"
        && m.createdAt - prev.createdAt < 5 * 60_000 && new Date(prev.createdAt).toDateString() === new Date(m.createdAt).toDateString();
      out.push({ kind: "msg", id: m.id, m, grouped });
      prev = m;
    }
    return out;
  }, [visible.length, visible.at(-1)?.id, readAt]);

  // Opening a room always lands on the newest message. The list stays invisible until it has
  // settled at the bottom (rows keep measuring in for a moment), so you never see it jump.
  // Unread messages above get a "New messages" button instead of moving you away from the latest.
  const positioned = useRef<string | undefined>(undefined);
  const atBottom = useRef(true);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [shown, setShown] = useState<string | undefined>(undefined);
  const [jumpDismissed, setJumpDismissed] = useState<string | undefined>(undefined);
  const newIndex = rows.findIndex((r) => r.kind === "new");
  const settle = () => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => { positioned.current = roomId; atBottom.current = true; setShown(roomId); }, 150);
  };
  useEffect(() => {
    // Safety net: show the room even if the list never reports a size change.
    if (!ready || !roomId || positioned.current === roomId) return;
    const t = setTimeout(() => { list.current?.scrollToEnd({ animated: false }); positioned.current = roomId; setShown(roomId); }, 900);
    return () => clearTimeout(t);
  }, [ready, roomId]);
  const onListSize = () => {
    if (!ready || !rows.length) return;
    if (positioned.current !== roomId) { list.current?.scrollToEnd({ animated: false }); settle(); return; }
    const last = visible.at(-1);
    if (atBottom.current || last?.author.kind === "human") list.current?.scrollToEnd({ animated: true });
  };
  const jumpToNew = () => { setJumpDismissed(roomId); if (newIndex >= 0) list.current?.scrollToIndex({ index: newIndex, viewPosition: 0, animated: true }); };
  const showJump = shown === roomId && newIndex >= 0 && jumpDismissed !== roomId;

  // Seeing the room marks it read up to the newest message, on every paired device.
  const newest = messages.at(-1)?.createdAt ?? 0;
  useEffect(() => { if (ready && roomId && newest) void hub?.markRead(roomId, newest).catch(() => {}); }, [ready, roomId, newest]);
  useEffect(() => { setText(""); setDetails(false); setFolderId(""); setPickOpen(false); }, [roomId]);
  useEffect(() => { if (s.composerStamp) input.current?.focus(); }, [s.composerStamp]); // 3.1: "Start a goal" in the ⌘K palette

  // 1.1: a goal can work in a folder the owner granted. Only grants that can carry a goal are offered: open to every
  // agent, readable, and for this room (or every room). The hub checks again and says why if it refuses.
  const [grants, setGrants] = useState<FolderGrant[]>([]);
  const [folderId, setFolderId] = useState("");
  const [pickOpen, setPickOpen] = useState(false);
  useEffect(() => {
    let live = true;
    if (!hub || !roomId) { setGrants([]); return; }
    hub.folderGrants().then((all) => { if (live) setGrants(all.filter((g) => g.agentId === "*" && g.read && (!g.roomId || g.roomId === roomId))); }).catch(() => { if (live) setGrants([]); });
    return () => { live = false; };
  }, [hub, roomId]);
  const folder = grants.find((g) => g.id === folderId);
  const folderName = (g: FolderGrant) => g.label || g.path.split("/").filter(Boolean).pop() || g.path;

  // @mention autocomplete
  const mentionQuery = /(^|\s)@([\w-]*)$/.exec(text)?.[2];
  const suggestions = mentionQuery !== undefined && !dmAgent
    ? agents.filter((a) => a.enabled && (a.id.startsWith(mentionQuery.toLowerCase()) || a.name.toLowerCase().startsWith(mentionQuery.toLowerCase())))
    : [];
  const pickMention = (id: string) => { setText(text.replace(/@([\w-]*)$/, `@${id} `)); input.current?.focus(); };

  // 2.6 slash commands: "/" at the start of the box opens a palette (Room first, then each agent). Up/down/Escape on the Mac, tap anywhere.
  const [cmdGroups, setCmdGroups] = useState<CommandGroup[] | null>(null);
  const [cmdAt, setCmdAt] = useState(0);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [cmdOff, setCmdOff] = useState(false);
  const cmdQuery = !cmdOff ? /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase() : undefined;
  useEffect(() => {
    if (cmdQuery === undefined || !hub || (cmdGroups && Date.now() - cmdAt < 30_000)) return;
    let live = true;
    hub.commands().then((r) => { if (live) { setCmdGroups(r.groups); setCmdAt(Date.now()); } }).catch(() => undefined);
    return () => { live = false; };
  }, [hub, cmdQuery === undefined]);
  const cmdRows = useMemo(() => {
    if (cmdQuery === undefined || !cmdGroups) return [] as { group: string; row: CommandRow }[];
    const hit = (c: CommandRow) => !cmdQuery || c.name.toLowerCase().includes(cmdQuery) || c.description.toLowerCase().includes(cmdQuery);
    return cmdGroups.flatMap((g) => g.commands.filter(hit).map((row) => ({ group: g.label, row })));
  }, [cmdGroups, cmdQuery]);
  const cmdSel = cmdRows[Math.min(cmdIdx, Math.max(0, cmdRows.length - 1))]?.row;
  const pickCommand = (name: string) => { setText(`/${name} `); setCmdIdx(0); input.current?.focus(); };
  const onTextChange = (v: string) => { setText(v); setCmdIdx(0); setCmdOff(false); };
  const cmdKey = (e: { nativeEvent: { key: string } }) => {
    if (!cmdRows.length) return;
    const k = e.nativeEvent.key;
    if (k === "ArrowDown") setCmdIdx((i) => (i + 1) % cmdRows.length);
    else if (k === "ArrowUp") setCmdIdx((i) => (i + cmdRows.length - 1) % cmdRows.length);
    else if (k === "Escape") setCmdOff(true);
  };

  const send = async () => {
    if (suggestions.length && mentionQuery !== undefined) return pickMention(suggestions[0].id);
    // A command typed out in full still sends; a partial one is completed from the highlighted row.
    if (cmdSel && cmdSel.name !== cmdQuery) return pickCommand(cmdSel.name);
    const v = text.trim(); if (!v || !hub || !roomId) return;
    setText(""); setHeight(22);
    try { await hub.post(roomId, v, folder?.id); setFolderId(""); setPickOpen(false); }
    catch (e) { s.setError((e as Error).message); setText(v); }   // a refused folder comes back with the hub's reason
  };
  const rate = async (taskId: string, score: number) => {
    await hub?.rate(taskId, score);
    useRoom.setState((st) => ({ calibration: st.calibration.filter((x) => x.id !== taskId) }));
  };

  const busy = Object.entries(working[roomId ?? ""] ?? {});
  const busyNames = busy.filter(([id]) => id !== "orchestrator").map(([id]) => agents.find((a) => a.id === id)?.name ?? id);
  const typing = busyNames.length ? `${busyNames.join(" and ")} ${busyNames.length > 1 ? "are" : "is"} working…` : busy.length ? "Figuring out who should take this…" : "";
  const members = agents.filter((a) => a.enabled);
  const pending = calibration[0];
  // While a job runs, anything typed here steers it.
  const activeGoal = Object.values(goals).find((g) => g.roomId === roomId && (g.status === "running" || g.status === "planning" || g.status === "paused"));
  const reviewing = activeGoal?.status === "awaiting_approval";
  const steering = !dmAgent && !!activeGoal && !reviewing;
  const placeholder = dmAgent ? `Message ${dmAgent.name}`
    : reviewing ? "Say what to change in the plan, or \"approve\"…"
    : steering ? "Steer the work, ask how it's going, or @tag an agent…" : `Message ${room?.name ?? "the room"}`;

  const header = (
    <View style={{ height: 58, flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(4), borderBottomWidth: 1, borderColor: p.line }}>
      {onBack ? <IconButton glyph="‹" label="Back" onPress={onBack} /> : null}
      {dmAgent ? <Avatar name={dmAgent.name} color={dmAgent.color} glyph={dmAgent.avatar} size={24} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[t.heading, { color: p.inkStrong, fontSize: 17 }]}>{dmAgent ? dmAgent.name : room?.name ?? ""}</Text>
        <Text numberOfLines={1} style={[t.tiny, { color: p.muted }]}>
          {dmAgent ? (s.statuses[dmAgent.id]?.detail ?? "") : room?.topic ?? "Give the room a goal, or @mention an agent"}
        </Text>
      </View>
      {!dmAgent ? (
        <Pressable onPress={() => s.openPage("agents")} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space(1.5), paddingVertical: 3, borderRadius: radius.md, borderWidth: 1, borderColor: p.line }}>
          {members.slice(0, 4).map((a, i) => (
            <View key={a.id} style={{ marginLeft: i ? -6 : 0, borderRadius: 6, borderWidth: 2, borderColor: p.canvas }}><Avatar name={a.name} color={a.color} glyph={a.avatar} size={20} /></View>
          ))}
          <Text style={[t.small, { color: p.ink, marginLeft: space(1.5), fontWeight: "600" }]}>{members.length}</Text>
        </Pressable>
      ) : null}
      {room && !dmAgent && room.paused ? <IconButton glyph="▶ Resume" label="Resume" onPress={() => hub?.pause(room.id, false)} /> : null}
      {room && !dmAgent && !room.paused ? <IconButton glyph="❚❚" label="Pause" onPress={() => hub?.pause(room.id, true)} /> : null}
      {busy.length && room ? <IconButton glyph="■ Stop" label="Stop all work" onPress={() => hub?.stop(room.id)} /> : null}
      <IconButton glyph="ⓘ" label="Activity" active={details} onPress={() => setDetails(!details)} badge={log.length || undefined} />
    </View>
  );

  const intro = (
    <View style={{ paddingHorizontal: space(5), paddingTop: space(8), paddingBottom: space(4), gap: space(2) }}>
      {dmAgent ? <Avatar name={dmAgent.name} color={dmAgent.color} glyph={dmAgent.avatar} size={64} /> : null}
      <Text style={[t.title, { color: p.inkStrong }]}>{dmAgent ? dmAgent.name : room?.name ?? ""}</Text>
      <Text style={[t.body, { color: p.muted, maxWidth: 560 }]}>
        {dmAgent
          ? `This is your direct line to ${dmAgent.name}. Messages here go straight to it, with no routing.`
          : `This is the start of ${room?.name}. Describe a goal and the right agents pick it up; bigger jobs get split up behind the scenes. Type @ to talk to one agent directly.`}
      </Text>
    </View>
  );

  const chat = (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <GoalCard />
      {showJump ? (
        <Pressable onPress={jumpToNew} style={{ position: "absolute", top: space(2), alignSelf: "center", zIndex: 5, flexDirection: "row", gap: space(1.5),
          paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: 99, backgroundColor: p.accent, ...lift(0.12, 6, 2) }}>
          <Text style={[t.small, { color: p.onAccent, fontWeight: "600" }]}>↑ New messages</Text>
        </Pressable>
      ) : null}
      <FlatList ref={list} data={rows} keyExtractor={(r) => r.id} ListHeaderComponent={intro}
        style={{ opacity: shown === roomId || !rows.length ? 1 : 0 }}
        // Draw the whole loaded history (up to 200 messages) so "the end" is the real end.
        initialNumToRender={Math.max(20, rows.length)} maxToRenderPerBatch={50} windowSize={21}
        onContentSizeChange={onListSize}
        onScroll={(e) => { const n = e.nativeEvent; atBottom.current = n.contentSize.height - (n.contentOffset.y + n.layoutMeasurement.height) < 150; }}
        scrollEventThrottle={100}
        onScrollToIndexFailed={(info) => {
          // Rows have different heights; get close, let them render, then land exactly.
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0, animated: false }), 120);
        }}
        renderItem={({ item }) => item.kind === "day" ? <DayDivider at={item.at} /> : item.kind === "new" ? <NewDivider /> : (
          <View>
            <MessageRow m={item.m} grouped={item.grouped} mentionNames={mentionNames}
              color={item.m.author.kind === "human" ? undefined : agents.find((a) => a.id === item.m.author.id)?.color}
              glyph={item.m.author.kind === "human" ? undefined : agents.find((a) => a.id === item.m.author.id)?.avatar}
              onAuthor={(id) => void s.openDm(id)} />
            {chipIds.has(item.m.id) ? <TaskVerdict taskId={chipIds.get(item.m.id)!} /> : null}
            {item.m.planGoalId && goals[item.m.planGoalId]?.status === "awaiting_approval" ? (
              <View style={{ flexDirection: "row", gap: space(2), paddingLeft: space(5) + 28 + space(2.5), paddingBottom: space(2) }}>
                <Button small label="Approve and start" onPress={() => void hub?.decidePlan(item.m.planGoalId!, "approve").catch((e) => s.setError((e as Error).message))} />
                <Button small kind="plain" label="Change it…" onPress={() => { setText(""); input.current?.focus(); }} />
                <Button small kind="ghost" label="Cancel" onPress={() => void hub?.decidePlan(item.m.planGoalId!, "cancel").catch((e) => s.setError((e as Error).message))} />
              </View>
            ) : null}
          </View>
        )}
        contentContainerStyle={{ paddingBottom: space(3) }} />

      {pending ? (
        <View style={{ marginHorizontal: space(5), marginBottom: space(2), padding: space(3), borderRadius: radius.lg, backgroundColor: p.surface, borderWidth: 1, borderColor: p.line, gap: space(2) }}>
          <Text style={[t.small, { color: p.ink }]}>Quick check: how good was "{pending.title}"? This tunes how work gets routed.</Text>
          <View style={{ flexDirection: "row", gap: space(2) }}>
            <Button small kind="plain" label="Good" onPress={() => rate(pending.id, 0.9)} />
            <Button small kind="plain" label="Okay" onPress={() => rate(pending.id, 0.6)} />
            <Button small kind="plain" label="Poor" onPress={() => rate(pending.id, 0.2)} />
            <Button small kind="ghost" label="Skip" onPress={() => useRoom.setState((st) => ({ calibration: st.calibration.slice(1) }))} />
          </View>
        </View>
      ) : null}

      <View style={{ paddingHorizontal: space(5), paddingBottom: space(1) }}>
        {cmdQuery !== undefined && cmdGroups ? (
          <ScrollView keyboardShouldPersistTaps="handled" accessibilityLabel="Commands"
            style={{ maxHeight: 260, marginBottom: space(1), borderRadius: radius.lg, borderWidth: 1, borderColor: p.line, backgroundColor: p.canvas, ...lift(0.1, 12, 4) }}>
            {cmdRows.length ? cmdRows.map(({ group, row }, i) => (
              <View key={row.name}>
                {i === 0 || cmdRows[i - 1].group !== group ? <Text style={[t.tiny, { color: p.muted, fontWeight: "700", paddingHorizontal: space(3), paddingTop: space(2) }]}>{group.toUpperCase()}</Text> : null}
                <Pressable accessibilityRole="button" accessibilityLabel={`/${row.name}`} onPress={() => pickCommand(row.name)}
                  style={{ paddingHorizontal: space(3), paddingVertical: space(1.5), backgroundColor: row.name === cmdSel?.name ? p.tint : "transparent" }}>
                  <Text style={[t.small, t.name, { color: p.inkStrong }]}>/{row.name}{row.argsHint ? <Text style={{ color: p.faint }}> {row.argsHint}</Text> : null}</Text>
                  <Text numberOfLines={1} style={[t.tiny, { color: p.muted }]}>{row.description}</Text>
                </Pressable>
              </View>
            )) : <Text style={[t.tiny, { color: p.muted, padding: space(3) }]}>No commands match.</Text>}
          </ScrollView>
        ) : null}
        {suggestions.length ? (
          <View style={{ marginBottom: space(1), borderRadius: radius.lg, borderWidth: 1, borderColor: p.line, backgroundColor: p.canvas, paddingVertical: space(1), ...lift(0.1, 12, 4) }}>
            {suggestions.map((a, i) => (
              <Pressable key={a.id} onPress={() => pickMention(a.id)}
                style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(3), paddingVertical: space(1.5), backgroundColor: i === 0 ? p.tint : "transparent" }}>
                <Avatar name={a.name} color={a.color} glyph={a.avatar} size={20} />
                <Text style={[t.small, t.name, { color: p.inkStrong }]}>{a.name}</Text>
                <Dot state={presence(s, a.id)} size={7} />
                <Text style={[t.tiny, { color: i === 0 ? p.inkStrong : p.faint }]}>@{a.id}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {/* The composer is the one raised surface on the page. */}
        <View {...({ keyDownEvents: [{ key: "ArrowDown" }, { key: "ArrowUp" }, { key: "Escape" }], onKeyDown: cmdKey } as object)}
          style={{ borderWidth: 1, borderColor: text ? p.accent : p.lineStrong, borderRadius: radius.lg, backgroundColor: p.canvas, ...lift(0.07, 10, 2) }}>
          <TextInput ref={input} value={text} onChangeText={onTextChange} multiline placeholder={room?.paused ? `${placeholder} (paused)` : placeholder}
            placeholderTextColor={p.faint} accessibilityLabel="Message"
            onContentSizeChange={(e) => setHeight(Math.min(160, Math.max(22, e.nativeEvent.contentSize.height)))}
            onSubmitEditing={send}
            {...({ submitBehavior: "submit", submitKeyEvents: [{ key: "Enter" }] } as object)}
            style={[t.body, { color: p.ink, paddingHorizontal: space(3), paddingTop: space(2.5), paddingBottom: space(1), minHeight: 22, height: height + space(3.5) }]} />
          {pickOpen && !dmAgent && !steering && !reviewing && grants.length ? (
            <View style={{ paddingHorizontal: space(3), paddingBottom: space(2), gap: space(1.5) }}>
              <Text style={[t.tiny, { color: p.muted }]}>Agents work on a copy of the folder.{folder && folder.write ? " What they change comes back to you as a change to approve." : " It is read only, so nothing is written back."}</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1.5) }}>
                {[{ id: "", name: "No folder" }, ...grants.map((g) => ({ id: g.id, name: `${folderName(g)}${g.write ? "" : " (read only)"}` }))].map((o) => {
                  const on = o.id === folderId;
                  return (
                    <Pressable key={o.id || "none"} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => { setFolderId(o.id); setPickOpen(false); }}
                      style={{ paddingHorizontal: space(3), paddingVertical: space(1), borderRadius: 99, borderWidth: 1, borderColor: on ? p.accent : p.lineStrong, backgroundColor: on ? p.tint : "transparent" }}>
                      <Text style={[t.tiny, { color: on ? p.accent : p.ink, fontWeight: on ? "700" : "400" }]}>{o.name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space(2), paddingBottom: space(1.5), gap: space(1) }}>
            {!dmAgent ? <IconButton glyph="@" label="Mention an agent" onPress={() => { setText(`${text}${text && !text.endsWith(" ") ? " " : ""}@`); input.current?.focus(); }} /> : null}
            {!dmAgent && !steering && !reviewing && grants.length ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Work in folder" accessibilityState={{ expanded: pickOpen }} onPress={() => setPickOpen((o) => !o)}
                style={{ paddingHorizontal: space(2), paddingVertical: 2, borderRadius: radius.sm, borderWidth: 1, borderColor: folder ? p.accent : p.line, backgroundColor: folder ? p.tint : "transparent" }}>
                <Text style={[t.tiny, { color: folder ? p.accent : p.muted, fontWeight: folder ? "700" : "400" }]}>{folder ? `In folder: ${folderName(folder)}` : "Work in folder"}</Text>
              </Pressable>
            ) : null}
            {steering ? (
              <View style={{ flexDirection: "row", gap: space(1), flex: 1, marginLeft: space(1) }}>
                {[["/redirect ", "Redirect", "Restart the work in progress with a change"], ["/replan ", "Change direction", "Keep what's finished and replan the rest"], ["/stop", "Stop", "Stop all work in this room"]].map(([cmd, label, hint]) => (
                  <Pressable key={cmd} accessibilityLabel={hint} onPress={() => { setText(cmd + text.replace(/^\/(redirect|replan|stop)\s*/i, "")); input.current?.focus(); }}
                    style={{ paddingHorizontal: space(2), paddingVertical: 2, borderRadius: radius.sm, borderWidth: 1, borderColor: p.line }}>
                    <Text style={[t.tiny, { color: p.muted }]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text style={[t.tiny, { color: p.faint, flex: 1, marginLeft: space(1) }]}>{Platform.OS === ("macos" as string) ? "Return to send, Shift+Return for a new line" : ""}</Text>
            )}
            <Pressable onPress={send} disabled={!text.trim()} accessibilityLabel="Send"
              style={{ width: 32, height: 28, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: text.trim() ? p.accent : "transparent" }}>
              <Text style={{ color: text.trim() ? p.onAccent : p.faint, fontSize: 15, fontWeight: "700" }}>↑</Text>
            </Pressable>
          </View>
        </View>
        <Text style={[t.tiny, { color: p.muted, height: 18, marginTop: 3 }]}>{typing}</Text>
      </View>
    </KeyboardAvoidingView>
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      {header}
      <View style={{ flex: 1, flexDirection: "row" }}>
        {details && !wide && width < 700 ? null : <View style={{ flex: 1 }}>{chat}</View>}
        {details ? (
          <View style={{ width: width < 700 ? "100%" : 340, borderLeftWidth: 1, borderColor: p.line, backgroundColor: p.canvas }}>
            <Activity log={log} onClose={() => setDetails(false)} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Right-hand pane: what's being worked on and the behind-the-scenes coordination log. */
function Activity({ log, onClose }: { log: Message[]; onClose: () => void }) {
  const p = usePalette();
  const { tasks, goals, agents, hub } = useRoom(useShallow((s) => ({ tasks: s.tasks, goals: s.goals, agents: s.agents, hub: s.hub })));
  const goal = Object.values(goals).sort((a, b) => b.createdAt - a.createdAt)[0];
  const [files, setFiles] = useState<string[]>([]);
  const doneCount = Object.values(tasks).filter((x) => x.goalId === goal?.id && x.status === "done").length;
  useEffect(() => {
    if (!goal?.folder || !hub) { setFiles([]); return; }
    hub.goalFiles(goal.id).then((r) => setFiles(r.files)).catch(() => setFiles([]));
  }, [goal?.id, goal?.folder, doneCount, hub]);
  const list = Object.values(tasks).filter((x) => x.goalId === goal?.id).sort((a, b) => a.createdAt - b.createdAt);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ height: 58, flexDirection: "row", alignItems: "center", paddingHorizontal: space(4), borderBottomWidth: 1, borderColor: p.line }}>
        <Text style={[t.heading, { color: p.inkStrong, flex: 1 }]}>Activity</Text>
        <IconButton glyph="✕" label="Close" onPress={onClose} />
      </View>
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(5) }}>
        <View style={{ gap: space(2) }}>
          <Text style={[t.heading, { color: p.inkStrong }]}>Current work</Text>
          {goal ? <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]} numberOfLines={3}>{goal.contract?.objective ?? goal.text}</Text>
            : <Text style={[t.small, { color: p.muted }]}>Nothing running.</Text>}
          {goal?.state?.waitingOnOwner ? (
            <View style={{ backgroundColor: p.warnBg, borderRadius: radius.md, padding: space(3), gap: 2 }}>
              <Text style={[t.small, { color: p.warn, fontWeight: "600" }]}>Waiting on you</Text>
              <Text selectable style={[t.small, { color: p.ink }]}>{goal.state.waitingOnOwner}</Text>
              <Text style={[t.tiny, { color: p.muted }]}>Reply in the room and the work picks back up.</Text>
            </View>
          ) : goal?.state?.nextAction ? <Text style={[t.tiny, { color: p.muted }]}>Next: {goal.state.nextAction}</Text> : null}
          {goal?.state?.progress ? (
            <Text style={[t.tiny, { color: p.faint }]}>
              {goal.state.progress.runs} task run{goal.state.progress.runs === 1 ? "" : "s"}
              {goal.state.progress.goalReplans ? `, ${goal.state.progress.goalReplans} recovery replan${goal.state.progress.goalReplans === 1 ? "" : "s"}` : ""}
              {goal.state.progress.verifyRounds ? `, final check run ${goal.state.progress.verifyRounds}×` : ""}
              {goal.state.progress.stall > 1 ? `, ${goal.state.progress.stall} reviews without progress` : ""}
            </Text>
          ) : null}
          {goal?.contract?.requirements?.length ? (
            <View style={{ gap: 2, marginTop: space(1) }}>
              <Text style={[t.small, { color: p.muted, fontWeight: "600" }]}>Done means</Text>
              {goal.contract.requirements.map((r) => (
                <Text key={r.id} style={[t.tiny, { color: r.status === "met" ? p.ok : r.status === "unmet" ? p.danger : p.ink }]} numberOfLines={3}>
                  {r.status === "met" ? "✓" : r.status === "unmet" ? "✗" : "○"} {r.text}{r.status === "unmet" && r.evidence ? ` — ${r.evidence}` : ""}
                </Text>
              ))}
            </View>
          ) : null}
          {list.map((task) => {
            const a = agents.find((x) => x.id === (task.assignee ?? task.owner));
            const checks = task.criteria ?? [];
            const verdict = (id: string) => task.judgment?.criteria?.[id]?.verdict ?? task.report?.criteria[id]?.verdict;
            const color = task.status === "failed" ? p.danger : task.status === "done" ? p.ok : task.status === "waiting" ? p.warn : p.muted;
            return (
              <View key={task.id} style={{ flexDirection: "row", gap: space(2), alignItems: "flex-start" }}>
                {a ? <Avatar name={a.name} color={a.color} glyph={a.avatar} size={18} /> : <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: p.line }} />}
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[t.small, { color: p.ink }]}>{task.title}</Text>
                  <Text style={[t.tiny, { color }]}>
                    {STATUS[task.status]}{a ? ` · ${task.assignee ? "" : "for "}${a.name}` : ""}{(() => { const pr = a?.profiles?.find((x) => x.id === task.profileId); return pr ? ` (${pr.label})` : task.role && task.role !== "worker" ? ` as ${task.role}` : ""; })()}{task.attempts > 1 ? ` · try ${task.attempts}` : ""}{task.replans ? " · replanned" : ""}{task.origin === "verify" ? " · from final check" : task.origin === "recovery" ? " · replacement" : ""}{task.recovered && task.status !== "done" ? " · routed around" : ""}
                  </Text>
                  {checks.map((c) => {
                    const v = verdict(c.id);
                    const unverified = task.flagged?.includes(c.id);
                    return (
                      <Text key={c.id} style={[t.tiny, { color: unverified ? p.warn : v === "PASS" ? p.ok : v === "FAIL" ? p.danger : p.faint }]} numberOfLines={2}>
                        {unverified ? "?" : v === "PASS" ? "✓" : v === "FAIL" ? "✗" : "○"} {c.text}{c.check ? " ⚙︎" : ""}{unverified ? " (couldn't be verified)" : ""}
                      </Text>
                    );
                  })}
                  <JuryChips jury={task.judgment?.jury} />
                  {task.drift?.length ? <Text style={[t.tiny, { color: p.warn }]} numberOfLines={3}>⚠︎ {task.drift[task.drift.length - 1]}</Text> : null}
                </View>
              </View>
            );
          })}
          {goal?.state?.gate ? (
            <Text style={[t.tiny, { color: goal.state.gate.passed ? p.ok : p.danger, fontWeight: "700" }]}>
              {goal.state.gate.passed ? "✓ " : "⚠︎ "}{goal.state.gate.lines.filter((l) => l.verdict === "PASS").length} of {goal.state.gate.lines.length} checks passed
            </Text>
          ) : null}
        </View>
        {goal?.folder ? (
          <View style={{ gap: space(1) }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={[t.heading, { color: p.inkStrong, flex: 1 }]}>Shared files</Text>
              {Platform.OS === ("macos" as string) ? <Button small kind="ghost" label="Show in Finder" onPress={() => void hub?.revealGoal(goal.id)} /> : null}
            </View>
            {files.length ? files.slice(0, 30).map((f) => <Text key={f} selectable style={[t.tiny, { color: p.ink, fontFamily: "Menlo" }]}>{f}</Text>)
              : <Text style={[t.small, { color: p.muted }]}>Nothing saved yet. Files the agents produce show up here.</Text>}
          </View>
        ) : null}
        {goal?.contract ? (
          <View style={{ gap: space(1) }}>
            <Text style={[t.heading, { color: p.inkStrong }]}>Work contract <Text style={[t.tiny, { color: p.faint }]}>version {goal.contract.version}</Text></Text>
            {goal.contract.constraints.map((c, i) => <Text key={`c${i}`} style={[t.small, { color: p.ink }]}>• {c}</Text>)}
            {goal.contract.outOfScope.length ? <Text style={[t.tiny, { color: p.muted }]}>Out of scope: {goal.contract.outOfScope.join("; ")}</Text> : null}
            {[...(goal.contract.decisions ?? []), ...(goal.state?.shared ?? []).map((d) => d.text)].map((d, i) => <Text key={`d${i}`} style={[t.tiny, { color: p.ink }]}>◆ {d}</Text>)}
            {goal.contract.amendments.map((m, i) => <Text key={`m${i}`} style={[t.tiny, { color: p.ink, fontStyle: "italic" }]}>You added: {m.text}</Text>)}
          </View>
        ) : null}
        <View style={{ gap: space(2) }}>
          <Text style={[t.heading, { color: p.inkStrong }]}>Coordination log</Text>
          {log.length ? log.slice(-60).reverse().map((m) => (
            <View key={m.id} style={{ gap: 1 }}>
              <Text style={[t.tiny, { color: p.faint }]}>{new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Text>
              <Text selectable style={[t.small, { color: p.muted }]}>{m.text}</Text>
            </View>
          )) : <Text style={[t.small, { color: p.muted }]}>Routing and quality checks show up here, out of the way of the conversation.</Text>}
        </View>
      </ScrollView>
    </View>
  );
}

function NewDivider() {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(5), paddingVertical: space(2) }}>
      <View style={{ flex: 1, height: 1, backgroundColor: p.accent }} />
      <Text style={[t.tiny, { color: p.accent, fontWeight: "700" }]}>New</Text>
    </View>
  );
}
