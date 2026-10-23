import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { ForkFileChange, ForkSideId, ForkSideView, ForkView } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Avatar, Button, Pill, Screen } from "./ui";
import { radius, space, type as t, usePalette, type Palette } from "../theme";

/**
 * 4.4: one goal worked by two teams, side by side, and the blind comparison. Wide: two columns with the comparison under them.
 * Narrow: tabs A, B and Compare. The jury's pick is a suggestion; the owner merges (a second click confirms).
 */

const STATUS: Record<string, string> = {
  planning: "Planning", awaiting_approval: "Waiting for your plan approval", running: "Working", paused: "Paused",
  done: "Done", failed: "Did not finish", superseded: "Replaced", needs_input: "Needs your input", waiting: "Needs your input",
};
const CHANGE = { added: "New", modified: "Changed", deleted: "Removed" } as const;
const mark = (v: string) => (v === "PASS" ? "✓" : v === "FAIL" ? "✗" : "?");
const tokens = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0");
const duration = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

export function preferenceLine(v: ForkView): string {
  const c = v.comparison;
  if (!c) return v.comparing ? "The judges are comparing the two sides." : v.state === "waiting" ? "Waiting for your approval before the sides start." : "The comparison starts when both sides are done.";
  if (c.state === "failed") return c.note ?? "The judges could not compare the two sides.";
  if (c.preference === "a" || c.preference === "b") return `The judges lean to side ${c.preference.toUpperCase()}${c.agreement ? ", the same answer in both orders." : "."}`;
  if (c.preference === "tie") return "The judges see no clear difference.";
  return "The judges did not agree, so there is no pick. Read both and choose.";
}

function Heading({ text, right }: { text: string; right?: string }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: space(3) }}>
      <Text style={[t.tiny, { color: p.muted, fontWeight: "700", textTransform: "uppercase" }]}>{text}</Text>
      {right ? <Text style={[t.tiny, { color: p.muted }]}>{right}</Text> : null}
    </View>
  );
}

function FileRow({ f, p }: { f: ForkFileChange; p: Palette }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderBottomWidth: 1, borderColor: p.line, paddingVertical: space(1) }}>
      <View style={{ flexDirection: "row", gap: space(2), alignItems: "center" }}>
        <Pill text={CHANGE[f.change]} />
        <Text selectable style={[t.small, { color: p.ink, flex: 1 }]}>{f.path}</Text>
        {f.diff ? <Button small kind="ghost" label={open ? "Hide" : "Diff"} onPress={() => setOpen(!open)} /> : <Text style={[t.tiny, { color: p.muted }]}>{f.binary ? "Not text" : f.truncated ? "Too large to show" : ""}</Text>}
      </View>
      {open ? <Text selectable style={[t.mono, { color: p.ink, backgroundColor: p.sunken, borderWidth: 1, borderColor: p.line, borderRadius: radius.md, padding: space(2), marginTop: space(1) }]}>{f.diff}</Text> : null}
    </View>
  );
}

