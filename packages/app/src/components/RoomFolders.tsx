import { useShallow } from "zustand/react/shallow";
import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { FolderGrant } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { launcher } from "../native/hub";
import { Button, Field, Toggle } from "./ui";
import { radius, space, type as t, usePalette } from "../theme";

const nameOf = (g: FolderGrant) => g.label || g.path.split("/").filter(Boolean).pop() || g.path;
const cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

/**
 * Room folders: the folders this room's goals can work on, and which one is the default. "Add folder…" opens the Mac's chooser and
 * grants the folder to this room (every agent, read; write only if the switch is on). The first folder added becomes the default.
 * Agents work on a copy of a folder, and writes always come back as changes to approve.
 */
export function RoomFolders({ roomId }: { roomId: string }) {
  const p = usePalette();
  const { hub, room } = useRoom(useShallow((s) => ({ hub: s.hub, room: s.rooms.find((r) => r.id === roomId) })));
  const defaultId = room?.folderGrantId;
  const [grants, setGrants] = useState<FolderGrant[] | undefined>();
  const [write, setWrite] = useState(false);          // writes are off until the owner turns them on
  const [path, setPath] = useState("");               // typed path, only when the Mac's chooser isn't in this build
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | undefined>(); // grant id waiting for "Remove folder"
  // A folder the hub normally refuses (credentials, settings, system) can still be shared on purpose, with a written reason.
  const [override, setOverride] = useState<{ path: string; because?: string; reason: string } | undefined>();

  const load = useCallback(async () => {
    if (!hub) return;
    try { setGrants(await hub.folderGrants()); } catch (e) { setErr((e as Error).message); setGrants((cur) => cur ?? []); }
  }, [hub]);
  useEffect(() => { setGrants(undefined); setErr(""); setOverride(undefined); setConfirm(undefined); void load(); }, [load, roomId]);

  // This room's own folders and the ones open to every room. A grant for one agent only is listed, but can't carry a goal.
  const mine = (grants ?? []).filter((g) => !g.roomId || g.roomId === roomId).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const usable = (g: FolderGrant) => g.agentId === "*" && g.read;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); await load(); } catch (e) { setErr(cap((e as Error).message)); } finally { setBusy(false); }
  };

  const makeDefault = (g: FolderGrant) => run(async () => { await hub?.updateRoom(roomId, { folderGrantId: g.id }); });
  const removeFromRoom = (g: FolderGrant) => run(async () => {
    setConfirm(undefined);
    if (g.roomId === roomId) await hub?.removeFolderGrant(g.id);              // this room's own grant: gone for everyone
    else if (g.id === defaultId) await hub?.updateRoom(roomId, { folderGrantId: null }); // an all-rooms grant stays; only the default clears
  });

  /** Check first (POST /folder-grants/check), grant it to this room, and make it the default if the room has none. */
  const add = async (picked: string, force?: { reason: string }) => {
    if (!hub || !picked.trim()) { setErr("Type the folder's full path, like /Users/you/Documents/notes."); return; }
    setBusy(true); setErr("");
    try {
      if (!force) {
        const c = await hub.checkFolder(picked.trim());
        if (!c.ok) { setErr(cap(c.error)); setOverride(c.canForce ? { path: picked.trim(), reason: override?.reason ?? "" } : undefined); return; }
        if (c.protected) { setOverride({ path: picked.trim(), because: c.because, reason: override?.reason ?? "" }); return; }
      }
      const g = await hub.addFolderGrant({ path: picked.trim(), roomId, agentId: "*", read: true, write, ...(force ? { force: true, reason: force.reason.trim() } : {}) });
      if (!defaultId) await hub.updateRoom(roomId, { folderGrantId: g.id }); // the room's first folder is its default
      setPath(""); setOverride(undefined); setWrite(false);
      await load();
    } catch (e) {
      const x = e as Error & { canForce?: boolean; because?: string };
      setErr(cap(x.message)); // the hub says why a folder can't be shared (home folder, credentials, not found)
      setOverride(x.canForce ? { path: picked.trim(), because: x.because, reason: override?.reason ?? "" } : undefined);
    } finally { setBusy(false); }
  };
  const choose = async () => {
    try { const picked = await launcher?.chooseFolder?.(); if (picked) await add(picked); }
    catch (e) { setErr(cap((e as Error).message)); }
  };

  return (
    <View style={{ gap: space(2) }}>
      <Text style={[t.heading, { color: p.inkStrong }]}>Folders</Text>
      <Text style={[t.tiny, { color: p.muted }]}>Agents work on a copy of the room's default folder. Writes always come to you as changes to approve.</Text>
      {grants && !mine.length ? <Text style={[t.small, { color: p.muted }]}>No folders for this room yet.</Text> : null}
      {mine.map((g) => {
        const isDefault = g.id === defaultId;
        const own = g.roomId === roomId;
        return (
          <View key={g.id} style={{ gap: 2, paddingVertical: space(1.5), borderBottomWidth: 1, borderColor: p.line }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
              <Text numberOfLines={1} style={[t.small, { color: p.ink, fontWeight: "600", flexShrink: 1 }]}>{nameOf(g)}</Text>
              {isDefault ? <Text style={[t.tiny, { color: p.accent, fontWeight: "700" }]}>Default</Text> : null}
            </View>
            <Text selectable numberOfLines={2} style={[t.tiny, { color: p.muted, fontFamily: "Menlo" }]}>{g.path}</Text>
            <Text style={[t.tiny, { color: usable(g) ? p.muted : p.warn }]}>
              {g.agentId !== "*" ? "Open to one agent only, so a goal can't start on it. Change that in Folders." : !g.read ? "Not readable, so a goal can't start on it." : `${g.write ? "Agents can propose changes" : "Read only"} · ${own ? "This room only" : "Every room"}`}
            </Text>
            {confirm === g.id ? (
              <View style={{ gap: space(1.5), marginTop: space(1) }}>
                <Text style={[t.tiny, { color: p.warn }]}>Agents lose access to this folder right away.</Text>
                <View style={{ flexDirection: "row", gap: space(2) }}>
                  <Button small kind="danger" label="Remove folder" disabled={busy} onPress={() => void removeFromRoom(g)} />
                  <Button small kind="plain" label="Keep it" onPress={() => setConfirm(undefined)} />
                </View>
              </View>
            ) : (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2), marginTop: space(1) }}>
                {!isDefault && usable(g) ? <Button small kind="plain" label="Make default" disabled={busy} onPress={() => void makeDefault(g)} /> : null}
                {own ? <Button small kind="plain" label="Remove from room" disabled={busy} onPress={() => setConfirm(g.id)} />
                  : isDefault ? <Button small kind="plain" label="Remove from room" disabled={busy} onPress={() => void removeFromRoom(g)} /> : null}
              </View>
            )}
          </View>
        );
      })}

      <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, overflow: "hidden" }}>
        <Toggle label="Agents can propose changes" hint="For the next folder you add. Off means read only." value={write} onChange={setWrite} />
      </View>
      {launcher?.chooseFolder ? null : (
        <Field label="Folder on this Mac" value={path} onChangeText={(v) => { setPath(v); setErr(""); setOverride(undefined); }} placeholder="/Users/you/Documents/notes"
          autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => void add(path)} hint="Type the full path. The folder chooser isn't available in this build." />
      )}
      {override ? (
        <View style={{ gap: space(2), padding: space(3), borderWidth: 1, borderColor: p.warn, borderRadius: radius.lg }}>
          <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]}>{override.because ? `This folder is normally kept private: ${override.because}.` : "This folder is normally kept private."}</Text>
          <Text style={[t.tiny, { color: p.muted }]}>Share it only if you mean to. Say why, in a sentence. It goes in the audit log.</Text>
          <Field label="Why share it?" value={override.reason} onChangeText={(v) => setOverride({ ...override, reason: v })} placeholder="For example: my notes app keeps its files here" multiline />
          <View style={{ flexDirection: "row", gap: space(2) }}>
            <Button small kind="danger" label={busy ? "Adding…" : "Grant anyway"} disabled={busy || override.reason.trim().length < 8} onPress={() => void add(override.path, { reason: override.reason })} />
            <Button small kind="plain" label="Cancel" onPress={() => { setOverride(undefined); setErr(""); }} />
          </View>
          {override.reason.trim().length < 8 ? <Text style={[t.tiny, { color: p.faint }]}>At least 8 characters.</Text> : null}
        </View>
      ) : null}
      {err ? <Text accessibilityRole="alert" style={[t.small, { color: p.danger }]}>{err}</Text> : null}
      {override ? null : (
        <View style={{ flexDirection: "row" }}>
          <Button label={busy ? "Checking…" : "Add folder…"} disabled={busy || (!launcher?.chooseFolder && !path.trim())} onPress={() => void (launcher?.chooseFolder ? choose() : add(path))} />
        </View>
      )}
    </View>
  );
}
