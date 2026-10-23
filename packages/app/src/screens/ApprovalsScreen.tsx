import { useShallow } from "zustand/react/shallow";
import React from "react";
import { ScrollView, Text, View } from "react-native";
import { useRoom } from "../state/store";
import { Button, Empty, Screen, Strip } from "../components/ui";
import { space, type as t, usePalette } from "../theme";

export function ApprovalsScreen() {
  const p = usePalette();
  const { approvals, agents, hub } = useRoom(useShallow((s) => ({ approvals: s.approvals, agents: s.agents, hub: s.hub })));
  return (
    <Screen title="Approvals">
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(3) }}>
        {!approvals.length ? <Empty text="Nothing to approve. Agents ask here before sending email, posting to Slack, changing CRM records or running shell commands." /> : null}
        {approvals.map((a) => {
          const agent = agents.find((x) => x.id === a.agentId);
          return (
            <View key={a.id} style={{ flexDirection: "row", gap: space(3), padding: space(4), borderRadius: 12, backgroundColor: p.surface, borderWidth: 1, borderColor: p.line }}>
              <Strip color={agent?.color ?? p.muted} />
              <View style={{ flex: 1, gap: space(2) }}>
                <Text style={[t.heading, { color: p.ink }]}>{agent?.name ?? a.agentId} wants to use {a.tool}</Text>
                <Text style={[t.body, { color: p.ink }]}>{a.action}</Text>
                <Text selectable style={[t.small, { color: p.muted }]} numberOfLines={8}>{a.detail}</Text>
                <View style={{ flexDirection: "row", gap: space(2) }}>
                  <Button label="Approve" onPress={() => hub?.decide(a.id, "approved")} />
                  <Button kind="plain" label="Reject" onPress={() => hub?.decide(a.id, "rejected")} />
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </Screen>
  );
}
