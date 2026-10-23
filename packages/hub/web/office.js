// The office (3.4): a calm low-poly room where each agent has a desk, drawn with three.js, or the same information as a 2D plan.
// Served by the hub next to the phone web app and shown in the Mac app inside a web view. No inline scripts or styles (strict CSP):
// colours are set through the style object, never through markup. Reads GET /office and the hub's live event stream; it owns no state of its own.
const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const TOKEN_KEY = "agentroom.token", MODE_KEY = "agentroom.office.mode", POWER_KEY = "agentroom.office.lowpower";
const THREE_URL = "/web/vendor/three.module.min.js";
const WATCH = new Set(["task", "goal", "approval", "working", "subagent", "agent", "room_deleted"]);
const STATE_TEXT = { working: "Working", waiting_approval: "Needs approval", idle: "Idle", judged: "Being judged", offline: "Offline" };
const IDLE_MS = 100; // idle animation: about 10 frames a second

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: the setting lasts until the page closes */ } },
};
const params = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.slice(1));
const injected = window.__AGENT_ROOM__ || {}; // the Mac app's web view sets { token } before the page loads
const token = injected.token || hashParams.get("token") || ls.get(TOKEN_KEY) || "";
if (hashParams.has("token")) history.replaceState(null, "", location.pathname + location.search); // never leave the token in the address
const roomId = params.get("roomId") || "";
const fromRoom = params.get("from") || roomId;
const embedded = !!window.ReactNativeWebView || window.parent !== window || params.get("embed") === "1";
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#5e6875");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cssVar = (n) => getComputedStyle(root).getPropertyValue(n).trim();

// Everything the tests (and a curious developer) can read. Not used by the page itself.
const dbg = window.__office = {
  ready: false, mode: "", why: "", tier: "", frames: 0, running: false, visible: true, lowPower: false, theme: "",
  state: null, desks: [], helpers: [], door: null, board: [], lastOpen: null, error: "",
};

let state = null, capacity = null, lastSig = "";
let mode = "", pref = params.get("view") === "3d" || params.get("view") === "2d" ? params.get("view") : (ls.get(MODE_KEY) || "auto");
let lowPower = ls.get(POWER_KEY) !== null ? ls.get(POWER_KEY) === "1" : matchMedia("(prefers-reduced-motion: reduce)").matches;
const onScreen = { stage: true, plan: true };

// ---------- page chrome
const stageEl = $("#stage"), planEl = $("#plan"), noteEl = $("#note"), labelsEl = $("#labels");
if (embedded) document.body.dataset.embedded = "1";
$("#back").href = fromRoom ? `/#room=${encodeURIComponent(fromRoom)}` : "/";

function showNote(text, link) {
  noteEl.replaceChildren(document.createTextNode(text));
  if (link) { const a = document.createElement("a"); a.href = link.href; a.textContent = link.text; noteEl.append(" ", a); }
  noteEl.hidden = !text;
}

function applyTheme() {
  const q = params.get("theme");
  if ((q === "dark" || q === "light") && root.dataset.theme !== q) root.dataset.theme = q; // only when it differs: a same-value write still wakes the observer below
  dbg.theme = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function onTheme() { applyTheme(); if (S) { S.rebuild(); invalidate(900); } if (mode === "2d") render2d(); }
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);
new MutationObserver(onTheme).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

function syncButtons() {
  $("#mode3d").setAttribute("aria-pressed", String(mode === "3d"));
  $("#mode2d").setAttribute("aria-pressed", String(mode === "2d"));
  $("#power").setAttribute("aria-pressed", String(lowPower));
  document.body.toggleAttribute("data-lowpower", lowPower);
  dbg.lowPower = lowPower; dbg.mode = mode;
}

// ---------- talking to the hub
async function api(path, init = {}) {
  const res = await fetch(path, { ...init, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("This device isn't paired with the hub."), { unpaired: true });
  if (!res.ok) throw new Error(body.error || `The hub returned ${res.status}.`);
  return body;
}

let refreshing = false, again = false, stale = false, refreshTimer = 0;
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    state = await api(`/office${roomId ? `?roomId=${encodeURIComponent(roomId)}` : ""}`);
    dbg.error = ""; setOnline(true); stale = false;
    if (noteEl.dataset.kind === "error") { noteEl.dataset.kind = ""; showNote(noteEl.dataset.why || ""); }
    onState();
  } catch (e) {
    dbg.error = e.message;
    if (e.unpaired) showNote("This device isn't paired with the hub yet.", { href: "/", text: "Open Agent Room to pair it" });
    else { noteEl.dataset.kind = "error"; showNote(`Can't reach the hub: ${e.message}`); }
    setOnline(false);
  } finally { refreshing = false; if (again) { again = false; refreshSoon(); } }
}
function refreshSoon() {
  if (!isVisible()) { stale = true; return; } // nothing to draw: catch up when the page comes back
  clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150);
}

let ws = null, wsDelay = 1000;
function setOnline(on) { $("#dot").classList.toggle("on", on); }
function connectWs() {
  if (ws || !token) return;
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws = sock;
  sock.onopen = () => { wsDelay = 1000; setOnline(true); refreshSoon(); };
  sock.onmessage = (m) => {
    let e; try { e = JSON.parse(m.data); } catch { return; }
    if (!WATCH.has(e.type)) return;
    if (roomId && e.type === "working" && e.roomId !== roomId) return;
    refreshSoon();
  };
  sock.onclose = () => { ws = null; setOnline(false); setTimeout(connectWs, (wsDelay = Math.min(wsDelay * 2, 15000))); };
}

// ---------- opening an agent's thread (AC5)
async function openAgent(agentId) {
  dbg.lastOpen = { agentId, via: "" };
  const msg = { type: "openAgent", agentId };
  if (window.ReactNativeWebView) { dbg.lastOpen.via = "native"; window.ReactNativeWebView.postMessage(JSON.stringify(msg)); return; } // the Mac app opens the DM room
  if (window.parent !== window) { dbg.lastOpen.via = "parent"; window.parent.postMessage(msg, "*"); return; }
  try {
    const room = await api(`/rooms/dm/${encodeURIComponent(agentId)}`, { method: "POST", body: {} });
    dbg.lastOpen.via = "web"; dbg.lastOpen.roomId = room.id;
    location.assign(`/#room=${encodeURIComponent(room.id)}`);
  } catch (e) { showNote(e.unpaired ? "Pair this device first." : e.message); }
}

// ---------- visibility (AC6)
function isVisible() {
  return document.visibilityState === "visible" && (mode === "3d" ? onScreen.stage : onScreen.plan);
}
const io = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => { for (const e of entries) onScreen[e.target.id] = e.isIntersecting; sync(); })
  : null;
