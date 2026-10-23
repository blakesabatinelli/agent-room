import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildServer } from "../src/api/server.js";
import { unifiedDiff } from "../src/files/diff.js";
import {
  fetchProposalForApproval, findProposalForApproval, flattenChange, flattenDiff, isFileWriteApproval, needsScrollGate, parseChangeDiff, parseUnifiedDiff, scrolledToEnd,
  splitFileDiffs, type ParsedDiff,
} from "../../shared/src/diff.js";
import { setup } from "./helpers.js";

// 1.1 (app side): the folder screens and the full-diff approval view. The screens themselves are checked by hand
// (docs/screenshots/1.1-*.png); here are the parts that can break silently: the diff reader, the rule for when Approve
// turns on, how an approval finds its proposal, and that the phone app only calls routes the hub really has.

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "../web");
const appSrc = join(here, "../../app/src");
const appJs = readFileSync(join(webDir, "app.js"), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The phone app's own copy of the reader (web/diff.js), loaded the way a browser would. */
const web = (() => {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(readFileSync(join(webDir, "diff.js"), "utf8"), sandbox);
  return sandbox.window.ARDiff as {
    parseUnifiedDiff(d: string): ParsedDiff; flattenDiff(d: ParsedDiff): unknown[];
    needsScrollGate(v: number, c: number, s?: number): boolean; scrolledToEnd(o: number, v: number, c: number, s?: number): boolean;
    isFileWriteApproval(a: { tool: string; action: string }): boolean; findProposalForApproval: typeof findProposalForApproval;
    fetchProposalForApproval: typeof fetchProposalForApproval; splitFileDiffs: typeof splitFileDiffs; parseChangeDiff: typeof parseChangeDiff;
    flattenChange(c: unknown): unknown[]; opWords(op: string): string;
  };
})();
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** Rebuild both sides of a change from a parsed diff and the file it was made against. */
function replay(oldText: string | null, d: ParsedDiff): { old: string; next: string } {
  const oldLines = oldText === null ? [] : oldText.split("\n");
  if (oldLines.length && oldLines[oldLines.length - 1] === "") oldLines.pop();
  const outNew: string[] = [], outOld: string[] = [];
  let at = 0; // next old line (0-based) not yet copied
  for (const h of d.hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    while (at < start) { outNew.push(oldLines[at]); outOld.push(oldLines[at]); at++; }
    for (const l of h.lines) {
      if (l.kind !== "add") { assert.equal(l.text, oldLines[at], `old line ${at + 1}`); outOld.push(l.text); at++; }
      if (l.kind !== "del") outNew.push(l.text);
    }
  }
  while (at < oldLines.length) { outNew.push(oldLines[at]); outOld.push(oldLines[at]); at++; }
  return { old: outOld.join("\n"), next: outNew.join("\n") };
}
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";

// ---------- the diff reader

test("diff reader: an edit gives hunks, counts and line numbers", () => {
  const old = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
  const next = "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\n";
  const d = parseUnifiedDiff(unifiedDiff("notes/a.txt", old, next));
  assert.equal(d.oldPath, "notes/a.txt");
  assert.equal(d.newPath, "notes/a.txt");
  assert.equal(d.isNew, false);
  assert.equal(d.problem, undefined);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.equal(d.hunks.length, 1);
  const del = d.hunks[0].lines.find((l) => l.kind === "del")!;
  assert.deepEqual([del.text, del.oldNo], ["three", 3]);
  const add = d.hunks[0].lines.find((l) => l.kind === "add")!;
  assert.deepEqual([add.text, add.newNo], ["THREE", 3]);
  assert.equal(d.lineCount, d.hunks[0].lines.length);
  assert.equal(flattenDiff(d).length, d.lineCount + d.hunks.length);
});

test("diff reader: a new file, an empty-to-text change, and hunks far apart", () => {
  const created = parseUnifiedDiff(unifiedDiff("new.md", null, "hello\nworld\n"));
  assert.equal(created.isNew, true);
  assert.equal(created.oldPath, null);
  assert.deepEqual([created.added, created.removed, created.hunks.length], [2, 0, 1]);
  assert.deepEqual(replay(null, created).next, "hello\nworld");

  const old = lines(100, (i) => `line ${i}`);
  const next = old.replace("line 5\n", "FIVE\n").replace("line 90\n", "NINETY\n");
  const d = parseUnifiedDiff(unifiedDiff("far.txt", old, next));
  assert.equal(d.hunks.length, 2);
  assert.deepEqual([d.added, d.removed], [2, 2]);
});

test('diff reader: "\\ No newline at end of file" sticks to the line it follows, on either side', () => {
  const d1 = parseUnifiedDiff(unifiedDiff("a.txt", "a\nb\n", "a\nb"));            // lost its final newline
  assert.equal(d1.problem, undefined);
  assert.deepEqual(d1.hunks[0].lines.map((l) => [l.kind, l.text, !!l.noNewline]), [["ctx", "a", false], ["del", "b", false], ["add", "b", true]]);
  const d2 = parseUnifiedDiff(unifiedDiff("a.txt", "a\nb", "a\nb\nc"));           // had none, now has more
  assert.equal(d2.problem, undefined);
  assert.deepEqual(d2.hunks[0].lines.map((l) => [l.kind, l.text, !!l.noNewline]), [["ctx", "a", false], ["del", "b", true], ["add", "b", false], ["add", "c", true]]);
  const d3 = parseUnifiedDiff(unifiedDiff("n.txt", null, "only"));                // new file with no final newline
  assert.equal(d3.problem, undefined);
  assert.equal(d3.hunks[0].lines[0].noNewline, true);
  assert.equal(d3.lineCount, 1, "the marker is not a line");
  // the marker after the very last line of a hunk is still attached (counts are already used up)
  const raw = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
  const d4 = parseUnifiedDiff(raw);
  assert.equal(d4.problem, undefined);
  assert.deepEqual(d4.hunks[0].lines.map((l) => !!l.noNewline), [true, true]);
});

test("diff reader: lines that look like headers or hunk markers are still just lines inside a hunk", () => {
  const old = "keep\n-- sql comment\n@@ not a hunk @@\n++ plus plus\nend\n";
  const next = "keep\n--- three dashes\n+++ three pluses\n@@ -1,1 +1,1 @@\nend\n";
  const d = parseUnifiedDiff(unifiedDiff("tricky.txt", old, next));
  assert.equal(d.problem, undefined, d.problem);
  assert.deepEqual(d.stray, []);
  const r = replay(old, d);
  assert.equal(r.next, next.replace(/\n$/, ""));
  assert.equal(r.old, old.replace(/\n$/, ""));
  assert.ok(d.hunks[0].lines.some((l) => l.kind === "add" && l.text === "+++ three pluses"), "a file line that starts with +++ is an added line");
  assert.ok(d.hunks[0].lines.some((l) => l.kind === "del" && l.text === "-- sql comment"), "--- line is a removed line");
});

test("diff reader: blank and tab-only lines, CRLF and non-ASCII survive", () => {
  const old = "a\n\n\tb\r\nc\n";
  const next = "a\n\n\tB\r\nc\né中😀\n";
  const d = parseUnifiedDiff(unifiedDiff("odd.txt", old, next));
  assert.equal(d.problem, undefined);
  const r = replay(old, d);
  assert.equal(r.next, next.replace(/\n$/, ""));
  assert.ok(d.hunks[0].lines.some((l) => l.text === "\tb\r"), "carriage returns are kept, not eaten");
});

test("diff reader: huge diffs are read whole, quickly, and every line is there", () => {
  const n = 4900; // the hub's limit is 5,000 lines a side
  const old = lines(n, (i) => `row ${i} ${"x".repeat(60)}`);
  const next = lines(n, (i) => (i % 10 === 0 ? `ROW ${i} ${"y".repeat(60)}` : `row ${i} ${"x".repeat(60)}`));
  const diff = unifiedDiff("big.txt", old, next);
  assert.ok(diff.length > 100_000 || diff.split("\n").length > 7000, "a genuinely large diff");
  const t0 = performance.now();
  const d = parseUnifiedDiff(diff);
  const ms = performance.now() - t0;
  assert.equal(d.problem, undefined, d.problem);
  assert.equal(d.added, n / 10);
  assert.equal(d.removed, n / 10);
  assert.ok(ms < 1000, `parsed in ${ms.toFixed(0)} ms`);
  const r = replay(old, d);
  assert.equal(r.next, next.replace(/\n$/, ""), "nothing was dropped");
  assert.equal(flattenDiff(d).length, d.lineCount + d.hunks.length);

  // one enormous line
  const wide = parseUnifiedDiff(unifiedDiff("wide.txt", "a\n", "a" + "z".repeat(500_000) + "\n"));
  assert.equal(wide.problem, undefined);
  assert.equal(wide.hunks[0].lines.find((l) => l.kind === "add")!.text.length, 500_001);
});

test("diff reader: random edits replay exactly, and the web copy gives identical answers", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pool = ["", " ", "alpha", "beta", "--- x", "+++ y", "@@ -1 +1 @@", "\\ No newline at end of file", "tab\there", "ünï", "}", "{"];
  const randomText = () => {
    const n = Math.floor(rnd() * 40);
    const ls = Array.from({ length: n }, () => pool[Math.floor(rnd() * pool.length)] + (rnd() < 0.2 ? String(Math.floor(rnd() * 5)) : ""));
    return ls.join("\n") + (n && rnd() < 0.8 ? "\n" : "");
  };
  for (let i = 0; i < 300; i++) {
    const a = rnd() < 0.15 ? null : randomText();
    const b = randomText();
    if (a === b) continue;
    const diff = unifiedDiff("f.txt", a, b);
    const d = parseUnifiedDiff(diff);
    if (d.problem) { assert.match(diff, /@@ no line changes @@|@@ too large/); continue; }
    const r = replay(a, d);
    const want = (s: string | null) => (s === null ? "" : s.replace(/\n$/, ""));
    assert.equal(r.next, want(b), `case ${i}: new side`);
    assert.equal(r.old, want(a), `case ${i}: old side`);
    assert.deepEqual(plain(web.parseUnifiedDiff(diff)), plain(d), `case ${i}: web copy`);
    assert.deepEqual(plain(web.flattenDiff(d)), plain(flattenDiff(d)));
  }
});

