// Agent Room on the phone. Served by the hub; talks to the same API as the Mac app.
"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  const TOKEN_KEY = "agentroom.token";

  const st = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    ownerName: "",
    view: "rooms",          // rooms | room | approvals | diff | permissions | folders | control | subscriptions | remote | personas | persona | resumes | scorecard | appearance | pair
    tools: [], control: null, quota: [], remote: null, firstPass: null, memExport: [], resumes: null, probationCount: 0,
    scorecard: null, scWeek: "this", ledger: null, attention: null, // 2.7
    rooms: [], agents: {}, roomId: "", messages: [], goals: {}, tasks: {}, goalOpen: {}, working: {}, approvals: [],
    // 3.1: the jump sheet (the Mac's Command-K): the query, the highlighted row and the rows on show
    jump: { open: false, q: "", idx: 0, rows: [] },
    unread: new Set(), readAt: 0, readSent: {}, positioned: "",
    online: false, ws: null, wsDelay: 1000,
    capacity: null,
    // 1.1 file access: folder grants, the write proposals behind file approvals (full diffs), and the approval open for review
    // `proposals` is the diff-less list (for the Folders screen); `full` holds each approval's whole proposal, fetched by id
    grants: null, proposals: null, proposalsErr: "", reviewId: "", full: {}, fullErr: {}, fullLoading: {},
    gform: { path: "", label: "", roomId: "", agentId: "*", read: true, write: false, err: "", busy: false, override: null },
    // a goal can work in a granted folder: the grants this room can use, the one picked, and whether the picker is open
    roomGrants: [], folderId: "", folderOpen: false,
    // 3.2 personas: the starter templates, the agent being edited and its form
    personas: { templates: [], id: "", form: null, err: "", busy: false },
  };

  // ---------- helpers
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#5e6875");
  // 3.1: an agent's own colour, nudged until it shows on this mode's canvas, with an ink that reads on it
  const tile = (color) => ARView.agentTone(safeColor(color), window.ARTheme.canvas());
  const avatar = (a, name, cls) => `<span class="av${cls ? ` ${cls}` : ""}"${cls ? "" : ` data-color="${esc(safeColor(a && a.color))}"`}>${esc(glyph(a, name))}</span>`;
  // 3.2: the avatar is the persona's letter or emoji; without one, the first letter of the name
  const glyph = (a, name) => (a && a.avatar) || (name || (a && a.name) || "?")[0].toUpperCase();
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayLabel = (t) => {
    const d = new Date(t), today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  };
  const isStandalone = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const visibleMsg = (m) => !m.quiet && m.author.kind !== "orchestrator" && m.type !== "directive";
  const roomName = (r) => (r.dmAgentId ? (st.agents[r.dmAgentId]?.name || r.dmAgentId) : r.name);

  let toastTimer;
  function toast(text) {
    const el = $("#toast"); el.textContent = text; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(st.token ? { authorization: `Bearer ${st.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/pair") { signOut("This phone isn't paired anymore. Pair it again."); throw new Error("unpaired"); }
    if (!res.ok) throw Object.assign(new Error(body.error || `The hub returned ${res.status}.`), { canForce: body.canForce === true, because: body.because, code: body.code });
    return body;
  }

  // Light markdown: everything is escaped first, then a few safe patterns are turned back on.
  function md(src) {
    const blocks = [];
    let s = esc(src).replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    const inline = (t) => t
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
      .replace(/(^|\s)@([A-Za-z0-9_-]+)/g, '$1<span class="mention">@$2</span>');
    const out = []; let list = [];
    const flush = () => { if (list.length) { out.push(`<ul>${list.map((li) => `<li${li.sub ? ' class="sub"' : ""}>${inline(li.text)}</li>`).join("")}</ul>`); list = []; } };
    for (const line of s.split("\n")) {
      const b = line.match(/^(\s*)[-*•]\s+(.*)$/) || line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      if (b) { list.push({ text: b[2], sub: b[1].length >= 2 }); continue; }
      flush();
      if (/^\u0000\d+\u0000$/.test(line.trim())) { out.push(line.trim()); continue; }
      const h = line.match(/^#{1,4}\s+(.*)$/);
      if (h) out.push(`<p class="h">${inline(h[1])}</p>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    flush();
    return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  // ---------- pairing
  function signOut(reason) {
    st.token = ""; localStorage.removeItem(TOKEN_KEY);
    if (st.ws) { st.ws.onclose = null; st.ws.close(); st.ws = null; }
    st.view = "pair"; render();
    if (reason) toast(reason);
  }

  function renderPair() {
    const homeHint = isIOS() && !isStandalone()
      ? `<div class="hint"><b>Add to Home Screen first.</b> Tap Share, then “Add to Home Screen”, and pair from the icon it makes. Safari and the home-screen app keep separate logins, so pairing here won't carry over.</div>`
      : "";
    $("#view").innerHTML = `
      <form class="pair" id="pairForm">
        <h1>Pair this phone</h1>
        <p>On your Mac, open Agent Room → Settings → Pair your phone. Enter the 6-digit code shown there. It works once and lasts 10 minutes.</p>
        ${homeHint}
        <label for="code">Pairing code</label>
        <input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required>
        <label for="device">Name this phone</label>
        <input id="device" value="${esc(/iPad/.test(navigator.userAgent) ? "iPad" : "iPhone")}" maxlength="80" required>
        <button class="btn" type="submit">Pair</button>
        <div class="err" id="pairErr"></div>
      </form>`;
    $("#pairForm").onsubmit = async (e) => {
      e.preventDefault();
      const code = $("#code").value.trim(), deviceName = $("#device").value.trim() || "Phone";
      try {
        const r = await api("/pair", { method: "POST", body: { code, deviceName } });
        st.token = r.token; st.ownerName = r.ownerName; localStorage.setItem(TOKEN_KEY, r.token);
        st.view = "rooms"; await start();
      } catch (err) { $("#pairErr").textContent = err.message; }
    };
    setTimeout(() => $("#code")?.focus(), 50);
  }

  // ---------- live events
  function connectWs() {
    if (st.ws || !st.token) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(st.token)}`);
    st.ws = ws;
    ws.onopen = () => { st.online = true; st.wsDelay = 1000; renderDot(); void refresh(); };
    ws.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
    ws.onclose = () => {
      st.online = false; st.ws = null; renderDot();
      if (st.token) setTimeout(connectWs, (st.wsDelay = Math.min(st.wsDelay * 2, 15000)));
    };
  }

  function onEvent(e) {
    switch (e.type) {
      case "hello": st.ownerName = e.ownerName; break;
      case "message": {
        const m = e.message;
        if (m.roomId === st.roomId && st.view === "room") {
          if (!st.messages.some((x) => x.id === m.id)) { st.messages.push(m); markRead(m.roomId, m.createdAt); renderMessages(m.author.kind === "human"); }
        } else if (visibleMsg(m) && m.author.kind !== "human") { st.unread.add(m.roomId); if (st.view === "rooms") renderRooms(); }
        break;
      }
      case "goal": st.goals[e.goal.id] = e.goal; if (e.goal.roomId === st.roomId) { renderMessages(); renderComposerState(); } break;
      case "task": if (e.task.roomId === st.roomId) { st.tasks[e.task.id] = e.task; if (st.view === "room") renderMessages(); } break; // 3.1: the verdict chips and the goal card
      case "working": {
        const w = (st.working[e.roomId] ||= {});
        if (e.active) w[e.agentId] = e.label || ""; else delete w[e.agentId];
        if (e.roomId === st.roomId) renderComposerState();
        break;
      }
      case "approval": {
        st.approvals = st.approvals.filter((a) => a.id !== e.approval.id);
        if (e.approval.status === "pending") st.approvals.unshift(e.approval);
        renderBadge(); if (st.view === "approvals") renderApprovals();
        if (st.view === "diff" && st.reviewId === e.approval.id && e.approval.status !== "pending") go("approvals"); // decided elsewhere (the Mac)
        break;
      }
      case "room": {
        const i = st.rooms.findIndex((r) => r.id === e.room.id);
        if (i >= 0) st.rooms[i] = e.room; else st.rooms.push(e.room);
        if (st.view === "rooms") renderRooms();
        break;
      }
      case "room_deleted":
        st.rooms = st.rooms.filter((r) => r.id !== e.roomId);
        if (st.roomId === e.roomId) go("rooms"); else if (st.view === "rooms") renderRooms();
        break;
      case "agent": st.agents[e.agent.id] = e.agent; if (st.view === "permissions") renderPermissions(); else if (st.view === "personas") renderPersonas(); break;
      case "read": if (st.unread.delete(e.roomId) && st.view === "rooms") renderRooms(); break;
      case "control": loadControl().catch(() => {}); break;
    }
  }

  // Read marks live on the hub, so the Mac and the phone agree on what's new.
  function markRead(roomId, at) {
    st.unread.delete(roomId);
    if ((st.readSent[roomId] || 0) >= at) return;
    st.readSent[roomId] = at;
    api(`/rooms/${roomId}/read`, { method: "PUT", body: { at } }).catch(() => {});
  }

  // ---------- data
  async function start() {
    render();
    try {
      const [rooms, agents, approvals] = await Promise.all([api("/rooms"), api("/agents"), api("/approvals?status=pending")]);
      st.rooms = rooms; st.agents = Object.fromEntries(agents.map((a) => [a.id, a])); st.approvals = approvals;
      connectWs(); render(); loadControl().catch(() => {});
      // 1.5: what the hub found about its computer, one line under Settings
      api("/capacity").then((c) => { st.capacity = c; if (st.view === "rooms") renderRooms(); }).catch(() => {});
      api("/resumes").then((r) => { st.probationCount = r.filter((x) => x.probation.on).length; if (st.view === "rooms") renderRooms(); }).catch(() => {}); // 2.3: "2 on probation" under Résumés
    } catch (err) { if (err.message !== "unpaired") toast(`Can't reach the hub: ${err.message}`); }
  }

  // Catch up after the phone wakes or the connection comes back.
  async function refresh() {
    if (!st.token) return;
    try {
      const [rooms, approvals] = await Promise.all([api("/rooms"), api("/approvals?status=pending")]);
      st.rooms = rooms; st.approvals = approvals; renderBadge();
      if (st.view === "room" && st.roomId) await loadRoom(st.roomId, true);
      else if (st.view === "rooms") renderRooms();
      else if (st.view === "approvals") renderApprovals();
    } catch { /* offline; the socket will retry */ }
  }

  async function loadRoom(id, keepScroll) {
    const [msgs, goals, mark, tasks] = await Promise.all([api(`/rooms/${id}/messages?limit=200`), api(`/rooms/${id}/goals`), api(`/rooms/${id}/read`).catch(() => ({ at: 0 })), api(`/rooms/${id}/tasks`).catch(() => [])]);
    if (st.roomId !== id) return;
    if (!keepScroll) st.readAt = mark.at; // frozen for this visit so the "New" line stays put
    st.messages = msgs; for (const g of goals) st.goals[g.id] = g; for (const t of tasks) st.tasks[t.id] = t;
    renderMessages(); renderComposerState();
    // 1.1: folders this room's goals can work in (open to every agent and readable). The hub checks again when the message is sent.
    api(`/folder-grants?roomId=${encodeURIComponent(id)}`).then((gs) => { if (st.roomId === id) { st.roomGrants = gs.filter((g) => g.agentId === "*" && g.read); renderFolderPick(); } }).catch(() => {});
    const last = msgs[msgs.length - 1]; if (last) markRead(id, last.createdAt);
  }

  // ---------- views
  function go(view, roomId) {
    st.view = view;
    $("#jumpNew").hidden = true;
    if (view === "room") { st.roomId = roomId; st.messages = []; st.goals = {}; st.tasks = {}; st.readAt = 0; st.positioned = ""; st.unread.delete(roomId); st.roomGrants = []; st.folderId = ""; st.folderOpen = false; }
    else st.roomId = "";
    render();
    if (view === "room") loadRoom(roomId).catch((e) => { if (e.message !== "unpaired") toast(e.message); });
  }

  function render() {
    if (!st.token) st.view = "pair";
    $("#back").hidden = st.view === "rooms" || st.view === "pair";
    $("#composer").hidden = st.view !== "room";
    const room = st.rooms.find((r) => r.id === st.roomId);
    $("#title").textContent = st.view === "room" && room ? (room.dmAgentId ? roomName(room) : room.name)
      : st.view === "approvals" ? "Approvals" : st.view === "diff" ? "Review change" : st.view === "folders" ? "Folders" : st.view === "permissions" ? "Permissions" : st.view === "control" ? "Control files" : st.view === "subscriptions" ? "Subscriptions" : st.view === "remote" ? "Remote access" : st.view === "scorecard" ? "Scorecard" : st.view === "personas" ? "Personas" : st.view === "persona" ? (st.agents[st.personas.id]?.name || "Persona") : "Agent Room";
    renderDot(); renderBadge();
    if (st.view === "resumes") $("#title").textContent = "Résumés"; // 2.3
    if (st.view === "appearance") $("#title").textContent = "Appearance"; // 3.1
    $("#jumpBtn").hidden = st.view === "pair";
    renderGoal();
    if (st.view === "pair") return renderPair();
    if (st.view === "rooms") return renderRooms();
    if (st.view === "approvals") return renderApprovals();
    if (st.view === "diff") return renderReview();
    if (st.view === "folders") return renderFolders();
    if (st.view === "permissions") return renderPermissions();
    if (st.view === "control") return renderControl();
    if (st.view === "subscriptions") return renderSubscriptions();
    if (st.view === "remote") return renderRemote();
    if (st.view === "resumes") return renderResumes(); // 2.3
    if (st.view === "scorecard") return renderScorecard();
    if (st.view === "appearance") return renderAppearance();
    if (st.view === "personas") return renderPersonas();
    if (st.view === "persona") return renderPersona();
    renderMessages(); renderComposerState();
  }

  function renderDot() { $("#dot").classList.toggle("on", st.online); $("#dot").hidden = st.view === "pair"; }
  function renderBadge() {
    const n = st.approvals.length;
    $("#approvalsBtn").hidden = !n || st.view === "pair" || st.view === "approvals" || st.view === "diff";
    $("#approvalsCount").textContent = String(n);
  }

  function renderRooms() {
    const channels = st.rooms.filter((r) => !r.dmAgentId).sort((a, b) => a.name.localeCompare(b.name));
    const dms = st.rooms.filter((r) => r.dmAgentId).sort((a, b) => roomName(a).localeCompare(roomName(b)));
    const row = (r) => {
      const a = r.dmAgentId ? st.agents[r.dmAgentId] : null;
      const lead = a ? `<span class="lead">${avatar(a)}</span>` : `<span class="lead"><span class="mark${st.unread.has(r.id) ? " new" : ""}"></span></span>`;
      return `<button class="row" data-room="${esc(r.id)}">${lead}<span class="name">${esc(roomName(r))}</span>${r.paused ? '<span class="sub">paused</span>' : ""}${st.unread.has(r.id) ? '<span class="unread"></span>' : ""}</button>`;
    };
    $("#view").innerHTML = st.rooms.length
      ? `${channels.length ? `<div class="section">Rooms</div>${channels.map(row).join("")}` : ""}
         ${dms.length ? `<div class="section">Agents</div>${dms.map(row).join("")}` : ""}`
      : `<div class="empty">No rooms yet. Make one on the Mac.</div>`;
    const nCtl = st.control ? st.control.notices.length : 0;
    $("#view").innerHTML += `<div class="section">Settings</div><button class="row" data-nav="permissions"><span class="hash">⚙︎</span><span class="name">Permissions</span></button>
      <button class="row" data-nav="folders"><span class="hash">▤</span><span class="name">Folders</span></button>
      <button class="row" data-nav="resumes"><span class="hash">☰</span><span class="name">Résumés</span>${st.probationCount ? `<span class="sub">${st.probationCount} on probation</span>` : ""}</button>
      <button class="row" data-nav="remote"><span class="hash">⇄</span><span class="name">Remote access</span></button>
      <button class="row" data-nav="subscriptions"><span class="hash">☷</span><span class="name">Subscriptions</span></button>
      <button class="row" data-nav="personas"><span class="hash">☺</span><span class="name">Personas</span></button>
      <button class="row" data-nav="scorecard"><span class="hash">▥</span><span class="name">Scorecard</span></button>
      <button class="row" data-nav="appearance"><span class="hash">☾</span><span class="name">Appearance</span></button>
      <button class="row" data-nav="control"><span class="hash">⚙︎</span><span class="name">Control files</span>${nCtl ? `<span class="sub">${nCtl} to look at</span>` : ""}</button>${st.capacity ? `<div class="capline">${esc(st.capacity.summary)}</div>` : ""}`;
    paintColors();
  }

  // 3.1 Appearance: System follows the phone; Light and Dark stay as chosen. Kept on this phone only.
  function renderAppearance() {
    const cur = window.ARTheme.mode();
    $("#view").replaceChildren(
      h("div", { class: "section", text: "Appearance" }),
      h("div", { class: "seg", role: "radiogroup", "aria-label": "Appearance" },
        ["system", "light", "dark"].map((m) => h("button", { type: "button", role: "radio", "aria-checked": cur === m ? "true" : "false", "data-theme-mode": m, text: m === "system" ? "System" : m === "light" ? "Light" : "Dark" }))),
      h("div", { class: "capline", text: "System follows your phone. Light and Dark stay as you choose." }));
  }

  // 3.2 Personas: how each agent sounds. The hub keeps it in the agent's SOUL.md (or in the agent's record when there is no control folder).
  // It shapes the agent's messages and is left out when its work is judged.
  function renderPersonas() {
    const agents = Object.values(st.agents).sort((a, b) => a.name.localeCompare(b.name));
    $("#view").innerHTML = `<div class="card"><div class="what">How each agent sounds</div><div class="detail">A persona shapes how an agent writes in the room. It is left out when its work is judged, so it never changes a score.</div></div>`
      + (agents.length ? agents.map((a) => `<button class="row" data-persona="${esc(a.id)}"><span class="lead">${avatar(a)}</span><span class="name">${esc(a.name)}</span></button>`).join("") : `<div class="empty">No agents yet.</div>`);
    paintColors();
  }

  async function openPersona(id) {
    const p = st.personas;
    Object.assign(p, { id, form: null, err: "", busy: false });
    go("persona");
    try {
      const [view, templates] = await Promise.all([api(`/agents/${encodeURIComponent(id)}/persona`), p.templates.length ? p.templates : api("/personas/templates")]);
      p.templates = templates;
      if (p.id !== id) return;
      p.form = { name: view.name, color: safeColor(view.color).length === 7 ? safeColor(view.color) : "#5e6875", avatar: view.avatar || "", role: view.role, tone: view.tone, body: (view.body || "").trim(), template: view.template || "" };
      if (st.view === "persona") renderPersona();
    } catch (e) { if (e.message !== "unpaired") toast(e.message); }
  }

  function renderPersona() {
    const p = st.personas, f = p.form;
    if (!f) { $("#view").innerHTML = `<div class="empty">Loading…</div>`; return; }
    const field = (id, label, input) => h("div", { class: "field" }, h("label", { for: id, text: label }), input);
    const inp = (key, extra) => h("input", { ...extra, id: `pf_${key}`, "data-pform": key, value: f[key], autocomplete: "off" }); // type first, so a colour input keeps its value
    const tpl = h("select", { id: "pf_template", "data-pform": "template" },
      h("option", { value: "", text: "Start from a template…", selected: !f.template }),
      p.templates.map((t) => h("option", { value: t.id, text: `${t.label}: ${t.summary}`, selected: t.id === f.template })));
    const form = h("form", { class: "gform", id: "personaForm", autocomplete: "off" },
      field("pf_template", "Template", tpl),
      field("pf_name", "Name", inp("name", { maxLength: 60 })),
      field("pf_color", "Colour", inp("color", { type: "color" })),
      field("pf_avatar", "Avatar (a letter or an emoji)", inp("avatar", { maxLength: 8, placeholder: "Leave empty for the first letter" })),
      field("pf_role", "Role", inp("role", { maxLength: 200, placeholder: "What it does, in a few words" })),
      field("pf_tone", "Tone", inp("tone", { maxLength: 200, placeholder: "How it sounds, in a few words" })),
      field("pf_body", "Bio and voice notes", h("textarea", { id: "pf_body", "data-pform": "body", rows: 9, value: f.body, maxLength: 6000, placeholder: "Describe how this agent writes. Voice only: it never changes what a task asks for." })),
      h("div", { class: "err", id: "pfErr", role: "alert", text: p.err }),
      h("button", { class: "btn", type: "submit", id: "pfSave", text: p.busy ? "Saving…" : "Save", disabled: p.busy }));
    $("#view").replaceChildren(form);
  }

  async function savePersona() {
    const p = st.personas, f = p.form; if (!f || p.busy) return;
    p.busy = true; p.err = ""; const b = $("#pfSave"); if (b) { b.disabled = true; b.textContent = "Saving…"; }
    try {
      const v = await api(`/agents/${encodeURIComponent(p.id)}/persona`, { method: "PUT", body: { name: f.name, color: f.color, avatar: f.avatar, role: f.role, tone: f.tone, body: f.body } });
      st.agents[p.id] = { ...st.agents[p.id], name: v.name, color: v.color, avatar: v.avatar || undefined };
      f.template = v.template || ""; toast("Saved");
    } catch (e) { if (e.message === "unpaired") return; p.err = e.message; }
    finally { p.busy = false; if (st.view === "persona") renderPersona(); }
  }

  // The control folder (CONTROL.md): where the rules, personas and permissions live as plain files on the Mac.
  function renderControl() {
    const c = st.control;
    if (!c) { $("#view").innerHTML = `<div class="empty">Loading…</div>`; return; }
    const when = c.lastLoad ? new Date(c.lastLoad).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "not yet";
    const notes = c.notices.length ? c.notices.map((n) => `
      <div class="card">
        <div class="what">${esc(n.file)}${n.line ? `, line ${esc(n.line)}` : ""}</div>
        <div class="detail">${esc(n.message)}</div>
      </div>`).join("") : `<div class="empty">No problems in the control files.</div>`;
    $("#view").innerHTML = `
      <div class="card">
        <div class="what">Folder on your Mac</div>
        <div class="detail">${esc(c.root)}\n\nLast read ${esc(when)}. ${c.git ? "Every change is saved in its history." : "History is off because git isn't installed."}</div>
        <div class="actions"><button class="btn small plain" data-control="lint">Check files</button></div>
      </div>
      <div class="section">${c.notices.length ? `Needs a look (${c.notices.length})` : "Notices"}</div>${notes}`;
  }

  async function loadControl() {
    try {
      st.control = await api("/control/status");
      if (st.view === "control") renderControl(); else if (st.view === "rooms") renderRooms();
    } catch (e) { if (e.message === "unpaired") throw e; /* older hub without control files */ }
  }

  function renderApprovals() {
    // 1.1: a file write is never approved from the preview text. It opens the full diff (renderReview) instead.
    wantProposals();
    $("#view").innerHTML = st.approvals.length ? st.approvals.map((a) => a.question ? questionCard(a) : ARDiff.isFileWriteApproval(a) ? fileApprovalCard(a) : `
      <div class="card">
        <div class="what">${esc(st.agents[a.agentId]?.name || a.agentId)} wants to ${esc(a.action)}</div>
        <div class="detail">Using ${esc(a.tool)}${a.detail ? `\n\n${esc(a.detail)}` : ""}</div>
        <div class="actions">
          <button class="btn small" data-approval="${esc(a.id)}" data-decision="approved">Approve</button>
          <button class="btn small plain" data-approval="${esc(a.id)}" data-decision="rejected">Reject</button>
        </div>
      </div>`).join("") : `<div class="empty">Nothing waiting for you.</div>`;
  }

  // 2.5: a memory question (two facts disagree) has its own answers, not Approve and Reject
  function questionCard(a) {
    const first = a.question.choices[0]?.id;
    return `<div class="card">
        <div class="what">The room remembers two different things</div>
        <div class="detail">${esc(a.action)}\n\n${esc(a.detail || "")}</div>
        <div class="actions">${a.question.choices.map((c) => `<button class="btn small${c.id === first ? "" : " plain"}" data-answer="${esc(a.id)}" data-choice="${esc(c.id)}">${esc(c.label)}</button>`).join("")}</div>
      </div>`;
  }

  // ---------- 1.1 file writes: the full diff, read to the end before Approve
  const proposalFor = (a) => st.full[a.id];
  const agentName = (id) => st.agents[id]?.name || id;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // A task writes several files: what each does, and the ones that will not be written.
  const fileList = (p) => (p.kind === "task" && p.files?.length ? `<div class="detail">${p.files.map((f) => `${esc(ARDiff.opWords(f.op))}: ${esc(f.relPath)}`).join("\n")}</div>` : "");
  const skippedList = (p) => (p.skipped?.length ? `<div class="detail warn">${esc(plural(p.skipped.length, "file", "files"))} won't be written:\n${p.skipped.map((x) => `${esc(x.relPath)}: ${esc(x.reason)}`).join("\n")}</div>` : "");
  const proposalTitle = (p) => (p.kind === "task" ? `write ${plural(p.files?.length || 0, "file", "files")} from "${p.title || "a task"}"` : `${p.baseSha256 ? "change" : "create"} ${p.relPath}`);

  function fileApprovalCard(a) {
    const p = proposalFor(a);
    const who = esc(agentName(a.agentId));
    const reject = `<button class="btn small plain" data-approval="${esc(a.id)}" data-decision="rejected">Reject</button>`;
    if (!p) {
      const loading = st.fullLoading[a.id], err = st.fullErr[a.id];
      const msg = loading || (!err && !triedProposals.has(a.id)) ? "Loading the full change…" : err ? `Can't load the full change: ${esc(err)}` : "The full change isn't available, so it can't be approved here. You can reject it.";
      return `<div class="card"><div class="what">${who} wants to ${esc(a.action)}</div><div class="detail">${msg}</div>
        <div class="actions">${loading ? "" : `<button class="btn small plain" data-reload="proposals">Try again</button>`}${reject}</div></div>`;
    }
    const d = ARDiff.parseChangeDiff(p.diff, p.files);
    return `<div class="card"><div class="what">${who} wants to ${esc(proposalTitle(p))}</div>
      <div class="detail"><span class="plus">+${d.added}</span> <span class="minus">-${d.removed}</span> in ${plural(d.places, "place", "places")}.${p.unappliable ? "" : " Open the full change to approve it."}</div>
      ${fileList(p)}${skippedList(p)}
      ${p.unappliable ? `<div class="detail warn">Can't be applied: ${esc(p.unappliable)}</div>` : ""}
      ${d.problem ? `<div class="detail warn">${esc(d.problem)}</div>` : ""}
      <div class="actions">${p.unappliable ? "" : `<button class="btn small" data-review="${esc(a.id)}">Review change</button>`}${reject}</div></div>`;
  }

  // The full change is one proposal, fetched by the approval's proposalId (GET /write-proposals/:id), once per approval.
  // The list route has no diffs; it only backs the guarded fallbacks in ARDiff.fetchProposalForApproval.
  const triedProposals = new Set();
  function wantProposals() {
    for (const a of st.approvals) {
      if (!ARDiff.isFileWriteApproval(a) || proposalFor(a) || triedProposals.has(a.id) || st.fullLoading[a.id]) continue;
      triedProposals.add(a.id);
      void loadFull(a);
    }
  }

  async function loadFull(a) {
    delete st.fullErr[a.id]; st.fullLoading[a.id] = true;
    try {
      const p = await ARDiff.fetchProposalForApproval(a, { one: (id) => api(`/write-proposals/${id}`), list: () => api("/write-proposals") });
      if (p) st.full[a.id] = p;
    } catch (e) { if (e.message === "unpaired") return; st.fullErr[a.id] = e.message; }
    finally { st.fullLoading[a.id] = false; }
    if (st.view === "approvals") renderApprovals(); else if (st.view === "diff") renderReview();
  }

  const h = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v;
      else if (k.startsWith("data-") || k.startsWith("aria-") || k === "for" || k === "role") e.setAttribute(k, v === true ? "" : v);
      else e[k] = v;
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  };

  const ROWS_PER_CHUNK = 250;
  let review = null; // the diff on screen: rows, how many are drawn, and whether Approve has been earned

  function renderReview() {
    const view = $("#view");
    const a = st.approvals.find((x) => x.id === st.reviewId);
    if (!a) { view.replaceChildren(h("div", { class: "empty", text: "This one was already decided." })); review = null; return; }
    const p = proposalFor(a);
    if (!p) {
      const loading = st.fullLoading[a.id], err = st.fullErr[a.id];
      view.replaceChildren(h("div", { class: "empty", text: loading ? "Loading the full change…" : err ? `Can't load the full change: ${err}` : "The full change isn't available, so it can't be approved here." }),
        h("div", { class: "actions pad" }, loading ? null : h("button", { class: "btn small plain", "data-reload": "proposals", text: "Try again" }),
          h("button", { class: "btn small plain", "data-approval": a.id, "data-decision": "rejected", text: "Reject" })));
      wantProposals();
      review = null; return;
    }
    const d = ARDiff.parseChangeDiff(p.diff, p.files);
    const rows = ARDiff.flattenChange(d);
    const task = p.kind === "task";
    const title = task ? `${plural(p.files?.length || 0, "file", "files")} from "${p.title || "a task"}"` : p.relPath;
    const head = h("div", { class: "dv-head" },
      h("div", { class: "dv-path", text: title }),
      h("div", { class: "dv-sub" }, task ? `${agentName(a.agentId)} finished this task and wants to write its files to your folder. ` : `${agentName(a.agentId)} ${p.baseSha256 ? "wants to change this file" : "wants to create this file"}. `,
        h("span", { class: "plus", text: `+${d.added}` }), " ", h("span", { class: "minus", text: `-${d.removed}` }), ` in ${plural(d.places, "place", "places")}${d.sections.length > 1 ? ` across ${d.sections.length} files` : ""}.`),
      p.unappliable ? h("div", { class: "detail warn", text: `Can't be applied: ${p.unappliable}` }) : null,
      p.skipped?.length ? h("div", { class: "detail warn", text: `${plural(p.skipped.length, "file", "files")} won't be written:\n${p.skipped.map((x) => `${x.relPath}: ${x.reason}`).join("\n")}` }) : null,
      d.problem ? h("div", { class: "detail warn", text: d.problem }) : null);
    const body = h("div", { class: "dv-body", role: "region", "aria-label": `Changes to ${title}` });
    const hint = h("div", { class: "dv-hint" });
    // A change the hub says can't be applied only gets Reject.
    const approve = p.unappliable ? null : h("button", { class: "btn small", "data-approval": a.id, "data-decision": "approved", text: "Approve", disabled: true });
    const reject = h("button", { class: "btn small plain", "data-approval": a.id, "data-decision": "rejected", text: "Reject" });
    const bar = h("div", { class: "dv-bar" }, hint, h("div", { class: "actions" }, approve, reject));
    const more = h("div", { class: "dv-more", hidden: true, text: "Loading more…" });
    view.replaceChildren(head, body, more, bar);
    view.scrollTop = 0;
    review = { approvalId: a.id, rows, shown: 0, problem: d.problem || (p.unappliable ? "unappliable" : undefined), body, more, approve, hint, view, done: false };
    appendRows();
    // Fits on one screen: nothing to scroll, so nothing to gate. Otherwise the owner reads to the end first.
    requestAnimationFrame(updateGate);
  }

  // Rows go in a chunk at a time, so a huge diff never freezes the phone. All of it is still there: the end is the end of the diff.
  function appendRows() {
    const r = review; if (!r || r.shown >= r.rows.length) return;
    const frag = document.createDocumentFragment();
    const upto = Math.min(r.rows.length, r.shown + ROWS_PER_CHUNK);
    for (let i = r.shown; i < upto; i++) {
      const row = r.rows[i];
      if (row.type === "file") { frag.append(h("div", { class: `dl file ${row.op}` }, h("span", { class: "fp", text: row.path }), h("span", { class: "fo" }, `${ARDiff.opWords(row.op)} `, h("span", { class: "plus", text: `+${row.added}` }), " ", h("span", { class: "minus", text: `-${row.removed}` })))); continue; }
      if (row.type === "hunk") { frag.append(h("div", { class: "dl hunk", text: row.header })); continue; }
      const L = row.line;
      frag.append(h("div", { class: `dl ${L.kind}` },
        h("span", { class: "ln", text: String((L.kind === "del" ? L.oldNo : L.newNo) ?? "") }),
        h("span", { class: "mk", text: L.kind === "add" ? "+" : L.kind === "del" ? "-" : " " }),
        h("span", { class: "tx", text: L.text === "" ? " " : L.text })));
      if (L.noNewline) frag.append(h("div", { class: "dl note", text: "No newline at end of file" }));
    }
    r.shown = upto;
    r.body.append(frag);
    r.more.hidden = r.shown >= r.rows.length;
  }

  function updateGate() {
    const r = review; if (!r || st.view !== "diff") return;
    const v = r.view;
    if (!r.more.hidden && v.scrollTop + v.clientHeight >= v.scrollHeight - 600) { appendRows(); return updateGate(); }
    const allShown = r.shown >= r.rows.length;
    const gated = ARDiff.needsScrollGate(v.clientHeight, v.scrollHeight);
    const atEnd = allShown && ARDiff.scrolledToEnd(v.scrollTop, v.clientHeight, v.scrollHeight);
    if (atEnd || (!gated && allShown)) r.done = true;   // once read to the end it stays read
    const ok = r.done && !r.problem && allShown;
    if (r.approve) r.approve.disabled = !ok;
    r.hint.textContent = r.problem ? "This change can't be approved here. You can reject it." : ok ? "You've seen the whole change." : "Scroll to the end to approve.";
  }

  function renderFolders() {
    const v = $("#view");
    const form = st.gform;
    const rooms = [...st.rooms].sort((a, b) => roomName(a).localeCompare(roomName(b)));
    const agents = Object.values(st.agents).sort((a, b) => a.name.localeCompare(b.name));
    const field = (id, label, input) => h("div", { class: "field" }, h("label", { for: id, text: label }), input);
    const sel = (id, value, opts) => h("select", { id, "data-gform": id }, opts.map(([val, text]) => h("option", { value: val, text, selected: val === value })));
    const sw = (id, label, hint, on) => h("label", { class: "perm", for: id }, h("span", { class: "txt" }, h("span", { class: "lbl", text: label }), h("span", { class: "hint2", text: hint })),
      h("input", { type: "checkbox", id, role: "switch", class: "switch", "aria-label": label, "data-gform": id, checked: on }));
    const f = h("form", { class: "gform", id: "grantForm", autocomplete: "off" },
      h("div", { class: "section flush", text: "Add a folder" }),
      field("gfPath", "Folder on your Mac", h("input", { id: "gfPath", "data-gform": "gfPath", value: form.path, placeholder: "/Users/you/Documents/notes", autocapitalize: "off", autocorrect: "off", spellcheck: false, inputMode: "url" })),
      field("gfLabel", "Name (optional)", h("input", { id: "gfLabel", "data-gform": "gfLabel", value: form.label, maxLength: 80, placeholder: "Notes" })),
      field("gfRoom", "Room", sel("gfRoom", form.roomId, [["", "All rooms"], ...rooms.map((r) => [r.id, roomName(r)])])),
      field("gfAgent", "Agent", sel("gfAgent", form.agentId, [["*", "Any agent"], ...agents.map((a) => [a.id, a.name])])),
      sw("gfRead", "Read", "Agents can look at files here.", form.read),
      sw("gfWrite", "Write", "Agents can propose changes. Writes always come to you as changes to approve.", form.write),
      h("div", { class: "err", id: "gfErr", role: "alert", text: form.err }),
      form.override ? h("div", { class: "override", id: "gfOverride" },
        h("div", { class: "ot", text: form.override.because ? `This folder is normally kept private: ${form.override.because}.` : "This folder is normally kept private." }),
        h("div", { class: "oh", text: "Share it only if you mean to. Say why, in a sentence. It goes in the audit log." }),
        field("gfReason", "Why share it?", h("input", { id: "gfReason", "data-gform": "gfReason", value: form.override.reason, maxLength: 300, placeholder: "For example: my notes app keeps its files here", autocomplete: "off" })),
        h("div", { class: "actions" },
          h("button", { class: "btn danger small", type: "button", id: "gfForce", "data-gform-force": "1", text: "Grant anyway", disabled: form.busy || form.override.reason.trim().length < 8 }),
          h("button", { class: "btn plain small", type: "button", "data-gform-cancel": "1", text: "Cancel" })),
        h("div", { class: "oh", id: "gfMin", text: "At least 8 characters.", hidden: form.override.reason.trim().length >= 8 })) : null,
      h("button", { class: "btn", type: "submit", id: "gfAdd", text: form.busy ? "Checking…" : "Add folder", disabled: form.busy, hidden: !!form.override }));
    v.replaceChildren(
      h("div", { class: "card" }, h("div", { class: "what", text: "Folders agents can use" }), h("div", { class: "detail", text: "Agents can read files here. Writes always come to you as changes to approve." })),
      h("div", { id: "grantList" }), f);
    paintGrantList();
    if (!st.grants) void loadGrants();
  }

  async function loadGrants() {
    try {
      const [grants, proposals] = await Promise.all([api("/folder-grants"), api("/write-proposals").catch(() => st.proposals || [])]);
      st.grants = grants; st.proposals = proposals; st.proposalsErr = "";
    } catch (e) { if (e.message !== "unpaired") toast(`Can't load folders: ${e.message}`); st.grants = st.grants || []; }
    if (st.view === "folders") paintGrantList();
  }

  const grantScope = (g) => {
    const r = g.roomId ? st.rooms.find((x) => x.id === g.roomId) : null;
    return g.roomId ? (r ? roomName(r) : "A room that was deleted") : "All rooms";
  };
  const grantAgent = (g) => (g.agentId === "*" ? "Any agent" : agentName(g.agentId));
  const pendingFor = (g) => (st.proposals || []).filter((p) => p.grantId === g.id && p.status === "pending").length;

  function paintGrantList() {
    const host = $("#grantList"); if (!host) return;
    if (!st.grants) { host.replaceChildren(h("div", { class: "empty", text: "Loading…" })); return; }
    const sorted = [...st.grants].sort((a, b) => a.path.localeCompare(b.path) || (a.roomId || "").localeCompare(b.roomId || "") || a.agentId.localeCompare(b.agentId) || a.createdAt - b.createdAt);
    if (!sorted.length) { host.replaceChildren(h("div", { class: "empty", text: "No folders yet. Agents can't see any files until you add one." })); return; }
    host.replaceChildren(h("div", { class: "section", text: `Added folders (${sorted.length})` }), ...sorted.map((g) => {
      const name = g.label || g.path.split("/").filter(Boolean).pop() || g.path;
      const row = (kind, label, hint, on) => h("label", { class: "perm" }, h("span", { class: "txt" }, h("span", { class: "lbl", text: label }), h("span", { class: "hint2", text: hint })),
        h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": `${label} ${name}`, "data-grant": g.id, "data-access": kind, checked: on }));
      return h("div", { class: "grant" },
        h("div", { class: "gtop" }, g.label ? h("div", { class: "gname", text: g.label }) : null, h("div", { class: "gpath", text: g.path }),
          h("div", { class: "gmeta", text: `${grantScope(g)} · ${grantAgent(g)}` })),
        row("read", "Read", "Agents can look at files here.", g.read),
        row("write", "Write", "Writes always come to you as changes to approve.", g.write),
        h("div", { class: "actions pad" }, h("button", { class: "btn small plain", "data-grant-remove": g.id, text: "Remove" })));
    }));
  }

  // One call changes the grant in place. Only turning Write off drops the writes waiting on it; the agent can ask again.
  async function setGrantAccess(input) {
    const g = st.grants.find((x) => x.id === input.dataset.grant); if (!g) return;
    const key = input.dataset.access, value = input.checked;
    const next = { read: g.read, write: g.write, [key]: value };
    if (!next.read && !next.write) { input.checked = !value; toast("A folder needs Read or Write. Remove it to stop all access."); return; }
    const n = pendingFor(g);
    if (key === "write" && !value && n && !confirm(`${n} change${n === 1 ? " is" : "s are"} waiting for your approval from this folder. Turning Write off drops ${n === 1 ? "it" : "them"}, and the agent can ask again. Continue?`)) { input.checked = !value; return; }
    input.disabled = true;
    try { await api(`/folder-grants/${g.id}`, { method: "PUT", body: { [key]: value } }); await loadGrants(); }
    catch (e) { input.checked = !value; input.disabled = false; if (e.message !== "unpaired") toast(e.message); }
  }

  async function removeGrant(btn) {
    const g = st.grants.find((x) => x.id === btn.dataset.grantRemove); if (!g) return;
    const n = pendingFor(g);
    if (!confirm(`Remove ${g.label || g.path}? Agents lose access to it right away.${n ? ` ${n} change${n === 1 ? "" : "s"} waiting for approval will be dropped.` : ""}`)) return;
    btn.disabled = true;
    try { await api(`/folder-grants/${g.id}`, { method: "DELETE" }); await loadGrants(); }
    catch (e) { btn.disabled = false; if (e.message !== "unpaired") toast(e.message); }
  }

  // Asks the hub first (POST /folder-grants/check). A folder that needs an override gets a reason box and "Grant anyway";
  // one that is never allowed gets the hub's words and nothing else. `force` is set only by the Grant anyway button.
  async function addGrant(force) {
    const f = st.gform;
    const cap = (m) => m.charAt(0).toUpperCase() + m.slice(1);
    const say = (text) => { f.err = text; const el = $("#gfErr"); if (el) el.textContent = text; };
    if (!f.path.trim()) return say("Type the folder's full path, like /Users/you/Documents/notes.");
    if (!f.read && !f.write) return say("Turn on Read, Write or both.");
    f.busy = true; say(""); { const b = $("#gfAdd"); if (b) b.disabled = true; const g = $("#gfForce"); if (g) g.disabled = true; }
    const redraw = () => { f.busy = false; if (st.view === "folders") renderFolders(); };
    try {
      if (!force) {
        const c = await api("/folder-grants/check", { method: "POST", body: { path: f.path.trim() } });
        if (!c.ok) { f.err = cap(c.error); f.override = c.canForce ? { because: "", reason: f.override?.reason || "" } : null; return redraw(); }
        if (c.protected) { f.override = { because: c.because || "", reason: f.override?.reason || "" }; return redraw(); }
      }
      await api("/folder-grants", { method: "POST", body: { path: f.path.trim(), label: f.label.trim() || undefined, roomId: f.roomId || undefined, agentId: f.agentId, read: f.read, write: f.write, ...(force ? { force: true, reason: f.override.reason.trim() } : {}) } });
      Object.assign(f, { path: "", label: "", roomId: "", agentId: "*", read: true, write: false, override: null });
      await loadGrants();
      redraw();
    } catch (e) {
      if (e.message === "unpaired") return;
      f.err = cap(e.message);   // the hub says why a folder can't be shared (home folder, credentials, not found)
      f.override = e.canForce ? { because: e.because || "", reason: f.override?.reason || "" } : null;
      redraw();
    } finally { f.busy = false; const b = $("#gfAdd"); if (b) { b.disabled = false; b.textContent = "Add folder"; } }
  }

  // 2.5: the switch that writes the room's memory into the agent's own context file. Says which file and how big, and is off until turned on.
  const capLabel = (n) => (n >= 1024 ? `${Number((n / 1024).toFixed(1))} KB` : `${n} bytes`);
  function memoryExportRow(a, row) {
    const info = (st.memExport || []).find((x) => x.agentId === a.id);
    if (!info || !info.supported || !info.file) return "";
    return row(a, "memexport", "memory", a.settings?.memoryExport === true, `Share room memory with ${a.name} outside the room`,
      `Off by default. When on, it writes what the room knows into ${info.file}, in one block between two marker lines, up to ${capLabel(info.capBytes || 4096)}. The rest of that file is never touched, and your original is saved once first.${info.note ? ` ${info.note}` : ""}`);
  }

  // Per-agent tool switches. A sub-setting is nested under its parent (indented, with a left rule); labels never carry spaces.
  function renderPermissions() {
    const agents = Object.values(st.agents).sort((a, b) => a.name.localeCompare(b.name));
    const sw = (a, kind, tool, on, label) =>
      `<input type="checkbox" role="switch" class="switch" aria-label="${esc(label)}" data-agent="${esc(a.id)}" data-kind="${kind}" data-tool="${esc(tool)}"${on ? " checked" : ""}>`;
    const row = (a, kind, tool, on, label, hint) => `
      <label class="perm">
        <span class="txt"><span class="lbl">${esc(label)}</span>${hint ? `<span class="hint2">${esc(hint)}</span>` : ""}</span>
        ${sw(a, kind, tool, on, label)}
      </label>`;
    $("#view").innerHTML = !st.tools.length ? `<div class="empty">Loading…</div>` : agents.map((a) => `
      <div class="section"><span class="av mini" data-color="${esc(safeColor(a.color))}">${esc(glyph(a))}</span>${esc(a.name)}</div>
      ${st.tools.map((tool) => {
        const on = !!a.tools?.[tool.id], auto = !!a.autoApprove?.[tool.id];
        const main = row(a, "tool", tool.id, on, tool.label, tool.sensitive ? (auto ? "Runs without asking" : "Asks you before each use") : "");
        const sub = tool.id === "shell" && on ? `<div class="nested">${row(a, "auto", "shell", auto, "Run shell commands without asking",
          a.adapter === "codex" ? "Codex already runs commands inside its sandbox without asking. This covers anything it asks the room about."
            : "Commands run right away. Each one is still logged in Activity and the audit log.")}</div>` : "";
        return main + sub;
      }).join("")}${memoryExportRow(a, row)}`).join("");
    paintColors();
  }

  // 1.6 Subscriptions: what each plan has used in its 5-hour and weekly windows. Read-only here; limits are edited on the Mac.
  function renderSubscriptions() {
    const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
    const at = (ms) => new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    const win = (w, label, free) => {
      if (free) return "";
      const lim = [w.limitRuns ? `${w.usedRuns} of ${w.limitRuns} runs` : "", w.limitTokens ? `${k(w.usedTokens)} of ${k(w.limitTokens)} tokens` : ""].filter(Boolean).join(", ");
      const pct = w.headroom === undefined ? 0 : Math.round((1 - w.headroom) * 100);
      const note = w.headroom === undefined ? `learning, ${w.usedRuns} runs so far` : `${lim}${w.limitSource === "learned" ? " (learned)" : ""}`;
      return `<div class="qrow"><span class="qlbl">${label}</span><span class="qbar${pct >= 90 ? " hot" : ""}"><i data-pct="${pct}"></i></span></div>
        <div class="qnote">${esc(note)}${w.usedRuns ? `, resets ${esc(at(w.resetsAt))}` : ""}</div>`;
    };
    $("#view").innerHTML = st.quota.length ? st.quota.map((q) => `
      <div class="qsub">
        <div class="qhead"><span class="qname">${esc(q.subscription.label)}</span>${q.free ? '<span class="qtag">free</span>' : q.limited ? '<span class="qtag warn">at its limit</span>' : ""}</div>
        ${q.subscription.plan ? `<div class="qnote flat">${esc(q.subscription.plan)}</div>` : ""}
        ${q.free ? '<div class="qnote flat">Runs on this Mac. No limit.</div>' : win(q.windows.fiveHour, "5-hour", false) + win(q.windows.weekly, "Weekly", false)}
        ${q.limited && q.limitedUntil ? `<div class="qnote flat">No work goes here until ${esc(at(q.limitedUntil))}.</div>` : ""}
      </div>`).join("") : `<div class="empty">Loading…</div>`;
    for (const el of document.querySelectorAll("[data-pct]")) el.style.width = `${el.dataset.pct}%`;
  }

  // Scorecard: how often work is accepted the first time (2.1), then this week's scorecard, the monthly return ledger and today's interruptions (2.7).
  const isoWeekOf = (ms) => {
    const d = new Date(ms); d.setUTCHours(0, 0, 0, 0);
    const mon = d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000;
    const thu = new Date(mon + 3 * 86400000), year = thu.getUTCFullYear();
    return `${year}-W${String(Math.floor((thu.getTime() - Date.UTC(year, 0, 1)) / 86400000 / 7) + 1).padStart(2, "0")}`;
  };
  async function loadScorecard() {
    const week = st.scWeek === "last" ? isoWeekOf(Date.now() - 7 * 86400000) : isoWeekOf(Date.now());
    const month = new Date().toISOString().slice(0, 7);
    const [fp, sc, lg, at] = await Promise.all([
      api("/metrics/first-pass?weeks=12"), api(`/reports/scorecard?week=${week}`).catch(() => null),
      api(`/reports/ledger?month=${month}`).catch(() => null), api("/attention").catch(() => null),
    ]);
    st.firstPass = fp; st.scorecard = sc; st.ledger = lg; st.attention = at;
    if (st.view === "scorecard") renderScorecard();
  }
  function renderScorecard() {
    const m = st.firstPass;
    if (!m) { $("#view").innerHTML = `<div class="empty">Loading…</div>`; return; }
    const pct = (r) => (r === null ? "no work" : `${Math.round(r * 100)}%`);
    const s = m.sincePhase;
    const since = new Date(m.phaseStartedAt).toLocaleDateString();
    const total = m.overall.reduce((n, w) => n + w.tasks, 0);
    const bars = m.overall.map((w) => `<div class="fpcol" title="${esc(`${w.week}: ${pct(w.rate)} of ${w.tasks} tasks`)}"><i class="${w.sincePhase ? "" : "pre"}" data-h="${w.rate === null ? 2 : Math.max(2, Math.round(w.rate * 100))}"></i></div>`).join("");
    const kv = (k, v) => `<div class="kv wide"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
    const usd = (x) => (x === null || x === undefined ? "n/a" : `$${x < 100 ? x.toFixed(2) : Math.round(x)}`);
    const sc = st.scorecard, lg = st.ledger, at = st.attention;
    const week = sc ? `
      <div class="section">${st.scWeek === "last" ? "Last week" : "This week"}, ${esc(sc.week)}</div>
      <div class="actions pad"><button class="btn small${st.scWeek === "last" ? " plain" : ""}" data-scweek="this">This week</button><button class="btn small${st.scWeek === "last" ? "" : " plain"}" data-scweek="last">Last week</button></div>
      <div class="card"><div class="what">${sc.totals.tasks ? `${pct(sc.totals.firstPass)} accepted first time` : "No finished work"}</div>
        <div class="detail">${sc.totals.goals} goals, ${sc.totals.tasks} tasks, ${sc.totals.gradedRuns} graded runs.</div></div>
      <div class="section">Best at what</div>
      ${sc.bestByTaskType.length ? sc.bestByTaskType.map((t) => `<div class="card"><div class="what">${esc(t.taskType)}: ${t.best ? esc(t.best) : "no clear best yet"}</div>
        <div class="detail">${esc(t.agents.map((a) => `${a.agentId} ${a.meanQuality.toFixed(2)} over ${a.gradedRuns}`).join(", "))}${t.note ? `. ${esc(t.note)}` : ""}</div></div>`).join("") : `<div class="empty">No graded work.</div>`}
      <div class="section">Where goals were vague</div>
      ${sc.vagueGoals.length ? sc.vagueGoals.map((g) => `<div class="card"><div class="what">${esc(g.goal)}</div><div class="detail">${g.specFailures} unclear-spec failures, ${g.clarifications} clarifications from you, ${g.revisions} send-backs.</div></div>`).join("") : `<div class="card"><div class="detail">None this week.</div></div>`}
      <div class="section">How close the judges are to you</div>
      <div class="card">${sc.judges.rated ? [
        kv("Jury", sc.judges.jury.n ? `${sc.judges.jury.meanDistance.toFixed(2)} (${sc.judges.jury.n})` : "no ratings"),
        kv("One judge", sc.judges.single.n ? `${sc.judges.single.meanDistance.toFixed(2)} (${sc.judges.single.n})` : "no ratings"),
        kv("Same family", sc.judges.sameFamily.n ? `${sc.judges.sameFamily.meanDistance.toFixed(2)} (${sc.judges.sameFamily.n})` : "no ratings"),
        kv("Other family", sc.judges.crossFamily.n ? `${sc.judges.crossFamily.meanDistance.toFixed(2)} (${sc.judges.crossFamily.n})` : "no ratings"),
      ].join("") + `<div class="detail">Distance from your rating: 0 is the same, 1 is the opposite.</div>` : `<div class="detail">You rated no judgments this week.</div>`}</div>
      <div class="section">What each goal cost</div>
      ${sc.costPerGoal.length ? sc.costPerGoal.map((g) => `<div class="card"><div class="what">${esc(g.goal)}</div><div class="detail">${g.tokens.toLocaleString()} tokens${g.estimated ? " (estimated)" : ""}, ${g.costUsd === null ? "cost not reported" : `${usd(g.costUsd)} at API prices`}, ${g.accepted} accepted${g.costPerAccepted === null ? "" : `, ${usd(g.costPerAccepted)} each`}.</div></div>`).join("") : `<div class="card"><div class="detail">No runs.</div></div>`}
      <div class="section">Interruptions</div>
      <div class="card"><div class="what">${sc.interruptions.total} this week</div>
        <div class="detail">Daily cap ${sc.interruptions.cap}.${at ? ` Today: ${at.day.interrupts} used, ${at.queue.length} waiting for the evening digest.` : ""}</div></div>
      ${sc.lessons.length ? `<div class="section">What the agents learned</div>${sc.lessons.map((l) => `<div class="card"><div class="what">${esc(l.agentId)}, ${esc(l.taskType)}</div><div class="detail">${esc(l.text)}</div></div>`).join("")}` : ""}` : "";
    const ledger = lg ? `
      <div class="section">Return ledger, ${esc(lg.month)}</div>
      ${lg.rows.map((r) => `<div class="card"><div class="what">${esc(r.label)}</div><div class="detail">${esc(r.line)}</div></div>`).join("")}` : "";
    $("#view").innerHTML = `
      <div class="card">
        <div class="what">${s.tasks ? `${pct(s.rate)} accepted first time` : "No finished work yet"}</div>
        <div class="detail">${s.tasks ? `Since ${esc(since)}: ${s.accepted} of ${s.tasks} tasks, ${s.revisionsPerTask ?? 0} send-backs per task.` : `Counting from ${esc(since)}.`}</div>
      </div>
      ${total ? `<div class="fpbars">${bars}</div><div class="qnote flat fpnote">Last ${m.weeks} weeks, newest on the right. Pale bars are from before this started.</div>` : ""}
      ${m.overall.filter((w) => w.tasks).slice(-6).reverse().map((w) => `<div class="kv"><span class="k">${esc(w.week)}</span><span class="v">${pct(w.rate)} of ${w.tasks}</span></div>`).join("")}
      ${week}${ledger}`;
    for (const el of document.querySelectorAll("[data-h]")) el.style.height = `${el.dataset.h}%`;
  }

  // 2.3 Resumes: where each agent is on probation (3 of 5 graded runs), what it is strong and weak at, and the owner's switch.
  async function loadResumes() {
    st.resumes = await api("/resumes");
    st.probationCount = st.resumes.filter((r) => r.probation.on).length;
    if (st.view === "resumes") renderResumes();
  }
  function renderResumes() {
    if (!st.resumes) { $("#view").innerHTML = `<div class="empty">Loading…</div>`; return; }
    const pct = (x) => (x === null ? "no work yet" : `${Math.round(x * 100)}%`);
    $("#view").innerHTML = st.resumes.map((r) => {
      const a = st.agents[r.agentId] || {}, pr = r.probation;
      const tag = pr.on ? '<span class="qtag warn">On probation</span>' : pr.endedAt ? '<span class="qtag">Finished probation</span>' : "";
      const prog = pr.on ? `<div class="qnote flat">${pr.graded} of ${pr.needed} graded runs. ${esc(r.name)} practises on copies of your tasks and gets no real work until then.</div>
        <div class="qrow"><span class="qbar"><i data-pct="${Math.min(100, Math.round((pr.graded / Math.max(1, pr.needed)) * 100))}"></i></span></div>`
        : pr.endedAt ? `<div class="qnote flat">${pr.endedBy === "owner" ? "You ended probation." : `Finished probation${typeof pr.mean === "number" ? `: ${pr.mean.toFixed(2)} over ${pr.graded} graded runs` : ""}.`}</div>` : "";
      const lines = [...r.strengths.map((l) => `<div class="rline">${esc(l)}</div>`), ...r.weaknesses.map((l) => `<div class="rline warn">${esc(l)}</div>`)].join("")
        || `<div class="qnote flat">${r.runs ? `${r.runs} graded run${r.runs === 1 ? "" : "s"}, nothing stands out yet.` : "No graded runs yet. A task type needs 3 before it shows here."}</div>`;
      const sum = r.runs ? `<div class="qnote flat">${r.runs} graded run${r.runs === 1 ? "" : "s"}${r.shadowRuns ? ` (${r.shadowRuns} practice)` : ""}, accepted first time ${pct(r.firstPass)}</div>` : "";
      return `<div class="qsub">
        <div class="qhead"><span class="av mini" data-color="${esc(safeColor(a.color))}">${esc((r.name || "?")[0].toUpperCase())}</span><span class="qname">${esc(r.name)}</span>${tag}</div>
        ${prog}${lines}${sum}
        <div class="rbtn">${pr.on ? `<button class="btn small plain" data-probation="${esc(r.agentId)}" data-on="0">End probation</button>` : `<button class="btn small ghost" data-probation="${esc(r.agentId)}" data-on="1">Restart probation</button>`}</div>
      </div>`;
    }).join("") || `<div class="empty">No agents yet.</div>`;
    paintColors();
    for (const el of document.querySelectorAll("[data-pct]")) el.style.width = `${el.dataset.pct}%`;
  }

  // 1.2: Tailscale status, read-only, plus the Funnel switch. Setup of Tailscale itself happens on the Mac.
  function renderRemote() {
    const r = st.remote;
    if (!r) { $("#view").innerHTML = `<div class="empty">Loading…</div>`; return; }
    const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
    const head = r.state === "running" ? `<div class="what">${esc(r.detail)}</div>`
      : `<div class="what">${r.state === "not_installed" ? "Tailscale isn't installed on the Mac." : r.state === "needs_login" ? "Tailscale needs a sign-in on the Mac." : "Tailscale is turned off on the Mac."}</div>
         <div class="detail">Open Agent Room on the Mac to set it up. This page is read-only for that.</div>`;
    const f = r.funnel;
    $("#view").innerHTML = `
      <div class="card">${head}
        ${r.state === "running" ? `${r.dnsName ? kv("Name", r.dnsName) : ""}${r.ip ? kv("Address", r.ip) : ""}${r.hubUrl ? kv("Hub", r.hubUrl) : ""}` : ""}
      </div>
      ${r.state === "running" ? `
      <div class="section">Cloud agents</div>
      <label class="perm">
        <span class="txt"><span class="lbl">Tailscale Funnel</span><span class="hint2">Lets cloud agents like ChatGPT connectors reach this Mac's agent endpoint. Only /mcp is exposed and every call needs a token.</span></span>
        <input type="checkbox" role="switch" class="switch" aria-label="Tailscale Funnel" data-remote="funnel"${f.on ? " checked" : ""}>
      </label>
      <div class="card"><div class="detail">${f.on && f.url ? `On: ${esc(f.url)}` : "Off. Nothing on the Mac is reachable from the internet."}</div>
        ${f.drift === "on_in_tailscale" ? `<div class="detail warn">Funnel is on in Tailscale, but you haven't turned it on here. Switch it off here to close it.</div>` : ""}
        ${f.drift === "off_in_tailscale" ? `<div class="detail warn">You switched Funnel on here, but Tailscale has it off now. Switch it off and on again to restore it.</div>` : ""}
        ${f.drift === "wrong_target" ? `<div class="detail warn">Tailscale serves /mcp, but it points at ${esc(f.wrongTarget || "something else")}, not Agent Room. Funnel is shown as off here. Fix it in Tailscale.</div>` : ""}
        ${f.extraPaths.length ? `<div class="detail warn">Funnel is also exposing ${esc(f.extraPaths.join(", "))} on the Mac. Close it on the Mac with: tailscale funnel reset</div>` : ""}
        ${(r.warnings || []).map((w) => `<div class="detail warn">WARNING: ${esc(w)}</div>`).join("")}
      </div>` : ""}`;
  }

  // 3.1 Verdict chips: accepted, sent back or disputed, with the score and a chip per judge. The judge's long line stays in the activity log.
  const chipHtml = (c) => `<span class="chip ${c.tone}"><i aria-hidden="true">${esc(c.glyph)}</i>${esc(c.label)}${c.score === undefined ? "" : ` <b>${esc(c.score)}</b>`}</span>`;
  function verdictRow(task) {
    const c = task && ARView.verdictChip(task); if (!c) return "";
    const jury = task.judgment && task.judgment.jury;
    const judges = jury ? jury.judges.map((j) => `<span class="chip judge ${j.verdict === "accept" ? "ok" : "danger"}"><i aria-hidden="true">${j.verdict === "accept" ? "✓" : "✗"}</i>${esc(j.family)}${j.local ? " (local)" : ""} <b>${esc(Math.round(j.score * 100))}</b></span>`).join("") : "";
    const spoken = c.score === undefined ? c.label : c.label + ", score " + c.score;
    return `<div class="vrow" aria-label="${esc(spoken)}">${chipHtml(c)}${judges}</div>`;
  }

  // 3.1 The goal card: the goal at the top of the room, with its "Done means" list, progress and state. One line when collapsed.
  // On a phone the card starts as one line, and opens by itself only when it needs the owner (a plan to approve, or a question).
  const goalIsOpen = (m) => st.goalOpen[m.goalId] !== undefined ? st.goalOpen[m.goalId] : m.state.key === "waiting" || m.state.key === "awaiting_approval";
  function renderGoal() {
    const host = $("#goal");
    const goal = st.view === "room" ? ARView.pickGoal(Object.values(st.goals).filter((g) => g.roomId === st.roomId)) : null;
    if (!goal) { host.hidden = true; host.replaceChildren(); return; }
    const m = ARView.goalCardModel(goal, Object.values(st.tasks).filter((t) => t.roomId === st.roomId));
    const open = goalIsOpen(m);
    const line = ARView.goalProgressLine(m);
    const frac = Math.round(ARView.goalFraction(m) * 100);
    host.hidden = false; host.className = open ? "open" : "";
    host.setAttribute("aria-label", `Goal: ${m.objective}. ${m.state.label}. ${line}`);
    const reqs = m.requirements.map((r) => h("div", { class: `req ${r.status}`, "aria-label": `${r.id}, ${r.status === "met" ? "met" : r.status === "unmet" ? "not met" : "open"}: ${r.text}` },
      h("span", { class: "rg", "aria-hidden": "true", text: r.status === "met" ? "✓" : r.status === "unmet" ? "✕" : "○" }), h("span", { class: "rid", text: r.id }),
      h("span", { class: "rt" }, r.text, r.status === "unmet" && r.evidence ? h("span", { class: "re", text: r.evidence }) : null)));
    host.replaceChildren(...[
      h("button", { type: "button", class: "gc-head", "data-goal-toggle": m.goalId, "aria-expanded": open ? "true" : "false", "aria-label": open ? "Collapse the goal" : "Expand the goal" },
        h("span", { class: `chip ${m.state.tone}`, text: m.state.label }),
        h("span", { class: "gc-main" }, h("span", { class: "gc-obj", text: m.objective }), h("span", { class: "gc-count", text: line })), h("span", { class: "gc-caret", "aria-hidden": "true", text: open ? "▾" : "▸" })),
      h("div", { class: "gc-bar" }, h("i", { class: m.state.key === "failed" ? "bad" : "", "data-pct": frac })),
      open ? h("div", { class: "gc-body" },
        m.note ? h("div", { class: `gc-note${m.note.kind === "next" ? " next" : ""}` }, h("b", { text: m.note.kind === "waiting" ? "Waiting on you" : "Next" }), m.note.text, m.note.kind === "waiting" ? h("small", { text: "Reply in the room and the work picks back up." }) : null) : null,
        reqs.length ? h("div", {}, h("div", { class: "gc-h" }, "Done means", h("span", { text: `${m.met} of ${m.total} met` })), reqs)
          : h("div", { class: "gc-line", text: m.state.key === "planning" ? "Writing the plan. The list of what done means shows here once it's ready." : "No list of requirements for this goal." }),
        line ? h("div", { class: "gc-line", text: line }) : null) : null].filter(Boolean));
    for (const el of host.querySelectorAll("[data-pct]")) el.style.width = `${el.dataset.pct}%`;
  }

  // First render of a room jumps to the first unread message (or the latest); later renders
  // follow new messages only if you're already at the bottom or just sent one.
  function renderMessages(follow) {
    if (st.view !== "room") return;
    const view = $("#view");
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 150;
    const msgs = st.messages.filter(visibleMsg);
    const chips = ARView.chipMessageIds(msgs); // 3.1: the verdict sits on the last message of each task
    let html = "", prev, marked = false;
    renderGoal();
    for (const m of msgs) {
      if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) html += `<div class="day">${esc(dayLabel(m.createdAt))}</div>`;
      if (!marked && st.readAt > 0 && m.createdAt > st.readAt && m.author.kind !== "human") { html += `<div class="new" id="newLine"><span>New</span></div>`; marked = true; }
      const sys = m.type === "system" || m.author.kind === "system";
      const grouped = prev && prev.author.id === m.author.id && !sys && prev.type !== "system" && m.createdAt - prev.createdAt < 5 * 60_000
        && new Date(prev.createdAt).toDateString() === new Date(m.createdAt).toDateString();
      const agent = st.agents[m.author.id];
      const cls = m.author.kind === "human" ? "owner" : sys ? "sys" : "";
      const name = m.author.kind === "human" ? (st.ownerName || m.author.name) : (agent?.name || m.author.name);
      const plan = m.planGoalId ? st.goals[m.planGoalId] : null;
      const actions = plan && plan.status === "awaiting_approval" ? `
        <div class="actions">
          <button class="btn small" data-plan="${esc(plan.id)}" data-decision="approve">Approve and start</button>
          <button class="btn small plain" data-plan="${esc(plan.id)}" data-decision="revise">Change it…</button>
          <button class="btn small ghost" data-plan="${esc(plan.id)}" data-decision="cancel">Cancel</button>
        </div>` : "";
      html += `<div class="msg${grouped ? "" : " first"}${sys ? " system" : ""}${m.planGoalId ? " plan" : ""}">
        <span class="av${cls ? ` ${cls}` : ""}"${cls ? "" : ` data-color="${esc(safeColor(agent?.color))}"`}>${sys ? "•" : esc(glyph(agent, name))}</span>
        <div class="body">${grouped ? "" : `<div class="who">${esc(sys ? "Agent Room" : name)}<span class="when">${esc(time(m.createdAt))}</span></div>`}
          <div class="text">${md(m.text)}</div>${actions}</div></div>${chips[m.id] ? verdictRow(st.tasks[chips[m.id]]) : ""}`;
      prev = m;
    }
    view.innerHTML = `<div class="msgs">${html || '<div class="empty">No messages yet. Say what you need.</div>'}</div>`;
    paintColors();
    if (!msgs.length) return;
    // Rooms always open on the newest message. Unread messages above get a button to jump up to them.
    if (st.positioned !== st.roomId) {
      st.positioned = st.roomId;
      view.scrollTop = view.scrollHeight;
      const line = $("#newLine");
      $("#jumpNew").hidden = !line || line.offsetTop - view.offsetTop >= view.scrollTop;
    } else if (follow || nearBottom) view.scrollTop = view.scrollHeight;
  }

  function renderComposerState() {
    if (st.view !== "room") return;
    const busy = Object.keys(st.working[st.roomId] || {});
    const names = busy.map((id) => st.agents[id]?.name).filter(Boolean);
    $("#working").textContent = names.length ? `${names.join(" and ")} ${names.length > 1 ? "are" : "is"} working…` : busy.length ? "Figuring out who should take this…" : "";
    const running = Object.values(st.goals).some((g) => g.roomId === st.roomId && (g.status === "running" || g.status === "planning"));
    $("#steer").hidden = !(running || busy.length);
    renderFolderPick();
  }

  // "Work in folder": only for a goal in a room (not a DM), and not while a goal is already running or waiting on a plan.
  function renderFolderPick() {
    const host = $("#folderPick"); if (!host) return;
    const room = st.rooms.find((r) => r.id === st.roomId);
    const goalOn = Object.values(st.goals).some((g) => g.roomId === st.roomId && ["running", "planning", "paused", "awaiting_approval"].includes(g.status));
    const show = st.view === "room" && !!room && !room.dmAgentId && !goalOn && st.roomGrants.length > 0;
    host.hidden = !show;
    if (!show) { host.replaceChildren(); return; }
    const name = (g) => g.label || g.path.split("/").filter(Boolean).pop() || g.path;
    const sel = st.roomGrants.find((g) => g.id === st.folderId);
    if (st.folderId && !sel) st.folderId = "";
    const chip = (props, text, on) => h("button", { class: `fchip${on ? " on" : ""}`, type: "button", ...props, text });
    host.replaceChildren(
      chip({ "data-folder-toggle": "1", "aria-expanded": st.folderOpen ? "true" : "false" }, sel ? `In folder: ${name(sel)}` : "Work in folder", !!sel),
      st.folderOpen ? h("div", { class: "fopts" },
        h("div", { class: "fnote", text: `Agents work on a copy.${sel ? (sel.write ? " What they change comes back to you to approve." : " It is read only, so nothing is written back.") : ""}` }),
        h("div", { class: "frow" }, chip({ "data-folder": "" }, "No folder", !sel), ...st.roomGrants.map((g) => chip({ "data-folder": g.id, role: "radio", "aria-checked": g.id === st.folderId ? "true" : "false" }, `${name(g)}${g.write ? "" : " (read only)"}`, g.id === st.folderId)))) : null);
  }

  // Colors go on through the DOM, not inline style attributes, so the page's CSP can forbid inline styles.
  // 3.1: the tile is the agent's colour made visible on this mode's canvas; the letter takes whichever ink reads on it.
  function paintColors() { for (const el of document.querySelectorAll("[data-color]")) { const t = tile(el.dataset.color); el.style.background = t.bg; el.style.color = t.ink; } }

  // ---------- actions
  async function sendMessage(text) {
    text = text.trim(); if (!text || !st.roomId) return;
    $("#sendBtn").disabled = true;
    try {
      // 1.1: the picked folder goes with the message. A folder the hub refuses comes back as a 400 with its reason, shown as is.
      await api(`/rooms/${st.roomId}/messages`, { method: "POST", body: st.folderId && !text.startsWith("/") ? { text, folderGrantId: st.folderId } : { text } });
      $("#input").value = ""; grow(); renderPalette(); st.folderId = ""; st.folderOpen = false; renderFolderPick();
    }
    catch (e) { if (e.message !== "unpaired") toast(e.message); }
    finally { $("#sendBtn").disabled = false; }
  }

  function grow() { const i = $("#input"); i.style.height = "auto"; i.style.height = `${Math.min(i.scrollHeight, innerHeight * 0.4)}px`; }

  // ---------- 2.6 slash commands: "/" at the start of the composer opens a palette, Room commands first, then each agent's skills
  const pal = { groups: null, at: 0, loading: false, rows: [], idx: 0, off: false };
  const palQuery = () => { const m = /^\/(\S*)$/.exec($("#input").value); return m && !pal.off ? m[1].toLowerCase() : null; };
  async function loadCommands() {
    if (pal.loading || (pal.groups && Date.now() - pal.at < 30000)) return;
    pal.loading = true;
    try { const r = await api("/commands"); pal.groups = r.groups; pal.at = Date.now(); } catch { /* the palette just stays closed */ }
    pal.loading = false;
    if (palQuery() !== null) renderPalette();
  }
  function renderPalette() {
    const host = $("#palette"), q = palQuery();
    pal.rows = [];
    if (q === null || !pal.groups) { host.hidden = true; host.replaceChildren(); return; }
    const hit = (c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
    const kids = [];
    for (const g of pal.groups) {
      const cs = g.commands.filter(hit); if (!cs.length) continue;
      kids.push(h("div", { class: "pgroup", text: g.label }));
      for (const c of cs) {
        const i = pal.rows.push(c) - 1;
        kids.push(h("button", { type: "button", class: `prow${i === pal.idx ? " on" : ""}`, role: "option", "aria-selected": i === pal.idx ? "true" : "false", "data-cmd": c.name },
          h("span", { class: "pname", text: `/${c.name}${c.argsHint ? ` ${c.argsHint}` : ""}` }), h("span", { class: "pdesc", text: c.description })));
      }
    }
    if (!pal.rows.length) kids.push(h("div", { class: "pnone", text: "No commands match." }));
    if (pal.idx >= pal.rows.length) pal.idx = 0;
    host.replaceChildren(...kids); host.hidden = false;
    host.querySelector(".prow.on")?.scrollIntoView({ block: "nearest" });
  }
  function chooseCommand(name) {
    const i = $("#input"); i.value = `/${name} `; pal.idx = 0; renderPalette(); i.focus(); grow();
  }

  // ---------- 3.1 the jump sheet: rooms, agents, room commands and screens in one list (the Mac's Command-K)
  const PHONE_SCREENS = ["approvals", "folders", "permissions", "appearance", "scorecard", "resumes", "agents"];
  function jumpItems() {
    return ARView.paletteItems({
      rooms: st.rooms, agents: Object.values(st.agents), currentRoomId: st.view === "room" ? st.roomId : undefined,
      screens: PHONE_SCREENS, platform: "phone",
    });
  }
  function renderJump() {
    const j = st.jump, host = $("#jumpList");
    j.rows = ARView.filterPalette(jumpItems(), j.q).slice(0, 60);
    if (j.idx >= j.rows.length) j.idx = 0;
    const kids = []; let last = "";
    j.rows.forEach((it, i) => {
      if (it.group !== last) { kids.push(h("div", { class: "pgroup", text: it.group })); last = it.group; }
      const a = it.action.kind === "dm" ? st.agents[it.action.agentId] : null;
      kids.push(h("button", { type: "button", class: `jrow${i === j.idx ? " on" : ""}`, role: "option", "aria-selected": i === j.idx ? "true" : "false", "data-jump-row": String(i) },
        a ? h("span", { class: "av", "data-color": safeColor(a.color), text: glyph(a) }) : it.action.kind === "room" ? h("span", { class: "jlead" }, h("span", { class: "mark" })) : null,
        h("span", { class: "jt", text: it.title }), it.hint ? h("span", { class: "jh", text: it.hint }) : null));
    });
    if (!j.rows.length) kids.push(h("div", { class: "jnone", text: `Nothing matches "${j.q}".` }));
    host.replaceChildren(...kids); paintColors();
    host.querySelector(".jrow.on")?.scrollIntoView({ block: "nearest" });
  }
  function openJump() {
    if (!st.token) return;
    st.jump = { open: true, q: "", idx: 0, rows: [] };
    $("#jump").hidden = false; $("#jumpInput").value = ""; renderJump(); $("#jumpInput").focus();
  }
  function closeJump() { st.jump.open = false; $("#jump").hidden = true; }
  const navigate = (name) => { const b = document.createElement("button"); b.dataset.nav = name; document.body.append(b); b.click(); b.remove(); }; // the same path as tapping the row
  async function runJump(it) {
    if (!it) return;
    closeJump();
    const a = it.action;
    try {
      if (a.kind === "room") go("room", a.roomId);
      else if (a.kind === "dm") { const r = await api(`/rooms/dm/${encodeURIComponent(a.agentId)}`, { method: "POST", body: {} }); if (!st.rooms.some((x) => x.id === r.id)) st.rooms.push(r); go("room", r.id); }
      else if (a.kind === "page") {
        const sc = { approvals: "approvals", folders: "folders", permissions: "permissions", appearance: "appearance", scorecard: "scorecard", resumes: "resumes", agents: "personas" }[a.screen];
        if (sc === "approvals") go("approvals"); else if (sc) navigate(sc);
      }
      else if (a.kind === "command") { if (st.roomId) await api(`/rooms/${st.roomId}/messages`, { method: "POST", body: { text: a.text } }); }
      else if (a.kind === "goal") { if (st.roomId !== a.roomId || st.view !== "room") go("room", a.roomId); setTimeout(() => $("#input").focus(), 120); }
    } catch (err) { if (err.message !== "unpaired") toast(err.message); }
  }

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button, [data-jump-close]"); if (!t) return;
    try {
      if (t.dataset.jumpClose) { closeJump(); return; }
      if (t.dataset.jumpRow !== undefined) { void runJump(st.jump.rows[Number(t.dataset.jumpRow)]); return; }
      if (t.dataset.goalToggle) {
        const g = st.goals[t.dataset.goalToggle];
        const cur = goalIsOpen(ARView.goalCardModel(g, Object.values(st.tasks).filter((x) => x.roomId === g.roomId)));
        st.goalOpen[g.id] = !cur; renderGoal(); return;
      }
      if (t.dataset.themeMode) { window.ARTheme.set(t.dataset.themeMode); renderAppearance(); return; }
      if (t.dataset.nav === "appearance") { go("appearance"); return; }
      if (t.dataset.room) return go("room", t.dataset.room);
      if (t.dataset.nav === "permissions") {
        go("permissions");
        if (!st.tools.length) { st.tools = await api("/tools"); if (st.view === "permissions") renderPermissions(); }
        st.memExport = await api("/memory/export").catch(() => st.memExport || []); if (st.view === "permissions") renderPermissions();   // 2.5
        return;
      }
      if (t.dataset.nav === "folders") { st.grants = null; go("folders"); void loadGrants(); return; }
      if (t.dataset.nav === "personas") { go("personas"); return; }
      if (t.dataset.persona) { void openPersona(t.dataset.persona); return; }
      if (t.dataset.review) { st.reviewId = t.dataset.review; go("diff"); return; }
      if (t.dataset.reload === "proposals") { triedProposals.clear(); st.fullErr = {}; if (st.view === "approvals") renderApprovals(); else renderReview(); return; }
      if (t.dataset.grantRemove) { await removeGrant(t); return; }
      if (t.dataset.folderToggle) { st.folderOpen = !st.folderOpen; renderFolderPick(); return; }
      if (t.dataset.folder !== undefined) { st.folderId = t.dataset.folder; st.folderOpen = false; renderFolderPick(); return; }
      if (t.dataset.gformForce) { void addGrant(true); return; }
      if (t.dataset.gformCancel) { st.gform.override = null; st.gform.err = ""; renderFolders(); return; }
      if (t.dataset.nav === "control") { go("control"); loadControl().catch(() => {}); return; }
      if (t.dataset.control === "lint") {
        t.disabled = true;
        try {
          const r = await api("/control/lint", { method: "POST", body: {} });
          toast(r.blocks.length + r.flags.length ? `${r.blocks.length} blocked, ${r.flags.length} flagged` : "No problems found");
          await loadControl();
        } finally { t.disabled = false; }
        return;
      }
      if (t.dataset.nav === "subscriptions") {
        go("subscriptions");
        st.quota = await api("/quota/subscriptions"); if (st.view === "subscriptions") renderSubscriptions();
        return;
      }
      if (t.dataset.nav === "scorecard") {
        go("scorecard");
        st.firstPass = null; st.scorecard = null; st.ledger = null; st.attention = null;
        await loadScorecard().catch(() => {});
        return;
      }
      if (t.dataset.nav === "resumes") { go("resumes"); await loadResumes(); return; } // 2.3
      if (t.dataset.probation) { // 2.3: the owner ends or restarts probation
        t.disabled = true;
        try { await api(`/agents/${t.dataset.probation}/probation`, { method: "POST", body: { on: t.dataset.on === "1" } }); await loadResumes(); }
        finally { t.disabled = false; }
        return;
      }
      if (t.dataset.scweek) { st.scWeek = t.dataset.scweek; st.scorecard = null; renderScorecard(); await loadScorecard().catch(() => {}); return; }
      if (t.dataset.nav === "remote") {
        go("remote");
        st.remote = await api("/remote/status?fresh=1"); if (st.view === "remote") renderRemote();
        return;
      }
      if (t.dataset.plan) {
        const d = t.dataset.decision; let text;
        if (d === "revise") { text = prompt("What should change in the plan?"); if (!text || !text.trim()) return; }
        if (d === "cancel" && !confirm("Cancel this plan?")) return;
        t.disabled = true;
        await api(`/goals/${t.dataset.plan}/plan`, { method: "POST", body: { decision: d, text } });
        return;
      }
      if (t.dataset.answer) {
        for (const b of document.querySelectorAll(`button[data-answer="${CSS.escape(t.dataset.answer)}"]`)) b.disabled = true;
        await api(`/approvals/${t.dataset.answer}`, { method: "POST", body: { choice: t.dataset.choice } });
        st.approvals = st.approvals.filter((a) => a.id !== t.dataset.answer);
        renderBadge(); renderApprovals();
        return;
      }
      if (t.dataset.approval) {
        // 1.1: a file write is approved only from the full diff, after it has been read to the end.
        const target = st.approvals.find((a) => a.id === t.dataset.approval);
        if (t.dataset.decision === "approved" && target && ARDiff.isFileWriteApproval(target) && !(review && review.approvalId === target.id && review.done && !review.problem)) return;
        t.disabled = true;
        await api(`/approvals/${t.dataset.approval}`, { method: "POST", body: { decision: t.dataset.decision } });
        st.approvals = st.approvals.filter((a) => a.id !== t.dataset.approval); review = null;
        if (st.view === "diff") go("approvals"); else { renderBadge(); renderApprovals(); }
        return;
      }
      if (t.dataset.cmd) { chooseCommand(t.dataset.cmd); return; }
      if (t.dataset.steer) {
        if (t.dataset.steer === "/stop") { if (confirm("Stop all work in this room?")) await sendMessage("/stop"); return; }
        const i = $("#input"); i.value = t.dataset.steer + i.value.replace(/^\/(redirect|replan)\s*/, ""); i.focus(); grow();
        return;
      }
    } catch (err) { t.disabled = false; if (err.message !== "unpaired") toast(err.message); }
  });

  // Permission switches: tool on/off, or the nested "without asking" setting.
  document.addEventListener("change", async (e) => {
    const el = e.target; if (!el.matches?.("input.switch") || el.dataset.remote || el.dataset.grant || el.dataset.gform) return;
    const { agent, kind, tool } = el.dataset;
    el.disabled = true;
    try {
      if (kind === "memexport") {   // 2.5: a plain agent setting, off until switched on
        const cur = st.agents[agent];
        const saved = await api(`/agents/${agent}`, { method: "PUT", body: { settings: { ...(cur?.settings || {}), memoryExport: el.checked } } });
        if (saved?.id) st.agents[saved.id] = saved;
        renderPermissions();
        return;
      }
      const updated = await api(`/agents/${agent}/${kind === "auto" ? "auto-approve" : "tools"}`, { method: "PUT", body: { [tool]: el.checked } });
      if (updated?.id) st.agents[updated.id] = updated;
      renderPermissions();
    } catch (err) { el.checked = !el.checked; el.disabled = false; if (err.message !== "unpaired") toast(err.message); }
  });

  // Folder grants (1.1): the Read and Write switches on a folder, and the Add folder form.
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.matches?.("input.switch[data-grant]")) { void setGrantAccess(el); return; }
    const id = el.dataset?.gform; if (!id) return;
    const f = st.gform;
    if (id === "gfRead") f.read = el.checked; else if (id === "gfWrite") f.write = el.checked;
    else if (id === "gfRoom") f.roomId = el.value; else if (id === "gfAgent") f.agentId = el.value;
  });
  document.addEventListener("input", (e) => {
    const id = e.target.dataset?.gform;
    if (id === "gfPath") {
      st.gform.path = e.target.value;
      if (st.gform.override) { st.gform.override = null; st.gform.err = ""; renderFolders(); $("#gfPath")?.focus(); }   // a different folder needs its own check
    } else if (id === "gfLabel") st.gform.label = e.target.value;
    else if (id === "gfReason" && st.gform.override) {
      st.gform.override.reason = e.target.value;
      const ok = e.target.value.trim().length >= 8;
      const b = $("#gfForce"); if (b) b.disabled = !ok || st.gform.busy;
      const m = $("#gfMin"); if (m) m.hidden = ok;
    }
  });
  document.addEventListener("submit", (e) => { if (e.target.id === "grantForm") { e.preventDefault(); void addGrant(); } });
  // 3.2: the persona form keeps what is typed; picking a template fills role, tone and bio (nothing is saved until Save)
  document.addEventListener("input", (e) => { const k = e.target.dataset?.pform; if (k && k !== "template" && st.personas.form) st.personas.form[k] = e.target.value; });
  document.addEventListener("change", (e) => {
    if (e.target.dataset?.pform !== "template" || !st.personas.form) return;
    const t = st.personas.templates.find((x) => x.id === e.target.value); if (!t) return;
    Object.assign(st.personas.form, { role: t.role, tone: t.tone, body: t.body.trim(), template: t.id });
    renderPersona();
  });
  document.addEventListener("submit", (e) => { if (e.target.id === "personaForm") { e.preventDefault(); void savePersona(); } });

  // Funnel switch (1.2). Turning it on asks first; the hub does the work and tells us what Tailscale ended up doing.
  document.addEventListener("change", async (e) => {
    const el = e.target; if (!el.matches?.("input.switch") || !el.dataset.remote) return;
    if (el.checked && !confirm("Turn on Funnel? Cloud agents can then reach this Mac's /mcp address. Every call still needs a token. You can turn it off here at any time.")) { el.checked = false; return; }
    el.disabled = true;
    try { st.remote = await api("/remote/funnel", { method: "POST", body: { on: el.checked } }); renderRemote(); }
    catch (err) { el.checked = !el.checked; el.disabled = false; if (err.message !== "unpaired") toast(err.message); }
  });

  $("#back").onclick = () => go(st.view === "diff" ? "approvals" : st.view === "persona" ? "personas" : "rooms");
  $("#jumpNew").onclick = () => {
    const line = $("#newLine"), view = $("#view");
    if (line) view.scrollTo({ top: Math.max(0, line.offsetTop - view.offsetTop - 8), behavior: "smooth" });
    $("#jumpNew").hidden = true;
  };
  // Scrolling up to the New line yourself also clears the button.
  $("#view").addEventListener("scroll", () => {
    const line = $("#newLine"), view = $("#view");
    if (!$("#jumpNew").hidden && line && line.offsetTop - view.offsetTop >= view.scrollTop) $("#jumpNew").hidden = true;
  }, { passive: true });
  // 1.1: reading a file change to the end is what turns Approve on.
  $("#view").addEventListener("scroll", () => { if (st.view === "diff") updateGate(); }, { passive: true });
  window.addEventListener("resize", () => { if (st.view === "diff") updateGate(); });
  $("#approvalsBtn").onclick = () => go("approvals");
  $("#jumpBtn").onclick = () => openJump();
  $("#jumpInput").addEventListener("input", (e) => { st.jump.q = e.target.value; st.jump.idx = 0; renderJump(); });
  $("#jumpInput").addEventListener("keydown", (e) => {
    const j = st.jump, n = j.rows.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (n) { j.idx = (j.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n; renderJump(); } }
    else if (e.key === "Enter") { e.preventDefault(); void runJump(j.rows[j.idx]); }
    else if (e.key === "Escape") { e.preventDefault(); closeJump(); }
  });
  // Command-K (or Control-K) on a keyboard opens the same sheet.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (st.jump.open) closeJump(); else openJump(); }
    else if (e.key === "Escape" && st.jump.open) closeJump();
  });
  // A change of mode (the choice, or the system) redraws the tiles so each agent colour is checked against the new canvas.
  window.ARTheme.onChange(() => { if (st.token) render(); });
  $("#send").onsubmit = (e) => { e.preventDefault(); void sendMessage($("#input").value); };
  $("#input").addEventListener("input", grow);
  $("#input").addEventListener("input", () => { pal.off = false; pal.idx = 0; if (palQuery() !== null) void loadCommands(); renderPalette(); });
  $("#palette").addEventListener("mousedown", (e) => e.preventDefault()); // tapping a row keeps the cursor in the box
  $("#input").addEventListener("keydown", (e) => {
    if (pal.rows.length && !$("#palette").hidden) {
      // Palette open: up/down move, Enter or Tab pick, Escape closes. A command typed out in full still sends on Enter.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pal.idx = (pal.idx + (e.key === "ArrowDown" ? 1 : pal.rows.length - 1)) % pal.rows.length; renderPalette(); return; }
      if (e.key === "Escape") { e.preventDefault(); pal.off = true; renderPalette(); return; }
      const sel = pal.rows[pal.idx];
      if ((e.key === "Enter" && !e.shiftKey && sel.name !== palQuery()) || e.key === "Tab") { e.preventDefault(); chooseCommand(sel.name); return; }
    }
    // On a keyboard, Enter sends and Shift+Enter makes a new line. On a phone, Return is a new line; use the send button.
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); void sendMessage($("#input").value); }
  });
  // iOS suspends sockets in the background; reconnect and catch up when the app comes back.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && st.token) { if (!st.ws) connectWs(); else void refresh(); } });

  if (st.token) void start(); else render();
})();
