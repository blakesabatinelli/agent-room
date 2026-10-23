import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { AgentConfig, Goal, Message, Room, Task } from "@agent-room/shared";
import { dark, light, MAC_ONLY, TEXT_PAIRS, type Palette } from "../../app/src/palette.js";
import { agentTone, contrast, legibleOn, readableInk } from "../../shared/src/colors.js";
import * as G from "../../shared/src/goalview.js";
import { buildServer } from "../src/api/server.js";
import { ROOM_COMMANDS } from "../src/commands/index.js";
import { setup } from "./helpers.js";

// 3.1 Design refresh. The screens themselves are checked by eye (docs/screenshots/3.1-*.png, docs/design/3.1-screens.md).
// Here is what can break without anyone noticing: contrast in either mode, a token that one app has and the other lacks,
// the goal card and verdict chips drawn from the wrong facts, a palette entry that goes nowhere, and Slack's look creeping back.

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "../web");
const appSrc = join(here, "../../app/src");
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const css = read(webDir, "app.css");
const appJs = read(webDir, "app.js");
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.(tsx?|js)$/.test(n) ? [p] : []; });
}

/** The text between the braces that follow `header` (nested braces are matched). */
function block(src: string, header: string): string {
  const at = src.indexOf(header);
  assert.ok(at >= 0, `app.css has ${header}`);
  let i = src.indexOf("{", at), depth = 0;
  const start = i + 1;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(start, i); }
  throw new Error(`unclosed ${header}`);
}
const tokens = (text: string) => Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().replace(/\s+/g, "").toLowerCase()]));
const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const flat = (v: string) => v.replace(/\s+/g, "").toLowerCase();

const cssLight = tokens(block(css, ":root {"));
const cssDarkAuto = tokens(block(block(css, "@media (prefers-color-scheme: dark)"), ':root:not([data-theme="light"])'));
const cssDarkManual = tokens(block(css, ':root[data-theme="dark"]'));

// ---------- tokens and contrast

test("3.1: light and dark palettes in the Mac app have the same keys", () => {
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
  assert.equal(light.mode, "light");
  assert.equal(dark.mode, "dark");
  for (const k of Object.keys(light) as (keyof Palette)[]) assert.notEqual(dark[k], undefined, `dark has ${k}`);
});