test("diff reader: anything it cannot show whole is flagged, so the apps never offer Approve", () => {
  const cases: Record<string, string> = {
    "the hub's too-large note": "--- a/x\n+++ b/x\n@@ too large to diff: 6000 lines -> 6001 lines; the whole file is replaced (content hash is verified) @@\n",
    "no changes": "--- a/x\n+++ b/x\n@@ no line changes @@\n",
    "nothing at all": "",
    "cut off mid-hunk": unifiedDiff("x", lines(30, (i) => `a${i}`), lines(30, (i) => `b${i}`)).slice(0, 150),
    "extra lines after the hunk": "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n+sneaked in\n",
    "a line with no marker": "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\nZ not a diff line\n",
    "headers only": "--- a/x\n+++ b/x\n",
  };
  for (const [name, diff] of Object.entries(cases)) {
    const d = parseUnifiedDiff(diff);
    assert.ok(d.problem, `${name} must set a problem`);
    assert.equal(web.parseUnifiedDiff(diff).problem, d.problem, `${name}: web copy agrees`);
  }
  assert.match(parseUnifiedDiff(cases["cut off mid-hunk"]).problem!, /cut off/);
  // and a real diff has none
  assert.equal(parseUnifiedDiff(unifiedDiff("x", "a\n", "b\n")).problem, undefined);
  // never throws on junk
  for (const junk of ["@@", "@@ -1 +1 @@", "\\", "+", "-", "\u0000\u0000", "@@ -x +y @@\n+a"]) assert.doesNotThrow(() => parseUnifiedDiff(junk));
});

