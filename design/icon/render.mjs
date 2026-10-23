// Regenerates every icon asset from the two SVGs in this folder:
//   agent-room-icon.svg      -> png/, AgentRoom.iconset/, macOS AppIcon set, iOS AppIcon set, web icons
//   menubar-template.svg     -> MenuBarIconTemplate imagesets in the macOS asset catalog
//   preview.png              -> contact sheet used to check legibility at small sizes
// Run from the repo root: pnpm icon:render
import { Resvg } from "@resvg/resvg-js";
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const out = (...p) => join(root, ...p);
const read = (f) => readFileSync(join(here, f), "utf8");
const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };

const masterSvg = read("agent-room-icon.svg");
const glyphSvg = read("menubar-template.svg");

// ---------- helpers

/** Render an SVG string at a square pixel size. Returns { png (RGBA), rgb (no alpha), width, height }. */
function render(svg, size) {
  const img = new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } }).render();
  return { png: img.asPng(), rgba: img.pixels, width: img.width, height: img.height };
}

/** Minimal opaque RGB PNG encoder (Apple wants no alpha channel on iOS icons). */
function rgbPng({ rgba, width, height }) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = y * stride + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const between = (svg, name) => {
  const m = svg.match(new RegExp(`<!-- ${name}:start -->[\\s\\S]*?<!-- ${name}:end -->`));
  if (!m) throw new Error(`agent-room-icon.svg is missing the ${name}:start / ${name}:end markers`);
  return m[0];
};

/** Full-bleed square variant for iOS and the web (the OS applies its own mask; no shadow, no transparency). */
function fullBleedSvg(svg) {
  const art = between(svg, "art");
  return svg
    .replace(between(svg, "body"), '<rect width="1024" height="1024" fill="url(#bodyFill)"/>')
    .replace(art, `<g transform="translate(512 512) scale(1.15) translate(-512 -512)">\n${art}\n</g>`);
}

const iosSvg = fullBleedSvg(masterSvg);

// ---------- 1. master PNGs (design/icon/png)

const sizes = [16, 32, 64, 128, 256, 512, 1024];
const mac = new Map(); // size -> PNG buffer
for (const s of sizes) mac.set(s, render(masterSvg, s).png);
for (const s of [16, 32, 64, 128, 256, 512, 1024]) write(out("design/icon/png", `agent-room-icon-${s}.png`), mac.get(s));
write(out("design/icon/png", "agent-room-icon-ios-1024.png"), rgbPng(render(iosSvg, 1024)));

// ---------- 2. macOS iconset (iconutil) and the asset catalog's AppIcon set

const macSlots = [
  ["16x16", "1x", 16], ["16x16", "2x", 32],
  ["32x32", "1x", 32], ["32x32", "2x", 64],
  ["128x128", "1x", 128], ["128x128", "2x", 256],
  ["256x256", "1x", 256], ["256x256", "2x", 512],
  ["512x512", "1x", 512], ["512x512", "2x", 1024],
];
const slotFile = (size, scale) => `icon_${size}${scale === "2x" ? "@2x" : ""}.png`;
const info = { author: "xcode", version: 1 };

const iconset = out("design/icon/AgentRoom.iconset");
rmSync(iconset, { recursive: true, force: true });
const macSet = out("packages/app/macos/AgentRoom-macOS/Assets.xcassets/AppIcon.appiconset");
rmSync(macSet, { recursive: true, force: true });
for (const [size, scale, px] of macSlots) {
  write(join(iconset, slotFile(size, scale)), mac.get(px));
  write(join(macSet, slotFile(size, scale)), mac.get(px));
}
write(join(macSet, "Contents.json"), JSON.stringify({
  images: macSlots.map(([size, scale]) => ({ filename: slotFile(size, scale), idiom: "mac", scale, size })),
  info,
}, null, 2) + "\n");

// ---------- 3. iOS AppIcon set (opaque, full bleed)

