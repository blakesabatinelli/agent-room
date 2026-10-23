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

  // ---- 1.1 integration: one proposal, possibly several files (port of fetchProposalForApproval, splitFileDiffs, parseChangeDiff, flattenChange)
  function fetchProposalForApproval(a, api) {
    var first, hadFirst = false;
    var tryOne = a.proposalId ? api.one(a.proposalId).then(function (p) { return { p: p }; }, function (e) { first = e; hadFirst = true; return null; }) : Promise.resolve(null);
    return tryOne.then(function (hit) {
      if (hit) return hit.p;
      return api.list().then(function (list) {
        var found = findProposalForApproval({ id: a.id, agentId: a.agentId, detail: a.detail, proposalId: undefined }, list);
        if (found) return api.one(found.id);
        if (hadFirst) throw first;
        return undefined;
      }, function (e) { throw hadFirst ? first : e; });
    });
  }

  function splitFileDiffs(diff) {
    var lines = String(diff).split("\n");
    var parts = [[]];
    var remOld = 0, remNew = 0, hasHunk = false;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var cur = parts[parts.length - 1];
      if (remOld > 0 || remNew > 0) {
        var c = raw.charAt(0);
        if (c === "+") remNew--; else if (c === "-") remOld--; else if (c === " " || raw === "") { remOld--; remNew--; }
        cur.push(raw); continue;
      }
      var h = HUNK.exec(raw);
      if (h) { remOld = h[2] === undefined ? 1 : Number(h[2]); remNew = h[4] === undefined ? 1 : Number(h[4]); hasHunk = true; cur.push(raw); continue; }
      if (hasHunk && raw.indexOf("--- ") === 0 && (lines[i + 1] || "").indexOf("+++ ") === 0) {
        while (cur.length && cur[cur.length - 1] === "") cur.pop();
        parts.push([raw]); hasHunk = false; continue;
      }
      cur.push(raw);
    }
    return parts.map(function (p) { return p.join("\n"); });
  }

  function parseChangeDiff(diff, files) {
    var sections = splitFileDiffs(diff).map(function (text) {
      var parsed = parseUnifiedDiff(text);
      var path = parsed.newPath !== null ? parsed.newPath : parsed.oldPath;
      var listed = files ? files.find(function (f) { return f.relPath === path; }) : undefined;
      return { path: path, op: listed ? listed.op : (parsed.isNew ? "create" : parsed.newPath === null && parsed.oldPath !== null ? "delete" : "edit"), parsed: parsed };
    });
    var out = { sections: sections, added: 0, removed: 0, places: 0 };
    sections.forEach(function (s) { out.added += s.parsed.added; out.removed += s.parsed.removed; out.places += s.parsed.hunks.length; });
    var bad = sections.find(function (s) { return s.parsed.problem; });
    if (bad) out.problem = bad.parsed.problem;
    else if (files && files.length !== sections.length) out.problem = "This change lists " + files.length + " file" + (files.length === 1 ? "" : "s") + " but the diff shows " + sections.length + ", so it is not the whole change.";
    else if (files && sections.some(function (s) { return !files.some(function (f) { return f.relPath === s.path; }); })) out.problem = "The diff shows a file the change doesn't list, so it is not safe to approve here.";
    return out;
  }

  function flattenChange(c) {
    var rows = [];
    c.sections.forEach(function (s, si) {
      if (c.sections.length > 1) rows.push({ type: "file", path: s.path === null ? "?" : s.path, op: s.op, added: s.parsed.added, removed: s.parsed.removed });
      s.parsed.hunks.forEach(function (h, i) {
        rows.push({ type: "hunk", hunk: si * 100000 + i, header: h.header });
        h.lines.forEach(function (line) { rows.push({ type: "line", hunk: si * 100000 + i, line: line }); });
      });
    });
    return rows;
  }

  function opWords(op) { return op === "create" ? "New file" : op === "delete" ? "Deleted" : "Changed"; }

  root.ARDiff = {
    parseUnifiedDiff: parseUnifiedDiff, flattenDiff: flattenDiff, needsScrollGate: needsScrollGate, scrolledToEnd: scrolledToEnd,
    isFileWriteApproval: isFileWriteApproval, findProposalForApproval: findProposalForApproval, SCROLL_SLACK: SCROLL_SLACK,
    fetchProposalForApproval: fetchProposalForApproval, splitFileDiffs: splitFileDiffs, parseChangeDiff: parseChangeDiff, flattenChange: flattenChange, opWords: opWords,
  };
})(typeof window !== "undefined" ? window : globalThis);
