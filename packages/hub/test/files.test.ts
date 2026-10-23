import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/api/server.js";
import { unifiedDiff } from "../src/files/diff.js";
import { FileBroker } from "../src/files/broker.js";
import { PathDenied, resolveInGrant } from "../src/files/paths.js";
import { setup } from "./helpers.js";

const dir = (p = "grant-") => realpathSync(mkdtempSync(join(tmpdir(), p)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) { for (let i = 0; i < ms / 10 && !fn(); i++) await sleep(10); assert.ok(fn(), "timed out waiting"); }
const actions = (store: { listAudit(n?: number): { action: string }[] }) => store.listAudit(1000).map((a) => a.action);

/** A hub context with one granted folder for agent "claude" (filesystem tool is on in the seed). */
function ctx(grant: { read?: boolean; write?: boolean; agentId?: string; roomId?: string } = {}) {
  const c = setup();
  const root = dir();
  const outside = dir("outside-");
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  const g = c.orch.files.addGrant({ path: root, agentId: grant.agentId ?? "claude", roomId: grant.roomId, read: grant.read ?? true, write: grant.write ?? true });
  return { ...c, root, outside, grant: g, files: c.orch.files };
}
const pendingApproval = (store: ReturnType<typeof setup>["store"]) => store.listApprovals("pending").at(-1)!;

// ---------- paths

test("resolveInGrant: traversal, absolute, NUL, empty, long and symlink escapes are refused", () => {
  const root = dir(), outside = dir("outside-");
  writeFileSync(join(outside, "secret.txt"), "x");
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "ok.txt"), "ok");
  symlinkSync(outside, join(root, "linkdir"));
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(join(root, "a", "ok.txt"), join(root, "inner-link.txt"));
  symlinkSync(join(root, "nowhere"), join(root, "dangling"));
  symlinkSync(join(outside, "new.txt"), join(root, "dangling-out"));

  for (const bad of ["../x", "a/../../x", "..", "/etc/passwd", join(root, "a/ok.txt"), "", "a\0b", "x".repeat(1025), "linkdir/secret.txt", "linkdir/new.txt", "linkdir", "link.txt", "dangling", "dangling-out", "link.txt/../../x"])
    assert.throws(() => resolveInGrant(root, bad), PathDenied, JSON.stringify(bad.slice(0, 30)));
  assert.equal(resolveInGrant(root, "a/ok.txt"), join(root, "a", "ok.txt"));
  assert.equal(resolveInGrant(root, "a/../a/./ok.txt"), join(root, "a", "ok.txt"), ".. that stays inside is fine");
  assert.equal(resolveInGrant(root, "new/deep/file.txt"), join(root, "new", "deep", "file.txt"), "not-yet-existing paths resolve against the real ancestor");
  assert.equal(resolveInGrant(root, "inner-link.txt"), join(root, "a", "ok.txt"), "a symlink that stays inside resolves to its real target");
  assert.equal(resolveInGrant(root, "."), root);
  // a sibling whose name merely starts with the root's name is not inside
  const sibling = root + "-evil"; mkdirSync(sibling);
  symlinkSync(sibling, join(root, "sib"));
  assert.throws(() => resolveInGrant(root, "sib/x"), PathDenied);
});

// ---------- diff

function applyDiff(oldText: string | null, diff: string): string {
  const old = oldText === null ? [] : oldText.split("\n").slice(0, -1);
  const out: string[] = []; let pos = 0;
  const lines = diff.split("\n"); lines.pop();
  let i = 2;
  while (i < lines.length) {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i++])!;
    assert.ok(m, `bad hunk header ${lines[i - 1]}`);
    const os = Number(m[1]), oc = Number(m[2]);
    const start = oc === 0 ? os : os - 1;
    while (pos < start) out.push(old[pos++]);
    let seenOld = 0, seenNew = 0;
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const l = lines[i++];
      if (l[0] === " ") { assert.equal(old[pos], l.slice(1)); out.push(old[pos++]); seenOld++; seenNew++; }
      else if (l[0] === "-") { assert.equal(old[pos], l.slice(1)); pos++; seenOld++; }
      else if (l[0] === "+") { out.push(l.slice(1)); seenNew++; }
    }
    assert.equal(seenOld, oc); assert.equal(seenNew, Number(m[4]));
  }
  while (pos < old.length) out.push(old[pos++]);
  return out.length ? out.join("\n") + "\n" : "";
}