// ---------- when Approve turns on

test("read-to-the-end gate: only a diff longer than the window must be scrolled", () => {
  for (const g of [needsScrollGate, web.needsScrollGate]) {
    assert.equal(g(600, 400), false, "fits: no gate");
    assert.equal(g(600, 610), false, "within slack: no gate");
    assert.equal(g(600, 700), true);
    assert.equal(g(600, 50_000), true);
  }
  for (const f of [scrolledToEnd, web.scrolledToEnd]) {
    assert.equal(f(0, 600, 5000), false, "at the top");
    assert.equal(f(2000, 600, 5000), false, "halfway");
    assert.equal(f(4300, 600, 5000), false, "a hundred pixels short");
    assert.equal(f(4400, 600, 5000), true, "bottom");
    assert.equal(f(4390, 600, 5000), true, "within slack of the bottom");
    assert.equal(f(4500, 600, 5000), true, "rubber-banded past it");
  }
});

// ---------- which proposal an approval is about

test("approval to proposal: the hub's link wins, the preview text is a guarded last resort", () => {
  const P = (id: string, o: Record<string, unknown> = {}) => ({ id, agentId: "claude", status: "pending", ...o });
  const A = (o: Record<string, unknown> = {}) => ({ id: "ap_1", agentId: "claude", detail: "", ...o });
  for (const find of [findProposalForApproval, web.findProposalForApproval]) {
    const ps = [P("wp_a"), P("wp_b", { approvalId: "ap_1" }), P("wp_c")];
    assert.equal(find(A({ proposalId: "wp_c" }), ps)?.id, "wp_c", "proposalId first");
    assert.equal(find(A(), ps)?.id, "wp_b", "then the proposal's approvalId");
    assert.equal(find(A({ proposalId: "wp_gone" }), ps)?.id, "wp_b", "an unknown proposalId falls through");
    assert.equal(find(A({ detail: "Write proposal wp_a: edit x.txt in Notes (3 bytes)\n--- a/x" }), [P("wp_a")])?.id, "wp_a", "preview text, when nothing else links");
    assert.equal(find(A({ detail: "!! DIFF TRUNCATED: showing the first part of 9000 characters. Approving writes the WHOLE change.\nWrite proposal wp_a: edit x" }), [P("wp_a")])?.id, "wp_a", "truncated preview");
    // spoofing: an agent can word an approval any way it likes
    assert.equal(find(A({ detail: "Write proposal wp_a: hi" }), [P("wp_a", { agentId: "codex" })]), undefined, "another agent's proposal");
    assert.equal(find(A({ detail: "Write proposal wp_a: hi" }), [P("wp_a", { status: "applied" })]), undefined, "already decided");
    assert.equal(find(A({ detail: "Write proposal wp_a: hi" }), [P("wp_a", { approvalId: "ap_other" })]), undefined, "owned by another approval");
    assert.equal(find(A({ detail: "see Write proposal wp_a: hi" }), [P("wp_a")]), undefined, "must start the text");
    assert.equal(find(A(), [P("wp_a")]), undefined, "nothing links: no diff, so no Approve");
  }
});

