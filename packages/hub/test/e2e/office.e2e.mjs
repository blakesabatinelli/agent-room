/**
 * 3.4 / 3.4b The office, in a real browser. Boots demo hubs (test/e2e/office-demo.ts), loads web/office.html in headless Chromium and checks
 * what only a browser can show: desks, name tags and status chips, the header counts, the inspector, the one-shot effects, clicking through to
 * an agent's thread, the render loop stopping when hidden, the 2D plan on 8 GB, no console errors and no CSP violations.
 *
 *   node packages/hub/test/e2e/office.e2e.mjs            (from the repo root, after pnpm install)
 *
 * Playwright is not a dependency of the repo: it is found in PLAYWRIGHT_DIR (default /opt/node-tools) and Chromium at CHROMIUM
 * (default /opt/pw-browsers/chromium-1243/chrome-linux64/chrome). WebGL runs through SwiftShader; if the browser has none, the 3D checks are
 * skipped and say so, and the 2D checks still run. Screenshots go to docs/screenshots/office-*.png (set SHOTS=0 to skip them).
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
let passed = 0; const skipped = [], notes = [];
const ok = (name) => { passed++; console.log(`PASS  ${name}`); };

function startDemo(tier) {
  const child = spawn("pnpm", ["exec", "tsx", "test/e2e/office-demo.ts"], { cwd: hubDir, env: { ...process.env, OFFICE_TIER: tier }, stdio: ["pipe", "pipe", "inherit"] });
  const info = new Promise((res, rej) => { child.stdout.once("data", (d) => res(JSON.parse(String(d).split("\n")[0]))); child.on("exit", () => rej(new Error("demo hub exited"))); });
  return info.then((i) => ({ ...i, send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`), stop: () => child.stdin.end() }));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const [big, small, still] = await Promise.all([startDemo("large"), startDemo("small"), startDemo("large")]);

async function open(hub, { query = "", width = 1100, height = 760, token = hub.token, init, colorScheme } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => { if ((m.type() === "error" || /Content Security Policy/i.test(m.text())) && !/status of 4\d\d/.test(m.text())) problems.push(m.text()); }); // a failed request is reported once, with its address, below
  page.on("response", (r) => { if (r.status() >= 400 && !/\/rooms\/dm\/|\/control\/status/.test(r.url())) problems.push(`${r.status()} ${r.url()}`); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  if (token) await page.addInitScript((t) => localStorage.setItem("agentroom.token", t), token);
  if (init) await page.addInitScript(init);
  await page.goto(`http://127.0.0.1:${hub.port}/web/office.html?roomId=${hub.roomId}${query ? `&${query}` : ""}`);
  await page.waitForFunction(() => window.__office?.ready, null, { timeout: 30000 });
  return { page, ctx, problems, url: `http://127.0.0.1:${hub.port}` };
}
const office = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__office, pick: undefined, scene: undefined })));
const frames = (page) => page.evaluate(() => window.__office.frames);
const csp = (page) => page.evaluate(() => window.__csp);
const desk = async (page, id) => (await office(page)).desks.find((d) => d.agentId === id);
/** A spot at (x, y) or just around it where a click lands on the 3D canvas and the ray picks `id` (a label may sit on top of part of a desk). */
const spot = (target, x, y, id) => target.evaluate(([x0, y0, want]) => {
  const grid = []; for (let r = 0; r <= 50; r += 5) for (let dx = -r; dx <= r; dx += 5) for (const dy of [-r, r]) grid.push([dx, dy], [dy, dx]); // nearest first
  for (const [dx, dy] of grid) {
    const px = x0 + dx, py = y0 + dy, el = document.elementFromPoint(px, py);
    if (el && el.id === "scene" && window.__office.pick(px, py) === want) return { x: px, y: py };
  }
  return null;
}, [x, y, id]);
const clickAgent = async (page, id) => { const f = await frames(page); await page.waitForFunction((n) => window.__office.frames > n + 1, f); const d = await desk(page, id), at = await spot(page, d.x, d.y, id); assert.ok(at, `the ray from ${id}'s desk hits ${id}`); await page.mouse.click(at.x, at.y); };
const inspector = (page) => page.evaluate(() => ({ open: !document.querySelector("#inspector").hidden, name: document.querySelector("#insName").textContent, role: document.querySelector("#insRole").textContent, body: document.querySelector("#insBody").innerText }));
const waitEffect = (page, pred) => page.waitForFunction((src) => window.__office.effects.some((e) => Object.entries(JSON.parse(src)).every(([k, v]) => e[k] === v)), JSON.stringify(pred), { timeout: 8000 });

