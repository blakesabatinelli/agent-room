// The office (3.4, 3.4b "live operations floor"): each agent at its own glowing desk around the goal, drawn with three.js
// (office-scene.js), or the same information as a 2D plan. Served by the hub next to the phone web app and shown in the Mac app inside a
// web view. No inline scripts or styles (strict CSP): colours are set through the style object, never through markup.
// Reads GET /office and the hub's live event stream; it owns no state of its own. One-shot effects (a task assigned, sent to review,
// accepted or sent back, a new approval) come from comparing one /office answer with the next.
const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const TOKEN_KEY = "agentroom.token", MODE_KEY = "agentroom.office.mode", POWER_KEY = "agentroom.office.lowpower", THEME_KEY = "agentroom.theme";
const THREE_URL = "/web/vendor/three.module.min.js";
const SCENE_URL = "/web/office-scene.js";
const WATCH = new Set(["task", "goal", "approval", "working", "subagent", "agent", "room_deleted", "message"]);
const STATE_TEXT = { working: "Working", waiting_approval: "Needs approval", idle: "Idle", judged: "Being judged", offline: "Offline" };
const STATUS_TEXT = { pending: "Not started", assigned: "Assigned", running: "Running", review: "In review", revising: "Revising", waiting: "Waiting for you", done: "Done", failed: "Failed", cancelled: "Cancelled" };
const IDLE_MS = 100; // nothing happening: about 10 frames a second (the slow drift, breathing)
const ACTIVE_MS = 33; // agents at work or an effect running: about 30 frames a second

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
const agentById = (id) => state?.agents.find((a) => a.id === id);

// Everything the tests (and a curious developer) can read. Not used by the page itself.
const dbg = window.__office = {
  ready: false, mode: "", why: "", tier: "", frames: 0, running: false, visible: true, lowPower: false, theme: "",
  state: null, desks: [], helpers: [], door: null, board: [], lastOpen: null, error: "", selected: "", effects: [], fps: 0,
};

let state = null, capacity = null, lastSig = "", selected = "";
let mode = "", pref = params.get("view") === "3d" || params.get("view") === "2d" ? params.get("view") : (ls.get(MODE_KEY) || "auto");
let lowPower = ls.get(POWER_KEY) !== null ? ls.get(POWER_KEY) === "1" : matchMedia("(prefers-reduced-motion: reduce)").matches;
const onScreen = { stage: true, plan: true };

// ---------- page chrome
const stageEl = $("#stage"), planEl = $("#plan"), noteEl = $("#note"), labelsEl = $("#labels"), insEl = $("#inspector");
if (embedded) document.body.dataset.embedded = "1";
$("#back").href = fromRoom ? `/#room=${encodeURIComponent(fromRoom)}` : "/";

function showNote(text, link) {
  noteEl.replaceChildren(document.createTextNode(text));
  if (link) { const a = document.createElement("a"); a.href = link.href; a.textContent = link.text; noteEl.append(" ", a); }
  noteEl.hidden = !text;
}

/** Dark is the office's default. Light only when asked for: ?theme=light, or the app's Appearance set to Light. */
function applyTheme() {
  const q = params.get("theme"), saved = ls.get(THEME_KEY);
  const want = q === "light" || q === "dark" ? q : saved === "light" ? "light" : "";
  if (want && root.dataset.theme !== want) root.dataset.theme = want; // only when it differs: a same-value write still wakes the observer below
  dbg.theme = root.dataset.theme === "light" ? "light" : "dark";
}
function onTheme() { applyTheme(); if (S) { S.rebuild(); invalidate(900); } if (mode === "2d") render2d(); }
new MutationObserver(onTheme).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

function syncButtons() {
  $("#mode3d").setAttribute("aria-pressed", String(mode === "3d"));
  $("#mode2d").setAttribute("aria-pressed", String(mode === "2d"));
  $("#power").setAttribute("aria-pressed", String(lowPower));
  document.body.toggleAttribute("data-lowpower", lowPower);
  document.body.dataset.mode = mode; // the plan spells every state out, so a phone drops the legend there
  dbg.lowPower = lowPower; dbg.mode = mode;
}

