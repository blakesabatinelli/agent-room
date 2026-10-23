import React, { useState } from "react";
import * as RN from "react-native";
import { Pressable, StyleSheet, Switch, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { radius, space, type as t, usePalette } from "../theme";

/** Page chrome for non-chat views: a slim header like a Slack channel header. */
export function Screen({ title, subtitle, right, left, children }: { title: string; subtitle?: string; right?: React.ReactNode; left?: React.ReactNode; children: React.ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <View style={[styles.header, { borderColor: p.line }]}>
        {left}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" numberOfLines={1} style={[t.heading, { color: p.inkStrong, fontSize: 18 }]}>{title}</Text>
          {subtitle ? <Text numberOfLines={1} style={[t.tiny, { color: p.muted, marginTop: 1 }]}>{subtitle}</Text> : null}
        </View>
        <View style={{ flexDirection: "row", gap: space(2), alignItems: "center" }}>{right}</View>
      </View>
      {children}
    </View>
  );
}

type Kind = "primary" | "plain" | "danger" | "ghost";
export function Button({ label, onPress, kind = "primary", disabled, small }: { label: string; onPress: () => void; kind?: Kind; disabled?: boolean; small?: boolean }) {
  const p = usePalette();
  const [hover, setHover] = useState(false);
  const bg = kind === "primary" ? (hover ? p.accentHover : p.accent) : kind === "danger" ? p.danger : kind === "plain" ? (hover ? p.raised : "transparent") : hover ? p.raised : "transparent";
  const fg = kind === "primary" || kind === "danger" ? p.onAccent : kind === "ghost" ? p.muted : p.ink;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)}
      style={({ pressed }) => [styles.button, small && styles.buttonSmall, {
        backgroundColor: bg, borderColor: kind === "plain" ? p.lineStrong : "transparent",
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      } as ViewStyle]}>
      <Text style={[small ? t.tiny : t.small, { color: fg, fontWeight: "600" }]}>{label}</Text>
    </Pressable>
  );
}

/** Small square icon-ish button used in headers (text glyphs keep us dependency-free). */
export function IconButton({ glyph, label, onPress, active, badge }: { glyph: string; label: string; onPress: () => void; active?: boolean; badge?: number }) {
  const p = usePalette();
  const [hover, setHover] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)}
      style={{ minWidth: 30, height: 28, paddingHorizontal: space(2), borderRadius: radius.md, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 4,
        backgroundColor: active ? p.raised : hover ? p.raised : "transparent", borderWidth: 1, borderColor: active ? p.lineStrong : "transparent" }}>
      <Text style={[t.small, { color: active ? p.inkStrong : p.muted, fontWeight: "700" }]}>{glyph}</Text>
      {badge ? <Text style={[t.tiny, { color: p.muted }]}>{badge}</Text> : null}
    </Pressable>
  );
}

/**
 * A labelled switch. `nested` renders it as a sub-setting of the toggle above it: indented, with a left rule
 * and secondary text. Indent with this, never with spaces in the label.
 */
export function Toggle({ label, hint, value, onChange, accent, nested }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; accent?: string; nested?: boolean }) {
  const p = usePalette();
  const row = (
    <View style={[styles.row, nested ? styles.nestedRow : null, { borderColor: p.line }]}>
      <View style={{ flex: 1 }}>
        <Text style={[nested ? t.small : t.body, { color: nested ? p.muted : p.ink }]}>{label}</Text>
        {hint ? <Text style={[nested ? t.tiny : t.small, { color: nested ? p.faint : p.muted }]}>{hint}</Text> : null}
      </View>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: accent ?? p.ok, false: p.raised }} />
    </View>
  );
  if (!nested) return row;
  return (
    <View accessibilityRole="none" style={[styles.nested, { borderLeftColor: p.lineStrong }]}>{row}</View>
  );
}

