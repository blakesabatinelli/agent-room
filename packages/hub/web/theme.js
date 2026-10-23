// Applies the saved Appearance choice (System, Light or Dark) before the page paints, so there is no flash of the wrong mode.
// System means no data-theme at all: app.css then follows prefers-color-scheme. Loaded in <head>, no inline script (the CSP forbids one).
"use strict";
(function () {
  var KEY = "agentroom.theme";
  var mode = "system";
  try { var v = localStorage.getItem(KEY); if (v === "light" || v === "dark") mode = v; } catch (e) { /* private mode: follow the system */ }
  var query = window.matchMedia("(prefers-color-scheme: dark)");
  var isDark = function () { return mode === "dark" || (mode === "system" && query.matches); };
  function apply() {
    if (mode === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", mode);
    var meta = document.getElementById("themeColor");
    if (meta) meta.setAttribute("content", isDark() ? "#121518" : "#ffffff");
  }
  apply();
  var listeners = [];
  var changed = function () { apply(); listeners.forEach(function (fn) { fn(); }); };
  if (query.addEventListener) query.addEventListener("change", changed);
  window.ARTheme = {
    mode: function () { return mode; },
    dark: isDark,
    set: function (m) {
      mode = m === "light" || m === "dark" ? m : "system";
      try { if (mode === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) { /* kept for this visit only */ }
      changed();
    },
    /** Called after the mode changes, by the choice or by the system. */
    onChange: function (fn) { listeners.push(fn); },
    /** The canvas colour in use right now, for agent tiles. */
    canvas: function () { return isDark() ? "#121518" : "#FFFFFF"; },
  };
  // The meta tag is below this script in the head; set it once the document has parsed it.
  document.addEventListener("DOMContentLoaded", apply);
})();
