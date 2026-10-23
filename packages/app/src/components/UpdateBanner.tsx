import React, { useCallback, useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import type { VersionInfo } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { launcher } from "../native/hub";
import { Button } from "./ui";
import { space, type as t, usePalette } from "../theme";

/**
 * 4.7 "A new version is available", fed by the hub (it reads the appcast). Nothing shows unless the appcast offers something newer.
 * "Update" opens Sparkle's own window when this build has Sparkle; otherwise it opens the download address. The hub only reads the
 * appcast; Sparkle downloads and installs, after checking the update's signature.
 */
export function UpdateBanner() {
  const p = usePalette();
  const hub = useRoom((s) => s.hub);
  const [v, setV] = useState<VersionInfo>();
  const [hidden, setHidden] = useState<string>();
  const [sparkle, setSparkle] = useState(false);
  const load = useCallback(() => { hub?.version().then(setV).catch(() => {}); }, [hub]);
  useEffect(() => {
    load();
    launcher?.updaterAvailable?.().then(setSparkle).catch(() => {});
    const i = setInterval(load, 30 * 60_000); // the hub checks daily; this just picks up what it found
    return () => clearInterval(i);
  }, [load]);

  const u = v?.update;
  if (!u || hidden === u.version) return null;
  const update = () => {
    if (sparkle && launcher?.checkForUpdates) launcher.checkForUpdates();
    else if (u.downloadUrl) void Linking.openURL(u.downloadUrl);
  };
  return (
    <View accessibilityRole="alert" style={{ flexDirection: "row", alignItems: "center", gap: space(3), backgroundColor: p.sunken, borderBottomWidth: 1, borderColor: p.line, paddingVertical: space(2), paddingHorizontal: space(4) }}>
      <Text style={[t.small, { color: p.ink, flex: 1 }]}>
        {`Agent Room ${u.shortVersion ?? u.version} is available. You have ${v!.version}.`}
      </Text>
      {u.notesUrl ? <Button small kind="ghost" label="What's new" onPress={() => { void Linking.openURL(u.notesUrl!); }} /> : null}
      {sparkle || u.downloadUrl ? <Button small label={sparkle ? "Update" : "Download"} onPress={update} /> : null}
      <Button small kind="ghost" label="Later" onPress={() => setHidden(u.version)} />
    </View>
  );
}
