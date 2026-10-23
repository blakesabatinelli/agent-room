import { useShallow } from "zustand/react/shallow";
import React from "react";
import { ScrollView, Text, View } from "react-native";
import { useRoom } from "../state/store";
import { Resume } from "../components/Resume"; // 2.3
import { Avatar, Empty, Screen } from "../components/ui";
import { space, type as t, usePalette } from "../theme";

/** 3.1: every agent's résumé in one place: probation, what it is strong and weak at, and the switch for probation. */
export function ResumesScreen() {
  const p = usePalette();
  const agents = useRoom(useShallow((s) => s.agents));
  return (
    <Screen title="Résumés" subtitle="What each agent is good at, from graded work">
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(6) }}>
        {agents.length ? agents.map((a) => (
          <View key={a.id} style={{ gap: space(2) }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space(2.5) }}>
              <Avatar name={a.name} color={a.color} glyph={a.avatar} size={24} />
              <Text style={[t.heading, { color: p.inkStrong }]}>{a.name}</Text>
            </View>
            <Resume agentId={a.id} name={a.name} />
          </View>
        )) : <Empty text="No agents yet." />}
      </ScrollView>
    </Screen>
  );
}
