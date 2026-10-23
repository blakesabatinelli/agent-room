import React, { useState, memo } from "react";
import { Pressable, Text, View } from "react-native";
import type { Message } from "@agent-room/shared";
import { Avatar } from "./ui";
import { radius, space, type as t, usePalette, type Palette } from "../theme";

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Inline formatting: **bold**, `code`, @mentions and links. */
function Inline({ text, p, mentionNames }: { text: string; p: Palette; mentionNames: Set<string> }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`\n]+`|@[\w-]+|https?:\/\/\S+)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) return <Text key={i} style={{ fontWeight: "800", color: p.inkStrong }}>{part.slice(2, -2)}</Text>;
        if (part.startsWith("`") && part.endsWith("`")) return <Text key={i} style={[t.mono, { color: p.warn, backgroundColor: p.sunken }]}> {part.slice(1, -1)} </Text>;
        if (part.startsWith("@") && mentionNames.has(part.slice(1).toLowerCase()))
          return <Text key={i} style={{ color: p.mention, backgroundColor: p.mentionBg, fontWeight: "600" }}>{part}</Text>;
        if (/^https?:\/\//.test(part)) return <Text key={i} style={{ color: p.link }}>{part}</Text>;
        return <Text key={i}>{part}</Text>;
      })}
    </>
  );
}

/** Message body with fenced code blocks and simple headings/bullets kept readable. */
export function Body({ text, mentionNames }: { text: string; mentionNames: Set<string> }) {
  const p = usePalette();
  const blocks = text.split(/```/);
  return (
    <View style={{ gap: space(1.5) }}>
      {blocks.map((b, i) => i % 2 === 1 ? (
        <Text key={i} selectable style={[t.mono, { color: p.ink, backgroundColor: p.sunken, borderWidth: 1, borderColor: p.line, borderRadius: radius.md, padding: space(3) }]}>
          {b.replace(/^[a-z0-9_-]*\n/i, "").replace(/\n$/, "")}
        </Text>
      ) : b.trim() ? (
        <Text key={i} selectable style={[t.body, { color: p.ink }]}>
          {b.replace(/^\n+|\n+$/g, "").split("\n").map((line, j, arr) => {
            const h = /^#{1,4}\s+(.*)/.exec(line);
            const bullet = /^\s*[-*]\s+(.*)/.exec(line);
            const content = h ? <Text style={{ fontWeight: "800", color: p.inkStrong }}>{h[1]}</Text>
              : bullet ? <>{"  •  "}<Inline text={bullet[1]} p={p} mentionNames={mentionNames} /></>
              : <Inline text={line} p={p} mentionNames={mentionNames} />;
            return <React.Fragment key={j}>{content}{j < arr.length - 1 ? "\n" : ""}</React.Fragment>;
          })}
        </Text>
      ) : null)}
    </View>
  );
}

function MessageRowImpl({ m, color, grouped, mentionNames, onAuthor }: {
  m: Message; color?: string; grouped?: boolean; mentionNames: Set<string>; onAuthor?: (agentId: string) => void;
}) {
  const p = usePalette();
  const [hover, setHover] = useState(false);

  // System notices (pause, errors): a quiet centred line, like Slack's channel events.
  if (m.type === "system" || m.author.kind === "system") {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(5), paddingVertical: space(2) }}>
        <View style={{ width: 36, alignItems: "center" }}><Text style={{ color: p.warn }}>●</Text></View>
        <Text selectable style={[t.small, { color: p.muted, flex: 1 }]}>{m.text}</Text>
        <Text style={[t.tiny, { color: p.faint }]}>{time(m.createdAt)}</Text>
      </View>
    );
  }

  const isOwner = m.author.kind === "human";
  const c = isOwner ? p.owner : color ?? p.muted;
  return (
    <View {...({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as object)}
      style={{ flexDirection: "row", gap: space(2.5), paddingHorizontal: space(5), paddingTop: grouped ? 2 : space(2), paddingBottom: 2, backgroundColor: hover ? p.sunken : "transparent" }}>
      <View style={{ width: 36, alignItems: "center", paddingTop: grouped ? 3 : 2 }}>
        {grouped
          ? (hover ? <Text style={[t.tiny, { color: p.faint, fontSize: 10 }]}>{time(m.createdAt).replace(/\s?[AP]M/i, "")}</Text> : null)
          : <Avatar name={m.author.name} color={c} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {!grouped ? (
          <View style={{ flexDirection: "row", gap: space(2), alignItems: "baseline", marginBottom: 1 }}>
            <Pressable disabled={isOwner || !onAuthor} onPress={() => onAuthor?.(m.author.id)}>
              <Text style={[t.body, t.name, { color: p.inkStrong }]}>{m.author.name}</Text>
            </Pressable>
            {!isOwner ? <Text style={[t.tiny, { color: p.faint }]}>agent</Text> : null}
            <Text style={[t.tiny, { color: p.faint }]}>{time(m.createdAt)}</Text>
          </View>
        ) : null}
        <Body text={m.text} mentionNames={mentionNames} />
      </View>
    </View>
  );
}

/** Day separator, Slack style. */
export function DayDivider({ at }: { at: number }) {
  const p = usePalette();
  const d = new Date(at);
  const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  const label = d.toDateString() === today.toDateString() ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday"
    : d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginVertical: space(3), paddingHorizontal: space(5) }}>
      <View style={{ flex: 1, height: 1, backgroundColor: p.line }} />
      <View style={{ paddingHorizontal: space(3), paddingVertical: 3, borderRadius: 99, borderWidth: 1, borderColor: p.line, backgroundColor: p.canvas }}>
        <Text style={[t.tiny, { color: p.ink, fontWeight: "700" }]}>{label}</Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: p.line }} />
    </View>
  );
}

/** Rows re-render only when their own message, grouping or colour changes, not on every streamed chunk elsewhere. */
export const MessageRow = memo(MessageRowImpl, (a, b) =>
  a.m === b.m && a.grouped === b.grouped && a.color === b.color && a.mentionNames === b.mentionNames);
