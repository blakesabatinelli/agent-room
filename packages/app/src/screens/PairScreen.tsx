import React, { useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { useRoom } from "../state/store";
import { Button, Field } from "../components/ui";
import { space, type as t, usePalette } from "../theme";

export function PairScreen() {
  const p = usePalette();
  const pair = useRoom((s) => s.pair);
  const [url, setUrl] = useState(Platform.OS === "macos" ? "http://127.0.0.1:4747" : "http://");
  const [code, setCode] = useState("");
  const [name, setName] = useState(Platform.OS === "macos" ? "Mac" : "iPhone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setBusy(true); setError(undefined);
    try { await pair(url, code, name); } catch (e) { setError(`${(e as Error).message} Check the hub address and the code it printed.`); }
    finally { setBusy(false); }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: p.canvas }} contentContainerStyle={{ padding: space(8), maxWidth: 520, width: "100%", alignSelf: "center" }}>
      <Text style={[t.title, { color: p.ink, marginBottom: space(2) }]}>Connect to your hub</Text>
      <Text style={[t.body, { color: p.muted, marginBottom: space(6) }]}>
        Start the hub on your Mac, then enter its address and the six-digit code it shows.
        {Platform.OS === "macos" ? "" : " From your phone, use the Mac's Tailscale address."}
      </Text>
      <Field label="Hub address" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Field label="Pairing code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} />
      <Field label="Name for this device" value={name} onChangeText={setName} />
      {error ? <Text style={[t.small, { color: p.danger, marginBottom: space(3) }]}>{error}</Text> : null}
      <Button label={busy ? "Connecting…" : "Connect"} onPress={submit} disabled={busy || code.length !== 6} />
    </ScrollView>
  );
}
