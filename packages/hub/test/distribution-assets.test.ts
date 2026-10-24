// 4.7 The non-code parts of the 1.0 release: packaging scripts' guards, the appcast script's round trip with the hub's reader,
// the Info.plist and entitlements, the download page, the user guides and the legal drafts. Nothing signs or notarizes here (that
// needs a Mac and the owner's account); these tests pin the rules that keep a release honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { offerFrom, parseAppcast } from "../src/distribution/appcast.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MACOS = "packages/app/macos";

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  return spawnSync("bash", [join(ROOT, script), ...args], { env: { ...clean, ...env }, encoding: "utf8", cwd: ROOT });
}

// ---------- package-mac.sh --release

test("4.7 release: a release build with nothing set fails at once and names every missing variable", () => {
  const r = run("scripts/package-mac.sh", ["--release"]);
  assert.notEqual(r.status, 0);
  const out = r.stdout + r.stderr;
  for (const v of ["AGENT_ROOM_SIGN_ID", "AGENT_ROOM_NOTARY_PROFILE", "AGENT_ROOM_FEED_URL", "AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY"]) assert.ok(out.includes(v), `names ${v}`);
  assert.match(out, /docs\/release\.md/, "points at the owner's checklist");
});

test("4.7 release: placeholder or malformed values are refused before anything is built", () => {
  const base = { AGENT_ROOM_SIGN_ID: "Developer ID Application: X (ABCDE12345)", AGENT_ROOM_NOTARY_PROFILE: "p", AGENT_ROOM_FEED_URL: "https://updates.example.invalid/agent-room/appcast.xml", AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY: "A".repeat(43) + "=" };
  const placeholder = run("scripts/package-mac.sh", ["--release"], base);
  assert.notEqual(placeholder.status, 0);
  assert.match(placeholder.stdout + placeholder.stderr, /placeholder/i);
  const http = run("scripts/package-mac.sh", ["--release"], { ...base, AGENT_ROOM_FEED_URL: "http://a.example.com/x.xml" });
  assert.notEqual(http.status, 0);
  assert.match(http.stdout + http.stderr, /https/);
  const key = run("scripts/package-mac.sh", ["--release"], { ...base, AGENT_ROOM_FEED_URL: "https://a.example.com/x.xml", AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY: "short" });
  assert.notEqual(key.status, 0);
  assert.match(key.stdout + key.stderr, /public key/i);
});

