/**
 * 3.4 The office, in a real browser. Boots demo hubs (test/e2e/office-demo.ts), loads web/office.html in headless Chromium and checks the
 * acceptance criteria that only a browser can show: desks and labels, clicking an agent, the render loop stopping when hidden, the 2D plan on 8 GB.
 *
 *   node packages/hub/test/e2e/office.e2e.mjs            (from the repo root, after pnpm install)
 *
 * Playwright is not a dependency of the repo: it is found in PLAYWRIGHT_DIR (default /opt/node-tools) and Chromium at CHROMIUM
 * (default /opt/pw-browsers/chromium-1243/chrome-linux64/chrome). WebGL runs through SwiftShader; if the browser has none, the 3D checks are
 * skipped and say so, and the 2D checks still run. Screenshots go to docs/screenshots/3.4-*.png (set SHOTS=0 to skip them).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hubDir = join(here, "../..");
const shots = join(hubDir, "../../docs/screenshots");
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR ?? "/opt/node-tools", "x.js"))("playwright");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; const skipped = [];
const ok = (name) => { passed++; console.log(`PASS  ${name}`); };

function startDemo(tier) {
  const child = spawn("pnpm", ["exec", "tsx", "test/e2e/office-demo.ts"], { cwd: hubDir, env: { ...process.env, OFFICE_TIER: tier }, stdio: ["pipe", "pipe", "inherit"] });
  const info = new Promise((res, rej) => { child.stdout.once("data", (d) => res(JSON.parse(String(d).split("\n")[0]))); child.on("exit", () => rej(new Error("demo hub exited"))); });
  return info.then((i) => ({ ...i, send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`), stop: () => child.stdin.end() }));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const [big, small] = await Promise.all([startDemo("large"), startDemo("small")]);

async function open(hub, { query = "", width = 1100, height = 760, token = hub.token, init, colorScheme } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) problems.push(m.text()); }); // a failed request is reported once, with its address, below
  page.on("response", (r) => { if (r.status() >= 400 && !/\/rooms\/dm\/|\/control\/status/.test(r.url())) problems.push(`${r.status()} ${r.url()}`); });
  if (token) await page.addInitScript((t) => localStorage.setItem("agentroom.token", t), token);
  if (init) await page.addInitScript(init);
  await page.goto(`http://127.0.0.1:${hub.port}/web/office.html?roomId=${hub.roomId}${query ? `&${query}` : ""}`);
  await page.waitForFunction(() => window.__office?.ready, null, { timeout: 20000 });
  return { page, ctx, problems, url: `http://127.0.0.1:${hub.port}` };
}
const office = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__office, pick: undefined })));
const frames = (page) => page.evaluate(() => window.__office.frames);
const desk = async (page, id) => (await office(page)).desks.find((d) => d.agentId === id);
/** A spot at (x, y) or just around it where a click lands on the 3D canvas and the ray picks `id` (a label may sit on top of part of a desk). */
const spot = (target, x, y, id) => target.evaluate(([x0, y0, want]) => {
  for (const [dx, dy] of [[0, 0], [0, -25], [0, 25], [-30, 0], [30, 0], [-30, -25], [30, -25], [0, -50], [0, 50]]) {
    const px = x0 + dx, py = y0 + dy, el = document.elementFromPoint(px, py);
    if (el && el.id === "scene" && window.__office.pick(px, py) === want) return { x: px, y: py };
  }
  return null;
}, [x, y, id]);

// is there WebGL at all?
const probe = await open(big, { query: "view=2d" });
const hasWebGL = await probe.page.evaluate(() => { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); });
await probe.ctx.close();
console.log(`WebGL in this browser: ${hasWebGL}`);