export function Field(props: TextInputProps & { label: string; hint?: string }) {
  const p = usePalette();
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: space(1.5), marginBottom: space(4) }}>
      <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]}>{props.label}</Text>
      <TextInput placeholderTextColor={p.faint} {...props}
        onFocus={(e) => { setFocus(true); props.onFocus?.(e); }} onBlur={(e) => { setFocus(false); props.onBlur?.(e); }}
        style={[t.body, styles.input, { color: p.ink, backgroundColor: p.sunken, borderColor: focus ? p.link : p.lineStrong }, props.style]} />
      {props.hint ? <Text style={[t.tiny, { color: p.faint }]}>{props.hint}</Text> : null}
    </View>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ marginBottom: space(7) }}>
      <Text style={[t.heading, { color: p.inkStrong, marginBottom: hint ? space(1) : space(2.5) }]}>{title}</Text>
      {hint ? <Text style={[t.small, { color: p.muted, marginBottom: space(2.5) }]}>{hint}</Text> : null}
      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.line }]}>{children}</View>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  const p = usePalette();
  return <Text style={[t.body, { color: p.muted, padding: space(5) }]}>{text}</Text>;
}

/** Legacy colour bar; kept for screens that still use it. */
export function Strip({ color }: { color: string }) {
  return <View style={{ width: 3, alignSelf: "stretch", borderRadius: 2, backgroundColor: color }} />;
}

/** Slack-style rounded-square avatar with the first letter, in the agent's colour. */
export function Avatar({ name, color, size = 36, presence, glyph }: { name: string; color: string; size?: number; presence?: "ready" | "busy" | "off"; /** 3.2: the persona's letter or emoji; empty means the first letter of the name */ glyph?: string }) {
  const p = usePalette();
  const dot = presence === "ready" ? p.ok : presence === "busy" ? p.warn : presence === "off" ? p.faint : undefined;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size * 0.22, backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: "#FFFFFF", fontFamily: t.name.fontFamily, fontWeight: "600", fontSize: size * 0.46 }}>{glyph || name.slice(0, 1).toUpperCase()}</Text>
      </View>
      {dot ? (
        <View style={{ position: "absolute", right: -3, bottom: -3, width: size * 0.36, height: size * 0.36, borderRadius: size, backgroundColor: dot, borderWidth: 2, borderColor: p.sidebar }} />
      ) : null}
    </View>
  );
}

/** Presence dot used in lists. */
export function Dot({ state, size = 9, ring }: { state: "ready" | "busy" | "off" | "error"; size?: number; ring?: string }) {
  const p = usePalette();
  const c = state === "ready" ? p.ok : state === "busy" ? p.warn : state === "error" ? p.danger : "transparent";
  return <View style={{ width: size, height: size, borderRadius: size, backgroundColor: c, borderWidth: state === "off" ? 1.5 : ring ? 2 : 0, borderColor: state === "off" ? p.sidebarMuted : ring }} />;
}

export function Pill({ text, color }: { text: string; color?: string }) {
  const p = usePalette();
  return (
    <View style={{ paddingHorizontal: space(2), paddingVertical: 2, borderRadius: 99, backgroundColor: p.raised, borderWidth: 1, borderColor: color ?? p.line }}>
      <Text style={[t.tiny, { color: color ?? p.muted, fontWeight: "700" }]}>{text}</Text>
    </View>
  );
}

/** Monospace block with a Copy button. */
export function CodeBlock({ text, label }: { text: string; label?: string }) {
  const p = usePalette();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try { (RN as unknown as { Clipboard: { setString(s: string): void } }).Clipboard.setString(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* selectable text is the fallback */ }
  };
  return (
    <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: p.line, backgroundColor: p.sunken, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space(3), paddingVertical: space(1.5), borderBottomWidth: 1, borderColor: p.line }}>
        <Text style={[t.tiny, { color: p.muted, flex: 1 }]}>{label ?? ""}</Text>
        <Button small kind="ghost" label={copied ? "Copied" : "Copy"} onPress={copy} />
      </View>
      <Text selectable style={[t.mono, { color: p.ink, padding: space(3) }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(5), height: 58, borderBottomWidth: 1 },
  button: { paddingHorizontal: space(3.5), paddingVertical: space(2), borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  buttonSmall: { paddingHorizontal: space(2.5), paddingVertical: space(1) },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: StyleSheet.hairlineWidth, gap: space(3) },
  // Sub-setting: indented container with a left rule; the rule carries the hierarchy, not whitespace.
  nested: { marginLeft: space(6), borderLeftWidth: 2, marginBottom: space(1) },
  nestedRow: { paddingLeft: space(3), paddingVertical: space(2.5) },
  input: { borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: space(3), paddingVertical: space(2.5) },
  card: { borderWidth: 1, borderRadius: radius.xl, overflow: "hidden" },
});
