import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AgentConfig, PersonaTemplate, PersonaView } from "@agent-room/shared";
import { useRoom } from "../state/store";
import { Avatar, Button, Field } from "./ui";
import { radius, space, type as t, usePalette } from "../theme";

// Strong enough to carry white initials on a light background (the same set the agent list offers).
const SWATCHES = ["#D9822B", "#D6336C", "#1C7ED6", "#2F9E44", "#B08800", "#7048E8", "#5C6B7A"];
const HEX = /^#[0-9a-fA-F]{6}$/;

interface Form { name: string; color: string; avatar: string; role: string; tone: string; body: string; template: string }
const toForm = (v: PersonaView): Form => ({ name: v.name, color: v.color, avatar: v.avatar ?? "", role: v.role, tone: v.tone, body: v.body.trim(), template: v.template ?? "" });

/**
 * 3.2: an agent's persona. Name, colour, avatar, role, tone and a bio: the hub keeps them in the agent's SOUL.md
 * (or in its record when there is no control folder). It shapes how the agent writes and is left out when its work
 * is judged. "Start from a template" fills the form; nothing is saved until Save.
 */
export function PersonaEditor({ a }: { a: AgentConfig }) {
  const p = usePalette();
  const hub = useRoom(useShallow((s) => s.hub));
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<PersonaTemplate[]>([]);
  const [saved, setSaved] = useState<Form>();
  const [form, setForm] = useState<Form>();
  const [source, setSource] = useState<PersonaView["source"]>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const dirty = useRef(false);

  const load = () => hub?.persona(a.id).then((v) => {
    const f = toForm(v);
    setSaved(f); setSource(v.source);
    if (!dirty.current) setForm(f);
  }).catch((e) => setErr((e as Error).message));
  // Opened: read the persona and the starters. A name or colour that changed elsewhere (the file, the phone) shows up unless it is being edited here.
  useEffect(() => { if (open) void load(); }, [hub, a.id, a.name, a.color, a.avatar, open]);
  useEffect(() => { if (open && hub && !templates.length) hub.personaTemplates().then(setTemplates).catch(() => {}); }, [hub, open]);

  const edit = (patch: Partial<Form>) => { dirty.current = true; setNote(undefined); setForm((f) => (f ? { ...f, ...patch } : f)); };
  const pick = (tpl: PersonaTemplate) => edit({ role: tpl.role, tone: tpl.tone, body: tpl.body.trim(), template: tpl.id });
  const changed = !!form && !!saved && JSON.stringify(form) !== JSON.stringify(saved);

  const save = async () => {
    if (!form || !hub) return;
    setBusy(true); setErr(undefined);
    try {
      const v = await hub.savePersona(a.id, { name: form.name, color: form.color, avatar: form.avatar, role: form.role, tone: form.tone, body: form.body });
      dirty.current = false;
      const f = toForm(v); setSaved(f); setForm(f); setSource(v.source); setNote("Saved");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const chip = (on: boolean) => ({ paddingHorizontal: space(2), paddingVertical: 3, borderRadius: radius.sm, borderWidth: 1, borderColor: on ? p.accent : p.line, backgroundColor: on ? p.accent : "transparent" });

  return (
    <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, overflow: "hidden" }}>
      <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: space(3), padding: space(3) }}>
        <Avatar name={a.name} color={a.color} glyph={a.avatar} size={28} />
        <View style={{ flex: 1 }}>
          <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]}>Persona</Text>
          <Text style={[t.tiny, { color: p.muted }]}>How {a.name} sounds in the room. Left out when its work is judged.</Text>
        </View>
        <Text style={[t.small, { color: p.link }]}>{open ? "Hide" : "Edit"}</Text>
      </Pressable>
      {open ? (
        <View style={{ borderTopWidth: 1, borderColor: p.line, padding: space(3), gap: space(2) }}>
          {!form ? <Text style={[t.small, { color: p.muted }]}>{err ?? "Loading…"}</Text> : (
            <>
              <View style={{ gap: space(1.5), marginBottom: space(4) }}>
                <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]}>Start from a template</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1) }}>
                  {templates.map((tpl) => (
                    <Pressable key={tpl.id} accessibilityRole="button" accessibilityState={{ selected: form.template === tpl.id }} onPress={() => pick(tpl)} style={chip(form.template === tpl.id)}>
                      <Text style={[t.tiny, { color: form.template === tpl.id ? p.onAccent : p.muted, fontWeight: form.template === tpl.id ? "700" : "400" }]}>{tpl.label}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={[t.tiny, { color: p.faint }]}>{templates.find((x) => x.id === form.template)?.summary ?? "Fills role, tone and bio. You can change them after."}</Text>
              </View>

              <Field label="Name" value={form.name} onChangeText={(v) => edit({ name: v })} maxLength={60} />
              <View style={{ gap: space(1.5), marginBottom: space(2) }}>
                <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]}>Colour</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
                  {SWATCHES.map((c) => (
                    <Pressable key={c} accessibilityRole="button" accessibilityLabel={`Colour ${c}`} accessibilityState={{ selected: form.color.toLowerCase() === c.toLowerCase() }} onPress={() => edit({ color: c })}
                      style={{ width: 24, height: 24, borderRadius: radius.sm, backgroundColor: c, borderWidth: 2, borderColor: form.color.toLowerCase() === c.toLowerCase() ? p.inkStrong : "transparent" }} />
                  ))}
                </View>
              </View>
              <Field label="Hex colour" value={form.color} onChangeText={(v) => edit({ color: v })} autoCapitalize="none" maxLength={7}
                hint={HEX.test(form.color) ? "Pick a swatch, or type a colour like #6B4FD8." : "A hex colour like #6B4FD8."} />
              <Field label="Avatar" value={form.avatar} onChangeText={(v) => edit({ avatar: v })} maxLength={8} hint="One letter or an emoji. Leave empty for the first letter of the name." />
              <Field label="Role" value={form.role} onChangeText={(v) => edit({ role: v })} maxLength={200} hint="What it does, in a few words." />
              <Field label="Tone" value={form.tone} onChangeText={(v) => edit({ tone: v })} maxLength={200} hint="How it sounds, in a few words." />
              <Field label="Bio and voice notes" value={form.body} onChangeText={(v) => edit({ body: v })} multiline numberOfLines={8} maxLength={6000}
                style={{ minHeight: 150, textAlignVertical: "top" }}
                hint={source === "control" ? "Saved in this agent's SOUL.md. Voice only: it never changes what a task asks for." : "Voice only: it never changes what a task asks for."} />

              {err ? <Text accessibilityRole="alert" style={[t.small, { color: p.danger }]}>{err}</Text> : null}
              <View style={{ flexDirection: "row", gap: space(2), alignItems: "center" }}>
                <Button label={busy ? "Saving…" : "Save persona"} onPress={() => void save()} disabled={busy || !changed} />
                {changed ? <Button kind="ghost" label="Undo changes" onPress={() => { dirty.current = false; setForm(saved); setErr(undefined); }} /> : null}
                {note && !changed ? <Text style={[t.small, { color: p.ok }]}>{note}</Text> : null}
              </View>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}