test("unifiedDiff: headers, context, /dev/null for new files, and patches that reproduce the new text", () => {
  assert.equal(unifiedDiff("a.txt", "same\n", "same\n"), "");
  const d = unifiedDiff("dir/a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n3\nFOUR\n5\n6\n7\n8\n9\n10\n");
  assert.match(d, /^--- a\/dir\/a\.txt\n\+\+\+ b\/dir\/a\.txt\n@@ -1,7 \+1,7 @@\n/);
  assert.ok(d.includes("-4\n+FOUR\n"));
  assert.ok(!d.includes(" 8\n"), "only 3 lines of context");
  const created = unifiedDiff("n.txt", null, "hello\nworld\n");
  assert.match(created, /^--- \/dev\/null\n\+\+\+ b\/n\.txt\n@@ -0,0 \+1,2 @@\n\+hello\n\+world\n$/);
  assert.match(unifiedDiff("e.txt", "a\nb", "a\nb\n"), /\\ No newline at end of file/);

  // pseudo-random edits, checked by applying the patch
  let seed = 12345; const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let t = 0; t < 150; t++) {
    const a = Array.from({ length: rnd(60) }, () => `line${rnd(8)}`);
    const b = a.slice();
    for (let e = rnd(8); e > 0; e--) {
      const at = rnd(b.length + 1), op = rnd(3);
      if (op === 0) b.splice(at, 0, ...Array.from({ length: 1 + rnd(3) }, () => `new${rnd(5)}`));
      else if (op === 1) b.splice(at, 1 + rnd(3));
      else if (at < b.length) b[at] = `chg${rnd(5)}`;
    }
    const oldT = a.length ? a.join("\n") + "\n" : "", newT = b.length ? b.join("\n") + "\n" : "";
    if (oldT === newT) continue;
    assert.equal(applyDiff(oldT, unifiedDiff("f", oldT, newT)), newT, `case ${t}`);
    assert.equal(applyDiff(null, unifiedDiff("f", null, newT)), newT, `new file case ${t}`);
  }
  // completely different big files fall back to replace-all and still patch correctly
  const big1 = Array.from({ length: 1200 }, (_, i) => `a${i}`).join("\n") + "\n", big2 = Array.from({ length: 1200 }, (_, i) => `b${i}`).join("\n") + "\n";
  assert.equal(applyDiff(big1, unifiedDiff("f", big1, big2)), big2);
  // above 5,000 lines: a summary line instead of hunks
  const huge = "x\n".repeat(5001);
  const s = unifiedDiff("h.txt", huge, huge + "y\n");
  assert.match(s, /too large to diff/);
  assert.ok(!/^[-+]x/m.test(s));
});

// ---------- broker: denials

test("traversal, absolute paths and symlink escapes (file and directory component) are denied and audited", () => {
  const { files, root, outside, store } = ctx();
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "linkdir"));
  for (const p of ["../x", "a/../../x", join(outside, "secret.txt"), "link.txt", "linkdir/secret.txt"]) {
    const r = files.read("claude", undefined, p);
    assert.equal(r.ok, false, p);
    if (!r.ok) assert.ok(!r.reason.includes("TOP SECRET"));
  }
  assert.equal(files.list("claude", undefined, "linkdir").ok, false);
  assert.equal(files.list("claude", undefined, "..").ok, false);
  assert.equal(files.proposeWrite("claude", undefined, "linkdir/new.txt", "x").ok, false);
  assert.equal(files.proposeWrite("claude", undefined, "../x", "x").ok, false);
  assert.equal(existsSync(join(outside, "new.txt")), false);
  const denied = actions(store).filter((a) => a === "file.denied");
  assert.equal(denied.length, 9, "every refusal is audited");
});