io?.observe(stageEl); io?.observe(planEl);
document.addEventListener("visibilitychange", () => { sync(); if (isVisible() && stale) refreshSoon(); });

/** Runs the 3D render loop only while it can be seen. The 2D plan has no loop: its animation is CSS and pauses with the page. */
function sync() {
  dbg.visible = isVisible();
  document.body.toggleAttribute("data-paused", !dbg.visible);
  if (mode === "3d" && S && dbg.visible) startLoop(); else stopLoop();
  if (dbg.visible && stale) refreshSoon();
}

const loop = { raf: 0, timer: 0, running: false, last: 0, boostUntil: 0, dirty: true };
function startLoop() { if (loop.running) return; loop.running = true; dbg.running = true; loop.last = performance.now(); loop.dirty = true; queue(); }
function stopLoop() { loop.running = false; dbg.running = false; cancelAnimationFrame(loop.raf); clearTimeout(loop.timer); loop.raf = loop.timer = 0; }
function queue() {
  if (!loop.running || loop.raf || loop.timer) return;
  if (loop.dirty || performance.now() < loop.boostUntil) loop.raf = requestAnimationFrame(frame);
  else if (!lowPower && S.animating()) loop.timer = setTimeout(() => { loop.timer = 0; if (loop.running) loop.raf = requestAnimationFrame(frame); }, IDLE_MS);
  // otherwise nothing is scheduled at all until something changes (invalidate wakes the loop)
}
function frame(ts) {
  loop.raf = 0;
  if (!loop.running || !isVisible()) { stopLoop(); return; }
  const dt = Math.min(0.25, Math.max(0, (ts - loop.last) / 1000)); loop.last = ts;
  S.draw(ts / 1000, dt, lowPower);
  loop.dirty = false; dbg.frames++;
  queue();
}
/** Something changed: draw a frame, and keep drawing smoothly for `boostMs` so a transition is not choppy. */
function invalidate(boostMs = 0) {
  loop.dirty = true;
  if (boostMs && !lowPower) loop.boostUntil = performance.now() + boostMs;
  if (loop.running) { clearTimeout(loop.timer); loop.timer = 0; queue(); }
}

// ---------- state
function onState() {
  const sig = JSON.stringify([state.agents, state.goal, state.pendingApprovals]);
  if (sig === lastSig) return;
  lastSig = sig;
  dbg.state = state;
  if (mode === "3d" && S) { S.apply(); invalidate(900); }
  else if (mode === "2d") render2d();
  const waiting = state.agents.filter((a) => a.state === "waiting_approval").length, working = state.agents.filter((a) => a.state === "working").length;
  $("#summary").textContent = `${state.agents.length} agents. ${working} working. ${waiting} waiting for approval. ${state.pendingApprovals} pending approvals.`;
}

// ---------- choosing 3D or 2D (AC7)
function decide() {
  const tier = capacity?.plan?.tier || "";
  dbg.tier = tier;
  if (pref === "2d") return { mode: "2d", why: "" };
  if (pref === "3d") return { mode: "3d", why: "" };
  if (innerWidth < 560) return { mode: "2d", why: "" }; // a phone held upright: the plan reads better than a tiny room
  if (tier === "small") return { mode: "2d", why: "This Mac has 8 GB of memory, so the office is drawn as a plan to keep it light. You can switch to 3D." };
  return { mode: "3d", why: "" };
}
async function setMode(want, why = "") {
  let m = want;
  if (m === "3d") {
    try { await ensure3d(); } catch (e) { m = "2d"; why = "3D isn't available on this device, so the office is drawn as a plan."; dbg.error = String(e.message || e); }
  }
  mode = m; dbg.why = why;
  stageEl.hidden = m !== "3d"; planEl.hidden = m !== "2d";
  noteEl.dataset.why = why; if (noteEl.dataset.kind !== "error") showNote(why);
  syncButtons();
  if (m === "3d") { S.resize(); S.rebuild(); loop.dirty = true; lastSig = ""; if (state) onState(); }
  else { stopLoop(); lastSig = ""; if (state) onState(); else render2d(); }
  sync();
}
$("#mode3d").onclick = () => { pref = "3d"; ls.set(MODE_KEY, pref); void setMode("3d"); };
$("#mode2d").onclick = () => { pref = "2d"; ls.set(MODE_KEY, pref); void setMode("2d"); };
$("#power").onclick = () => {
  lowPower = !lowPower; ls.set(POWER_KEY, lowPower ? "1" : "0"); syncButtons();
  if (S) { S.setPixelRatio(); invalidate(); }
  if (mode === "3d") { stopLoop(); sync(); }
};

// =====================================================================================================================
// 3D
// =====================================================================================================================
let THREE = null, S = null;

async function ensure3d() {
  if (S) return;
  if (!window.WebGLRenderingContext) throw new Error("WebGL is not available");
  THREE ||= await import(THREE_URL);
  S = createScene(THREE);
  dbg.pick = (x, y) => (S ? S.pick(x, y) : "");
}

const LAYOUT = { sx: 3.5, sz: 3.9, wallH: 4.0 };
function layoutFor(n) {
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3, rows = Math.max(1, Math.ceil(n / cols));
  const W = Math.max(cols * LAYOUT.sx + 2.2, 7.4), D = rows * LAYOUT.sz + 1.8;
  const at = (i) => ({ x: ((i % cols) - (cols - 1) / 2) * LAYOUT.sx, z: (Math.floor(i / cols) - (rows - 1) / 2) * LAYOUT.sz + 0.5 });
  return { cols, rows, W, D, at };
}

