import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 0.1: indentation is a layout job. No label in the Mac app or the phone web app may start (or end) with spaces.
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = join(here, "../../app/src");
const web = join(here, "../web/app.js");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.(tsx?|js)$/.test(n) ? [p] : []; });
}

test("0.1: no UI label carries leading or trailing spaces", () => {
  const offenders: string[] = [];
  for (const f of [...files(appSrc), web]) {
    const src = readFileSync(f, "utf8");
    // label="  x", label={"  x"}, label: "  x", aria-label="  x", and string labels passed to row(...)/Toggle
    for (const m of src.matchAll(/(?:\blabel|aria-label|accessibilityLabel)\s*[=:]\s*\{?\s*(["'`])(\s+[^"'`]*|[^"'`]*\s+)\1/g)) {
      offenders.push(`${f.replace(join(here, "../.."), "")}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("0.1: the shell sub-setting is nested, in both apps", () => {
  const perms = readFileSync(join(appSrc, "screens/PermissionsScreen.tsx"), "utf8");
  assert.match(perms, /<Toggle nested label="Run shell commands without asking"/);
  const ui = readFileSync(join(appSrc, "components/ui.tsx"), "utf8");
  assert.match(ui, /nested: \{ marginLeft: [^}]*borderLeftWidth: 2/, "indented container with a left rule");
  const js = readFileSync(web, "utf8");
  assert.match(js, /<div class="nested">\$\{row\(a, "auto", "shell"/);
  const css = readFileSync(join(here, "../web/app.css"), "utf8");
  assert.match(css, /\.nested \{ margin: 0 0 4px 28px; border-left: 2px solid/);
});
