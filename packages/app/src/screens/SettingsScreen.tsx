import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import type { AuditEntry, OrchestratorSettings } from "@agent-room/shared";
import type { SetupInfo } from "../api/client";
import { useRoom } from "../state/store";
import { Button, Field, Screen, Section, Toggle } from "../components/ui";
import { space, type as t, usePalette } from "../theme";

export function SettingsScreen() {
  const p = usePalette();
  const { hub, agents, unpair } = useRoom(useShallow((s) => ({ hub: s.hub, agents: s.agents, unpair: s.unpair })));
  const [s, setS] = useState<OrchestratorSettings & { calibration: { n: number; absErr: number } }>();
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [mcp, setMcp] = useState<string>();
  const [setup, setSetup] = useState<SetupInfo>();
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
        {setup ? (
          <Section title="Practice mode">
            <Toggle label="Practice agents" value={setup.practiceMode} hint="Stand-ins that answer instantly instead of your real agents"
              onChange={async (v) => { await hub?.saveSetup({ practiceMode: v }); loadSetup(); }} />
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
                    On your phone, with Tailscale on: open the address above in Safari, tap Share → Add to Home Screen, then open Agent Room from the home screen and enter the code. The code works once and lasts 10 minutes.
                  </Text>
                </>
              ) : <Text style={[t.small, { color: p.muted }]}>Tailscale isn't running on this Mac yet.</Text>}
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
        <Section title="Setup">
          <View style={{ padding: space(4), gap: space(2) }}>
            <Text style={[t.small, { color: p.muted }]}>Go back through the welcome steps: sign agents in, pair your phone, start at login. Agents can also be connected any time from Agents & connections.</Text>
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
