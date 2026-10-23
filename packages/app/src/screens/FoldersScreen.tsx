import { useShallow } from "zustand/react/shallow";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { FolderGrant, WriteProposal } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Button, Empty, Field, Screen, Section, Toggle } from "../components/ui";
import { launcher } from "../native/hub";
import { radius, space, type as t, usePalette } from "../theme";

/** One row of choices where exactly one is picked (rooms, agents). Wraps, so many rooms still fit. */
function Choice({ label, options, value, onChange }: { label: string; options: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  const p = usePalette();
  return (
    <View style={{ gap: space(1.5), marginBottom: space(4) }}>
      <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1.5) }}>
        {options.map((o) => {
          const on = o.id === value;
          return (
            <Pressable key={o.id} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => onChange(o.id)}
              style={{ paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: 99, borderWidth: 1, borderColor: on ? p.accent : p.lineStrong, backgroundColor: on ? p.tint : "transparent" }}>
              <Text style={[t.small, { color: on ? p.accent : p.ink, fontWeight: on ? "700" : "400" }]}>{o.name}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

type Ask = { id: string; kind: "remove" } | { id: string; kind: "read" | "write"; value: boolean };

export function FoldersScreen() {
  const p = usePalette();
  const { hub, rooms, agents } = useRoom(useShallow((s) => ({ hub: s.hub, rooms: s.rooms, agents: s.agents })));
  const [grants, setGrants] = useState<FolderGrant[] | undefined>();
  const [proposals, setProposals] = useState<WriteProposal[]>([]);
  const [loadError, setLoadError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [ask, setAsk] = useState<Ask | undefined>();

  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [roomId, setRoomId] = useState("");
  const [agentId, setAgentId] = useState("*");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);   // writes are off until the owner turns them on
  const [formError, setFormError] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!hub) return;
    try {
      const [g, pr] = await Promise.all([hub.folderGrants(), hub.writeProposals().catch(() => [] as WriteProposal[])]);
      setGrants(g); setProposals(pr); setLoadError("");
    } catch (e) { setLoadError((e as Error).message); setGrants((cur) => cur ?? []); }
  }, [hub]);
  useEffect(() => { void load(); }, [load]);

  const roomName = (id?: string) => (!id ? "All rooms" : rooms.find((r) => r.id === id)?.name ?? "A room that was deleted");
  const agentName = (id: string) => (id === "*" ? "Any agent" : agents.find((a) => a.id === id)?.name ?? id);
  const pendingFor = (g: FolderGrant) => proposals.filter((x) => x.grantId === g.id && x.status === "pending").length;
  const sorted = [...(grants ?? [])].sort((a, b) => a.path.localeCompare(b.path) || (a.roomId ?? "").localeCompare(b.roomId ?? "") || a.agentId.localeCompare(b.agentId) || a.createdAt - b.createdAt);

  // The hub has no "edit" for a grant, so a switch adds the changed grant first and then removes the old one.
  // Writes the agent had waiting from the old grant are dropped; it can ask again.
  const setAccess = async (g: FolderGrant, key: "read" | "write", value: boolean) => {
    if (!hub) return;
    const next = { read: g.read, write: g.write, [key]: value };
    if (!next.read && !next.write) { setNote("A folder needs Read or Write. Remove it to stop all access."); return; }
    setBusy(g.id); setNote(""); setAsk(undefined);
    try {
      const added = await hub.addFolderGrant({ path: g.path, label: g.label, roomId: g.roomId, agentId: g.agentId, ...next });
      try { await hub.removeFolderGrant(g.id); } catch (e) { await hub.removeFolderGrant(added.id).catch(() => {}); throw e; }
      await load();
    } catch (e) { setNote((e as Error).message); } finally { setBusy(undefined); }
  };
  const remove = async (g: FolderGrant) => {
    if (!hub) return;
    setBusy(g.id); setNote(""); setAsk(undefined);
    try { await hub.removeFolderGrant(g.id); await load(); } catch (e) { setNote((e as Error).message); } finally { setBusy(undefined); }
  };
  const toggle = (g: FolderGrant, key: "read" | "write", value: boolean) => {
    if (pendingFor(g) > 0) setAsk({ id: g.id, kind: key, value }); else void setAccess(g, key, value);
  };

  const choose = async () => {
    try { const picked = await launcher?.chooseFolder?.(); if (picked) { setPath(picked); setFormError(""); } }
    catch (e) { setFormError((e as Error).message); }
  };
  const add = async () => {
    if (!hub) return;
    if (!path.trim()) { setFormError("Type the folder's full path, like /Users/you/Documents/notes."); return; }
    if (!read && !write) { setFormError("Turn on Read, Write or both."); return; }
    setAdding(true); setFormError("");
    try {
      await hub.addFolderGrant({ path: path.trim(), label: label.trim() || undefined, roomId: roomId || undefined, agentId, read, write });
      setPath(""); setLabel(""); setRoomId(""); setAgentId("*"); setRead(true); setWrite(false);
      await load();
    } catch (e) { const m = (e as Error).message; setFormError(m.charAt(0).toUpperCase() + m.slice(1)); }   // the hub says why a folder can't be shared (home folder, credentials, not found)
    finally { setAdding(false); }
  };

  const plural = (n: number) => `${n} change${n === 1 ? " is" : "s are"}`;
  return (
    <Screen title="Folders" subtitle="Files on this Mac that agents can use">
      <ScrollView contentContainerStyle={{ padding: space(4) }} keyboardShouldPersistTaps="handled">
        <Text style={[t.body, { color: p.muted, marginBottom: space(5) }]}>Agents can read files here. Writes always come to you as changes to approve.</Text>
        {loadError ? <Text style={[t.small, { color: p.danger, marginBottom: space(3) }]}>Can't load folders: {loadError}</Text> : null}
        {note ? <Text style={[t.small, { color: p.danger, marginBottom: space(3) }]}>{note}</Text> : null}

        {grants && !sorted.length ? <Empty text="No folders yet. Agents can't see any files until you add one." /> : null}
        {sorted.map((g) => {
          const pending = pendingFor(g);
          const name = g.label || g.path.split("/").filter(Boolean).pop() || g.path;
          const asked = ask && ask.id === g.id ? ask : undefined;
          return (
            <Section key={g.id} title={name}>
              <View style={{ paddingHorizontal: space(4), paddingVertical: space(3), gap: space(1), borderBottomWidth: 1, borderColor: p.line }}>
                <Text selectable style={[t.mono, { color: p.ink }]}>{g.path}</Text>
                <Text style={[t.small, { color: p.muted }]}>{roomName(g.roomId)} · {agentName(g.agentId)}</Text>
              </View>
              <Toggle label="Read" hint="Agents can look at files here." value={g.read} onChange={(v) => busy ? undefined : toggle(g, "read", v)} />
              <Toggle label="Write" hint="Writes always come to you as changes to approve." value={g.write} onChange={(v) => busy ? undefined : toggle(g, "write", v)} />
              <View style={{ padding: space(3), gap: space(2) }}>
                {asked ? (
                  <>
                    <Text style={[t.small, { color: p.warn }]}>
                      {asked.kind === "remove" ? "Agents lose access right away." : `${plural(pending)} waiting for your approval from this folder. Changing this drops ${pending === 1 ? "it" : "them"}, and the agent can ask again.`}
                      {asked.kind === "remove" && pending ? ` ${plural(pending)} waiting for approval and will be dropped.` : ""}
                    </Text>
                    <View style={{ flexDirection: "row", gap: space(2) }}>
                      <Button small kind={asked.kind === "remove" ? "danger" : "primary"} label={asked.kind === "remove" ? "Remove folder" : "Continue"}
                        onPress={() => void (asked.kind === "remove" ? remove(g) : setAccess(g, asked.kind, asked.value))} />
                      <Button small kind="plain" label="Keep it" onPress={() => setAsk(undefined)} />
                    </View>
                  </>
                ) : (
                  <View style={{ flexDirection: "row" }}>
                    <Button small kind="plain" label="Remove" disabled={busy === g.id} onPress={() => setAsk({ id: g.id, kind: "remove" })} />
                  </View>
                )}
              </View>
            </Section>
          );
        })}

        <Section title="Add a folder" hint="Pick who can use it and what they can do.">
          <View style={{ padding: space(4) }}>
            <Field label="Folder on this Mac" value={path} onChangeText={(v) => { setPath(v); setFormError(""); }} placeholder="/Users/you/Documents/notes"
              autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => void add()}
              hint={launcher?.chooseFolder ? undefined : "Type the full path. The Choose button isn't available in this build."} />
            {launcher?.chooseFolder ? <View style={{ flexDirection: "row", marginTop: -space(2), marginBottom: space(4) }}><Button small kind="plain" label="Choose…" onPress={() => void choose()} /></View> : null}
            <Field label="Name (optional)" value={label} onChangeText={setLabel} maxLength={80} placeholder="Notes" />
            <Choice label="Room" value={roomId} onChange={setRoomId} options={[{ id: "", name: "All rooms" }, ...rooms.map((r) => ({ id: r.id, name: r.dmAgentId ? agentName(r.dmAgentId) : `# ${r.name}` }))]} />
            <Choice label="Agent" value={agentId} onChange={setAgentId} options={[{ id: "*", name: "Any agent" }, ...agents.map((a) => ({ id: a.id, name: a.name }))]} />
            <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, overflow: "hidden", marginBottom: space(4) }}>
              <Toggle label="Read" hint="Agents can look at files here." value={read} onChange={setRead} />
              <Toggle label="Write" hint="Agents can propose changes. Writes always come to you as changes to approve." value={write} onChange={setWrite} />
            </View>
            {formError ? <Text style={[t.small, { color: p.danger, marginBottom: space(3) }]}>{formError}</Text> : null}
            <View style={{ flexDirection: "row" }}><Button label={adding ? "Adding…" : "Add folder"} disabled={adding || !path.trim()} onPress={() => void add()} /></View>
          </View>
        </Section>
      </ScrollView>
    </Screen>
  );
}
