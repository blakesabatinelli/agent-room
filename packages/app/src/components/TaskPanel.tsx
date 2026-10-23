import { useShallow } from "zustand/react/shallow";
import React from "react";
import { ScrollView, Text, View } from "react-native";
import type { Task } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { space, type as t, usePalette } from "../theme";
import { Empty } from "./ui";
import { JuryChips } from "./JuryChips"; // 2.2

const label: Record<Task["status"], string> = {
  pending: "Waiting", assigned: "Assigned", running: "Working", review: "Being judged", revising: "Revising",
  waiting: "Needs your input", done: "Done", failed: "Failed", cancelled: "Cancelled",
};

export function TaskPanel() {
  const p = usePalette();
  const { tasks, goals, agents } = useRoom(useShallow((s) => ({ tasks: s.tasks, goals: s.goals, agents: s.agents })));
  const goal = Object.values(goals).sort((a, b) => b.createdAt - a.createdAt)[0];
  const list = Object.values(tasks).filter((x) => x.goalId === goal?.id).sort((a, b) => a.createdAt - b.createdAt);
  const byId = new Map(list.map((x) => [x.id, x]));
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space(4), gap: space(3) }}>
      {goal ? (
        <View style={{ gap: space(1) }}>
          <Text style={[t.small, { color: p.muted }]}>Current goal</Text>
          <Text style={[t.heading, { color: p.ink }]}>{goal.text}</Text>
        </View>
      ) : <Empty text="No goal yet. Type one in the room to get the agents working." />}
      {list.map((task) => {
        const a = agents.find((x) => x.id === task.assignee);
        const deps = task.dependsOn.map((d) => byId.get(d)?.title).filter(Boolean);
        return (
          <View key={task.id} style={{ borderLeftWidth: 3, borderColor: a?.color ?? p.line, paddingLeft: space(3), gap: 2 }}>
            <Text style={[t.body, { color: p.ink, fontWeight: "600" }]}>{task.title}</Text>
            <Text style={[t.small, { color: task.status === "failed" ? p.danger : task.status === "done" ? p.ok : p.muted }]}>
              {label[task.status]}{a ? ` by ${a.name}` : ""}{task.judgment ? `, scored ${Math.round(task.judgment.score * 100)}` : ""}
            </Text>
            {deps.length ? <Text style={[t.small, { color: p.muted }]}>After {deps.join(", ")}</Text> : null}
            <JuryChips jury={task.judgment?.jury} />
          </View>
        );
      })}
    </ScrollView>
  );
}