// is there WebGL at all?
const probe = await open(big, { query: "view=2d" });
const hasWebGL = await probe.page.evaluate(() => { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); });
await probe.ctx.close();
console.log(`WebGL in this browser: ${hasWebGL}`);
if (process.env.SHOTS !== "0") mkdirSync(shots, { recursive: true });

try {
  // ---------------------------------------------------------------- 3D
  if (hasWebGL) {
    const { page, ctx, problems } = await open(big);
    await page.waitForTimeout(1500);
    const o = await office(page);

    assert.equal(o.mode, "3d"); assert.equal(o.tier, "large"); ok("AC7: a large machine opens in 3D");
    assert.equal(await page.locator("canvas#scene").isVisible(), true);
    assert.equal(await page.locator("#plan").isVisible(), false);
    assert.equal(o.theme, "dark", "the office is dark by default");

    // AC1 + labels: a name tag with the persona's role over each agent, and a status chip with the live state
    const tags = await page.$$eval(".lbl[data-agent]", (els) => els.map((e) => [e.dataset.agent, e.querySelector(".nm").textContent, e.querySelector(".role").textContent]));
    assert.deepEqual(tags.map((l) => l[0]).sort(), ["atlas", "claude", "codex", "hermes", "muse"]);
    assert.deepEqual(tags.find((l) => l[0] === "hermes"), ["hermes", "Hermes", "Fact checker"]);
    const chips = Object.fromEntries(await page.$$eval(".lbl.status[data-chip]", (els) => els.map((e) => [e.dataset.chip, [e.querySelector(".st").textContent, e.querySelector(".tk").textContent]])));
    assert.deepEqual(Object.fromEntries(o.state.agents.map((a) => [a.id, a.state])), { claude: "working", codex: "waiting_approval", hermes: "judged", muse: "idle", atlas: "offline" });
    assert.deepEqual(chips.claude, ["Working · 2 helpers", "Draft the board narrative"]);
    assert.deepEqual(chips.codex, ["Needs approval", "Save tables to the board folder"]);
    assert.deepEqual(chips.hermes, ["Being judged", "Check the revenue figures"]);
    assert.deepEqual(chips.muse, ["Idle", "Next: Design the cover and charts"]);
    assert.equal(chips.atlas[0], "Offline");
    assert.equal(o.desks.length, 5); assert.ok(o.desks.every((d) => d.x > 0 && d.y > 0 && d.x < 1100 && d.y < 760), "every desk is on screen");
    ok("AC1: five desks with name tags (name and role) and status chips; working, waiting for approval, being judged, idle and offline are all shown");

    // the header: the room and the real counts
    assert.equal(await page.locator("#roomName").textContent(), "#board-update");
    assert.equal((await page.locator("#counts").innerText()).replace(/\s+/g, " "), "5 agents 6 tasks 3 in progress 1 blocker") // the bars between them are CSS;
    assert.equal(await page.locator("#live").getAttribute("class"), "live on");
    assert.equal(await page.locator("#full").isVisible(), true, "the browser has the Fullscreen API, so the button shows");
    ok("HUD: '#board-update // Office', 5 agents | 6 tasks | 3 in progress | 1 blocker, Live, 3D/2D, Full screen");

    // AC2
    assert.equal(o.helpers.length, 2);
    assert.deepEqual(o.helpers.map((h) => [h.parent, h.readOnly, h.state]).sort(), [["claude", false, "working"], ["claude", true, "working"]]);
    assert.ok(o.helpers.every((h) => Math.hypot(h.x - o.desks.find((d) => d.agentId === "claude").x, h.y - o.desks.find((d) => d.agentId === "claude").y) < 160), "helpers stand at the parent's desk");
    ok("AC2: two helpers (one read-only) stand at the working agent's desk");

    // AC3, AC4, the task flow and the pedestal
    assert.equal(o.board.length, 6); assert.match(o.board[0], /Revenue and forecast slide/);
    assert.deepEqual(o.state.goal.tasks.map((t) => t.status), ["done", "done", "running", "review", "running", "pending"]);
    assert.match(await page.locator(".lbl.goal").innerText(), /Prepare the October board update\s+33% · 2 of 6 met/);
    ok("AC3: the mission board lists the goal's six requirements; the task flow has the six tasks in plan order; the pedestal names the goal");
    assert.equal(o.door.count, 1); assert.equal(o.door.lit, true);
    assert.match(await page.locator(".lbl.door").textContent(), /1 approval waiting/);
    ok("AC4: the door light is lit with a count of 1");

    assert.deepEqual(problems, [], "no console or page errors in 3D"); assert.deepEqual(await csp(page), [], "no CSP violations");
    ok("no console errors and no CSP violations in 3D");

    // the inspector: click a desk (raycast) or a tag; "Open thread" opens the DM room
    await clickAgent(page, "hermes");
    await page.waitForFunction(() => window.__office.selected === "hermes");
    const ins = await inspector(page);
    assert.equal(ins.open, true); assert.equal(ins.name, "Hermes"); assert.equal(ins.role, "Fact checker");
    assert.match(ins.body, /CURRENT TASK\s+Check the revenue figures/i);
    assert.match(ins.body, /75% of its checks pass\s+In review/);
    assert.match(ins.body, /Started \d\d:\d\d, 12 min ago/);
    assert.match(ins.body, /Waiting for the judge/);
    assert.match(ins.body, /RECENT OUTPUTS\s+•\s+Checking revenue against the ledger export\./i);
    assert.match(ins.body, /APPROVALS\s+None waiting/i);
    ok("inspector: clicking a desk shows the agent's role, current task with progress and start time, step, outputs and approvals");
    await page.click('.lbl[data-agent="codex"] .tag');
    await page.waitForFunction(() => window.__office.selected === "codex");
    const ci = await inspector(page);
    assert.match(ci.body, /BLOCKED BY\s+!\s+Approval: Save tables to the board folder/i);
    assert.match(ci.body, /APPROVALS\s+\?\s+Save tables to the board folder \(drive\)/i);
    assert.match(ci.body, /of its usual time/);
    ok("inspector: a name tag selects too; the agent waiting for approval shows the approval as a blocker and in its list");
    await page.keyboard.press("Escape"); await page.waitForFunction(() => document.querySelector("#inspector").hidden);
    await clickAgent(page, "hermes");
    await page.click("#insOpen");
    await page.waitForFunction(() => document.querySelector("#title")?.textContent === "Hermes", null, { timeout: 10000 });
    assert.equal(new URL(page.url()).hash, "", "the hash is consumed");
    ok("AC5: 'Open thread' in the inspector opens that agent's DM room in the web app");
    await page.goBack(); await page.waitForFunction(() => window.__office?.ready);
    await page.waitForSelector('.lbl.status[data-chip="codex"]');
    await page.click('.lbl.status[data-chip="codex"] .chip'); await page.click("#insOpen");
    await page.waitForFunction(() => document.querySelector("#title")?.textContent === "Codex", null, { timeout: 10000 });
    assert.equal(await page.locator("#officeBtn").isVisible(), true, "a room has the Office button");
    ok("AC5: a status chip selects the agent too, and the room shows an Office button");

    // Mac app web view: postMessage to the native side; and an embedding page: postMessage to the parent
    {
      const m = await open(big, { init: () => { window.ReactNativeWebView = { postMessage: (s) => { (window.__posted ||= []).push(s); } }; } });
      await m.page.waitForTimeout(800);
      await clickAgent(m.page, "claude"); await m.page.click("#insOpen");
      await m.page.waitForTimeout(300); const f0 = await frames(m.page); await m.page.waitForFunction((n) => window.__office.frames > n + 1, f0);
      const helper = (await office(m.page)).helpers.find((h) => h.readOnly), ha = await spot(m.page, helper.x, helper.y, "hermes"); await m.page.mouse.click(ha.x, ha.y);
      await m.page.waitForFunction(() => window.__office.selected === "hermes"); await m.page.click("#insOpen");
      const posted = await m.page.evaluate(() => window.__posted);
      assert.deepEqual(posted.map((s) => JSON.parse(s)), [{ type: "openAgent", agentId: "claude" }, { type: "openAgent", agentId: "hermes" }]);
      assert.equal(new URL(m.page.url()).pathname, "/web/office.html", "no navigation inside the Mac app's web view");
      await m.ctx.close();
      ok("AC5: in the Mac app's web view 'Open thread' posts { type: openAgent, agentId } (a helper selects the agent running it)");
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
      await frame.waitForFunction(() => window.__office.selected === "muse"); await frame.click("#insOpen");
      await host.waitForFunction(() => window.msgs.length > 0);
      assert.deepEqual(await host.evaluate(() => window.msgs), [{ type: "openAgent", agentId: "muse" }]);
      await ctx2.close();
      ok("AC5: embedded in another page, 'Open thread' posts { type: openAgent, agentId } to the parent window");
    }

    // one-shot effects, from live changes
    {
      const fx = await open(big);
      await fx.page.waitForTimeout(600);
      big.send({ op: "status", taskId: "t_next", status: "running" }); await waitEffect(fx.page, { kind: "assign", to: "muse" });
      big.send({ op: "status", taskId: "t_run", status: "review" }); await waitEffect(fx.page, { kind: "review", from: "claude" });
      big.send({ op: "status", taskId: "t_run", status: "revising" }); await waitEffect(fx.page, { kind: "sendback", at: "claude" });
      big.send({ op: "status", taskId: "t_rev", status: "done" }); await waitEffect(fx.page, { kind: "accept", at: "hermes" });
      big.send({ op: "approval", agentId: "claude" }); await waitEffect(fx.page, { kind: "approval", from: "claude" });
      await fx.page.waitForFunction(() => window.__office.door?.count === 2, null, { timeout: 8000 });
      const lo = await office(fx.page);
      assert.equal(lo.state.agents.find((a) => a.id === "claude").state, "waiting_approval");
      assert.equal(lo.state.agents.find((a) => a.id === "hermes").state, "idle");
      assert.match(await fx.page.locator(".lbl.door").textContent(), /2 approvals waiting/);
      assert.equal((await fx.page.locator("#counts").innerText()).replace(/\s+/g, " "), "5 agents 6 tasks 3 in progress 2 blockers") // the bars between them are CSS;
      assert.deepEqual(fx.problems, []); assert.deepEqual(await csp(fx.page), []);
      await fx.ctx.close();
      ok("effects: assigned, sent to review, sent back, accepted and a new approval each fire once, live; the door count goes to 2");
    }

    // AC6: only renders while visible; paced by what is happening
    {
      const { page: p, ctx: c } = await open(big);
      await p.waitForTimeout(1600); // past the start-up burst
      const a = await frames(p); await p.waitForTimeout(1500); const b = await frames(p);
      assert.ok(b - a >= 2, `agents at work keep it animating (saw ${b - a} frames in 1.5 s)`);
      notes.push(`SwiftShader frame rate at 1100x760 with agents working: ${((b - a) / 1.5).toFixed(1)} fps`);
      ok(`AC6: working agents animate (${b - a} frames in 1.5 s in SwiftShader)`);

      await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
      await p.waitForTimeout(400); const h1 = await frames(p); await p.waitForTimeout(1000); const h2 = await frames(p);
      assert.equal(h2, h1, "no frames while the page is hidden"); assert.equal((await office(p)).running, false);
      await p.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); });
      await p.waitForTimeout(1000); assert.ok((await frames(p)) > h2, "frames resume when the page is visible again");
      ok("AC6: the render loop stops when the page is hidden and resumes when it is shown");

      await p.evaluate(() => { document.querySelector("#stage").style.transform = "translateY(-4000px)"; });
      await p.waitForTimeout(700); const s1 = await frames(p); await p.waitForTimeout(800);
      assert.equal(await frames(p), s1, "no frames while the view is off screen"); assert.equal((await office(p)).running, false);
      await p.evaluate(() => { document.querySelector("#stage").style.transform = ""; });
      await p.waitForTimeout(1000); assert.ok((await frames(p)) > s1);
      ok("AC6: the render loop stops when the office is scrolled off screen (IntersectionObserver)");

      await p.click("#power"); await p.waitForTimeout(1200);
      const l1 = await frames(p); await p.waitForTimeout(1000);
      assert.equal(await frames(p), l1, "low power: no idle animation");
      assert.equal(await p.getAttribute("#power", "aria-pressed"), "true");
      big.send({ op: "status", taskId: "t_next", status: "done" }); // a change still draws a frame
      await p.waitForFunction((n) => window.__office.frames > n, l1, { timeout: 8000 });
      await p.waitForTimeout(1200); const l2 = await frames(p); await p.waitForTimeout(800);
      assert.equal(await frames(p), l2, "and then it goes quiet again");
      await p.click("#power"); await p.waitForTimeout(1500);
      assert.ok((await frames(p)) > l2 + 1, "animation returns when low power is off");
      ok("AC6: low-power mode stops idle animation, still draws on a change, and animation returns when switched off");
      await c.close();
    }
    await ctx.close();

    // 3D / 2D switch in the view; the choice is remembered
    {
      const s = await open(big, { query: "view=3d" });
      await s.page.click("#mode2d");
      await s.page.waitForFunction(() => window.__office.mode === "2d");
      assert.equal(await s.page.locator(".seat").count(), 5);
      await s.page.waitForTimeout(400); const f = await frames(s.page); await s.page.waitForTimeout(700);
      assert.equal(await frames(s.page), f, "the 3D loop is off while the plan is shown");
      await s.page.click("#mode3d"); await s.page.waitForFunction(() => window.__office.mode === "3d");
      await s.page.waitForTimeout(1200); assert.ok((await frames(s.page)) > f);
      await s.page.click("#mode2d");
      const again = await s.page.context().newPage(); await again.goto(`http://127.0.0.1:${big.port}/web/office.html?roomId=${big.roomId}`);
      await again.waitForFunction(() => window.__office?.ready); assert.equal((await office(again)).mode, "2d");
      await s.ctx.close();
      ok("AC7: the owner can switch between 3D and 2D in the view, and the choice is remembered");
    }

    // screenshots, from a hub nobody has changed
    if (process.env.SHOTS !== "0") {
      const v = await open(still, { width: 1440, height: 900 }); await v.page.waitForTimeout(3000);
      await v.page.screenshot({ path: join(shots, "office-3d.png") });
      await clickAgent(v.page, "claude"); await v.page.waitForTimeout(2000);
      await v.page.screenshot({ path: join(shots, "office-3d-inspector.png") });
      assert.deepEqual(v.problems, []); assert.deepEqual(await csp(v.page), []);
      await v.ctx.close();
      // a short sequence about a second apart: a task is accepted and the next one assigned in between
      const q = await open(still, { width: 1440, height: 900 }); await q.page.waitForTimeout(3000);
      const f0 = await frames(q.page); const s1 = await q.page.screenshot({ path: join(shots, "office-seq-1.png") });
      still.send({ op: "status", taskId: "t_rev", status: "done" }); still.send({ op: "status", taskId: "t_next", status: "running" });
      await q.page.waitForTimeout(1000); const s2 = await q.page.screenshot({ path: join(shots, "office-seq-2.png") });
      await q.page.waitForTimeout(1000); const s3 = await q.page.screenshot({ path: join(shots, "office-seq-3.png") });
      assert.ok((await frames(q.page)) > f0 + 2, "frames were drawn between the shots");
      assert.ok(!s1.equals(s2) && !s2.equals(s3), "the picture changes from frame to frame");
      await q.ctx.close();
      const l = await open(small, { query: "view=3d&theme=light", width: 1440, height: 900 }); await l.page.waitForTimeout(3000);
      assert.equal((await office(l.page)).theme, "light");
      await l.page.screenshot({ path: join(shots, "office-3d-light.png") }); await l.ctx.close();
      ok("screenshots: office-3d, office-3d-inspector, office-seq-1..3 (they differ), office-3d-light");
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
    assert.ok(!reqs2.some((u) => u.includes("three.module") || u.includes("office-scene")), "three.js and the scene module are not even downloaded on the small tier"); await page2.close();
    ok("AC7: the 700 KB three.js file and the scene module are not downloaded on the small tier");

    // the same information
    const seats = await page.$$eval(".seat", (els) => els.map((e) => [e.dataset.agent, e.dataset.state, e.querySelector("text.disp").textContent, e.querySelectorAll(".helper").length]));
    assert.deepEqual(seats, [["claude", "working", "Claude", 2], ["codex", "waiting_approval", "Codex", 0], ["hermes", "judged", "Hermes", 0], ["muse", "idle", "Muse", 0], ["atlas", "offline", "Atlas", 0]]);
    assert.equal(await page.locator(".helper.ro").count(), 1);
    assert.equal(o.board.length, 6); assert.deepEqual([o.door.count, o.door.lit], [1, true]);
    assert.match(await page.locator("[data-door] text.amber").textContent(), /1 waiting/);
    assert.equal(await page.locator(".flow .node").count(), 6);
    assert.equal(await page.locator(".flow .edge.live").count(), 3, "the connectors into the three tasks in progress move");
    assert.equal((await page.locator("#counts").innerText()).replace(/\s+/g, " "), "5 agents 6 tasks 3 in progress 1 blocker") // the bars between them are CSS;
    ok("AC1-AC4 in 2D: states, helpers (one read-only), the mission board, the task flow, the door light and the header carry the same information");

    // interaction: click and keyboard select; the inspector opens the thread
    const claude = await desk(page, "claude");
    await page.mouse.click(claude.x, claude.y);
    await page.waitForFunction(() => window.__office.selected === "claude");
    assert.match((await inspector(page)).body, /CURRENT TASK\s+Draft the board narrative/i);
    await page.click("#insOpen");
    await page.waitForURL(/\/#room=/); await page.waitForFunction(() => document.querySelector("#title")?.textContent === "Claude");
    await page.goBack(); await page.waitForFunction(() => window.__office?.ready);
    await page.focus('.seat[data-agent="codex"]'); await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__office.selected === "codex");
    await page.click("#insOpen");
    await page.waitForFunction(() => document.querySelector("#title")?.textContent === "Codex");
    ok("AC5 in 2D: clicking a desk, or pressing Enter on a focused one, opens the inspector; 'Open thread' opens that agent's DM room");

    // switching up to 3D is the owner's call
    if (hasWebGL) {
      const s = await open(small);
      await s.page.click("#mode3d"); await s.page.waitForFunction(() => window.__office.mode === "3d"); await s.page.waitForTimeout(1200);
      assert.ok((await frames(s.page)) > 0);
      await s.ctx.close(); ok("AC7: on a small machine the owner can still choose 3D");
    }
    assert.deepEqual(problems, []); assert.deepEqual(await csp(page), []);
    if (process.env.SHOTS !== "0") {
      const f = await open(small, { width: 1440, height: 900 }); await f.page.waitForTimeout(800);
      await f.page.screenshot({ path: join(shots, "office-2d.png") }); await f.ctx.close();
      const ph = await open(small, { width: 390, height: 844 }); await ph.page.waitForTimeout(800);
      assert.equal((await office(ph.page)).mode, "2d", "a phone held upright gets the plan");
      await ph.page.screenshot({ path: join(shots, "office-phone.png") });
      await ph.page.click('.seat[data-agent="codex"]'); await ph.page.waitForTimeout(400);
      await ph.page.screenshot({ path: join(shots, "office-phone-inspector.png") });
      assert.deepEqual(ph.problems, []);
      await ph.ctx.close();
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
  await browser.close(); big.stop(); small.stop(); still.stop();
}
console.log(`\n${passed} checks passed${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}`);
for (const n of notes) console.log(`NOTE  ${n}`);
