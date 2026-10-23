import React, { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import type { SignInView } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Button, Field } from "./ui";
import { space, type as t, usePalette } from "../theme";

const ACTIVE = ["installing", "starting", "waiting"];

/**
 * 1.7: signing a CLI agent in without leaving the app. The hub runs the CLI's own login headless, and this shows the
 * sign-in page or one-time code it printed, with a live status. Terminal stays as the fallback button.
 * Used by the welcome screen and by Agents & connections.
 */
export function SignInPanel({ agentId, adapter, ready, notInstalled, onChanged }: {
  agentId: string; adapter: string; ready: boolean; notInstalled?: boolean; onChanged?: () => void;
}) {
  const p = usePalette();
  const hub = useRoom((s) => s.hub);
  const [view, setView] = useState<SignInView>();
  const [note, setNote] = useState<string>();
  const [pasted, setPasted] = useState("");
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const active = !!view && ACTIVE.includes(view.state);
  const viaTerminal = !!view?.terminal;

  // While a sign-in runs, ask the hub how it's going. A Terminal sign-in can't be asked, so keep re-checking the agent instead.
  useEffect(() => {
    if (!hub || !(active || viaTerminal)) return;
    let n = 0;
    const i = setInterval(async () => {
      n++;
      if (viaTerminal) { changed.current?.(); if (n > 60) clearInterval(i); return; }
      try {
        const v = await hub.signInState(agentId);
        setView(v);
        if (v.state === "done") changed.current?.();
      } catch (e) { setNote((e as Error).message); }
    }, viaTerminal ? 3000 : 1500);
    return () => clearInterval(i);
  }, [hub, agentId, active, viaTerminal]);
  useEffect(() => { if (ready && viaTerminal) setView(undefined); }, [ready, viaTerminal]);

  const start = useCallback(async (mode?: "browser" | "device" | "terminal") => {
    if (!hub) return;
    setNote(undefined); setPasted("");
    try {
      const v = await hub.signIn(agentId, { mode, force: ready });
      setView(v);
      if (mode === "terminal") setNote(v.message);
    } catch (e) { setNote((e as Error).message); }
  }, [hub, agentId, ready]);
  const cancel = async () => { try { setView(await hub!.signInCancel(agentId)); } catch (e) { setNote((e as Error).message); } };
  const sendCode = async () => { try { setView(await hub!.signInCode(agentId, pasted.trim())); setPasted(""); } catch (e) { setNote((e as Error).message); } };
  const open = () => { if (view?.url) void Linking.openURL(view.url); };

  const host = view?.url ? new URL(view.url).host : "";
  return (
    <View style={{ gap: space(2) }}>
      {!active ? (
        <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap", alignItems: "center" }}>
          <Button kind={ready ? "plain" : "primary"} label={view?.state === "failed" ? "Try again" : notInstalled ? "Install and sign in" : ready ? "Sign in again" : "Sign in"} onPress={() => start()} />
          {!viaTerminal ? <Button kind="ghost" small label="Sign in with Terminal instead" onPress={() => start("terminal")} /> : null}
        </View>
      ) : null}

      {view && (active || view.state === "failed" || view.state === "done") && !viaTerminal ? (
        <View style={{ gap: space(2) }}>
          <Text style={[t.small, { color: view.state === "done" ? p.ok : view.state === "failed" ? p.danger : p.muted }]}>{view.message}</Text>
          {active && view.code ? (
            <Text selectable style={[t.title, { color: p.orchestrator, fontSize: 30, letterSpacing: 4 }]}>{view.code}</Text>
          ) : null}
          {active && view.url ? (
            <View style={{ flexDirection: "row", gap: space(2), alignItems: "center", flexWrap: "wrap" }}>
              <Button label="Open sign-in page" onPress={open} />
              <Text style={[t.tiny, { color: p.faint }]}>{host}</Text>
            </View>
          ) : null}
          {active && view.needsPaste ? (
            <View>
              <Field label="Code from the browser" value={pasted} onChangeText={setPasted} autoCorrect={false} onSubmitEditing={sendCode} />
              <Button kind="plain" label="Send code" disabled={!pasted.trim()} onPress={sendCode} />
            </View>
          ) : null}
          {active ? (
            <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
              {adapter === "codex" && view.method !== "device" ? <Button kind="ghost" small label="Use a code instead" onPress={async () => { await cancel(); void start("device"); }} /> : null}
              <Button kind="ghost" small label="Cancel" onPress={cancel} />
              <Button kind="ghost" small label="Sign in with Terminal instead" onPress={async () => { await cancel(); void start("terminal"); }} />
            </View>
          ) : null}
        </View>
      ) : null}
      {note ? <Text style={[t.small, { color: p.muted }]}>{note}</Text> : null}
    </View>
  );
}