// full screen (the Fullscreen API; a web view without it simply has no button)
const fullBtn = $("#full");
if (document.fullscreenEnabled && root.requestFullscreen) {
  fullBtn.hidden = false;
  fullBtn.onclick = () => { if (document.fullscreenElement) void document.exitFullscreen(); else root.requestFullscreen().catch(() => showNote("Full screen isn't allowed here.")); };
  document.addEventListener("fullscreenchange", () => { fullBtn.setAttribute("aria-pressed", String(!!document.fullscreenElement)); fullBtn.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen"; });
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
    dbg.error = ""; stale = false;
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
function setOnline(on) { $("#live").classList.toggle("on", on); $("#liveText").textContent = on ? "Live" : "Reconnecting"; }
function connectWs() {
  if (ws || !token) return;
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws = sock;
  sock.onopen = () => { wsDelay = 1000; setOnline(true); refreshSoon(); };
  sock.onmessage = (m) => {
    let e; try { e = JSON.parse(m.data); } catch { return; }
    if (!WATCH.has(e.type)) return;
    if (roomId && (e.type === "working" || e.type === "message") && (e.roomId ?? e.message?.roomId) !== roomId) return;
    refreshSoon();
  };
  sock.onclose = () => { ws = null; setOnline(false); setTimeout(connectWs, (wsDelay = Math.min(wsDelay * 2, 15000))); };
}

// ---------- opening an agent's thread (AC5): the inspector's "Open thread"
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

const loop = { raf: 0, timer: 0, running: false, last: 0, boostUntil: 0, dirty: true, fpsN: 0, fpsAt: 0 };
function startLoop() { if (loop.running) return; loop.running = true; dbg.running = true; loop.last = performance.now(); loop.dirty = true; queue(); }
function stopLoop() { loop.running = false; dbg.running = false; cancelAnimationFrame(loop.raf); clearTimeout(loop.timer); loop.raf = loop.timer = 0; }
/**
 * The pace: every display frame while something changes or an effect plays (boost); about 30 a second while agents work;
 * about 10 (IDLE_MS) when nothing is happening; and in low power, nothing at all until something changes (invalidate wakes the loop).
 */
function queue() {
  if (!loop.running || loop.raf || loop.timer) return;
  if (loop.dirty || performance.now() < loop.boostUntil) { loop.raf = requestAnimationFrame(frame); return; }
  const pace = lowPower ? "none" : S.level();
  if (pace !== "none") loop.timer = setTimeout(() => { loop.timer = 0; if (loop.running) loop.raf = requestAnimationFrame(frame); }, pace === "active" ? ACTIVE_MS : IDLE_MS);
}
function frame(ts) {
  loop.raf = 0;
  if (!loop.running || !isVisible()) { stopLoop(); return; }
  const dt = Math.min(0.25, Math.max(0, (ts - loop.last) / 1000)); loop.last = ts;
  const moving = S.draw(ts / 1000, dt, lowPower);
  if (moving && !lowPower) loop.boostUntil = Math.max(loop.boostUntil, performance.now() + 150);
  loop.dirty = false; dbg.frames++;
  loop.fpsN++; if (ts - loop.fpsAt > 1000) { dbg.fps = Math.round((loop.fpsN * 1000) / (ts - loop.fpsAt)); loop.fpsN = 0; loop.fpsAt = ts; }
  queue();
}
/** Something changed: draw a frame, and keep drawing smoothly for `boostMs` so a transition is not choppy. */
function invalidate(boostMs = 0) {
  loop.dirty = true;
  if (boostMs && !lowPower) loop.boostUntil = Math.max(loop.boostUntil, performance.now() + boostMs);
  if (loop.running) { clearTimeout(loop.timer); loop.timer = 0; queue(); }
}

// ---------- state
let prev = null;
/** Compares this answer with the last one and names what just happened, for the one-shot effects. */
function diffEffects(st) {
  const tasks = st.goal?.tasks || [], out = [];
  const pend = new Map(st.agents.map((a) => [a.id, (a.approvals || []).length]));
  if (prev && prev.goalId === st.goal?.id) {
    for (const t of tasks) {
      const p = prev.tasks.get(t.id), was = p?.status, now = t.status, who = t.assignee;
      if (!who || was === now) continue;
      if (now === "done") out.push({ kind: "accept", at: who, task: t.id });
      else if (now === "failed") out.push({ kind: "fail", at: who, task: t.id });
      else if (now === "review") out.push({ kind: "review", from: who, ...(t.judgeId && t.judgeId !== who ? { to: t.judgeId } : {}), task: t.id });
      else if (was === "review" && (now === "revising" || now === "running" || now === "assigned")) out.push({ kind: "sendback", at: who, task: t.id });
      else if ((now === "assigned" || now === "running") && (!was || was === "pending" || was === "waiting")) out.push({ kind: "assign", to: who, task: t.id });
    }
  }
  if (prev) for (const [id, n] of pend) if (n > (prev.pend.get(id) || 0)) out.push({ kind: "approval", from: id });
  prev = { goalId: st.goal?.id, tasks: new Map(tasks.map((t) => [t.id, { status: t.status, attempts: t.attempts }])), pend };
  return out;
}
function fire(effects) {
  for (const e of effects) {
    dbg.effects.push({ ...e, firedAt: Date.now() }); if (dbg.effects.length > 30) dbg.effects.shift();
    if (mode === "3d" && S) S.effect(e);
    else if (mode === "2d" && !lowPower) {
      const id = e.at || e.to || e.from, seat = planEl.querySelector(`.seat[data-agent="${CSS.escape(id || "")}"]`);
      const cls = e.kind === "accept" ? "flash-accept" : e.kind === "sendback" || e.kind === "fail" ? "flash-back" : "";
      if (seat && cls) { seat.classList.add(cls); setTimeout(() => seat.classList.remove(cls), 1400); }
    }
  }
}

function onState() {
  const effects = diffEffects(state);
  const sig = JSON.stringify({ ...state, at: 0 }); // the answer's own time changes on every poll
  if (sig === lastSig) { renderInspector(); return; } // "started 12 min ago" still moves on
  lastSig = sig;
  dbg.state = state;
  if (selected && !agentById(selected)) selected = "";
  renderHeader();
  if (mode === "3d" && S) { S.apply(); invalidate(900); }
  else if (mode === "2d") render2d();
  fire(effects);
  renderInspector();
  const waiting = state.agents.filter((a) => a.state === "waiting_approval").length, working = state.agents.filter((a) => a.state === "working").length;
  $("#summary").textContent = `${state.agents.length} agents. ${working} working. ${waiting} waiting for approval. ${state.pendingApprovals} pending approvals.`;
}

// ---------- header: "<room> // Office", then agents | tasks | in progress | blockers
function renderHeader() {
  const c = state.counts || { agents: state.agents.length, tasks: 0, inProgress: 0, blockers: 0 };
  const part = (n, one, many, warn) => { const s = document.createElement("span"); if (warn && n) s.className = "warn"; const b = document.createElement("b"); b.textContent = String(n); s.append(b, ` ${n === 1 ? one : many}`); return s; };
  $("#counts").replaceChildren(part(c.agents, "agent", "agents"), part(c.tasks, "task", "tasks"), part(c.inProgress, "in progress", "in progress"), part(c.blockers, "blocker", "blockers", true));
}

// ---------- the inspector: everything the hub knows about the selected agent
const stateWord = (a) => STATE_TEXT[a.state] || a.state;
/** The status chip's second part: what the agent is doing, in its own data's words. */
function chipText(a) {
  if (a.state === "waiting_approval") return a.approvals?.[0]?.action || a.taskTitle || "";
  if (a.state === "working" || a.state === "judged") return a.taskTitle || "";
  if (a.state === "idle" && a.next) return `Next: ${a.next}`;
  return "";
}
const two = (n) => String(n).padStart(2, "0");
function when(at) {
  const d = new Date(at), now = new Date();
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
}
function ago(at) {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
function section(title, ...kids) { const s = el("section", "sec"); s.append(el("h3", "", title), ...kids.filter(Boolean)); return s; }
function list(items) { const u = el("ul", "list"); for (const [ic, cls, text, at] of items) { const li = el("li"); li.append(el("span", `ic ${cls}`, ic), el("span", "tx", text)); if (at) { const t = el("time", "", when(at)); t.dateTime = new Date(at).toISOString(); li.append(t); } u.append(li); } return u; }

function renderInspector() {
  const a = selected ? agentById(selected) : undefined;
  dbg.selected = a ? a.id : "";
  if (!a) { insEl.hidden = true; return; }
  insEl.hidden = false;
  insEl.className = `st-${a.state}`;
  insEl.style.setProperty("--agent", safeColor(a.color));
  $("#insAvatar").textContent = a.avatar || a.name[0];
  $("#insName").textContent = a.name;
  $("#insState").textContent = a.state === "working" ? "Active" : stateWord(a);
  $("#insRole").textContent = a.role || "";
  $("#insAbout").textContent = a.about || "";
  const body = [];
  const t = a.task;
  if (t) {
    const pct = t.progress !== undefined ? Math.round(t.progress * 100) : undefined;
    const bar = el("div", `bar${pct === undefined ? " unknown" : ""}`); const fill = el("i"); if (pct !== undefined) fill.style.width = `${pct}%`; bar.append(fill);
    const r1 = el("div", "row2"); r1.append(el("span", "", pct !== undefined ? `${pct}% ${t.progressFrom === "criteria" ? "of its checks pass" : "of its usual time"}` : "No estimate yet"), el("b", "", STATUS_TEXT[t.status] || t.status));
    const r2 = el("div", "row2"); r2.append(el("span", "", t.startedAt ? `Started ${when(t.startedAt)}, ${ago(t.startedAt)}` : "Not started"), el("span", "", t.attempts > 1 ? `Attempt ${t.attempts}` : ""));
    body.push(section("Current task", el("p", "ttl", t.title), bar, r1, r2, el("p", "mut", t.step)));
    body.push(section("Blocked by", t.blockedBy.length ? list(t.blockedBy.map((b) => ["!", "blk", b])) : el("p", "mut", "Nothing")));
  } else body.push(section("Current task", el("p", "mut", a.state === "working" && a.taskTitle ? `${a.taskTitle[0].toUpperCase()}${a.taskTitle.slice(1)} in the room` : a.state === "offline" ? "Switched off" : "No task right now")));
  body.push(section("Next step", el("p", a.next ? "" : "mut", a.next || "Nothing queued for this agent")));
  if (a.helpers.length) body.push(section("Helpers", list(a.helpers.map((h) => ["◦", "msg", `${h.title || "Helper"} (${agentById(h.agentId)?.name || h.agentId}${h.readOnly ? ", reads only" : ""}, ${STATE_TEXT[h.state].toLowerCase()})`]))));
  const outs = a.outputs || [];
  body.push(section("Recent outputs", outs.length ? list(outs.map((o) => o.kind === "accepted" ? ["✓", "ok", `Accepted: ${o.text}`, o.at] : o.kind === "sent_back" ? ["↺", "back", `Sent back: ${o.text}`, o.at] : ["•", "msg", o.text, o.at])) : el("p", "mut", "Nothing yet")));
  const aps = a.approvals || [];
  body.push(section("Approvals", aps.length ? list(aps.map((p) => ["?", "wait", `${p.action} (${p.tool})`, p.createdAt])) : el("p", "mut", "None waiting")));
  $("#insBody").replaceChildren(...body);
}
function select(id) {
  selected = id && agentById(id) ? id : "";
  if (S) S.select(selected);
  for (const s of planEl.querySelectorAll(".seat")) s.classList.toggle("sel", s.dataset.agent === selected);
  renderInspector();
}
$("#insClose").onclick = () => select("");
$("#insOpen").onclick = () => { if (selected) void openAgent(selected); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selected) select(""); });

// ---------- choosing 3D or 2D (AC7)
function decide() {
  const tier = capacity?.plan?.tier || "";
  dbg.tier = tier;
  if (pref === "2d") return { mode: "2d", why: "" };
  if (pref === "3d") return { mode: "3d", why: "" };
  if (innerWidth < 560 && innerHeight > innerWidth) return { mode: "2d", why: "" }; // a phone held upright: the plan reads better than a tiny room
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
  if (m === "3d") { S.resize(); S.rebuild(); S.select(selected); loop.dirty = true; lastSig = ""; if (state) onState(); }
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
// 3D: three.js and the scene module are fetched only now, so the 2D plan never downloads them
// =====================================================================================================================
let THREE = null, S = null;
async function ensure3d() {
  if (S) return;
  if (!window.WebGLRenderingContext) throw new Error("WebGL is not available");
  const [three, mod] = await Promise.all([THREE ? Promise.resolve(THREE) : import(THREE_URL), import(SCENE_URL)]);
  THREE = three;
  const canvas = $("#scene");
  S = mod.createScene(THREE, {
    canvas, labelsEl, cssVar, safeColor, dbg, agentById, stateWord, chipText,
    getState: () => state, lowPower: () => lowPower, invalidate, onSelect: (id) => select(id),
  });
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); S = null; stopLoop(); labelsEl.replaceChildren(); void setMode("2d", "The 3D view stopped, so the office is drawn as a plan."); });
  new ResizeObserver(() => { if (!stageEl.hidden && S) S.resize(); }).observe(stageEl);
  dbg.pick = (x, y) => (S ? S.pick(x, y) : "");
  dbg.scene = () => (S ? S.info() : null);
}

