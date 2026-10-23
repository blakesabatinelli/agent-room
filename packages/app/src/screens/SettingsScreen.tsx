import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import type { AuditEntry, CapacitySnapshot, ControlCommit, ControlStatus, JuryCalibration, OrchestratorSettings } from "@agent-room/shared";
import type { SetupInfo } from "../api/client";
import { useRoom } from "../state/store";
import { Button, Field, Screen, Section, Toggle } from "../components/ui";
import { SubscriptionList } from "../components/subscriptions";
import { RemoteAccess } from "../components/RemoteAccess";
import { Appearance } from "../components/Appearance"; // 3.1
import { PrivacyPanel } from "../components/Privacy"; // 4.7
import { ProviderTerms } from "../components/ProviderTerms"; // 4.7 / D5
import { About } from "../components/About"; // 4.7
import { space, type as t, usePalette } from "../theme";

export function SettingsScreen() {
  const p = usePalette();
  const { hub, agents, unpair, controlStamp } = useRoom(useShallow((s) => ({ hub: s.hub, agents: s.agents, unpair: s.unpair, controlStamp: s.controlStamp })));
  const [ctl, setCtl] = useState<ControlStatus>();
  const [ctlHistory, setCtlHistory] = useState<ControlCommit[]>([]);
  const [ctlMsg, setCtlMsg] = useState<string>();
  const loadCtl = () => { hub?.controlStatus().then(setCtl).catch(() => {}); hub?.controlHistory().then((h) => setCtlHistory(h.slice(0, 8))).catch(() => {}); };
  useEffect(loadCtl, [hub, controlStamp]);
  const checkCtl = async () => {
    const r = await hub?.controlLint().catch((e: Error) => { setCtlMsg(e.message); return undefined; });
    if (r) setCtlMsg(r.blocks.length + r.flags.length ? `${r.blocks.length} blocked, ${r.flags.length} flagged.` : "No problems found.");
    loadCtl();
  };
  const undoCtl = async (commit: string) => {
    try { await hub?.controlRevert(commit); setCtlMsg("Undone."); } catch (e) { setCtlMsg((e as Error).message); }
    loadCtl();
  };
  const [s, setS] = useState<OrchestratorSettings & { calibration: { n: number; absErr: number } }>();
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [mcp, setMcp] = useState<string>();
  const [setup, setSetup] = useState<SetupInfo>();
  const [cap, setCap] = useState<CapacitySnapshot>();
  useEffect(() => { hub?.capacity().then(setCap).catch(() => {}); }, [hub]);
  const [jury, setJury] = useState<{ calibration: JuryCalibration; juries: number; splits: number }>(); // 2.2
  useEffect(() => { hub?.juryStats().then(setJury).catch(() => {}); }, [hub]);
  const loadSetup = () => { hub?.setup().then(setSetup).catch(() => {}); };
  useEffect(loadSetup, [hub]);
  useEffect(() => { hub?.settings().then(setS).catch(() => {}); hub?.audit().then(setAudit).catch(() => {}); }, [hub]);
  const save = async (patch: Partial<OrchestratorSettings>) => { if (!hub || !s) return; await hub.saveSettings(patch); setS({ ...s, ...patch }); };
  const candidates = agents.filter((a) => a.canBeOrchestrator || a.adapter !== "command");

  const makeMcp = async () => {
    const r = await hub?.mcpToken("claude-desktop", "Claude Desktop");
    if (r && hub) setMcp(JSON.stringify({ mcpServers: { "agent-room": { type: "http", url: `${hub.baseUrl}/mcp`, headers: { Authorization: `Bearer ${r.token}` } } } }, null, 2));
  };

  return (
    <Screen title="Settings">
      <ScrollView contentContainerStyle={{ padding: space(4) }}>
        <Appearance />
        {s ? (
          <>
            <Section title="Orchestrator">
              <View style={{ padding: space(4), gap: space(2) }}>
                <Text style={[t.small, { color: p.muted }]}>Which agent plans, routes and keeps memory</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
                  {candidates.map((a) => <Button key={a.id} kind={s.orchestratorAgentId === a.id ? "primary" : "plain"} label={a.name} onPress={() => save({ orchestratorAgentId: a.id })} />)}
                </View>
              </View>
            </Section>
            <Section title="Judges">
              {candidates.map((a) => (
                <Toggle key={a.id} label={a.name} accent={a.color} hint="Takes turns grading work; never grades its own"
                  value={s.judgeRotation.includes(a.id)}
                  onChange={(v) => save({ judgeRotation: v ? [...s.judgeRotation, a.id] : s.judgeRotation.filter((x) => x !== a.id) })} />
              ))}
              <Toggle label="Blind jury of three" hint="Work is rewritten in a neutral voice, then graded by three judges from other model families, one of them local. Needs three families besides the worker's."
                value={s.jury?.enabled ?? true} onChange={(v) => save({ jury: { ...s.jury, enabled: v } })} />
              {jury && jury.calibration.n ? (
                <View style={{ paddingHorizontal: space(4) }}>
                  <Text style={[t.small, { color: p.muted }]}>
                    {`Juries are off by ${Math.round(jury.calibration.juryAbsErr * 100)} points from your ratings (${jury.calibration.juryN}), single judges by ${Math.round(jury.calibration.singleAbsErr * 100)} (${jury.calibration.singleN}).`}
                  </Text>
                </View>
              ) : null}
              <View style={{ padding: space(4) }}>
                <Text style={[t.small, { color: p.muted }]}>
                  {s.calibration.n ? `You've spot-checked ${s.calibration.n} judgments; judges are off by ${Math.round(s.calibration.absErr * 100)} points on average.` : "No spot checks yet."}
                </Text>
              </View>
            </Section>
            <Section title="Plans and checks">
              <View style={{ padding: space(4), gap: space(2) }}>
                <Text style={[t.body, { color: p.ink }]}>Show me the plan before work starts</Text>
                <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                  {([["always", "Always"], ["big", "For bigger jobs"], ["never", "Never"]] as const).map(([v, label]) => (
                    <Button key={v} small kind={(s.planApproval ?? "big") === v ? "primary" : "plain"} label={label} onPress={() => save({ planApproval: v })} />
                  ))}
                </View>
                <Text style={[t.small, { color: p.muted }]}>"Bigger jobs" means three or more tasks, or a plan with checks that run commands.</Text>
              </View>
              <Toggle label="Run plan checks without asking" value={!!s.autoRunChecks}
                hint="Checks are shell commands in a job's own folder (for example, does summary.md exist). Off: they run only on plans you approved."
                onChange={(v) => save({ autoRunChecks: v })} />
              <Toggle label="Pick up work after a restart" value={s.autoResume !== false}
                hint="If the hub restarts mid-job, the work continues where it left off."
                onChange={(v) => save({ autoResume: v })} />
            </Section>
            <Section title="Learning">
              <View style={{ padding: space(4) }}>
                <Field label="How often to try a less proven agent (0 to 1)" defaultValue={String(s.explorationRate)} keyboardType="decimal-pad"
                  onEndEditing={(e) => save({ explorationRate: Math.min(1, Math.max(0, Number(e.nativeEvent.text) || 0)) })} />
                <Field label="Attempts before a task fails" defaultValue={String(s.maxAttempts)} keyboardType="number-pad"
                  onEndEditing={(e) => save({ maxAttempts: Math.max(1, Math.round(Number(e.nativeEvent.text) || 3)) })} />
                <Field label="Agent-to-agent back-and-forth before it comes to you" defaultValue={String(s.maxAgentHops ?? 4)} keyboardType="number-pad"
                  onEndEditing={(e) => save({ maxAgentHops: Math.max(0, Math.min(12, Math.round(Number(e.nativeEvent.text) || 0))) })} />
                <Field label="Minutes a connected agent has to pick up its work" defaultValue={String(s.claimTimeoutMinutes ?? 3)} keyboardType="decimal-pad"
                  onEndEditing={(e) => save({ claimTimeoutMinutes: Math.max(0.5, Math.min(60, Number(e.nativeEvent.text) || 3)) })} />
                <Field label="Off-task strikes before work is taken away" defaultValue={String(s.driftStrikes ?? 2)} keyboardType="number-pad"
                  onEndEditing={(e) => save({ driftStrikes: Math.max(1, Math.min(5, Math.round(Number(e.nativeEvent.text) || 2))) })} />
                <Field label="Share of judgments sent to you for spot checks (0 to 1)" defaultValue={String(s.calibrationSampleRate)} keyboardType="decimal-pad"
                  onEndEditing={(e) => save({ calibrationSampleRate: Math.min(1, Math.max(0, Number(e.nativeEvent.text) || 0)) })} />
              </View>
            </Section>
          </>
        ) : null}
        {s ? (
          <Section title="Interruptions and digest" hint="During the day the room only interrupts you for a disagreement between judges or a decision it needs. Everything else waits for the evening digest.">
            <View style={{ padding: space(4) }}>
              <Field label="Interruptions a day before they wait for the digest" defaultValue={String(s.attention?.dailyInterruptCap ?? 6)} keyboardType="number-pad"
                onEndEditing={(e) => save({ attention: { ...s.attention, dailyInterruptCap: Math.max(0, Math.min(50, Math.round(Number(e.nativeEvent.text) || 0))) } })} />
              <Field label="Digest time (24-hour, for example 18:00)" defaultValue={s.attention?.digestAt ?? "18:00"}
                onEndEditing={(e) => { const v = e.nativeEvent.text.trim(); if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) save({ attention: { ...s.attention, digestAt: v } }); }} />
              <Field label="Quiet from" defaultValue={s.attention?.quietFrom ?? "22:00"}
                onEndEditing={(e) => { const v = e.nativeEvent.text.trim(); if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) save({ attention: { ...s.attention, quietFrom: v } }); }} />
              <Field label="Quiet until" defaultValue={s.attention?.quietTo ?? "07:00"}
                onEndEditing={(e) => { const v = e.nativeEvent.text.trim(); if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) save({ attention: { ...s.attention, quietTo: v } }); }} />
              <Field label="Minutes each accepted task saves you" defaultValue={s.minutesSavedPerTask === undefined ? "" : String(s.minutesSavedPerTask)} keyboardType="decimal-pad"
                hint="Only used by the kill-criteria review, to weigh the attention the room costs you against what it saves."
                onEndEditing={(e) => { const v = Number(e.nativeEvent.text); save({ minutesSavedPerTask: e.nativeEvent.text.trim() && Number.isFinite(v) && v >= 0 ? Math.min(600, v) : undefined }); }} />
            </View>
          </Section>
        ) : null}
        {cap ? (
          <Section title="This computer">
            <View style={{ padding: space(4), gap: space(1) }}>
              <Text style={[t.body, { color: p.ink }]}>{cap.summary}</Text>
            </View>
          </Section>
        ) : null}
        <Section title="Subscriptions" hint="What each plan has used in its 5-hour and weekly windows. Work stops going to a plan that is at its limit.">
          <SubscriptionList hub={hub} />
        </Section>
        {setup ? (
          <Section title="Practice mode">
            <Toggle label="Practice agents" value={setup.practiceMode} hint="Stand-ins that answer instantly instead of your real agents"
              onChange={async (v) => { await hub?.saveSetup({ practiceMode: v }); loadSetup(); }} />
          </Section>
        ) : null}
        {Platform.OS === ("macos" as string) ? (
          <Section title="Remote access">
            <RemoteAccess funnel />
          </Section>
        ) : null}
        {Platform.OS === ("macos" as string) && setup ? (
          <Section title="Pair your phone">
            <View style={{ padding: space(4), gap: space(1) }}>
              {setup.phone.url ? (
                <>
                  <Text selectable style={[t.heading, { color: p.ink }]}>{setup.phone.url}</Text>
                  <Text selectable style={[t.title, { color: p.orchestrator, fontSize: 30, letterSpacing: 6 }]}>{setup.phone.code}</Text>
                  <Text style={[t.small, { color: p.muted }]}>
                    On your phone, with Tailscale on: open the address above (the Mac's Tailscale name) in Safari, tap Share → Add to Home Screen, then open Agent Room from the home screen and enter the code. The code works once and lasts 10 minutes.
                  </Text>
                </>
              ) : <Text style={[t.small, { color: p.muted }]}>Tailscale isn't connected on this Mac yet. See Remote access above.</Text>}
              <Button kind="plain" label="Refresh" onPress={loadSetup} />
            </View>
          </Section>
        ) : null}
        {Platform.OS === ("macos" as string) ? (
          <Section title="Let MCP apps join the room">
            <View style={{ padding: space(4), gap: space(2) }}>
              <Text style={[t.small, { color: p.muted }]}>Creates a connection for Claude Desktop or another MCP app. Paste the result into its MCP settings.</Text>
              <Button kind="plain" label="Create connection" onPress={makeMcp} />
              {mcp ? <Text selectable style={[t.small, { color: p.ink, fontFamily: "Menlo" }]}>{mcp}</Text> : null}
            </View>
          </Section>
        ) : null}
        {ctl ? (
          <Section title="Control files" hint="Your rules, personas and permissions are plain files in this folder. Edit them here or in any text editor; both stay in step.">
            <View style={{ padding: space(4), gap: space(2) }}>
              <Text selectable style={[t.body, { color: p.ink }]}>{ctl.root}</Text>
              <Text style={[t.small, { color: p.muted }]}>
                {ctl.lastLoad ? `Last read ${new Date(ctl.lastLoad).toLocaleTimeString()}. ` : ""}{ctl.git ? "Every change is kept in the folder's history." : "History is off because git isn't installed."}
              </Text>
              {ctl.notices.length ? ctl.notices.map((n, i) => (
                <View key={`${n.file}:${i}`} style={{ paddingTop: space(1) }}>
                  <Text style={[t.small, { color: n.level === "block" ? p.danger : p.ink }]}>{n.file}{n.line ? `, line ${n.line}` : ""}</Text>
                  <Text style={[t.small, { color: p.muted }]}>{n.message}</Text>
                </View>
              )) : <Text style={[t.small, { color: p.muted }]}>No problems in the control files.</Text>}
              <View style={{ flexDirection: "row", gap: space(2), alignItems: "center" }}>
                <Button kind="plain" label="Check files" onPress={checkCtl} />
                {ctlMsg ? <Text style={[t.small, { color: p.muted }]}>{ctlMsg}</Text> : null}
              </View>
            </View>
            {ctlHistory.length ? (
              <View style={{ borderTopWidth: 1, borderColor: p.line }}>
                <Text style={[t.small, { color: p.muted, paddingHorizontal: space(4), paddingTop: space(3) }]}>Recent changes. Undo adds a new change that reverses it.</Text>
                {ctlHistory.map((h) => (
                  <View key={h.commit} style={{ paddingHorizontal: space(4), paddingVertical: space(2), flexDirection: "row", alignItems: "center", gap: space(2) }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[t.small, { color: p.ink }]} numberOfLines={2}>{h.message}</Text>
                      <Text style={[t.small, { color: p.muted }]}>{h.author}, {new Date(h.at).toLocaleString()}</Text>
                    </View>
                    <Button small kind="plain" label="Undo" onPress={() => undoCtl(h.commit)} />
                  </View>
                ))}
              </View>
            ) : null}
          </Section>
        ) : null}
        <Section title="Privacy and updates" hint="What can leave this Mac, and only if you allow it. Everything is off until you turn it on, except looking for updates.">
          <PrivacyPanel />
        </Section>
        <Section title="Sign-in and provider terms">
          <ProviderTerms />
        </Section>
        <Section title="About">
          <About />
        </Section>
        <Section title="Setup">
          <View style={{ padding: space(4), gap: space(2) }}>
            <Text style={[t.small, { color: p.muted }]}>Go back through the welcome steps: sign agents in, pair your phone, start at login. Agents can also be connected any time from Agents & connections.</Text>
            {setup?.timer?.done && setup.elapsedSeconds != null ? (
              <Text style={[t.small, { color: p.muted }]}>
                First goal finished {Math.floor(setup.elapsedSeconds / 60)}:{String(setup.elapsedSeconds % 60).padStart(2, "0")} after you first opened Agent Room{setup.timer.firstGoalPractice ? " (practice agents)" : ""}.
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: space(2) }}>
              <Button kind="plain" label="Run setup again" onPress={async () => { await hub?.saveSetup({ onboarded: false }); useRoom.setState({ onboarded: false }); }} />
              <Button kind="plain" label="Agents & connections" onPress={() => useRoom.getState().openPage("agents")} />
            </View>
          </View>
        </Section>
        <Section title="Activity log">
          {audit.slice(0, 50).map((a) => (
            <View key={a.id} style={{ paddingHorizontal: space(4), paddingVertical: space(2), borderBottomWidth: 1, borderColor: p.line }}>
              <Text style={[t.small, { color: p.ink }]}>{a.actor}: {a.action}</Text>
              <Text style={[t.small, { color: p.muted }]} numberOfLines={2}>{new Date(a.at).toLocaleString()} {a.detail}</Text>
            </View>
          ))}
        </Section>
        <Button kind="danger" label="Disconnect this device" onPress={unpair} />
      </ScrollView>
    </Screen>
  );
}
