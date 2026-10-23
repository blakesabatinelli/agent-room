// 4.4 Fork a goal, on the phone: two sides of one goal, side by side, and the blind comparison.
// On a phone the sides are tabs (A, B, Compare); on a wide screen they are two columns with the comparison under them.
// Builds the page with DOM calls only (the page's CSP forbids inline styles and scripts). app.js owns the data and the routes.
"use strict";
(function (root) {
  var STATUS = {
    planning: "Planning", awaiting_approval: "Waiting for your plan approval", running: "Working", paused: "Paused",
    done: "Done", failed: "Did not finish", superseded: "Replaced", needs_input: "Needs your input", waiting: "Needs your input",
  };
  var VERDICT = { PASS: "Met", FAIL: "Not met", UNSURE: "Unsure" };
  var CHANGE = { added: "New", modified: "Changed", deleted: "Removed" };

  function h(tag, props) {
    var e = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === undefined || v === null || v === false) return;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.indexOf("data-") === 0 || k.indexOf("aria-") === 0 || k === "role" || k === "type") e.setAttribute(k, v === true ? "" : v);
      else e[k] = v;
    });
    for (var i = 2; i < arguments.length; i++) {
      var kids = [].concat(arguments[i]);
      for (var j = 0; j < kids.length; j++) { var c = kids[j]; if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); }
    }
    return e;
  }

  function money(n) { return n >= 1 ? "$" + n.toFixed(2) : n > 0 ? "$" + n.toFixed(3) : "$0"; }
  function tokens(n) { return n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }
  function duration(s) { return s >= 3600 ? Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m" : s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s"; }
  function letter(side) { return String(side).toUpperCase(); }
  function mark(v) { return v === "PASS" ? "✓" : v === "FAIL" ? "✗" : "?"; }

  function preferenceLine(v) {
    var c = v.comparison;
    if (!c) return v.comparing ? "The judges are comparing the two sides." : v.state === "waiting" ? "Waiting for your approval before the sides start." : "The comparison starts when both sides are done.";
    if (c.state === "failed") return c.note || "The judges could not compare the two sides.";
    if (c.preference === "a" || c.preference === "b") return "The judges lean to side " + letter(c.preference) + (c.agreement ? ", the same answer in both orders." : ".");
    if (c.preference === "tie") return "The judges see no clear difference.";
    return "The judges did not agree, so there is no pick. Read both and choose.";
  }

  function rosterRow(side, ui) {
    return h("div", { class: "fk-roster" }, side.roster.map(function (a) {
      return h("span", { class: "fk-agent" }, h("span", { class: "av mini", "data-color": ui.safeColor(a.color), text: (a.name || "?").charAt(0).toUpperCase() }), a.name);
    }));
  }

  function sidePanel(v, side, ui, state) {
    var open = state.open;
    var cost = side.cost, doneReqs = side.requirements.filter(function (r) { return r.status === "met"; }).length;
    var suggested = v.comparison && v.comparison.preference === side.side;
    var shown = side.deliverables.files.map(function (f) {
      var label = h("span", { class: "fk-file" }, h("b", { class: "fk-tag", text: CHANGE[f.change] || f.change }), f.path);
      if (!f.diff) return h("div", { class: "fk-row" }, label, h("small", { text: f.binary ? "Not text" : f.truncated ? "Too large to show" : "" }));
      var key = side.side + ":" + f.path;
      var d = h("details", { class: "fk-diff" }, h("summary", {}, label), h("pre", { text: f.diff }));
      d.open = !!open[key];
      d.ontoggle = function () { open[key] = d.open; };
      return d;
    });
    return h("section", { class: "fk-side", "data-side": side.side, "aria-label": "Side " + letter(side.side) },
      h("div", { class: "fk-head" }, h("b", { class: "fk-title", text: "Side " + letter(side.side) }),
        suggested ? h("span", { class: "chip ok", text: "Judges' pick" }) : null,
        v.merged && v.merged.side === side.side ? h("span", { class: "chip ok", text: "Merged" }) : null,
        side.archived ? h("span", { class: "chip", text: "Archived" }) : null),
      rosterRow(side, ui),
      h("div", { class: "fk-status" }, STATUS[side.status] || side.status, side.waitingOnOwner ? ": " + side.waitingOnOwner : ""),
      h("div", { class: "fk-meta" },
        h("span", { text: side.tasks.done + " of " + side.tasks.total + " tasks done" }),
        h("span", { text: duration(side.time.seconds) }),
        h("span", { text: cost.runs + (cost.runs === 1 ? " run" : " runs") }),
        h("span", { text: tokens(cost.inputTokens + cost.outputTokens) + " tokens" }),
        cost.costUsd > 0 ? h("span", { text: money(cost.costUsd) }) : null),
      h("div", { class: "fk-h" }, "Summary"),
      h("div", { class: "fk-summary", text: side.summary || "No summary yet." }),
      side.requirements.length ? h("div", { class: "fk-h" }, "Done means", h("small", { text: doneReqs + " of " + side.requirements.length + " met" })) : null,
      side.requirements.map(function (r) {
        return h("div", { class: "fk-req " + r.status }, h("i", { "aria-hidden": "true", text: r.status === "met" ? "✓" : r.status === "unmet" ? "✗" : "○" }), r.text);
      }),
      h("div", { class: "fk-h" }, "Delivered", h("small", { text: side.deliverables.files.length + side.deliverables.more + " files, " + side.deliverables.docs.length + " documents" })),
      shown.length ? shown : h("div", { class: "fk-none", text: "No file changes." }),
      side.deliverables.more ? h("div", { class: "fk-none", text: side.deliverables.more + " more files not shown." }) : null,
      side.deliverables.docs.map(function (d) {
        return h("div", { class: "fk-row" }, h("span", { class: "fk-file" }, h("b", { class: "fk-tag", text: "Doc" }), d.title), h("small", { text: d.status === "superseded" ? "Superseded" : d.status }));
      }),
      side.accepted.length ? h("div", { class: "fk-h" }, "Accepted tasks", h("small", { text: String(side.accepted.length) })) : null,
      side.accepted.map(function (t) { return h("div", { class: "fk-row" }, h("span", { text: t.title }), h("small", { text: t.agentName || "" })); }));
  }

  function comparePanel(v, ui, state, act) {
    var c = v.comparison;
    var node = h("section", { class: "fk-compare", "aria-label": "Compare" },
      h("div", { class: "fk-head" }, h("b", { class: "fk-title", text: "Compare" })),
      h("div", { class: "fk-pref", text: preferenceLine(v) }));
    if (c) {
      if (c.reasons.length) node.append(h("ul", { class: "fk-reasons" }, c.reasons.map(function (r) { return h("li", { text: r }); })));
      if (c.requirements.length) {
        node.append(h("div", {}, h("div", { class: "fk-h" }, "Each requirement"),
          h("div", { class: "fk-grid head" }, h("span", { text: "Requirement" }), h("span", { text: "A" }), h("span", { text: "B" })),
          c.requirements.map(function (r) {
            return h("div", { class: "fk-grid" }, h("span", { class: "fk-reqtext", text: r.text, title: r.note || "" }),
              h("span", { class: "fk-v " + r.a, "aria-label": "Side A " + (VERDICT[r.a] || r.a), text: mark(r.a) }),
              h("span", { class: "fk-v " + r.b, "aria-label": "Side B " + (VERDICT[r.b] || r.b), text: mark(r.b) }));
          })));
      }
      node.append(h("div", { class: "fk-note", text: (c.independence === "full" ? "The judges came from outside both teams." : "Some judges share a model family with a team.") + " They saw neutral text with no names, in both orders." }));
    }
    if (v.merged) {
      node.append(h("div", { class: "fk-done", text: "Merged side " + letter(v.merged.side) + ". " + v.merged.detail }));
      return node;
    }
    var waiting = v.sides.some(function (s) { return s.awaitingApproval; });
    var actions = h("div", { class: "fk-actions" });
    if (waiting) actions.append(h("button", { class: "btn small", type: "button", "data-fk": "plan", text: "Approve plans" }));
    if (v.mergeBlocked) node.append(h("div", { class: "fk-note", text: v.mergeBlocked }));
    ["a", "b"].forEach(function (s) {
      var side = v.sides.filter(function (x) { return x.side === s; })[0];
      var ready = side && ["done", "failed", "superseded"].indexOf(side.status) >= 0;
      var sure = state.confirm === s;
      actions.append(h("button", { class: "btn small" + (sure ? "" : " plain"), type: "button", "data-fk": "merge", "data-side": s, disabled: !ready || !!state.busy, text: sure ? "Confirm merge " + letter(s) : "Merge " + letter(s) }));
    });
    if (state.confirm) actions.append(h("button", { class: "btn small ghost", type: "button", "data-fk": "cancel", text: "Cancel" }));
    if (c && c.state !== "done" && !v.comparing) actions.append(h("button", { class: "btn small ghost", type: "button", "data-fk": "compare", text: "Compare again" }));
    node.append(actions, h("div", { class: "fk-note", text: "The other side is archived and stays here to read. Your choice decides; the pick above is only a suggestion." }));
    if (state.err) node.append(h("div", { class: "err", text: state.err }));
    return node;
  }

  /** Draws the fork into `host`. ui: { safeColor, paint, onAct(kind, side) }. state: { tab, confirm, busy, err, open }. */
  function render(host, v, state, ui) {
    state.open = state.open || {};
    if (!state.tab) state.tab = "a";
    var tabs = h("div", { class: "fk-tabs", role: "tablist" }, ["a", "b", "compare"].map(function (t) {
      return h("button", { class: "fk-tab" + (state.tab === t ? " on" : ""), type: "button", role: "tab", "aria-selected": state.tab === t ? "true" : "false", "data-fk-tab": t, text: t === "compare" ? "Compare" : "Side " + letter(t) });
    }));
    var wrap = h("div", { class: "fork", "data-tab": state.tab },
      h("div", { class: "fk-goal" }, h("div", { class: "fk-label", text: "Goal" }), h("div", { text: v.text }),
        v.target.label ? h("div", { class: "fk-target", text: v.target.label }) : null),
      tabs,
      h("div", { class: "fk-cols" }, v.sides.map(function (s) { return sidePanel(v, s, ui, state); })),
      comparePanel(v, ui, state));
    wrap.addEventListener("click", function (ev) {
      var b = ev.target.closest("button"); if (!b) return;
      if (b.dataset.fkTab) { state.tab = b.dataset.fkTab; wrap.dataset.tab = state.tab; for (var t of tabs.children) { var on = t.dataset.fkTab === state.tab; t.classList.toggle("on", on); t.setAttribute("aria-selected", on ? "true" : "false"); } return; }
      if (b.dataset.fk) ui.onAct(b.dataset.fk, b.dataset.side || "");
    });
    host.replaceChildren(wrap);
    ui.paint();
  }

  root.ARFork = { render: render, preferenceLine: preferenceLine };
})(typeof window !== "undefined" ? window : globalThis);