test("only the hub's own file-write approvals open as a diff", () => {
  for (const f of [isFileWriteApproval, web.isFileWriteApproval]) {
    assert.equal(f({ tool: "filesystem", action: "write notes/a.txt" }), true);
    assert.equal(f({ tool: "filesystem", action: "read notes/a.txt" }), false);
    assert.equal(f({ tool: "shell", action: "write notes/a.txt" }), false);
    assert.equal(f({ tool: "gmail", action: "send" }), false);
  }
});

// ---------- the phone app against the real hub

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Phone" }) });
  const { token } = (await pr.json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { ...ctx, app, base, h };
}

/**
 * Every api("...") call in the phone app. Path parameters become :param; a `${cond ? "a" : "b"}` part becomes both
 * spellings, so each is checked; the query string is dropped.
 */
function webCalls(src: string): { method: string; urls: string[]; text: string }[] {
  const out: { method: string; urls: string[]; text: string }[] = [];
  for (const m of src.matchAll(/\bapi\(\s*(`[^`]*`|"[^"]*"|'[^']*')\s*(?:,\s*\{\s*method:\s*"(\w+)")?/g)) {
    const raw = m[1].slice(1, -1);
    let urls = [""];
    for (const part of raw.split(/(\$\{[^}]*\})/)) {
      const alts = part.startsWith("${")
        ? (part.includes("?") ? [...part.slice(part.indexOf("?")).matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]) : [":param"])
        : [part];
      urls = urls.flatMap((u) => alts.map((a) => u + a));
    }
    out.push({ method: m[2] ?? "GET", urls: urls.map((u) => u.replace(/\?.*$/, "")), text: raw });
  }
  return out;
}

test("phone app: every route app.js calls is a route the hub registers, and the file routes are among them", async (t) => {
  const { app } = await boot(); t.after(() => app.close());
  const calls = webCalls(appJs);
  assert.ok(calls.length > 15, `found ${calls.length} api calls`);
  const missing = calls.filter((c) => c.urls.some((u) => !app.hasRoute({ method: c.method as "GET", url: u.replace(/:param/g, ":id") })));
  assert.deepEqual(missing.map((c) => `${c.method} ${c.text}`), []);
  const has = (method: string, url: string) => calls.some((c) => c.method === method && c.urls.includes(url));
  assert.ok(has("GET", "/folder-grants"), "lists grants");
  assert.ok(has("POST", "/folder-grants"), "adds grants");
  assert.ok(has("DELETE", "/folder-grants/:param"), "removes grants");
  assert.ok(has("PUT", "/folder-grants/:param"), "changes a grant in place");
  assert.ok(has("POST", "/folder-grants/check"), "asks before adding");
  assert.ok(has("GET", "/write-proposals/:param"), "reads one whole proposal");
  assert.ok(has("GET", "/folder-grants"), "lists the folders a room can use");
  assert.ok(has("POST", "/approvals/:param"), "decides approvals");
  assert.ok(has("GET", "/approvals"), "lists approvals");
});

test("phone app: serves diff.js before app.js, no inline styles or scripts, switches and diff colours by class", async (t) => {
  const { app, base } = await boot(); t.after(() => app.close());
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.indexOf('src="/web/diff.js"') > 0 && html.indexOf('src="/web/diff.js"') < html.indexOf('src="/web/app.js"'));
  const js = await fetch(`${base}/web/diff.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  assert.match(js.headers.get("content-security-policy") ?? "", /style-src 'self'/);
  for (const [name, src] of [["app.js", appJs], ["diff.js", readFileSync(join(webDir, "diff.js"), "utf8")], ["index.html", html]] as const) {
    assert.doesNotMatch(src, /\sstyle\s*=\s*["'`\\]/, `${name}: no style attributes`);
    assert.doesNotMatch(src, /setAttribute\(\s*["']style["']/, `${name}: no setAttribute("style")`);
    assert.doesNotMatch(src, /\son[a-z]+\s*=\s*["']/, `${name}: no inline event handlers`);
  }
  const css = readFileSync(join(webDir, "app.css"), "utf8");
  for (const cls of [".dl.add", ".dl.del", ".dl.hunk", ".dv-bar", ".grant", ".plus", ".minus"]) assert.ok(css.includes(cls), `app.css styles ${cls}`);
  assert.doesNotMatch(appJs + readFileSync(join(webDir, "diff.js"), "utf8"), /—|–/, "no em or en dashes in copy");
});

test("a real file write: the phone app gets the whole diff and finds it from the approval", async (t) => {
  const { app, base, h, orch, store, room, dir } = await boot(); t.after(() => app.close());
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grant-ui-")));
  const original = lines(1200, (i) => `config ${i} = ${"v".repeat(40)}`);
  writeFileSync(join(root, "big.conf"), original);

  // add the folder the way the app does
  const added = await fetch(`${base}/folder-grants`, { method: "POST", headers: h, body: JSON.stringify({ path: root, label: "Config", agentId: "claude", read: true, write: true }) });
  assert.equal(added.status, 200);
  const grant = (await added.json()) as { id: string; write: boolean };
  assert.equal(grant.write, true);
  assert.equal(((await (await fetch(`${base}/folder-grants`, { headers: h })).json()) as unknown[]).length, 1);

  // the hub says why a folder can't be shared; the app shows that text
  const refused = await fetch(`${base}/folder-grants`, { method: "POST", headers: h, body: JSON.stringify({ path: "/", agentId: "*", read: true, write: false }) });
  assert.equal(refused.status, 400);
  assert.ok(((await refused.json()) as { error: string }).error.length > 10);

  // an agent proposes a change big enough that the 8,000-character approval preview cannot hold it
  const next = original.replace(/config (\d*[05]) =/g, "CONFIG $1 =");
  const res = orch.files.proposeWrite("claude", room.id, "big.conf", next, grant.id);
  assert.equal(res.ok, true);
  await until(() => store.listApprovals("pending").length === 1);
  const approval = store.listApprovals("pending")[0];
  assert.ok(isFileWriteApproval(approval));
  assert.match(approval.detail, /DIFF TRUNCATED/, "the preview really is cut");

  // 1.1 hub: the list leaves the diff out, and one proposal comes whole by id
  const proposals = (await (await fetch(`${base}/write-proposals`, { headers: h })).json()) as { id: string; approvalId?: string; diffBytes: number; status: string; agentId: string }[];
  assert.equal(proposals.length, 1);
  assert.ok(!("diff" in proposals[0]) && proposals[0].diffBytes > 8000, "no diff in the list, its size instead");
  assert.equal(findProposalForApproval(approval, proposals)?.id, approval.proposalId, "the list still backs the guarded fallbacks");
  type Whole = { id: string; diff: string; kind?: string; files?: { relPath: string; op: string }[]; skipped?: { relPath: string; reason: string }[]; unappliable?: string; relPath: string; status: string; agentId: string };
  const one = async (id: string) => { const r = await fetch(`${base}/write-proposals/${id}`, { headers: h }); if (!r.ok) throw new Error(((await r.json()) as { error: string }).error); return (await r.json()) as Whole; };
  // both copies of the app logic fetch the one proposal by the approval's proposalId, never the whole list
  for (const fetchFor of [fetchProposalForApproval, web.fetchProposalForApproval]) {
    const calls: string[] = [];
    const got = (await fetchFor(approval, { one: async (id: string) => { calls.push(`one ${id}`); return one(id); }, list: async () => { calls.push("list"); return proposals; } })) as Whole;
    assert.deepEqual(plain(calls), [`one ${approval.proposalId}`]);
    assert.equal(got.id, approval.proposalId);
    assert.ok(got.diff.length > 8000);
  }
  const found = await one(approval.proposalId!);
  const d = parseUnifiedDiff(found.diff);
  assert.equal(d.problem, undefined);
  assert.ok(d.added >= 200 && d.added === d.removed, `${d.added} lines changed, all of them shown`);
  assert.ok(found!.diff.length > 8000, "longer than the preview");
  assert.equal(replay(original, d).next, next.replace(/\n$/, ""));
  assert.deepEqual(plain(web.parseUnifiedDiff(found!.diff)), plain(d));
  const chg = parseChangeDiff(found.diff, found.files as { relPath: string; op: "create" | "edit" | "delete" }[]);
  assert.equal(chg.problem, undefined);
  assert.deepEqual([chg.sections.length, chg.added, chg.removed], [1, d.added, d.removed]);
  assert.deepEqual(plain(web.parseChangeDiff(found.diff, found.files as never)), plain(chg));

  // approving through the same route the app uses applies the full change
  const ok = await fetch(`${base}/approvals/${approval.id}`, { method: "POST", headers: h, body: JSON.stringify({ decision: "approved" }) });
  assert.equal(ok.status, 200);
  await until(() => readFileSync(join(root, "big.conf"), "utf8") === next);

  // a switch changes the grant in place (PUT), and only turning Write off drops what is waiting
  const put = await fetch(`${base}/folder-grants/${grant.id}`, { method: "PUT", headers: h, body: JSON.stringify({ label: "Config files" }) });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { id: string; label: string }).id, grant.id, "same grant, same id");
  // the Add button asks first: a normal folder is fine, the hub's own data folder needs an override, "/" never
  const check = async (path: string) => (await (await fetch(`${base}/folder-grants/check`, { method: "POST", headers: h, body: JSON.stringify({ path }) })).json()) as { ok: boolean; protected?: boolean; because?: string; error?: string; canForce?: boolean };
  assert.deepEqual([(await check(root)).ok, (await check(root)).protected], [true, false]);
  const prot = await check(dir);
  assert.deepEqual([prot.ok, prot.protected], [true, true], "the hub's own folder needs Grant anyway");
  assert.match(prot.because ?? "", /data folder/);
  const never = await check("/");
  assert.equal(never.ok, false);
  assert.equal(never.canForce, false);
  assert.ok(never.error!.length > 10, "the hub says why, in words the app shows as they are");

  // removing the grant, as the Remove button does
  assert.equal((await fetch(`${base}/folder-grants/${grant.id}`, { method: "DELETE", headers: h })).status, 200);
  assert.equal(((await (await fetch(`${base}/folder-grants`, { headers: h })).json()) as unknown[]).length, 0);
});

async function until(fn: () => boolean, ms = 3000) { for (let i = 0; i < ms / 10 && !fn(); i++) await sleep(10); assert.ok(fn(), "timed out waiting"); }

// ---------- the Mac app (typechecked in CI, run by hand): the wiring that must not be lost

test("Mac app: Folders is in the sidebar and the page map, approvals use the full diff, and the same rules apply", () => {
  const read = (p: string) => readFileSync(join(appSrc, p), "utf8");
  assert.match(read("state/store.ts"), /type Page = [^;]*"folders"/);
  assert.match(read("components/Sidebar.tsx"), /label="Folders"[^\n]*isPage\("folders"\)[^\n]*page\("folders"\)/);
  assert.match(read("App.tsx"), /folders: <FoldersScreen/);
  const client = read("api/client.ts");
  for (const m of ['"/folder-grants"', "`/folder-grants/${", '"/folder-grants/check"', '"PUT", `/folder-grants/${', '"/write-proposals"', "`/write-proposals/${"]) assert.ok(client.includes(m), `client calls ${m}`);
  assert.match(client, /folderGrantId \? \{ text, folderGrantId \}/, "a goal can start on a folder");
  const approvals = read("screens/ApprovalsScreen.tsx");
  assert.match(approvals, /fetchProposalForApproval/, "one proposal by the approval's proposalId, with the guarded fallbacks");
  assert.match(approvals, /isFileWriteApproval/);
  assert.match(approvals, /unappliable/);
  assert.match(approvals, /skipped/);
  const viewer = read("components/DiffViewer.tsx");
  assert.match(viewer, /scrolledToEnd/);
  assert.match(viewer, /needsScrollGate/);
  assert.match(viewer, /FlatList/, "long diffs are virtualised");
  assert.match(viewer, /disabled=\{!canApprove\}/);
  assert.match(viewer, /unappliable \? null : <Button label="Approve"/, "a change that can't be applied only gets Reject");
  const folders = read("screens/FoldersScreen.tsx");
  assert.match(folders, /updateFolderGrant\(g\.id, \{ \[key\]: value \}\)/, "a switch is a PUT, not add then delete");
  assert.doesNotMatch(folders, /added\.id/, "no add-then-delete toggle");
  assert.match(folders, /checkFolder\(/);
  assert.match(folders, /Grant anyway/);
  assert.match(folders, /reason\.trim\(\)\.length < 8/);
  assert.match(folders, /force: true/);
  const room = read("screens/RoomScreen.tsx");
  assert.match(room, /Work in folder/);
  assert.match(room, /g\.agentId === "\*" && g\.read && \(!g\.roomId \|\| g\.roomId === roomId\)/);
  assert.match(room, /hub\.post\(roomId, v, folder\?\.id\)/);
  const agents = read("screens/AgentsScreen.tsx");
  assert.match(agents, /Key hidden\./);
  assert.match(agents, /conn\.tokenHidden/);
  assert.match(read("components/Discovery.tsx"), /inv\.tokenHidden/);
  for (const f of ["screens/FoldersScreen.tsx", "screens/ApprovalsScreen.tsx", "components/DiffViewer.tsx"]) assert.doesNotMatch(read(f), /—|–/, `${f}: no em or en dashes`);
  assert.match(read("screens/FoldersScreen.tsx"), /Writes always come to you as changes to approve\./);
});

// ---------- 1.1 integration: several files in one approval, a change that can't be applied, the phone and Mac rules on the same inputs

test("a task's write-back: one approval, every file in order, each with its operation, and the skipped ones named", async (t) => {
  const { app, base, h, orch, store, room } = await boot(); t.after(() => app.close());
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grant-task-")));
  writeFileSync(join(root, "keep.txt"), "line 1\nline 2\nline 3\n");
  writeFileSync(join(root, "gone.txt"), "bye\nbye\n");
  const grant = (await (await fetch(`${base}/folder-grants`, { method: "POST", headers: h, body: JSON.stringify({ path: root, agentId: "*", read: true, write: true }) })).json()) as { id: string };
  const r = orch.files.proposeTask({
    grantId: grant.id, agentId: "claude", roomId: room.id, goalId: "goal_1", taskId: "task_1", title: "Tidy the notes",
    changes: [
      { relPath: "keep.txt", content: Buffer.from("line 1\nLINE 2\nline 3\nline 4\n") },
      { relPath: "docs/new.md", content: Buffer.from("# New\n\nhello\n") },
      { relPath: "gone.txt", content: null },
      { relPath: "logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]) },
    ],
  });
  assert.equal(r.ok, true);
  await until(() => store.listApprovals("pending").length === 1);
  const approval = store.listApprovals("pending")[0];
  assert.ok(isFileWriteApproval(approval), "a task approval opens the same full-diff view");
  assert.match(approval.action, /^write 3 files from "Tidy the notes"$/);
  const whole = (await (await fetch(`${base}/write-proposals/${approval.proposalId}`, { headers: h })).json()) as {
    kind: string; diff: string; files: { relPath: string; op: "create" | "edit" | "delete" }[]; skipped?: { relPath: string; reason: string }[];
  };
  assert.equal(whole.kind, "task");
  assert.deepEqual(whole.files.map((f) => `${f.op} ${f.relPath}`), ["create docs/new.md", "delete gone.txt", "edit keep.txt"]);
  assert.deepEqual(whole.skipped?.map((x) => x.relPath), ["logo.png"], "the file that will not be written is listed, with a reason");
  assert.ok(whole.skipped![0].reason.length > 5);

  // the plain parser can't read several files; the change reader can, and the phone copy answers the same
  assert.ok(parseUnifiedDiff(whole.diff).problem, "one-file reader refuses a many-file diff");
  const chg = parseChangeDiff(whole.diff, whole.files);
  assert.equal(chg.problem, undefined);
  assert.deepEqual(chg.sections.map((x) => `${x.op} ${x.path}`), ["create docs/new.md", "delete gone.txt", "edit keep.txt"]);
  assert.deepEqual([chg.added, chg.removed], [3 + 2, 2 + 1]);
  assert.deepEqual(plain(web.parseChangeDiff(whole.diff, whole.files)), plain(chg));
  assert.deepEqual(plain(web.flattenChange(chg)), plain(flattenChange(chg)));
  const rows = flattenChange(chg);
  assert.deepEqual(rows.filter((x) => x.type === "file").map((x) => (x as { path: string }).path), ["docs/new.md", "gone.txt", "keep.txt"]);
  assert.equal(rows.filter((x) => x.type === "line").length, chg.sections.reduce((n, x) => n + x.parsed.lineCount, 0), "every line is there");
  // a diff that doesn't match its file list is never approvable
  assert.ok(parseChangeDiff(whole.diff, whole.files.slice(1)).problem);
  assert.ok(parseChangeDiff(whole.diff.split("\n--- a/gone.txt")[0], whole.files).problem, "a diff cut short of a listed file");

  const ok = await fetch(`${base}/approvals/${approval.id}`, { method: "POST", headers: h, body: JSON.stringify({ decision: "approved" }) });
  assert.equal(ok.status, 200);
  await until(() => readFileSync(join(root, "docs/new.md"), "utf8") === "# New\n\nhello\n");
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "line 1\nLINE 2\nline 3\nline 4\n");
});

test("a change that can't be applied: the hub's reason comes with it, and the phone app and Mac app offer only Reject", async (t) => {
  const { app, base, h, orch, store, room } = await boot(); t.after(() => app.close());
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grant-bad-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "grant-out-")));
  mkdirSync(join(root, "d"));
  symlinkSync(outside, join(root, "d", "link"));
  const grant = (await (await fetch(`${base}/folder-grants`, { method: "POST", headers: h, body: JSON.stringify({ path: root, agentId: "claude", read: false, write: true }) })).json()) as { id: string };
  const res = orch.files.proposeWrite("claude", room.id, "d/link/x.txt", "x\n", grant.id);
  assert.equal(res.ok, true);
  await until(() => store.listApprovals("pending").length === 1);
  const approval = store.listApprovals("pending")[0];
  const whole = (await (await fetch(`${base}/write-proposals/${approval.proposalId}`, { headers: h })).json()) as { unappliable?: string; diff: string; files: { relPath: string; op: "create" | "edit" | "delete" }[] };
  assert.ok(whole.unappliable && whole.unappliable.length > 10, "the hub says why");
  assert.match(appJs, /p\.unappliable \? null : h\("button"/, "phone: no Approve button for it");
  assert.match(appJs, /p\.unappliable \? "" : `<button class="btn small" data-review/, "phone: no Review button on the card either");
  assert.equal(parseChangeDiff(whole.diff, whole.files).sections.length, 1);
  assert.equal(readFileSync(join(appSrc, "components/DiffViewer.tsx"), "utf8").includes("unappliable ? null : <Button"), true);
});

test("an approval whose proposalId is gone falls back to the guarded list, and says so when nothing matches", async () => {
  for (const fetchFor of [fetchProposalForApproval, web.fetchProposalForApproval]) {
    const P = (id: string, o: Record<string, unknown> = {}) => ({ id, agentId: "claude", status: "pending", ...o });
    const A = (o: Record<string, unknown> = {}) => ({ id: "ap_1", agentId: "claude", detail: "", ...o });
    const api = (list: ReturnType<typeof P>[], gone: string[] = []) => ({
      one: async (id: string) => { if (gone.includes(id)) throw new Error("Proposal not found."); return { ...P(id), diff: "x" }; },
      list: async () => list,
    });
    // linked by the proposal's own approvalId after the id the approval carries is gone
    assert.equal((await fetchFor(A({ proposalId: "wp_gone" }), api([P("wp_b", { approvalId: "ap_1" })], ["wp_gone"])))?.id, "wp_b");
    // nothing links and the id is unknown: the error is the one the hub gave, not a silent empty
    await assert.rejects(() => fetchFor(A({ proposalId: "wp_gone" }), api([P("wp_other")], ["wp_gone"])) as Promise<unknown>, /Proposal not found/);
    // no id at all and nothing in the list: no proposal, so no Approve
    assert.equal(await fetchFor(A(), api([P("wp_other")])), undefined);
    // the preview text link is still guarded against another agent's proposal
    assert.equal(await fetchFor(A({ detail: "Write proposal wp_a: x" }), api([P("wp_a", { agentId: "codex" })])), undefined);
  }
});

test("phone app: the folder picker, Grant anyway, PUT switches and the one-proposal fetch are really in app.js and the page", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  assert.match(html, /id="folderPick"/);
  assert.match(appJs, /folderGrantId: st\.folderId/, "the picked folder goes with the message");
  assert.match(appJs, /`\/folder-grants\?roomId=\$\{encodeURIComponent\(id\)\}`/);
  assert.match(appJs, /st\.roomGrants = gs\.filter\(\(g\) => g\.agentId === "\*" && g\.read\)/);
  assert.match(appJs, /method: "PUT", body: \{ \[key\]: value \}/);
  assert.doesNotMatch(appJs, /added\.id/, "no add-then-delete toggle");
  assert.match(appJs, /"\/folder-grants\/check"/);
  assert.match(appJs, /Grant anyway/);
  assert.match(appJs, /reason\.trim\(\)\.length < 8/);
  assert.match(appJs, /force: true, reason: f\.override\.reason\.trim\(\)/);
  assert.match(appJs, /fetchProposalForApproval\(a, \{ one: \(id\) => api\(`\/write-proposals\/\$\{id\}`\)/);
});
