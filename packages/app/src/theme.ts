import { Platform, useColorScheme } from "react-native";
import { dark, light, type AppearanceMode, type Palette } from "./palette";
import { useAppearance } from "./state/appearance";

export { dark, light };
export type { AppearanceMode, Palette };

/** Which palette for a choice and the system's scheme. */
export const paletteFor = (mode: AppearanceMode, system: "light" | "dark" | null | undefined): Palette =>
  (mode === "system" ? system === "dark" : mode === "dark") ? dark : light;

/** The palette in use: the system appearance (useColorScheme) unless Settings says Light or Dark. */
export const usePalette = (): Palette => {
  const system = useColorScheme();
  const mode = useAppearance((s) => s.mode);
  return paletteFor(mode, system);
};

// Avenir Next (built into macOS and iOS, nothing to bundle) for names and headings; the system face for reading.
const display = "Avenir Next";
export const type = {
  title: { fontFamily: display, fontSize: 22, lineHeight: 28, fontWeight: "600" as const },
  heading: { fontFamily: display, fontSize: 15, lineHeight: 20, fontWeight: "600" as const },
  name: { fontFamily: display, fontWeight: "600" as const },
  body: { fontSize: 15, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 18 },
  tiny: { fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: "Menlo", fontSize: 12, lineHeight: 18 },
};
export const space = (n: number) => n * 4;
export const radius = { sm: 4, md: 7, lg: 10, xl: 14 };

// A soft drop shadow, iOS only. react-native-macos 0.79 rebuilds the shadow whenever opacity, radius or
// offset is set, and if one of those lands before shadowColor (prop order isn't guaranteed) it calls
// colorWithCGColor: with NULL and the app dies ("NULL CGColor argument"). On the Mac, surfaces rely on
// their hairline border instead.
export const lift = (opacity: number, blur: number, y: number) =>
  Platform.OS === ("macos" as string)
    ? {}
    : { shadowColor: "#1E242C", shadowOpacity: opacity, shadowRadius: blur, shadowOffset: { width: 0, height: y } };
