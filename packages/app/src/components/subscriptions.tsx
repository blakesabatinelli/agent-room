import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { QuotaWindowStatus, Subscription, SubscriptionStatus } from "@agent-room/shared";
import type { Hub } from "../api/client";
import { Button, Field, Pill } from "./ui";
import { space, type as t, usePalette } from "../theme";

/** 1.6 Subscriptions: each plan's 5-hour and weekly usage, reset times, and the owner's limits. */
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
const num = (s: string) => { const n = Math.round(Number(s.replace(/[, ]/g, ""))); return Number.isFinite(n) && n > 0 ? n : undefined; };

function Bar({ w, label }: { w: QuotaWindowStatus; label: string }) {
  const p = usePalette();
  const known = w.headroom !== undefined;
  const used = known ? 1 - w.headroom! : 0;
  const detail = known
    ? [w.limitRuns ? `${w.usedRuns} of ${w.limitRuns} runs` : "", w.limitTokens ? `${k(w.usedTokens)} of ${k(w.limitTokens)} tokens` : ""].filter(Boolean).join(", ") + (w.limitSource === "learned" ? " (learned)" : "")
    : `learning, ${w.usedRuns} runs so far`;
  return (
    <View style={{ gap: space(1) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
        <Text style={[t.small, { color: p.muted, width: 56 }]}>{label}</Text>
        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: p.line, overflow: "hidden" }}>
          <View style={{ width: `${Math.round(used * 100)}%`, height: 6, backgroundColor: used >= 0.9 ? p.warn : p.accent }} />
        </View>
      </View>
      <Text style={[t.tiny, { color: p.muted, marginLeft: 56 + space(2) }]}>{detail}{w.usedRuns ? `, resets ${when(w.resetsAt)}` : ""}</Text>
    </View>
  );
}

function Limits({ sub, onSave }: { sub: Subscription; onSave: (s: Subscription) => void }) {
  const win = (id: "fiveHour" | "weekly", key: "limitRuns" | "limitTokens") => String(sub.windows[id]?.[key] ?? "");
  const set = (id: "fiveHour" | "weekly", key: "limitRuns" | "limitTokens", text: string) => {
    const w = { ...(sub.windows[id] ?? {}) }; const v = num(text);
    if (v === undefined) delete w[key]; else w[key] = v;
    onSave({ ...sub, windows: { ...sub.windows, [id]: Object.keys(w).length ? w : undefined } });
  };
  return (
    <View style={{ gap: space(1), marginTop: space(2) }}>
      <Field label="Plan" defaultValue={sub.plan ?? ""} placeholder="for example, Max 5x" onEndEditing={(e) => onSave({ ...sub, plan: e.nativeEvent.text.trim() || undefined })} />
      <Field label="Runs per 5 hours" defaultValue={win("fiveHour", "limitRuns")} keyboardType="number-pad" hint="Leave empty to let the room learn it from rate limits" onEndEditing={(e) => set("fiveHour", "limitRuns", e.nativeEvent.text)} />
      <Field label="Tokens per 5 hours" defaultValue={win("fiveHour", "limitTokens")} keyboardType="number-pad" onEndEditing={(e) => set("fiveHour", "limitTokens", e.nativeEvent.text)} />
      <Field label="Runs per week" defaultValue={win("weekly", "limitRuns")} keyboardType="number-pad" onEndEditing={(e) => set("weekly", "limitRuns", e.nativeEvent.text)} />
      <Field label="Tokens per week" defaultValue={win("weekly", "limitTokens")} keyboardType="number-pad" onEndEditing={(e) => set("weekly", "limitTokens", e.nativeEvent.text)} />
    </View>
  );
}

export function SubscriptionList({ hub }: { hub?: Hub }) {
  const p = usePalette();
  const [list, setList] = useState<SubscriptionStatus[]>([]);
  const [open, setOpen] = useState<string>();
  const load = () => { hub?.quota().then(setList).catch(() => {}); };
  useEffect(load, [hub]);
  // The list is every subscription; an edit sends them all back with one changed.
  const save = async (next: Subscription) => { if (hub) setList(await hub.saveQuota(list.map((q) => (q.subscription.id === next.id ? next : q.subscription)))); };
  if (!list.length) return <View style={{ padding: space(4) }}><Text style={[t.small, { color: p.muted }]}>No subscriptions yet.</Text></View>;
  return (
    <>
      {list.map((q) => (
        <View key={q.subscription.id} style={{ padding: space(4), gap: space(2), borderBottomWidth: 1, borderColor: p.line }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
            <Text style={[t.body, { color: p.ink, flex: 1 }]}>{q.subscription.label}</Text>
            {q.free ? <Pill text="free" /> : q.limited ? <Pill text="at its limit" color={p.warn} /> : null}
          </View>
          {q.subscription.plan ? <Text style={[t.small, { color: p.muted }]}>{q.subscription.plan}</Text> : null}
          {q.free ? <Text style={[t.small, { color: p.muted }]}>Runs on this Mac. No limit.</Text> : (
            <>
              <Bar w={q.windows.fiveHour} label="5-hour" />
              <Bar w={q.windows.weekly} label="Weekly" />
              {q.limited && q.limitedUntil ? <Text style={[t.small, { color: p.warn }]}>No work goes here until {when(q.limitedUntil)}.</Text> : null}
              <Button small kind="plain" label={open === q.subscription.id ? "Done" : "Edit limits"} onPress={() => setOpen(open === q.subscription.id ? undefined : q.subscription.id)} />
              {open === q.subscription.id ? <Limits sub={q.subscription} onSave={save} /> : null}
            </>
          )}
        </View>
      ))}
    </>
  );
}
