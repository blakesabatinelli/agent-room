// ---- 3.1 Colour maths, shared by the Mac app, the contrast tests and (as a hand port in hub/web/goalview.js) the phone app.
// WCAG 2.x contrast and the two small rules the apps use for agent colours: pick a readable ink for a coloured tile, and nudge a colour
// until it can be seen on the current canvas. No imports, so Metro and tsx both load it.

export interface Rgba { r: number; g: number; b: number; a: number }

/** "#rgb", "#rrggbb", "#rrggbbaa", "rgb(...)" or "rgba(...)". Null when it is none of those. */
export function parseColor(input: string): Rgba | null {
  const s = String(input).trim();
  const h = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (h) {
    let x = h[1];
    if (x.length === 3 || x.length === 4) x = [...x].map((c) => c + c).join("");
    if (x.length !== 6 && x.length !== 8) return null;
    const n = (i: number) => parseInt(x.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: x.length === 8 ? n(6) / 255 : 1 };
  }
  const f = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (f) return { r: Number(f[1]), g: Number(f[2]), b: Number(f[3]), a: f[4] === undefined ? 1 : Number(f[4]) };
  return null;
}

/** Lay `top` over an opaque `under`. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

export function luminance(c: Rgba): number {
  const lin = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio (1 to 21). A translucent `fg` or `bg` is laid over `under` first (default white). */
export function contrast(fg: string, bg: string, under = "#FFFFFF"): number {
  const u = parseColor(under) ?? { r: 255, g: 255, b: 255, a: 1 };
  const b0 = parseColor(bg), f0 = parseColor(fg);
  if (!b0 || !f0) return NaN;
  const b = composite(b0, u), f = composite(f0, b);
  const x = luminance(f), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const toHex = (c: Rgba) => "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase();

/** Black-ish or white ink, whichever reads better on `bg`. Always at least 4.5:1 for an opaque colour. */
export function readableInk(bg: string): string {
  return contrast("#FFFFFF", bg) >= contrast("#101418", bg) ? "#FFFFFF" : "#101418";
}

/**
 * An agent's own colour, adjusted so the tile can be seen on this canvas (at least 3:1, the bar for non-text shapes). A colour that is
 * already clear is returned as it was. Light colours are darkened on a light canvas; dark ones are lightened on a dark canvas.
 */
export function legibleOn(color: string, canvas: string, min = 3): string {
  const c = parseColor(color), bg = parseColor(canvas);
  if (!c || !bg) return color;
  if (contrast(color, canvas) >= min) return toHex(c);
  const toward = luminance(bg) < 0.4 ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 };
  let out = c;
  for (let i = 1; i <= 20 && contrast(toHex(out), canvas) < min; i++) {
    const t = i * 0.05;
    out = { r: c.r + (toward.r - c.r) * t, g: c.g + (toward.g - c.g) * t, b: c.b + (toward.b - c.b) * t, a: 1 };
  }
  return toHex(out);
}

/** The tile for an agent: its colour (made visible on the canvas) and the ink for the letter on it. */
export function agentTone(color: string, canvas: string): { bg: string; ink: string } {
  let bg = legibleOn(color, canvas);
  let ink = readableInk(bg);
  if (contrast(ink, bg) < 4.5) {
    // A mid-tone colour that neither white nor dark ink reads on. Push it away from the canvas-facing side: darker under white ink on a
    // light canvas, lighter under dark ink on a dark canvas, so the tile stays visible against the canvas too.
    const c = parseColor(bg), cv = parseColor(canvas);
    if (c && cv) {
      const onDark = luminance(cv) < 0.4;
      ink = onDark ? "#101418" : "#FFFFFF";
      const toward = onDark ? 255 : 0;
      for (let i = 1; i <= 20 && contrast(ink, bg) < 4.5; i++) {
        const t = i * 0.05;
        bg = toHex({ r: c.r + (toward - c.r) * t, g: c.g + (toward - c.g) * t, b: c.b + (toward - c.b) * t, a: 1 });
      }
    }
  }
  return { bg, ink };
}
