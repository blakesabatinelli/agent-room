import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { goalCardModel, goalFraction, goalProgressLine, pickGoal, type GoalCardModel } from "@agent-room/shared/src/goalview";
import { useRoom } from "../state/store";
import { space, type as t, usePalette } from "../theme";
import { Chip } from "./ui";

/**
 * 3.1: the goal card. It sits at the top of the room's conversation and shows the goal's objective, its "Done means" list
 * (met, unmet or still open, as the final check set them), how far along it is, and what state it is in.
 * Open while the goal is moving; collapsed to one line once it is done. The owner can flip either.
 */
export function GoalCardView({ m }: { m: GoalCardModel }) {
  const p = usePalette();
  const [open, setOpen] = useState(m.live);
  useEffect(() => { setOpen(m.live); }, [m.goalId, m.live]);
  const fraction = goalFraction(m);
  const line = goalProgressLine(m);
  const tone = m.state.tone === "neutral" ? p.muted : m.state.tone === "accent" ? p.accent : m.state.tone === "ok" ? p.ok : m.state.tone === "warn" ? p.warn : p.danger;
  return (
    <View accessibilityLabel={`Goal: ${m.objective}. ${m.state.label}. ${line}`} style={{ borderBottomWidth: 1, borderColor: p.line, backgroundColor: p.canvas }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={open ? "Collapse the goal" : "Expand the goal"} onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(5), paddingVertical: space(2.5) }}>
        <Chip label={m.state.label} tone={m.state.tone} />
        <Text numberOfLines={open ? 3 : 1} style={[t.heading, { color: p.inkStrong, flex: 1 }]}>{m.objective}</Text>
        {!open && line ? <Text numberOfLines={1} style={[t.tiny, { color: p.muted }]}>{line}</Text> : null}
        <Text style={[t.small, { color: p.muted, width: 12, textAlign: "center" }]}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      <View style={{ height: 2, backgroundColor: p.line }}>
        <View style={{ height: 2, width: `${Math.round(fraction * 100)}%`, backgroundColor: m.state.key === "failed" ? p.danger : p.accent }} />
      </View>
      {open ? (
        <View style={{ paddingHorizontal: space(5), paddingTop: space(2.5), paddingBottom: space(3), gap: space(2) }}>
          {m.note ? (
            <View style={{ borderLeftWidth: 2, borderColor: tone, paddingLeft: space(2.5), gap: 2 }}>
              <Text style={[t.small, { color: m.note.kind === "waiting" ? p.warn : p.muted, fontWeight: "600" }]}>{m.note.kind === "waiting" ? "Waiting on you" : "Next"}</Text>
              <Text selectable style={[t.small, { color: p.ink }]}>{m.note.text}</Text>
              {m.note.kind === "waiting" ? <Text style={[t.tiny, { color: p.muted }]}>Reply in the room and the work picks back up.</Text> : null}
            </View>
          ) : null}
          {m.requirements.length ? (
            <View style={{ gap: space(1.5) }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: space(2) }}>
                <Text style={[t.small, t.name, { color: p.inkStrong }]}>Done means</Text>
                <Text style={[t.tiny, { color: p.muted }]}>{m.met} of {m.total} met</Text>
              </View>
              {m.requirements.map((r) => {
                const c = r.status === "met" ? p.ok : r.status === "unmet" ? p.danger : p.muted;
                return (
                  <View key={r.id} accessibilityLabel={`${r.id}, ${r.status === "met" ? "met" : r.status === "unmet" ? "not met" : "open"}: ${r.text}`} style={{ flexDirection: "row", gap: space(2) }}>
                    <Text style={[t.small, { color: c, width: 16, textAlign: "center", fontWeight: "700" }]}>{r.status === "met" ? "✓" : r.status === "unmet" ? "✕" : "○"}</Text>
                    <Text style={[t.tiny, { color: p.faint, width: 22, paddingTop: 1 }]}>{r.id}</Text>
                    <View style={{ flex: 1 }}>
                      <Text selectable style={[t.small, { color: r.status === "open" ? p.ink : p.inkStrong }]}>{r.text}</Text>
                      {r.status === "unmet" && r.evidence ? <Text selectable style={[t.tiny, { color: p.danger }]}>{r.evidence}</Text> : null}
                    </View>
                  </View>
                );
              })}
            </View>
          ) : <Text style={[t.small, { color: p.muted }]}>{m.state.key === "planning" ? "Writing the plan. The list of what done means shows here once it's ready." : "No list of requirements for this goal."}</Text>}
          {line ? <Text style={[t.tiny, { color: p.muted }]}>{line}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/** The card for the open room, or nothing when the room has no goal yet. */
export function GoalCard() {
  const { goals, tasks } = useRoom(useShallow((s) => ({ goals: s.goals, tasks: s.tasks })));
  const goal = useMemo(() => pickGoal(Object.values(goals)), [goals]);
  const model = useMemo(() => (goal ? goalCardModel(goal, Object.values(tasks)) : null), [goal, tasks]);
  return model ? <GoalCardView m={model} /> : null;
}
