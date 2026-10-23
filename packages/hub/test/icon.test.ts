import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "../web");

/** Width and height from the PNG signature and IHDR chunk (no image dependencies). */
function pngSize(file: string) {
  const b = readFileSync(join(web, file));
  assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} is not a PNG`);
  assert.equal(b.subarray(12, 16).toString("latin1"), "IHDR", `${file} has no IHDR chunk`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

test("web app icons exist at 180, 512 and 32 px", () => {
  assert.deepEqual(pngSize("icon-180.png"), { width: 180, height: 180 });
  assert.deepEqual(pngSize("icon-512.png"), { width: 512, height: 512 });
  assert.deepEqual(pngSize("favicon-32.png"), { width: 32, height: 32 });
});

test("manifest and index.html reference icon files that exist", () => {
  const manifest = JSON.parse(readFileSync(join(web, "manifest.webmanifest"), "utf8")) as { icons: { src: string; sizes: string }[] };
  for (const i of manifest.icons) {
    const { width, height } = pngSize(i.src.replace("/web/", ""));
    assert.equal(i.sizes, `${width}x${height}`, i.src);
  }
  const html = readFileSync(join(web, "index.html"), "utf8");
  const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="\/web\/([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(hrefs.length >= 2, "index.html should link an icon and an apple-touch-icon");
  for (const href of hrefs) pngSize(href);
});
