// The Mac and iPhone app run on React Native, whose URL and URLSearchParams are partial: URL's getters (host, pathname, search...) and
// URLSearchParams' set/get/has/delete throw "not implemented", and an error thrown while a screen renders quits a release build.
// The office screen crashed this way (URLSearchParams.set). This keeps those calls out of the app's source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../../app/src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});

test("app source uses no React Native URL or URLSearchParams API that throws at run time", () => {
  const found: string[] = [];
  for (const f of files(SRC)) {
    const text = readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "");
    if (/new URL\(/.test(text)) found.push(`${f}: new URL(...)`);
    if (/URLSearchParams/.test(text)) found.push(`${f}: URLSearchParams`);
    if (/\.searchParams\b/.test(text)) found.push(`${f}: .searchParams`);
  }
  assert.deepEqual(found, [], "build URLs and read hosts by hand in packages/app/src");
});