test("read without a grant is denied; with a grant but the filesystem tool off is denied", () => {
  const c = setup();
  const root = dir(); writeFileSync(join(root, "a.txt"), "hi");
  const r1 = c.orch.files.read("claude", undefined, "a.txt");
  assert.equal(r1.ok, false);
  assert.match(!r1.ok ? r1.reason : "", /no folder/);
  c.orch.files.addGrant({ path: root, agentId: "claude", read: true, write: true });
  assert.equal(c.orch.files.read("claude", undefined, "a.txt").ok, true);
  const a = c.store.getAgent("claude")!; a.tools.filesystem = false; c.store.saveAgent(a);
  for (const r of [c.orch.files.read("claude", undefined, "a.txt"), c.orch.files.list("claude", undefined, "."), c.orch.files.proposeWrite("claude", undefined, "a.txt", "x")]) {
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /switched off/);
  }
  assert.equal(c.orch.files.read("ghost", undefined, "a.txt").ok, false, "unknown agents get nothing");
  assert.ok(actions(c.store).includes("file.denied"));
});

test("a read-only grant cannot be written to", () => {
  const { files, root, store } = ctx({ write: false });
  writeFileSync(join(root, "a.txt"), "hi");
  const r = files.proposeWrite("claude", undefined, "a.txt", "changed");
  assert.equal(r.ok, false);
  assert.equal(store.listApprovals("pending").length, 0, "the owner is not even asked");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "hi");
});

test("room-scoped grants are invisible from other rooms; agent-scoped grants from other agents", () => {
  const c = setup();
  const root = dir(); writeFileSync(join(root, "a.txt"), "hi");
  const room2 = c.store.createRoom("other");
  c.orch.files.addGrant({ path: root, agentId: "claude", roomId: c.room.id, read: true, write: false });
  assert.equal(c.orch.files.read("claude", c.room.id, "a.txt").ok, true);
  assert.equal(c.orch.files.read("claude", room2.id, "a.txt").ok, false, "other room");
  assert.equal(c.orch.files.read("claude", undefined, "a.txt").ok, false, "no room at all never widens a room grant");
  assert.equal(c.orch.files.read("codex", c.room.id, "a.txt").ok, false, "other agent");
  assert.equal(c.orch.files.grantsFor("codex", c.room.id).length, 0);
  // "*" grants reach every agent but still respect the room
  c.orch.files.addGrant({ path: root, agentId: "*", roomId: room2.id, read: true, write: false });
  assert.equal(c.orch.files.read("codex", room2.id, "a.txt").ok, true);
  assert.equal(c.orch.files.read("codex", c.room.id, "a.txt").ok, false);
});

test("with several usable grants the caller must name one; a grantId from another scope is refused", () => {
  const c = setup();
  const r1 = dir(), r2 = dir(); writeFileSync(join(r1, "a.txt"), "one"); writeFileSync(join(r2, "a.txt"), "two");
  const g1 = c.orch.files.addGrant({ path: r1, agentId: "claude", read: true, write: false });
  const g2 = c.orch.files.addGrant({ path: r2, agentId: "claude", read: true, write: false });
  const amb = c.orch.files.read("claude", undefined, "a.txt");
  assert.equal(amb.ok, false);
  assert.match(!amb.ok ? amb.reason : "", /pass grantId/);
  const two = c.orch.files.read("claude", undefined, "a.txt", g2.id);
  assert.equal(two.ok && !two.binary && two.content, "two");
  const other = c.orch.files.addGrant({ path: r1, agentId: "codex", read: true, write: false });
  assert.equal(c.orch.files.read("claude", undefined, "a.txt", other.id).ok, false, "can't borrow another agent's grant by id");
  assert.equal(c.orch.files.read("claude", undefined, "a.txt", g1.id).ok, true);
});

test("list and read: sizes, truncation, binary files and non-files", () => {
  const { files, root } = ctx();
  mkdirSync(join(root, "sub")); writeFileSync(join(root, "sub", "x.txt"), "x");
  writeFileSync(join(root, "big.txt"), "a".repeat(1000));
  writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  const l = files.list("claude", undefined, ".");
  assert.ok(l.ok && l.entries.some((e) => e.name === "sub" && e.type === "dir") && l.entries.some((e) => e.name === "big.txt" && e.size === 1000));
  const r = files.read("claude", undefined, "big.txt", undefined, 100);
  assert.ok(r.ok && !r.binary && r.content.length === 100 && r.truncated && r.bytes === 1000);
  const b = files.read("claude", undefined, "bin.dat");
  assert.ok(b.ok && b.binary && /Not a text file/.test(b.note)); // 1.1: the same wording for binary and invalid UTF-8, on read and on write
  assert.equal(files.read("claude", undefined, "sub").ok, false, "a folder is not a file");
  assert.equal(files.read("claude", undefined, "missing.txt").ok, false);
});

