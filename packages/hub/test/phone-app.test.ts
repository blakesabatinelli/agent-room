import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { Task } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { localPairHeaders, setup } from "./helpers.js";

// QA pass over the phone web app. The real-browser walk (Playwright, 390x844, light and dark) lives outside the suite because it needs Chromium;
// these are the parts of it that need no browser: the page's own code run against a real hub with a small stand-in for the DOM, and the
// source checks that catch what a merge of several engineers' edits leaves behind (a key written twice, a case that can never run, a
// colour variable that was never defined).

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "../web");
const read = (f: string) => readFileSync(join(webDir, f), "utf8");
const appJs = read("app.js");
const appCss = read("app.css");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await sleep(10); }
}

// ---------------------------------------------------------------- source checks

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

test("QA: app.js has no key written twice in its state object, no case that can never run, no function declared twice", () => {
  const open = appJs.indexOf("const st = {") + "const st = ".length;
  const keys = new Map<string, number>();
  const dupes: string[] = [];
  // Every `name:` at the top of the object, however many sit on one line (a line can hold several, and a comment can hold a colon).
  const body = appJs.slice(open, appJs.indexOf("\n  };", open));
  for (const m of body.matchAll(/(?:^|[,{]\s*|\n\s*)([A-Za-z_]\w*):(?!:)/g)) {
    // only keys at depth 1: count braces and brackets before the match
    const before = body.slice(0, m.index! + m[0].length).replace(/\/\/[^\n]*/g, "").replace(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, "");
    const depth = [...before].reduce((d, c) => d + ("{[(".includes(c) ? 1 : "}])".includes(c) ? -1 : 0), 0);
    if (depth !== 1) continue;
    if (keys.has(m[1])) dupes.push(`${m[1]} (lines ${keys.get(m[1])} and ${lineOf(appJs, open + m.index!)})`); else keys.set(m[1], lineOf(appJs, open + m.index!));
  }
  assert.deepEqual(dupes, [], "a key written twice in st: the later one silently replaces the earlier");
  assert.ok(keys.has("tasks") && keys.has("taskList") && keys.has("settings"), "the three task and settings keys are all there");

  const sw = appJs.indexOf("switch (e.type) {");
  const caseLabels = [...appJs.slice(sw, appJs.indexOf("\n  }\n", sw)).matchAll(/\n      case "(\w+)":/g)].map((m) => m[1]);
  assert.ok(caseLabels.length >= 10, "found the live-event switch");
  assert.deepEqual(caseLabels.filter((c, i) => caseLabels.indexOf(c) !== i), [], "an event case written twice: the second can never run");

  const fns = [...appJs.matchAll(/\n  (?:async )?function (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(fns.filter((f, i) => fns.indexOf(f) !== i), [], "a function declared twice in the app's scope");
});

test("QA: every screen the app can open is drawn by render(), and Back leads somewhere that exists", () => {
  const views = new Set<string>();
  for (const m of appJs.matchAll(/\bgo\("(\w+)"/g)) views.add(m[1]);
  for (const m of appJs.matchAll(/st\.view = "(\w+)"/g)) views.add(m[1]);
  const renderSrc = appJs.slice(appJs.indexOf("  function render() {"), appJs.indexOf("  function renderDot()"));
  const drawn = new Set([...renderSrc.matchAll(/st\.view === "(\w+)"\) return/g)].map((m) => m[1]));
  for (const v of views) assert.ok(v === "room" || drawn.has(v), `render() draws "${v}"`);
  // every view the code compares against is one it can be in
  const compared = new Set([...appJs.matchAll(/st\.view [!=]== "(\w+)"/g)].map((m) => m[1]));
  for (const v of compared) assert.ok(views.has(v) || v === "room", `st.view is never set to "${v}" but is compared with it`);
  // Back: the screens with their own parent, then Rooms for the rest
  const back = appJs.slice(appJs.indexOf('$("#back").onclick'), appJs.indexOf('$("#tasksBtn").onclick'));
  for (const v of [...back.matchAll(/st\.view === "(\w+)"/g)].map((m) => m[1])) assert.ok(views.has(v), `the Back handler names "${v}", which is not a screen`);
  for (const v of ["tasks", "roominfo", "fork", "diff", "persona"]) assert.match(back, new RegExp(`st\\.view === "${v}"`), `Back knows ${v}`);
  // a title for each screen
  const titled = new Set([...appJs.slice(appJs.indexOf("  function render() {"), appJs.indexOf("  function renderDot()")).matchAll(/st\.view === "(\w+)"\s*\?|st\.view === "(\w+)"\) \$\("#title"\)/g)].map((m) => m[1] ?? m[2]));
  for (const v of views) if (v !== "rooms" && v !== "pair") assert.ok(titled.has(v) || v === "room", `the header says what "${v}" is`);
});

test("QA: every var(--x) in the phone app's CSS is defined in light, in dark (system) and in dark (chosen)", () => {
  for (const file of ["app.css", "office.css"]) {
    const css = read(file);
    const used = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
    const block = (head: RegExp) => {
      const m = head.exec(css); assert.ok(m, `${file} has ${head}`);
      let i = css.indexOf("{", m!.index), depth = 0, j = i;
      for (; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) break; }
      return css.slice(i, j);
    };
    const defined = (b: string) => new Set([...b.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const fallback0 = (name: string) => new RegExp(`var\\(${name},`).test(css);
    if (file === "office.css") { // 3.4b: the office is dark first; data-theme="light" is its variant
      const base = defined(block(/(^|\n):root \{/)), lightVariant = defined(block(/:root\[data-theme="light"\]/));
      for (const v of used) if (!fallback0(v)) assert.ok(base.has(v), `${file}: ${v} is used but not defined`);
      for (const v of lightVariant) assert.ok(base.has(v), `${file}: the light variant redefines ${v}, which the dark base never defines`);
      continue;
    }
    const light = defined(block(/(^|\n):root \{/));
    const darkSystem = defined(block(/@media \(prefers-color-scheme: dark\)/));
    const darkChosen = defined(block(/:root\[data-theme="dark"\]/));
    // set by the page's own script, with a fallback in the rule
    const fallback = (name: string) => new RegExp(`var\\(${name},`).test(css);
    for (const v of used) {
      if (fallback(v)) continue;
      assert.ok(light.has(v), `${file}: ${v} is used but not defined for light`);
      // a token that is the same in both modes (like --display) may only be defined once, in the base block
      if (darkSystem.size) assert.ok(darkSystem.has(v) || light.has(v), `${file}: ${v} is not defined in dark`);
      assert.ok(darkChosen.has(v) || light.has(v), `${file}: ${v} is not defined in dark (chosen)`);
    }
    assert.deepEqual([...darkSystem].sort(), [...darkChosen].sort(), `${file}: the two dark blocks define the same tokens`);
  }
});

test("QA: the header's room tools take a row of their own, so a room's name stays readable at 390px", () => {
  assert.match(appCss, /#bar\.tools\s*\{[^}]*flex-wrap: wrap/);
  assert.match(appJs, /\$\("#bar"\)\.classList\.toggle\("tools", st\.view === "room"\)/);
});

// ---------------------------------------------------------------- the page's own code, against a real hub

type Handler = (e: Record<string, unknown>) => unknown;
class FakeEl {
  innerHTML = ""; textContent = ""; value = ""; hidden = false; className = ""; disabled = false; checked = false; scrollTop = 0;
  scrollHeight = 0; clientHeight = 0; offsetTop = 0; id = "";
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; children: unknown[] = [];
  onclick: (() => unknown) | null = null; onsubmit: unknown = null;
  classList = { toggle: () => false, add: () => undefined, remove: () => undefined, contains: () => false };
  addEventListener() {} removeEventListener() {} focus() {} scrollIntoView() {} scrollTo() {} remove() {} click() {}
  append(...k: unknown[]) { this.children.push(...k); } replaceChildren(...k: unknown[]) { this.children = k; this.innerHTML = ""; }
  setAttribute() {} getAttribute() { return null; } removeAttribute() {}
  querySelector() { return null; } querySelectorAll() { return []; } closest() { return null; } matches() { return false; }
}

/** Runs the phone app's scripts the way the page loads them, with a stand-in for the DOM and a real hub behind fetch. */
function phoneApp(base: string, token: string) {
  const els = new Map<string, FakeEl>();
  const handlers: Record<string, Handler[]> = {};
  const sockets: { onmessage?: (m: { data: string }) => void }[] = [];
  const el = (s: string) => { let e = els.get(s); if (!e) els.set(s, e = new FakeEl()); return e; };
  const unref = <T extends { unref?: () => void }>(t: T) => { t.unref?.(); return t; };
  const sandbox: Record<string, unknown> = {
    console, URL, setTimeout: (f: () => void, ms?: number) => unref(setTimeout(f, ms)), clearTimeout, setInterval: (f: () => void, ms?: number) => unref(setInterval(f, ms)), clearInterval,
    requestAnimationFrame: (f: () => void) => unref(setTimeout(f, 0)),
    document: {
      querySelector: el, querySelectorAll: () => [], createElement: () => new FakeEl(), createTextNode: (t: string) => ({ nodeType: 3, textContent: String(t) }), getElementById: () => null,
      documentElement: new FakeEl(), body: new FakeEl(), visibilityState: "visible",
      addEventListener: (t: string, fn: Handler) => { (handlers[t] ||= []).push(fn); },
    },
    localStorage: { getItem: (k: string) => (k === "agentroom.token" ? token : null), setItem() {}, removeItem() {} },
    navigator: { userAgent: "Mozilla/5.0 (iPhone)", standalone: false },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { protocol: "http:", host: new URL(base).host, hash: "", pathname: "/", search: "" }, history: { replaceState() {} },
    addEventListener() {}, innerWidth: 390, innerHeight: 844, CSS: { escape: (s: string) => s }, confirm: () => true, prompt: () => "",
    fetch: (u: string, init?: RequestInit) => fetch(u.startsWith("/") ? base + u : u, init),
    WebSocket: class { onmessage?: (m: { data: string }) => void; constructor() { sockets.push(this); } close() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ["theme.js", "diff.js", "goalview.js", "fork.js", "app.js"]) vm.runInContext(read(f), sandbox, { filename: f });
  const fire = async (type: string, ev: Record<string, unknown>) => { for (const h of handlers[type] ?? []) await h(ev); };
  /** Tap a button the page drew: the page's click handler reads its data-* attributes. */
  const tap = (dataset: Record<string, string>) => fire("click", { target: { closest: () => ({ dataset, disabled: false }) } });
  /** Flip a switch the page drew. */
  const flip = (dataset: Record<string, string>, checked: boolean) => {
    const input = { dataset, checked, disabled: false, matches: (s: string) => s === "input.switch" };
    return fire("change", { target: input }).then(() => input);
  };
  return {
    view: () => el("#view").innerHTML, title: () => el("#title").textContent, toast: () => el("#toast").textContent, el, tap, flip, fire,
    live: (e: unknown) => sockets.forEach((s) => s.onmessage?.({ data: JSON.stringify(e) })),
  };
}

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const paired = await fetch(`${base}/pair/local`, { method: "POST", headers: localPairHeaders(ctx.dir), body: JSON.stringify({ deviceName: "QA phone" }) });
  const { token } = (await paired.json()) as { token: string };
  return { ...ctx, app, base, token, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

test("4.5: the phone app's Settings has a Night shift switch with one line of explanation, off until turned on", { timeout: 30_000 }, async (t) => {
  const { app, base, token, store } = await boot();
  t.after(() => app.close());
  const page = phoneApp(base, token);
  await until(() => page.view().includes("Night shift"), "the rooms list with its Settings rows");
  const row = /<label class="perm">(?:(?!<\/label>)[\s\S])*Night shift[\s\S]*?<\/label>/.exec(page.view())?.[0] ?? "";
  assert.ok(row, "a switch row");
  assert.match(row, /<input type="checkbox" role="switch" class="switch" aria-label="Night shift" data-setting="nightShift">/, "off by default, and not checked");
  const hint = /class="hint2">([^<]+)</.exec(row)?.[1] ?? "";
  assert.ok(hint.length > 20 && hint.length < 120 && !/[—–]/.test(hint), `a short plain line: ${hint}`);
  assert.equal(store.getSettings().nightShift, undefined, "nothing is saved just by looking at it");
});

test("4.5: turning the switch on and off is saved with PUT /settings, keeps the window and limits, and is audited", { timeout: 30_000 }, async (t) => {
  const { app, base, token, store, auth } = await boot();
  t.after(() => app.close());
  // the owner already chose a window and a limit on the Mac
  const set = await fetch(`${base}/settings`, { method: "PUT", headers: auth, body: JSON.stringify({ nightShift: { from: "22:00", to: "05:30", maxRunsPerNight: 7 } }) });
  assert.equal(set.status, 200);
  const page = phoneApp(base, token);
  await until(() => page.view().includes("Night shift"), "the Night shift row");

  const on = await page.flip({ setting: "nightShift" }, true);
  assert.deepEqual(store.getSettings().nightShift, { from: "22:00", to: "05:30", maxRunsPerNight: 7, enabled: true });
  assert.equal(on.disabled, true, "the switch waits for the hub");
  assert.match(page.view(), /aria-label="Night shift" data-setting="nightShift" checked>/, "the row now shows it on");
  const got = (await (await fetch(`${base}/settings`, { headers: auth })).json()) as { nightShift: { enabled: boolean; from: string } };
  assert.equal(got.nightShift.enabled, true);
  assert.equal(got.nightShift.from, "22:00");

  await page.flip({ setting: "nightShift" }, false);
  assert.equal(store.getSettings().nightShift?.enabled, false);
  assert.equal(store.getSettings().nightShift?.maxRunsPerNight, 7, "the limit stays");
  assert.doesNotMatch(page.view(), /data-setting="nightShift" checked>/);
  assert.equal(store.listAudit().filter((a) => a.action === "settings.updated").length >= 3, true, "each save is in the audit log");
  assert.equal(page.toast(), "", "no error shown");
});

test("4.5: a save the hub can't take puts the switch back and says so", { timeout: 30_000 }, async (t) => {
  const { app, base, token, store } = await boot();
  t.after(() => app.close().catch(() => undefined)); // (closed again below, before the tap)
  const page = phoneApp(base, token);
  await until(() => page.view().includes("Night shift"), "the Night shift row");
  await app.close(); // the hub goes away before the tap
  const input = await page.flip({ setting: "nightShift" }, true);
  assert.equal(input.checked, false, "back to off");
  assert.equal(input.disabled, false, "free to try again");
  assert.notEqual(page.toast(), "", "the reason is shown");
  assert.equal(store.getSettings().nightShift, undefined, "nothing was saved");
});

test("QA: the Tasks screen opens from a room, fills in live, and the room keeps its own task list for the goal card", { timeout: 30_000 }, async (t) => {
  const { app, base, token, store, room } = await boot();
  t.after(() => app.close());
  const now = Date.now();
  store.saveGoal({ id: "g_qa", roomId: room.id, text: "Check the numbers", status: "running", approvedAt: now, createdAt: now } as never);
  const task = (o: Partial<Task> & { id: string; title: string; status: Task["status"] }): Task => ({ roomId: room.id, goalId: "g_qa", description: "", taskType: "writing", acceptance: "", dependsOn: [], attempts: 1, createdAt: now, updatedAt: now, assignee: "claude", ...o }) as Task;
  store.saveTask(task({ id: "t_one", title: "Draft the narrative", status: "running" }));
  const bad: unknown[] = [];
  const onBad = (e: unknown) => bad.push(e);
  process.on("unhandledRejection", onBad);
  t.after(() => { process.off("unhandledRejection", onBad); });

  const page = phoneApp(base, token);
  await until(() => page.view().includes("general"), "the rooms list");
  await page.tap({ room: room.id });
  await until(() => page.el("#goal").hidden === false, "the room, with its goal card"); // the goal card is drawn once the room has loaded
  await page.el("#tasksBtn").onclick?.();
  await until(() => page.view().includes("Draft the narrative"), "the Tasks screen");
  assert.equal(page.title(), "Tasks");
  assert.match(page.view(), /Working · Claude/);

  // a task finishing, and a helper starting, reach the open screen
  page.live({ type: "task", task: task({ id: "t_one", title: "Draft the narrative", status: "done" }) });
  page.live({ type: "subagent", task: task({ id: "t_help", title: "Scan last quarter", status: "running", parentTaskId: "t_one", kind: "subagent", depth: 1, readOnly: true } as never) });
  await until(() => page.view().includes("Scan last quarter"), "the helper under its parent");
  assert.match(page.view(), /Done · Claude/);
  assert.match(page.view(), /read-only/);
  assert.deepEqual(bad, [], "nothing threw while the screen was open");
});

test("QA: the folder picker draws nothing but its own buttons (no stray text where an empty slot was)", () => {
  const src = appJs.slice(appJs.indexOf("  function renderFolderPick()"), appJs.indexOf("  // Colors go on through the DOM"));
  assert.doesNotMatch(src, /replaceChildren\([^;]*\bnull\b/, "replaceChildren turns a null into the text \"null\"");
});

test("4.5 (Mac app): Settings has the same switch, from the shared default", () => {
  const mac = readFileSync(join(here, "../../app/src/screens/SettingsScreen.tsx"), "utf8");
  assert.match(mac, /NIGHT_SHIFT_DEFAULTS/);
  assert.match(mac, /<Toggle label="Night shift" value=\{s\.nightShift\?\.enabled \?\? NIGHT_SHIFT_DEFAULTS\.enabled\}/);
  assert.match(mac, /save\(\{ nightShift: \{ \.\.\.s\.nightShift, enabled: v \} \}\)/, "the window and limits are kept");
});
