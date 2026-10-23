import { useShallow } from "zustand/react/shallow";
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { SetupInfo } from "../api/client";
import { launcher } from "../native/hub";
import { useRoom } from "../state/store";
import { Avatar, Button, CodeBlock, Section, Toggle } from "../components/ui";
import { RemoteAccess } from "../components/RemoteAccess";
import { Discovery } from "../components/Discovery";
import { SignInPanel } from "../components/SignIn";
import { ProviderTerms } from "../components/ProviderTerms"; // 4.7 / D5
import { PrivacyPanel } from "../components/Privacy"; // 4.7
import { space, type as t, usePalette } from "../theme";

const clock = (secs: number) => `${Math.floor(Math.max(0, secs) / 60)}:${String(Math.floor(Math.max(0, secs) % 60)).padStart(2, "0")}`;

export function OnboardingScreen() {
  const p = usePalette();
  const { hub, ownerName } = useRoom(useShallow((s) => ({ hub: s.hub, ownerName: s.ownerName })));
  const [info, setInfo] = useState<SetupInfo>();
  const [note, setNote] = useState<string>();
  const [atLogin, setAtLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string>();

  const refresh = useCallback(async () => { if (hub) setInfo(await hub.setup()); }, [hub]);
  useEffect(() => { void refresh(); launcher?.startAtLoginEnabled().then(setAtLogin).catch(() => {}); }, [refresh]);
  // 1.7: the setup clock keeps counting here, and the status refreshes now and then, so the sign-in rows update on their own.
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => { tick((n) => n + 1); void refresh(); }, 4000); return () => clearInterval(i); }, [refresh]);

  if (!info || !hub) return <View style={{ flex: 1, backgroundColor: p.canvas }} />;
  const showLog = async (id: string) => { try { setLog((await hub.signInLog(id)).log ?? "No setup log yet."); } catch (e) { setLog((e as Error).message); } };
  const cli = info.agents.filter((a) => a.adapter === "claude-code" || a.adapter === "codex");
  const anyReady = cli.some((a) => a.ready);

  const practice = async (v: boolean) => { try { await hub.saveSetup({ practiceMode: v }); await refresh(); } catch (e) { setNote((e as Error).message); } };
  const loginItem = async (v: boolean) => {
    setBusy(true);
    try { setAtLogin(await launcher!.setStartAtLogin(v)); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  const finish = async () => { try { await hub.saveSetup({ onboarded: true }); useRoom.setState({ onboarded: true }); } catch (e) { setNote((e as Error).message); } };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: p.canvas }} contentContainerStyle={{ padding: space(8), maxWidth: 620, width: "100%", alignSelf: "center" }}>
      <Text style={[t.title, { color: p.inkStrong, fontSize: 28, marginBottom: space(2) }]}>Welcome, {ownerName}</Text>
      <Text style={[t.body, { color: p.muted, marginBottom: space(8) }]}>
        Your hub is running on this Mac. A few quick steps and the room is ready.
      </Text>

      <Section title="1. Sign in your agents">
        <View style={{ padding: space(4) }}><Discovery invite={false} /></View>
        {cli.map((a) => (
          <View key={a.id} style={{ padding: space(4), borderBottomWidth: 1, borderColor: p.line, gap: space(3) }}>
            <View style={{ flexDirection: "row", gap: space(3), alignItems: "center" }}>
              <Avatar name={a.name} color={a.color} size={36} presence={a.ready ? "ready" : "off"} />
              <View style={{ flex: 1 }}>
                <Text style={[t.body, { color: p.inkStrong, fontWeight: "700" }]}>{a.adapter === "codex" ? `${a.name} (ChatGPT)` : a.name}</Text>
                <Text style={[t.small, { color: a.ready ? p.ok : p.muted }]}>
                  {a.ready ? a.detail || "Signed in." : a.adapter === "claude-code" ? "Uses your Claude plan through Claude Code." : "Uses your ChatGPT plan through OpenAI's Codex CLI."}
                </Text>
              </View>
              {!a.ready ? <Button kind="ghost" small label="Log" onPress={() => showLog(a.id)} /> : null}
            </View>
            <SignInPanel agentId={a.id} adapter={a.adapter} ready={a.ready} notInstalled={/isn't installed/i.test(a.detail)} onChanged={refresh} />
          </View>
        ))}
        <View style={{ padding: space(4), flexDirection: "row", gap: space(2), alignItems: "center" }}>
          <Button kind="plain" label="Check again" onPress={refresh} />
          {note ? <Text style={[t.small, { color: p.muted, flex: 1 }]}>{note}</Text> : null}
        </View>
        {log !== undefined ? <View style={{ paddingHorizontal: space(4), paddingBottom: space(4) }}><CodeBlock label="Setup log" text={log} /></View> : null}
        <View style={{ paddingHorizontal: space(4), paddingBottom: space(4) }}>
          <Text style={[t.small, { color: p.muted }]}>Muse and other agents on another device join later, from Agents & connections in the sidebar. You can come back to any of this later.</Text>
        </View>
        <Toggle label="Use practice agents for now" value={info.practiceMode} onChange={practice}
          hint="Stand-in agents that answer instantly, so you can try the room before signing in. Turn off in Settings." />
      </Section>

      <Section title="How sign-in and terms work" hint="Read this before you sign in. Nothing here changes how sign-in works.">
        <ProviderTerms />
      </Section>

      <Section title="2. Connect Tailscale">
        <RemoteAccess />
      </Section>

      <Section title="3. Connect your phone (optional)">
        <View style={{ padding: space(4), gap: space(2) }}>
          {info.phone.url ? (
            <>
              <Text style={[t.body, { color: p.ink }]}>In the phone app, enter:</Text>
              <Text selectable style={[t.heading, { color: p.ink }]}>{info.phone.url}</Text>
              <Text style={[t.body, { color: p.ink }]}>Code</Text>
              <Text selectable style={[t.title, { color: p.orchestrator, fontSize: 34, letterSpacing: 6 }]}>{info.phone.code}</Text>
              <Text style={[t.small, { color: p.muted }]}>The code works once and changes every 10 minutes. You can find it again in Settings.</Text>
            </>
          ) : (
            <Text style={[t.body, { color: p.muted }]}>
              Finish step 2 first, then install Tailscale on your phone and sign in to the same account. The address and code appear here once this Mac is connected. You can skip this and do it later from Settings.
            </Text>
          )}
        </View>
      </Section>

      {launcher ? (
        <Section title="4. Keep it running">
          <Toggle label="Start the hub when I log in" value={atLogin} onChange={loginItem}
            hint={busy ? "Restarting the hub…" : "Lets your phone reach the room even when this app is closed."} />
        </Section>
      ) : null}

      <Section title={`${launcher ? "5" : "4"}. Crash reports and usage counts (optional)`} hint="Both are off. Turn one on only if you want to help. You can change this any time in Settings.">
        <PrivacyPanel onboarding />
      </Section>

      {info.timer?.startedAt ? (
        <Text style={[t.small, { color: p.muted, marginBottom: space(3) }]}>
          {info.timer.done
            ? `First goal finished ${clock((info.timer.firstGoalDoneAt! - info.timer.startedAt) / 1000)} after you first opened Agent Room${info.timer.firstGoalPractice ? " (with practice agents)" : ""}.`
            : `Setup time so far: ${clock((Date.now() - info.timer.startedAt) / 1000)}. It stops when your first goal finishes.`}
        </Text>
      ) : null}
      <Button label="Open the room" onPress={finish} />
      {!anyReady && !info.practiceMode ? (
        <Text style={[t.small, { color: p.muted, marginTop: space(2) }]}>No agents are signed in yet. You can open the room anyway and connect them from the sidebar.</Text>
      ) : null}
    </ScrollView>
  );
}