// ---------- broker: writes

test("propose, approve: the file changes only after approval, and the audit trail shows proposed + applied", async () => {
  const { files, root, store, approvals } = ctx();
  writeFileSync(join(root, "notes.txt"), "one\ntwo\nthree\n");
  const r = files.proposeWrite("claude", undefined, "notes.txt", "one\nTWO\nthree\n");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.proposal.status, "pending");
  assert.ok(r.proposal.diff.includes("-two\n+TWO\n"));
  assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "one\ntwo\nthree\n", "nothing written before approval");
  const apr = pendingApproval(store);
  assert.equal(apr.tool, "filesystem");
  assert.equal(apr.action, "write notes.txt");
  assert.ok(apr.detail.includes("-two\n+TWO") && apr.detail.length <= 8000);
  assert.equal(files.proposal(r.proposal.id)!.approvalId, apr.id);

  approvals.decide(apr.id, "approved");
  await until(() => files.proposal(r.proposal.id)!.status !== "pending");
  assert.equal(files.proposal(r.proposal.id)!.status, "applied");
  assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "one\nTWO\nthree\n");
  assert.deepEqual(readdirSync(root), ["notes.txt"], "no temp files left behind");
  const a = actions(store);
  assert.ok(a.includes("file.write.proposed") && a.includes("file.write.applied"));
  const applied = store.listAudit(1000).find((e) => e.action === "file.write.applied")!;
  assert.equal(applied.actor, "claude");
});

test("a long diff is truncated for the approval card with a loud warning; the full diff stays on the proposal", async () => {
  const { files, store, approvals } = ctx();
  const content = Array.from({ length: 600 }, (_, i) => `line number ${i}`).join("\n") + "\n";
  const r = files.proposeWrite("claude", undefined, "long.txt", content);
  assert.ok(r.ok); if (!r.ok) return;
  const apr = pendingApproval(store);
  assert.ok(apr.detail.length <= 8000);
  assert.match(apr.detail, /^!! DIFF TRUNCATED/);
  assert.ok(r.proposal.diff.includes("+line number 599"), "the stored diff is complete");
  assert.equal(files.proposal(r.proposal.id)!.approvalId, apr.id);
  approvals.decide(apr.id, "rejected");
});

test("applying keeps the file's permissions; an auto-approve setting does not skip the owner", async () => {
  const { files, root, store, approvals } = ctx();
  const a = store.getAgent("claude")!; a.autoApprove = { filesystem: true }; store.saveAgent(a);
  writeFileSync(join(root, "run.sh"), "echo 1\n", { mode: 0o755 });
  const r = files.proposeWrite("claude", undefined, "run.sh", "echo 2\n");
  assert.ok(r.ok);
  assert.equal(store.listApprovals("pending").length, 1, "still waits for the owner");
  approvals.decide(pendingApproval(store).id, "approved");
  await until(() => files.proposal(r.ok ? r.proposal.id : "")!.status === "applied");
  assert.equal(statSync(join(root, "run.sh")).mode & 0o777, 0o755);
});

test("propose, reject: the file is unchanged", async () => {
  const { files, root, store, approvals } = ctx();
  writeFileSync(join(root, "a.txt"), "keep\n");
  const r = files.proposeWrite("claude", undefined, "a.txt", "lose\n");
  assert.ok(r.ok); if (!r.ok) return;
  approvals.decide(pendingApproval(store).id, "rejected");
  await until(() => files.proposal(r.proposal.id)!.status !== "pending");
  assert.equal(files.proposal(r.proposal.id)!.status, "rejected");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "keep\n");
  assert.ok(actions(store).includes("file.write.rejected"));
  assert.ok(!actions(store).includes("file.write.applied"));
  assert.equal(store.listAudit(1000).find((e) => e.action === "file.write.rejected")!.actor, "owner");
});

test("an approval that expires leaves the file alone and marks the proposal expired", async () => {
  const { files, root, store, approvals } = ctx();
  writeFileSync(join(root, "a.txt"), "keep\n");
  const r = files.proposeWrite("claude", undefined, "a.txt", "lose\n");
  assert.ok(r.ok); if (!r.ok) return;
  approvals.decide(pendingApproval(store).id, "expired", "system");
  await until(() => files.proposal(r.proposal.id)!.status !== "pending");
  assert.equal(files.proposal(r.proposal.id)!.status, "expired");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "keep\n");
});

