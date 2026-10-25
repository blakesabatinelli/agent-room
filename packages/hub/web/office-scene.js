// The office in 3D (3.4b, "live operations floor"): a dark isometric floor where each agent works at its own glowing desk around the goal's
// holographic pedestal, with the mission board and the task-flow board on the walls. Loaded by office.js only when the office is drawn in 3D,
// with the vendored three.js passed in (no second copy, nothing from the network). Every word drawn comes from GET /office.
// No post-processing: glow is additive sprites and unlit materials, which costs little on a laptop GPU and still runs in SwiftShader.

const TAU = Math.PI * 2;
const STATE_COLOR = { working: "--o-working", waiting_approval: "--o-amber", judged: "--o-judge", idle: "--o-idle", offline: "--o-off" };
const ACTIVE_TASK = new Set(["assigned", "running", "revising"]);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (k) => 1 - Math.pow(1 - k, 3);

/** Desks stand on an arc round the pedestal, facing it, on the side of the room the camera looks from. Desks are drawn DESK times life size. */
const DESK = 1.3, FIG = 1.3; // figures are drawn FIG times larger again than their desks, so they read as characters
function layoutFor(n) {
  const span = n <= 1 ? 0 : Math.min(3.6, 0.8 * (n - 1));
  const R = n <= 1 ? 4.6 : Math.max(4.6, ((n - 1) * 4.0) / span);
  const L = R + 2.7, H = 5.0;
  const at = (i) => { const a = Math.PI / 4 + (n <= 1 ? 0 : -span / 2 + (span * i) / (n - 1)); return { x: Math.sin(a) * R, z: Math.cos(a) * R, a }; };
  return { n, R, L, H, at };
}

