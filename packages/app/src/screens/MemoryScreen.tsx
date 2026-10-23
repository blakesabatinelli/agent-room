import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { MemoryEntry } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Button, Empty, Screen, Section } from "../components/ui";
import { space, type as t, usePalette } from "../theme";

export function MemoryScreen() {
  const p = usePalette();
  const { hub, roomId, proposals, agents } = useRoom(useShallow((s) => ({ hub: s.hub, roomId: s.roomId, proposals: s.proposals, agents: s.agents })));
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const refresh = () => { hub?.memory(roomId).then(setEntries).catch(() => {}); };
  useEffect(refresh, [hub, roomId, proposals.length]);
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  return (
    <Screen title="Shared memory" right={<Button kind="plain" label="Refresh" onPress={refresh} />}>
      <ScrollView contentContainerStyle={{ padding: space(4) }}>
        <Section title="Waiting for a decision">
          {!proposals.length ? <Empty text="The orchestrator decides most proposals itself. Ones it couldn't decide land here." /> : null}
          {proposals.map((pr) => (
            <View key={pr.id} style={{ padding: space(4), gap: space(2), borderBottomWidth: 1, borderColor: p.line }}>
              <Text style={[t.body, { color: p.ink }]}>{pr.text}</Text>
              <Text style={[t.small, { color: p.muted }]}>Suggested by {name(pr.sourceAgentId)}</Text>
              <View style={{ flexDirection: "row", gap: space(2) }}>
                <Button label="Keep" onPress={() => hub?.decideProposal(pr.id, true)} />
                <Button kind="plain" label="Discard" onPress={() => hub?.decideProposal(pr.id, false)} />
              </View>
            </View>
          ))}
        </Section>
        <Section title="What the room knows">
          {!entries.length ? <Empty text="Nothing yet. Agents suggest memories as they work; the orchestrator files the useful ones." /> : null}
          {entries.map((e) => (
            <View key={e.id} style={{ padding: space(4), gap: space(1), borderBottomWidth: 1, borderColor: p.line }}>
              <TextInput defaultValue={e.text} multiline style={[t.body, { color: p.ink }]}
                onEndEditing={(ev) => ev.nativeEvent.text !== e.text && hub?.editMemory(e.id, ev.nativeEvent.text)} accessibilityLabel="Memory entry" />
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={[t.small, { color: p.muted }]}>From {name(e.sourceAgentId)}{e.roomId ? "" : ", all rooms"}</Text>
                <Button kind="plain" label="Delete" onPress={async () => { await hub?.deleteMemory(e.id); refresh(); }} />
              </View>
            </View>
          ))}
        </Section>
      </ScrollView>
    </Screen>
  );
}