test("file edited by someone else before approval: conflict, the other edit survives", async () => {
  const { files, root, store, approvals } = ctx();
  writeFileSync(join(root, "a.txt"), "original\n");
  const r = files.proposeWrite("claude", undefined, "a.txt", "agent version\n");
  assert.ok(r.ok); if (!r.ok) return;
  writeFileSync(join(root, "a.txt"), "someone else edited this\n");
  approvals.decide(pendingApproval(store).id, "approved");
  await until(() => files.proposal(r.proposal.id)!.status !== "pending");
  assert.equal(files.proposal(r.proposal.id)!.status, "conflict");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "someone else edited this\n");
  assert.ok(actions(store).includes("file.write.conflict"));
  assert.ok(!actions(store).includes("file.write.applied"));
});

test("a new file that appeared (or a deleted one) after proposing is also a conflict", async () => {
  const { files, root, store, approvals } = ctx();
  const r = files.proposeWrite("claude", undefined, "fresh.txt", "mine\n");
  assert.ok(r.ok); if (!r.ok) return;
  assert.equal(r.proposal.baseSha256, null);
  writeFileSync(join(root, "fresh.txt"), "theirs\n");
  approvals.decide(pendingApproval(store).id, "approved");
  await until(() => files.proposal(r.proposal.id)!.status !== "pending");
  assert.equal(files.proposal(r.proposal.id)!.status, "conflict");
  assert.equal(readFileSync(join(root, "fresh.txt"), "utf8"), "theirs\n");
});

test("a new-file proposal creates its parent folders, inside the granted folder only", async () => {
  const { files, root, store, approvals, outside } = ctx();
  const r = files.proposeWrite("claude", undefined, "docs/2026/plan.md", "# Plan\n");
  assert.ok(r.ok); if (!r.ok) return;
  assert.match(r.proposal.diff, /^--- \/dev\/null\n\+\+\+ b\/docs\/2026\/plan\.md\n/);
  assert.equal(existsSync(join(root, "docs")), false, "no folders before approval");
  approvals.decide(pendingApproval(store).id, "approved");
  await until(() => files.proposal(r.proposal.id)!.status !== "pending");
  assert.equal(files.proposal(r.proposal.id)!.status, "applied");
  assert.equal(readFileSync(join(root, "docs", "2026", "plan.md"), "utf8"), "# Plan\n");
  assert.deepEqual(readdirSync(outside), ["secret.txt"]);
});

test("a symlink planted after proposing cannot redirect the approved write outside", async () => {
  const { files, root, store, approvals, outside } = ctx();
  const r = files.proposeWrite("claude", undefined, "sub/a.txt", "payload\n");
  assert.ok(r.ok); if (!r.ok) return;
  symlinkSync(outside, join(root, "sub"));            // the folder the write was going to create is now a link out
  approvals.decide(pendingApproval(store).id, "approved");
  await until(() => files.proposal(r.proposal.id)!.status !== "pending");
  assert.notEqual(files.proposal(r.proposal.id)!.status, "applied");
  assert.deepEqual(readdirSync(outside), ["secret.txt"]);
  assert.ok(actions(store).includes("file.denied"));
});

test("removing the grant, or switching the tool off, while a write waits stops it", async () => {
  for (const how of ["grant", "tool"] as const) {
    const { files, root, store, approvals, grant } = ctx();
    writeFileSync(join(root, "a.txt"), "keep\n");
    const r = files.proposeWrite("claude", undefined, "a.txt", "lose\n");
    assert.ok(r.ok); if (!r.ok) return;
    if (how === "grant") {
      files.removeGrant(grant.id);
      // 1.1: removing the grant settles the waiting write at once; the owner is not left an approval that can only fail.
      assert.equal(files.proposal(r.proposal.id)!.status, "rejected");
      assert.equal(store.listApprovals("pending").length, 0);
    } else {
      const a = store.getAgent("claude")!; a.tools.filesystem = false; store.saveAgent(a);
      approvals.decide(pendingApproval(store).id, "approved");
    }
    await until(() => files.proposal(r.proposal.id)!.status !== "pending");
    assert.notEqual(files.proposal(r.proposal.id)!.status, "applied", how);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "keep\n", how);
  }
});

