// Reads a unified diff for the phone app. A hand port of packages/shared/src/diff.ts (the phone app has no build step);
// test/fileaccess-ui.test.ts runs both over the same diffs and requires identical answers. Change them together.
"use strict";
(function (root) {
  var HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  var META = /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index )/;
  var stripPrefix = function (s) { return s === "/dev/null" ? null : s.replace(/^[ab]\//, ""); };

  function parseUnifiedDiff(diff) {
    var out = { oldPath: null, newPath: null, isNew: false, hunks: [], added: 0, removed: 0, lineCount: 0, stray: [] };
    var lines = String(diff).split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    var cur, remOld = 0, remNew = 0, oldNo = 0, newNo = 0, sawOld = false, sawNew = false;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (cur && (remOld > 0 || remNew > 0)) {
        var c = raw.charAt(0);
        if (c === "+") { cur.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ }); cur.added++; remNew--; continue; }
        if (c === "-") { cur.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ }); cur.removed++; remOld--; continue; }
        if (c === " " || raw === "") { cur.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ }); remOld--; remNew--; continue; }
        if (c === "\\") { var last = cur.lines[cur.lines.length - 1]; if (last) last.noNewline = true; continue; }
        out.stray.push(raw); continue;
      }
      if (raw.indexOf("\\") === 0 && cur && cur.lines.length) { cur.lines[cur.lines.length - 1].noNewline = true; continue; }
      var h = HUNK.exec(raw);
      if (h) {
        cur = {
          header: raw, oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]),
          newStart: Number(h[3]), newCount: h[4] === undefined ? 1 : Number(h[4]), lines: [], added: 0, removed: 0,
        };
        out.hunks.push(cur);
        remOld = cur.oldCount; remNew = cur.newCount; oldNo = cur.oldStart; newNo = cur.newStart;
        continue;
      }
      if (!out.hunks.length && raw.indexOf("--- ") === 0 && !sawOld) { sawOld = true; out.oldPath = stripPrefix(raw.slice(4)); out.isNew = raw.slice(4) === "/dev/null"; continue; }
      if (!out.hunks.length && raw.indexOf("+++ ") === 0 && !sawNew) { sawNew = true; out.newPath = stripPrefix(raw.slice(4)); continue; }
      if (META.test(raw) && !out.hunks.length) continue;
      out.stray.push(raw);
    }
    out.hunks.forEach(function (hk) { out.added += hk.added; out.removed += hk.removed; out.lineCount += hk.lines.length; });
    var open = cur && (remOld > 0 || remNew > 0);
    if (open) out.problem = "This diff is cut off before the end, so it is not the whole change.";
    else if (out.stray.length) out.problem = "Part of this change can't be shown as lines. Reject it and ask the agent for smaller edits.";
    else if (!out.hunks.length) out.problem = "There are no changed lines to show.";
    return out;
  }

  function flattenDiff(d) {
    var rows = [];
    d.hunks.forEach(function (h, i) {
      rows.push({ type: "hunk", hunk: i, header: h.header });
      for (var j = 0; j < h.lines.length; j++) rows.push({ type: "line", hunk: i, line: h.lines[j] });
    });
    return rows;
  }

  var SCROLL_SLACK = 16;
  function needsScrollGate(viewportH, contentH, slack) { return contentH > viewportH + (slack === undefined ? SCROLL_SLACK : slack); }
  function scrolledToEnd(offsetY, viewportH, contentH, slack) { return offsetY + viewportH >= contentH - (slack === undefined ? SCROLL_SLACK : slack); }
  function isFileWriteApproval(a) { return a.tool === "filesystem" && a.action.indexOf("write ") === 0; }

  function findProposalForApproval(a, proposals) {
    var p;
    if (a.proposalId) { p = proposals.find(function (x) { return x.id === a.proposalId; }); if (p) return p; }
    var linked = proposals.find(function (x) { return x.approvalId === a.id; });
    if (linked) return linked;
    var m = /^(?:!! [^\n]*\n)?Write proposal (\S+?):/.exec(a.detail || "");
    if (!m) return undefined;
    return proposals.find(function (x) { return x.id === m[1] && x.status === "pending" && x.agentId === a.agentId && (x.approvalId === undefined || x.approvalId === a.id); });
  }

  root.ARDiff = {
    parseUnifiedDiff: parseUnifiedDiff, flattenDiff: flattenDiff, needsScrollGate: needsScrollGate, scrolledToEnd: scrolledToEnd,
    isFileWriteApproval: isFileWriteApproval, findProposalForApproval: findProposalForApproval, SCROLL_SLACK: SCROLL_SLACK,
  };
})(typeof window !== "undefined" ? window : globalThis);
