import { useShallow } from "zustand/react/shallow";
import React, { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useRoom } from "../state/store";
import { Button, Screen } from "../components/ui";
import { space, type as t, usePalette } from "../theme";

/**
 * 3.4 The office. The picture is drawn by the hub's own page (web/office.html, three.js with a 2D plan on small machines), shown here in a web view,
 * so the phone and the Mac see the same thing (DECISIONS D7). The page asks for nothing but GET /office and the live socket; the device token reaches
 * it through the web view's start-up script, never through the address. Clicking an agent posts { type: "openAgent", agentId } and this screen opens that DM.
 */
export function OfficeScreen() {
  const p = usePalette();
  const { hub, roomId, rooms, openDm } = useRoom(useShallow((s) => ({ hub: s.hub, roomId: s.roomId, rooms: s.rooms, openDm: s.openDm })));
  const [nonce, setNonce] = useState(0); // "Reload" remounts the view
  const room = rooms.find((r) => r.id === roomId);
  const uri = useMemo(() => {
    if (!hub) return "";
    const q = new URLSearchParams({ embed: "1" });
    if (room && !room.dmAgentId) q.set("roomId", room.id); // a direct message has no goal of its own: show every room
    return `${hub.baseUrl}/web/office.html?${q}`;
  }, [hub, room]);
  const start = useMemo(() => `window.__AGENT_ROOM__ = { token: ${JSON.stringify(hub?.token ?? "")} }; true;`, [hub]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(e.nativeEvent.data) as { type?: string; agentId?: string };
      if (m.type === "openAgent" && typeof m.agentId === "string") void openDm(m.agentId);
    } catch { /* not ours */ }
  };

  return (
    <Screen title="Office" subtitle={room && !room.dmAgentId ? `#${room.name}` : "All rooms"} right={<Button small kind="plain" label="Reload" onPress={() => setNonce(nonce + 1)} />}>
      {uri ? (
        <WebView key={nonce} source={{ uri }} originWhitelist={[`${hub?.baseUrl ?? ""}*`]} injectedJavaScriptBeforeContentLoaded={start} onMessage={onMessage}
          style={{ flex: 1, backgroundColor: p.canvas }} />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space(6) }}>
          <Text style={[t.body, { color: p.muted }]}>Connect to your hub to see the office.</Text>
        </View>
      )}
    </Screen>
  );
}