test("writes to symlinks, into .git, of binary or oversized content, and no-op writes are refused", () => {
  const { files, root, outside } = ctx();
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  writeFileSync(join(root, "same.txt"), "same\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2]));
  mkdirSync(join(root, ".git")); mkdirSync(join(root, "d"));
  const cases: [string, string][] = [
    ["link.txt", "x"], [".git/hooks/pre-commit", "x"], ["sub/.GIT/config", "x"], ["same.txt", "same\n"], ["bin.dat", "text"],
    ["n.txt", "a\0b"], ["big.txt", "x".repeat(2 * 1024 * 1024 + 1)], ["d", "x"], [".", "x"],
    ["evil\n+++ forged header.txt", "x"],
    ["huge-diff.txt", Array.from({ length: 4000 }, (_, i) => `line number ${i} with some padding text`).join("\n")],
  ];
  for (const [p, c] of cases) assert.equal(files.proposeWrite("claude", undefined, p, c).ok, false, p);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP SECRET");
});

test("H1: a change too big to diff is DENIED, never approved on a one-line summary", () => {
  const { files, root, store } = ctx();
  const big = (tag: string) => Array.from({ length: 5001 }, (_, i) => `${tag}${i}`).join("\n") + "\n";
  // new side over the limit
  const r1 = files.proposeWrite("claude", undefined, "new-big.txt", big("a"));
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.reason, /smaller|split/i);
  // old side over the limit
  writeFileSync(join(root, "old-big.txt"), big("a"));
  const r2 = files.proposeWrite("claude", undefined, "old-big.txt", "tiny\n");
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.reason, /smaller|split/i);
  assert.equal(store.listApprovals("pending").length, 0, "the owner is never asked to approve a summary");
  assert.equal(files.proposals().length, 0);
  assert.equal(readFileSync(join(root, "old-big.txt"), "utf8"), big("a"));
  // just under the limit is still reviewable
  const ok = files.proposeWrite("claude", undefined, "edge.txt", Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n") + "\n");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.ok(!ok.proposal.diff.includes("too large to diff"));
});

test("M1: a symlinked folder that points at .git cannot be used to write into .git", () => {
  const { files, root, store } = ctx();
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  symlinkSync(join(root, ".git"), join(root, "gitdir"));
  for (const p of ["gitdir/hooks/pre-commit", "gitdir/config", "gitdir"]) assert.equal(files.proposeWrite("claude", undefined, p, "#!/bin/sh\nevil\n").ok, false, p);
  assert.equal(store.listApprovals("pending").length, 0);
  assert.equal(existsSync(join(root, ".git", "hooks", "pre-commit")), false);
});

test("M1: the owner sees the resolved path, not the symlinked spelling the agent used", () => {
  const { files, root, store } = ctx();
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "docs"));
  const r = files.proposeWrite("claude", undefined, "docs/a.txt", "hello\n");
  assert.ok(r.ok); if (!r.ok) return;
  assert.equal(r.proposal.relPath, "real/a.txt");
  assert.ok(r.proposal.diff.includes("+++ b/real/a.txt"));
  const apr = pendingApproval(store);
  assert.equal(apr.action, "write real/a.txt");
  assert.ok(apr.detail.includes("real/a.txt"));
});

test("L1: names with invisible or direction-changing characters, or a trailing slash, are refused", () => {
  const { files, root } = ctx();
  const bad = ["report\u202Etxt.exe", "zero\u200Bwidth.txt", "line\u2028sep.txt", "para\u2029sep.txt", "bom\uFEFF.txt", "dir/sub/", "newdir/"];
  for (const p of bad) assert.equal(files.proposeWrite("claude", undefined, p, "x\n").ok, false, JSON.stringify(p));
  assert.equal(files.proposeWrite("claude", undefined, "caf\u00e9.txt", "x\n").ok, true, "ordinary non-ASCII letters are fine");
  assert.deepEqual(readdirSync(root), []);
});

test("I3: audited paths are not cut short below the 1,024 character path limit", () => {
  const { files, store } = ctx();
  const long = Array.from({ length: 10 }, (_, i) => String(i).repeat(99)).join("/"); // 999 chars
  assert.equal(files.read("claude", undefined, long).ok, false);
  const e = store.listAudit(50).find((a) => a.action === "file.denied")!;
  assert.ok(e.detail.includes(JSON.stringify(long)), "the whole path is in the audit entry");
});

