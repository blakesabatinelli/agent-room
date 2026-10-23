// Agent Room on the phone. Served by the hub; talks to the same API as the Mac app.
"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  const TOKEN_KEY = "agentroom.token";

  const st = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    ownerName: "",
    view: "rooms",          // rooms | room | approvals | permissions | control | subscriptions | remote | pair
    tools: [], control: null, quota: [], remote: null,
    rooms: [], agents: {}, roomId: "", messages: [], goals: {}, working: {}, approvals: [],
    unread: new Set(), readAt: 0, readSent: {}, positioned: "",
    online: false, ws: null, wsDelay: 1000,
    capacity: null,
  };

  // ---------- helpers
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#5e6875");
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
    if (!res.ok) throw new Error(body.error || `The hub returned ${res.status}.`);
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
      case "agent": st.agents[e.agent.id] = e.agent; if (st.view === "permissions") renderPermissions(); break;
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
    const [msgs, goals, mark] = await Promise.all([api(`/rooms/${id}/messages?limit=200`), api(`/rooms/${id}/goals`), api(`/rooms/${id}/read`).catch(() => ({ at: 0 }))]);
    if (st.roomId !== id) return;
    if (!keepScroll) st.readAt = mark.at; // frozen for this visit so the "New" line stays put
    st.messages = msgs; for (const g of goals) st.goals[g.id] = g;
    renderMessages(); renderComposerState();
    const last = msgs[msgs.length - 1]; if (last) markRead(id, last.createdAt);
  }

  // ---------- views
  function go(view, roomId) {
    st.view = view;
    $("#jumpNew").hidden = true;
    if (view === "room") { st.roomId = roomId; st.messages = []; st.readAt = 0; st.positioned = ""; st.unread.delete(roomId); }
    else st.roomId = "";
    render();
    if (view === "room") loadRoom(roomId).catch((e) => { if (e.message !== "unpaired") toast(e.message); });
  }

  function render() {
    if (!st.token) st.view = "pair";
    $("#back").hidden = st.view === "rooms" || st.view === "pair";
    $("#composer").hidden = st.view !== "room";
    const room = st.rooms.find((r) => r.id === st.roomId);
    $("#title").textContent = st.view === "room" && room ? (room.dmAgentId ? roomName(room) : `# ${room.name}`)
      : st.view === "approvals" ? "Approvals" : st.view === "permissions" ? "Permissions" : st.view === "control" ? "Control files" : st.view === "subscriptions" ? "Subscriptions" : st.view === "remote" ? "Remote access" : "Agent Room";
    renderDot(); renderBadge();
    if (st.view === "pair") return renderPair();
    if (st.view === "rooms") return renderRooms();
    if (st.view === "approvals") return renderApprovals();
    if (st.view === "permissions") return renderPermissions();
    if (st.view === "control") return renderControl();
    if (st.view === "subscriptions") return renderSubscriptions();
    if (st.view === "remote") return renderRemote();
    renderMessages(); renderComposerState();
  }

  function renderDot() { $("#dot").classList.toggle("on", st.online); $("#dot").hidden = st.view === "pair"; }
  function renderBadge() {
    const n = st.approvals.length;
    $("#approvalsBtn").hidden = !n || st.view === "pair" || st.view === "approvals";
    $("#approvalsCount").textContent = String(n);
  }

  function renderRooms() {
    const channels = st.rooms.filter((r) => !r.dmAgentId).sort((a, b) => a.name.localeCompare(b.name));
    const dms = st.rooms.filter((r) => r.dmAgentId).sort((a, b) => roomName(a).localeCompare(roomName(b)));
    const row = (r) => {
      const a = r.dmAgentId ? st.agents[r.dmAgentId] : null;
      const lead = a ? `<span class="av" data-color="${esc(safeColor(a.color))}">${esc((a.name || "?")[0].toUpperCase())}</span>` : `<span class="hash">#</span>`;
      return `<button class="row" data-room="${esc(r.id)}">${lead}<span class="name">${esc(roomName(r))}</span>${r.paused ? '<span class="sub">paused</span>' : ""}${st.unread.has(r.id) ? '<span class="unread"></span>' : ""}</button>`;
    };
    $("#view").innerHTML = st.rooms.length
      ? `${channels.length ? `<div class="section">Channels</div>${channels.map(row).join("")}` : ""}
         ${dms.length ? `<div class="section">Direct messages</div>${dms.map(row).join("")}` : ""}`
      : `<div class="empty">No rooms yet. Make one on the Mac.</div>`;
    const nCtl = st.control ? st.control.notices.length : 0;
    $("#view").innerHTML += `<div class="section">Settings</div><button class="row" data-nav="permissions"><span class="hash">⚙︎</span><span class="name">Permissions</span></button>
      <button class="row" data-nav="remote"><span class="hash">⇄</span><span class="name">Remote access</span></button>
      <button class="row" data-nav="subscriptions"><span class="hash">◔</span><span class="name">Subscriptions</span></button>
      <button class="row" data-nav="control"><span class="hash">⚙︎</span><span class="name">Control files</span>${nCtl ? `<span class="sub">${nCtl} to look at</span>` : ""}</button>${st.capacity ? `<div class="capline">${esc(st.capacity.summary)}</div>` : ""}`;
    paintColors();
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
    $("#view").innerHTML = st.approvals.length ? st.approvals.map((a) => `
      <div class="card">
        <div class="what">${esc(st.agents[a.agentId]?.name || a.agentId)} wants to ${esc(a.action)}</div>
        <div class="detail">Using ${esc(a.tool)}${a.detail ? `\n\n${esc(a.detail)}` : ""}</div>
        <div class="actions">
          <button class="btn small" data-approval="${esc(a.id)}" data-decision="approved">Approve</button>
          <button class="btn small plain" data-approval="${esc(a.id)}" data-decision="rejected">Reject</button>
        </div>
      </div>`).join("") : `<div class="empty">Nothing waiting for you.</div>`;
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
      <div class="section"><span class="av mini" data-color="${esc(safeColor(a.color))}">${esc((a.name || "?")[0].toUpperCase())}</span>${esc(a.name)}</div>
      ${st.tools.map((tool) => {
        const on = !!a.tools?.[tool.id], auto = !!a.autoApprove?.[tool.id];
        const main = row(a, "tool", tool.id, on, tool.label, tool.sensitive ? (auto ? "Runs without asking" : "Asks you before each use") : "");
        const sub = tool.id === "shell" && on ? `<div class="nested">${row(a, "auto", "shell", auto, "Run shell commands without asking",
          a.adapter === "codex" ? "Codex already runs commands inside its sandbox without asking. This covers anything it asks the room about."
            : "Commands run right away. Each one is still logged in Activity and the audit log.")}</div>` : "";
        return main + sub;
      }).join("")}`).join("");
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
        ${f.extraPaths.length ? `<div class="detail warn">Funnel is also exposing ${esc(f.extraPaths.join(", "))} on the Mac. Close it on the Mac with: tailscale funnel reset</div>` : ""}
      </div>` : ""}`;
  }

  // First render of a room jumps to the first unread message (or the latest); later renders
  // follow new messages only if you're already at the bottom or just sent one.
  function renderMessages(follow) {
    if (st.view !== "room") return;
    const view = $("#view");
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 150;
    const msgs = st.messages.filter(visibleMsg);
    let html = "", prev, marked = false;
    for (const m of msgs) {
      if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) html += `<div class="day">${esc(dayLabel(m.createdAt))}</div>`;
      if (!marked && st.readAt > 0 && m.createdAt > st.readAt && m.author.kind !== "human") { html += `<div class="new" id="newLine"><span>New</span></div>`; marked = true; }
      const sys = m.type === "system" || m.author.kind === "system";
      const grouped = prev && prev.author.id === m.author.id && !sys && prev.type !== "system" && m.createdAt - prev.createdAt < 5 * 60_000
        && new Date(prev.createdAt).toDateString() === new Date(m.createdAt).toDateString();
      const agent = st.agents[m.author.id];
      const color = m.author.kind === "human" ? "#1e242c" : sys ? "#c7ced6" : safeColor(agent?.color);
      const name = m.author.kind === "human" ? (st.ownerName || m.author.name) : (agent?.name || m.author.name);
      const plan = m.planGoalId ? st.goals[m.planGoalId] : null;
      const actions = plan && plan.status === "awaiting_approval" ? `
        <div class="actions">
          <button class="btn small" data-plan="${esc(plan.id)}" data-decision="approve">Approve and start</button>
          <button class="btn small plain" data-plan="${esc(plan.id)}" data-decision="revise">Change it…</button>
          <button class="btn small ghost" data-plan="${esc(plan.id)}" data-decision="cancel">Cancel</button>
        </div>` : "";
      html += `<div class="msg${grouped ? "" : " first"}${sys ? " system" : ""}${m.planGoalId ? " plan" : ""}">
        <span class="av" data-color="${esc(color)}">${sys ? "•" : esc((name || "?")[0].toUpperCase())}</span>
        <div class="body">${grouped ? "" : `<div class="who">${esc(sys ? "Agent Room" : name)}<span class="when">${esc(time(m.createdAt))}</span></div>`}
          <div class="text">${md(m.text)}</div>${actions}</div></div>`;
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
  }

  // Colors go on through the DOM, not inline style attributes, so the page's CSP can forbid inline styles.
  function paintColors() { for (const el of document.querySelectorAll("[data-color]")) el.style.background = el.dataset.color; }

  // ---------- actions
  async function sendMessage(text) {
    text = text.trim(); if (!text || !st.roomId) return;
    $("#sendBtn").disabled = true;
    try { await api(`/rooms/${st.roomId}/messages`, { method: "POST", body: { text } }); $("#input").value = ""; grow(); }
    catch (e) { if (e.message !== "unpaired") toast(e.message); }
    finally { $("#sendBtn").disabled = false; }
  }

  function grow() { const i = $("#input"); i.style.height = "auto"; i.style.height = `${Math.min(i.scrollHeight, innerHeight * 0.4)}px`; }

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t) return;
    try {
      if (t.dataset.room) return go("room", t.dataset.room);
      if (t.dataset.nav === "permissions") {
        go("permissions");
        if (!st.tools.length) { st.tools = await api("/tools"); if (st.view === "permissions") renderPermissions(); }
        return;
      }
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
      if (t.dataset.approval) {
        t.disabled = true;
        await api(`/approvals/${t.dataset.approval}`, { method: "POST", body: { decision: t.dataset.decision } });
        st.approvals = st.approvals.filter((a) => a.id !== t.dataset.approval); renderBadge(); renderApprovals();
        return;
      }
      if (t.dataset.steer) {
        if (t.dataset.steer === "/stop") { if (confirm("Stop all work in this room?")) await sendMessage("/stop"); return; }
        const i = $("#input"); i.value = t.dataset.steer + i.value.replace(/^\/(redirect|replan)\s*/, ""); i.focus(); grow();
        return;
      }
    } catch (err) { t.disabled = false; if (err.message !== "unpaired") toast(err.message); }
  });

  // Permission switches: tool on/off, or the nested "without asking" setting.
  document.addEventListener("change", async (e) => {
    const el = e.target; if (!el.matches?.("input.switch") || el.dataset.remote) return;
    const { agent, kind, tool } = el.dataset;
    el.disabled = true;
    try {
      const updated = await api(`/agents/${agent}/${kind === "auto" ? "auto-approve" : "tools"}`, { method: "PUT", body: { [tool]: el.checked } });
      if (updated?.id) st.agents[updated.id] = updated;
      renderPermissions();
    } catch (err) { el.checked = !el.checked; el.disabled = false; if (err.message !== "unpaired") toast(err.message); }
  });

  // Funnel switch (1.2). Turning it on asks first; the hub does the work and tells us what Tailscale ended up doing.
  document.addEventListener("change", async (e) => {
    const el = e.target; if (!el.matches?.("input.switch") || !el.dataset.remote) return;
    if (el.checked && !confirm("Turn on Funnel? Cloud agents can then reach this Mac's /mcp address. Every call still needs a token. You can turn it off here at any time.")) { el.checked = false; return; }
    el.disabled = true;
    try { st.remote = await api("/remote/funnel", { method: "POST", body: { on: el.checked } }); renderRemote(); }
    catch (err) { el.checked = !el.checked; el.disabled = false; if (err.message !== "unpaired") toast(err.message); }
  });

  $("#back").onclick = () => go("rooms");
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
  $("#approvalsBtn").onclick = () => go("approvals");
  $("#send").onsubmit = (e) => { e.preventDefault(); void sendMessage($("#input").value); };
  $("#input").addEventListener("input", grow);
  $("#input").addEventListener("keydown", (e) => {
    // On a keyboard, Enter sends and Shift+Enter makes a new line. On a phone, Return is a new line; use the send button.
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); void sendMessage($("#input").value); }
  });
  // iOS suspends sockets in the background; reconnect and catch up when the app comes back.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && st.token) { if (!st.ws) connectWs(); else void refresh(); } });

  if (st.token) void start(); else render();
})();
