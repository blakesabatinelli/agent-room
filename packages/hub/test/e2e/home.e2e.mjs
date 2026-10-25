/**
 * Simple by default, in a real browser. Boots a demo hub (test/e2e/home-demo.ts), loads web/index.html in headless Chromium and checks what
 * only a browser can show: the calm home, the live strip (running, approvals, usage chips), the Advanced menu, the usage detail, and the
 * delete-room affordance. No console errors, no CSP violations, no horizontal scroll at 390px. Screenshots go to docs/screenshots/.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node packages/hub/test/e2e/home.e2e.mjs      (from the repo root, after pnpm install)
 *
 * Playwright is found in PLAYWRIGHT_DIR (default /opt/node-tools); Chromium at CHROMIUM (default /opt/pw-browsers/chromium-1243/...). SHOTS=0 skips images.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hubDir = join(here, "../..");
const shots = join(hubDir, "../../docs/screenshots");
const LOG = process.env.E2E_LOG || "/tmp/claude-0/scratch/pw-progress.log";
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } };
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR ?? "/opt/node-tools", "x.js"))("playwright");
let passed = 0;
const ok = (name) => { passed++; console.log(`PASS  ${name}`); log(`PASS ${name}`); };
if (process.env.SHOTS !== "0") mkdirSync(shots, { recursive: true });

function startDemo() {
  const child = spawn("pnpm", ["exec", "tsx", "test/e2e/home-demo.ts"], { cwd: hubDir, env: { ...process.env }, stdio: ["pipe", "pipe", "inherit"] });
  const info = new Promise((res, rej) => { child.stdout.once("data", (d) => res(JSON.parse(String(d).split("\n")[0]))); child.on("exit", () => rej(new Error("demo hub exited"))); });
  return info.then((i) => ({ ...i, stop: () => child.kill() }));
}

log("booting demo hub");
const hub = await startDemo();
log(`demo hub up on ${hub.port}`);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-features=Translate,OptimizationHints,AutofillServerCommunication"] });

async function open({ width = 390, height = 844, colorScheme } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if ((m.type() === "error" || /Content Security Policy/i.test(m.text())) && !/status of 4\d\d/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !/\/rooms\/dm\/|\/control\/status/.test(r.url())) problems.push(`${r.status()} ${r.url()}`); }); // the demo has no control folder
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.addInitScript(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  await page.addInitScript((t) => localStorage.setItem("agentroom.token", t), hub.token);
  log(`open goto ${width}x${height} ${colorScheme ?? "light"}`);
  await page.goto(`http://127.0.0.1:${hub.port}/web/index.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".home .greet", { timeout: 20000 });
  await page.waitForSelector("[data-room]", { timeout: 20000 });
  await page.waitForSelector("#strip .uchip", { timeout: 20000 });
  log("open ready");
  return { page, ctx, problems };
}
const csp = (page) => page.evaluate(() => window.__csp);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = (page, name) => process.env.SHOTS !== "0" && page.screenshot({ path: join(shots, name), fullPage: false });

try {
  // ---- home, light, phone
  {
    const { page, ctx, problems } = await open({});
    assert.ok(await page.locator(".home .goalbox textarea").isVisible(), "the goal box is on the home");
    assert.ok(await page.locator("#strip .uchip").count() >= 2, "usage chips in the live strip");
    assert.match(await page.locator("#strip").innerText(), /working|approve|plenty|low/i, "the strip shows something live");
    assert.ok(await page.locator('[data-nav="advanced"]').isVisible(), "one Advanced entry");
    assert.ok(!(await page.locator("text=Permissions").count()), "Permissions is not on the home");
    assert.equal(await noHScroll(page), true, "no horizontal scroll at 390");
    assert.deepEqual(await csp(page), [], "no CSP violations");
    await shot(page, "home-390.png");
    ok("home (390, light): calm home with goal box, strip and Advanced; no CSP violations, no horizontal scroll");
    assert.deepEqual(problems, [], `no console/network errors: ${problems.join(" | ")}`);
    await ctx.close();
  }
  // ---- home, dark, phone
  {
    const { page, ctx, problems } = await open({ colorScheme: "dark" });
    await shot(page, "home-390-dark.png");
    assert.equal(await noHScroll(page), true, "no horizontal scroll (dark)");
    assert.deepEqual(await csp(page), [], "no CSP violations (dark)");
    ok("home (390, dark)");
    assert.deepEqual(problems, [], `no errors (dark): ${problems.join(" | ")}`);
    await ctx.close();
  }
  // ---- home, light + dark, wide
  for (const [scheme, name] of [[undefined, "home-1440.png"], ["dark", "home-1440-dark.png"]]) {
    const { page, ctx, problems } = await open({ width: 1440, height: 900, colorScheme: scheme });
    await shot(page, name);
    assert.deepEqual(await csp(page), [], "no CSP violations (wide)");
    ok(`home (1440, ${scheme ?? "light"})`);
    assert.deepEqual(problems, [], `no errors (wide): ${problems.join(" | ")}`);
    await ctx.close();
  }
  // ---- a room, with the strip above the conversation
  {
    const { page, ctx, problems } = await open({});
    await page.locator(`[data-room="${hub.roomId}"]`).first().click();
    await page.waitForSelector("#composer:not([hidden])", { timeout: 15000 });
    await page.waitForSelector("#strip .uchip", { timeout: 15000 });
    assert.ok(await page.locator("#goal").isVisible(), "the goal card is in the room");
    await shot(page, "room-with-strip-390.png");
    assert.equal(await noHScroll(page), true, "no horizontal scroll in a room");
    assert.deepEqual(await csp(page), [], "no CSP violations (room)");
    ok("room (390): the live strip sits above the conversation");
    assert.deepEqual(problems, [], `no errors (room): ${problems.join(" | ")}`);
    await ctx.close();
  }
  // ---- the Advanced menu
  {
    const { page, ctx, problems } = await open({});
    await page.locator('[data-nav="advanced"]').click();
    await page.waitForSelector('[data-nav="permissions"]', { timeout: 15000 });
    for (const nav of ["permissions", "folders", "subscriptions", "scorecard", "control"]) assert.ok(await page.locator(`[data-nav="${nav}"]`).count(), `Advanced lists ${nav}`);
    await shot(page, "advanced-menu-390.png");
    assert.deepEqual(await csp(page), [], "no CSP violations (advanced)");
    ok("advanced (390): the full list, reached from one entry");
    assert.deepEqual(problems, [], `no errors (advanced): ${problems.join(" | ")}`);
    await ctx.close();
  }
  // ---- the usage detail
  {
    const { page, ctx, problems } = await open({});
    await page.locator("#strip .uchip").first().click();
    await page.waitForSelector(".qsub", { timeout: 15000 });
    assert.match(await page.locator("#title").innerText(), /usage/i, "the usage detail is titled");
    await shot(page, "usage-detail-390.png");
    assert.equal(await noHScroll(page), true, "no horizontal scroll (usage)");
    assert.deepEqual(await csp(page), [], "no CSP violations (usage)");
    ok("usage detail (390): per-subscription windows");
    assert.deepEqual(problems, [], `no errors (usage): ${problems.join(" | ")}`);
    await ctx.close();
  }
  // ---- the delete-room affordance (the confirm itself is a native dialog; this shows where it lives)
  {
    const { page, ctx, problems } = await open({});
    await page.locator(`[data-room="${hub.roomId}"]`).first().click();
    await page.waitForSelector("#composer:not([hidden])", { timeout: 15000 });
    await page.locator("#infoBtn").click();
    await page.waitForSelector('[data-del-room]', { timeout: 15000 });
    await page.locator('[data-del-room]').scrollIntoViewIfNeeded();
    await shot(page, "delete-room-confirm-390.png");
    assert.equal(await noHScroll(page), true, "no horizontal scroll (room info)");
    assert.deepEqual(await csp(page), [], "no CSP violations (room info)");
    ok("delete room (390): a quiet Delete room action in room info");
    assert.deepEqual(problems, [], `no errors (room info): ${problems.join(" | ")}`);
    await ctx.close();
  }
  console.log(`\n${passed} checks passed. Screenshots in docs/screenshots/.`);
  log(`done: ${passed} checks passed`);
} catch (e) {
  log(`ERROR ${e?.message}`);
  console.error(e);
  process.exitCode = 1;
} finally {
  log("closing browser + hub");
  await browser.close().catch(() => {});
  hub.stop();
}
log("exiting");
process.exit(process.exitCode ?? 0);