// =====================================================================================================================
// 2D plan: the same information, drawn in SVG
// =====================================================================================================================
const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid) e.append(kid);
  return e;
}
const text = (s, attrs) => { const t = svg("text", attrs); t.textContent = s; return t; };
const title = (s) => { const t = svg("title"); t.textContent = s; return t; };

function boardSvg(g, x, y, w, maxRows) {
  const reqs = g?.requirements || [], lines = [];
  const shown = reqs.length > maxRows ? reqs.slice(0, maxRows - 1) : reqs;
  const h = 58 + Math.max(1, shown.length + (reqs.length > shown.length ? 1 : 0)) * 21 + 6;
  const b = svg("g", { class: "board" }, svg("rect", { class: "o-board", x, y, width: w, height: h, rx: 8 }), text("DONE MEANS", { class: "cap", x: x + 14, y: y + 22, "font-size": 11 }));
  if (!g) b.append(text("No goal yet. Give the room one and its checklist appears here.", { class: "o-board-muted", x: x + 14, y: y + 46, "font-size": 13 }));
  else {
    b.append(text(clip(g.objective, Math.floor((w - 90) / 7.2)), { class: "o-board-ink", x: x + 14, y: y + 44, "font-size": 14, "font-weight": 600 }));
    b.append(text(`${Math.round(g.progress * 100)}%`, { class: "o-board-ink", x: x + w - 14, y: y + 24, "text-anchor": "end", "font-size": 15, "font-weight": 700 }),
      svg("rect", { class: "o-bar", x: x + w - 120, y: y + 32, width: 106, height: 5, rx: 2.5 }), svg("rect", { class: "o-fill", x: x + w - 120, y: y + 32, width: 106 * g.progress, height: 5, rx: 2.5 }));
    shown.forEach((r, k) => {
      const ry = y + 70 + k * 21;
      b.append(svg("circle", { class: `o-ring ${r.status}`, cx: x + 22, cy: ry - 4, r: 6.5 }));
      if (r.status === "met") b.append(svg("path", { class: "o-tick", d: `M${x + 18.5} ${ry - 4} l2.6 2.6 l5 -5.6` }));
      b.append(text(clip(r.text, Math.floor((w - 50) / 6.8)), { class: r.status === "met" ? "o-board-muted" : "o-board-ink", x: x + 36, y: ry, "font-size": 12.5 }, title(`${r.text}${r.status === "met" ? " (done)" : r.status === "unmet" ? " (not met)" : ""}`)));
    });
    for (const r of reqs) lines.push(r.text);
    if (reqs.length > shown.length) b.append(text(`+${reqs.length - shown.length} more`, { class: "o-board-muted", x: x + 36, y: y + 70 + shown.length * 21, "font-size": 12 }));
  }
  return { node: b, h, lines };
}
function flowSvg(tasks, x, y, w) {
  const per = Math.max(2, Math.min(tasks.length, Math.floor((w - 20) / 92))), rows = Math.max(1, Math.ceil(tasks.length / per));
  const h = 40 + rows * 74 + 4, step = (w - 28) / per;
  const f = svg("g", { class: "flow" }, svg("rect", { class: "o-board", x, y, width: w, height: h, rx: 8 }), text("TASK FLOW", { class: "cap", x: x + 14, y: y + 22, "font-size": 11 }));
  if (!tasks.length) { f.append(text("No tasks yet.", { class: "o-board-muted", x: x + 14, y: y + 50, "font-size": 13 })); return { node: f, h }; }
  const pos = new Map(tasks.map((t, k) => [t.id, { x: x + 14 + step * ((k % per) + 0.5), y: y + 52 + Math.floor(k / per) * 74, t }]));
  tasks.forEach((t, k) => {
    const deps = (t.dependsOn || []).filter((d) => pos.has(d)), from = deps.length ? deps : k ? [tasks[k - 1].id] : [];
    for (const d of from) {
      const A = pos.get(d), B = pos.get(t.id), live = A.t.status === "done" && ["assigned", "running", "review", "revising"].includes(t.status);
      f.append(svg("path", { class: `edge${A.t.status === "done" ? " done" : ""}${live ? " live" : ""}`, d: `M${A.x} ${A.y} C${(A.x + B.x) / 2} ${A.y} ${(A.x + B.x) / 2} ${B.y} ${B.x} ${B.y}` }));
    }
  });
  for (const { x: cx, y: cy, t } of pos.values()) {
    const who = agentById(t.assignee);
    f.append(svg("circle", { class: `node ${t.status}`, cx, cy, r: 9 }, title(`${t.title}: ${STATUS_TEXT[t.status] || t.status}${who ? `, ${who.name}` : ""}`)));
    f.append(text(clip(t.title, Math.max(8, Math.floor(step / 6.4))), { class: "o-board-ink", x: cx, y: cy + 25, "text-anchor": "middle", "font-size": 11 }));
    f.append(text(`${STATUS_TEXT[t.status] || t.status}${who ? ` · ${who.name}` : ""}`, { class: "o-board-muted", x: cx, y: cy + 39, "text-anchor": "middle", "font-size": 10 }));
  }
  return { node: f, h };
}

