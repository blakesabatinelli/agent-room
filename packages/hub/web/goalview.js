// What the goal card, the verdict chips and the jump sheet show, and the colour rules for agent tiles, for the phone app.
// A hand port of packages/shared/src/goalview.ts and colors.ts (the phone app has no build step); test/design.test.ts runs both
// over the same fixtures and requires identical answers. Change them together.
"use strict";
(function (root) {
  // ---------- colour (colors.ts)
  function parseColor(input) {
    var s = String(input).trim();
    var h = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (h) {
      var x = h[1];
      if (x.length === 3 || x.length === 4) x = x.split("").map(function (c) { return c + c; }).join("");
      if (x.length !== 6 && x.length !== 8) return null;
      var n = function (i) { return parseInt(x.slice(i, i + 2), 16); };
      return { r: n(0), g: n(2), b: n(4), a: x.length === 8 ? n(6) / 255 : 1 };
    }
    var f = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (f) return { r: Number(f[1]), g: Number(f[2]), b: Number(f[3]), a: f[4] === undefined ? 1 : Number(f[4]) };
    return null;
  }
  function composite(top, under) {
    var a = top.a;
    return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
  }
  function luminance(c) {
    var lin = function (v) { var x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  }
  function contrast(fg, bg, under) {
    var u = parseColor(under || "#FFFFFF") || { r: 255, g: 255, b: 255, a: 1 };
    var b0 = parseColor(bg), f0 = parseColor(fg);
    if (!b0 || !f0) return NaN;
    var b = composite(b0, u), f = composite(f0, b);
    var x = luminance(f), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function toHex(c) {
    return "#" + [c.r, c.g, c.b].map(function (v) { return Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0"); }).join("").toUpperCase();
  }
  function readableInk(bg) { return contrast("#FFFFFF", bg) >= contrast("#101418", bg) ? "#FFFFFF" : "#101418"; }
  function legibleOn(color, canvas, min) {
    min = min === undefined ? 3 : min;
    var c = parseColor(color), bg = parseColor(canvas);
    if (!c || !bg) return color;
    if (contrast(color, canvas) >= min) return toHex(c);
    var toward = luminance(bg) < 0.4 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
    var out = c;
    for (var i = 1; i <= 20 && contrast(toHex(out), canvas) < min; i++) {
      var t = i * 0.05;
      out = { r: c.r + (toward.r - c.r) * t, g: c.g + (toward.g - c.g) * t, b: c.b + (toward.b - c.b) * t, a: 1 };
    }
    return toHex(out);
  }
  function agentTone(color, canvas) {
    var bg = legibleOn(color, canvas), ink = readableInk(bg);
    if (contrast(ink, bg) < 4.5) {
      var c = parseColor(bg), cv = parseColor(canvas);
      if (c && cv) {
        var onDark = luminance(cv) < 0.4;
        ink = onDark ? "#101418" : "#FFFFFF";
        var toward = onDark ? 255 : 0;
        for (var i = 1; i <= 20 && contrast(ink, bg) < 4.5; i++) {
          var t = i * 0.05;
          bg = toHex({ r: c.r + (toward - c.r) * t, g: c.g + (toward - c.g) * t, b: c.b + (toward - c.b) * t, a: 1 });
        }
      }
    }
    return { bg: bg, ink: ink };
  }

  // ---------- the goal card (goalview.ts)
  var STATE_LABEL = { planning: "Planning", awaiting_approval: "Awaiting approval", running: "Running", waiting: "Waiting on you", paused: "Paused", done: "Done", failed: "Failed" };
  var STATE_TONE = { planning: "neutral", awaiting_approval: "warn", running: "accent", waiting: "warn", paused: "neutral", done: "ok", failed: "danger" };

  function goalStateKey(g) {
    if (g.status === "paused" && g.state && g.state.waitingOnOwner) return "waiting";
    if (g.status === "superseded") return "done";
    return g.status;
  }
  function pickGoal(goals) {
    var own = goals.filter(function (g) { return g.status !== "superseded"; });
    var live = function (g) { return g.status === "planning" || g.status === "awaiting_approval" || g.status === "running" || g.status === "paused"; };
    var byNew = function (a, b) { return b.createdAt - a.createdAt; };
    return own.filter(live).sort(byNew)[0] || own.sort(byNew)[0];
  }
  function goalCardModel(goal, tasks) {
    var key = goalStateKey(goal);
    var mine = tasks.filter(function (t) { return t.goalId === goal.id && t.status !== "cancelled"; });
    var reqs = ((goal.contract && goal.contract.requirements) || []).map(function (r) {
      var o = { id: r.id, text: r.text, status: r.status || "open" };
      if (r.evidence) o.evidence = r.evidence;
      return o;
    });
    var waiting = goal.state && goal.state.waitingOnOwner;
    var next = goal.state && goal.state.nextAction;
    var m = {
      goalId: goal.id,
      objective: (goal.contract && goal.contract.objective) || goal.text,
      state: { key: key, label: STATE_LABEL[key], tone: STATE_TONE[key] },
      requirements: reqs,
      met: reqs.filter(function (r) { return r.status === "met"; }).length,
      total: reqs.length,
      tasksDone: mine.filter(function (t) { return t.status === "done"; }).length,
      tasksTotal: mine.length,
      live: key !== "done" && key !== "failed",
    };
    if (waiting) m.note = { kind: "waiting", text: waiting };
    else if (next && key === "running") m.note = { kind: "next", text: next };
    return m;
  }
  function goalProgressLine(m) {
    var parts = [];
    if (m.total) parts.push(m.met + " of " + m.total + " met");
    if (m.tasksTotal) parts.push(m.tasksDone + " of " + m.tasksTotal + " " + (m.tasksTotal === 1 ? "task" : "tasks") + " done");
    return parts.join(", ");
  }
  function goalFraction(m) {
    if (m.state.key === "done") return 1;
    if (m.total) return m.met / m.total;
    if (m.tasksTotal) return m.tasksDone / m.tasksTotal;
    return 0;
  }

  // ---------- verdict chips
  var GLYPH = { accepted: "✓", sent_back: "↩", reassigned: "⇄", disputed: "≠", judging: "…", failed: "✕", needs_you: "?" };
  function chip(key, label, tone, score) {
    var c = { key: key, label: label, tone: tone, glyph: GLYPH[key] };
    if (score !== undefined) c.score = score;
    return c;
  }
  function verdictChip(task) {
    var j = task.judgment;
    var score = j ? Math.round(j.score * 100) : undefined;
    if (task.status === "review") return chip("judging", "Being judged", "neutral");
    if (task.status === "waiting") return chip("needs_you", "Needs you", "warn");
    if (task.status === "failed") return chip("failed", "Failed", "danger", score);
    if (!j) return null;
    if (j.jury && j.jury.split) return chip("disputed", "Disputed", "warn", score);
    if (j.verdict === "accept") return chip("accepted", "Accepted", "ok", score);
    if (j.verdict === "reassign") return chip("reassigned", "Reassigned", "warn", score);
    return chip("sent_back", "Sent back", "warn", score);
  }
  // message id -> task id, for the last agent message of each task
  function chipMessageIds(messages) {
    var last = {}, order = [];
    messages.forEach(function (m) {
      if (m.taskId && m.author.kind === "agent" && !m.quiet) { if (!(m.taskId in last)) order.push(m.taskId); last[m.taskId] = m.id; }
    });
    var out = {};
    order.forEach(function (taskId) { out[last[taskId]] = taskId; });
    return out;
  }

  // ---------- the jump sheet
  var SCREENS = [
    { id: "home", title: "Home", mac: "home", keywords: "home start goal overview" },
    { id: "approvals", title: "Approvals", mac: "approvals", phone: "approvals", keywords: "approve reject waiting" },
    { id: "folders", title: "Folders", mac: "folders", phone: "folders", keywords: "files access grants" },
    { id: "permissions", title: "Permissions", mac: "permissions", phone: "permissions", keywords: "tools shell switches" },
    { id: "settings", title: "Settings", mac: "settings", keywords: "preferences appearance dark light theme" },
    { id: "appearance", title: "Appearance", phone: "appearance", keywords: "dark light theme mode settings" },
    { id: "scorecard", title: "Scorecard", mac: "scorecard", phone: "scorecard", keywords: "first pass weekly ledger" },
    { id: "resumes", title: "Résumés", mac: "resumes", phone: "resumes", keywords: "resume probation strengths" },
    { id: "office", title: "Office", mac: "office", keywords: "3d desks live agents" },
    { id: "memory", title: "Memory", mac: "memory", keywords: "remember proposals" },
    { id: "policy", title: "Approval rules", mac: "policy", phone: "policy", keywords: "policy rules lease allow learned permission expire" },
    { id: "issues", title: "Issues", mac: "issues", phone: "issues", keywords: "problems recurring failures blocked trace dismiss" },
    { id: "agents", title: "Agents and connections", mac: "agents", phone: "personas", keywords: "connect personas people" },
  ];
  var COMMANDS = [
    { name: "pause", title: "Pause the room", hint: "Running tasks finish; nothing new starts" },
    { name: "resume", title: "Resume the room", hint: "Start new work again" },
    { name: "stop", title: "Stop all work", hint: "Stops everything running in this room" },
    { name: "digest", title: "Digest this room", hint: "Summarize what happened" },
  ];
  function paletteItems(inp) {
    var out = [];
    var dmIds = {};
    inp.rooms.forEach(function (r) { if (r.dmAgentId) dmIds[r.dmAgentId] = true; });
    var here = inp.rooms.filter(function (r) { return r.id === inp.currentRoomId; })[0];
    inp.rooms.filter(function (x) { return !x.dmAgentId; }).forEach(function (r) {
      out.push({ id: "room:" + r.id, group: "Rooms", title: r.name, hint: r.paused ? "Paused" : undefined, keywords: "room " + r.name, action: { kind: "room", roomId: r.id } });
    });
    inp.agents.filter(function (x) { return x.enabled; }).forEach(function (a) {
      out.push({ id: "dm:" + a.id, group: "Agents", title: a.name, hint: dmIds[a.id] ? "Direct message" : "Start a direct message", keywords: "agent dm direct message " + a.id + " " + a.name, action: { kind: "dm", agentId: a.id } });
    });
    if (here && !here.dmAgentId) out.push({ id: "goal:" + here.id, group: "Goals", title: "Start a goal here", hint: here.name, keywords: "goal new start task work " + here.name, action: { kind: "goal", roomId: here.id } });
    inp.rooms.filter(function (x) { return !x.dmAgentId && x.id !== inp.currentRoomId; }).forEach(function (r) {
      out.push({ id: "goal:" + r.id, group: "Goals", title: "Start a goal in " + r.name, keywords: "goal new start task work " + r.name, action: { kind: "goal", roomId: r.id } });
    });
    if (here) COMMANDS.forEach(function (c) {
      if (c.name === "pause" && here.paused) return;
      if (c.name === "resume" && !here.paused) return;
      out.push({ id: "cmd:" + c.name, group: "Room commands", title: c.title, hint: "/" + c.name, keywords: "/" + c.name + " " + c.name + " command " + c.hint, action: { kind: "command", text: "/" + c.name } });
    });
    SCREENS.forEach(function (s) {
      if (inp.screens.indexOf(s.id) < 0 || !(inp.platform === "mac" ? s.mac : s.phone)) return;
      out.push({ id: "page:" + s.id, group: "Screens", title: s.title, keywords: "open go screen " + (s.keywords || ""), action: { kind: "page", screen: s.id } });
    });
    return out;
  }
  function norm(s) { return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function filterPalette(items, query) {
    var words = norm(query).split(/\s+/).filter(Boolean);
    if (!words.length) return items;
    var scored = [];
    items.forEach(function (item, order) {
      var title = norm(item.title), hay = title + " " + norm(item.keywords);
      if (!words.every(function (w) { return hay.indexOf(w) >= 0; })) return;
      var score = words.reduce(function (s, w) {
        return s + (title.indexOf(w) === 0 ? 0 : title.split(/[\s/]+/).some(function (x) { return x.indexOf(w) === 0; }) ? 1 : title.indexOf(w) >= 0 ? 2 : 3);
      }, 0);
      scored.push({ item: item, score: score, order: order });
    });
    return scored.sort(function (a, b) { return a.score - b.score || a.order - b.order; }).map(function (x) { return x.item; });
  }

  root.ARView = {
    parseColor: parseColor, contrast: contrast, readableInk: readableInk, legibleOn: legibleOn, agentTone: agentTone,
    pickGoal: pickGoal, goalStateKey: goalStateKey, goalCardModel: goalCardModel, goalProgressLine: goalProgressLine, goalFraction: goalFraction,
    verdictChip: verdictChip, chipMessageIds: chipMessageIds, paletteItems: paletteItems, filterPalette: filterPalette,
  };
})(typeof window !== "undefined" ? window : globalThis);