test("a write-only grant never shows the agent the existing file through the diff", async () => {
  const { files, root, store, approvals } = ctx({ read: false, write: true });
  writeFileSync(join(root, "a.txt"), "private old content\n");
  assert.equal(files.read("claude", undefined, "a.txt").ok, false);
  const r = files.proposeWrite("claude", undefined, "a.txt", "new\n");
  assert.ok(r.ok); if (!r.ok) return;
  assert.ok(r.proposal.diff.includes("private old content"), "the owner sees the full diff");
  const view = files.proposalFor("claude", r.proposal.id)!;
  assert.ok(!view.diff.includes("private old content"));
  assert.equal(files.proposalFor("codex", r.proposal.id), undefined, "only the proposing agent can look");
  approvals.decide(pendingApproval(store).id, "rejected");
});

test("proposals are capped and a restart expires the ones still waiting", async () => {
  const { files, store, approvals, root } = ctx({ agentId: "*" });
  const r = files.proposeWrite("claude", undefined, "a.txt", "x\n");
  assert.ok(r.ok); if (!r.ok) return;
  const restarted = new FileBroker(store, approvals); // what the hub does on boot
  assert.equal(restarted.proposal(r.proposal.id)!.status, "expired");
  assert.equal(store.listApprovals("pending").length, 0);
  await sleep(20);
  assert.equal(existsSync(join(root, "a.txt")), false);
  // 50 waiting writes in all (spread over three agents: one agent alone is capped lower, see the per-agent test in fileaccess)
  for (let i = 0; i < 50; i++) assert.ok(files.proposeWrite(["claude", "codex", "hermes"][i % 3], undefined, `f${i}.txt`, "x\n").ok);
  assert.equal(files.proposeWrite("claude", undefined, "one-too-many.txt", "x\n").ok, false);
  for (const a of store.listApprovals("pending")) approvals.decide(a.id, "rejected");
});

// ---------- REST + MCP end to end

