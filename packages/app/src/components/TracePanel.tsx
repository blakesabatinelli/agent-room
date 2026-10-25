import { useShallow } from "zustand/react/shallow";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { GoalTrace, TraceAttempt, TraceEvent, TraceState, TraceTask } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Button, Chip } from "./ui";
import { space, type as t, usePalette } from "../theme";

/**
 * The trace of one goal: plan, tasks in plan order, each attempt (agent, model, time, cost, outcome, failure, judge and score),
 * and what happened during it (approvals, reply turns, posts), with helpers under their parent. Opened from the goal card, and from
 * an issue. Everything comes from GET /goals/:id/trace; this only draws it.
 */

const STATE_LABEL: Record<TraceState, string> = { ok: "Accepted", sent_back: "Sent back", failed: "Failed", waiting: "Needs you", running: "Running", stopped: "Stopped" };
/** The recorded note often starts with the tag already ("blocked by its environment: ..."); say it once. */
const failureLine = (label: string, reason?: string) => (!reason ? label : reason.toLowerCase().startsWith(label.toLowerCase()) ? reason.charAt(0).toUpperCase() + reason.slice(1) : `${label}: ${reason}`);
const TAG_LABEL: Record<string, string> = { spec: "Unclear task", misalignment: "Drifted off task", verification: "Said done too early", placement: "Blocked by its environment", other: "Failed" };
const TASK_LABEL: Record<string, string> = { pending: "Waiting", assigned: "Assigned", running: "Working", review: "Being judged", revising: "Revising", waiting: "Needs your input", done: "Done", failed: "Failed", cancelled: "Cancelled" };
const TURN_KIND: Record<string, string> = { owner: "your message", tag: "tagged", rollcall: "roll call", ask: "asked", aside: "side question" };

export function durText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const stamp = (at: number) => `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(at)}`;

function useTone() {
  const p = usePalette();
  return (s: TraceState | string) => (s === "ok" || s === "done" ? p.ok : s === "sent_back" || s === "waiting" ? p.warn : s === "failed" ? p.danger : s === "running" || s === "assigned" || s === "review" || s === "revising" ? p.accent : p.muted);
}

export function eventLine(e: TraceEvent): string {
  if (e.kind === "approval") {
    const how = e.status === "pending" ? "Waiting for you" : e.auto ? "Approved automatically"
      : `${e.status === "approved" ? "Approved" : e.status === "rejected" ? "Declined" : "Expired"}${e.waitSeconds !== undefined ? ` after ${durText(e.waitSeconds)}` : ""}`;
    return `Approval, ${e.tool}: ${e.action}. ${how}.`;
  }
  if (e.kind === "turn") {
    const bits = [e.status === "failed" ? "couldn't reply" : e.status];
    if (e.via) bits.push(e.via === "post" ? "posted in the room" : "answered by the hub");
    if (e.dropped) bits.push(`${plural(e.dropped, "repeat post")} kept out`);
    return `Reply (${TURN_KIND[e.turnKind] ?? e.turnKind}): ${bits.join(", ")}${e.error ? `. ${e.error}` : ""}`;
  }
  return `${e.author}: ${e.text}`;
}

