import { useShallow } from "zustand/react/shallow";
import React, { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { ROLES, SUGGESTED_PROFILES, type AgentConfig, type Effort, type Profile } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Button } from "./ui";
import { radius, space, type as t, usePalette } from "../theme";

const EFFORTS: (Effort | undefined)[] = [undefined, "low", "medium", "high", "xhigh", "max"];
const TIERS: Profile["tier"][] = [1, 2, 3];
const TIER_LABEL = { 1: "Cheap", 2: "Standard", 3: "Strongest" } as const;

function Chips<T>({ options, value, label, onPick }: { options: T[]; value: T; label: (v: T) => string; onPick: (v: T) => void }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1) }}>
      {options.map((o, i) => {
        const on = o === value;
        return (
          <Pressable key={i} onPress={() => onPick(o)} accessibilityRole="button" accessibilityState={{ selected: on }}
            style={{ paddingHorizontal: space(2), paddingVertical: 3, borderRadius: radius.sm, borderWidth: 1, borderColor: on ? p.accent : p.line, backgroundColor: on ? p.accent : "transparent" }}>
            <Text style={[t.tiny, { color: on ? p.onAccent : p.muted, fontWeight: on ? "700" : "400" }]}>{label(o)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Ways to run an agent: role, model, effort and cost tier. The orchestrator picks the cheapest
 * profile that fits each task's role and moves up a tier when work fails twice.
 */
export function Profiles({ a }: { a: AgentConfig }) {
  const p = usePalette();
  const { hub } = useRoom(useShallow((s) => ({ hub: s.hub })));
  const [list, setList] = useState<Profile[]>(a.profiles ?? []);
  const [err, setErr] = useState<string>();
  const save = async (next: Profile[]) => {
    setList(next);
    try { setErr(undefined); await hub?.updateAgent(a.id, { profiles: next }); } catch (e) { setErr((e as Error).message); }
  };
  const edit = (i: number, patch: Partial<Profile>, persist = true) => {
    const next = list.map((x, j) => (j === i ? { ...x, ...patch } : x));
    if (persist) void save(next); else setList(next);
  };
  const suggested = SUGGESTED_PROFILES[a.provider];
  const input = { color: p.ink, borderWidth: 1, borderColor: p.line, borderRadius: radius.md, paddingHorizontal: space(2), paddingVertical: space(1.5), backgroundColor: p.canvas };

  return (
    <View style={{ gap: space(3) }}>
      <View style={{ gap: 2 }}>
        <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]}>Ways to run {a.name}</Text>
        <Text style={[t.small, { color: p.muted }]}>
          Each task gets the cheapest profile that fits its role. If work fails twice, the next try moves up a tier.
          {list.length ? "" : ` With none set, ${a.name} always runs on ${String(a.settings.model ?? "its default model")}.`}
        </Text>
      </View>
      {list.map((pr, i) => (
        <View key={pr.id} style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, padding: space(3), gap: space(2) }}>
          <View style={{ flexDirection: "row", gap: space(2), alignItems: "center" }}>
            <TextInput value={pr.label} onChangeText={(v) => edit(i, { label: v }, false)} onEndEditing={() => void save(list)}
              accessibilityLabel="Profile name" style={[t.body, input, { flex: 1, fontWeight: "700" }]} />
            <Button small kind="ghost" label="Remove" onPress={() => void save(list.filter((_, j) => j !== i))} />
          </View>
          <Chips options={ROLES.map((r) => r.id)} value={pr.role} label={(r) => ROLES.find((x) => x.id === r)!.label} onPick={(role) => edit(i, { role })} />
          <Text style={[t.tiny, { color: p.faint }]}>{ROLES.find((r) => r.id === pr.role)?.hint}</Text>
          <TextInput value={pr.model ?? ""} placeholder="Model, e.g. claude-opus-5-5 or gpt-5.6-luna" placeholderTextColor={p.faint}
            onChangeText={(v) => edit(i, { model: v || undefined }, false)} onEndEditing={() => void save(list)}
            autoCapitalize="none" autoCorrect={false} accessibilityLabel="Model" style={[t.small, input, { fontFamily: "Menlo" }]} />
          <View style={{ gap: space(1) }}>
            <Text style={[t.tiny, { color: p.muted }]}>Effort</Text>
            <Chips options={EFFORTS} value={pr.effort} label={(e) => e ?? "default"} onPick={(effort) => edit(i, { effort })} />
          </View>
          <View style={{ gap: space(1) }}>
            <Text style={[t.tiny, { color: p.muted }]}>Cost tier</Text>
            <Chips options={TIERS} value={pr.tier} label={(x) => `${x} · ${TIER_LABEL[x]}`} onPick={(tier) => edit(i, { tier })} />
          </View>
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
        <Button small kind="plain" label="Add a profile" onPress={() => void save([...list, { id: `p-${Date.now().toString(36)}`, label: "New profile", role: "worker", tier: 2 }])} />
        {suggested && !list.length ? <Button small label="Use the suggested set" onPress={() => void save(suggested)} /> : null}
      </View>
      {err ? <Text style={[t.small, { color: p.danger }]}>{err}</Text> : null}
    </View>
  );
}
