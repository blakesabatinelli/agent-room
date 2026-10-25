import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { UsageLeftStatus } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { radius, space, type as t, usePalette } from "../theme";

/**
 * Simple by default: the live strip. A calm line above the conversation and the home that shows what is running right now,
 * approvals waiting, and each agent's usage left as a small dot chip. Tapping a chip opens that agent's windows. It is
 * glanceable, not a dashboard: when nothing is happening it is just the row of usage chips.
 */
const TONE: Record<UsageLeftStatus, "ok" | "warn" | "danger" | "muted"> = {
  plenty: "ok", unlimited: "ok", getting_low: "warn", almost_out: "danger", out: "danger", learning: "muted",
};

export function LiveStrip() {
  const p = usePalette();
  const s = useRoom(useShallow((s) => ({ usage: s.usage, working: s.working, approvals: s.approvals, agents: s.agents, openPage: s.openPage, loadUsage: s.loadUsage })));
  const [open, setOpen] = useState<string>(); // the agent whose windows are shown
  useEffect(() => { void s.loadUsage(); const id = setInterval(() => void s.loadUsage(), 60_000); return () => clearInterval(id); }, [s.loadUsage]);

  const running: { agentId: string; label: string }[] = [];
  for (const room of Object.values(s.working)) for (const [agentId, label] of Object.entries(room)) running.push({ agentId, label });
  const n = s.approvals.length;
  const agents = s.usage?.agents ?? [];
  if (!running.length && !n && !agents.length) return null;
  const dot = (tone: "ok" | "warn" | "danger" | "muted") => p[tone === "muted" ? "muted" : tone];
  const detail = agents.find((a) => a.agentId === open);

  return (
    <View style={{ borderBottomWidth: 1, borderColor: p.line, backgroundColor: p.canvas, paddingHorizontal: space(4), paddingVertical: space(2), gap: space(2) }}>
      {running.length ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space(2) }}>
          {running.slice(0, 3).map((r, i) => {
            const a = s.agents.find((x) => x.id === r.agentId);
            return (
              <View key={`${r.agentId}-${i}`} style={{ flexDirection: "row", alignItems: "center", gap: space(1.5) }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.accent }} />
                <Text style={[t.small, { color: p.muted }]} numberOfLines={1}>{a?.name ?? r.agentId}{r.label ? ` · ${r.label}` : " working"}</Text>
              </View>
            );
          })}
          {running.length > 3 ? <Text style={[t.small, { color: p.muted }]}>{`+${running.length - 3} more`}</Text> : null}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space(2) }}>
        {n ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${n} waiting to approve`} onPress={() => s.openPage("approvals")}
            style={{ flexDirection: "row", alignItems: "center", gap: space(1.5), paddingVertical: space(1), paddingHorizontal: space(2.5), borderRadius: 99, backgroundColor: p.warnBg }}>
            <Text style={[t.tiny, { color: p.warn, fontWeight: "700" }]}>{`${n} to approve`}</Text>
          </Pressable>
        ) : null}
        {agents.map((a) => {
          const tone = TONE[a.status];
          return (
            <Pressable key={a.agentId} accessibilityRole="button" accessibilityLabel={`${a.agentName}: ${a.statusText}`} onPress={() => setOpen(open === a.agentId ? undefined : a.agentId)}
              style={{ flexDirection: "row", alignItems: "center", gap: space(1.5), paddingVertical: space(1), paddingHorizontal: space(2.5), borderRadius: 99, borderWidth: 1, borderColor: open === a.agentId ? p.accent : p.line, backgroundColor: p.surface }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot(tone) }} />
              <Text style={[t.tiny, { color: p.inkStrong, fontWeight: "600" }]}>{a.agentName}</Text>
              <Text style={[t.tiny, { color: p.muted }]}>{a.statusText}</Text>
            </Pressable>
          );
        })}
      </View>

      {detail ? (
        <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.md, padding: space(3), gap: space(1), backgroundColor: p.surface }}>
          <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]}>{detail.agentName}</Text>
          {detail.subscriptions.length ? detail.subscriptions.map((sub) => (
            <View key={sub.subscriptionId} style={{ gap: 1, marginTop: space(1) }}>
              <Text style={[t.tiny, { color: p.ink }]}>{sub.name} · {sub.statusText}</Text>
              {[sub.fiveHour, sub.weekly].map((w) => (
                <Text key={w.window} style={[t.tiny, { color: p.muted }]}>
                  {w.label}: {w.learning ? "learning the limit" : `${w.percentLeft}% left`} · {w.usedRuns} run{w.usedRuns === 1 ? "" : "s"} used
                </Text>
              ))}
            </View>
          )) : <Text style={[t.tiny, { color: p.muted }]}>No subscription covers this agent yet.</Text>}
        </View>
      ) : null}
    </View>
  );
}
