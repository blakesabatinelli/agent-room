import React, { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Text, View } from "react-native";
import type { RemoteStatus } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Button, Toggle } from "./ui";
import { space, type as t, usePalette } from "../theme";

const GET_TAILSCALE = "https://tailscale.com/download/mac";
const FUNNEL_HINT = "Lets cloud agents like ChatGPT connectors reach this Mac's agent endpoint. Only /mcp is exposed and every call needs a token.";

/**
 * 1.2: Tailscale status from the hub, with the steps to get it running. Used as onboarding step 2 and as a Settings card
 * (with the Funnel switch). Keeps checking by itself until Tailscale is connected, so nobody has to press Check again.
 */
export function RemoteAccess({ funnel = false }: { funnel?: boolean }) {
  const p = usePalette();
  const hub = useRoom((s) => s.hub);
  const [st, setSt] = useState<RemoteStatus>();
  const [note, setNote] = useState<string>();
  const [approvalUrl, setApprovalUrl] = useState<string>();

  const check = useCallback(async (fresh = true) => {
    if (!hub) return;
    try { setSt(await hub.remoteStatus(fresh)); } catch (e) { setNote((e as Error).message); }
  }, [hub]);
  useEffect(() => { void check(false); }, [check]);
  const state = st?.state;
  useEffect(() => {
    if (state === "running") return;
    const i = setInterval(() => { void check(true); }, 4000);
    return () => clearInterval(i);
  }, [state, check]);

  if (!st) return <View style={{ padding: space(4) }}><Text style={[t.small, { color: p.muted }]}>Checking Tailscale…</Text></View>;

  const openTailscale = async () => {
    try { setNote((await hub!.openTailscale()).message); } catch (e) { setNote((e as Error).message); }
  };
  const applyFunnel = async (on: boolean) => {
    setNote(undefined); setApprovalUrl(undefined);
    try { setSt(await hub!.setFunnel(on)); }
    catch (e) { setNote((e as Error).message); setApprovalUrl((e as Error & { approvalUrl?: string }).approvalUrl); void check(true); }
  };
  const switchFunnel = (on: boolean) => {
    if (!on) return void applyFunnel(false);
    Alert.alert("Turn on Funnel?", `${FUNNEL_HINT} Turn it off any time here.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Turn on", onPress: () => void applyFunnel(true) },
    ]);
  };
  const line = (k: string, v: string) => (
    <View style={{ flexDirection: "row", gap: space(2) }}>
      <Text style={[t.small, { color: p.muted, width: 92 }]}>{k}</Text>
      <Text selectable style={[t.small, { color: p.ink, flex: 1 }]}>{v}</Text>
    </View>
  );

  return (
    <View>
      <View style={{ padding: space(4), gap: space(2) }}>
        {st.state === "not_installed" ? (
          <>
            <Text style={[t.body, { color: p.ink }]}>Tailscale isn't installed on this Mac.</Text>
            <Text style={[t.small, { color: p.muted }]}>
              Agent Room needs it. It's how your phone and other devices reach this Mac privately, and nothing is opened to the internet. Install it, sign in, then check again.
            </Text>
            <View style={{ flexDirection: "row", gap: space(2) }}>
              <Button label="Get Tailscale" onPress={() => { void Linking.openURL(GET_TAILSCALE); }} />
              <Button kind="plain" label="Check again" onPress={() => check(true)} />
            </View>
          </>
        ) : st.state !== "running" ? (
          <>
            <Text style={[t.body, { color: p.ink }]}>{st.state === "needs_login" ? "Tailscale needs you to sign in." : "Tailscale is turned off."}</Text>
            <Text style={[t.small, { color: p.muted }]}>{st.detail} Sign in with the same account on your phone. This page updates when it connects.</Text>
            <View style={{ flexDirection: "row", gap: space(2) }}>
              <Button label="Open Tailscale to sign in" onPress={openTailscale} />
              <Button kind="plain" label="Check again" onPress={() => check(true)} />
            </View>
          </>
        ) : (
          <>
            <Text style={[t.body, { color: p.ok, fontWeight: "700" }]}>{st.detail}</Text>
            {st.dnsName ? line("Name", st.dnsName) : null}
            {st.ip ? line("Address", st.ip) : null}
            {st.hubUrl ? line("Hub", st.hubUrl) : null}
            {!st.dnsName ? <Text style={[t.small, { color: p.muted }]}>MagicDNS is off for this tailnet, so devices connect by address. Turn it on in the Tailscale admin console for a name that never changes.</Text> : null}
          </>
        )}
        {note ? <Text style={[t.small, { color: p.muted }]}>{note}</Text> : null}
        {approvalUrl ? <View style={{ flexDirection: "row" }}><Button kind="plain" small label="Open Tailscale admin console" onPress={() => { void Linking.openURL(approvalUrl); }} /></View> : null}
      </View>
      {funnel && st.state === "running" ? (
        <>
          <Toggle label="Cloud agents (Tailscale Funnel)" value={st.funnel.on} onChange={switchFunnel} hint={FUNNEL_HINT} />
          <View style={{ paddingHorizontal: space(4), paddingBottom: space(4), gap: space(1) }}>
            {st.funnel.on && st.funnel.url ? line("Public address", st.funnel.url) : <Text style={[t.small, { color: p.muted }]}>Off. Nothing on this Mac is reachable from the internet.</Text>}
            {st.funnel.drift === "on_in_tailscale" ? <Text style={[t.small, { color: p.danger }]}>Funnel is on in Tailscale, but you haven't turned it on here. It was switched on outside Agent Room. Switch it off here to close it.</Text> : null}
            {st.funnel.drift === "off_in_tailscale" ? <Text style={[t.small, { color: p.warn }]}>You switched Funnel on here, but Tailscale has it off now. Switch it off and on again to restore it.</Text> : null}
            {st.funnel.extraPaths.length ? <Text style={[t.small, { color: p.danger }]}>Funnel is also exposing {st.funnel.extraPaths.join(", ")} on this Mac. Run "tailscale funnel reset" in Terminal to close it.</Text> : null}
          </View>
        </>
      ) : null}
    </View>
  );
}
