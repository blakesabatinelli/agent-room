import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { CrashList, PrivacyState, TelemetryPayload } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Button, CodeBlock, Toggle } from "./ui";
import { space, type as t, usePalette } from "../theme";

/**
 * 4.7 Crash reports and usage counts. Both switches start OFF. Nothing leaves this Mac unless a switch is on AND the build has a report
 * endpoint (AGENT_ROOM_REPORT_URL); without one the switches only say so. "See what would be sent" shows the exact JSON.
 * Used as an onboarding step (`onboarding`: shorter) and as a Settings section.
 */
export function PrivacyPanel({ onboarding = false }: { onboarding?: boolean }) {
  const p = usePalette();
  const hub = useRoom((s) => s.hub);
  const [st, setSt] = useState<PrivacyState>();
  const [preview, setPreview] = useState<TelemetryPayload>();
  const [crashes, setCrashes] = useState<CrashList>();
  const [note, setNote] = useState<string>();

  const load = useCallback(async () => {
    if (!hub) return;
    try { setSt(await hub.privacy()); } catch (e) { setNote((e as Error).message); }
    if (!onboarding) hub.crashes().then(setCrashes).catch(() => {});
  }, [hub, onboarding]);
  useEffect(() => { void load(); }, [load]);

  if (!st) return <View style={{ padding: space(4) }}><Text style={[t.small, { color: p.muted }]}>Loading…</Text></View>;

  const save = async (patch: { crashReports?: boolean; telemetry?: boolean; updateChecks?: boolean }) => {
    setNote(undefined);
    try { setSt(await hub!.savePrivacy(patch)); if (preview && patch.telemetry === false) setPreview(undefined); } catch (e) { setNote((e as Error).message); }
  };
  const noEndpoint = "This build has no place to send reports to, so nothing can be sent even with the switch on.";
  const where = st.endpointConfigured ? `Reports would go to ${st.endpointHost} and nowhere else.` : noEndpoint;
  const showPreview = async () => {
    try { setPreview((await hub!.telemetryPreview()).payload); } catch (e) { setNote((e as Error).message); }
  };
  const hasNew = (crashes?.mac ?? []).some((m) => m.isNew);

  return (
    <View>
      <View style={{ padding: space(4), gap: space(1) }}>
        <Text style={[t.small, { color: p.muted }]}>
          Both are off until you turn them on. They never include what you write, your goals, files, agent or room names, paths, emails or keys. {where}
        </Text>
      </View>
      <Toggle label="Send crash reports" value={st.crashReports} onChange={(v) => save({ crashReports: v })}
        hint="When the hub crashes, send the error's code location, the app and macOS versions. No messages, prompts or file contents. Reports are kept on this Mac either way." />
      <Toggle label="Share usage counts" value={st.telemetry} onChange={(v) => save({ telemetry: v })}
        hint="One small batch a week of counts only, listed below. Nothing is sent the first week." />
      <View style={{ padding: space(4), gap: space(2) }}>
        <Text style={[t.small, { color: p.ink, fontWeight: "700" }]}>Exactly what a weekly batch holds</Text>
        {st.telemetryFields.map((f) => (
          <Text key={f.key} style={[t.small, { color: p.muted }]}>{`${f.label}. For example ${f.example}.`}</Text>
        ))}
        <View style={{ flexDirection: "row", gap: space(2) }}>
          <Button small kind="plain" label={preview ? "Refresh" : "See what would be sent"} onPress={showPreview} />
          {preview ? <Button small kind="ghost" label="Hide" onPress={() => setPreview(undefined)} /> : null}
        </View>
        {preview ? <CodeBlock label="The next batch, exactly as it would be sent" text={JSON.stringify(preview, null, 2)} /> : null}
        {st.telemetryLastSentAt ? <Text style={[t.small, { color: p.muted }]}>Last sent {new Date(st.telemetryLastSentAt).toLocaleDateString()}.</Text> : null}
        {st.telemetry && st.endpointConfigured && st.telemetryNextAt ? <Text style={[t.small, { color: p.muted }]}>Next batch on or after {new Date(st.telemetryNextAt).toLocaleDateString()}.</Text> : null}
      </View>
      {!onboarding ? (
        <>
          <Toggle label="Check for updates automatically" value={st.updateChecks} onChange={(v) => save({ updateChecks: v })}
            hint="Reads the list of versions from the update address, once a day. Sends only the request itself and your Agent Room version." />
          <View style={{ padding: space(4), gap: space(2) }}>
            <Text style={[t.small, { color: p.ink, fontWeight: "700" }]}>Crashes on this Mac</Text>
            {crashes ? (
              <>
                {crashes.hub.length === 0 && crashes.mac.length === 0 ? <Text style={[t.small, { color: p.muted }]}>None.</Text> : null}
                {crashes.hub.slice(0, 5).map((c) => (
                  <Text key={c.name} style={[t.small, { color: p.muted }]} numberOfLines={2}>{`${new Date(c.at).toLocaleString()}, hub: ${c.message}${c.sent ? " (sent)" : ""}`}</Text>
                ))}
                {crashes.mac.length ? <Text style={[t.small, { color: hasNew ? p.warn : p.muted }]}>{`${crashes.mac.length} macOS crash report${crashes.mac.length === 1 ? "" : "s"} for Agent Room${hasNew ? ", some new since you last looked" : ""}. They are in ${crashes.macDir}. They hold more than ours do, so they are only listed here and never sent. Attach one to a bug report yourself if you want to.`}</Text> : null}
                <View style={{ flexDirection: "row", gap: space(2) }}>
                  {crashes.mac.length ? <Button small kind="plain" label="Mark as seen" onPress={async () => { await hub!.crashesSeen().catch(() => {}); void load(); }} /> : null}
                  {crashes.hub.length ? <Button small kind="plain" label="Delete the hub's crash reports" onPress={async () => { await hub!.clearCrashes().catch(() => {}); void load(); }} /> : null}
                </View>
              </>
            ) : <Text style={[t.small, { color: p.muted }]}>Loading…</Text>}
          </View>
        </>
      ) : null}
      {note ? <View style={{ paddingHorizontal: space(4), paddingBottom: space(3) }}><Text style={[t.small, { color: p.danger }]}>{note}</Text></View> : null}
    </View>
  );
}