function SideColumn({ v, side }: { v: ForkView; side: ForkSideView }) {
  const p = usePalette();
  const met = side.requirements.filter((r) => r.status === "met").length;
  const c = side.cost;
  return (
    <View style={{ flex: 1, minWidth: 0, gap: space(1.5), borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, padding: space(3) }}>
      <View style={{ flexDirection: "row", gap: space(2), alignItems: "center", flexWrap: "wrap" }}>
        <Text style={[t.heading, { color: p.inkStrong, fontSize: 17 }]}>Side {side.side.toUpperCase()}</Text>
        {v.comparison?.preference === side.side ? <Pill text="Judges' pick" color={p.ok} /> : null}
        {v.merged?.side === side.side ? <Pill text="Merged" color={p.ok} /> : null}
        {side.archived ? <Pill text="Archived" /> : null}
      </View>
      <View style={{ flexDirection: "row", gap: space(3), flexWrap: "wrap" }}>
        {side.roster.map((a) => (
          <View key={a.id} style={{ flexDirection: "row", gap: space(1.5), alignItems: "center" }}>
            <Avatar name={a.name} color={a.color} size={20} />
            <Text style={[t.small, { color: p.ink }]}>{a.name}</Text>
          </View>
        ))}
      </View>
      <Text style={[t.small, { color: p.inkStrong, fontWeight: "600" }]}>{STATUS[side.status] ?? side.status}{side.waitingOnOwner ? `: ${side.waitingOnOwner}` : ""}</Text>
      <Text style={[t.tiny, { color: p.muted }]}>
        {`${side.tasks.done} of ${side.tasks.total} tasks done  ·  ${duration(side.time.seconds)}  ·  ${c.runs} ${c.runs === 1 ? "run" : "runs"}  ·  ${tokens(c.inputTokens + c.outputTokens)} tokens${c.costUsd > 0 ? `  ·  ${money(c.costUsd)}` : ""}`}
      </Text>
      <Heading text="Summary" />
      <Text selectable style={[t.small, { color: p.ink }]}>{side.summary || "No summary yet."}</Text>
      {side.requirements.length ? <Heading text="Done means" right={`${met} of ${side.requirements.length} met`} /> : null}
      {side.requirements.map((r) => (
        <View key={r.id} style={{ flexDirection: "row", gap: space(2) }}>
          <Text style={[t.small, { width: 14, fontWeight: "700", color: r.status === "met" ? p.ok : r.status === "unmet" ? p.danger : p.muted }]}>{r.status === "met" ? "✓" : r.status === "unmet" ? "✗" : "○"}</Text>
          <Text style={[t.small, { color: p.ink, flex: 1 }]}>{r.text}</Text>
        </View>
      ))}
      <Heading text="Delivered" right={`${side.deliverables.files.length + side.deliverables.more} files, ${side.deliverables.docs.length} documents`} />
      {side.deliverables.files.length ? side.deliverables.files.map((f) => <FileRow key={f.path} f={f} p={p} />) : <Text style={[t.small, { color: p.muted }]}>No file changes.</Text>}
      {side.deliverables.more ? <Text style={[t.tiny, { color: p.muted }]}>{side.deliverables.more} more files not shown.</Text> : null}
      {side.deliverables.docs.map((d) => (
        <View key={d.id} style={{ flexDirection: "row", gap: space(2), alignItems: "center", paddingVertical: space(0.5) }}>
          <Pill text="Doc" /><Text style={[t.small, { color: p.ink, flex: 1 }]}>{d.title}</Text>
          <Text style={[t.tiny, { color: p.muted }]}>{d.status === "superseded" ? "Superseded" : d.status}</Text>
        </View>
      ))}
      {side.accepted.length ? <Heading text="Accepted tasks" right={String(side.accepted.length)} /> : null}
      {side.accepted.map((a) => (
        <View key={a.id} style={{ flexDirection: "row", gap: space(2) }}>
          <Text style={[t.small, { color: p.ink, flex: 1 }]}>{a.title}</Text>
          <Text style={[t.tiny, { color: p.muted }]}>{a.agentName ?? ""}</Text>
        </View>
      ))}
    </View>
  );
}

