import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { NightShiftState, ReturnLedger, Scorecard } from "@agent-room/shared";
import type { Hub } from "../api/client";
import { useRoom } from "../state/store";
import { space, type as t, usePalette } from "../theme";
import { Button } from "./ui";

/**
 * 2.7 The weekly scorecard and the monthly return ledger, as the hub's /reports/scorecard and /reports/ledger build them.
 * Weeks are ISO weeks (Monday to Sunday, UTC), the same as the first-pass chart above it.
 */

function isoWeekOf(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const pct = (r: number | null) => (r === null ? "none yet" : `${Math.round(r * 100)}%`);
const usd = (x: number | null) => (x === null ? "not reported" : `$${x < 10 ? x.toFixed(2) : x.toFixed(0)}`);
const points = (d: number | null) => (d === null ? "no data" : `${Math.round(d * 100)} points`);

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ gap: space(1) }}>
      <Text style={[t.small, { color: p.muted }]}>{title}</Text>
      {children}
    </View>
  );
}

export function WeeklyScorecard({ hub }: { hub?: Hub }) {
  const p = usePalette();
  const [which, setWhich] = useState<"this" | "last">("this");
  const [sc, setSc] = useState<Scorecard>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setSc(undefined); setErr(undefined);
    const week = which === "this" ? undefined : isoWeekOf(Date.now() - 7 * 86_400_000);
    hub?.scorecard(week).then(setSc).catch((e: Error) => setErr(e.message));
  }, [hub, which]);

  return (
    <View style={{ padding: space(4), gap: space(3) }}>
      <View style={{ flexDirection: "row", gap: space(2) }}>
        <Button small kind={which === "this" ? "primary" : "plain"} label="This week" onPress={() => setWhich("this")} />
        <Button small kind={which === "last" ? "primary" : "plain"} label="Last week" onPress={() => setWhich("last")} />
      </View>
      {err ? <Text style={[t.small, { color: p.warn }]}>{err}</Text> : null}
      {!sc && !err ? <Text style={[t.small, { color: p.muted }]}>Loading.</Text> : null}
      {sc ? (
        <>
          <Text style={[t.body, { color: p.ink }]}>
            {`${sc.week} (${sc.start} to ${sc.end}): ${sc.totals.goals} goals, ${sc.totals.tasks} tasks, ${sc.totals.accepted} accepted, ${pct(sc.totals.firstPass)} first time.`}
          </Text>

          <Block title="Best agent at each kind of work">
            {sc.bestByTaskType.length ? sc.bestByTaskType.map((r) => (
              <Text key={r.taskType} style={[t.body, { color: p.ink }]}>
                {r.best ? `${r.taskType}: ${r.best}` : `${r.taskType}: not enough graded runs yet`}
                {r.best ? <Text style={{ color: p.muted }}>{` (${Math.round((r.agents.find((a) => a.agentId === r.best)?.meanQuality ?? 0) * 100)}% average quality)`}</Text> : null}
              </Text>
            )) : <Text style={[t.small, { color: p.muted }]}>No graded work this week.</Text>}
          </Block>

          <Block title="Goals that were too vague">
            {sc.vagueGoals.length ? sc.vagueGoals.map((g) => (
              <Text key={g.goalId} style={[t.body, { color: p.ink }]}>
                {`${g.goal}: ${g.specFailures} spec failures, ${g.clarifications} questions back to you`}
              </Text>
            )) : <Text style={[t.small, { color: p.muted }]}>None. Nothing needed rewording.</Text>}
          </Block>

          <Block title="How far judges are from you">
            {sc.judges.rated ? (
              <>
                <Text style={[t.body, { color: p.ink }]}>{`Juries: ${points(sc.judges.jury.meanDistance)} (${sc.judges.jury.n}). Single judges: ${points(sc.judges.single.meanDistance)} (${sc.judges.single.n}).`}</Text>
                {sc.judges.byFamily.map((f) => (
                  <Text key={f.family} style={[t.small, { color: p.muted }]}>{`${f.family}: ${Math.round(f.meanDistance * 100)} points over ${f.n} ratings`}</Text>
                ))}
              </>
            ) : <Text style={[t.small, { color: p.muted }]}>You have not rated any judgments this week.</Text>}
          </Block>

          <Block title="Cost per goal">
            <Text style={[t.body, { color: p.ink }]}>
              {`${usd(sc.cost.costUsd)} API-equivalent across ${sc.cost.goals} goals${sc.cost.costPerAccepted === null ? "" : `, ${usd(sc.cost.costPerAccepted)} per accepted task`}.`}
            </Text>
            {sc.costPerGoal.slice(0, 5).map((g) => (
              <Text key={g.goalId} style={[t.small, { color: p.muted }]}>{`${g.goal}: ${usd(g.costUsd)}, ${g.accepted} accepted${g.estimated ? " (tokens estimated)" : ""}`}</Text>
            ))}
          </Block>

          <Block title="Interruptions">
            <Text style={[t.body, { color: p.ink }]}>
              {`${sc.interruptions.total} this week (cap ${sc.interruptions.cap} a day), ${sc.interruptions.queued} waited for the digest.${sc.interruptions.overCap ? ` ${sc.interruptions.overCap} went through past the cap because work was blocked.` : ""}`}
            </Text>
          </Block>

          <Block title="What agents learned">
            {sc.lessons.length ? sc.lessons.map((l, i) => (
              <Text key={i} style={[t.small, { color: p.ink }]}>{`${l.agentId}, ${l.taskType}: ${l.text}`}</Text>
            )) : <Text style={[t.small, { color: p.muted }]}>No new lessons this week.</Text>}
          </Block>
        </>
      ) : null}
    </View>
  );
}

