import { useShallow } from "zustand/react/shallow";
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Issue, IssuesResponse } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Button, Chip, Empty } from "../components/ui";
import { TracePanel } from "../components/TracePanel";
import { space, type as t, usePalette } from "../theme";

const stamp = (at: number) => `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })} ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

/** Recurring problems from the last 7 days, each with one next step, links to the traces behind it, and a Dismiss. A dismissed issue stays away until it happens again. */
export function IssuesScreen() {
  const p = usePalette();
  const { hub, setError } = useRoom(useShallow((s) => ({ hub: s.hub, setError: s.setError })));
  const [data, setData] = useState<IssuesResponse | undefined>();
  const [trace, setTrace] = useState<string | undefined>(); // the goal whose trace is open
  const load = useCallback(() => { hub?.issues().then(setData).catch((e: Error) => setError(e.message)); }, [hub, setError]);
  useEffect(load, [load]);

  const dismiss = async (i: Issue) => {
    try { await hub!.dismissIssue(i.id); load(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <View style={{ paddingHorizontal: space(5), paddingTop: space(4), paddingBottom: space(3), borderBottomWidth: 1, borderColor: p.line }}>
        <Text accessibilityRole="header" style={[t.heading, { color: p.inkStrong, fontSize: 18 }]}>Issues</Text>
        <Text style={[t.tiny, { color: p.muted, marginTop: 1 }]}>Problems that keep coming back, from the last {data?.days ?? 7} days. Dismiss one and it stays away until it happens again.</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(3) }}>
        {!data ? <Empty text="Loading…" /> : null}
        {data?.issues.map((i) => (
          <View key={i.id} style={{ borderWidth: 1, borderColor: p.line, borderRadius: 10, padding: space(3), gap: space(2), backgroundColor: p.surface }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), flexWrap: "wrap" }}>
              <Text selectable style={[t.body, { color: p.inkStrong, fontWeight: "700", flexShrink: 1 }]}>{i.title}</Text>
              {i.reappeared ? <Chip label="Back again" tone="warn" /> : null}
            </View>
            <Text style={[t.small, { color: p.muted }]}>First seen {stamp(i.firstSeen)}. Last seen {stamp(i.lastSeen)}.</Text>
            <View style={{ borderLeftWidth: 2, borderColor: p.line, paddingLeft: space(2.5), gap: 2 }}>
              <Text style={[t.small, { color: p.muted, fontWeight: "600" }]}>Next step</Text>
              <Text selectable style={[t.small, { color: p.ink }]}>{i.next}</Text>
            </View>
            {i.goals.length ? (
              <View style={{ gap: space(1.5) }}>
                <Text style={[t.small, { color: p.muted, fontWeight: "600" }]}>{i.goals.length === 1 ? "Goal" : "Goals"}</Text>
                {i.goals.map((g) => (
                  <View key={g.id} style={{ gap: space(1.5) }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
                      <Text numberOfLines={2} style={[t.small, { color: p.ink, flex: 1 }]}>{g.text}</Text>
                      <Button small kind="plain" label={trace === g.id ? "Hide trace" : "Trace"} onPress={() => setTrace(trace === g.id ? undefined : g.id)} />
                    </View>
                    {trace === g.id ? <TracePanel goalId={g.id} onClose={() => setTrace(undefined)} maxHeight={420} /> : null}
                  </View>
                ))}
              </View>
            ) : null}
            {i.tasks.length ? <Text style={[t.tiny, { color: p.muted }]}>Tasks: {i.tasks.map((x) => x.title).join(", ")}</Text> : null}
            <View style={{ flexDirection: "row" }}><Button small kind="plain" label="Dismiss" onPress={() => void dismiss(i)} /></View>
          </View>
        ))}
        {data && !data.issues.length ? <Empty text={data.dismissed ? "Nothing new. Dismissed issues show up again if they happen again." : "No recurring problems this week."} /> : null}
      </ScrollView>
    </View>
  );
}
