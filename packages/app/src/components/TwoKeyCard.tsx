import React from "react";
import { Text, View } from "react-native";
import type { Approval, TwoKeyCard as Card, TwoKeyDiff, TwoKeySide } from "@agent-room/shared";
import { Button } from "./ui";
import { space, type as t, usePalette } from "../theme";

/** 4.1 Two-key action: two agents from different vendors drafted it; they disagree (or only one could draft). Both drafts side by side, what differs marked. */

const TITLE: Record<Card["kind"], string> = { email: "send an email", crm: "write to the CRM", delete: "delete" };
type Line = { k: string; v: string; m: boolean };

const critical = (diffs: TwoKeyDiff[], field: string) => diffs.some((d) => d.level !== "minor" && d.field.toLowerCase() === field.toLowerCase());

function lines(side: TwoKeySide, diffs: TwoKeyDiff[], which: "a" | "b"): Line[] {
  const d = side.draft;
  if (!d) return [];
  if (d.kind === "email") {
    const rows: Line[] = [{ k: "To", v: d.to.join(", ") || "(none)", m: critical(diffs, "to") }, { k: "Cc", v: d.cc.join(", "), m: critical(diffs, "cc") }, { k: "Bcc", v: (d.bcc ?? []).join(", "), m: critical(diffs, "bcc") }, { k: "Subject", v: d.subject, m: critical(diffs, "subject") }];
    return rows.filter((r) => r.v || r.m);
  }
  if (d.kind === "crm") {
    const rows: Line[] = [{ k: "Object", v: d.object, m: critical(diffs, "object") }, { k: "Operation", v: d.op, m: critical(diffs, "operation") }];
    if (d.id || critical(diffs, "record id")) rows.push({ k: "Record", v: d.id ?? "(none)", m: critical(diffs, "record id") });
    for (const [f, v] of Object.entries(d.fields)) rows.push({ k: f, v: typeof v === "string" ? v : JSON.stringify(v), m: critical(diffs, `field ${f}`) });
    return rows;
  }
  const rows: Line[] = d.targets.map((x) => ({ k: "", v: x, m: diffs.some((df) => df.level !== "minor" && df.field === "targets" && df[which].includes(x)) }));
  if (d.unparsed) rows.push({ k: "Also", v: `whatever ${d.unparsed} reaches`, m: true });
  return rows;
}

function Pane({ card, which }: { card: Card; which: "a" | "b" }) {
  const p = usePalette();
  const side = card[which]!;
  const words = card.words?.[which];
  const bodyMarked = card.diffs.some((x) => x.field.startsWith("body") && x.level !== "minor");
  const note = side.noAction !== undefined ? `Says no action is called for: ${side.noAction}` : !side.draft ? (side.raw ? `No readable draft: ${side.raw}` : "No readable draft.") : undefined;
  return (
    <View style={{ gap: space(1), padding: space(3), borderRadius: 10, borderWidth: 1, borderColor: p.line, backgroundColor: p.canvas }}>
      <Text style={[t.small, { color: p.ink, fontWeight: "700" }]}>{which.toUpperCase()}: {side.name} ({side.family})</Text>
      {note ? <Text selectable style={[t.small, { color: p.warn, backgroundColor: p.warnBg }]}>{note}</Text> : null}
      {lines(side, card.diffs, which).map((r, i) => (
        <Text key={i} selectable style={[t.small, { color: r.m ? p.warn : p.ink, backgroundColor: r.m ? p.warnBg : undefined }]}>
          {r.k ? <Text style={{ color: r.m ? p.warn : p.muted, fontWeight: "600" }}>{r.k} </Text> : null}{r.v}
        </Text>
      ))}
      {side.draft?.kind === "email" ? (
        <Text selectable style={[t.small, { color: p.ink, backgroundColor: !words && bodyMarked ? p.warnBg : undefined }]}>
          {words ? words.map((w, i) => <Text key={i} style={w.d ? { color: p.warn, backgroundColor: p.warnBg } : undefined}>{w.t}{" "}</Text>) : side.draft.body}
        </Text>
      ) : null}
    </View>
  );
}

export function TwoKeyApproval({ approval, agentName, onAnswer }: { approval: Approval; agentName: string; onAnswer: (choice: string) => void }) {
  const p = usePalette();
  const card = approval.twoKey!;
  const title = card.verdict === "unavailable" ? `${agentName} wants to ${TITLE[card.kind]}: no second key` : `Two agents disagree about whether to ${TITLE[card.kind]}`;
  return (
    <>
      <Text style={[t.heading, { color: p.ink }]}>{title}</Text>
      <Text style={[t.small, { color: p.muted }]}>{card.why}</Text>
      <View style={{ gap: space(2) }}>
        <Pane card={card} which="a" />
        {card.b ? <Pane card={card} which="b" /> : null}
      </View>
      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
        {card.choices.map((c, i) => <Button key={c.id} kind={i === 0 ? "primary" : "plain"} label={c.label} onPress={() => onAnswer(c.id)} />)}
      </View>
    </>
  );
}