/**
 * 4.5 Night shift: quota that would expire overnight re-runs the day's finished tasks on other agents, and the two results are graded blind.
 * What the owner sees here: whether it is on, the last night's one line, and who beat whom by task type (the same table the kill-criteria review reads).
 */
export function NightShiftView({ hub }: { hub?: Hub }) {
  const p = usePalette();
  const agents = useRoom((s) => s.agents);
  const [ns, setNs] = useState<NightShiftState>();
  const [err, setErr] = useState<string>();
  useEffect(() => { hub?.nightShift().then(setNs).catch((e: Error) => setErr(e.message)); }, [hub]);
  const who = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  if (err) return <Text style={[t.small, { color: p.warn, padding: space(4) }]}>{err}</Text>;
  if (!ns) return <Text style={[t.small, { color: p.muted, padding: space(4) }]}>Loading.</Text>;
  const s = ns.settings;
  const status = !s.enabled ? "Off." : ns.inWindow ? `Running tonight: ${ns.runsTonight} of ${s.maxRunsPerNight} runs so far.` : `On, ${s.from} to ${s.to} (${s.timezone}).`;
  const latest = ns.nights.find((n) => n.line);
  return (
    <View style={{ padding: space(4), gap: space(3) }}>
      <Text style={[t.body, { color: p.ink }]}>{status}</Text>
      <Text style={[t.small, { color: p.muted }]}>
        {`${s.enabled ? "Re-runs" : "Would re-run"} the day's finished tasks on other agents with quota that would expire, and grades both results blind. Nothing is merged and nothing is said in a room.`}
      </Text>
      {latest?.line ? <Text style={[t.body, { color: p.ink }]}>{latest.line}</Text> : null}
      <Block title="Head to head">
        {ns.headToHead.length ? ns.headToHead.slice(0, 12).map((r) => (
          <Text key={`${r.taskType}${r.first}${r.second}`} style={[t.body, { color: p.ink }]}>
            {`${who(r.first)} against ${who(r.second)}, ${r.taskType}: ${r.firstWins} to ${r.secondWins}${r.ties ? `, ${r.ties} tied` : ""} over ${r.n} run${r.n === 1 ? "" : "s"}`}
            <Text style={{ color: p.muted }}>{` (average ${r.firstMean.toFixed(2)} against ${r.secondMean.toFixed(2)})`}</Text>
          </Text>
        )) : <Text style={[t.small, { color: p.muted }]}>No head-to-head runs yet.</Text>}
      </Block>
    </View>
  );
}

export function ReturnLedgerView({ hub }: { hub?: Hub }) {
  const p = usePalette();
  const [l, setL] = useState<ReturnLedger>();
  useEffect(() => { hub?.ledger().then(setL).catch(() => {}); }, [hub]);
  if (!l) return <Text style={[t.small, { color: p.muted, padding: space(4) }]}>Loading.</Text>;
  return (
    <View style={{ padding: space(4), gap: space(2) }}>
      <Text style={[t.small, { color: p.muted }]}>{l.month}</Text>
      {l.rows.length ? l.rows.map((r) => (
        <Text key={r.subscriptionId} style={[t.body, { color: r.advice === "cancel" ? p.warn : p.ink }]}>{r.line}</Text>
      )) : <Text style={[t.small, { color: p.muted }]}>No subscriptions yet.</Text>}
      <Text style={[t.small, { color: p.muted }]}>
        {`Keep up to $${l.thresholds.keepUpToUsd} per accepted task; consider cancelling above $${l.thresholds.cancelAboveUsd} or under ${l.thresholds.minAccepted} accepted tasks. Set what you pay in the subscription list below.`}
      </Text>
    </View>
  );
}
