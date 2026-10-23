import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { FirstPassMetrics } from "@agent-room/shared";
import type { Hub } from "../api/client";
import { space, type as t, usePalette } from "../theme";

/**
 * 2.1 First-pass acceptance by week: how often work was accepted on its first attempt. A stub of the Scorecard that 2.7 extends
 * (per agent and per task type are in the data already). The weeks before the phase started are drawn pale, as the baseline.
 */
const pct = (r: number | null) => (r === null ? "no work" : `${Math.round(r * 100)}%`);

export function FirstPass({ hub }: { hub?: Hub }) {
  const p = usePalette();
  const [m, setM] = useState<FirstPassMetrics>();
  useEffect(() => { hub?.firstPass(12).then(setM).catch(() => {}); }, [hub]);
  if (!m) return <Text style={[t.small, { color: p.muted, padding: space(4) }]}>Loading.</Text>;
  const total = m.overall.reduce((n, w) => n + w.tasks, 0);
  const s = m.sincePhase;
  return (
    <View style={{ padding: space(4), gap: space(2) }}>
      <Text style={[t.body, { color: p.ink }]}>
        {s.tasks ? `${pct(s.rate)} accepted first time since ${new Date(m.phaseStartedAt).toLocaleDateString()} (${s.accepted} of ${s.tasks} tasks), ${s.revisionsPerTask ?? 0} send-backs per task.` : `Counting from ${new Date(m.phaseStartedAt).toLocaleDateString()}. No finished work yet.`}
      </Text>
      {total ? (
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space(1), height: 64 }}>
          {m.overall.map((w) => (
            <View key={w.week} accessibilityLabel={`${w.week}: ${pct(w.rate)} of ${w.tasks} tasks`} style={{ flex: 1, height: 64, justifyContent: "flex-end" }}>
              <View style={{ height: w.rate === null ? 2 : Math.max(2, Math.round(w.rate * 64)), borderRadius: 2, backgroundColor: w.rate === null ? p.line : w.sincePhase ? p.accent : p.lineStrong }} />
            </View>
          ))}
        </View>
      ) : null}
      {total ? <Text style={[t.tiny, { color: p.muted }]}>Last {m.weeks} weeks, newest on the right. Pale bars are from before this started.</Text> : null}
    </View>
  );
}