function render2d() {
  if (!state) { planEl.replaceChildren(); return; }
  const focused = document.activeElement?.dataset?.agent || "";
  const agents = state.agents, n = agents.length;
  const narrow = planEl.clientWidth && planEl.clientWidth < 620;
  const cols = Math.max(1, Math.min(narrow ? 2 : 3, n)), rows = Math.max(1, Math.ceil(n / cols));
  const CW = narrow ? 200 : 240, CH = 206, pad = 12;
  const W = pad * 2 + Math.max(cols, 2) * CW;
  const parts = [];
  // the boards: side by side, or stacked on a narrow screen
  const g = state.goal;
  let y = pad, boardLines = [];
  if (narrow) {
    const b = boardSvg(g, pad, y, W - pad * 2, 6); parts.push(b.node); boardLines = b.lines; y += b.h + 10;
    const f = flowSvg(g?.tasks || [], pad, y, W - pad * 2); parts.push(f.node); y += f.h + 12;
  } else {
    const bw = Math.round((W - pad * 2 - 12) * 0.55), b = boardSvg(g, pad, y, bw, 7), f = flowSvg(g?.tasks || [], pad + bw + 12, y, W - pad * 2 - bw - 12);
    parts.push(b.node, f.node); boardLines = b.lines; y += Math.max(b.h, f.h) + 12;
  }
  dbg.board = boardLines;
  // the door and its light
  const lit = state.pendingApprovals > 0, doorY = y;
  parts.push(svg("g", { class: "door", "data-door": "1" },
    lit ? svg("rect", { class: "door-halo lit halo", x: pad + 6, y: doorY + 5, width: 28, height: 14, rx: 7 }) : null,
    svg("rect", { class: `door-lamp${lit ? " lit" : ""}`, x: pad + 8, y: doorY + 7, width: 24, height: 10, rx: 3 }),
    svg("rect", { class: "o-door", x: pad + 4, y: doorY + 22, width: 32, height: 40, rx: 3 }), svg("circle", { class: "o-knob", cx: pad + 30, cy: doorY + 44, r: 2 }),
    text("Approvals", { x: pad + 46, y: doorY + 30, "font-size": 11, class: "muted" }),
    text(lit ? `${state.pendingApprovals} waiting` : "None waiting", { x: pad + 46, y: doorY + 48, "font-size": 13, class: lit ? "disp amber" : "muted" }),
    title(lit ? `${state.pendingApprovals} pending approvals` : "No approvals waiting")));
  const floorTop = doorY + 72;
  const H = floorTop + rows * CH + pad;
  const svgRoot = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": "The office plan" });
  svgRoot.append(svg("rect", { class: "o-floor", x: 2, y: floorTop - 6, width: W - 4, height: H - floorTop + 2, rx: 12 }), ...parts);

  const seats = [];
  agents.forEach((a, i) => {
    const cx = pad + (i % cols) * CW + CW / 2 + (cols < 2 ? CW / 2 : 0), y0 = floorTop + Math.floor(i / cols) * CH + 4, col = safeColor(a.color);
    const seat = svg("g", { class: `seat st-${a.state}${selected === a.id ? " sel" : ""}`, tabindex: 0, role: "button", "data-agent": a.id, "data-state": a.state, "aria-label": `${a.name}, ${STATE_TEXT[a.state].toLowerCase()}${a.helpers.length ? `, ${a.helpers.length} helper${a.helpers.length > 1 ? "s" : ""}` : ""}. Show details.` });
    seat.style.setProperty("--agent", col);
    const dw = narrow ? 136 : 152;
    const desk = svg("rect", { class: "o-desk", x: cx - dw / 2, y: y0 + 58, width: dw, height: 58, rx: 10 }); desk.style.stroke = col;
    const avatar = svg("g", { class: "avatar" }, svg("circle", { cx, cy: y0 + 30, r: 21, class: "av" }), text(a.avatar, { class: "glyph", x: cx, y: y0 + 31, "font-size": 19 }));
    avatar.querySelector(".av").style.fill = col;
    seat.append(svg("rect", { class: "hit", x: cx - CW / 2 + 6, y: y0, width: CW - 12, height: CH - 12 }), desk, avatar);
    seat.append(svg("rect", { class: "o-monitor", x: cx - 30, y: y0 + 66, width: 60, height: 14, rx: 3 }), svg("circle", { class: "lamp", cx: cx + dw / 2 - 18, cy: y0 + 73, r: 6 }));
    if (a.task?.progress !== undefined) seat.append(svg("rect", { class: "o-bar", x: cx - 60, y: y0 + 102, width: 120, height: 4, rx: 2 }), svg("rect", { class: "o-fill", x: cx - 60, y: y0 + 102, width: 120 * a.task.progress, height: 4, rx: 2 }));
    if (a.state === "waiting_approval") seat.append(svg("circle", { class: "halo", cx: cx + dw / 2 - 18, cy: y0 + 73, r: 16 }), svg("path", { class: "hand", d: `M${cx + 20} ${y0 + 36} L${cx + 34} ${y0 + 8}` }), svg("circle", { class: "amber", cx: cx + 34, cy: y0 + 6, r: 5 }));
    if (a.state === "working") seat.append(svg("g", { class: "typing" }, [0, 1, 2].map((k) => svg("circle", { cx: cx - 12 + k * 12, cy: y0 + 92, r: 3.2 }))));
    const jx = cx - dw / 2 - 20; // the judge's stand, just left of the desk
    if (a.state === "judged") seat.append(svg("circle", { class: "judge-glow", cx: jx, cy: y0 + 92, r: 20 }), svg("path", { class: "stand", d: `M${jx - 12} ${y0 + 104} l5 -28 h14 l5 28 z` }), svg("rect", { class: "stand", x: jx - 13, y: y0 + 70, width: 26, height: 6, rx: 2, opacity: 0.8 }));
    a.helpers.slice(0, 4).forEach((h, k) => {
      const hc = safeColor(agentById(h.agentId)?.color || a.color);
      const dot = svg("circle", { class: `helper${h.readOnly ? " ro" : ""}`, "data-helper": h.id, cx: cx + dw / 2 + 14 + (k % 2) * 16, cy: y0 + 64 + Math.floor(k / 2) * 18, r: 7 }, title(`Helper: ${h.title || h.agentId}${h.readOnly ? " (reads only)" : ""}, ${STATE_TEXT[h.state].toLowerCase()}`));
      dot.style.fill = hc; seat.append(dot);
    });
    if (a.helpers.length > 4) seat.append(text(`+${a.helpers.length - 4}`, { x: cx + 100, y: y0 + 110, "font-size": 11, "text-anchor": "middle", class: "muted" }));
    const line = a.state === "idle" || a.state === "offline" ? (a.role || "") : chipText(a);
    seat.append(text(a.name, { class: "disp", x: cx, y: y0 + 140, "text-anchor": "middle", "font-size": 16 }),
      text(STATE_TEXT[a.state] + (a.task?.progress !== undefined ? ` · ${Math.round(a.task.progress * 100)}%` : ""), { class: "stt", x: cx, y: y0 + 157, "text-anchor": "middle", "font-size": 12 }),
      line ? text(clip(line, narrow ? 28 : 34), { class: "muted", x: cx, y: y0 + 173, "text-anchor": "middle", "font-size": 11 }) : null, title(`${a.name}: ${STATE_TEXT[a.state]}${a.taskTitle ? `. ${a.taskTitle}` : ""}`));
    const pickIt = () => select(a.id);
    seat.addEventListener("click", pickIt);
    seat.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickIt(); } });
    svgRoot.append(seat); seats.push(seat);
  });
  planEl.replaceChildren(svgRoot);
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
    api("/rooms").then((rooms) => { const r = rooms.find((x) => x.id === roomId); $("#roomName").textContent = r && !r.dmAgentId ? `#${r.name}` : "All rooms"; }).catch(() => {}),
  ]);
  const d = decide();
  await setMode(d.mode, d.why);
  connectWs();
  setInterval(() => { if (isVisible()) refreshSoon(); }, 20000); // a safety net for any event that never arrived; it also keeps "started 12 min ago" fresh
  dbg.ready = true;
}
void main();
