import React, { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import type { VersionInfo } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { launcher } from "../native/hub";
import { LEGAL } from "../legal";
import { Button } from "./ui";
import { space, type as t, usePalette } from "../theme";

/** 4.7 About: the version, "Check for updates", and the licence terms and privacy notice (linked once the owner has published the final ones). */
export function About() {
  const p = usePalette();
  const hub = useRoom((s) => s.hub);
  const [v, setV] = useState<VersionInfo>();
  const [sparkle, setSparkle] = useState(false);
  const [msg, setMsg] = useState<string>();
  useEffect(() => {
    hub?.version().then(setV).catch(() => {});
    launcher?.updaterAvailable?.().then(setSparkle).catch(() => {});
  }, [hub]);

  const check = async () => {
    setMsg(undefined);
    if (sparkle && launcher?.checkForUpdates) { launcher.checkForUpdates(); return; }
    try {
      const r = await hub!.checkVersion();
      setV(r);
      setMsg(!r.feedConfigured ? "This build has no update address, so it can't check." : r.error ? r.error : r.update ? `Version ${r.update.version} is available.` : "You have the latest version.");
    } catch (e) { setMsg((e as Error).message); }
  };
  const link = (label: string, url?: string) => url
    ? <Button small kind="plain" label={label} onPress={() => { void Linking.openURL(url); }} />
    : <Text style={[t.small, { color: p.muted }]}>{`${label}: draft, awaiting legal review. Not final yet.`}</Text>;

  return (
    <View style={{ padding: space(4), gap: space(2) }}>
      <Text style={[t.body, { color: p.ink }]}>{`Agent Room ${v?.version ?? ""}`}</Text>
      {v ? <Text style={[t.small, { color: p.muted }]}>{`macOS ${v.macos}`}</Text> : null}
      <View style={{ flexDirection: "row", gap: space(2), alignItems: "center" }}>
        <Button small kind="plain" label="Check for updates" onPress={check} />
        {msg ? <Text style={[t.small, { color: p.muted, flex: 1 }]}>{msg}</Text> : null}
      </View>
      <View style={{ gap: space(1) }}>
        {link("Licence terms", LEGAL.eulaUrl)}
        {link("Privacy notice", LEGAL.privacyUrl)}
      </View>
    </View>
  );
}