function ComparePanel({ v, busy, confirm, setConfirm, onMerge, onPlans, onCompare, err }: {
  v: ForkView; busy: boolean; confirm?: ForkSideId; setConfirm: (s?: ForkSideId) => void;
  onMerge: (s: ForkSideId) => void; onPlans: () => void; onCompare: () => void; err?: string;
}) {
  const p = usePalette();
  const c = v.comparison;
  const waiting = v.sides.some((s) => s.awaitingApproval);
  return (
    <View style={{ gap: space(1.5), borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, padding: space(3) }}>
      <Text style={[t.heading, { color: p.inkStrong, fontSize: 17 }]}>Compare</Text>
      <Text style={[t.body, { color: p.inkStrong }]}>{preferenceLine(v)}</Text>
      {c?.reasons.map((r, i) => <Text key={i} style={[t.small, { color: p.ink }]}>{`•  ${r}`}</Text>)}
      {c?.requirements.length ? (
        <View>
          <Heading text="Each requirement" />
          <View style={{ flexDirection: "row", gap: space(2), paddingVertical: space(1) }}>
            <Text style={[t.tiny, { flex: 1, color: p.muted, fontWeight: "700" }]}>Requirement</Text>
            <Text style={[t.tiny, { width: 24, textAlign: "center", color: p.muted, fontWeight: "700" }]}>A</Text>
            <Text style={[t.tiny, { width: 24, textAlign: "center", color: p.muted, fontWeight: "700" }]}>B</Text>
          </View>
          {c.requirements.map((r, i) => (
            <View key={i} style={{ flexDirection: "row", gap: space(2), paddingVertical: space(1), borderTopWidth: 1, borderColor: p.line }}>
              <Text style={[t.small, { flex: 1, color: p.ink }]}>{r.text}</Text>
              {([r.a, r.b] as const).map((verdict, k) => (
                <Text key={k} accessibilityLabel={`Side ${k ? "B" : "A"} ${verdict}`} style={[t.small, { width: 24, textAlign: "center", fontWeight: "700", color: verdict === "PASS" ? p.ok : verdict === "FAIL" ? p.danger : p.muted }]}>{mark(verdict)}</Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
      {c ? <Text style={[t.tiny, { color: p.muted }]}>{`${c.independence === "full" ? "The judges came from outside both teams." : "Some judges share a model family with a team."} They saw neutral text with no names, in both orders.`}</Text> : null}
      {v.merged ? <Text style={[t.small, { color: p.ok, fontWeight: "600" }]}>{`Merged side ${v.merged.side.toUpperCase()}. ${v.merged.detail}`}</Text> : (
        <>
          {v.mergeBlocked ? <Text style={[t.tiny, { color: p.muted }]}>{v.mergeBlocked}</Text> : null}
          <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap", marginTop: space(2) }}>
            {waiting ? <Button small label="Approve plans" onPress={onPlans} disabled={busy} /> : null}
            {(["a", "b"] as const).map((s) => {
              const side = v.sides.find((x) => x.side === s);
              const ready = !!side && ["done", "failed", "superseded"].includes(side.status);
              return <Button key={s} small kind={confirm === s ? "primary" : "plain"} label={confirm === s ? `Confirm merge ${s.toUpperCase()}` : `Merge ${s.toUpperCase()}`}
                disabled={!ready || busy} onPress={() => (confirm === s ? onMerge(s) : setConfirm(s))} />;
            })}
            {confirm ? <Button small kind="ghost" label="Cancel" onPress={() => setConfirm(undefined)} /> : null}
            {c && c.state !== "done" && !v.comparing ? <Button small kind="ghost" label="Compare again" onPress={onCompare} disabled={busy} /> : null}
          </View>
          <Text style={[t.tiny, { color: p.muted }]}>The other side is archived and stays here to read. Your choice decides; the pick above is only a suggestion.</Text>
        </>
      )}
      {err ? <Text style={[t.small, { color: p.danger }]}>{err}</Text> : null}
    </View>
  );
}

/** The fork, in place of the conversation (the room keeps its place). */
export function ForkPane({ forkId, onClose }: { forkId: string; onClose: () => void }) {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const hub = useRoom(useShallow((s) => s.hub));
  const [v, setV] = useState<ForkView>();
  const [err, setErr] = useState<string>();
  const [tab, setTab] = useState<"a" | "b" | "compare">("a");
  const [confirm, setConfirm] = useState<ForkSideId>();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const wide = width >= 900;

  const load = () => hub?.fork(forkId).then((x) => { if (live.current) { setV(x); setErr(undefined); } }).catch((e) => { if (live.current) setErr((e as Error).message); });
  useEffect(() => {
    live.current = true; setV(undefined); setConfirm(undefined); void load();
    const timer = setInterval(() => void load(), 4000); // the sides work while this is open
    return () => { live.current = false; clearInterval(timer); };
  }, [hub, forkId]);

  const act = async (run: () => Promise<ForkView | { ok: boolean } | void>, after?: (x: ForkView) => void) => {
    setBusy(true); setErr(undefined);
    try { const r = await run(); if (r && "sides" in r) { setV(r); after?.(r); } else await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); setConfirm(undefined); }
  };

  return (
    <Screen title="Fork" subtitle={v?.text} right={<Button small kind="plain" label="Back to the room" onPress={onClose} />}>
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(3) }}>
        {!v ? <Text style={[t.small, { color: err ? p.danger : p.muted }]}>{err ?? "Loading…"}</Text> : (
          <>
            {v.target.label ? <Text style={[t.tiny, { color: p.muted }]}>{v.target.label}</Text> : null}
            {wide ? null : (
              <View style={{ flexDirection: "row", gap: space(2) }}>
                {(["a", "b", "compare"] as const).map((k) => (
                  <Button key={k} small kind={tab === k ? "primary" : "plain"} label={k === "compare" ? "Compare" : `Side ${k.toUpperCase()}`} onPress={() => setTab(k)} />
                ))}
              </View>
            )}
            {wide ? (
              <View style={{ flexDirection: "row", gap: space(3), alignItems: "flex-start" }}>{v.sides.map((s) => <SideColumn key={s.side} v={v} side={s} />)}</View>
            ) : tab === "compare" ? null : <SideColumn v={v} side={v.sides.find((s) => s.side === tab) ?? v.sides[0]} />}
            {wide || tab === "compare" ? (
              <ComparePanel v={v} busy={busy} confirm={confirm} setConfirm={setConfirm} err={err}
                onMerge={(s) => void act(() => hub!.mergeFork(forkId, s), () => setTab("compare"))}
                onPlans={() => void act(() => hub!.approveForkPlans(forkId))}
                onCompare={() => void act(() => hub!.compareFork(forkId))} />
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