async function boot() {
  const c = setup();
  const app = await buildServer({ ...c, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  return { ...c, app, base, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

test("REST folder grants: validation, realpath, audit, and device auth", async () => {
  const { app, base, auth, store, dir: dataDir, orch } = await boot();
  const root = dir(), real = dir("real-");
  const post = (body: unknown) => fetch(`${base}/folder-grants`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/folder-grants`)).status, 401);
  assert.equal((await fetch(`${base}/write-proposals`)).status, 401);

  for (const path of ["/", homedir(), dataDir, join(dataDir, "workspaces"), join(root, "missing"), "relative/path", "", "/etc/hosts", join(homedir(), ".ssh")]) {
    const r = await post({ path, agentId: "claude" });
    assert.equal(r.status, 400, `refuse ${path}`);
  }
  writeFileSync(join(root, "file.txt"), "x");
  assert.equal((await post({ path: join(root, "file.txt"), agentId: "claude" })).status, 400, "a file is not a folder");
  assert.equal((await post({ path: root, agentId: "nobody" })).status, 400);
  assert.equal((await post({ path: root, agentId: "claude", read: false, write: false })).status, 400);
  assert.equal((await post({ path: root, agentId: "claude", roomId: "room_nope" })).status, 400);
  assert.equal(orch.files.listGrants().length, 0);

  const link = join(dir("links-"), "viaLink"); symlinkSync(real, link);
  const ok = await post({ path: link, agentId: "claude", label: "Docs", write: true });
  assert.equal(ok.status, 200);
  const g = (await ok.json()) as { id: string; path: string; read: boolean; write: boolean };
  assert.equal(g.path, real, "the realpath is stored, not the symlink");
  assert.equal(g.read, true); assert.equal(g.write, true);
  assert.equal(((await (await fetch(`${base}/folder-grants`, { headers: auth })).json()) as unknown[]).length, 1);
  assert.equal((await fetch(`${base}/folder-grants/${g.id}`, { method: "DELETE", headers: auth })).status, 200);
  assert.equal((await fetch(`${base}/folder-grants/${g.id}`, { method: "DELETE", headers: auth })).status, 404);
  assert.deepEqual(((await (await fetch(`${base}/write-proposals`, { headers: auth })).json()) as unknown[]), []);
  const log = store.listAudit(100);
  assert.equal(log.find((e) => e.action === "grant.added")!.actor, "owner");
  assert.ok(log.some((e) => e.action === "grant.removed" && e.actor === "owner"));
  await app.close();
});

test("MCP end to end: an agent lists, reads, proposes a write, the owner approves, status reports applied", async () => {
  const { app, base, auth, store, approvals, orch } = await boot();
  const root = dir(); writeFileSync(join(root, "plan.md"), "# Plan\n- one\n");
  const outsideFile = join(dir("outside-"), "secret.txt"); writeFileSync(outsideFile, "TOP SECRET");

  const mk = async (agentId: string) => {
    const tk = await fetch(`${base}/mcp-tokens`, { method: "POST", headers: auth, body: JSON.stringify({ agentId, name: agentId }) });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${((await tk.json()) as { token: string }).token}` } } }));
    return client;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => ((await c.callTool({ name, arguments: args })).content as { text: string }[])[0].text;

  const cloud = await mk("cloud-agent");
  const names = (await cloud.listTools()).tools.map((t) => t.name);
  for (const n of ["list_granted_folders", "list_files", "read_file", "propose_file_write", "file_write_status"]) assert.ok(names.includes(n), n);

  // External agents start with the filesystem tool off: everything is denied until the owner switches it on.
  assert.match(await call(cloud, "list_granted_folders"), /^DENIED:/);
  assert.match(await call(cloud, "read_file", { path: "plan.md" }), /^DENIED:/);
  assert.equal(store.getAgent("cloud-agent")!.tools.filesystem, false);
  const a = store.getAgent("cloud-agent")!; a.tools.filesystem = true; store.saveAgent(a);

  assert.match(await call(cloud, "read_file", { path: "plan.md" }), /^DENIED:.*no folder/, "no grant yet");
  const gr = await fetch(`${base}/folder-grants`, { method: "POST", headers: auth, body: JSON.stringify({ path: root, agentId: "cloud-agent", label: "Work", write: true }) });
  const grant = (await gr.json()) as { id: string };

  assert.match(await call(cloud, "list_granted_folders"), new RegExp(`${grant.id} \\| Work \\| read write`));
  assert.match(await call(cloud, "list_files"), /file plan\.md \(\d+ bytes\)/);
  assert.equal(await call(cloud, "read_file", { path: "plan.md" }), "# Plan\n- one\n");
  for (const p of ["../x", outsideFile, "a/../../x"]) assert.match(await call(cloud, "read_file", { path: p }), /^DENIED:/, p);

  const proposed = await call(cloud, "propose_file_write", { path: "plan.md", content: "# Plan\n- one\n- two\n" });
  const pid = /proposalId: (\S+)/.exec(proposed)![1];
  assert.match(proposed, /status: pending/);
  assert.match(proposed, /NOT been changed/);
  assert.ok(proposed.includes("+- two"));
  assert.equal(readFileSync(join(root, "plan.md"), "utf8"), "# Plan\n- one\n");
  assert.match(await call(cloud, "file_write_status", { proposalId: pid }), /status: pending/);

  // another agent cannot look at it
  const other = await mk("other-agent");
  const b = store.getAgent("other-agent")!; b.tools.filesystem = true; store.saveAgent(b);
  assert.match(await call(other, "file_write_status", { proposalId: pid }), /^DENIED:/);
  assert.match(await call(other, "read_file", { path: "plan.md" }), /^DENIED:/, "grants are per agent");

  // the owner decides, through the usual approvals
  const pending = store.listApprovals("pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].agentId, "cloud-agent");
  approvals.decide(pending[0].id, "approved");
  await until(() => orch.files.proposal(pid)!.status !== "pending");
  assert.match(await call(cloud, "file_write_status", { proposalId: pid }), /status: applied/);
  assert.equal(readFileSync(join(root, "plan.md"), "utf8"), "# Plan\n- one\n- two\n");
  assert.equal(readFileSync(outsideFile, "utf8"), "TOP SECRET");

  const log = actions(store);
  for (const want of ["file.list", "file.read", "file.denied", "file.write.proposed", "file.write.applied", "grant.added", "file.grants.listed", "file.write.status"]) assert.ok(log.includes(want), want);
  assert.equal(((await (await fetch(`${base}/write-proposals`, { headers: auth })).json()) as { status: string }[])[0].status, "applied");
  await cloud.close(); await other.close();
  await app.close();
});
