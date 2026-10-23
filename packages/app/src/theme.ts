import { Platform } from "react-native";

// Light and quiet: white conversation, a pale cool sidebar, hairlines instead of boxes.
// The chrome stays neutral so each agent's own colour (avatar and name) is what you notice.
const light = {
  canvas: "#FFFFFF",        // conversation pane ("Paper")
  surface: "#F4F6F8",       // side panels, cards ("Mist")
  raised: "#EEF1F4",        // hovered rows, popovers
  sunken: "#F7F8FA",        // inputs, code
  ink: "#2A313A",           // primary text
  inkStrong: "#1E242C",     // names, headings ("Graphite")
  muted: "#5E6875",         // secondary text ("Slate")
  faint: "#8B94A0",         // timestamps, hints
  line: "#E2E6EB",          // hairlines ("Rule")
  lineStrong: "#C7CED6",    // field borders
  sidebar: "#F4F6F8",
  sidebarInk: "#3A424C",
  sidebarMuted: "#6B7480",
  sidebarHover: "#E8ECF0",
  sidebarActive: "#DCEDEB",  // active room: a Lagoon tint, not a solid block
  accent: "#0B6E69",         // "Lagoon": primary buttons, focus, active room text
  accentHover: "#085752",
  onAccent: "#FFFFFF",
  tint: "rgba(11, 110, 105, 0.09)",
  link: "#0B6E69",
  ok: "#18794E",
  okBg: "rgba(24, 121, 78, 0.08)",
  warn: "#A15C07",           // dark enough to read as text on white
  warnBg: "#FFF4E0",
  danger: "#C62D3B",
  mention: "#7A5B00",
  mentionBg: "#FFF3C4",      // a highlighter, the way you'd mark your name on paper
  owner: "#1E242C",
  orchestrator: "#0B6E69",   // legacy key: accent text
  shadow: "rgba(30, 36, 44, 0.08)",
  // file changes: tinted rows, with the +/- sign kept so colour is never the only cue
  diffAddBg: "rgba(24, 121, 78, 0.12)",
  diffAddInk: "#12603F",
  diffDelBg: "rgba(198, 45, 59, 0.11)",
  diffDelInk: "#A3232F",
};
export type Palette = typeof light;
export const usePalette = (): Palette => light;

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