const iosSet = out("packages/app/ios/AgentRoom/Images.xcassets/AppIcon.appiconset");
rmSync(iosSet, { recursive: true, force: true });
const iosSlots = [
  ["iphone", "20x20", "2x", 40], ["iphone", "20x20", "3x", 60],
  ["iphone", "29x29", "2x", 58], ["iphone", "29x29", "3x", 87],
  ["iphone", "40x40", "2x", 80], ["iphone", "40x40", "3x", 120],
  ["iphone", "60x60", "2x", 120], ["iphone", "60x60", "3x", 180],
  ["ios-marketing", "1024x1024", "1x", 1024],
];
const iosImages = [];
for (const [idiom, size, scale, px] of iosSlots) {
  const filename = idiom === "ios-marketing" ? "icon_1024.png" : `icon_${size}@${scale}.png`;
  write(join(iosSet, filename), rgbPng(render(iosSvg, px)));
  iosImages.push({ filename, idiom, scale, size });
}
write(join(iosSet, "Contents.json"), JSON.stringify({ images: iosImages, info }, null, 2) + "\n");

// ---------- 4. web app icons (packages/hub/web)

write(out("packages/hub/web/icon-180.png"), rgbPng(render(iosSvg, 180)));
write(out("packages/hub/web/icon-512.png"), rgbPng(render(iosSvg, 512)));
write(out("packages/hub/web/favicon-32.png"), rgbPng(render(iosSvg, 32)));

// ---------- 5. menu bar template glyph

const catalog = out("packages/app/macos/AgentRoom-macOS/Assets.xcassets");
const glyphSets = [
  ["MenuBarIconTemplate", 16], // 16 / 32
  ["MenuBarIconTemplate18", 18], // 18 / 36
];
for (const [name, px] of glyphSets) {
  const dir = join(catalog, `${name}.imageset`);
  rmSync(dir, { recursive: true, force: true });
  const one = render(glyphSvg, px).png, two = render(glyphSvg, px * 2).png;
  write(join(dir, `${name}.png`), one);
  write(join(dir, `${name}@2x.png`), two);
  write(join(dir, "Contents.json"), JSON.stringify({
    images: [
      { filename: `${name}.png`, idiom: "universal", scale: "1x" },
      { filename: `${name}@2x.png`, idiom: "universal", scale: "2x" },
    ],
    info,
    properties: { "template-rendering-intent": "template" },
  }, null, 2) + "\n");
  write(out("design/icon/png", `${name}.png`), one);
  write(out("design/icon/png", `${name}@2x.png`), two);
}

// ---------- 6. preview contact sheet (AC2 evidence)
// Real pixel renders at 16/32/64/128, drawn 3x with nearest-neighbour so individual pixels stay visible.

const ZOOM = 3;
const b64 = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
const img = (buf, x, y, px) =>
  `<image x="${x}" y="${y}" width="${px * ZOOM}" height="${px * ZOOM}" image-rendering="optimizeSpeed" href="${b64(buf)}"/>`;
const pad = 24, gap = 24;
const iconSizes = [16, 32, 64, 128];
const rowW = iconSizes.reduce((w, s) => w + s * ZOOM + gap, pad);
const iconRowH = 128 * ZOOM + pad * 2;
const barRowH = 18 * ZOOM + pad * 2;
const colW = rowW + pad;
const sheetW = colW * 2, sheetH = iconRowH + barRowH;
const themes = [
  { x: 0, bg: "#FFFFFF", bar: "#ECECEC", ink: "#000000" },
  { x: colW, bg: "#1E1E1E", bar: "#2A2A2A", ink: "#FFFFFF" },
];
let sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}" viewBox="0 0 ${sheetW} ${sheetH}">`;
for (const t of themes) {
  sheet += `<rect x="${t.x}" y="0" width="${colW}" height="${iconRowH}" fill="${t.bg}"/>`;
  sheet += `<rect x="${t.x}" y="${iconRowH}" width="${colW}" height="${barRowH}" fill="${t.bar}"/>`;
  let x = t.x + pad;
  for (const s of iconSizes) {
    sheet += img(mac.get(s), x, pad + (128 - s) * ZOOM, s);
    x += s * ZOOM + gap;
  }
  x = t.x + pad;
  for (const s of [16, 18]) {
    const g = render(glyphSvg.replaceAll("#000000", t.ink), s).png;
    sheet += img(g, x, iconRowH + pad, s);
    x += s * ZOOM + gap;
  }
}
// hairline between the light and dark halves
sheet += `<rect x="${colW - 1}" y="0" width="2" height="${sheetH}" fill="#888888"/></svg>`;
write(out("design/icon/preview.png"), new Resvg(sheet).render().asPng());

console.log("icons rendered");
