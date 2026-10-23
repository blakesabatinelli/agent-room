import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { AgentResume } from "@agent-room/shared";
import { useShallow } from "zustand/react/shallow";
import { useRoom } from "../state/store";
import { Button, Pill } from "./ui";
import { radius, space, type as t, usePalette } from "../theme";

/**
 * 2.3 An agent's résumé, as the orchestrator keeps it: where it is on probation, what it is strong and weak at (each line says
 * the numbers behind it), and the owner's switch for probation. The same data is in agents/<id>/RESUME.md. Agents never see it.
 */
const pct = (x: number | null) => (x === null ? "no work yet" : `${Math.round(x * 100)}%`);

export function Resume({ agentId, name }: { agentId: string; name: string }) {
  const p = usePalette();
  const { hub, st } = useRoom(useShallow((s) => ({ hub: s.hub, st: s.statuses[agentId] })));
  const [r, setR] = useState<AgentResume>();
  const [err, setErr] = useState<string>();
  const load = useCallback(() => { hub?.resume(agentId).then((x) => { setR(x); setErr(undefined); }).catch((e) => setErr((e as Error).message)); }, [hub, agentId]);
  useEffect(() => { load(); const i = setInterval(load, 15_000); return () => clearInterval(i); }, [load, st?.ready]);
  const flip = async (on: boolean) => { try { await hub?.setProbation(agentId, on); load(); } catch (e) { setErr((e as Error).message); } };

  if (!r) return <View style={{ paddingHorizontal: space(4), paddingVertical: space(3), borderTopWidth: 1, borderColor: p.line }}><Text style={[t.small, { color: p.muted }]}>{err ?? "Loading résumé."}</Text></View>;
  const pr = r.probation;
  const share = pr.needed ? Math.min(1, pr.graded / pr.needed) : 0;
  return (
    <View style={{ paddingHorizontal: space(4), paddingVertical: space(3), gap: space(2), borderTopWidth: 1, borderColor: p.line }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
        <Text style={[t.body, { color: p.inkStrong, fontWeight: "700" }]}>Résumé</Text>
        <Pill text={pr.on ? "On probation" : pr.endedAt ? "Finished probation" : "Not on probation"} color={pr.on ? p.warn : p.ok} />
        <View style={{ flex: 1 }} />
        {pr.on ? <Button small kind="plain" label="End probation" onPress={() => void flip(false)} />
          : <Button small kind="ghost" label="Restart probation" onPress={() => void flip(true)} />}
      </View>
      {pr.on ? (
        <View style={{ gap: space(1) }}>
          <Text style={[t.small, { color: p.ink }]}>{`${pr.graded} of ${pr.needed} graded runs. ${name} practises on copies of your tasks and gets no real work until then.`}</Text>
          <View accessibilityLabel={`${pr.graded} of ${pr.needed} graded runs`} style={{ height: 4, borderRadius: radius.sm, backgroundColor: p.line, overflow: "hidden" }}>
            <View style={{ height: 4, width: `${Math.round(share * 100)}%`, backgroundColor: p.accent }} />
          </View>
        </View>
      ) : pr.endedAt ? (
        <Text style={[t.small, { color: p.muted }]}>
          {pr.endedBy === "owner" ? "You ended probation." : `Finished probation${pr.mean === null || pr.mean === undefined ? "" : `: ${pr.mean.toFixed(2)} over ${pr.graded} graded runs`}.`}
        </Text>
      ) : null}
      {r.strengths.map((l) => <Text key={l} style={[t.small, { color: p.ink }]}>{l}</Text>)}
      {r.weaknesses.map((l) => <Text key={l} style={[t.small, { color: p.warn }]}>{l}</Text>)}
      {!r.strengths.length && !r.weaknesses.length ? (
        <Text style={[t.small, { color: p.muted }]}>
          {r.runs ? `${r.runs} graded run${r.runs === 1 ? "" : "s"}, nothing stands out yet.` : "No graded runs yet. A task type needs 3 before it shows here."}
        </Text>
      ) : null}
      {r.runs ? <Text style={[t.tiny, { color: p.muted }]}>{`${r.runs} graded run${r.runs === 1 ? "" : "s"}${r.shadowRuns ? ` (${r.shadowRuns} practice)` : ""} · accepted first time ${pct(r.firstPass)}`}</Text> : null}
      {err ? <Text style={[t.small, { color: p.danger }]}>{err}</Text> : null}
    </View>
  );
}
