import React from "react";
import { View } from "react-native";
import { verdictChip } from "@agent-room/shared/src/goalview";
import { useRoom } from "../state/store";
import { space } from "../theme";
import { JuryChips } from "./JuryChips"; // 2.2
import { VerdictChip } from "./ui";

/**
 * 3.1: the verdict on a task's message, as chips: accepted, sent back or disputed (the judges split), with the score, then one
 * small chip per judge when a jury looked at it. It replaces the judge's long log line, which now only shows in the activity log.
 */
export function TaskVerdict({ taskId }: { taskId: string }) {
  const task = useRoom((s) => s.tasks[taskId]);
  const chip = task ? verdictChip(task) : null;
  if (!task || !chip) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space(1.5), paddingLeft: space(5) + 28 + space(2.5), paddingRight: space(5), paddingTop: 2, paddingBottom: space(1.5) }}>
      <VerdictChip chip={chip} />
      <JuryChips jury={task.judgment?.jury} compact />
    </View>
  );
}