test("4.7 release: the script signs inside-out with the hardened runtime and a timestamp, notarizes, staples and never uses --deep", () => {
  const s = read("scripts/package-mac.sh");
  assert.match(s, /--options runtime/);
  assert.match(s, /--timestamp/);
  assert.match(s, /notarytool submit/);
  assert.match(s, /stapler staple/);
  assert.match(s, /spctl/);
  const deep = s.split("\n").filter((l) => !/^\s*#/.test(l) && /--deep/.test(l));
  assert.ok(deep.every((l) => /codesign --verify --deep/.test(l) || /codesign --force --deep -s - /.test(l)), "--deep appears only in verification and the ad-hoc local build, never with a Developer ID");
  assert.match(s, /verify-dmg\.sh" --release/);
});

test("4.7 release: the bundle id is com.agentroom.app everywhere and the Info.plist has the update and report keys as placeholders", () => {
  const pbx = read(`${MACOS}/AgentRoom.xcodeproj/project.pbxproj`);
  const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map((m) => m[1]);
  assert.ok(ids.length >= 2);
  assert.ok(ids.every((i) => i === "com.agentroom.app"), `bundle ids: ${ids.join(", ")}`);
  const plist = read(`${MACOS}/AgentRoom-macOS/Info.plist`);
  assert.match(plist, /<key>SUFeedURL<\/key>\s*<string>https:\/\/[^<]*\.invalid\//, "feed URL is an obvious placeholder");
  assert.match(plist, /<key>SUPublicEDKey<\/key>\s*<string>REPLACE/, "public key is a placeholder");
  assert.match(plist, /<key>AgentRoomReportURL<\/key>\s*<string><\/string>/, "no report address is built in");
  assert.match(plist, /<key>SUEnableSystemProfiling<\/key>\s*<false\/>/, "Sparkle sends no system profile");
});

test("4.7 release: Sparkle and its code exist only behind the build flag", () => {
  assert.match(read(`${MACOS}/Podfile`), /pod 'Sparkle'.*if ENV\['AGENT_ROOM_SPARKLE'\] == '1'/);
  const m = read(`${MACOS}/AgentRoom-macOS/AppDelegate.mm`);
  assert.match(m, /#if AR_SPARKLE/);
  assert.match(m, /SPUStandardUpdaterController/);
  assert.match(m, /Check for Updates/);
});

test("4.7 release: entitlements are the documented minimum (no sandbox, outgoing network only, and Node's three runtime keys)", () => {
  const app = read(`${MACOS}/AgentRoom-macOS/AgentRoom.entitlements`);
  assert.match(app, /com\.apple\.security\.network\.client/);
  assert.match(app, /app-sandbox<\/key>\s*<false\/>/, "not sandboxed: it launches the user's own CLIs");
  assert.ok(!/network\.server/.test(app.replace(/<!--[\s\S]*?-->/g, "")));
  const node = read(`${MACOS}/AgentRoom-macOS/NodeRuntime.entitlements`);
  for (const k of ["allow-jit", "allow-unsigned-executable-memory", "disable-library-validation"]) assert.ok(node.includes(`com.apple.security.cs.${k}`), k);
  const why = read(join(MACOS, "../../../docs/release.md"));
  for (const k of ["allow-jit", "allow-unsigned-executable-memory", "disable-library-validation"]) assert.ok(why.includes(`\`${k}\``), `${k} is explained in docs/release.md`);
});

test("4.7 release: every plist and entitlements file is one codesign and Xcode can read (no comments in entitlements, no `--` inside any comment)", () => {
  // codesign's entitlements parser (AMFIUnserializeXML) rejected a comment that said "--release": XML forbids "--" inside a comment.
  const files = ["AgentRoom-macOS/Info.plist", "AgentRoom-macOS/AgentRoom.entitlements", "AgentRoom-macOS/NodeRuntime.entitlements"];
  for (const f of files) {
    const text = read(`${MACOS}/${f}`);
    for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) assert.ok(!m[1].includes("--"), `${f}: a comment contains "--"`);
    assert.equal((text.match(/<key>/g) ?? []).length, (text.match(/<\/key>/g) ?? []).length, `${f}: keys are balanced`);
    if (f.endsWith(".entitlements")) assert.ok(!text.includes("<!--"), `${f}: entitlements carry no comments (the reasons live in docs/release.md)`);
  }
});

// ---------- make-appcast.sh with a stand-in sign_update

test("4.7 appcast: make-appcast.sh writes a feed the hub's reader understands, keeps old items and replaces the same version", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-appcast-"));
  const sign = join(dir, "sign_update");
  writeFileSync(sign, "#!/bin/sh\necho 'sparkle:edSignature=\"FAKESIG==\" length=\"11\"'\n");
  chmodSync(sign, 0o755);
  const dmg = join(dir, "a.dmg");
  writeFileSync(dmg, "hello-dmg\n");
  const out = join(dir, "appcast.xml");
  const env = { SPARKLE_SIGN_UPDATE: sign };
  const make = (v: string, url: string) => run("scripts/make-appcast.sh", [dmg, url, "--version", v, "--out", out], env);
  assert.equal(make("1.0.0", "https://dl.example.com/AgentRoom-1.0.0.dmg").status, 0);
  assert.equal(make("1.1.0", "https://dl.example.com/AgentRoom-1.1.0.dmg").status, 0);
  assert.equal(make("1.1.0", "https://dl.example.com/AgentRoom-1.1.0-rebuilt.dmg").status, 0);
  const items = parseAppcast(readFileSync(out, "utf8"));
  assert.deepEqual(items.map((i) => i.version).sort(), ["1.0.0", "1.1.0"], "one item per version");
  const v11 = items.find((i) => i.version === "1.1.0")!;
  assert.equal(v11.url, "https://dl.example.com/AgentRoom-1.1.0-rebuilt.dmg", "a re-run replaces the item");
  const offer = offerFrom(items, "1.0.0", "15.1");
  assert.equal(offer?.version, "1.1.0");
  assert.equal(offerFrom(items, "1.1.0", "15.1"), undefined, "nothing newer: no offer");
  assert.match(readFileSync(out, "utf8"), /sparkle:edSignature="FAKESIG=="/);
});

test("4.7 appcast: refuses a non-https download address and a missing signer", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-appcast-"));
  const dmg = join(dir, "a.dmg");
  writeFileSync(dmg, "x");
  const http = run("scripts/make-appcast.sh", [dmg, "http://dl.example.com/a.dmg", "--out", join(dir, "o.xml")], { SPARKLE_SIGN_UPDATE: "/bin/true" });
  assert.notEqual(http.status, 0);
  assert.match(http.stdout + http.stderr, /https/);
  const none = run("scripts/make-appcast.sh", [dmg, "https://dl.example.com/a.dmg", "--out", join(dir, "o.xml")], { SPARKLE_SIGN_UPDATE: join(dir, "missing") });
  assert.notEqual(none.status, 0);
  assert.ok(!existsSync(join(dir, "o.xml")), "no feed is written without a signature");
});

// ---------- the download page

const siteFiles = () => readdirSync(join(ROOT, "site")).filter((f) => /\.(html|css)$/.test(f));

test("4.7 site: the download page is self-contained (no scripts, no outside requests) and its download link is a placeholder", () => {
  assert.ok(existsSync(join(ROOT, "site/index.html")) && existsSync(join(ROOT, "site/style.css")));
  for (const f of siteFiles()) {
    const text = read(`site/${f}`);
    assert.ok(!/<script/i.test(text), `${f}: no scripts`);
    assert.ok(!/<iframe|<img[^>]+src="https?:|<link[^>]+href="https?:|@import|url\(\s*["']?https?:/i.test(text), `${f}: nothing loaded from elsewhere`);
    assert.ok(!/—/.test(text), `${f}: no em dashes`);
  }
  const html = read("site/index.html");
  const hrefs = [...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 1);
  assert.ok(hrefs.every((h) => /\.invalid\//.test(h)), "every outside link is the .invalid placeholder until the owner publishes");
  assert.match(html, /placeholder/i, "the placeholder is called out in a comment for the owner");
});

// ---------- docs

test("4.7 docs: every user guide exists, links resolve, and none uses an em dash", () => {
  const dir = join(ROOT, "docs/user");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  for (const need of ["README.md", "getting-started.md", "agents.md", "folders-and-approvals.md", "memory-and-control-files.md", "digest-and-scorecard.md", "privacy-and-data.md", "troubleshooting.md"]) assert.ok(files.includes(need), need);
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.ok(!/—/.test(text), `${f}: no em dash`);
    for (const m of text.matchAll(/\]\(([^)#]+\.md)\)/g)) assert.ok(existsSync(join(dir, m[1]!)), `${f} links to ${m[1]}, which exists`);
  }
});

test("4.7 legal: the licence options and drafts are marked as drafts, and the repo has no LICENSE yet", () => {
  assert.ok(!existsSync(join(ROOT, "LICENSE")) && !existsSync(join(ROOT, "LICENSE.md")), "the owner picks the licence after legal review");
  for (const f of ["eula-draft.md", "privacy-notice-draft.md"]) assert.match(read(`docs/legal/${f}`), /DRAFT: needs legal review/, f);
  const opts = read("docs/legal/licence-options.md");
  assert.match(opts, /MIT/);
  assert.match(opts, /Apache/);
  assert.match(opts, /EULA/);
});

test("4.7 legal: the app links to final terms only when they are marked final, and says drafts are drafts", () => {
  const legal = read("packages/app/src/legal.ts");
  assert.match(legal, /final:\s*false/);
  assert.match(legal, /PROVIDER_TERMS/);
  for (const url of ["anthropic.com", "openai.com"]) assert.ok(legal.includes(url), `cites ${url}`);
});
