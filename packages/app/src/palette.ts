// 3.1: one palette per mode, with the same keys. No imports, so the contrast tests can load it without React Native.
// theme.ts picks one with usePalette(). Every text pair here is checked for WCAG AA (4.5:1) by test/design.test.ts,
// and hub/web/app.css carries the same values as custom properties (the test compares them).

// Light and quiet: white conversation, a pale cool sidebar, hairlines instead of boxes.
// The chrome stays neutral so each agent's own colour (avatar and name) is what you notice.
export const light = {
  mode: "light" as "light" | "dark",
  canvas: "#FFFFFF",        // conversation pane ("Paper")
  surface: "#F4F6F8",       // side panels, cards ("Mist")
  raised: "#EEF1F4",        // hovered rows, popovers
  sunken: "#F7F8FA",        // inputs, code
  ink: "#2A313A",           // primary text
  inkStrong: "#1E242C",     // names, headings ("Graphite")
  muted: "#5E6875",         // secondary text ("Slate")
  faint: "#5F6874",         // timestamps, hints: still 4.5:1 on every surface
  line: "#E2E6EB",          // hairlines ("Rule")
  lineStrong: "#C7CED6",    // field borders
  sidebar: "#F4F6F8",       // the opaque fallback; on the Mac the sidebar is translucent over this
  sidebarVeil: "rgba(244, 246, 248, 0.45)", // laid over the translucent sidebar so it stays pale; the opaque fallback is `sidebar`
  sidebarInk: "#3A424C",
  sidebarMuted: "#5E6875",
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
  scrim: "rgba(30, 36, 44, 0.22)",   // behind the command palette
  // file changes: tinted rows, with the +/- sign kept so colour is never the only cue
  diffAddBg: "rgba(24, 121, 78, 0.12)",
  diffAddInk: "#12603F",
  diffDelBg: "rgba(198, 45, 59, 0.11)",
  diffDelInk: "#A3232F",
};
export type Palette = typeof light;

// Dark keeps the structure: a near-black canvas, a slightly lighter sidebar, hairlines, one teal. The teal is lifted so it reads as
// text and as a fill, with dark ink on it instead of white.
export const dark: Palette = {
  mode: "dark",
  canvas: "#121518",
  surface: "#1A1E23",
  raised: "#232830",
  sunken: "#0E1114",
  ink: "#D6DBE1",
  inkStrong: "#F2F5F8",
  muted: "#A2ACB8",
  faint: "#8C96A3",
  line: "#2A3038",
  lineStrong: "#434B56",
  sidebar: "#181C21",
  sidebarVeil: "rgba(24, 28, 33, 0.40)",
  sidebarInk: "#CDD3DA",
  sidebarMuted: "#9AA4B0",
  sidebarHover: "#232930",
  sidebarActive: "#16403D",
  accent: "#4DBBB2",
  accentHover: "#6CCBC3",
  onAccent: "#04211F",
  tint: "rgba(77, 187, 178, 0.14)",
  link: "#5FC9C0",
  ok: "#52C78F",
  okBg: "rgba(82, 199, 143, 0.12)",
  warn: "#E8AA4C",
  warnBg: "#33270F",
  danger: "#F27983",
  mention: "#F4D77A",
  mentionBg: "#4A3C10",
  owner: "#E4E9EE",
  orchestrator: "#4DBBB2",
  shadow: "rgba(0, 0, 0, 0.45)",
  scrim: "rgba(0, 0, 0, 0.5)",
  diffAddBg: "rgba(82, 199, 143, 0.16)",
  diffAddInk: "#86DEB0",
  diffDelBg: "rgba(242, 121, 131, 0.16)",
  diffDelInk: "#FFA2AA",
};

/** The pairs that carry text, as [foreground key, background key]. Each must reach 4.5:1 in both palettes. */
export const TEXT_PAIRS: [keyof Palette, keyof Palette][] = [
  ["ink", "canvas"], ["inkStrong", "canvas"], ["muted", "canvas"], ["faint", "canvas"], ["link", "canvas"], ["accent", "canvas"],
  ["ok", "canvas"], ["warn", "canvas"], ["danger", "canvas"],
  ["ink", "surface"], ["inkStrong", "surface"], ["muted", "surface"], ["faint", "surface"], ["accent", "surface"], ["danger", "surface"], ["warn", "surface"],
  ["ink", "raised"], ["muted", "raised"], ["faint", "raised"], ["accent", "raised"], ["ok", "raised"], ["danger", "raised"], ["warn", "raised"],
  ["ink", "sunken"], ["faint", "sunken"], ["warn", "sunken"],
  ["sidebarInk", "sidebar"], ["sidebarMuted", "sidebar"], ["inkStrong", "sidebar"], ["accent", "sidebar"], ["danger", "sidebar"],
  ["sidebarInk", "sidebarHover"], ["sidebarMuted", "sidebarHover"],
  ["accent", "sidebarActive"], ["inkStrong", "sidebarActive"],
  ["onAccent", "accent"], ["onAccent", "accentHover"], ["onAccent", "danger"],
  ["accent", "tint"], ["ok", "okBg"], ["warn", "warnBg"], ["ink", "warnBg"], ["mention", "mentionBg"],
  ["diffAddInk", "diffAddBg"], ["diffDelInk", "diffDelBg"], ["ink", "diffAddBg"], ["ink", "diffDelBg"],
];

/** Tokens only the Mac app has (the sidebar, the owner's tile, the legacy `orchestrator` key). The phone's CSS has every other key, same names in kebab-case. */
export const MAC_ONLY: (keyof Palette)[] = ["mode", "sidebar", "sidebarVeil", "sidebarInk", "sidebarMuted", "sidebarHover", "sidebarActive", "owner", "orchestrator"];

/** Appearance choice kept in Settings. */
export type AppearanceMode = "system" | "light" | "dark";
export const APPEARANCE_MODES: AppearanceMode[] = ["system", "light", "dark"];
