import React from "react";
import { Text, View } from "react-native";
import type { Judgment } from "@agent-room/shared";
import { space, type as t, usePalette } from "../theme";
import { Pill } from "./ui";

/** 2.2: "3 judges: ✓ ✓ ✗ (agree 67%)" with one small chip per judge (family, verdict, score). Nothing when the work was not judged by a jury. */
/** `compact` (3.1, in the conversation) leaves out the sentence; the verdict chip beside it already says accepted, sent back or disputed. */
export function JuryChips({ jury, compact }: { jury?: Judgment["jury"]; compact?: boolean }) {
  const p = usePalette();
  if (!jury) return null;
  const mark = (v: Judgment["verdict"]) => (v === "accept" ? "✓" : "✗");
  const line = jury.kind === "fallback"
    ? `1 judge${jury.reason ? `, no jury: ${jury.reason}` : ""}`
    : `${jury.judges.length} judges: ${jury.judges.map((j) => mark(j.verdict)).join(" ")} (agree ${Math.round(jury.agreement.majority * 100)}%)${jury.split ? " · split" : ""}`;
  return (
    <View style={{ gap: space(1), marginTop: 2 }}>
      {compact ? null : <Text style={[t.tiny, { color: jury.split ? p.warn : p.muted }]} numberOfLines={2}>{line}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1) }}>
        {jury.judges.map((j) => (
          <Pill key={j.agentId} text={`${j.family}${j.local ? " (local)" : ""} ${mark(j.verdict)} ${Math.round(j.score * 100)}`} color={j.verdict === "accept" ? p.ok : p.danger} />
        ))}
      </View>
    </View>
  );
}