function Row({ title, meta, color, open, onToggle, depth = 0, children }: { title: string; meta: string; color: string; open: boolean; onToggle: () => void; depth?: number; children?: React.ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ marginLeft: depth ? space(4) : 0, borderLeftWidth: depth ? 1 : 0, borderColor: p.line }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${title}. ${meta}`} onPress={onToggle}
        style={{ flexDirection: "row", alignItems: "center", gap: space(2.5), paddingVertical: space(1.5), paddingHorizontal: space(2) }}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={2} style={[t.small, { color: p.inkStrong, fontWeight: "600" }]}>{title}</Text>
          <Text numberOfLines={2} style={[t.tiny, { color }]}>{meta}</Text>
        </View>
        <Text style={[t.small, { color: p.muted, width: 12, textAlign: "center" }]}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open ? <View style={{ paddingLeft: space(4), paddingBottom: space(1.5), gap: space(1) }}>{children}</View> : null}
    </View>
  );
}

function Attempt({ task, a, open, toggle, openMap }: { task: TraceTask; a: TraceAttempt; open: boolean; toggle: (k: string, dflt: boolean) => void; openMap: Record<string, boolean> }) {
  const p = usePalette();
  const tone = useTone();
  const key = `a:${a.id}`;
  const meta = [STATE_LABEL[a.state], a.seconds !== undefined ? durText(a.seconds) : "", a.model ?? ""].filter(Boolean).join(" · ");
  const use = [a.tokens !== undefined ? `${a.tokens.toLocaleString()} tokens` : "", a.usage?.costUsd !== undefined ? `$${a.usage.costUsd.toFixed(4)}` : ""].filter(Boolean).join(" · ");
  const verdict = a.judge ? (a.judge.verdict === "accept" ? "accepted" : a.judge.verdict === "revise" ? "sent back" : "given to another agent") : "";
  return (
    <Row title={`Attempt ${a.n}, ${a.agentName}`} meta={meta} color={tone(a.state)} open={open} onToggle={() => toggle(key, a.state !== "ok")} depth={1}>
      <Text style={[t.tiny, { color: p.muted }]}>{stamp(a.at)}{a.endedAt ? ` to ${clock(a.endedAt)}` : ""}</Text>
      {use ? <Text style={[t.tiny, { color: p.muted }]}>{use}</Text> : null}
      {a.failure ? <Text selectable style={[t.small, { color: p.danger }]}>{failureLine(TAG_LABEL[a.failure.tag] ?? a.failure.tag, a.failure.reason)}</Text> : null}
      {a.judge ? <Text selectable style={[t.small, { color: p.ink }]}>Judged by {a.judge.names.join(", ") || "a reviewer"}: {Math.round(a.judge.score * 100)}/100, {verdict}{a.judge.feedback ? `. ${a.judge.feedback}` : ""}</Text>
        : a.note && !a.failure ? <Text selectable style={[t.small, { color: p.ink }]}>{a.note}</Text> : null}
      {a.events.map((e) => (
        <View key={`${e.kind}:${e.id}`} style={{ flexDirection: "row", gap: space(2) }}>
          <Text style={[t.tiny, { color: p.muted, width: 56, fontVariant: ["tabular-nums"] }]}>{clock(e.at)}</Text>
          <Text selectable style={[t.small, { flex: 1, color: e.kind === "post" && e.quiet ? p.muted : p.ink, fontWeight: e.kind === "approval" ? "600" : "400" }]}>{eventLine(e)}</Text>
        </View>
      ))}
      {a.hidden ? <Text style={[t.tiny, { color: p.muted }]}>{plural(a.hidden, "more line")} not shown.</Text> : null}
      {task.helpers.filter((h) => h.parentAttempt === a.n).map((h) => <Task key={h.id} t={h} open={openMap} toggle={toggle} />)}
    </Row>
  );
}

function Task({ t: task, open, toggle }: { t: TraceTask; open: Record<string, boolean>; toggle: (k: string, dflt: boolean) => void }) {
  const tone = useTone();
  const key = `t:${task.id}`;
  const dflt = task.status !== "done" || task.attempts.some((a) => a.state !== "ok");
  const isOpen = open[key] ?? dflt;
  const placed = new Set(task.attempts.map((a) => a.n));
  const kind = task.helper ? (task.native ? "built-in helper" : task.readOnly ? "read-only helper" : "helper") : "";
  const meta = `${kind ? `${kind} · ` : ""}${TASK_LABEL[task.status] ?? task.status} · ${plural(task.attempts.length, "attempt")}${task.assigneeName ? ` · ${task.assigneeName}` : ""}`;
  return (
    <Row title={task.title} meta={meta} color={tone(task.status)} open={isOpen} onToggle={() => toggle(key, dflt)} depth={task.helper ? 1 : 0}>
      {task.attempts.map((a) => <Attempt key={a.id} task={task} a={a} open={open[`a:${a.id}`] ?? a.state !== "ok"} toggle={toggle} openMap={open} />)}
      {task.attempts.length === 0 ? <TinyNote text={task.helper ? "No separate run recorded." : "Not started."} /> : null}
      {task.helpers.filter((h) => !placed.has(h.parentAttempt ?? -1)).map((h) => <Task key={h.id} t={h} open={open} toggle={toggle} />)}
    </Row>
  );
}

function TinyNote({ text }: { text: string }) {
  const p = usePalette();
  return <Text style={[t.tiny, { color: p.muted }]}>{text}</Text>;
}

export function TraceSummaryChips({ tr }: { tr: GoalTrace }) {
  const s = tr.summary;
  const chips: { label: string; tone: "neutral" | "ok" | "warn" | "danger" | "accent" }[] = [
    { label: `${s.tasksDone} of ${s.tasksTotal} tasks done`, tone: s.tasksTotal > 0 && s.tasksDone === s.tasksTotal ? "ok" : "accent" },
    { label: plural(s.attempts, "attempt"), tone: "neutral" },
  ];
  if (s.helpers) chips.push({ label: plural(s.helpers, "helper"), tone: "neutral" });
  if (s.sentBack) chips.push({ label: `${s.sentBack} sent back`, tone: "warn" });
  for (const tag of ["placement", "spec", "misalignment", "verification", "other"] as const) if (s.failures[tag]) chips.push({ label: `${s.failures[tag]} ${(TAG_LABEL[tag] ?? tag).toLowerCase()}`, tone: "danger" });
  chips.push({ label: `${durText(s.elapsedSeconds)} in all`, tone: "neutral" });
  if (s.workSeconds) chips.push({ label: `${durText(s.workSeconds)} of agent work`, tone: "neutral" });
  if (s.approvals.total) chips.push({ label: `${plural(s.approvals.total, "approval")}${s.approvals.pending ? `, ${s.approvals.pending} waiting` : ""}`, tone: s.approvals.pending ? "warn" : "neutral" });
  if (s.tokens !== undefined) chips.push({ label: `${s.tokens.toLocaleString()} tokens`, tone: "neutral" });
  if (s.costUsd !== undefined) chips.push({ label: s.costUsd > 0 && s.costUsd < 0.005 ? "Under $0.01" : `$${s.costUsd.toFixed(2)}`, tone: "neutral" });
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1.5) }}>{chips.map((c) => <Chip key={c.label} label={c.label} tone={c.tone} />)}</View>;
}

/** The trace for one goal, loaded when it opens. `onClose` puts the panel away. */
export function TracePanel({ goalId, onClose, maxHeight }: { goalId: string; onClose?: () => void; maxHeight?: number }) {
  const p = usePalette();
  const { hub } = useRoom(useShallow((s) => ({ hub: s.hub })));
  const [tr, setTr] = useState<GoalTrace | undefined>();
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const load = useCallback(() => { hub?.goalTrace(goalId).then((d) => { setTr(d); setErr(""); }).catch((e: Error) => setErr(e.message)); }, [hub, goalId]);
  useEffect(() => { setTr(undefined); load(); }, [load]);
  const toggle = (k: string, dflt: boolean) => setOpen((o) => ({ ...o, [k]: !(o[k] ?? dflt) }));

  const plan = tr?.plan;
  const planLine = !plan ? "" : plan.approval.state === "approved" ? `Approved ${stamp(plan.approval.at ?? 0)}` : plan.approval.state === "waiting" ? "Waiting for your approval" : plan.approval.state === "planning" ? "Being written"
    : plan.approval.state === "cancelled" ? "You cancelled it" : "Started without needing approval";
  return (
    <View style={{ borderBottomWidth: 1, borderColor: p.line, backgroundColor: p.canvas }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(5), paddingVertical: space(2) }}>
        <Text accessibilityRole="header" style={[t.heading, { color: p.inkStrong, flex: 1 }]}>Trace</Text>
        <Button small kind="plain" label="Refresh" onPress={load} />
        {onClose ? <Button small kind="ghost" label="Close" onPress={onClose} /> : null}
      </View>
      <ScrollView style={maxHeight ? { maxHeight } : undefined} contentContainerStyle={{ paddingHorizontal: space(5), paddingBottom: space(4), gap: space(2.5) }}>
        {!tr ? <Text style={[t.small, { color: err ? p.danger : p.muted }]}>{err || "Loading…"}</Text> : (
          <>
            <Text selectable style={[t.small, { color: p.inkStrong, fontWeight: "600" }]}>{tr.goal.text}</Text>
            <TraceSummaryChips tr={tr} />
            <Row title={`Plan${plan?.version ? ` v${plan.version}` : ""}`} meta={planLine} color={plan?.approval.state === "waiting" ? p.warn : plan?.approval.state === "cancelled" ? p.danger : p.ok} open={open.plan ?? false} onToggle={() => toggle("plan", false)}>
              {plan!.steps.map((s) => <Text key={`${s.at}:${s.text}`} style={[t.small, { color: p.ink }]}>{clock(s.at)}  {s.text}</Text>)}
              {plan!.amendments.map((m) => <Text key={`${m.at}:${m.text}`} style={[t.small, { color: p.ink }]}>{clock(m.at)}  You asked: {m.text}</Text>)}
              {plan!.requirements.map((r) => <Text key={r.id} style={[t.small, { color: r.status === "met" ? p.ok : r.status === "unmet" ? p.danger : p.muted }]}>{r.status === "met" ? "✓" : r.status === "unmet" ? "✕" : "○"} {r.id} {r.text}</Text>)}
            </Row>
            {tr.tasks.map((x) => <Task key={x.id} t={x} open={open} toggle={toggle} />)}
            {tr.loose.length ? (
              <View style={{ gap: space(1) }}>
                <Text style={[t.small, { color: p.muted, fontWeight: "600" }]}>Other activity</Text>
                {tr.loose.map((e) => <Text key={`${e.kind}:${e.id}`} selectable style={[t.small, { color: p.ink }]}>{clock(e.at)}  {eventLine(e)}</Text>)}
              </View>
            ) : null}
            {tr.lessons.length ? (
              <View style={{ gap: space(1) }}>
                <Text style={[t.small, { color: p.muted, fontWeight: "600" }]}>Lessons from the retro</Text>
                {tr.lessons.map((l) => <Text key={l.id} selectable style={[t.small, { color: p.ink }]}>{l.agentName}, {l.taskType}: {l.text}</Text>)}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