try {
  // ---------------------------------------------------------------- 3D
  if (hasWebGL) {
    const { page, ctx, problems } = await open(big);
    await page.waitForTimeout(1500);
    const o = await office(page);

    assert.equal(o.mode, "3d"); assert.equal(o.tier, "large"); ok("AC7: a large machine opens in 3D");
    assert.equal(await page.locator("canvas#scene").isVisible(), true);
    assert.equal(await page.locator("#plan").isVisible(), false);

    // AC1 + labels
    const labels = await page.$$eval(".lbl[data-agent]", (els) => els.map((e) => [e.dataset.agent, e.querySelector(".nm").textContent, e.querySelector(".st").textContent]));
    assert.deepEqual(labels.map((l) => l[0]).sort(), ["atlas", "claude", "codex", "hermes", "muse"]);
    assert.deepEqual(Object.fromEntries(o.state.agents.map((a) => [a.id, a.state])), { claude: "working", codex: "waiting_approval", hermes: "judged", muse: "idle", atlas: "offline" });
    assert.match(labels.find((l) => l[0] === "claude")[2], /Working · 2 helpers/);
    assert.equal(labels.find((l) => l[0] === "codex")[2], "Needs approval");
    assert.equal(labels.find((l) => l[0] === "hermes")[2], "Being judged");
    assert.equal(o.desks.length, 5); assert.ok(o.desks.every((d) => d.x > 0 && d.y > 0 && d.x < 1100 && d.y < 760), "every desk is on screen");
    ok("AC1: five desks with name labels; working, waiting for approval, being judged, idle and offline are all shown");

    // AC2
    assert.equal(o.helpers.length, 2);
    assert.deepEqual(o.helpers.map((h) => [h.parent, h.readOnly, h.state]).sort(), [["claude", false, "working"], ["claude", true, "working"]]);
    assert.ok(o.helpers.every((h) => Math.hypot(h.x - o.desks.find((d) => d.agentId === "claude").x, h.y - o.desks.find((d) => d.agentId === "claude").y) < 160), "helpers stand at the parent's desk");
    ok("AC2: two helpers (one read-only) stand at the working agent's desk");

    // AC3, AC4
    assert.equal(o.board.length, 6); assert.match(o.board[0], /Revenue and forecast slide/);
    ok("AC3: the whiteboard lists the goal's six requirements");
    assert.equal(o.door.count, 1); assert.equal(o.door.lit, true);
    assert.match(await page.locator(".lbl.door").textContent(), /1 approval waiting/);
    ok("AC4: the door light is lit with a count of 1");

    // AC5: raycast click on a desk's figure area, and on a label; the web app opens the DM room
    assert.deepEqual(problems, [], "no console or page errors in 3D"); ok("no console errors in 3D");
    const hermes = await desk(page, "hermes");
    const at = await spot(page, hermes.x, hermes.y, "hermes");
    assert.ok(at, "the ray from hermes' desk hits hermes");
    await page.mouse.click(at.x, at.y);
    await page.waitForFunction(() => document.querySelector("#title")?.textContent === "Hermes", null, { timeout: 10000 });
    assert.equal(new URL(page.url()).hash, "", "the hash is consumed");
    ok("AC5: clicking a desk opens that agent's DM room in the web app");
    await page.goBack(); await page.waitForFunction(() => window.__office?.ready);
    await page.waitForSelector('.lbl[data-agent="codex"]');
    await page.click('.lbl[data-agent="codex"]');
    await page.waitForFunction(() => document.querySelector("#title")?.textContent === "Codex", null, { timeout: 10000 });
    assert.equal(await page.locator("#officeBtn").isVisible(), true, "a room has the Office button");
    ok("AC5: clicking a name label does the same, and the room shows an Office button");

    // Mac app web view: postMessage to the native side; and an embedding page: postMessage to the parent
    {
      const m = await open(big, { init: () => { window.ReactNativeWebView = { postMessage: (s) => { (window.__posted ||= []).push(s); } }; } });
      await m.page.waitForTimeout(800);
      const claude = await desk(m.page, "claude"), ca = await spot(m.page, claude.x, claude.y, "claude"); await m.page.mouse.click(ca.x, ca.y);
      const helper = (await office(m.page)).helpers.find((h) => h.readOnly), ha = await spot(m.page, helper.x, helper.y, "hermes"); await m.page.mouse.click(ha.x, ha.y);
      const posted = await m.page.evaluate(() => window.__posted);
      assert.deepEqual(posted.map((s) => JSON.parse(s)), [{ type: "openAgent", agentId: "claude" }, { type: "openAgent", agentId: "hermes" }]);
      assert.equal(new URL(m.page.url()).pathname, "/web/office.html", "no navigation inside the Mac app's web view");
      await m.ctx.close();
      ok("AC5: in the Mac app's web view a click posts { type: openAgent, agentId } (a helper opens the agent running it)");
    }
    {
      const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 760 } });
      const host = await ctx2.newPage();
      await host.addInitScript((t) => localStorage.setItem("agentroom.token", t), big.token);
      await host.route("**/host.html", (r) => r.fulfill({ contentType: "text/html", body: `<body style="margin:0"><iframe id="f" style="border:0;width:1100px;height:760px" src="/web/office.html?roomId=${big.roomId}"></iframe><script>window.msgs=[];addEventListener("message",e=>msgs.push(e.data))</script>` }));
      await host.route("**/web/office.html*", async (r) => { const res = await r.fetch(); const h = { ...res.headers() }; delete h["x-frame-options"]; h["content-security-policy"] = h["content-security-policy"].replace("frame-ancestors 'none'", "frame-ancestors 'self'"); await r.fulfill({ response: res, headers: h }); });
      await host.goto(`http://127.0.0.1:${big.port}/host.html`);
      const frame = host.frame({ url: /office\.html/ });
      await frame.waitForFunction(() => window.__office?.ready, null, { timeout: 20000 });
      await host.waitForTimeout(800);
      const d = (await frame.evaluate(() => window.__office.desks)).find((x) => x.agentId === "muse"), da = await spot(frame, d.x, d.y, "muse");
      await host.mouse.click(da.x, da.y);
      await host.waitForFunction(() => window.msgs.length > 0);
      assert.deepEqual(await host.evaluate(() => window.msgs), [{ type: "openAgent", agentId: "muse" }]);
      await ctx2.close();
      ok("AC5: embedded in another page, a click posts { type: openAgent, agentId } to the parent window");
    }

    // AC6: only renders while visible
    {
      const { page: p, ctx: c } = await open(big);
      await p.waitForTimeout(1600); // past the start-up burst
      const a = await frames(p); await p.waitForTimeout(1000); const b = await frames(p);
      assert.ok(b - a >= 3 && b - a <= 14, `idle animation runs about 10 fps (saw ${b - a} frames in a second)`);
      ok(`AC6: working agents animate at the throttled idle rate (${b - a} frames in 1 s)`);

      await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
      await p.waitForTimeout(150); const h1 = await frames(p); await p.waitForTimeout(1000); const h2 = await frames(p);
      assert.equal(h2, h1, "no frames while the page is hidden"); assert.equal((await office(p)).running, false);
      await p.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); });
      await p.waitForTimeout(800); assert.ok((await frames(p)) > h2, "frames resume when the page is visible again");
      ok("AC6: the render loop stops when the page is hidden and resumes when it is shown");

      await p.evaluate(() => { document.querySelector("#stage").style.transform = "translateY(-4000px)"; });
      await p.waitForTimeout(500); const s1 = await frames(p); await p.waitForTimeout(800);
      assert.equal(await frames(p), s1, "no frames while the view is off screen"); assert.equal((await office(p)).running, false);
      await p.evaluate(() => { document.querySelector("#stage").style.transform = ""; });
      await p.waitForTimeout(800); assert.ok((await frames(p)) > s1);
      ok("AC6: the render loop stops when the office is scrolled off screen (IntersectionObserver)");

      await p.click("#power"); await p.waitForTimeout(700);
      const l1 = await frames(p); await p.waitForTimeout(1000);
      assert.equal(await frames(p), l1, "low power: no idle animation");
      assert.equal(await p.getAttribute("#power", "aria-pressed"), "true");
      big.send({ op: "status", taskId: "t_rev", status: "done" }); // a change still draws a frame
      await p.waitForFunction((n) => window.__office.frames > n, l1, { timeout: 5000 });
      await p.waitForTimeout(800); const l2 = await frames(p); await p.waitForTimeout(800);
      assert.equal(await frames(p), l2, "and then it goes quiet again");
      assert.equal((await office(p)).state.agents.find((a) => a.id === "hermes").state, "idle");
      await p.click("#power"); await p.waitForTimeout(1200);
      assert.ok((await frames(p)) > l2 + 2, "animation returns when low power is off");
      ok("AC6: low-power mode stops idle animation, still draws on a change, and animation returns when switched off");
      await c.close();
    }

    // live update over the websocket: a new approval lights the door and flips an agent
    {
      const live = await open(big);
      big.send({ op: "approval", agentId: "claude" });
      await live.page.waitForFunction(() => window.__office.door?.count === 2, null, { timeout: 8000 });
      const lo = await office(live.page);
      assert.equal(lo.state.agents.find((a) => a.id === "claude").state, "waiting_approval");
      assert.match(await live.page.locator(".lbl.door").textContent(), /2 approvals waiting/);
      await live.ctx.close();
      ok("AC1/AC4: a new approval arrives live: the door count goes to 2 and the agent waits for approval");
    }
    if (process.env.SHOTS !== "0") mkdirSync(shots, { recursive: true });
    await ctx.close();

    // screenshots (fresh state: the demo hub has changed, so use the live one as is)
    if (process.env.SHOTS !== "0") {
      const l = await open(small, { query: "view=3d" }); await l.page.waitForTimeout(1800);
      await l.page.screenshot({ path: join(shots, "3.4-office-3d.png") }); await l.ctx.close();
      const d = await open(small, { query: "view=3d", colorScheme: "dark" }); await d.page.waitForTimeout(1800);
      assert.equal((await office(d.page)).theme, "dark");
      await d.page.screenshot({ path: join(shots, "3.4-office-3d-dark.png") }); await d.ctx.close();
      ok("dark mode follows prefers-color-scheme (and screenshots saved)");
    }

    // 3D / 2D switch in the view; the choice is remembered
    {
      const s = await open(big, { query: "view=3d" });
      await s.page.click("#mode2d");
      await s.page.waitForFunction(() => window.__office.mode === "2d");
      assert.equal(await s.page.locator(".seat").count(), 5);
      await s.page.waitForTimeout(300); const f = await frames(s.page); await s.page.waitForTimeout(700);
      assert.equal(await frames(s.page), f, "the 3D loop is off while the plan is shown");
      await s.page.click("#mode3d"); await s.page.waitForFunction(() => window.__office.mode === "3d");
      await s.page.waitForTimeout(800); assert.ok((await frames(s.page)) > f);
      await s.page.click("#mode2d");
      const again = await s.page.context().newPage(); await again.goto(`http://127.0.0.1:${big.port}/web/office.html?roomId=${big.roomId}`);
      await again.waitForFunction(() => window.__office?.ready); assert.equal((await office(again)).mode, "2d");
      await s.ctx.close();
      ok("AC7: the owner can switch between 3D and 2D in the view, and the choice is remembered");
    }
  } else skipped.push("3D checks (no WebGL in this browser)");

  // ---------------------------------------------------------------- 2D on an 8 GB machine
  {
    const { page, ctx, problems } = await open(small);
    await page.waitForTimeout(800);
    const o = await office(page);
    assert.equal(o.tier, "small"); assert.equal(o.mode, "2d"); assert.match(o.why, /8 GB/);
    assert.equal(o.frames, 0, "no 3D frames were ever drawn");
    assert.equal(await page.locator("canvas#scene").isVisible(), false);
    assert.equal(await page.locator(".seat").count(), 5);
    assert.match(await page.locator("#note").textContent(), /8 GB of memory/);
    ok("AC7: an 8 GB machine (tier small) opens the 2D plan, without drawing a 3D frame");
    const page2 = await ctx.newPage(); const reqs2 = []; page2.on("request", (r) => reqs2.push(r.url()));
    await page2.goto(`http://127.0.0.1:${small.port}/web/office.html?roomId=${small.roomId}`); await page2.waitForFunction(() => window.__office?.ready);
    assert.ok(!reqs2.some((u) => u.includes("three.module")), "three.js is not even downloaded on the small tier"); await page2.close();
    ok("AC7: the 700 KB three.js file is not downloaded on the small tier");

    // the same information
    const seats = await page.$$eval(".seat", (els) => els.map((e) => [e.dataset.agent, e.dataset.state, e.querySelector("text.disp").textContent, e.querySelectorAll(".helper").length]));
    assert.deepEqual(seats, [["claude", "working", "Claude", 2], ["codex", "waiting_approval", "Codex", 0], ["hermes", "judged", "Hermes", 0], ["muse", "idle", "Muse", 0], ["atlas", "offline", "Atlas", 0]]);
    assert.equal(await page.locator(".helper.ro").count(), 1);
    assert.equal(o.board.length, 6); assert.deepEqual([o.door.count, o.door.lit], [1, true]);
    assert.match(await page.locator("[data-door] text.amber").textContent(), /1 waiting/);
    ok("AC1-AC4 in 2D: states, helpers (one read-only), whiteboard and the door light carry the same information");

    // interaction: click and keyboard
    const claude = await desk(page, "claude");
    await page.mouse.click(claude.x, claude.y);
    await page.waitForURL(/\/#room=/); await page.waitForFunction(() => document.querySelector("#title")?.textContent === "Claude");
    await page.goBack(); await page.waitForFunction(() => window.__office?.ready);
    await page.focus('.seat[data-agent="codex"]'); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#title")?.textContent === "Codex");
    ok("AC5 in 2D: clicking a desk, or pressing Enter on a focused one, opens that agent's DM room");

    // switching up to 3D is the owner's call
    if (hasWebGL) {
      const s = await open(small);
      await s.page.click("#mode3d"); await s.page.waitForFunction(() => window.__office.mode === "3d"); await s.page.waitForTimeout(900);
      assert.ok((await frames(s.page)) > 0);
      await s.ctx.close(); ok("AC7: on a small machine the owner can still choose 3D");
    }
    assert.deepEqual(problems, []);
    if (process.env.SHOTS !== "0") {
      const f = await open(small); await f.page.waitForTimeout(600); await f.page.screenshot({ path: join(shots, "3.4-office-2d.png") }); await f.ctx.close();
      const ph = await open(small, { width: 390, height: 780 }); await ph.page.waitForTimeout(600);
      assert.equal((await office(ph.page)).mode, "2d", "a phone held upright gets the plan");
      await ph.page.screenshot({ path: join(shots, "3.4-office-2d-phone.png") }); await ph.ctx.close();
    }
    await ctx.close();
  }

  // ---------------------------------------------------------------- no WebGL, no token
  {
    const { page, ctx } = await open(big, { query: "view=3d", init: () => { delete window.WebGLRenderingContext; } });
    const o = await office(page);
    assert.equal(o.mode, "2d"); assert.match(await page.locator("#note").textContent(), /3D isn't available on this device/);
    assert.equal(await page.locator(".seat").count(), 5);
    await ctx.close(); ok("AC7: with no WebGL the page falls back to the 2D plan and says why");
  }
  {
    const { page, ctx } = await open(big, { token: "" });
    const o = await office(page);
    assert.equal(o.error, "unpaired"); assert.match(await page.locator("#note").textContent(), /isn't paired/);
    await ctx.close(); ok("an unpaired device is told to pair");
  }
} finally {
  await browser.close(); big.stop(); small.stop();
}
console.log(`\n${passed} checks passed${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}`);
