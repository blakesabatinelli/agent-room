import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useState } from "react";
import { Pressable, SafeAreaView, StatusBar, Text, View, useWindowDimensions } from "react-native";
import { useRoom } from "./state/store";
import { PairScreen } from "./screens/PairScreen";
import { RoomScreen } from "./screens/RoomScreen";
import { ApprovalsScreen } from "./screens/ApprovalsScreen";
import { AgentsScreen } from "./screens/AgentsScreen";
import { PermissionsScreen } from "./screens/PermissionsScreen";
import { FoldersScreen } from "./screens/FoldersScreen";
import { MemoryScreen } from "./screens/MemoryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui";
import { launcher } from "./native/hub";
import { space, type as t, usePalette } from "./theme";

export default function App() {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const { hub, restore, error, setError, onboarded, startupError, view } = useRoom(useShallow((s) => ({ hub: s.hub, restore: s.restore, error: s.error, setError: s.setError, onboarded: s.onboarded, startupError: s.startupError, view: s.view })));
  const [ready, setReady] = useState(false);
  const [showList, setShowList] = useState(true); // phone: sidebar is the home screen
  useEffect(() => { restore().finally(() => setReady(true)); }, []);

  if (!ready) return (
    <View style={{ flex: 1, backgroundColor: p.sidebar, alignItems: "center", justifyContent: "center", gap: space(2) }}>
      <Text style={[t.title, { color: p.inkStrong }]}>Agent Room</Text>
      <Text style={[t.small, { color: p.sidebarMuted }]}>{launcher ? "Starting your hub…" : "Loading…"}</Text>
    </View>
  );
  if (startupError) return (
    <View style={{ flex: 1, backgroundColor: p.canvas, alignItems: "center", justifyContent: "center", padding: space(8), gap: space(4) }}>
      <Text style={[t.title, { color: p.inkStrong }]}>Agent Room couldn't start</Text>
      <Text selectable style={[t.body, { color: p.muted, maxWidth: 520, textAlign: "center" }]}>{startupError}</Text>
      <Button label="Try again" onPress={() => { setReady(false); restore().finally(() => setReady(true)); }} />
    </View>
  );
  if (!hub) return <PairScreen />;
  if (!onboarded) return <OnboardingScreen />;

  const wide = width >= 700;
  const back = wide ? undefined : () => setShowList(true);
  const main = view.kind === "room" ? <RoomScreen onBack={back} /> : {
    agents: <AgentsScreen onBack={back} />, approvals: <ApprovalsScreen />, memory: <MemoryScreen />,
    permissions: <PermissionsScreen />, folders: <FoldersScreen />, settings: <SettingsScreen />,
  }[view.page];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: wide ? p.canvas : p.sidebar }}>
      <StatusBar barStyle="dark-content" />
      {error ? (
        <Pressable onPress={() => setError(undefined)} style={{ backgroundColor: p.danger, paddingVertical: space(2), paddingHorizontal: space(4) }}>
          <Text style={[t.small, { color: p.onAccent, fontWeight: "600" }]}>{error} (click to dismiss)</Text>
        </Pressable>
      ) : null}
      {wide ? (
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ width: 260 }}><Sidebar /></View>
          <View style={{ flex: 1 }}>{main}</View>
        </View>
      ) : showList ? <Sidebar onNavigate={() => setShowList(false)} /> : (
        <View style={{ flex: 1, backgroundColor: p.canvas }}>
          {view.kind === "page" && view.page !== "agents" ? (
            <Pressable onPress={() => setShowList(true)} style={{ padding: space(3) }}><Text style={[t.small, { color: p.link }]}>‹ Back</Text></Pressable>
          ) : null}
          {main}
        </View>
      )}
    </SafeAreaView>
  );
}