test("3.1: every text pair reaches WCAG AA (4.5:1) in the light palette and in the dark one", () => {
  const low: string[] = [];
  for (const [name, pal] of [["light", light], ["dark", dark]] as const) {
    for (const [fg, bg] of TEXT_PAIRS) {
      const r = contrast(pal[fg] as string, pal[bg] as string, pal.canvas);
      if (!(r >= 4.5)) low.push(`${name} ${fg} on ${bg}: ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(low, []);
});

test("3.1: the accent is the deep teal in light mode, and its text and fills hold in dark", () => {
  assert.equal(light.accent.toLowerCase(), "#0b6e69");
  assert.ok(contrast(dark.accent, dark.canvas) >= 4.5, "teal text on the dark canvas");
  assert.ok(contrast(dark.onAccent, dark.accent) >= 4.5, "text on a teal button in dark");
  assert.ok(contrast(light.onAccent, light.accent) >= 4.5, "text on a teal button in light");
});

test("3.1: agent colours stay legible in both modes: a tile 3:1 against the canvas, its letter 4.5:1 on the tile", () => {
  const colours = ["#6B4FD8", "#0E8A7A", "#B7791F", "#D97757", "#2BAC76", "#E8912D", "#A63A86", "#D9822B", "#D6336C", "#1C7ED6", "#2F9E44", "#B08800", "#7048E8", "#5C6B7A",
    "#000000", "#FFFFFF", "#F5C542", "#101820", "#0B0B3B", "#FFFF00"];
  const bad: string[] = [];
  for (const pal of [light, dark]) for (const c of colours) {
    const t = agentTone(c, pal.canvas);
    if (contrast(t.bg, pal.canvas) < 3) bad.push(`${pal.mode} ${c} tile ${t.bg}`);
    if (contrast(t.ink, t.bg) < 4.5) bad.push(`${pal.mode} ${c} letter on ${t.bg}`);
  }
  assert.deepEqual(bad, []);
  assert.equal(legibleOn("#0E8A7A", light.canvas), "#0E8A7A", "a colour that already shows is not touched");
  assert.equal(readableInk("#FFFFFF"), "#101418");
  assert.equal(readableInk("#0B6E69"), "#FFFFFF");
});

test("3.1: app.css defines the same tokens as the Mac palette, same values, light and dark (system and chosen)", () => {
  const want = (Object.keys(light) as (keyof Palette)[]).filter((k) => !MAC_ONLY.includes(k)).map(kebab).sort();
  for (const [name, set] of [["light", cssLight], ["dark (system)", cssDarkAuto], ["dark (chosen)", cssDarkManual]] as const) {
    assert.deepEqual(Object.keys(set).filter((k) => k !== "display").sort(), want, `${name} tokens`);
  }
  for (const [pal, set, name] of [[light, cssLight, "light"], [dark, cssDarkAuto, "dark system"], [dark, cssDarkManual, "dark chosen"]] as const) {
    for (const k of Object.keys(pal) as (keyof Palette)[]) {
      if (MAC_ONLY.includes(k)) continue;
      assert.equal(set[kebab(k)], flat(pal[k] as string), `${name}: --${kebab(k)}`);
    }
  }
  assert.match(css, /color-scheme: light;/);
  assert.equal((css.match(/color-scheme: dark;/g) ?? []).length, 2, "both dark blocks tell the browser it is dark");
});

test("3.1: the text pairs hold on the phone's own tokens too", () => {
  const low: string[] = [];
  for (const [name, set, canvas] of [["light", cssLight, cssLight.canvas], ["dark", cssDarkAuto, cssDarkAuto.canvas]] as const) {
    for (const [fg, bg] of TEXT_PAIRS) {
      const f = set[kebab(fg)], b = set[kebab(bg)];
      if (!f || !b) continue;
      const r = contrast(f, b, canvas);
      if (!(r >= 4.5)) low.push(`${name} --${kebab(fg)} on --${kebab(bg)}: ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(low, []);
});

test("3.1: both apps follow the system and can be told otherwise", () => {
  // Mac: palette per mode, usePalette follows useColorScheme, Settings has System, Light and Dark.
  const theme = read(appSrc, "theme.ts");
  assert.match(theme, /useColorScheme\(\)/);
  assert.match(theme, /mode === "system" \? system === "dark"/);
  const choices = read(appSrc, "palette.ts");
  assert.match(choices, /APPEARANCE_MODES: AppearanceMode\[\] = \["system", "light", "dark"\]/);
  assert.match(read(appSrc, "screens/SettingsScreen.tsx"), /<Appearance \/>/);
  assert.match(read(appSrc, "components/Appearance.tsx"), /System: "System", light: "Light", dark: "Dark"|system: "System", light: "Light", dark: "Dark"/);
  assert.doesNotMatch(read(here, "../../app/macos/AgentRoom-macOS/AppDelegate.mm"), /NSAppearance appearanceNamed:NSAppearanceNameAqua\]/, "the window is no longer forced light");
  // Phone: tokens in CSS, system by media query, override by data-theme, kept by theme.js before first paint.
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  const html = read(webDir, "index.html");
  assert.ok(html.indexOf("/web/theme.js") > 0 && html.indexOf("/web/theme.js") < html.indexOf("</head>"), "theme.js is in the head");
  assert.match(read(webDir, "theme.js"), /setAttribute\("data-theme", mode\)/);
  assert.match(appJs, /data-theme-mode/);
  // theme.js paints agent tiles against the same canvas the tokens say
  assert.match(read(webDir, "theme.js"), new RegExp(`isDark\\(\\) \\? "${dark.canvas}" : "${light.canvas}"`, "i"));
});

test("3.1: no colour is written into a component or a rule; they come from the palette and the tokens", () => {
  const allowed = new Set(["palette.ts", "theme.ts"]);
  const offenders: string[] = [];
  for (const f of files(appSrc)) {
    if (allowed.has(f.split("/").pop()!)) continue;
    read(f).split("\n").forEach((line, i) => {
      if (/SWATCHES|COLORS|color: "#|hint=|colour like/.test(line)) return; // the owner's own choices for an agent's colour
      if (/#[0-9a-fA-F]{6}\b/.test(line) || /rgba?\(/.test(line)) offenders.push(`${f.replace(appSrc, "")}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [], "Mac: use the palette");
  const outside = css.replace(block(css, ":root {"), "").replace(block(css, "@media (prefers-color-scheme: dark)"), "").replace(block(css, ':root[data-theme="dark"]'), "");
  assert.deepEqual(outside.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [], [], "phone: use the tokens");
});

// ---------- goal card and verdict chips: the Mac's logic and the phone's port agree

const web = (() => {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(read(webDir, "goalview.js"), sandbox);
  return sandbox.window.ARView as Record<string, (...a: unknown[]) => unknown>;
})();

const NOW = 1_700_000_000_000;
const goal = (over: Partial<Goal> = {}): Goal => ({ id: "g1", roomId: "r1", text: "Write the poem", status: "running", createdAt: NOW, ...over });
const task = (over: Partial<Task> = {}): Task => ({
  id: "t1", roomId: "r1", goalId: "g1", title: "Draft", description: "", taskType: "writing", acceptance: "", dependsOn: [], status: "running", attempts: 1, createdAt: NOW, updatedAt: NOW, ...over,
});
const withJury = (split: boolean) => ({
  id: "j1", kind: "jury" as const, judges: [
    { agentId: "claude", family: "anthropic", local: false, verdict: "accept" as const, score: 0.9 },
    { agentId: "codex", family: "openai", local: false, verdict: split ? ("revise" as const) : ("accept" as const), score: split ? 0.4 : 0.8 },
    { agentId: "local", family: "local-llama", local: true, verdict: "accept" as const, score: 0.85 },
  ], agreement: { majority: split ? 0.67 : 1, pairwise: 1, kappa: null, spread: 0.1 }, split,
});
const judged = (verdict: "accept" | "revise" | "reassign", score: number, split?: boolean): Task["judgment"] => ({ score, verdict, feedback: "", judgeAgentId: "claude", ...(split === undefined ? {} : { jury: withJury(split) }) });

test("3.1 goal card: objective, Done means, progress and state come from the goal and its tasks", () => {
  const g = goal({
    contract: { objective: "A poem about bars", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: NOW, amendments: [], requirements: [
      { id: "G1", text: "Two lines", status: "met" }, { id: "G2", text: "Mentions a bar" }, { id: "G3", text: "Rhymes", status: "unmet", evidence: "No rhyme in line 2" },
    ] },
    state: { decisions: [], nextAction: "Judging the draft" },
  });
  const m = G.goalCardModel(g, [task({ status: "done" }), task({ id: "t2" }), task({ id: "t3", status: "cancelled" }), task({ id: "t4", goalId: "other", status: "done" })]);
  assert.equal(m.objective, "A poem about bars");
  assert.deepEqual(m.requirements.map((r) => `${r.id} ${r.status}`), ["G1 met", "G2 open", "G3 unmet"]);
  assert.deepEqual([m.met, m.total, m.tasksDone, m.tasksTotal], [1, 3, 1, 2], "cancelled and other goals' tasks are not counted");
  assert.equal(G.goalProgressLine(m), "1 of 3 met, 1 of 2 tasks done");
  assert.equal(G.goalFraction(m), 1 / 3);
  assert.deepEqual(m.state, { key: "running", label: "Running", tone: "accent" });
  assert.deepEqual(m.note, { kind: "next", text: "Judging the draft" });
  assert.equal(m.live, true);
});

test("3.1 goal card: planning, awaiting approval, running, waiting on you and done each have their own state", () => {
  const key = (g: Goal) => G.goalCardModel(g, []).state.label;
  assert.equal(key(goal({ status: "planning" })), "Planning");
  assert.equal(key(goal({ status: "awaiting_approval" })), "Awaiting approval");
  assert.equal(key(goal({ status: "running" })), "Running");
  assert.equal(key(goal({ status: "paused", state: { decisions: [], nextAction: "", waitingOnOwner: "Which tone?" } })), "Waiting on you");
  assert.equal(key(goal({ status: "paused" })), "Paused");
  assert.equal(key(goal({ status: "done" })), "Done");
  assert.equal(key(goal({ status: "failed" })), "Failed");
  const waiting = G.goalCardModel(goal({ status: "paused", state: { decisions: [], nextAction: "x", waitingOnOwner: "Which tone?" } }), []);
  assert.deepEqual(waiting.note, { kind: "waiting", text: "Which tone?" });
  assert.equal(G.goalCardModel(goal({ status: "done" }), []).live, false, "a finished goal opens collapsed");
  assert.equal(G.goalFraction(G.goalCardModel(goal({ status: "done" }), [])), 1);
  // before the plan is written the card has the owner's words and no list
  const early = G.goalCardModel(goal({ status: "planning" }), []);
  assert.equal(early.objective, "Write the poem");
  assert.equal(early.total, 0);
});

test("3.1 goal card: the live goal wins; otherwise the newest; superseded goals never show", () => {
  const a = goal({ id: "a", status: "done", createdAt: NOW + 2 }), b = goal({ id: "b", status: "running", createdAt: NOW }), c = goal({ id: "c", status: "superseded", createdAt: NOW + 5 });
  assert.equal(G.pickGoal([a, b, c])?.id, "b");
  assert.equal(G.pickGoal([a, c])?.id, "a");
  assert.equal(G.pickGoal([c]), undefined);
  assert.equal(G.pickGoal([]), undefined);
});

test("3.1 verdict chips: accepted, sent back, disputed, with the score; a jury split is a dispute even when the verdict was accept", () => {
  const chip = (t: Task) => G.verdictChip(t);
  assert.deepEqual(chip(task({ status: "done", judgment: judged("accept", 0.92) })), { key: "accepted", label: "Accepted", tone: "ok", glyph: "✓", score: 92 });
  assert.deepEqual(chip(task({ status: "revising", judgment: judged("revise", 0.41) })), { key: "sent_back", label: "Sent back", tone: "warn", glyph: "↩", score: 41 });
  assert.deepEqual(chip(task({ status: "running", judgment: judged("reassign", 0.2) })), { key: "reassigned", label: "Reassigned", tone: "warn", glyph: "⇄", score: 20 });
  assert.deepEqual(chip(task({ status: "done", judgment: judged("accept", 0.7, true) })), { key: "disputed", label: "Disputed", tone: "warn", glyph: "≠", score: 70 });
  assert.equal(chip(task({ status: "done", judgment: judged("accept", 0.9, false) }))?.key, "accepted", "a jury that agreed is not a dispute");
  assert.equal(chip(task({ status: "review" }))?.label, "Being judged");
  assert.equal(chip(task({ status: "waiting" }))?.label, "Needs you");
  assert.equal(chip(task({ status: "failed" }))?.label, "Failed");
  assert.equal(chip(task({ status: "running" })), null, "nothing to say while it runs");
  assert.equal(chip(task({ status: "pending" })), null);
  for (const t of [judged("accept", 1), judged("revise", 0.5, true), judged("reassign", 0)]) assert.ok((chip(task({ judgment: t, status: "done" }))?.glyph.length ?? 0) > 0, "every chip has a glyph, so colour is never the only cue");
});

test("3.1 verdict chips: one per task, on its last message from the agent; quiet lines and other authors are skipped", () => {
  const m = (id: string, taskId: string | undefined, over: Partial<Message> = {}): Message => ({
    id, roomId: "r1", type: "agent", author: { kind: "agent", id: "claude", name: "Claude" }, text: "x", mentions: [], taskId, createdAt: NOW, ...over,
  });
  const out = G.chipMessageIds([
    m("a1", "t1"), m("a2", "t1"), m("b1", "t2"), m("q", "t2", { quiet: true, type: "task_update", author: { kind: "orchestrator", id: "orchestrator", name: "Orchestrator" } }),
    m("s", "t1", { type: "system", author: { kind: "system", id: "system", name: "Agent Room" } }), m("free", undefined),
  ]);
  assert.deepEqual([...out.entries()].sort(), [["a2", "t1"], ["b1", "t2"]]);
});

test("3.1: the phone's port answers exactly like the shared code (goal card, chips, palette, colours)", () => {
  const goals: Goal[] = [
    goal({ status: "planning" }), goal({ status: "awaiting_approval" }), goal({ status: "done", summary: "x" }),
    goal({ status: "paused", state: { decisions: [], nextAction: "n", waitingOnOwner: "Which tone?" } }),
    goal({ status: "running", state: { decisions: [], nextAction: "Judging" }, contract: { objective: "Obj", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: NOW, amendments: [], requirements: [{ id: "G1", text: "a", status: "met" }, { id: "G2", text: "b", status: "unmet", evidence: "why" }, { id: "G3", text: "c" }] } }),
  ];
  const tasks = [task({ status: "done" }), task({ id: "t2", status: "cancelled" }), task({ id: "t3", status: "running" })];
  for (const g of goals) {
    assert.deepEqual(plain(web.goalCardModel(g, tasks)), plain(G.goalCardModel(g, tasks)), g.status);
    const m = G.goalCardModel(g, tasks);
    assert.equal(web.goalProgressLine(m), G.goalProgressLine(m));
    assert.equal(web.goalFraction(m), G.goalFraction(m));
  }
  assert.equal((web.pickGoal(plain(goals)) as Goal).status, G.pickGoal(goals)!.status);
  const ts: Task[] = [
    task({ status: "done", judgment: judged("accept", 0.92) }), task({ status: "revising", judgment: judged("revise", 0.41) }), task({ judgment: judged("reassign", 0.2) }),
    task({ status: "done", judgment: judged("accept", 0.7, true) }), task({ status: "review" }), task({ status: "waiting" }), task({ status: "failed" }), task({ status: "running" }),
  ];
  for (const t of ts) assert.deepEqual(plain(web.verdictChip(t)), plain(G.verdictChip(t)), `${t.status} ${t.judgment?.verdict}`);
  const msgs = [{ id: "a1", taskId: "t1", author: { kind: "agent" } }, { id: "a2", taskId: "t1", author: { kind: "agent" } }, { id: "b", taskId: "t2", author: { kind: "agent" } }, { id: "c", taskId: "t3", quiet: true, author: { kind: "agent" } }] as unknown as Message[];
  assert.deepEqual(plain(web.chipMessageIds(msgs)), Object.fromEntries([...G.chipMessageIds(msgs)]));
  for (const mode of [light, dark]) for (const c of ["#6B4FD8", "#F5C542", "#101820", "#E8912D", "#fff", "#bad"]) {
    assert.deepEqual(plain(web.agentTone(c, mode.canvas)), plain(agentTone(c, mode.canvas)), `${mode.mode} ${c}`);
    assert.equal(web.contrast(c, mode.canvas), contrast(c, mode.canvas));
  }
  const input = {
    rooms: [{ id: "r1", name: "general", paused: false }, { id: "r2", name: "sales", paused: true }, { id: "d1", name: "dm", dmAgentId: "claude", paused: false }],
    agents: [{ id: "claude", name: "Claude", enabled: true }, { id: "hermes", name: "Hermes", enabled: true }, { id: "muse", name: "Muse", enabled: false }],
    screens: G.PALETTE_SCREENS.map((s) => s.id),
  };
  for (const platform of ["mac", "phone"] as const) for (const currentRoomId of [undefined, "r1", "r2", "d1"]) {
    const args = { ...input, currentRoomId, platform };
    assert.deepEqual(plain(web.paletteItems(args)), plain(G.paletteItems(args)), `${platform} ${currentRoomId}`);
  }
  const items = G.paletteItems({ ...input, currentRoomId: "r1", platform: "mac" });
  for (const q of ["", "go", "pause", "SALES", "dm", "résumé", "goal in", "zzz", "start  goal", "scor"]) {
    assert.deepEqual((plain(web.filterPalette(items, q)) as { id: string }[]).map((i) => i.id), G.filterPalette(items, q).map((i) => i.id), `query "${q}"`);
  }
});

// ---------- the command palette: everything in it goes somewhere real

const room = (over: Partial<Room> & { id: string; name: string }): Room => ({ paused: false, createdAt: NOW, ...over });
const agentRow = (id: string, name: string, enabled = true): Pick<AgentConfig, "id" | "name" | "enabled"> => ({ id, name, enabled });

test("3.1 palette: rooms, agents, room commands, screens and goals, filtered by what is typed", () => {
  const items = G.paletteItems({
    rooms: [room({ id: "r1", name: "general" }), room({ id: "r2", name: "sales" }), room({ id: "d1", name: "dm", dmAgentId: "claude" })],
    agents: [agentRow("claude", "Claude"), agentRow("hermes", "Hermes"), agentRow("muse", "Muse", false)],
    currentRoomId: "r1", screens: G.PALETTE_SCREENS.map((s) => s.id), platform: "mac",
  });
  const by = (g: string) => items.filter((i) => i.group === g).map((i) => i.title);
  assert.deepEqual(by("Rooms"), ["general", "sales"]);
  assert.deepEqual(by("Agents"), ["Claude", "Hermes"], "an agent that is switched off is not offered");
  assert.deepEqual(by("Goals"), ["Start a goal here", "Start a goal in sales"]);
  assert.deepEqual(items.filter((i) => i.group === "Room commands").map((i) => i.action), [{ kind: "command", text: "/pause" }, { kind: "command", text: "/stop" }, { kind: "command", text: "/digest" }], "pause, not resume, in a room that is running");
  for (const name of ["Approvals", "Folders", "Permissions", "Settings", "Scorecard", "Résumés", "Office"]) assert.ok(by("Screens").includes(name), name);
  assert.equal(G.filterPalette(items, "pau")[0].title, "Pause the room");
  assert.equal(G.filterPalette(items, "claude")[0].title, "Claude", "a title that starts with the word comes first");
  assert.deepEqual(G.filterPalette(items, "zzzz"), []);
  assert.equal(G.filterPalette(items, "resume").some((i) => i.title === "Résumés"), true, "accents don't get in the way");
  assert.equal(G.filterPalette(items, "").length, items.length);
  // paused room: resume instead of pause; a DM has no goals or commands of the room kind beyond the room's own
  const paused = G.paletteItems({ rooms: [room({ id: "r1", name: "general", paused: true })], agents: [], currentRoomId: "r1", screens: [], platform: "mac" });
  assert.deepEqual(paused.filter((i) => i.group === "Room commands").map((i) => i.title), ["Resume the room", "Stop all work", "Digest this room"]);
  const noRoom = G.paletteItems({ rooms: [room({ id: "r1", name: "general" })], agents: [], screens: ["approvals"], platform: "mac" });
  assert.equal(noRoom.some((i) => i.group === "Room commands"), false, "commands need a room on screen");
});

test("3.1 palette: every screen it offers is a real Mac page with a screen behind it, and a real phone view", () => {
  const store = read(appSrc, "state/store.ts");
  const pageUnion = /export type Page = ([^;]+);/.exec(store)![1];
  const pages = [...pageUnion.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  const app = read(appSrc, "App.tsx");
  const mapBody = /const pages: Record<Page, React\.ReactNode> = \{([\s\S]*?)\n  \};/.exec(app)![1];
  const mapped = [...mapBody.matchAll(/\b([a-z]+): <([A-Za-z]+)/g)].map((m) => ({ page: m[1], screen: m[2] }));
  assert.deepEqual(mapped.map((m) => m.page).sort(), [...pages].sort(), "every Page has a screen in App.tsx");
  for (const m of mapped) {
    const f = join(appSrc, "screens", `${m.screen}.tsx`);
    assert.ok(existsSync(f), `${m.screen}.tsx exists`);
    assert.match(read(f), new RegExp(`export function ${m.screen}\\b`), `${m.screen} is exported`);
    assert.match(app, new RegExp(`import \\{ ${m.screen} \\} from "\\./screens/${m.screen}"`));
  }
  const PENDING = ["office"]; // 3.4 adds the Office page; the palette lists it as soon as App.tsx has it
  for (const s of G.PALETTE_SCREENS) {
    if (s.mac) assert.ok(pages.includes(s.mac) || PENDING.includes(s.mac), `Mac page ${s.mac}`);
  }
  for (const pg of pages) assert.ok(G.PALETTE_SCREENS.some((s) => s.mac === pg), `the palette can reach the ${pg} page`);
  // Phone: each view the palette names is rendered by render(), and the sheet passes the list it can open
  const render = /function render\(\) \{([\s\S]*?)\n  \}\n/.exec(appJs)![1];
  const phoneScreens = G.PALETTE_SCREENS.filter((s) => s.phone);
  for (const s of phoneScreens.filter((x) => x.id !== "agents")) assert.match(render, new RegExp(`st\\.view === "${s.phone}"`), `phone view ${s.phone}`);
  assert.match(render, /st\.view === "personas"/);
  const passed = /const PHONE_SCREENS = \[([^\]]*)\]/.exec(appJs)![1].match(/"([a-z]+)"/g)!.map((x) => x.slice(1, -1)).sort();
  assert.deepEqual(passed, phoneScreens.map((s) => s.id).sort(), "the phone offers exactly the screens it has");
  for (const s of phoneScreens.filter((x) => x.id !== "approvals")) assert.match(appJs, new RegExp(`data-nav="\\$\\{view\\}"|nav\\("${s.phone}"|"${s.phone}": "${s.phone}"|${s.id}: "${s.phone}"`), `phone can open ${s.id}`);
  assert.match(appJs, /if \(t\.dataset\.nav === "appearance"\)/);
});

test("3.1 palette: its room commands are ones the hub handles, and running them as messages works", async () => {
  const hubNames = ROOM_COMMANDS.map((c) => c.name);
  for (const c of G.ROOM_COMMANDS) assert.ok(hubNames.includes(c.name), `/${c.name} is a room command in the hub`);
  const { orch, room: r, store } = setup();
  await orch.handleOwnerMessage(r.id, "/pause");
  assert.equal(store.getRoom(r.id)!.paused, true);
  await orch.handleOwnerMessage(r.id, "/resume");
  assert.equal(store.getRoom(r.id)!.paused, false);
  await orch.handleOwnerMessage(r.id, "/stop");
  await orch.handleOwnerMessage(r.id, "/digest");
  assert.ok(store.listMessages(r.id).some((m) => m.text === "/digest" && m.author.kind === "human"), "digest was received as a message");
});

test("3.1 phone: the new files are served, ordered, and the page keeps the CSP (no inline styles or scripts)", async (t) => {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake", restrictInterfaces: false });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  for (const f of ["goalview.js", "theme.js", "app.css"]) assert.equal((await fetch(`${base}/web/${f}`)).status, 200, f);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.indexOf("/web/goalview.js") > html.indexOf("/web/diff.js") && html.indexOf("/web/goalview.js") < html.indexOf("/web/app.js"), "goalview.js loads before app.js");
  for (const id of ['id="goal"', 'id="jump"', 'id="jumpInput"', 'id="jumpBtn"', 'id="themeColor"']) assert.ok(html.includes(id), id);
  for (const [name, src] of [["goalview.js", read(webDir, "goalview.js")], ["theme.js", read(webDir, "theme.js")], ["app.js", appJs]] as const) {
    assert.doesNotMatch(src, /\sstyle\s*=\s*["'`\\]/, `${name}: no style attributes`);
    assert.doesNotMatch(src, /setAttribute\(\s*["']style["']/, `${name}: no setAttribute("style")`);
    assert.doesNotMatch(src, /—|–/, `${name}: no em or en dashes in copy`);
  }
  assert.match(appJs, /"\/rooms\/\$\{id\}\/tasks"|`\/rooms\/\$\{id\}\/tasks`/, "the phone reads the room's tasks for the chips and the card");
  assert.match(appJs, /case "task":/, "and keeps them live");
});

// ---------- nothing from Slack's visual identity

test("3.1 audit: no Slack names, colours or patterns in either app", () => {
  const SLACK_COLOURS = ["#4A154B", "#611F69", "#E01E5A", "#36C5F0", "#2EB67D", "#ECB22E", "#350D36"];
  const sources = [...files(appSrc), join(webDir, "app.js"), join(webDir, "app.css"), join(webDir, "index.html"), join(webDir, "goalview.js"), join(here, "../src/seed.ts"), join(here, "../src/discovery/invite.ts")];
  const hits: string[] = [];
  for (const f of sources) {
    const text = read(f);
    for (const c of SLACK_COLOURS) if (text.toUpperCase().includes(c)) hits.push(`${f.replace(join(here, ".."), "")}: ${c}`);
    if (/like a slack|slack-style|slack style|slack's/i.test(text)) hits.push(`${f.replace(join(here, ".."), "")}: names Slack as a model`);
    if (/reaction|addReaction|emoji-?picker|react-with/i.test(text.replace(/React Native|react-native|reactNative/g, ""))) hits.push(`${f.replace(join(here, ".."), "")}: reactions`);
  }
  assert.deepEqual(hits, []);
  // the sidebar is pale (or translucent), never a solid dark or purple block, in both modes' light palette
  assert.ok(contrast(light.sidebar, light.canvas) < 1.2, "the light sidebar is nearly the canvas colour");
  // headings of the lists say what they hold
  assert.doesNotMatch(appJs, /Channels|Direct messages/);
  assert.doesNotMatch(read(appSrc, "components/Sidebar.tsx"), /label="Channels"|label="Direct messages"/);
  assert.doesNotMatch(read(appSrc, "screens/RoomScreen.tsx"), /`# \$\{|Message #\$\{/, "rooms are not written with a hash sign");
  assert.doesNotMatch(appJs, /`# \$\{room\.name\}`/);
});

test("3.1: the Mac sidebar is translucent where the build can do it, and pale and opaque where it can't", () => {
  const surface = read(appSrc, "components/SidebarSurface.tsx");
  assert.match(surface, /if \(!VisualEffectView\) return <View style=\{\{ flex: 1, backgroundColor: p\.sidebar \}\}>/, "fallback: the opaque pale sidebar");
  assert.match(surface, /material="sidebar" blending="behindWindow"/);
  const shell = read(appSrc, "native/shell.ts");
  assert.match(shell, /shell\?\.hasVisualEffect \? requireNativeComponent/, "only asked for when the native module says it is there");
  const m = read(here, "../../app/macos/AgentRoom-macOS/ARShell.m");
  for (const needle of ["NSVisualEffectView", "NSVisualEffectMaterialSidebar", "NSVisualEffectBlendingModeBehindWindow", "RCT_EXPORT_MODULE(ARVisualEffectView)", "@\"hasVisualEffect\"", "ARGoTo", "keyEquivalent:@\"k\"", "NSEventModifierFlagCommand"]) assert.ok(m.includes(needle), needle);
  const proj = read(here, "../../app/macos/AgentRoom.xcodeproj/project.pbxproj");
  assert.equal(proj.split("\n").filter((l) => l.includes("ARShell.m")).length, 4, "ARShell.m is in the build file, file reference, group and sources sections");
  assert.match(read(appSrc, "components/Sidebar.tsx"), /<SidebarSurface>[\s\S]*<\/SidebarSurface>/);
  // light mode keeps the pale look: the veil over the material is the sidebar's own colour
  assert.match(light.sidebarVeil, /^rgba\(244, 246, 248,/);
});

test("3.1: the Mac palette opens on ⌘K, in the window and from the menu, and the sidebar has a way in", () => {
  const app = read(appSrc, "App.tsx");
  assert.match(app, /keyDownEvents: \[\{ key: "k", metaKey: true \}\]/);
  assert.match(app, /onGoTo\(togglePalette\)/);
  assert.match(read(appSrc, "components/CommandPalette.tsx"), /\{ key: "ArrowDown" \}, \{ key: "ArrowUp" \}, \{ key: "Escape" \}/);
  assert.match(read(appSrc, "components/CommandPalette.tsx"), /onSubmitEditing=\{\(\) => run\(shown\[sel\]\)\}/);
  assert.match(read(appSrc, "components/Sidebar.tsx"), /Go to…/);
  assert.match(read(here, "../../app/macos/AgentRoom-macOS/ARShell.m"), /@selector\(goTo:\)/);
});
