import { useShallow } from "zustand/react/shallow";
import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { DiscoveryState, McpInvite } from "@agent-room/shared";
import type { HermesConnectResult } from "../api/client";
import { useRoom } from "../state/store";
import { Button, CodeBlock, Toggle } from "./ui";
import { radius, space, type as t, usePalette } from "../theme";

/**
 * 1.3: what the hub found on this Mac ("Found: Claude Code (signed in), Codex (signed in), Hermes, llama.cpp with ..."),
 * a way to look again, the "Connect automatically" switch for Hermes, and the one-step invite for Muse.
 */
export function Discovery({ invite = true }: { invite?: boolean }) {
  const p = usePalette();
  const { hub, agents } = useRoom(useShallow((s) => ({ hub: s.hub, agents: s.agents })));
  const [state, setState] = useState<DiscoveryState>();
  const [busy, setBusy] = useState(false);
  const [hermes, setHermes] = useState<HermesConnectResult>();
  const [inv, setInv] = useState<McpInvite>();
  const [err, setErr] = useState<string>();

  useEffect(() => { hub?.discovery().then(setState).catch(() => {}); }, [hub]);
  const look = useCallback(async () => {
    setBusy(true); setErr(undefined);
    try { setState(await hub!.runDiscovery()); void useRoom.getState().refreshStatus(true); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [hub]);
  const auto = async (v: boolean) => { try { setState(await hub!.saveDiscoverySettings(v)); if (v) await look(); } catch (e) { setErr((e as Error).message); } };
  const connect = async () => { try { setErr(undefined); setHermes(await hub!.connectHermes()); } catch (e) { setErr((e as Error).message); } };
  const askInvite = async () => { try { setErr(undefined); setInv(await hub!.invite("muse")); } catch (e) { setErr((e as Error).message); } };

  const last = state?.last;
  const hasHermes = agents.some((a) => a.id === "hermes") && !!last?.agents.some((a) => a.id === "hermes" && a.installed);
  const applied = last?.applied?.hermes;
  const shown = hermes ?? applied;

  return (
    <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.xl, backgroundColor: p.surface, overflow: "hidden" }}>
      <View style={{ padding: space(4), gap: space(2) }}>
        <Text style={[t.body, { color: p.inkStrong, fontWeight: "700" }]}>{last ? last.summary : "Looking at this Mac…"}</Text>
        <Text style={[t.small, { color: p.muted }]}>
          Agents it finds are added by themselves. Ones you switched off stay off.
        </Text>
        <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
          <Button small kind="plain" label={busy ? "Looking…" : "Look again"} onPress={look} disabled={busy} />
          {invite ? <Button small kind="plain" label="Invite Muse" onPress={askInvite} /> : null}
          {hasHermes ? <Button small kind="plain" label="Connect Hermes" onPress={connect} /> : null}
        </View>
        {err ? <Text style={[t.small, { color: p.danger }]}>{err}</Text> : null}
      </View>

      {hasHermes ? (
        <Toggle label="Connect Hermes automatically" value={state?.settings.connectAutomatically ?? true} onChange={auto}
          hint="Adds Agent Room to Hermes's own config and keeps a backup of the file." />
      ) : null}
      {hasHermes && shown ? (
        <View style={{ padding: space(4), gap: space(2), borderTopWidth: 1, borderColor: p.line }}>
          <Text style={[t.small, { color: shown.status === "failed" ? p.danger : p.muted }]}>{shown.detail}</Text>
          {hermes?.status === "failed" ? <CodeBlock label="Paste this into Hermes's config.yaml" text={hermes.snippet} /> : null}
        </View>
      ) : null}

      {inv ? (
        <View style={{ padding: space(4), gap: space(2), borderTopWidth: 1, borderColor: p.line }}>
          <Text style={[t.small, { color: p.muted }]}>Give this to {inv.name} on its own device. It is the only step.</Text>
          <CodeBlock label={`Invite for ${inv.name}`} text={inv.block} />
        </View>
      ) : null}
    </View>
  );
}