function createScene(T) {
  const canvas = $("#scene");
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); S = null; stopLoop(); void setMode("2d", "The 3D view stopped, so the office is drawn as a plan."); });
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(26, 1, 0.5, 200);
  const sun = new T.DirectionalLight(0xffffff, 2.3); sun.position.set(5, 11, 7);
  const hemi = new T.HemisphereLight(0xffffff, 0xaab6c2, 1.5);
  scene.add(sun, hemi);
  const world = new T.Group(); scene.add(world);
  const boxGeo = new T.BoxGeometry(1, 1, 1); boxGeo.userData.shared = true;
  const ray = new T.Raycaster(), ndc = new T.Vector2(), tmp = new T.Vector3();
  const haloTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32); grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64); return new T.CanvasTexture(c);
  })();

  let pal = {}, size = { w: 1, h: 1 }, lay = layoutFor(1), desks = new Map(), door = null, board = null, hoverId = "", agentSig = "";
  const labelEls = new Map();

  const readPalette = () => {
    const c = (n) => new T.Color(cssVar(n));
    pal = { floor: c("--o-floor"), wall: c("--o-wall"), wallSide: c("--o-wall-side"), trim: c("--o-trim"), desk: c("--o-desk"), chair: c("--o-chair"), skin: c("--o-skin"), hair: c("--o-hair"),
      door: c("--o-door"), leaf: c("--o-leaf"), pot: c("--o-pot"), accent: c("--accent"), amber: c("--amber"), judge: c("--judge"), idle: c("--idle"), ink: c("--ink"),
      sky: c("--o-sky"), ground: c("--o-ground"), sun: Number(cssVar("--o-sun")) || 2.3, ambient: Number(cssVar("--o-ambient")) || 1.5 };
    sun.intensity = pal.sun; hemi.intensity = pal.ambient; hemi.color.copy(pal.sky); hemi.groundColor.copy(pal.ground);
  };
  const lam = (color) => new T.MeshLambertMaterial({ color, flatShading: true });
  const basic = (color, extra = {}) => new T.MeshBasicMaterial({ color, ...extra });
  const mesh = (geo, m, x = 0, y = 0, z = 0) => { const o = new T.Mesh(geo, m); o.position.set(x, y, z); return o; };
  const box = (w, h, d, m, x, y, z) => { const o = mesh(boxGeo, m, x, y, z); o.scale.set(w, h, d); return o; };
  const halo = (color, scale) => {
    const s = new T.Sprite(new T.SpriteMaterial({ map: haloTex, color, transparent: true, depthWrite: false, opacity: 0 }));
    s.scale.setScalar(scale); s.userData.base = scale; s.raycast = () => {}; return s; // a glow is never a click target
  };
  function dispose(obj) {
    obj.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      const ms = [].concat(o.material || []);
      for (const m of ms) { if (m.map && m.map !== haloTex) m.map.dispose(); m.dispose(); }
    });
  }

  // ----- a person: used for the agent at the desk (scale 1) and for helpers (smaller)
  function makeFigure(colorHex, glyph, scale = 1, seated = false) {
    const g = new T.Group(); g.scale.setScalar(scale);
    const body = new T.Color(safeColor(colorHex));
    const bm = lam(body), sm = lam(pal.skin), hm = lam(pal.hair);
    const torso = box(0.52, 0.64, 0.32, bm, 0, 1.0, 0);
    const pm = lam(pal.ink.clone().lerp(body, 0.25));
    if (seated) { for (const s of [-1, 1]) g.add(box(0.19, 0.16, 0.52, pm, s * 0.13, 0.74, 0.22), box(0.17, 0.5, 0.17, pm, s * 0.13, 0.46, 0.5), box(0.17, 0.07, 0.26, lam(0x1e242c), s * 0.13, 0.2, 0.56)); }
    else for (const s of [-1, 1]) g.add(box(0.17, 0.7, 0.2, pm, s * 0.12, 0.34, 0), box(0.18, 0.07, 0.28, lam(0x1e242c), s * 0.12, 0.03, 0.04));
    const head = new T.Group(); head.position.set(0, 1.58, 0);
    head.add(mesh(new T.IcosahedronGeometry(0.22, 1), sm), box(0.5, 0.14, 0.46, hm, 0, 0.13, -0.02), box(0.045, 0.06, 0.03, lam(0x1e242c), -0.08, 0.02, 0.2), box(0.045, 0.06, 0.03, lam(0x1e242c), 0.08, 0.02, 0.2));
    head.children[0].scale.set(1, 1.05, 1);
    const arm = (side) => {
      const p = new T.Group(); p.position.set(side * 0.34, 1.24, 0.02);
      p.add(box(0.13, 0.52, 0.13, bm, 0, -0.26, 0), box(0.12, 0.12, 0.12, sm, 0, -0.55, 0));
      return p;
    };
    const lArm = arm(-1), rArm = arm(1);
    g.add(torso, head, lArm, rArm);
    if (glyph) { // the avatar on the chest: the persona's letter or emoji
      const c = document.createElement("canvas"); c.width = c.height = 96; const x = c.getContext("2d");
      x.fillStyle = "rgba(255,255,255,0.92)"; x.beginPath(); x.arc(48, 48, 44, 0, Math.PI * 2); x.fill();
      x.fillStyle = "#" + body.getHexString(); x.font = "600 54px -apple-system, 'Segoe UI', sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(glyph, 48, 52);
      const badge = mesh(new T.PlaneGeometry(0.3, 0.3), basic(0xffffff, { map: new T.CanvasTexture(c), transparent: true }), 0, 1.02, 0.165);
      g.add(badge);
    }
    return { group: g, torso, head, lArm, rArm, pose: { l: 0, r: 0, rz: 0, hx: 0 } };
  }

  // ----- a desk with its agent, lamp, judge's stand and helpers
  function buildDesk(agent, i) {
    const g = new T.Group(); const p = lay.at(i); g.position.set(p.x, 0, p.z); g.userData.agentId = agent.id;
    const col = new T.Color(safeColor(agent.color));
    const topM = lam(col.clone().lerp(new T.Color(0xffffff), 0.12)), bodyM = lam(pal.desk), darkM = lam(pal.trim);
    g.add(box(2.8, 0.03, 2.3, lam(col.clone().lerp(pal.floor, 0.7)), 0, 0.016, -0.1)); // a rug in the agent's colour
    g.add(box(1.9, 0.08, 0.9, topM, 0, 0.8, 0.0), box(0.08, 0.78, 0.82, bodyM, -0.87, 0.39, 0), box(0.08, 0.78, 0.82, bodyM, 0.87, 0.39, 0), box(1.7, 0.4, 0.05, bodyM, 0, 0.55, -0.36));
    // the monitor and its status bar (visible from behind: this is how the state reads from across the room)
    const lampM = basic(0x888888); const bar = box(0.86, 0.07, 0.06, lampM, 0, 1.62, -0.1);
    g.add(box(0.1, 0.22, 0.1, darkM, 0, 0.95, -0.1), box(0.9, 0.52, 0.05, darkM, 0, 1.3, -0.1), bar);
    const keys = box(0.7, 0.03, 0.22, lam(pal.trim), 0, 0.855, -0.34); g.add(keys);
    // the desk lamp: amber when the agent is waiting for approval
    const bulbM = basic(0x999999);
    const lamp = new T.Group(); lamp.position.set(0.68, 0.84, 0.18);
    lamp.add(box(0.05, 0.4, 0.05, darkM, 0, 0.2, 0), mesh(new T.ConeGeometry(0.17, 0.2, 7), darkM, 0, 0.5, 0), mesh(new T.SphereGeometry(0.07, 8, 6), bulbM, 0, 0.4, 0));
    const lampHalo = halo(pal.amber, 1.7); lampHalo.position.set(0, 0.4, 0); lamp.add(lampHalo); g.add(lamp);
    // chair and person (behind the desk, facing the room)
    const chair = new T.Group(); chair.position.set(0, 0, -0.95);
    chair.add(box(0.7, 0.08, 0.7, lam(pal.chair), 0, 0.5, 0), box(0.7, 0.72, 0.08, lam(pal.chair), 0, 0.92, -0.32), box(0.08, 0.5, 0.08, darkM, 0, 0.25, 0), box(0.6, 0.05, 0.6, darkM, 0, 0.03, 0));
    g.add(chair);
    const fig = makeFigure(agent.color, agent.avatar, 1, true); fig.group.position.set(0, -0.12, -0.88); g.add(fig.group);
    // the judge's stand, with a gavel and a violet glow on the floor
    const stand = new T.Group(); stand.position.set(-1.55, 0, 0.1); stand.visible = false;
    const glow = mesh(new T.CircleGeometry(0.95, 24), basic(pal.judge, { transparent: true, opacity: 0.28, depthWrite: false }), 0, 0.04, 0); glow.rotation.x = -Math.PI / 2; glow.raycast = () => {};
    const gavel = new T.Group(); gavel.position.set(0.06, 1.02, 0.02);
    gavel.add(box(0.05, 0.3, 0.05, lam(pal.hair), 0, 0.15, 0), box(0.22, 0.1, 0.1, lam(pal.hair), 0, 0.32, 0));
    stand.add(glow, box(0.6, 0.85, 0.45, lam(pal.judge), 0, 0.43, 0), box(0.66, 0.08, 0.5, lam(pal.judge.clone().lerp(new T.Color(0xffffff), 0.3)), 0, 0.89, 0), gavel);
    g.add(stand);
    // helpers: smaller figures standing at the desk's right
    const helpers = [];
    agent.helpers.slice(0, 4).forEach((h, k) => {
      const hc = (state?.agents.find((a) => a.id === h.agentId)?.color) || agent.color;
      const f = makeFigure(hc, "", 0.55);
      f.group.position.set(1.4 + (k % 2) * 0.5, 0, 0.1 + Math.floor(k / 2) * 0.55); f.group.userData.agentId = h.agentId || agent.id;
      if (h.readOnly) { f.group.add(mesh(new T.TorusGeometry(0.16, 0.035, 5, 12), lam(pal.ink), 0.34, 0.95, 0.2)); } // a magnifier: reads, never writes
      const hl = halo(pal.judge, 1.2); hl.position.set(0, 1.0, 0); f.group.add(hl);
      g.add(f.group); helpers.push({ ...f, data: h, halo: hl, phase: k * 1.3 });
    });
    const overflow = Math.max(0, agent.helpers.length - 4);
    return { group: g, agent, fig, bar, lampM, bulbM, lampHalo, stand, glow, gavel, helpers, overflow, keys, pos: p, sig: structSig(agent), anchor: new T.Vector3(p.x, 0, p.z + 0.78), phase: i * 0.9 };
  }
  const structSig = (a) => JSON.stringify([a.color, a.avatar, a.name, a.helpers.map((h) => [h.id, h.agentId, h.readOnly])]);

  // ----- the room: floor, two walls, the whiteboard, the door and its light
  function buildRoom(n) {
    lay = layoutFor(n);
    const { W, D } = lay, H = LAYOUT.wallH;
    const wallM = lam(pal.wall), sideM = lam(pal.wallSide), trimM = lam(pal.trim);
    world.add(box(W, 0.2, D, lam(pal.floor), 0, -0.1, 0));
    world.add(box(W + 0.4, H, 0.2, wallM, 0, H / 2, -D / 2 - 0.1), box(0.2, H, D, sideM, -W / 2 - 0.1, H / 2, 0));
    world.add(box(W, 0.14, 0.05, trimM, 0, 0.07, -D / 2 + 0.03), box(0.05, 0.14, D, trimM, -W / 2 + 0.03, 0.07, 0));
    // whiteboard on the back wall
    const bw = Math.min(W - 1.4, 9.2), bh = bw / 2.3;
    const c = document.createElement("canvas"); c.width = 1450; c.height = Math.round(1450 * bh / bw);
    const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
    const face = mesh(new T.PlaneGeometry(bw, bh), basic(0xffffff, { map: tex }), 0.3, 2.3, -D / 2 + 0.07);
    world.add(box(bw + 0.2, bh + 0.2, 0.07, lam(pal.trim), 0.3, 2.3, -D / 2 + 0.03), face);
    board = { canvas: c, tex, sig: "" };
    // the door on the left wall, and the light above it
    const dz = D / 2 - 1.7, dx = -W / 2;
    world.add(box(0.1, 2.5, 1.3, trimM, dx + 0.05, 1.25, dz), box(0.1, 2.3, 1.05, lam(pal.door), dx + 0.1, 1.15, dz), box(0.07, 0.1, 0.1, lam(pal.ink), dx + 0.18, 1.1, dz + 0.36));
    const lensM = basic(0x888888); const lens = box(0.06, 0.16, 0.5, lensM, dx + 0.2, 2.78, dz);
    world.add(box(0.14, 0.26, 0.6, lam(pal.ink), dx + 0.09, 2.78, dz), lens);
    const dh = halo(pal.amber, 2.4); dh.position.set(dx + 0.45, 2.78, dz); world.add(dh);
    door = { lensM, halo: dh, anchor: new T.Vector3(dx + 0.3, 3.3, dz), count: 0 };
    // plants
    for (const [px, pz] of [[W / 2 - 0.7, -D / 2 + 0.8], [-W / 2 + 0.7, -D / 2 + 0.8]]) {
      world.add(mesh(new T.CylinderGeometry(0.28, 0.2, 0.45, 7), lam(pal.pot), px, 0.22, pz), mesh(new T.IcosahedronGeometry(0.42, 0), lam(pal.leaf), px, 0.8, pz), mesh(new T.IcosahedronGeometry(0.3, 0), lam(pal.leaf), px + 0.14, 1.2, pz - 0.05));
    }
  }

  function paintBoard() {
    const g = state?.goal, sig = JSON.stringify(g || null) + dbg.theme;
    if (!board || board.sig === sig) return; board.sig = sig;
    const c = board.canvas, x = c.getContext("2d"), Wc = c.width, Hc = c.height, pad = Math.round(Hc * 0.07);
    const ink = cssVar("--o-board-ink"), muted = cssVar("--o-board-muted"), accent = cssVar("--accent"), amber = cssVar("--amber"), disp = cssVar("--display");
    x.fillStyle = cssVar("--o-board"); x.fillRect(0, 0, Wc, Hc);
    x.textBaseline = "alphabetic"; x.textAlign = "left";
    x.fillStyle = ink; x.font = `600 ${Math.round(Hc * 0.115)}px ${disp}`; x.fillText("Done means", pad, pad + Hc * 0.09);
    const lines = [];
    if (!g) { x.fillStyle = muted; x.font = `${Math.round(Hc * 0.06)}px ${disp}`; x.fillText("No goal yet. Give the room one and its checklist appears here.", pad, pad + Hc * 0.28); }
    else {
      x.fillStyle = muted; x.font = `${Math.round(Hc * 0.056)}px ${disp}`; x.fillText(clipPx(x, g.objective, Wc - pad * 2 - 360), pad, pad + Hc * 0.19);
      const reqs = g.requirements, shown = reqs.length > 8 ? reqs.slice(0, 7) : reqs, cols = shown.length > 4 ? 2 : 1, perCol = Math.ceil(shown.length / cols);
      const colW = (Wc - pad * 2) / cols, fs = Math.round(Hc * 0.06), rowH = Hc * 0.165;
      shown.forEach((r, k) => {
        const cx = pad + Math.floor(k / perCol) * colW, cy = pad + Hc * 0.28 + (k % perCol) * rowH, rr = fs * 0.55;
        x.lineWidth = 4; x.strokeStyle = r.status === "met" ? accent : r.status === "unmet" ? amber : muted;
        x.beginPath(); x.arc(cx + rr, cy - rr * 0.55, rr, 0, Math.PI * 2); x.stroke();
        if (r.status === "met") { x.lineWidth = 6; x.lineCap = "round"; x.lineJoin = "round"; x.beginPath(); x.moveTo(cx + rr * 0.45, cy - rr * 0.5); x.lineTo(cx + rr * 0.9, cy - rr * 0.1); x.lineTo(cx + rr * 1.6, cy - rr * 1.1); x.stroke(); }
        if (r.status === "unmet") { x.fillStyle = amber; x.fillRect(cx + rr - 3, cy - rr * 1.2, 6, rr * 0.8); x.fillRect(cx + rr - 3, cy - rr * 0.25, 6, 6); }
        x.fillStyle = r.status === "met" ? muted : ink; x.font = `${fs}px ${disp}`;
        lines.push(r.text);
        wrapPx(x, r.text, colW - rr * 2 - 40, 2).forEach((ln, li) => x.fillText(ln, cx + rr * 2 + 18, cy + li * fs * 1.15));
      });
      if (reqs.length > shown.length) { x.fillStyle = muted; x.font = `${fs}px ${disp}`; x.fillText(`+${reqs.length - shown.length} more`, pad + (cols - 1) * colW, pad + Hc * 0.28 + (perCol - 1) * rowH + rowH); }
      // progress
      const bw = Math.round(Wc * 0.2), bx = Wc - pad - bw, by = pad + Hc * 0.02;
      x.fillStyle = cssVar("--line"); x.fillRect(bx, by, bw, 16); x.fillStyle = accent; x.fillRect(bx, by, bw * g.progress, 16);
      x.fillStyle = ink; x.font = `600 ${Math.round(Hc * 0.058)}px ${disp}`; x.textAlign = "right"; x.fillText(`${Math.round(g.progress * 100)}%`, bx + bw, by + 62);
    }
    dbg.board = lines; board.tex.needsUpdate = true;
  }
  function wrapPx(x, text, maxW, maxLines) {
    const words = text.split(/\s+/), out = []; let cur = "";
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (x.measureText(t).width <= maxW || !cur) cur = t; else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    if (out.length > maxLines) { const rest = out.slice(maxLines - 1).join(" "); out.length = maxLines - 1; out.push(clipPx(x, rest, maxW)); }
    return out.map((l) => clipPx(x, l, maxW));
  }
  function clipPx(x, s, maxW) { if (x.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && x.measureText(`${t}…`).width > maxW) t = t.slice(0, -1); return `${t}…`; }

  // ----- labels: DOM elements over the canvas (crisp text, keyboard reachable, themed by CSS)
  function label(key, make) {
    let el = labelEls.get(key); if (!el) { el = make(); labelsEl.append(el); labelEls.set(key, el); } return el;
  }
  function updateLabels() {
    const live = new Set();
    for (const d of desks.values()) {
      const a = d.agent, key = `d:${a.id}`; live.add(key);
      const el = label(key, () => {
        const b = document.createElement("button"); b.type = "button"; b.className = "lbl"; b.dataset.agent = a.id;
        b.innerHTML = '<span class="row"><b><span class="sw"></span><span class="nm"></span></b><i class="st"></i></span><i class="tk"></i>';
        b.onclick = () => void openAgent(a.id); return b;
      });
      el.className = `lbl st-${a.state}`; el.style.setProperty("--agent", safeColor(a.color));
      el.querySelector(".nm").textContent = a.name; el.querySelector(".st").textContent = STATE_TEXT[a.state] + (a.helpers.length ? ` · ${a.helpers.length} helper${a.helpers.length > 1 ? "s" : ""}` : "");
      const tk = el.querySelector(".tk"); tk.textContent = a.taskTitle ? clip(a.taskTitle, 34) : ""; tk.hidden = !a.taskTitle;
      el.title = a.taskTitle ? `${a.name}: ${STATE_TEXT[a.state]}. ${a.taskTitle}` : `${a.name}: ${STATE_TEXT[a.state]}`;
      el.setAttribute("aria-label", `${a.name}, ${STATE_TEXT[a.state].toLowerCase()}${a.helpers.length ? `, ${a.helpers.length} helper${a.helpers.length > 1 ? "s" : ""}` : ""}. Open thread.`);
      if (d.overflow) {
        const mk = `m:${a.id}`; live.add(mk); const m = label(mk, () => { const s = document.createElement("div"); s.className = "lbl more"; return s; });
        m.textContent = `+${d.overflow}`; m.dataset.anchor = "more";
      }
    }
    const dk = "door"; live.add(dk);
    const del = label(dk, () => { const s = document.createElement("div"); s.className = "lbl door static"; s.dataset.door = "1"; return s; });
    const n = state?.pendingApprovals || 0;
    del.textContent = n ? `${n} approval${n > 1 ? "s" : ""} waiting` : "No approvals waiting"; del.classList.toggle("lit", n > 0);
    for (const [k, el] of labelEls) if (!live.has(k)) { el.remove(); labelEls.delete(k); }
  }
  function placeLabels() {
    const w = size.w, h = size.h; dbg.desks = []; dbg.helpers = [];
    const rect = canvas.getBoundingClientRect();
    const put = (el, v, below = false) => {
      tmp.copy(v).project(camera);
      const ew = el.offsetWidth / 2 + 4; // keep a label inside the view
      const px = Math.min(w - ew, Math.max(ew, (tmp.x * 0.5 + 0.5) * w)), py = (-tmp.y * 0.5 + 0.5) * h;
      const t = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) translate(-50%,${below ? "0" : "-100%"})`;
      if (el.dataset.t !== t) { el.style.transform = t; el.dataset.t = t; }
      return [px, py];
    };
    for (const d of desks.values()) {
      const el = labelEls.get(`d:${d.agent.id}`); if (!el) continue;
      put(el, d.anchor, true);
      tmp.set(d.pos.x, 0.95, d.pos.z).project(camera);
      dbg.desks.push({ agentId: d.agent.id, state: d.agent.state, x: rect.left + (tmp.x * 0.5 + 0.5) * w, y: rect.top + (-tmp.y * 0.5 + 0.5) * h, helpers: d.helpers.length });
      d.helpers.forEach((hp) => {
        hp.group.getWorldPosition(tmp); tmp.y += 0.5; tmp.project(camera);
        dbg.helpers.push({ id: hp.data.id, parent: d.agent.id, agentId: hp.data.agentId, readOnly: hp.data.readOnly, state: hp.data.state, x: rect.left + (tmp.x * 0.5 + 0.5) * w, y: rect.top + (-tmp.y * 0.5 + 0.5) * h });
      });
      const m = labelEls.get(`m:${d.agent.id}`); if (m) put(m, tmp.set(d.pos.x + 1.65, 1.1, d.pos.z + 0.8));
    }
    const del = labelEls.get("door"); if (del && door) { const [px, py] = put(del, door.anchor); dbg.door = { count: door.count, x: rect.left + px, y: rect.top + py, lit: door.count > 0 }; }
  }

  // ----- applying a new state
  function apply() {
    if (!state) return;
    const ids = state.agents.map((a) => a.id).join("|"), sig = ids + dbg.theme;
    if (sig !== agentSig) { rebuild(); return; }
    state.agents.forEach((a, i) => {
      const d = desks.get(a.id);
      if (d && d.sig !== structSig(a)) { world.remove(d.group); dispose(d.group); const nd = buildDesk(a, i); desks.set(a.id, nd); world.add(nd.group); }
      else if (d) d.agent = a;
    });
    door.count = state.pendingApprovals;
    paintBoard(); updateLabels();
  }
  function rebuild() {
    for (const o of [...world.children]) { world.remove(o); dispose(o); }
    desks = new Map(); board = null; door = null; readPalette();
    const agents = state?.agents || [];
    buildRoom(agents.length);
    agents.forEach((a, i) => { const d = buildDesk(a, i); desks.set(a.id, d); world.add(d.group); });
    agentSig = agents.map((a) => a.id).join("|") + dbg.theme;
    if (door && state) door.count = state.pendingApprovals;
    paintBoard(); updateLabels(); fitCamera(); invalidate(600);
  }

  // ----- camera: a gentle perspective from the front right, fitted to the room
  const camDir = new T.Vector3(0.6, 0.72, 1).normalize();
  function fitCamera() {
    const { W, D } = lay, H = LAYOUT.wallH, target = new T.Vector3(0.2, H * 0.34, 0.1);
    camera.aspect = size.w / size.h;
    const pts = [[-W / 2, 0, -D / 2], [W / 2, 0, -D / 2], [-W / 2, 0, D / 2], [W / 2, 0, D / 2], [-W / 2, H, -D / 2], [W / 2, H, -D / 2], [-W / 2, H, D / 2]].map((p) => new T.Vector3(...p));
    let dist = 40;
    for (let i = 0; i < 5; i++) {
      camera.position.copy(camDir).multiplyScalar(dist).add(target); camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      let m = 0; for (const p of pts) { tmp.copy(p).project(camera); m = Math.max(m, Math.abs(tmp.x) / 0.97, Math.abs(tmp.y) / 0.9); }
      dist *= m;
    }
  }
  function setPixelRatio() { renderer.setPixelRatio(lowPower ? 1 : Math.min(window.devicePixelRatio || 1, 2)); }
  function resize() {
    const r = stageEl.getBoundingClientRect(); size = { w: Math.max(2, Math.round(r.width)), h: Math.max(2, Math.round(r.height)) };
    setPixelRatio(); renderer.setSize(size.w, size.h, false); fitCamera(); invalidate();
  }
  new ResizeObserver(() => { if (!stageEl.hidden) resize(); }).observe(stageEl);

  // ----- drawing a frame
  const rest = (f, v, k, key) => { f[key] += (v - f[key]) * k; };
  function poseFigure(fig, st, t, snap, dt, phase = 0) {
    const k = snap ? 1 : 1 - Math.exp(-dt * 10), p = fig.pose;
    let l = -0.45, r = -0.45, rz = 0, hx = 0.02;
    if (st === "working") { l = -1.0 + Math.sin(t * 7 + phase) * 0.08; r = -1.0 + Math.sin(t * 7 + phase + 1.9) * 0.08; hx = 0.14 + Math.sin(t * 2.4 + phase) * 0.03; }
    else if (st === "waiting_approval") { r = -Math.PI * 0.86; rz = Math.sin(t * 5 + phase) * 0.22; l = -0.5; hx = -0.04; }
    else if (st === "judged") { l = -0.75; r = -0.75; hx = 0.06; }
    rest(p, l, k, "l"); rest(p, r, k, "r"); rest(p, rz, k, "rz"); rest(p, hx, k, "hx");
    fig.lArm.rotation.x = p.l; fig.rArm.rotation.x = p.r; fig.rArm.rotation.z = p.rz; fig.head.rotation.x = p.hx;
  }
  function animating() {
    if (!state) return false;
    return state.pendingApprovals > 0 || state.agents.some((a) => a.state === "working" || a.state === "waiting_approval" || a.state === "judged" || a.helpers.some((h) => h.state !== "idle"));
  }
  function draw(t, dt, snap) {
    for (const d of desks.values()) {
      const a = d.agent, st = a.state, off = st === "offline", pulse = 0.5 + 0.5 * Math.sin(t * 4 + d.phase);
      d.fig.group.visible = !off;
      poseFigure(d.fig, st, t, snap, dt, d.phase);
      const bar = st === "working" ? pal.accent : st === "waiting_approval" ? pal.amber : st === "judged" ? pal.judge : st === "idle" ? pal.idle : null;
      d.lampM.color.copy(bar || pal.trim).multiplyScalar(st === "working" ? 0.75 + 0.25 * Math.sin(t * 9 + d.phase) : st === "idle" || !bar ? 0.55 : 1);
      const waiting = st === "waiting_approval";
      d.bulbM.color.copy(waiting ? pal.amber : pal.idle).multiplyScalar(waiting ? 1 : 0.55);
      d.lampHalo.material.opacity = waiting ? (snap ? 0.7 : 0.45 + 0.35 * pulse) : 0; d.lampHalo.scale.setScalar(d.lampHalo.userData.base * (waiting && !snap ? 0.9 + 0.2 * pulse : 1));
      d.stand.visible = st === "judged";
      if (st === "judged") { d.glow.material.opacity = snap ? 0.3 : 0.2 + 0.15 * pulse; d.gavel.rotation.z = snap ? 0 : Math.max(0, Math.sin(t * 3 + d.phase)) * -0.7; }
      d.helpers.forEach((hp) => {
        const hs = hp.data.state, hpulse = 0.5 + 0.5 * Math.sin(t * 4 + hp.phase);
        poseFigure(hp, hs === "working" ? "working" : "idle", t, snap, dt, hp.phase);
        hp.group.position.y = hs === "working" && !snap ? Math.abs(Math.sin(t * 6 + hp.phase)) * 0.03 : 0;
        hp.halo.material.opacity = hs === "judged" ? (snap ? 0.5 : 0.25 + 0.3 * hpulse) : 0;
      });
    }
    if (door) {
      const lit = door.count > 0, pulse = 0.5 + 0.5 * Math.sin(t * 4);
      door.lensM.color.copy(lit ? pal.amber : pal.idle).multiplyScalar(lit ? 1 : 0.5);
      door.halo.material.color.copy(pal.amber); door.halo.material.opacity = lit ? (snap ? 0.75 : 0.5 + 0.3 * pulse) : 0;
    }
    placeLabels();
    renderer.render(scene, camera);
  }

  // ----- picking (AC5)
  function pick(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects(world.children, true)) {
      let shown = true, id = "";
      for (let o = hit.object; o; o = o.parent) { if (!o.visible) shown = false; if (!id && o.userData.agentId) id = o.userData.agentId; }
      if (shown && id) return id; // something hidden (an offline agent's figure, a judge's stand not in use) is not a target
    }
    return "";
  }
  canvas.addEventListener("click", (e) => { const id = pick(e.clientX, e.clientY); if (id) void openAgent(id); });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const id = pick(e.clientX, e.clientY);
    if (id !== hoverId) { hoverId = id; canvas.classList.toggle("hover", !!id); }
  });
  canvas.addEventListener("pointerleave", () => { hoverId = ""; canvas.classList.remove("hover"); });

  return { apply, rebuild, resize, draw, animating, setPixelRatio, pick };
}

// =====================================================================================================================
// 2D plan: the same information, drawn in SVG
// =====================================================================================================================
const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid) el.append(kid);
  return el;
}
const text = (s, attrs) => { const t = svg("text", attrs); t.textContent = s; return t; };
const title = (s) => { const t = svg("title"); t.textContent = s; return t; };

function render2d() {
  if (!state) { planEl.replaceChildren(); return; }
  const focused = document.activeElement?.dataset?.agent || "";
  const agents = state.agents, n = agents.length;
  const narrow = planEl.clientWidth && planEl.clientWidth < 560;
  const cols = Math.max(1, Math.min(narrow ? 2 : 3, n)), rows = Math.max(1, Math.ceil(n / cols));
  const CW = 230, CH = 196, left = 104, boardH = 160, top = 20, floorTop = top + boardH + 22;
  const W = left + Math.max(cols, 2) * CW + 20, H = floorTop + rows * CH + 12;
  const root2 = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": "The office plan" });
  root2.append(svg("rect", { class: "o-wall", x: 6, y: 6, width: W - 12, height: floorTop - 6, rx: 10 }), svg("rect", { class: "o-floor", x: 6, y: floorTop - 4, width: W - 12, height: H - floorTop - 2, rx: 10 }));

  // whiteboard
  const g = state.goal, bx = left, bw = W - left - 20;
  const board = svg("g", { class: "board" }, svg("rect", { class: "o-board", x: bx, y: top, width: bw, height: boardH, rx: 8 }), text("Done means", { class: "disp o-board-ink", x: bx + 18, y: top + 30, "font-size": 20 }));
  const lines = [];
  if (!g) board.append(text("No goal yet. Give the room one and its checklist appears here.", { class: "o-board-muted", x: bx + 18, y: top + 62, "font-size": 14 }));
  else {
    board.append(text(clip(g.objective, 70), { class: "o-board-muted", x: bx + 18, y: top + 52, "font-size": 13 }));
    const reqs = g.requirements, shown = reqs.length > 8 ? reqs.slice(0, 7) : reqs, c2 = shown.length > 4 ? 2 : 1, perCol = Math.ceil(shown.length / c2), colW = (bw - 36) / c2;
    shown.forEach((r, k) => {
      const x = bx + 18 + Math.floor(k / perCol) * colW, y = top + 78 + (k % perCol) * 20;
      board.append(svg("circle", { class: "o-ring", cx: x + 7, cy: y - 5, r: 7 }));
      if (r.status === "met") board.append(svg("path", { class: "o-tick", d: `M${x + 3} ${y - 5} l3 3 l6 -7` }));
      board.append(text(clip(r.text, Math.floor(colW / 7.4)), { class: r.status === "met" ? "o-board-muted" : "o-board-ink", x: x + 22, y, "font-size": 13 }, title(`${r.text}${r.status === "met" ? " (done)" : r.status === "unmet" ? " (not met)" : ""}`)));
      lines.push(r.text);
    });
    if (reqs.length > shown.length) board.append(text(`+${reqs.length - shown.length} more`, { class: "o-board-muted", x: bx + 18 + (c2 - 1) * colW, y: top + 78 + perCol * 20, "font-size": 13 }));
    board.append(svg("rect", { class: "o-bar", x: bx + bw - 190, y: top + 14, width: 160, height: 8, rx: 4 }), svg("rect", { class: "o-fill", x: bx + bw - 190, y: top + 14, width: 160 * g.progress, height: 8, rx: 4 }),
      text(`${Math.round(g.progress * 100)}%`, { class: "disp o-board-ink", x: bx + bw - 30, y: top + 40, "text-anchor": "end", "font-size": 14 }));
  }
  dbg.board = lines;
  root2.append(board);

  // the door and its light
  const lit = state.pendingApprovals > 0;
  root2.append(svg("g", { class: "door", "data-door": "1" },
    lit ? svg("rect", { class: "door-halo lit halo", x: 28, y: 44, width: 44, height: 24, rx: 10 }) : null, svg("rect", { class: `door-lamp${lit ? " lit" : ""}`, x: 36, y: 50, width: 28, height: 12, rx: 3 }),
    svg("rect", { class: "o-door", x: 22, y: 70, width: 56, height: 92, rx: 4 }), svg("circle", { class: "o-knob", cx: 68, cy: 118, r: 3 }),
    text("Approvals", { x: 50, y: 180, "text-anchor": "middle", "font-size": 11, class: "muted" }),
    text(lit ? `${state.pendingApprovals} waiting` : "None waiting", { x: 50, y: 195, "text-anchor": "middle", "font-size": 12, class: lit ? "disp amber" : "muted" }),
    title(lit ? `${state.pendingApprovals} pending approvals` : "No approvals waiting")));

  const seats = [];
  agents.forEach((a, i) => {
    const cx = left + (i % cols) * CW + CW / 2 + (cols < 2 ? CW / 2 : 0), y0 = floorTop + Math.floor(i / cols) * CH + 6, col = safeColor(a.color);
    const seat = svg("g", { class: `seat st-${a.state}`, tabindex: 0, role: "button", "data-agent": a.id, "data-state": a.state, "aria-label": `${a.name}, ${STATE_TEXT[a.state].toLowerCase()}${a.helpers.length ? `, ${a.helpers.length} helper${a.helpers.length > 1 ? "s" : ""}` : ""}. Open thread.` });
    const desk = svg("rect", { class: "o-desk", x: cx - 72, y: y0 + 62, width: 144, height: 56, rx: 9 }); desk.style.fill = col; desk.style.fillOpacity = "0.86";
    const avatar = svg("g", { class: "avatar" }, svg("rect", { class: "o-chair", x: cx - 26, y: y0 + 14, width: 52, height: 40, rx: 12 }), svg("circle", { cx, cy: y0 + 34, r: 21, class: "av" }), text(a.avatar, { class: "glyph", x: cx, y: y0 + 35, "font-size": 20 }));
    avatar.querySelector(".av").style.fill = col;
    seat.append(svg("rect", { class: "hit", x: cx - 108, y: y0, width: 216, height: CH - 14 }), desk, avatar);
    seat.append(svg("rect", { class: "o-monitor", x: cx - 24, y: y0 + 70, width: 48, height: 10, rx: 3 }), svg("circle", { class: "lamp", cx: cx + 54, cy: y0 + 76, r: 7 }));
    if (a.state === "waiting_approval") seat.append(svg("circle", { class: "halo", cx: cx + 54, cy: y0 + 76, r: 18 }), svg("path", { class: "hand", d: `M${cx + 22} ${y0 + 40} L${cx + 36} ${y0 + 12}` }), svg("circle", { cx: cx + 36, cy: y0 + 10, r: 5, fill: "var(--amber)" }));
    if (a.state === "working") seat.append(svg("g", { class: "typing" }, [0, 1, 2].map((k) => svg("circle", { cx: cx - 12 + k * 12, cy: y0 + 100, r: 3.4 }))));
    if (a.state === "judged") seat.append(svg("circle", { class: "judge-glow", cx: cx - 104, cy: y0 + 96, r: 24 }), svg("path", { class: "stand", d: `M${cx - 118} ${y0 + 110} l6 -34 h24 l6 34 z` }), svg("rect", { class: "stand", x: cx - 114, y: y0 + 70, width: 36, height: 7, rx: 2, opacity: 0.8 }));
    a.helpers.slice(0, 4).forEach((h, k) => {
      const hc = safeColor(agents.find((o) => o.id === h.agentId)?.color || a.color);
      const dot = svg("circle", { class: `helper${h.readOnly ? " ro" : ""}`, "data-helper": h.id, cx: cx + 92 + (k % 2) * 18, cy: y0 + 70 + Math.floor(k / 2) * 20, r: 8 }, title(`Helper: ${h.title || h.agentId}${h.readOnly ? " (reads only)" : ""}, ${STATE_TEXT[h.state].toLowerCase()}`));
      dot.style.fill = hc; seat.append(dot);
    });
    if (a.helpers.length > 4) seat.append(text(`+${a.helpers.length - 4}`, { x: cx + 101, y: y0 + 114, "font-size": 11, "text-anchor": "middle", class: "muted" }));
    seat.append(text(a.name, { class: "disp", x: cx, y: y0 + 140, "text-anchor": "middle", "font-size": 16 }),
      text(STATE_TEXT[a.state], { class: "stt", x: cx, y: y0 + 157, "text-anchor": "middle", "font-size": 12 }),
      a.taskTitle ? text(clip(a.taskTitle, 30), { class: "muted", x: cx, y: y0 + 172, "text-anchor": "middle", "font-size": 11 }) : null, title(`${a.name}: ${STATE_TEXT[a.state]}${a.taskTitle ? `. ${a.taskTitle}` : ""}`));
    const open = () => void openAgent(a.id);
    seat.addEventListener("click", open);
    seat.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    root2.append(seat); seats.push(seat);
  });
  planEl.replaceChildren(root2);
  if (focused) planEl.querySelector(`[data-agent="${CSS.escape(focused)}"]`)?.focus();
  // positions for tests
  dbg.desks = seats.map((s) => { const r = s.querySelector(".o-desk").getBoundingClientRect(); return { agentId: s.dataset.agent, state: s.dataset.state, x: r.left + r.width / 2, y: r.top + r.height / 2, helpers: s.querySelectorAll(".helper").length }; });
  dbg.helpers = [...planEl.querySelectorAll(".helper")].map((h) => { const r = h.getBoundingClientRect(); return { id: h.dataset.helper, parent: h.closest(".seat").dataset.agent, x: r.left + r.width / 2, y: r.top + r.height / 2, readOnly: h.classList.contains("ro") }; });
  const dr = planEl.querySelector(".door-lamp").getBoundingClientRect();
  dbg.door = { count: state.pendingApprovals, x: dr.left + dr.width / 2, y: dr.top + dr.height / 2, lit };
  if (!n) showNote("No agents yet. Add one in Agent Room settings.");
}
window.addEventListener("resize", () => { if (mode === "2d") render2d(); });

// =====================================================================================================================
async function main() {
  applyTheme(); syncButtons();
  if (!token) { showNote("This device isn't paired with the hub yet.", { href: "/", text: "Open Agent Room to pair it" }); dbg.ready = true; dbg.error = "unpaired"; return; }
  await Promise.all([
    refresh(),
    api("/capacity").then((c) => { capacity = c; }).catch(() => {}),
    api("/rooms").then((rooms) => { const r = rooms.find((x) => x.id === roomId); if (r) $("#title").textContent = `Office: ${r.dmAgentId ? "all rooms" : r.name}`; }).catch(() => {}),
  ]);
  const d = decide();
  await setMode(d.mode, d.why);
  connectWs();
  setInterval(() => { if (isVisible()) refreshSoon(); }, 20000); // a safety net for any event that never arrived
  dbg.ready = true;
}
void main();
