import { useShallow } from "zustand/react/shallow";
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { LeaseView, PolicyRuleView, PolicyState } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Button, Empty, Pill, Screen, Section } from "../components/ui";
import { space, type as t, usePalette } from "../theme";

/** "12m 04s left", "3h 20m left", "2d 4h left". */
export function leftWords(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s left`;
  const hr = Math.floor(m / 60);
  return hr < 24 ? `${hr}h ${m % 60}m left` : `${Math.floor(hr / 24)}d ${hr % 24}h left`;
}

const EFFECTS: PolicyRuleView["effect"][] = ["allow", "ask", "deny"];

/** 4.2: the approval rules the hub learned from your approvals, the rules you wrote, and permissions that end by themselves. */
export function PolicyScreen() {
  const p = usePalette();
  const { hub, controlStamp, setError } = useRoom(useShallow((s) => ({ hub: s.hub, controlStamp: s.controlStamp, setError: s.setError })));
  const [state, setState] = useState<PolicyState | undefined>();
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => { hub?.policy().then(setState).catch((e: Error) => setError(e.message)); }, [hub, setError]);
  useEffect(load, [load, controlStamp]);
  // The countdown: one tick a second, only while this screen is open.
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); load(); } catch (e) { setError((e as Error).message); }
  };

  const proposals = state?.rules.filter((r) => r.kind === "learned" && !r.accepted) ?? [];
  const mine = state?.rules.filter((r) => r.kind === "owner") ?? [];
  const accepted = state?.rules.filter((r) => r.kind === "learned" && r.accepted) ?? [];

  const rule = (r: PolicyRuleView, pending: boolean) => (
    <View key={r.id} style={{ gap: space(2), paddingVertical: space(3), borderBottomWidth: 1, borderColor: p.line }}>
      <Text style={[t.body, { color: p.ink }]}>{r.text}</Text>
      <View style={{ flexDirection: "row", gap: space(2), alignItems: "center", flexWrap: "wrap" }}>
        <Pill text={r.effect} color={r.effect === "deny" ? p.danger : r.effect === "allow" ? p.accent : p.muted} />
        {pending ? <Button small label="Accept" onPress={() => void run(() => hub!.acceptRule(r.id))} /> : null}
        {r.kind === "learned" ? EFFECTS.filter((e) => e !== r.effect).map((e) => (
          <Button key={e} small kind="plain" label={`Make it ${e}`} onPress={() => void run(() => hub!.editRule(r.id, { effect: e }))} />
        )) : null}
        {r.kind === "learned" ? <Button small kind="ghost" label="Delete" onPress={() => void run(() => hub!.deleteRule(r.id))} /> : null}
      </View>
    </View>
  );

  const lease = (l: LeaseView) => (
    <View key={l.id} style={{ gap: space(2), paddingVertical: space(3), borderBottomWidth: 1, borderColor: p.line }}>
      <Text style={[t.body, { color: p.ink }]}>{l.text}</Text>
      <View style={{ flexDirection: "row", gap: space(3), alignItems: "center" }}>
        <Text style={[t.small, { color: p.muted }]}>{leftWords(l.expiresAt - now)}</Text>
        <Button small kind="plain" label="Revoke" onPress={() => void run(() => hub!.revokeLease(l.id))} />
      </View>
    </View>
  );

  return (
    <Screen title="Approval rules" subtitle={state?.pending ? `${state.pending} to review` : "What the hub may do without asking"}
      right={<Button kind="plain" small label="Edit POLICY.md" onPress={() => void run(() => hub!.openPolicyFile())} />}>
      <ScrollView contentContainerStyle={{ padding: space(4) }}>
        {!state ? <Empty text="Loading…" /> : null}
        {state && !state.ok ? <Empty text={state.problem ?? "POLICY.md can't be read. Fix it, then come back."} /> : null}
        {proposals.length ? <Section title={`To review (${proposals.length})`} hint="Proposed from your approvals. Nothing here applies until you accept it.">{proposals.map((r) => rule(r, true))}</Section> : null}
        {state?.leases.length ? <Section title="Active leases" hint="Permissions that end by themselves.">{state.leases.map(lease)}</Section> : null}
        {mine.length ? <Section title="Your rules">{mine.map((r) => rule(r, false))}</Section> : null}
        {accepted.length ? <Section title="Accepted from your approvals">{accepted.map((r) => rule(r, false))}</Section> : null}
        {state?.ok && !state.rules.length && !state.leases.length ? <Empty text="No rules yet. When you approve the same kind of thing a few times, the hub offers a rule here." /> : null}
      </ScrollView>
    </Screen>
  );
}