export function createScene(T, host) {
  const { canvas, labelsEl, cssVar, safeColor, dbg } = host;
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
  const hemi = new T.HemisphereLight(0x9cc8ff, 0x0a0f16, 1.1);
  const key = new T.DirectionalLight(0xd8f1ff, 1.5); key.position.set(9, 14, 11);
  const rim = new T.DirectionalLight(0x29e0d0, 1.1); rim.position.set(-8, 6, -9);
  const core = new T.PointLight(0x2de2d0, 6, 10, 1.6); core.position.set(0, 2.2, 0);
  scene.add(hemi, key, rim, core);
  const world = new T.Group(); scene.add(world);
  const fx = new T.Group(); scene.add(fx); // one-shot effects, never picked
  const ray = new T.Raycaster(), ndc = new T.Vector2(), tmp = new T.Vector3(), tmp2 = new T.Vector3();

  // ---------- shared textures and helpers
  const glowTex = radialTex(128, [[0, "rgba(255,255,255,1)"], [0.25, "rgba(255,255,255,0.55)"], [1, "rgba(255,255,255,0)"]]);
  const softTex = radialTex(128, [[0, "rgba(255,255,255,0.9)"], [0.6, "rgba(255,255,255,0.25)"], [1, "rgba(255,255,255,0)"]]);
  const ringTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d");
    g.strokeStyle = "#fff"; g.lineWidth = 7; g.shadowColor = "#fff"; g.shadowBlur = 14; g.beginPath(); g.arc(64, 64, 46, 0, TAU); g.stroke();
    return tex(c);
  })();
  const shared = new Set([glowTex, softTex, ringTex]);
  function radialTex(size, stops) {
    const c = document.createElement("canvas"); c.width = c.height = size; const g = c.getContext("2d");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) grad.addColorStop(o, col);
    g.fillStyle = grad; g.fillRect(0, 0, size, size); return tex(c);
  }
  function tex(c) { const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; return t; }
  const lam = (color, extra = {}) => new T.MeshLambertMaterial({ color, ...extra });
  const basic = (color, extra = {}) => new T.MeshBasicMaterial({ color, ...extra });
  const add = (color, extra = {}) => new T.MeshBasicMaterial({ color, transparent: true, blending: T.AdditiveBlending, depthWrite: false, ...extra });
  const mesh = (geo, m, x = 0, y = 0, z = 0) => { const o = new T.Mesh(geo, m); o.position.set(x, y, z); return o; };
  const boxGeo = new T.BoxGeometry(1, 1, 1); boxGeo.userData.shared = true;
  const box = (w, h, d, m, x, y, z) => { const o = mesh(boxGeo, m, x, y, z); o.scale.set(w, h, d); return o; };
  const noPick = (o) => { o.traverse((c) => { c.raycast = () => {}; }); return o; };
  /** A glow: an additive sprite (always faces the camera). */
  function glow(color, size, opacity = 0.8, map = glowTex) {
    const s = new T.Sprite(new T.SpriteMaterial({ map, color, transparent: true, blending: T.AdditiveBlending, depthWrite: false, opacity }));
    s.scale.setScalar(size); s.userData.base = size; s.userData.alpha = opacity; s.raycast = () => {}; return s;
  }
  /** A glow lying on the floor. */
  function pool(color, size, opacity = 0.5) {
    const m = mesh(new T.PlaneGeometry(size, size), add(color, { map: softTex, opacity }), 0, 0.012, 0);
    m.rotation.x = -Math.PI / 2; m.raycast = () => {}; m.userData.alpha = opacity; return m;
  }
  function dispose(obj) {
    obj.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) { if (m.map && !shared.has(m.map)) m.map.dispose(); m.dispose(); }
    });
  }
  /** A colour that reads as light on a dark floor: the agent's own hue, saturated and lifted. */
  function neon(hex) {
    const c = new T.Color(safeColor(hex)); const hsl = {}; c.getHSL(hsl);
    return new T.Color().setHSL(hsl.h, Math.max(hsl.s, 0.62), clamp(hsl.l, 0.56, 0.68));
  }

  // ---------- palette (CSS custom properties, so the light theme is a stylesheet change)
  let pal = {};
  function readPalette() {
    const c = (n) => new T.Color(cssVar(n) || "#888");
    pal = {
      floor: c("--o-floor"), grid: cssVar("--o-grid"), wall: c("--o-wall"), panel: c("--o-panel"), desk: c("--o-desk"), metal: c("--o-metal"),
      head: c("--o-head"), teal: c("--o-teal"), working: c("--o-working"), amber: c("--o-amber"), judge: c("--o-judge"), idle: c("--o-idle"),
      off: c("--o-off"), red: c("--o-red"), green: c("--o-green"), screen: cssVar("--o-screen"), ink: cssVar("--o-ink"), muted: cssVar("--o-muted"),
      light: cssVar("--o-mode") === "light",
    };
    hemi.intensity = pal.light ? 2.2 : 1.1; key.intensity = pal.light ? 1.6 : 1.5; rim.intensity = pal.light ? 0.4 : 1.1;
  }
  const stateColor = (st) => pal[{ working: "working", waiting_approval: "amber", judged: "judge", idle: "idle", offline: "off" }[st] || "idle"];

  // ---------- state of the scene
  let lay = layoutFor(1), desks = new Map(), boards = null, pedestal = null, door = null, structSig = "";
  let size = { w: 1, h: 1 }, selected = "", hover = "";
  const labelEls = new Map();
  const effects = [];

  // =================================================================================================================
  // characters: an original figure from primitives (rounded body, head with a visor, headset, arms), tinted with the agent's colour
  // =================================================================================================================
  function makeFigure(colorHex, opts = {}) {
    const { scale = 1, seated = true } = opts;
    const col = neon(colorHex), bodyCol = col.clone().lerp(new T.Color(0x0b1118), 0.2);
    const g = new T.Group(); g.scale.setScalar(scale);
    const bodyM = lam(bodyCol), darkM = lam(0x121a24), headM = lam(pal.head), visorM = basic(col.clone()), trimM = basic(col.clone());
    const torso = new T.Group(); torso.position.set(0, seated ? 0.6 : 0.62, 0); g.add(torso);
    const body = mesh(new T.CapsuleGeometry(0.25, 0.32, 4, 12), bodyM, 0, 0.36, 0); body.scale.set(1, 1, 0.82); torso.add(body);
    torso.add(mesh(new T.TorusGeometry(0.2, 0.025, 6, 20), trimM, 0, 0.62, 0).rotateX(Math.PI / 2)); // a glowing collar in the agent's colour
    if (seated) { for (const s of [-1, 1]) torso.add(mesh(new T.CapsuleGeometry(0.09, 0.32, 3, 8), darkM, s * 0.12, -0.02, 0.2).rotateX(Math.PI / 2)); }
    else for (const s of [-1, 1]) g.add(mesh(new T.CapsuleGeometry(0.085, 0.42, 3, 8), darkM, s * 0.11, 0.33, 0));
    const head = new T.Group(); head.position.set(0, 0.92, 0); torso.add(head);
    const skull = mesh(new T.SphereGeometry(0.22, 18, 14), headM); skull.scale.set(1, 1.04, 1); head.add(skull);
    const visor = mesh(new T.SphereGeometry(0.205, 18, 10, Math.PI * 0.12, Math.PI * 0.76, Math.PI * 0.34, Math.PI * 0.24), visorM); // a band across the face (the figure is built facing +z)
    visor.scale.set(1.08, 1.08, 1.08); head.add(visor);
    const band = mesh(new T.TorusGeometry(0.235, 0.022, 6, 18, Math.PI), darkM); band.rotation.set(0, Math.PI / 2, 0); head.add(band); // headset band over the top
    for (const s of [-1, 1]) {
      const cup = mesh(new T.CylinderGeometry(0.075, 0.075, 0.06, 14), darkM, s * 0.225, 0, 0); cup.rotation.z = Math.PI / 2; head.add(cup);
      head.add(mesh(new T.CylinderGeometry(0.05, 0.05, 0.065, 12), trimM, s * 0.232, 0, 0).rotateZ(Math.PI / 2));
    }
    const boom = mesh(new T.CylinderGeometry(0.012, 0.012, 0.24, 6), darkM, 0.2, -0.1, 0.11); boom.rotation.set(-Math.PI / 2.4, 0, 0.5); head.add(boom);
    head.add(mesh(new T.SphereGeometry(0.026, 8, 6), trimM, 0.15, -0.15, 0.21));
    const arm = (side) => {
      const sh = new T.Group(); sh.position.set(side * 0.31, 0.56, 0); torso.add(sh);
      sh.add(mesh(new T.CapsuleGeometry(0.075, 0.2, 3, 8), bodyM, 0, -0.15, 0));
      const el = new T.Group(); el.position.set(0, -0.3, 0); sh.add(el);
      el.add(mesh(new T.CapsuleGeometry(0.065, 0.18, 3, 8), bodyM, 0, -0.13, 0), mesh(new T.SphereGeometry(0.07, 10, 8), headM, 0, -0.27, 0));
      return { sh, el };
    };
    const L = arm(-1), R = arm(1);
    return { group: g, torso, head, L, R, mats: { bodyM, headM, visorM, trimM, darkM }, cols: { body: bodyCol, head: pal.head.clone(), visor: col.clone() }, pose: { lx: 0, le: 0, rx: 0, re: 0, rz: 0, hy: 0, hx: 0, lean: 0 }, dim: 0 };
  }
  const restTo = (p, key2, v, k) => { p[key2] += (v - p[key2]) * k; };
  /** Poses a figure for a state (negative shoulder and elbow angles swing an arm forward). */
  function pose(f, st, t, dt, phase, snap) {
    const k = snap ? 1 : 1 - Math.exp(-dt * 7), p = f.pose;
    let lx = -0.25, le = -0.35, rx = -0.25, re = -0.35, rz = 0, hy = 0, hx = 0, lean = 0, breathe = 1;
    if (st === "working") {
      lx = -0.75 + Math.sin(t * 13 + phase) * 0.07; rx = -0.75 + Math.sin(t * 13 + phase + 2.1) * 0.07; le = -0.95 + Math.sin(t * 17 + phase) * 0.12; re = -0.95 + Math.sin(t * 16 + phase + 1.3) * 0.12;
      hx = 0.12 + Math.sin(t * 2.2 + phase) * 0.04; hy = Math.sin(t * 0.7 + phase) * 0.12; lean = 0.12;
    } else if (st === "waiting_approval") {
      rx = -2.85; re = -0.25 + Math.sin(t * 6 + phase) * 0.25; rz = -0.15 + Math.sin(t * 6 + phase) * 0.18; lx = -0.6; le = -0.9; hx = -0.18; hy = 0.25 * Math.sin(t * 0.9 + phase);
    } else if (st === "judged") { // leans back, a hand to the chin: its work is being judged
      lx = -0.4; le = -0.6; rx = -1.15; re = -2.15; hx = -0.08; hy = Math.sin(t * 0.5 + phase) * 0.35; lean = -0.1;
    } else if (st === "offline") { lx = -0.1; le = -0.2; rx = -0.1; re = -0.2; hx = 0.55; lean = 0.18; breathe = 0; }
    else { hy = Math.sin(t * 0.35 + phase) * 0.55 + Math.sin(t * 0.13 + phase * 2) * 0.25; hx = Math.sin(t * 0.27 + phase) * 0.08; } // idle: looks around
    restTo(p, "lx", lx, k); restTo(p, "le", le, k); restTo(p, "rx", rx, k); restTo(p, "re", re, k); restTo(p, "rz", rz, k); restTo(p, "hy", hy, k); restTo(p, "hx", hx, k); restTo(p, "lean", lean, k);
    f.L.sh.rotation.x = p.lx; f.L.el.rotation.x = p.le; f.R.sh.rotation.x = p.rx; f.R.el.rotation.x = p.re; f.R.sh.rotation.z = p.rz;
    f.head.rotation.set(p.hx, p.hy, 0); f.torso.rotation.x = p.lean;
    const b = 1 + (snap ? 0 : Math.sin(t * 1.8 + phase) * 0.018 * breathe); f.torso.scale.set(1, b, 1);
    const dim = st === "offline" ? 1 : 0;
    if (f.dim !== dim) {
      f.dim = dim; const dk = new T.Color(0x151b22);
      f.mats.bodyM.color.copy(f.cols.body).lerp(dk, dim * 0.7); f.mats.headM.color.copy(f.cols.head).lerp(dk, dim * 0.7);
      f.mats.visorM.color.copy(f.cols.visor).multiplyScalar(dim ? 0.12 : 1); f.mats.trimM.color.copy(f.cols.visor).multiplyScalar(dim ? 0.15 : 1);
    }
  }

  // =================================================================================================================
  // screens: CanvasTextures with the agent's real task title and its latest lines
  // =================================================================================================================
  const FONT = cssVar("--o-font") || "system-ui, sans-serif", MONO = cssVar("--o-mono") || "monospace";
  function clipPx(x, s, maxW) { if (x.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && x.measureText(`${t}…`).width > maxW) t = t.slice(0, -1); return `${t}…`; }
  function wrapPx(x, text, maxW, maxLines) {
    const words = String(text || "").split(/\s+/).filter(Boolean), out = []; let cur = "";
    for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (x.measureText(t).width <= maxW || !cur) cur = t; else { out.push(cur); cur = w; } }
    if (cur) out.push(cur);
    if (out.length > maxLines) { const rest = out.slice(maxLines - 1).join(" "); out.length = maxLines - 1; out.push(clipPx(x, rest, maxW)); }
    return out.map((l) => clipPx(x, l, maxW));
  }
  function roundRect(x, X, Y, W, H, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath(); }

  /** The main monitor: a title band (fixed) and a log that scrolls (a tall texture moved by its UV offset, so scrolling costs no upload). */
  function paintMain(d) {
    const a = d.agent, col = "#" + d.neon.getHexString();
    const h = d.screens.head, x = h.ctx, W = h.canvas.width, Hh = h.canvas.height;
    x.fillStyle = pal.screen; x.fillRect(0, 0, W, Hh);
    x.fillStyle = col; x.fillRect(0, 0, W, 7);
    x.font = `600 22px ${FONT}`; x.fillStyle = col; x.textBaseline = "top"; x.fillText(clipPx(x, (a.task ? a.task.status === "review" ? "IN REVIEW" : a.task.status.toUpperCase() : a.state === "offline" ? "OFFLINE" : "NO TASK"), W - 40), 22, 20);
    x.font = `600 30px ${FONT}`; x.fillStyle = "#eef6fa";
    wrapPx(x, a.task?.title || a.taskTitle || (a.state === "offline" ? "Switched off" : "Waiting for work"), W - 44, 2).forEach((ln, i) => x.fillText(ln, 22, 54 + i * 36));
    h.tex.needsUpdate = true;
    const lg = d.screens.log, y = lg.ctx, LW = lg.canvas.width, LH = lg.canvas.height;
    y.fillStyle = pal.screen; y.fillRect(0, 0, LW, LH);
    const lines = (a.log && a.log.length ? a.log : a.task ? [a.task.step] : []).slice(-8);
    y.font = `22px ${MONO}`; y.textBaseline = "top";
    const rows = Math.floor(LH / 30);
    for (let r = 0; r < rows && lines.length; r++) { // repeated, so the texture wraps seamlessly while it scrolls
      const ln = lines[r % lines.length];
      y.fillStyle = r % lines.length === lines.length - 1 ? col : "rgba(200,225,235,0.72)";
      y.fillText(clipPx(y, `${r % lines.length === lines.length - 1 ? "› " : "  "}${ln}`, LW - 30), 16, r * 30 + 6);
    }
    if (!lines.length) { y.fillStyle = "rgba(200,225,235,0.4)"; y.font = `22px ${MONO}`; y.fillText("  no lines yet", 16, 8); }
    lg.tex.needsUpdate = true; lg.rows = rows; lg.count = lines.length;
  }
  /** The side monitor: state, progress and the next step. */
  function paintSide(d) {
    const a = d.agent, s = d.screens.side, x = s.ctx, W = s.canvas.width, H = s.canvas.height;
    const stc = "#" + stateColor(a.state).getHexString();
    x.fillStyle = pal.screen; x.fillRect(0, 0, W, H);
    x.textBaseline = "top"; x.font = `600 22px ${FONT}`; x.fillStyle = stc; x.fillText(host.stateWord(a).toUpperCase(), 18, 16);
    const p = a.task?.progress;
    x.lineWidth = 12; x.strokeStyle = "rgba(255,255,255,0.12)"; x.beginPath(); x.arc(W - 62, 92, 38, 0, TAU); x.stroke();
    if (p !== undefined) { x.strokeStyle = stc; x.beginPath(); x.arc(W - 62, 92, 38, -Math.PI / 2, -Math.PI / 2 + TAU * p); x.stroke(); x.fillStyle = "#eef6fa"; x.font = `600 22px ${FONT}`; x.textAlign = "center"; x.fillText(`${Math.round(p * 100)}%`, W - 62, 81); x.textAlign = "left"; }
    x.font = `20px ${FONT}`; x.fillStyle = "rgba(220,235,242,0.8)";
    wrapPx(x, a.task?.step || (a.next ? `Next: ${a.next}` : a.role || ""), W - 140, 3).forEach((ln, i) => x.fillText(ln, 18, 56 + i * 26));
    s.tex.needsUpdate = true;
  }
  function screen(w, h, cw, ch, repeatY) {
    const canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch;
    const t = tex(canvas); if (repeatY) { t.wrapT = T.RepeatWrapping; t.repeat.set(1, repeatY); }
    const m = basic(0xffffff, { map: t });
    return { canvas, ctx: canvas.getContext("2d"), tex: t, mat: m, mesh: mesh(new T.PlaneGeometry(w, h), m) };
  }

  // =================================================================================================================
  // a desk: the agent, two monitors, a chair, a floor glow in its colour, an approval beacon, the judge's orbiting gavel, its helpers
  // =================================================================================================================
  function buildDesk(agent, i) {
    const p = lay.at(i), col = neon(agent.color);
    const g = new T.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = Math.atan2(p.x, p.z); g.scale.setScalar(DESK); // local -z faces the pedestal
    g.userData.agentId = agent.id;
    const deskM = lam(pal.desk), metalM = lam(pal.metal), edgeM = basic(col.clone());
    const floorGlow = pool(col, 3.6, pal.light ? 0.25 : 0.42); g.add(floorGlow);
    const sel = mesh(new T.RingGeometry(1.55, 1.66, 48), add(col.clone(), { opacity: 0 }), 0, 0.02, 0.15); sel.rotation.x = -Math.PI / 2; sel.raycast = () => {}; g.add(sel);
    // desk
    g.add(box(2.1, 0.07, 0.95, deskM, 0, 0.8, 0), box(0.07, 0.78, 0.86, metalM, -1.0, 0.39, 0), box(0.07, 0.78, 0.86, metalM, 1.0, 0.39, 0), box(1.95, 0.42, 0.04, metalM, 0, 0.56, -0.42));
    g.add(box(2.1, 0.022, 0.022, edgeM, 0, 0.84, 0.477), box(0.022, 0.022, 0.95, edgeM, -1.05, 0.84, 0), box(0.022, 0.022, 0.95, edgeM, 1.05, 0.84, 0));
    const keys = box(0.62, 0.02, 0.2, basic(col.clone().multiplyScalar(0.35)), -0.18, 0.845, 0.2); g.add(keys);
    // monitors (screens face +z, toward the agent and, over its shoulder, the camera)
    const main = new T.Group(); main.position.set(-0.2, 1.3, -0.24); g.add(main);
    main.add(box(1.08, 0.66, 0.05, metalM, 0, 0, -0.03), box(0.06, 0.4, 0.06, metalM, 0, -0.36, -0.05), box(1.08, 0.016, 0.016, edgeM, 0, -0.335, 0.0));
    const head = screen(1.0, 0.25, 512, 128); head.mesh.position.set(0, 0.165, 0.002); main.add(head.mesh);
    const log = screen(1.0, 0.33, 512, 512, 0.33); log.mesh.position.set(0, -0.125, 0.002); main.add(log.mesh);
    const side = screen(0.56, 0.4, 320, 228); const sideG = new T.Group(); sideG.position.set(0.72, 1.18, -0.12); sideG.rotation.y = -0.5; g.add(sideG);
    sideG.add(box(0.62, 0.46, 0.04, metalM, 0, 0, -0.03), box(0.05, 0.3, 0.05, metalM, 0, -0.3, -0.04), side.mesh); side.mesh.position.z = 0.002;
    const screenGlow = glow(col, 2.2, 0.22); screenGlow.position.set(-0.2, 1.35, -0.1); g.add(screenGlow);
    const led = mesh(new T.SphereGeometry(0.035, 8, 6), basic(0xffffff), 0.42, 1.6, -0.22); g.add(led);
    // chair (a low back, so the figure reads from behind)
    const chair = new T.Group(); chair.position.set(0, 0, 0.92); g.add(chair);
    chair.add(box(0.62, 0.08, 0.58, metalM, 0, 0.5, 0), box(0.62, 0.32, 0.07, metalM, 0, 0.72, 0.3), box(0.06, 0.46, 0.06, metalM, 0, 0.25, 0), box(0.56, 0.04, 0.56, metalM, 0, 0.03, 0));
    chair.add(box(0.64, 0.02, 0.02, edgeM, 0, 0.89, 0.33));
    const fig = makeFigure(agent.color, { scale: FIG }); fig.group.position.set(0, 0.55 * (1 - FIG), 0.9); fig.group.rotation.y = Math.PI; g.add(fig.group); // faces its monitor, hips on the seat
    // waiting for approval: an amber beacon on the desk, pulsing, with a turning light
    const beacon = new T.Group(); beacon.position.set(0.82, 0.84, 0.28); beacon.visible = false; g.add(beacon);
    const bulbM = basic(pal.amber.clone());
    beacon.add(mesh(new T.CylinderGeometry(0.08, 0.1, 0.08, 14), metalM, 0, 0.04, 0), mesh(new T.SphereGeometry(0.085, 14, 10, 0, TAU, 0, Math.PI / 2), bulbM, 0, 0.08, 0));
    const beamM = add(pal.amber.clone(), { map: softTex, opacity: 0.5, side: T.DoubleSide });
    const beam = new T.Group(); beam.position.y = 0.13; beacon.add(beam);
    for (const r of [0, Math.PI / 2]) { const pl = mesh(new T.PlaneGeometry(1.3, 0.2), beamM, 0.55, 0, 0); const holder = new T.Group(); holder.rotation.y = r; holder.add(pl); beam.add(holder); }
    const beaconGlow = glow(pal.amber, 1.6, 0.8); beaconGlow.position.y = 0.12; beacon.add(beaconGlow);
    // its work is being judged: a gavel and a scale orbit over its head, with a violet ring on the floor
    const judge = new T.Group(); judge.position.set(0, 1.85, 0.9); judge.visible = false; g.add(judge); // orbits at head height, under the card
    const jm = basic(pal.judge.clone());
    const orbit = new T.Group(); judge.add(orbit);
    const gavel = new T.Group(); gavel.position.set(0.66, 0, 0); gavel.add(box(0.045, 0.28, 0.045, jm, 0, -0.06, 0), box(0.2, 0.085, 0.085, jm, 0, 0.08, 0)); orbit.add(gavel);
    const scale = new T.Group(); scale.position.set(-0.66, 0, 0);
    scale.add(box(0.03, 0.26, 0.03, jm, 0, 0, 0), box(0.34, 0.025, 0.025, jm, 0, 0.12, 0));
    for (const s of [-1, 1]) scale.add(mesh(new T.CylinderGeometry(0.075, 0.04, 0.035, 12), jm, s * 0.16, 0.0, 0));
    orbit.add(scale, glow(pal.judge, 0.9, 0.5));
    const judgeRing = mesh(new T.RingGeometry(0.7, 0.78, 40), add(pal.judge.clone(), { opacity: 0.6 }), 0, 0.025, 0.9); judgeRing.rotation.x = -Math.PI / 2; judgeRing.raycast = () => {}; judgeRing.visible = false; g.add(judgeRing);
    // helpers (3.3 subagents): smaller standing figures at the desk's right; a read-only one carries a magnifier
    const helpers = [];
    agent.helpers.slice(0, 4).forEach((h, k) => {
      const hc = host.agentById(h.agentId)?.color || agent.color;
      const f = makeFigure(hc, { scale: 0.8, seated: false });
      f.group.position.set(1.6 + (k % 2) * 0.62, 0, -0.1 + Math.floor(k / 2) * 0.66); f.group.rotation.y = -0.7;
      f.group.userData.agentId = h.agentId || agent.id;
      if (h.readOnly) {
        const mag = new T.Group(); mag.position.set(-0.36, 0.95, -0.2);
        mag.add(mesh(new T.TorusGeometry(0.12, 0.025, 6, 16), basic(0xdff6ff)), mesh(new T.CircleGeometry(0.11, 16), add(0x9be8ff, { opacity: 0.35 })), box(0.03, 0.16, 0.03, lam(0x3a4552), 0, -0.19, 0));
        f.group.add(mag);
      }
      const hg = glow(neon(hc), 1.1, 0); hg.position.y = 0.8; f.group.add(hg);
      const hp = pool(neon(hc), 1.1, 0.4); f.group.add(hp);
      g.add(f.group); helpers.push({ ...f, data: h, halo: hg, phase: k * 1.3 + i });
    });
    g.updateMatrixWorld(true);
    return {
      group: g, agent, neon: col, fig, screens: { head, log, side }, screenGlow, led, keys, beacon, beam, beaconGlow, bulbM, judge, orbit, judgeRing, sel, floorGlow, edgeM,
      helpers, overflow: Math.max(0, agent.helpers.length - 4), pos: p, phase: i * 1.7, flash: 0, flashCol: new T.Color(), sig: deskSig(agent), paintSig: "",
    };
  }
  const deskSig = (a) => JSON.stringify([a.color, a.name, a.helpers.map((h) => [h.id, h.agentId, h.readOnly])]);
  const paintSigOf = (a) => JSON.stringify([a.state, a.task, a.taskTitle, a.log, a.next, a.role]);
  /** A point in a desk's local space, in world space. */
  const deskPoint = (d, x, y, z, out = new T.Vector3()) => d.group.localToWorld(out.set(x, y, z));

  // =================================================================================================================
  // the room: floor with a glowing grid and neon edges, two walls with light strips, the boards, the door
  // =================================================================================================================
  function buildRoom() {
    const { L, H } = lay;
    const grp = new T.Group();
    // the floor: a slab whose top is a canvas grid (unlit, so it glows a little on its own)
    const c = document.createElement("canvas"); c.width = c.height = 1024; const x = c.getContext("2d");
    x.fillStyle = "#" + pal.floor.getHexString(); x.fillRect(0, 0, 1024, 1024);
    const vg = x.createRadialGradient(512, 512, 40, 512, 512, 720); vg.addColorStop(0, pal.light ? "rgba(255,255,255,0.0)" : "rgba(40,120,130,0.22)"); vg.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = vg; x.fillRect(0, 0, 1024, 1024);
    const cells = Math.round(L * 2 / 1.1), step = 1024 / cells;
    for (let k = 0; k <= cells; k++) {
      x.strokeStyle = pal.grid; x.globalAlpha = k % 4 === 0 ? 0.55 : 0.22; x.lineWidth = k % 4 === 0 ? 2 : 1;
      x.beginPath(); x.moveTo(k * step, 0); x.lineTo(k * step, 1024); x.moveTo(0, k * step); x.lineTo(1024, k * step); x.stroke();
    }
    x.globalAlpha = 1;
    const floorTex = tex(c); floorTex.anisotropy = 8;
    const top = mesh(new T.PlaneGeometry(L * 2, L * 2), basic(0xffffff, { map: floorTex }), 0, 0, 0); top.rotation.x = -Math.PI / 2; grp.add(top);
    grp.add(box(L * 2, 0.5, L * 2, lam(pal.panel), 0, -0.251, 0));
    const tealE = basic(pal.teal.clone());
    // neon edges along the two near sides of the slab, and where the walls meet the floor
    grp.add(box(L * 2, 0.04, 0.04, tealE, 0, 0.0, L), box(0.04, 0.04, L * 2, tealE, L, 0.0, 0), box(L * 2, 0.03, 0.03, tealE, 0, -0.5, L), box(0.03, 0.03, L * 2, tealE, L, -0.5, 0));
    for (const [px, pz, w, d] of [[0, L, L * 2, 0.6], [L, 0, 0.6, L * 2]]) { const e = mesh(new T.PlaneGeometry(w, d), add(pal.teal.clone(), { map: softTex, opacity: 0.35 }), px, 0.01, pz); e.rotation.x = -Math.PI / 2; grp.add(e); }
    // walls: dark panels with vertical light strips
    const wallM = lam(pal.wall);
    grp.add(box(L * 2 + 0.3, H, 0.3, wallM, 0, H / 2, -L - 0.15), box(0.3, H, L * 2, wallM, -L - 0.15, H / 2, 0));
    grp.add(box(L * 2, 0.04, 0.04, tealE, 0, 0.03, -L + 0.02), box(0.04, 0.04, L * 2, tealE, -L + 0.02, 0.03, 0), box(L * 2 + 0.3, 0.05, 0.05, tealE, 0, H, -L + 0.02), box(0.05, 0.05, L * 2, tealE, -L + 0.02, H, 0));
    const stripM = basic(pal.teal.clone().multiplyScalar(0.55));
    for (let k = 1; k < 8; k++) {
      const u = -L + (k * 2 * L) / 8;
      grp.add(box(0.035, H - 0.6, 0.02, stripM, u, H / 2, -L + 0.02), box(0.02, H - 0.6, 0.035, stripM, -L + 0.02, H / 2, u));
    }
    world.add(noPick(grp));
  }

  // ---------- the boards
  function buildBoards() {
    const { L, H } = lay;
    const bw = Math.min(L * 1.04, 8.6), bh = bw * 0.54, turn = 0.45, off = (bw / 2) * Math.sin(turn) + 0.25;
    const mk = (w, h) => {
      const canvas = document.createElement("canvas"); canvas.width = 2048; canvas.height = Math.round(2048 * h / w);
      const t = tex(canvas); t.anisotropy = 8;
      const grp = new T.Group();
      const face = mesh(new T.PlaneGeometry(w, h), basic(0xffffff, { map: t }));
      const frameM = basic(pal.teal.clone());
      grp.add(face, box(w + 0.12, 0.04, 0.04, frameM, 0, h / 2 + 0.06, 0.01), box(w + 0.12, 0.04, 0.04, frameM, 0, -h / 2 - 0.06, 0.01), box(0.04, h + 0.12, 0.04, frameM, -w / 2 - 0.06, 0, 0.01), box(0.04, h + 0.12, 0.04, frameM, w / 2 + 0.06, 0, 0.01));
      const halo = mesh(new T.PlaneGeometry(w * 1.35, h * 1.6), add(pal.teal.clone(), { map: softTex, opacity: pal.light ? 0.15 : 0.32 }), 0, 0, -0.04); grp.add(halo);
      const dots = new T.Group(); dots.position.z = 0.02; grp.add(dots);
      const legM = lam(pal.metal), legE = basic(pal.teal.clone().multiplyScalar(0.8)), y0 = -(H * 0.55);
      for (const sx of [-1, 1]) { const lx = sx * (w / 2 - 0.5), legH = -h / 2 - y0; grp.add(box(0.12, legH, 0.12, legM, lx, y0 + legH / 2, -0.08), box(0.03, legH, 0.03, legE, lx, y0 + legH / 2, -0.01), box(0.5, 0.06, 0.4, legM, lx, y0 + 0.03, -0.08)); }
      noPick(grp);
      return { grp, canvas, ctx: canvas.getContext("2d"), tex: t, w, h, dots, sig: "", nodes: [], edges: [] };
    };
    const mission = mk(bw, bh); mission.grp.position.set(L * 0.04, H * 0.55, -L + off); mission.grp.rotation.y = turn; world.add(mission.grp);
    const flow = mk(bw, bh); flow.grp.position.set(-L + off, H * 0.55, -L * 0.04); flow.grp.rotation.y = Math.PI / 2 - turn; world.add(flow.grp);
    return { mission, flow };
  }

  function paintMission() {
    const b = boards.mission, st = host.getState(), g = st?.goal;
    const sig = JSON.stringify([g?.objective, g?.requirements, g?.progress, g?.status, pal.light]);
    if (b.sig === sig) return; b.sig = sig;
    const x = b.ctx, W = b.canvas.width, H = b.canvas.height, pad = 80;
    bg(x, W, H);
    const teal = "#" + pal.teal.getHexString(), amber = "#" + pal.amber.getHexString(), ink = "#eef6fa", mute = "rgba(205,225,235,0.62)";
    x.textBaseline = "alphabetic"; x.textAlign = "left";
    x.fillStyle = teal; x.font = `600 46px ${FONT}`; spaced(x, "DONE MEANS", pad, pad + 24, 7);
    const lines = [];
    if (!g) { x.fillStyle = mute; x.font = `48px ${FONT}`; x.fillText("No goal yet. Give the room one and its checklist appears here.", pad, pad + 140); }
    else {
      x.fillStyle = ink; x.font = `600 80px ${FONT}`;
      wrapPx(x, g.objective, W - pad * 2 - 420, 2).forEach((ln, i) => x.fillText(ln, pad, pad + 130 + i * 90));
      // progress ring, top right
      const cx = W - pad - 150, cy = pad + 120, r = 110;
      x.lineWidth = 26; x.strokeStyle = "rgba(255,255,255,0.1)"; x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.stroke();
      x.strokeStyle = teal; x.shadowColor = teal; x.shadowBlur = 24; x.beginPath(); x.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * g.progress); x.stroke(); x.shadowBlur = 0;
      x.fillStyle = ink; x.font = `600 64px ${FONT}`; x.textAlign = "center"; x.fillText(`${Math.round(g.progress * 100)}%`, cx, cy + 22);
      const met = g.requirements.filter((r2) => r2.status === "met").length;
      x.fillStyle = mute; x.font = `40px ${FONT}`; x.fillText(g.requirements.length ? `${met} of ${g.requirements.length} met` : g.status, cx, cy + r + 64); x.textAlign = "left";
      const reqs = g.requirements, shown = reqs.length > 6 ? reqs.slice(0, 5) : reqs, cols = shown.length > 3 ? 2 : 1, per = Math.ceil(shown.length / cols);
      const top = pad + 360, colW = (W - pad * 2) / cols, rowH = Math.min(190, (H - top - pad) / Math.max(1, per)), fs = 54;
      shown.forEach((rq, k) => {
        const X = pad + Math.floor(k / per) * colW, Y = top + (k % per) * rowH, rr = 30, cy2 = Y + 8;
        const c = rq.status === "met" ? teal : rq.status === "unmet" ? amber : "rgba(205,225,235,0.55)";
        x.lineWidth = 6; x.strokeStyle = c;
        if (rq.status === "met") { x.fillStyle = teal; x.shadowColor = teal; x.shadowBlur = 18; x.beginPath(); x.arc(X + rr, cy2, rr, 0, TAU); x.fill(); x.shadowBlur = 0; x.strokeStyle = "#04212a"; x.lineWidth = 8; x.lineCap = "round"; x.lineJoin = "round"; x.beginPath(); x.moveTo(X + rr * 0.5, cy2); x.lineTo(X + rr * 0.88, cy2 + rr * 0.38); x.lineTo(X + rr * 1.55, cy2 - rr * 0.42); x.stroke(); }
        else { x.beginPath(); x.arc(X + rr, cy2, rr, 0, TAU); x.stroke(); if (rq.status === "unmet") { x.fillStyle = amber; x.fillRect(X + rr - 4, cy2 - 15, 8, 18); x.fillRect(X + rr - 4, cy2 + 8, 8, 8); } }
        x.fillStyle = rq.status === "met" ? mute : ink; x.font = `${fs}px ${FONT}`;
        wrapPx(x, rq.text, colW - rr * 2 - 70, 2).forEach((ln, li) => x.fillText(ln, X + rr * 2 + 26, cy2 + 18 + li * (fs + 8)));
        lines.push(rq.text);
      });
      if (reqs.length > shown.length) { x.fillStyle = mute; x.font = `${fs}px ${FONT}`; x.fillText(`+${reqs.length - shown.length} more`, pad + (cols - 1) * colW + 78, top + per * rowH); }
    }
    dbg.board = lines; b.tex.needsUpdate = true;
  }
  function bg(x, W, H) {
    const gr = x.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, pal.screen); gr.addColorStop(1, "#04090f");
    x.fillStyle = gr; x.fillRect(0, 0, W, H);
    x.strokeStyle = "rgba(45,226,208,0.16)"; x.lineWidth = 2;
    for (let y = 0; y < H; y += 6) { x.globalAlpha = 0.07; x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke(); }
    x.globalAlpha = 1;
  }
  function spaced(x, s, X, Y, gap) { let cx = X; for (const ch of s) { x.fillText(ch, cx, Y); cx += x.measureText(ch).width + gap; } }

  const NODE_STYLE = {
    done: ["--o-teal", "done"], assigned: ["--o-working", "in progress"], running: ["--o-working", "in progress"], revising: ["--o-red", "revising"],
    review: ["--o-judge", "in review"], pending: ["--o-idle", "next"], waiting: ["--o-amber", "waiting for you"], failed: ["--o-red", "failed"], cancelled: ["--o-off", "cancelled"],
  };
  function paintFlow() {
    const b = boards.flow, st = host.getState(), tasks = st?.goal?.tasks || [];
    const sig = JSON.stringify([tasks, st?.agents.map((a) => [a.id, a.name, a.color]), pal.light]);
    if (b.sig === sig) return; b.sig = sig;
    for (const o of [...b.dots.children]) { b.dots.remove(o); dispose(o); }
    b.pulses = [];
    const x = b.ctx, W = b.canvas.width, H = b.canvas.height, pad = 80;
    bg(x, W, H);
    const teal = "#" + pal.teal.getHexString(), ink = "#eef6fa", mute = "rgba(205,225,235,0.62)";
    x.textBaseline = "alphabetic"; x.textAlign = "left";
    x.fillStyle = teal; x.font = `600 46px ${FONT}`; spaced(x, "TASK FLOW", pad, pad + 24, 7);
    const done = tasks.filter((t) => t.status === "done").length, moving = tasks.filter((t) => ACTIVE_TASK.has(t.status) || t.status === "review").length;
    x.fillStyle = mute; x.font = `42px ${FONT}`; x.textAlign = "right";
    x.fillText(tasks.length ? `${done} done · ${moving} in progress · ${tasks.length - done - moving} to go` : "", W - pad, pad + 24); x.textAlign = "left";
    b.nodes = []; b.edges = [];
    if (!tasks.length) { x.fillStyle = mute; x.font = `48px ${FONT}`; x.fillText(st?.goal ? "The plan's tasks appear here once it is approved." : "No goal yet.", pad, pad + 160); b.tex.needsUpdate = true; return; }
    const n = tasks.length, rows = n <= 4 ? 1 : n <= 10 ? 2 : 3, cols = Math.ceil(n / rows);
    const top = pad + 110, cellW = (W - pad * 2) / cols, cellH = (H - top - pad / 2) / rows;
    const pos = new Map();
    tasks.forEach((t, k) => { // plan order, snaking so consecutive tasks stay next to each other
      const r = Math.floor(k / cols), c0 = k % cols, c = r % 2 ? cols - 1 - c0 : c0;
      pos.set(t.id, { x: pad + cellW * (c + 0.5), y: top + cellH * r + 64, t });
    });
    const R = Math.min(52, cellW * 0.16);
    // connectors: the plan's dependencies, else plan order
    const edges = [];
    tasks.forEach((t, k) => {
      const deps = (t.dependsOn || []).filter((d) => pos.has(d));
      if (deps.length) for (const d of deps) edges.push([d, t.id, true]); else if (k > 0) edges.push([tasks[k - 1].id, t.id, false]);
    });
    for (const [a, bId, real] of edges) {
      const A = pos.get(a), B = pos.get(bId), live = (ACTIVE_TASK.has(B.t.status) || B.t.status === "review") && A.t.status === "done";
      x.lineWidth = live ? 8 : 5; x.setLineDash(real ? [] : [14, 12]);
      x.strokeStyle = A.t.status === "done" ? (live ? "#" + pal.working.getHexString() : teal) : "rgba(205,225,235,0.28)";
      const pts = edgePath(A, B, R);
      x.beginPath(); x.moveTo(pts[0].x, pts[0].y); x.bezierCurveTo(pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y); x.stroke();
      if (live) b.edges.push(pts);
    }
    x.setLineDash([]);
    for (const { x: cx, y: cy, t } of pos.values()) {
      const [v, word] = NODE_STYLE[t.status] || NODE_STYLE.pending, c = cssVar(v);
      x.lineWidth = 8; x.strokeStyle = c; x.fillStyle = t.status === "done" ? c : pal.screen;
      x.shadowColor = c; x.shadowBlur = t.status === "pending" ? 0 : 26;
      x.beginPath(); x.arc(cx, cy, R, 0, TAU); x.fill(); x.stroke(); x.shadowBlur = 0;
      if (t.status === "done") { x.strokeStyle = "#04212a"; x.lineWidth = 10; x.lineCap = "round"; x.beginPath(); x.moveTo(cx - R * 0.42, cy + 2); x.lineTo(cx - R * 0.08, cy + R * 0.36); x.lineTo(cx + R * 0.48, cy - R * 0.34); x.stroke(); }
      else if (t.status === "failed" || t.status === "revising") { x.strokeStyle = c; x.lineWidth = 9; x.lineCap = "round"; x.beginPath(); x.moveTo(cx - R * 0.35, cy - R * 0.35); x.lineTo(cx + R * 0.35, cy + R * 0.35); x.moveTo(cx + R * 0.35, cy - R * 0.35); x.lineTo(cx - R * 0.35, cy + R * 0.35); x.stroke(); }
      else if (t.status !== "pending") { x.fillStyle = c; x.beginPath(); x.arc(cx, cy, R * 0.38, 0, TAU); x.fill(); }
      x.textAlign = "center"; x.fillStyle = ink; x.font = `600 50px ${FONT}`;
      wrapPx(x, t.title, cellW - 24, 2).forEach((ln, i) => x.fillText(ln, cx, cy + R + 62 + i * 58));
      const who = host.agentById(t.assignee);
      x.font = `42px ${FONT}`; x.fillStyle = c; x.fillText(clipPx(x, `${word}${who ? ` · ${who.name}` : ""}`, cellW - 24), cx, cy + R + 180);
      x.textAlign = "left";
      b.nodes.push({ id: t.id, x: cx, y: cy, status: t.status, R });
    }
    b.tex.needsUpdate = true;
    // moving dots along the live connectors, and a pulse on each node in progress (sprites over the board, so the canvas is never redrawn for them)
    const toLocal = (p) => new T.Vector3((p.x / W - 0.5) * b.w, (0.5 - p.y / H) * b.h, 0);
    b.edges = b.edges.map((pts) => {
      const curve = new T.CubicBezierCurve3(...pts.map(toLocal));
      const sprites = [0, 1, 2].map(() => { const s = glow(pal.working, 0.32, 0.95); b.dots.add(s); return s; });
      return { curve, sprites };
    });
    b.pulses = b.nodes.filter((nd) => ACTIVE_TASK.has(nd.status) || nd.status === "review").map((nd) => {
      const s = glow(new T.Color(cssVar((NODE_STYLE[nd.status] || NODE_STYLE.pending)[0])), (nd.R / W) * b.w * 4, 0.6, ringTex); s.position.copy(toLocal(nd)); b.dots.add(s); return s;
    });
  }
  function edgePath(A, B, R) {
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const p0 = { x: A.x + ux * (R + 6), y: A.y + uy * (R + 6) }, p3 = { x: B.x - ux * (R + 6), y: B.y - uy * (R + 6) };
    const horiz = Math.abs(dx) > Math.abs(dy);
    return [p0, horiz ? { x: (p0.x + p3.x) / 2, y: p0.y } : { x: p0.x, y: (p0.y + p3.y) / 2 }, horiz ? { x: (p0.x + p3.x) / 2, y: p3.y } : { x: p3.x, y: (p0.y + p3.y) / 2 }, p3];
  }

  // ---------- the pedestal: the goal as a hologram, with a ring that turns and an arc for its progress
  function buildPedestal() {
    const g = new T.Group();
    const metalM = lam(pal.metal);
    g.add(mesh(new T.CylinderGeometry(1.45, 1.6, 0.32, 40), metalM, 0, 0.16, 0), mesh(new T.CylinderGeometry(1.15, 1.3, 0.18, 40), lam(pal.desk), 0, 0.41, 0));
    const tealB = basic(pal.teal.clone());
    g.add(mesh(new T.TorusGeometry(1.52, 0.03, 6, 64), tealB, 0, 0.33, 0).rotateX(Math.PI / 2), mesh(new T.TorusGeometry(1.2, 0.025, 6, 64), tealB, 0, 0.5, 0).rotateX(Math.PI / 2));
    const disc = mesh(new T.CircleGeometry(1.1, 48), add(pal.teal.clone(), { map: softTex, opacity: 0.8 }), 0, 0.51, 0); disc.rotation.x = -Math.PI / 2; g.add(disc);
    g.add(pool(pal.teal, 6.5, pal.light ? 0.2 : 0.45));
    // the beam: an open cone that fades upward
    const beamMat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
      uniforms: { uColor: { value: pal.teal.clone() }, uTime: { value: 0 }, uAlpha: { value: pal.light ? 0.35 : 0.6 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "uniform vec3 uColor; uniform float uTime; uniform float uAlpha; varying vec2 vUv; void main(){ float f = pow(1.0 - vUv.y, 1.6); float s = 0.75 + 0.25 * sin(vUv.y * 40.0 - uTime * 3.0); gl_FragColor = vec4(uColor * f * s, f * uAlpha); \n#include <colorspace_fragment>\n }",
    });
    const beam = mesh(new T.CylinderGeometry(0.7, 1.05, 3.4, 40, 1, true), beamMat, 0, 2.2, 0); g.add(beam);
    // rising sparks inside the beam (positions move in the shader: no work per frame)
    const N = 70, pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let k = 0; k < N; k++) { const a = Math.random() * TAU, r = Math.random() * 0.85; pos[k * 3] = Math.cos(a) * r; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = Math.sin(a) * r; seed[k] = Math.random(); }
    const pg = new T.BufferGeometry(); pg.setAttribute("position", new T.BufferAttribute(pos, 3)); pg.setAttribute("seed", new T.BufferAttribute(seed, 1));
    const sparkMat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: pal.teal.clone().lerp(new T.Color(0xffffff), 0.35) }, uScale: { value: 30 }, uMap: { value: glowTex } },
      vertexShader: "attribute float seed; uniform float uTime; uniform float uScale; varying float vA; void main(){ float h = fract(seed + uTime * (0.08 + seed * 0.07)); vec3 p = position; p.y = 0.5 + h * 3.6; p.xz *= (1.0 - h * 0.35); vA = sin(h * 3.14159); vec4 mv = modelViewMatrix * vec4(p,1.0); gl_PointSize = uScale * (0.5 + seed); gl_Position = projectionMatrix * mv; }",
      fragmentShader: "uniform vec3 uColor; uniform sampler2D uMap; varying float vA; void main(){ vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(uColor * t.a * vA, t.a * vA); \n#include <colorspace_fragment>\n }",
    });
    const sparks = new T.Points(pg, sparkMat); g.add(sparks);
    // the turning ring, the progress arc and a wire core
    const ring = new T.Group(); ring.position.y = 2.6; g.add(ring);
    const r1 = mesh(new T.TorusGeometry(1.0, 0.022, 6, 80), basic(pal.teal.clone())); r1.rotation.x = Math.PI / 2.3; ring.add(r1);
    const ticks = new T.Group(); ring.add(ticks);
    for (let k = 0; k < 24; k++) { const a = (k / 24) * TAU; const tk = box(0.025, 0.12, 0.025, basic(pal.teal.clone()), Math.cos(a) * 1.0, 0, Math.sin(a) * 1.0); ticks.add(tk); }
    ticks.rotation.x = Math.PI / 2.3 - Math.PI / 2;
    const arcM = basic(pal.green.clone());
    const arcHolder = new T.Group(); arcHolder.position.y = 1.15; g.add(arcHolder);
    const coreM = new T.LineBasicMaterial({ color: pal.teal.clone().lerp(new T.Color(0xffffff), 0.3), transparent: true, opacity: 0.9 });
    const coreG = new T.Group(); coreG.position.y = 2.6; g.add(coreG);
    coreG.add(new T.LineSegments(new T.EdgesGeometry(new T.IcosahedronGeometry(0.5, 0)), coreM), new T.LineSegments(new T.EdgesGeometry(new T.IcosahedronGeometry(0.3, 0)), coreM));
    coreG.add(glow(pal.teal, 2.4, 0.55));
    noPick(g); world.add(g);
    return { group: g, beamMat, sparkMat, ring, coreG, arcHolder, arcM, arcSig: -1, disc };
  }
  function setProgressArc() {
    const pr = host.getState()?.goal?.progress ?? 0;
    if (pedestal.arcSig === pr) return; pedestal.arcSig = pr;
    for (const o of [...pedestal.arcHolder.children]) { pedestal.arcHolder.remove(o); o.geometry.dispose(); }
    const base = mesh(new T.TorusGeometry(1.32, 0.02, 4, 90), basic(pal.teal.clone().multiplyScalar(0.35))); base.rotation.x = Math.PI / 2; pedestal.arcHolder.add(base);
    if (pr > 0) { const arc = mesh(new T.TorusGeometry(1.32, 0.05, 6, 90, TAU * pr), pedestal.arcM); arc.rotation.x = Math.PI / 2; arc.rotation.z = Math.PI / 2; pedestal.arcHolder.add(arc); }
  }

  // ---------- the door, with a beacon that turns amber while approvals wait
  function buildDoor() {
    const { L } = lay, g = new T.Group(); g.position.set(L - 1.7, 0, -L + 0.08);
    const metalM = lam(pal.metal), frameM = basic(pal.teal.clone().multiplyScalar(0.7));
    g.add(box(1.5, 2.7, 0.08, metalM, 0, 1.35, 0), box(1.3, 2.55, 0.06, lam(pal.desk), 0, 1.28, 0.06));
    g.add(box(1.56, 0.04, 0.04, frameM, 0, 2.72, 0.08), box(0.04, 2.72, 0.04, frameM, -0.78, 1.36, 0.08), box(0.04, 2.72, 0.04, frameM, 0.78, 1.36, 0.08));
    const lensM = basic(pal.idle.clone());
    const lamp = mesh(new T.SphereGeometry(0.16, 16, 10, 0, TAU, 0, Math.PI / 2), lensM, 0, 2.86, 0.12); g.add(lamp, box(0.4, 0.08, 0.2, metalM, 0, 2.82, 0.1));
    const beamM = add(pal.amber.clone(), { map: softTex, opacity: 0, side: T.DoubleSide });
    const beam = new T.Group(); beam.position.set(0, 2.95, 0.12); g.add(beam);
    for (const r of [0, Math.PI / 2]) { const pl = mesh(new T.PlaneGeometry(2.4, 0.35), beamM, 1.1, 0, 0); const h = new T.Group(); h.rotation.y = r; h.add(pl); beam.add(h); }
    const halo = glow(pal.amber, 2.6, 0); halo.position.set(0, 2.95, 0.2); g.add(halo);
    const floorPool = pool(pal.amber, 3.2, 0); floorPool.position.set(0, 0.015, 1.1); g.add(floorPool);
    noPick(g); world.add(g);
    return { group: g, lensM, beam, beamM, halo, floorPool, count: 0, anchor: new T.Vector3(L - 1.7, 3.5, -L + 0.4), mouth: new T.Vector3(L - 1.7, 0.4, -L + 1.0) };
  }

  // ---------- live trails on the floor: pedestal to each working agent, worker to the pedestal while judged, desk to the door while waiting
  const trailMat = (color) => new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uAlpha: { value: 0 }, uDir: { value: 1 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform vec3 uColor; uniform float uTime; uniform float uAlpha; uniform float uDir; varying vec2 vUv; void main(){ float u = uDir > 0.0 ? vUv.x : 1.0 - vUv.x; float d = fract(u * 2.5 - uTime * 0.8); float pulse = smoothstep(0.0, 0.06, d) * (1.0 - smoothstep(0.06, 0.38, d)); float edge = 1.0 - abs(vUv.y - 0.5) * 2.0; float a = (0.4 + 1.6 * pulse) * uAlpha * (smoothstep(0.0, 0.5, edge) + 0.6 * smoothstep(0.75, 1.0, edge)); gl_FragColor = vec4(uColor * a, a); \n#include <colorspace_fragment>\n }",
  });
  function ribbon(curve, width, mat) {
    // a flat strip on the floor along the curve; uv.x runs along it, uv.y across it
    const N = 64, pos = new Float32Array((N + 1) * 2 * 3), uv = new Float32Array((N + 1) * 2 * 2), idx = [];
    const p = new T.Vector3(), tng = new T.Vector3(), side = new T.Vector3(), up = new T.Vector3(0, 1, 0);
    for (let k = 0; k <= N; k++) {
      const u = k / N; curve.getPoint(u, p); curve.getTangent(u, tng); side.crossVectors(up, tng).normalize().multiplyScalar(width / 2);
      pos.set([p.x + side.x, 0.03, p.z + side.z, p.x - side.x, 0.03, p.z - side.z], k * 6); uv.set([u, 0, u, 1], k * 4);
      if (k < N) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3)); geo.setAttribute("uv", new T.BufferAttribute(uv, 2)); geo.setIndex(idx);
    const m = new T.Mesh(geo, mat); m.raycast = () => {}; m.frustumCulled = false; return m;
  }
  function floorCurve(a, b, bend = 0.18) {
    const mid = a.clone().add(b).multiplyScalar(0.5), dir = b.clone().sub(a); const perp = new T.Vector3(-dir.z, 0, dir.x).multiplyScalar(bend);
    return new T.QuadraticBezierCurve3(new T.Vector3(a.x, 0, a.z), mid.add(perp).setY(0), new T.Vector3(b.x, 0, b.z));
  }
  function buildTrails(d) {
    const deskFront = deskPoint(d, 0, 0, -0.75), toCenter = deskFront.clone().normalize().multiplyScalar(1.75);
    const toDesk = ribbon(floorCurve(toCenter, deskFront, 0.12), 0.34, trailMat(d.neon)); world.add(toDesk);
    const toDoor = ribbon(floorCurve(deskPoint(d, 0.4, 0, 1.4), door.mouth, -0.22), 0.3, trailMat(pal.amber)); world.add(toDoor);
    d.trails = { toDesk, toDoor };
  }

  // =================================================================================================================
  // one-shot effects: a comet along an arc (assigned, sent to review, asking for approval), a burst (accepted), a red pulse (sent back)
  // =================================================================================================================
  function comet(from, to, color, dur = 1.25, lift = 2.2) {
    const mid = from.clone().add(to).multiplyScalar(0.5); mid.y = Math.max(from.y, to.y) + lift;
    const curve = new T.QuadraticBezierCurve3(from.clone(), mid, to.clone());
    const sprites = Array.from({ length: 12 }, (_, k) => { const s = glow(color, k === 0 ? 0.9 : 0.62 - k * 0.04, k === 0 ? 1 : 0.85 - k * 0.06); fx.add(s); return s; });
    const head = glow(new T.Color(0xffffff), 0.32, 1); fx.add(head);
    return { t0: -1, dur, step(t) {
      if (this.t0 < 0) this.t0 = t; const k = (t - this.t0) / this.dur;
      sprites.forEach((s, j) => { const u = clamp(ease(clamp(k, 0, 1)) - j * 0.025, 0, 1); curve.getPoint(u, s.position); s.material.opacity = s.userData.alpha * (k > 1 ? Math.max(0, 1 - (k - 1) * 4) : 1); });
      curve.getPoint(ease(clamp(k, 0, 1)), head.position); head.material.opacity = k > 1 ? 0 : 1;
      if (k > 1.25) { for (const s of [...sprites, head]) { fx.remove(s); s.material.dispose(); } return false; }
      return true;
    } };
  }
  function burst(at, color, { ring = true, sparks = 26, dur = 1.4, check = false } = {}) {
    const objs = [];
    const rm = mesh(new T.RingGeometry(0.55, 0.72, 48), add(color.clone(), { opacity: 1 }), at.x, 0.05, at.z); rm.rotation.x = -Math.PI / 2; if (ring) { fx.add(rm); objs.push(rm); }
    const rm2 = mesh(new T.RingGeometry(0.4, 0.5, 48), add(color.clone(), { opacity: 1 }), at.x, 0.06, at.z); rm2.rotation.x = -Math.PI / 2; if (ring) { fx.add(rm2); objs.push(rm2); }
    const parts = Array.from({ length: sparks }, (_, k) => {
      const s = glow(color, 0.34, 1); s.position.copy(at); const a = (k / sparks) * TAU + Math.random() * 0.3;
      s.userData.v = new T.Vector3(Math.cos(a) * (1.2 + Math.random()), 2.2 + Math.random() * 2.2, Math.sin(a) * (1.2 + Math.random())); fx.add(s); return s;
    });
    let mark = null;
    if (check) {
      const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
      x.strokeStyle = "#fff"; x.lineWidth = 16; x.lineCap = "round"; x.lineJoin = "round"; x.shadowColor = "#fff"; x.shadowBlur = 12;
      x.beginPath(); x.moveTo(30, 66); x.lineTo(54, 90); x.lineTo(100, 38); x.stroke();
      mark = new T.Sprite(new T.SpriteMaterial({ map: tex(c), color, transparent: true, depthWrite: false, blending: T.AdditiveBlending })); mark.scale.setScalar(0.9); mark.position.copy(at).setY(2.4); fx.add(mark);
    }
    const flash = glow(color, 3.2, 0.9); flash.position.copy(at).setY(1.2); fx.add(flash);
    return { t0: -1, dur, last: 0, step(t) {
      if (this.t0 < 0) { this.t0 = t; this.last = t; } const k = (t - this.t0) / this.dur, dt = Math.min(0.1, t - this.last); this.last = t;
      rm.scale.setScalar(1 + ease(clamp(k, 0, 1)) * 2.4); rm.material.opacity = Math.max(0, 1 - k);
      rm2.scale.setScalar(1 + ease(clamp(k * 1.4, 0, 1)) * 1.4); rm2.material.opacity = Math.max(0, 0.8 - k);
      for (const s of parts) { s.userData.v.y -= 5.5 * dt; s.position.addScaledVector(s.userData.v, dt); s.material.opacity = Math.max(0, 1 - k); }
      flash.material.opacity = Math.max(0, 0.9 * (1 - k * 2.2));
      if (mark) { mark.position.y = 2.4 + k * 0.8; mark.material.opacity = k < 0.7 ? 1 : Math.max(0, 1 - (k - 0.7) * 3.3); }
      if (k >= 1) { for (const o of [...objs, ...parts, flash, ...(mark ? [mark] : [])]) { fx.remove(o); dispose(o); } return false; }
      return true;
    } };
  }
  function effect(e) {
    if (!desks.size || host.lowPower()) return; // low power: the state change itself is drawn; no animation
    const d = (id) => desks.get(id), top = (dd) => deskPoint(dd, -0.2, 1.75, -0.2), feet = (dd) => deskPoint(dd, 0, 0.1, 0.4);
    const core0 = new T.Vector3(0, 2.6, 0);
    if (e.kind === "assign" && d(e.to)) { effects.push(comet(core0, top(d(e.to)), d(e.to).neon)); flashDesk(d(e.to), d(e.to).neon, 0.6); }
    else if (e.kind === "review" && d(e.from)) { const target = e.to && d(e.to) ? top(d(e.to)) : core0.clone(); effects.push(comet(top(d(e.from)), target, pal.judge, 1.35)); }
    else if (e.kind === "accept" && d(e.at)) { effects.push(burst(feet(d(e.at)), pal.green, { check: true })); flashDesk(d(e.at), pal.green, 1); }
    else if ((e.kind === "sendback" || e.kind === "fail") && d(e.at)) { effects.push(burst(feet(d(e.at)), pal.red, { sparks: 0, dur: 1.1 })); flashDesk(d(e.at), pal.red, 1.4); }
    else if (e.kind === "approval" && d(e.from)) { effects.push(comet(top(d(e.from)), door.anchor.clone().setY(3.0), pal.amber, 1.4, 1.6)); door.flash = 1; }
    else return;
    host.invalidate(1800);
  }
  function flashDesk(d, color, strength) { d.flash = strength; d.flashCol.copy(color); }

  // =================================================================================================================
  // labels: one card per agent, just over its head: name and role, the status chip under them (live state, what it is about, a progress
  // ring when the hub knows), and a leader line down to the head. DOM, so text stays crisp.
  // =================================================================================================================
  const SVGNS = "http://www.w3.org/2000/svg";
  const HEAD_TOP = 2.2; // desk-local height of the top of a seated agent's head
  const MAX_SHIFT = 46; // a card moves at most this far (px) from its head to make room
  let cardHover = "";
  function label(k, make) { let el = labelEls.get(k); if (!el) { el = make(); labelsEl.append(el); labelEls.set(k, el); el._w = 0; } return el; }
  function makeCard(id) {
    const el = document.createElement("div"); el.className = "lbl card"; el.dataset.agent = id;
    const tag = document.createElement("button"); tag.type = "button"; tag.className = "tag";
    tag.innerHTML = '<span class="sw"></span><b class="nm"></b><i class="role"></i>';
    const chip = document.createElement("button"); chip.type = "button"; chip.className = "chip";
    const ring = document.createElementNS(SVGNS, "svg"); ring.setAttribute("viewBox", "0 0 20 20"); ring.setAttribute("class", "ring");
    const bgc = document.createElementNS(SVGNS, "circle"); bgc.setAttribute("cx", "10"); bgc.setAttribute("cy", "10"); bgc.setAttribute("r", "7.5"); bgc.setAttribute("class", "rb");
    const fg = document.createElementNS(SVGNS, "circle"); fg.setAttribute("cx", "10"); fg.setAttribute("cy", "10"); fg.setAttribute("r", "7.5"); fg.setAttribute("class", "rf"); fg.setAttribute("pathLength", "100");
    ring.append(bgc, fg);
    const txt = document.createElement("span"); txt.className = "txt"; txt.innerHTML = '<b class="st"></b><span class="tk"></span>';
    chip.append(ring, txt);
    const lead = document.createElement("span"); lead.className = "lead";
    el.append(tag, chip, lead);
    tag.onclick = () => host.onSelect(id);
    chip.onclick = () => host.onSelect(id);
    el.addEventListener("mouseenter", () => { cardHover = id; host.invalidate(); });
    el.addEventListener("mouseleave", () => { if (cardHover === id) cardHover = ""; host.invalidate(); });
    return el;
  }
  /** Measures a card both ways (full, and the name pill it shrinks to when crowded or over a board). Only when its content changes. */
  function measureCard(el) {
    el.classList.remove("compact"); el._full = { w: el.offsetWidth, h: el.offsetHeight };
    el.classList.add("compact"); el._mini = { w: el.offsetWidth, h: el.offsetHeight };
    el.classList.toggle("compact", !!el._compact);
  }
  function updateLabels() {
    const st = host.getState(), live = new Set();
    for (const d of desks.values()) {
      const a = d.agent, k = `d:${a.id}`; live.add(k);
      const el = label(k, () => makeCard(a.id));
      el.classList.remove(...[...el.classList].filter((c) => c.startsWith("st-"))); el.classList.add(`st-${a.state}`); el.classList.toggle("sel", selected === a.id);
      el.style.setProperty("--agent", "#" + d.neon.getHexString());
      el.querySelector(".nm").textContent = a.name;
      el.querySelector(".role").textContent = a.role || "";
      el.querySelector(".st").textContent = host.stateWord(a) + (a.helpers.length ? ` · ${a.helpers.length} helper${a.helpers.length > 1 ? "s" : ""}` : "");
      const tk = host.chipText(a); el.querySelector(".tk").textContent = tk; el.querySelector(".tk").hidden = !tk;
      const p = a.task?.progress, fg = el.querySelector(".rf");
      el.querySelector(".ring").classList.toggle("none", p === undefined);
      fg.setAttribute("stroke-dasharray", `${Math.round((p ?? 0) * 100)} 100`);
      el.querySelector(".tag").setAttribute("aria-label", `${a.name}${a.role ? `, ${a.role}` : ""}: ${host.stateWord(a)}. Show details.`);
      el.querySelector(".chip").setAttribute("aria-label", `${a.name}: ${host.stateWord(a)}${tk ? `, ${tk}` : ""}${p !== undefined ? `, ${Math.round(p * 100)}%` : ""}. Show details.`);
      el._w = 0; // measure again
      if (d.overflow) { const mk = `m:${a.id}`; live.add(mk); const m = label(mk, () => { const s = document.createElement("div"); s.className = "lbl more"; return s; }); m.textContent = `+${d.overflow}`; }
    }
    if (st?.goal) {
      live.add("goal");
      const g = label("goal", () => { const s = document.createElement("div"); s.className = "lbl goal"; s.innerHTML = '<b class="gt"></b><span class="gp"></span>'; return s; });
      g.querySelector(".gt").textContent = st.goal.title || st.goal.objective;
      const met = st.goal.requirements.filter((r) => r.status === "met").length;
      g.querySelector(".gp").textContent = `${Math.round(st.goal.progress * 100)}%${st.goal.requirements.length ? ` · ${met} of ${st.goal.requirements.length} met` : ""}`;
      g._w = 0;
    }
    live.add("door");
    const del = label("door", () => { const s = document.createElement("div"); s.className = "lbl door"; s.dataset.door = "1"; return s; });
    const n = st?.pendingApprovals || 0;
    del.textContent = n ? `${n} approval${n > 1 ? "s" : ""} waiting` : "No approvals waiting"; del.classList.toggle("lit", n > 0); del._w = 0;
    for (const [k, el] of labelEls) if (!live.has(k)) { el.remove(); labelEls.delete(k); }
  }

  /** The boards' faces on screen, as quadrilaterals, so cards can keep off their text. */
  function boardQuads(proj) {
    if (!boards) return [];
    return [boards.mission, boards.flow].map((b) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => proj(b.grp.localToWorld(tmp2.set((sx * b.w) / 2, (sy * b.h) / 2, 0)))));
  }
  const inQuad = (q, x, y) => { let s = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x); if (c !== 0) { if (s && Math.sign(c) !== s) return false; s = Math.sign(c); } } return true; };
  /** Does the box (left, top, right, bottom) touch a board's face? */
  function onBoard(quads, l, t, r, b) {
    for (const q of quads) {
      for (const [x, y] of [[l, t], [r, t], [l, b], [r, b], [(l + r) / 2, t], [(l + r) / 2, b], [l, (t + b) / 2], [r, (t + b) / 2], [(l + r) / 2, (t + b) / 2]]) if (inQuad(q, x, y)) return true;
      if (q.some((p) => p.x >= l && p.x <= r && p.y >= t && p.y <= b)) return true;
    }
    return false;
  }
  const overlap = (A, B, pad = 4) => Math.min(A.x + A.w / 2, B.x + B.w / 2) - Math.max(A.x - A.w / 2, B.x - B.w / 2) > -pad && Math.min(A.y, B.y) - Math.max(A.y - A.h, B.y - B.h) > -pad;

  /**
   * Each card sits just over its agent's head. Crowded cards move up a little (never more than MAX_SHIFT) or shrink to the name pill;
   * a card over a board's face shrinks to the pill unless it is selected or under the pointer.
   */
  function placeLabels() {
    const w = size.w, h = size.h, rect = canvas.getBoundingClientRect();
    const proj = (v) => { tmp.copy(v).project(camera); return { x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h }; };
    const measure = (el) => { if (!el._w) { el._w = el.offsetWidth; el._h = el.offsetHeight; } return el; };
    const quads = boardQuads(proj), cards = [], others = [];
    dbg.desks = []; dbg.helpers = []; dbg.cards = [];
    const PRI = { working: 2, waiting_approval: 2, judged: 2, idle: 1, offline: 0 };
    for (const d of desks.values()) {
      const el = labelEls.get(`d:${d.agent.id}`); if (!el) continue;
      if (!el._w) { measureCard(el); el._w = 1; }
      const head = proj(deskPoint(d, 0, HEAD_TOP, 0.9, tmp2)), hot = d.agent.id === selected || d.agent.id === hover || d.agent.id === cardHover;
      cards.push({ el, id: d.agent.id, ax: head.x, ay: head.y, x: head.x, y: head.y - 9, compact: false, hot, pri: hot ? 3 : PRI[d.agent.state] ?? 1 });
      const c = proj(deskPoint(d, 0, 0.95, 0.2, tmp2));
      dbg.desks.push({ agentId: d.agent.id, state: d.agent.state, x: rect.left + c.x, y: rect.top + c.y, helpers: d.helpers.length });
      d.helpers.forEach((hp) => { hp.group.getWorldPosition(tmp2); tmp2.y += 0.7; const q = proj(tmp2); dbg.helpers.push({ id: hp.data.id, parent: d.agent.id, agentId: hp.data.agentId, readOnly: hp.data.readOnly, state: hp.data.state, x: rect.left + q.x, y: rect.top + q.y }); });
      const m = labelEls.get(`m:${d.agent.id}`); if (m) { const q = proj(deskPoint(d, 2.0, 1.6, 0.4, tmp2)); others.push({ el: measure(m), x: q.x, y: q.y }); }
    }
    const gl = labelEls.get("goal");
    let goalBox = null;
    if (gl) { // over the hologram; lower, across the beam, if that would cover a board
      measure(gl); let q = proj(tmp2.set(0, 3.25, 0));
      if (onBoard(quads, q.x - gl._w / 2, q.y - gl._h, q.x + gl._w / 2, q.y)) q = proj(tmp2.set(0, 1.9, 0));
      goalBox = { el: gl, x: q.x, y: q.y }; others.push(goalBox);
    }
    const del = labelEls.get("door");
    if (del && door) { // over the door; lower down its front if that would cover a board
      measure(del); const near = (v) => { const p = proj(v); p.x = clamp(p.x, del._w / 2 + 6, w - del._w / 2 - 6); return p; };
      let q = near(door.anchor);
      for (const y of [2.0, 0.6]) if (onBoard(quads, q.x - del._w / 2, q.y - del._h, q.x + del._w / 2, q.y)) q = near(tmp2.copy(door.anchor).setY(y).setZ(door.anchor.z + 0.4));
      others.push({ el: del, x: q.x, y: q.y }); dbg.door = { count: door.count, x: rect.left + q.x, y: rect.top + q.y, lit: door.count > 0 };
    }
    for (const o of others) { o.w = o.el._w; o.h = o.el._h; o.x = clamp(o.x, o.w / 2 + 6, w - o.w / 2 - 6); o.y = clamp(o.y, o.h + 6, h - 4); o.fixed = true; o.pri = 9; o.ay = o.y + 9; }

    const size2 = (c) => { const s = c.compact ? c.el._mini : c.el._full; c.w = s.w; c.h = s.h; };
    const visible = [];
    for (const c of cards) {
      c.off = c.ax < -20 || c.ax > w + 20 || c.ay < -20 || c.ay > h + 80;
      if (c.el._off !== c.off) { c.el._off = c.off; c.el.style.visibility = c.off ? "hidden" : ""; }
      if (c.off) continue;
      size2(c);
      if (!c.hot && onBoard(quads, c.x - c.w / 2, c.y - c.h, c.x + c.w / 2, c.y)) { c.compact = true; size2(c); }
      visible.push(c);
    }
    // crowding: the less important card (or, equal, the one further back) gives way: up a little, then down to its name.
    // The goal's and the door's labels stay put; cards give way to them.
    visible.push(...others);
    visible.sort((a, b) => b.ay - a.ay); // front first: the front cards keep their place
    for (let pass = 0; pass < 6; pass++) {
      let moved = false;
      for (let i = 0; i < visible.length; i++) for (let j = 0; j < visible.length; j++) {
        if (i === j) continue;
        const A = visible[i], B = visible[j];
        if (!overlap(A, B)) continue;
        const mv = A.pri !== B.pri ? (A.pri < B.pri ? A : B) : (A.ay < B.ay ? A : B), fixd = mv === A ? B : A;
        const want = mv.y - (fixd.y - fixd.h) + 4; // move up so its bottom clears the other's top
        if (mv.fixed) continue;
        if (mv.ay - 9 - (mv.y - want) <= MAX_SHIFT && mv.y - want - mv.h > 4) { mv.y -= want; moved = true; }
        else if (!mv.compact && !mv.hot) { mv.compact = true; size2(mv); mv.y = mv.ay - 9; moved = true; }
        else if (!fixd.compact && !fixd.hot && !fixd.fixed) { fixd.compact = true; size2(fixd); moved = true; }
      }
      if (!moved) break;
    }
    // a card that moved up onto a board shrinks too
    for (let k = visible.length - 1; k >= 0; k--) if (visible[k].fixed) visible.splice(k, 1);
    for (const c of visible) if (!c.hot && !c.compact && onBoard(quads, c.x - c.w / 2, c.y - c.h, c.x + c.w / 2, c.y)) { c.compact = true; size2(c); }
    for (const c of visible) {
      const left = clamp(c.x - c.w / 2, 6, w - c.w - 6), top = c.y - c.h;
      if (c.el._compact !== c.compact) { c.el._compact = c.compact; c.el.classList.toggle("compact", c.compact); }
      const t = `translate(${left.toFixed(1)}px,${top.toFixed(1)}px)`;
      if (c.el.dataset.t !== t) { c.el.style.transform = t; c.el.dataset.t = t; }
      const lead = c.el.lastElementChild, lh = Math.max(4, c.ay - c.y), lx = clamp(c.ax - left, 8, c.w - 8);
      const ls = `${lh.toFixed(0)}|${lx.toFixed(0)}`;
      if (lead._s !== ls) { lead._s = ls; lead.style.height = `${lh.toFixed(0)}px`; lead.style.left = `${lx.toFixed(0)}px`; }
      dbg.cards.push({ agentId: c.id, compact: c.compact, x: rect.left + left + c.w / 2, top: rect.top + top, bottom: rect.top + c.y, headX: rect.left + c.ax, headY: rect.top + c.ay });
    }
    for (const o of others) {
      const t = `translate(${(o.x - o.w / 2).toFixed(1)}px,${(o.y - o.h).toFixed(1)}px)`;
      if (o.el.dataset.t !== t) { o.el.style.transform = t; o.el.dataset.t = t; }
    }
    dbg.boardQuads = quads.map((q) => q.map((p) => ({ x: rect.left + p.x, y: rect.top + p.y })));
  }

  // =================================================================================================================
  // building and applying state
  // =================================================================================================================
  function clearWorld() {
    for (const o of [...world.children]) { world.remove(o); dispose(o); }
    for (const o of [...fx.children]) { fx.remove(o); dispose(o); }
    effects.length = 0; desks = new Map();
  }
  function rebuild() {
    clearWorld(); readPalette();
    const st = host.getState(), agents = st?.agents || [];
    lay = layoutFor(Math.max(1, agents.length));
    buildRoom(); boards = buildBoards(); pedestal = buildPedestal(); door = buildDoor();
    agents.forEach((a, i) => { const d = buildDesk(a, i); desks.set(a.id, d); world.add(d.group); buildTrails(d); });
    structSig = agents.map((a) => a.id).join("|") + dbg.theme;
    apply(true); fitCamera(); host.invalidate(600);
  }
  function apply(fromRebuild = false) {
    const st = host.getState(); if (!st) return;
    if (!fromRebuild && st.agents.map((a) => a.id).join("|") + dbg.theme !== structSig) { rebuild(); return; }
    st.agents.forEach((a, i) => {
      let d = desks.get(a.id);
      if (d && d.sig !== deskSig(a)) {
        world.remove(d.group); dispose(d.group); for (const tr of Object.values(d.trails || {})) { world.remove(tr); dispose(tr); }
        d = buildDesk(a, i); desks.set(a.id, d); world.add(d.group); buildTrails(d);
      }
      d.agent = a;
      const ps = paintSigOf(a) + pal.light;
      if (d.paintSig !== ps) { d.paintSig = ps; paintMain(d); paintSide(d); }
    });
    door.count = st.pendingApprovals;
    paintMission(); paintFlow(); setProgressArc(); updateLabels();
  }

  // =================================================================================================================
  // camera: orthographic, isometric, a slow drift; drag to orbit a little, wheel or pinch to zoom, double-click to reset
  // =================================================================================================================
  const HOME = { az: Math.PI / 4, el: 0.64, zoom: 1 };
  // cx, cy centre the fitted room; px, py are the owner's pan (from zooming toward the pointer), in view units
  const view = { az: HOME.az, el: HOME.el, zoom: HOME.zoom, tAz: HOME.az, tEl: HOME.el, tZoom: HOME.zoom, drift: 0, userAt: -1e9, fit: 10, cx: 0, cy: 0, px: 0, py: 0, tpx: 0, tpy: 0 };
  const target = new T.Vector3(0, 1.4, 0);
  function placeCamera() {
    const az = view.az + view.drift, el = view.el, dist = 60;
    camera.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(az) * Math.cos(el) * dist);
    camera.lookAt(target);
    const aspect = size.w / size.h, half = view.fit / view.zoom;
    const ox = view.cx + view.px, oy = view.cy + view.py;
    camera.left = -half * aspect + ox; camera.right = half * aspect + ox; camera.top = half + oy; camera.bottom = -half + oy;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  }
  /** Finds the half-height that holds what matters: the ring of desks with the agents' heads and cards, the boards and the door. The floor's far tips and the top of the walls may be cut. */
  function fitCamera() {
    world.updateMatrixWorld(true);
    view.zoom = view.tZoom; view.px = view.tpx; view.py = view.tpy; view.cx = 0; view.cy = 0; view.fit = 10; placeCamera();
    const keepPx = view.px, keepPy = view.py; view.px = view.py = 0; placeCamera();
    const { R } = lay, ring = R + 2.7, pts = [];
    for (let k = 0; k < 24; k++) { const a = (k / 24) * TAU; pts.push(new T.Vector3(Math.sin(a) * ring, -0.6, Math.cos(a) * ring), new T.Vector3(Math.sin(a) * R, 4.2, Math.cos(a) * R)); }
    for (const b of boards ? [boards.mission, boards.flow] : []) for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) pts.push(b.grp.localToWorld(new T.Vector3((sx * b.w) / 2, (sy * b.h) / 2 + (sy > 0 ? 0.25 : 0), 0)));
    if (door) pts.push(door.anchor.clone().setY(door.anchor.y + 0.4));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const inv = camera.matrixWorldInverse;
    for (const p of pts) { p.applyMatrix4(inv); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const aspect = size.w / size.h, needH = (maxY - minY) / 2 * 1.04, needW = (maxX - minX) / 2 * 1.02;
    view.fit = Math.max(needH, needW / aspect);
    view.cx = (maxX + minX) / 2; view.cy = (maxY + minY) / 2;
    view.px = keepPx; view.py = keepPy;
    placeCamera();
  }
  function updateCamera(t, dt, still) {
    const k = still ? 1 : 1 - Math.exp(-dt * 6);
    const idle = t - view.userAt > 6 && !still;
    view.drift = idle ? Math.sin(t * 0.07) * 0.07 : view.drift * (1 - k);
    const moving = Math.abs(view.tAz - view.az) + Math.abs(view.tEl - view.el) + Math.abs(view.tZoom - view.zoom) + Math.abs(view.tpx - view.px) + Math.abs(view.tpy - view.py) > 1e-4;
    view.az += (view.tAz - view.az) * k; view.el += (view.tEl - view.el) * k; view.zoom += (view.tZoom - view.zoom) * k;
    view.px += (view.tpx - view.px) * k; view.py += (view.tpy - view.py) * k;
    placeCamera();
    return moving;
  }
  function resetView() { view.tAz = HOME.az; view.tEl = HOME.el; view.tZoom = HOME.zoom; view.tpx = view.tpy = 0; view.userAt = -1e9; host.invalidate(1200); }
  /** Zooms keeping the point under (clientX, clientY) where it is. */
  function zoomAt(z, clientX, clientY) {
    const r = canvas.getBoundingClientRect(), nx = ((clientX - r.left) / r.width) * 2 - 1, ny = -(((clientY - r.top) / r.height) * 2 - 1), aspect = size.w / size.h;
    const z2 = clamp(z, 0.7, 3), h1 = view.fit / view.tZoom, h2 = view.fit / z2;
    view.tpx += nx * aspect * (h1 - h2); view.tpy += ny * (h1 - h2); view.tZoom = z2;
    const lim = z2 <= 1 ? 0 : view.fit * (1 - 1 / z2); // never pan the room out of view
    view.tpx = clamp(view.tpx, -lim * aspect, lim * aspect); view.tpy = clamp(view.tpy, -lim, lim);
    view.userAt = performance.now() / 1000; host.invalidate(500);
  }

  // pointer: drag to orbit, pinch to zoom, click to select, double-click to reset
  const pointers = new Map(); let drag = null, pinch = 0;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture?.(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, az: view.tAz, el: view.tEl, moved: false };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y) / view.tZoom; drag = null; }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) { const [a, b] = [...pointers.values()]; zoomAt(Math.hypot(a.x - b.x, a.y - b.y) / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2); return; }
    if (drag && pointers.size === 1) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 5) drag.moved = true;
      if (drag.moved) { view.tAz = clamp(drag.az - dx * 0.005, HOME.az - 0.75, HOME.az + 0.75); view.tEl = clamp(drag.el + dy * 0.004, 0.3, 1.05); view.userAt = performance.now() / 1000; host.invalidate(400); }
      return;
    }
    if (e.pointerType !== "touch") { const id = pick(e.clientX, e.clientY); if (id !== hover) { hover = id; canvas.classList.toggle("hover", !!id); host.invalidate(); } }
  });
  const up = (e) => {
    const wasDrag = drag?.moved; pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0;
    if (pointers.size === 0) {
      if (drag && !wasDrag && e.type === "pointerup") host.onSelect(pick(e.clientX, e.clientY) || "");
      drag = null;
    }
  };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("dblclick", (e) => { e.preventDefault(); resetView(); });
  canvas.addEventListener("pointerleave", () => { hover = ""; canvas.classList.remove("hover"); });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(view.tZoom * Math.exp(-e.deltaY * 0.0012), e.clientX, e.clientY); }, { passive: false });

  function setPixelRatio() { renderer.setPixelRatio(host.lowPower() ? 1 : Math.min(window.devicePixelRatio || 1, 2)); }
  function resize() {
    const r = canvas.parentElement.getBoundingClientRect(); size = { w: Math.max(2, Math.round(r.width)), h: Math.max(2, Math.round(r.height)) };
    setPixelRatio(); renderer.setSize(size.w, size.h, false); fitCamera();
    for (const el of labelEls.values()) el._w = 0;
    host.invalidate();
  }

  // =================================================================================================================
  // a frame
  // =================================================================================================================
  /** "active": something is happening (agents working, an effect, the camera moving); "ambient": only the idle drift; "none": nothing to draw. */
  function level() {
    const st = host.getState(); if (!st) return "none";
    if (effects.length) return "active";
    if (st.pendingApprovals > 0 || st.agents.some((a) => a.state === "working" || a.state === "waiting_approval" || a.state === "judged" || a.helpers.some((h) => h.state !== "idle"))) return "active";
    return "ambient";
  }
  function draw(t, dt, still) {
    const camMoving = updateCamera(t, dt, still);
    pedestal.ring.rotation.y = still ? 0 : t * 0.35; pedestal.coreG.rotation.set(still ? 0 : t * 0.3, still ? 0 : t * 0.45, 0);
    pedestal.beamMat.uniforms.uTime.value = t; pedestal.sparkMat.uniforms.uTime.value = still ? 0.3 : t; pedestal.sparkMat.uniforms.uScale.value = 16 * renderer.getPixelRatio() * Math.max(1, size.h / 700);
    for (const d of desks.values()) {
      const a = d.agent, st = a.state, off = st === "offline", pulse = 0.5 + 0.5 * Math.sin(t * 4 + d.phase);
      pose(d.fig, st, t, dt, d.phase, still);
      // monitors: off when the agent is; a flicker and a scrolling log while it types
      const typing = st === "working" && !still;
      const lum = off ? 0.06 : typing ? 0.9 + 0.1 * Math.sin(t * 31 + d.phase) * Math.sin(t * 7.3) : st === "idle" ? 0.62 : 0.95;
      for (const s of [d.screens.head, d.screens.log, d.screens.side]) s.mat.color.setScalar(lum);
      if (typing && d.screens.log.count) d.screens.log.tex.offset.y = -((t * 0.045 + d.phase) % 1);
      d.screenGlow.material.opacity = off ? 0 : (st === "idle" ? 0.12 : 0.24) * (typing ? 0.85 + 0.3 * pulse : 1);
      d.keys.material.color.copy(d.neon).multiplyScalar(off ? 0.05 : typing ? 0.35 + 0.35 * pulse : 0.25);
      d.led.material.color.copy(stateColor(st)).multiplyScalar(off ? 0.25 : st === "working" ? 0.7 + 0.3 * pulse : 1);
      d.floorGlow.material.opacity = (off ? 0.08 : st === "idle" ? 0.25 : 0.42) * (pal.light ? 0.6 : 1) + (d.flash > 0 ? d.flash * 0.4 : 0);
      if (d.flash > 0) { d.floorGlow.material.color.copy(d.neon).lerp(d.flashCol, Math.min(1, d.flash)); d.edgeM.color.copy(d.neon).lerp(d.flashCol, Math.min(1, d.flash)); d.flash = Math.max(0, d.flash - dt * 1.2); if (!d.flash) { d.floorGlow.material.color.copy(d.neon); d.edgeM.color.copy(d.neon); } }
      else d.edgeM.color.copy(d.neon).multiplyScalar(off ? 0.25 : 1);
      // waiting for approval: the beacon
      const waiting = st === "waiting_approval"; d.beacon.visible = waiting;
      if (waiting) { d.beam.rotation.y = still ? 0.6 : t * 3.2; d.beaconGlow.material.opacity = still ? 0.8 : 0.45 + 0.5 * pulse; d.beaconGlow.scale.setScalar(1.2 + (still ? 0.3 : 0.5 * pulse)); d.bulbM.color.copy(pal.amber).multiplyScalar(0.75 + 0.25 * pulse); }
      // being judged: the gavel and the scale orbit; the gavel taps
      const judged = st === "judged"; d.judge.visible = judged; d.judgeRing.visible = judged;
      if (judged) { d.orbit.rotation.y = still ? 0.5 : t * 1.1; d.orbit.children[0].rotation.z = still ? 0 : -Math.max(0, Math.sin(t * 5 + d.phase)) * 0.8; d.judgeRing.material.opacity = 0.35 + 0.35 * pulse; d.judge.position.y = 1.85 + (still ? 0 : Math.sin(t * 2) * 0.06); }
      // selection and hover
      const sel = selected === a.id, hov = hover === a.id;
      d.sel.material.opacity = sel ? 0.75 + 0.25 * Math.sin(t * 3) : hov ? 0.4 : 0;
      // helpers
      d.helpers.forEach((hp) => {
        const hs = hp.data.state, hpulse = 0.5 + 0.5 * Math.sin(t * 4 + hp.phase);
        pose(hp, hs === "working" ? "working" : hs === "judged" ? "judged" : "idle", t, dt, hp.phase, still);
        hp.group.position.y = hs === "working" && !still ? Math.abs(Math.sin(t * 5 + hp.phase)) * 0.04 : 0;
        hp.halo.material.opacity = hs === "judged" ? 0.25 + 0.35 * hpulse : hs === "working" ? 0.12 : 0;
      });
      // trails on the floor
      const tr = d.trails;
      if (tr) {
        const work = st === "working" || st === "judged";
        tr.toDesk.material.uniforms.uAlpha.value += ((work ? 1 : off ? 0 : 0.18) - tr.toDesk.material.uniforms.uAlpha.value) * (still ? 1 : Math.min(1, dt * 3));
        tr.toDesk.material.uniforms.uDir.value = st === "judged" ? -1 : 1; // to the pedestal while judged
        tr.toDesk.material.uniforms.uColor.value.copy(st === "judged" ? pal.judge : d.neon);
        tr.toDesk.material.uniforms.uTime.value = still ? 0.2 : t;
        tr.toDoor.material.uniforms.uAlpha.value = waiting ? 1 : 0; tr.toDoor.material.uniforms.uTime.value = still ? 0.2 : t;
      }
    }
    // the task-flow board: dots run along the live connectors, nodes in progress pulse
    if (boards?.flow.edges) {
      for (const e of boards.flow.edges) e.sprites.forEach((s, k) => { e.curve.getPoint(still ? (k + 1) / 4 : ((t * 0.35 + k / 3) % 1), s.position); });
      for (const s of boards.flow.pulses || []) { const k = still ? 0.5 : (t * 0.8) % 1; s.scale.setScalar(s.userData.base * (1 + k * 0.9)); s.material.opacity = 0.8 * (1 - k); }
    }
    // the door
    if (door) {
      const lit = door.count > 0, pulse = 0.5 + 0.5 * Math.sin(t * 4);
      door.lensM.color.copy(lit ? pal.amber : pal.idle).multiplyScalar(lit ? 0.8 + 0.2 * pulse : 0.45);
      door.beam.rotation.y = still ? 0.6 : t * 2.6; door.beamM.opacity = lit ? 0.55 : 0;
      door.halo.material.opacity = lit ? (still ? 0.75 : 0.45 + 0.4 * pulse) + (door.flash || 0) * 0.5 : 0; door.halo.scale.setScalar(2.6 * (1 + (door.flash || 0) * 0.8));
      door.floorPool.material.opacity = lit ? 0.35 + 0.2 * pulse : 0;
      if (door.flash) door.flash = Math.max(0, door.flash - dt);
    }
    for (let k = effects.length - 1; k >= 0; k--) if (!effects[k].step(t)) effects.splice(k, 1);
    placeLabels();
    renderer.render(scene, camera);
    return camMoving;
  }

  // ---------- picking: the desk group (or a helper) under the pointer; hidden things never count
  function pick(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects(world.children, true)) {
      let shown = true, id = "";
      for (let o = hit.object; o; o = o.parent) { if (!o.visible) shown = false; if (!id && o.userData.agentId) id = o.userData.agentId; }
      if (shown && id) return id;
    }
    return "";
  }
  function select(id) { selected = id || ""; updateLabels(); host.invalidate(); }

  readPalette();
  return { apply, rebuild, resize, draw, level, setPixelRatio, pick, effect, resetView, select, info: () => ({ effects: effects.length, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles }) };
}
