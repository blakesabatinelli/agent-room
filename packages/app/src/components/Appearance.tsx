import React from "react";
import { Pressable, Text, View } from "react-native";
import { APPEARANCE_MODES, type AppearanceMode } from "../palette";
import { useAppearance } from "../state/appearance";
import { radius, space, type as t, usePalette } from "../theme";
import { Section } from "./ui";

const LABEL: Record<AppearanceMode, string> = { system: "System", light: "Light", dark: "Dark" };

/** 3.1: System follows the Mac; Light and Dark override it. A segmented control, in Settings. */
export function Appearance() {
  const p = usePalette();
  const mode = useAppearance((s) => s.mode);
  const set = useAppearance((s) => s.set);
  return (
    <Section title="Appearance" hint="System follows your Mac. Light and Dark stay as you choose.">
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", padding: space(3), gap: space(2) }}>
        {APPEARANCE_MODES.map((m) => {
          const on = m === mode;
          return (
            <Pressable key={m} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => set(m)}
              style={{ paddingHorizontal: space(4), paddingVertical: space(1.5), borderRadius: radius.md, borderWidth: 1, borderColor: on ? p.accent : p.lineStrong, backgroundColor: on ? p.tint : "transparent" }}>
              <Text style={[t.small, { color: on ? p.accent : p.ink, fontWeight: on ? "700" : "400" }]}>{LABEL[m]}</Text>
            </Pressable>
          );
        })}
      </View>
    </Section>
  );
}
