import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/api/server.js";
import { ClaudeCodeAdapter } from "../src/adapters/claudeCode.js";
import { claudeConfinementSettings } from "../src/files/confine.js";
import { GrantRefused, PathDenied, assertPlainPath, inspectGrantRoot } from "../src/files/paths.js";
import { setup } from "./helpers.js";
import { GitConfigGuard } from "../src/files/gitSafe.js";
import { TaskWorkspaces, hardLinkedFiles } from "../src/orchestrator/worktree.js";

/**
 * 1.1 security review, round 2. Each test here fails on the code as it was before the round 2 fixes.
 * Run: cd packages/hub && npx tsx --test test/fileaccess-round2.test.ts
 */
const dir = (p = "r2-") => realpathSync(mkdtempSync(join(tmpdir(), p)));
const IDENT = ["-c", "user.name=Owner", "-c", "user.email=o@example.com"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
function ownerRepo() {
  const d = dir("repo-");
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "README.md"), "# mine\n");
  git(d, ...IDENT, "add", "-A");
  git(d, ...IDENT, "commit", "-q", "-m", "init");
  return d;
}
const exists = (p: string) => existsSync(p);
type Sec = { a: string; d: string };
const security = () => { const seen: Sec[] = []; return { seen, fn: (a: string, d: string) => { seen.push({ a, d }); } }; };
const adminOf = (folder: string) => /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(folder, ".git"), "utf8"))![1];
/** A stand-in `git` that runs the real one, with a hook to do something an agent could do at that moment. */
function gitWrapper(dirPath: string, name: string, body: string) {
  const f = join(dirPath, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755);
  return f;
}

// ============================================================ H1. the integration worktree is bound like a task worktree

test("H1: rewriting the integration worktree's commondir to a repo with a smudge filter does not make the hub run it; the tamper is put back and audited", async () => {
  const data = dir("data-"), owner = ownerRepo(), markers = dir("markers-"), evil = dir("evil-");
  const { seen, fn } = security();
  const ws = new TaskWorkspaces({ dataDir: data, onSecurity: fn });
  const goal = { id: "goal_h1", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_h1" } };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  const integration = ws.stateFolder(goal.id)!;
  assert.ok(integration && integration.endsWith("_integration"));
  writeFileSync(join(w.path, "new.txt"), "hi\n");
  git(w.path, "add", "-A"); git(w.path, ...IDENT, "commit", "-q", "-m", "work");
  // The agent's repository: a copy of the clone's whole .git (so it has the branch and the commit), with a smudge filter chosen by its own info/attributes.
  cpSync(join(w.base, ".git"), join(evil, ".git"), { recursive: true });
  git(evil, "config", "filter.evil.smudge", `touch ${join(markers, "RAN-smudge")}; cat`);
  mkdirSync(join(evil, ".git", "info"), { recursive: true }); writeFileSync(join(evil, ".git", "info", "attributes"), "*.txt filter=evil\n");
  writeFileSync(join(adminOf(integration), "commondir"), join(evil, ".git"));

  const r = await ws.accept(goal, { id: "t1", title: "T" });
  assert.deepEqual(readdirSync(markers), [], "the smudge filter of the agent's repository did not run");
  assert.ok(r.ok && r.merged.includes("new.txt"), JSON.stringify(r));
  assert.equal(readFileSync(join(adminOf(integration), "commondir"), "utf8"), "../..\n", "commondir is back as git wrote it");
  assert.ok(seen.some((x) => x.a === "worktree.tampered" && /commondir/.test(x.d)), `audited: ${JSON.stringify(seen)}`);
  assert.equal(git(owner, "-c", "core.fsmonitor=false", "show", "agent-room/goal_h1:new.txt"), "hi", "the accepted work still reached the owner's repo");
  await ws.cleanup(goal, ["t1"]);
});

test("H1: the integration worktree's HEAD, gitdir file and .git file are verified before every hub git call, and a replaced admin folder is refused", async () => {
  const data = dir("data-"), owner = ownerRepo();
  const { seen, fn } = security();
  const ws = new TaskWorkspaces({ dataDir: data, onSecurity: fn });
  const goal = { id: "goal_h1b", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_h1b" } };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  const integration = ws.stateFolder(goal.id)!, admin = adminOf(integration);
  const headBefore = readFileSync(join(admin, "HEAD"), "utf8"), gitdirBefore = readFileSync(join(admin, "gitdir"), "utf8"), pointerBefore = readFileSync(join(integration, ".git"), "utf8");
  assert.equal(headBefore, "ref: refs/heads/agent-room/goal_h1b\n");
  // HEAD points at another branch, the gitdir file at a folder of the agent's, and the .git file at another repository
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/ar/t1\n");
  writeFileSync(join(admin, "gitdir"), "/tmp/elsewhere/.git\n");
  writeFileSync(join(integration, ".git"), "gitdir: /tmp/elsewhere/.git\n");
  writeFileSync(join(w.path, "a.txt"), "a\n");
  const r1 = await ws.accept(goal, { id: "t1", title: "One" });
  assert.ok(r1.ok && r1.merged.includes("a.txt"), JSON.stringify(r1));
  assert.equal(readFileSync(join(admin, "HEAD"), "utf8"), headBefore);
  assert.equal(readFileSync(join(admin, "gitdir"), "utf8"), gitdirBefore);
  assert.equal(readFileSync(join(integration, ".git"), "utf8"), pointerBefore);
  for (const what of ["HEAD", "gitdir file", ".git file"]) assert.ok(seen.some((x) => x.a === "worktree.tampered" && x.d.includes(what)), `${what} audited: ${JSON.stringify(seen.map((x) => x.d))}`);
  assert.equal(git(owner, "-c", "core.fsmonitor=false", "branch", "--list", "ar/*"), "", "nothing was merged into the wrong branch");

  // the whole admin folder swapped for a link to a copy the agent controls cannot be put back: the hub refuses to run git there
  const w2 = await ws.open(goal, { id: "t2" }, "claude");
  writeFileSync(join(w2.path, "b.txt"), "b\n");
  renameSync(admin, `${admin}.mine`); symlinkSync(`${admin}.mine`, admin);
  const r2 = await ws.accept(goal, { id: "t2", title: "Two" });
  assert.equal(r2.ok, false, "the accept did not go through");
  assert.ok(seen.some((x) => x.a === "worktree.tampered" && /replaced/.test(x.d)));
  rmSync(admin, { force: true }); renameSync(`${admin}.mine`, admin);
  await ws.cleanup(goal, ["t1", "t2"]);
});

// ============================================================ M2. the config is never re-snapshotted

test("M2: a config line written while git adds a worktree does not become trusted; keys git itself sets are accepted", async () => {
  const markers = dir("markers-");
  // the "agent" appends to the shared config right after `git worktree add`, the window in which the old code re-snapshotted
  const bin = gitWrapper(dir("bin-"), "git-slow", `${realGit} "$@"; rc=$?\ncase " $* " in *" worktree add "*) printf '[filter "evil"]\\n\\tsmudge = touch ${join(markers, "RAN-smudge")}\\n[core]\\n\\tfsmonitor = touch ${join(markers, "RAN-fsmonitor")}\\n' >> .git/config;; esac\nexit $rc`);
  const data = dir("data-"), folder = dir("goal-"); writeFileSync(join(folder, "seed.txt"), "seed\n");
  const { seen, fn } = security();
  const ws = new TaskWorkspaces({ dataDir: data, git: bin, onSecurity: fn });
  const goal = { id: "goal_m2", folder };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  const config = readFileSync(join(folder, ".git", "config"), "utf8");
  assert.ok(!/smudge|fsmonitor|evil/.test(config), `the config written in the window was put back:\n${config}`);
  assert.ok(seen.some((x) => x.a === "git.config.restored"), "and reported");
  writeFileSync(join(w.path, "a.txt"), "a\n");
  writeFileSync(join(folder, ".git", "info", "attributes"), "*.txt filter=evil\n");
  const r = await ws.accept(goal, { id: "t1", title: "T" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(readdirSync(markers), [], "nothing ran");
  await ws.cleanup(goal, ["t1"]);

  // the same for the hub's clone of a granted repo (open and the integration worktree)
  const owner = ownerRepo(), seen2 = security();
  const ws2 = new TaskWorkspaces({ dataDir: dir("data-"), git: bin, onSecurity: seen2.fn });
  const g2 = { id: "goal_m2b", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_m2b" } };
  const w2 = await ws2.open(g2, { id: "t1" }, "claude");
  assert.ok(!/smudge|fsmonitor|evil/.test(readFileSync(join(w2.base, ".git", "config"), "utf8")), "the clone's config is clean after open");
  assert.ok(seen2.seen.some((x) => x.a === "git.config.restored"));
  await ws2.cleanup(g2, ["t1"]);
});

test("M2: GitConfigGuard.reconcile accepts only the allowlisted keys and puts everything else back", () => {
  const repo = dir("rc-"), snaps = dir("snaps-"); git(repo, "init", "-q");
  const restored: string[] = [];
  const guard = new GitConfigGuard(snaps, (r, why) => restored.push(why));
  guard.snapshot(repo);
  const config = () => readFileSync(join(repo, ".git", "config"), "utf8");
  assert.equal(guard.reconcile(repo), "same");
  const original = config();
  writeFileSync(join(repo, ".git", "config"), `${original}[extensions]\n\tworktreeConfig = true\n`);
  assert.equal(guard.reconcile(repo), "accepted", "git's own worktree key");
  assert.ok(/worktreeConfig/.test(config()) && restored.length === 0);
  writeFileSync(join(repo, ".git", "config"), `${config()}[core]\n\tfsmonitor = touch /tmp/x\n`);
  assert.equal(guard.reconcile(repo), "restored", "anything else is put back");
  assert.ok(!/fsmonitor/.test(config()) && /worktreeConfig/.test(config()), "back to the last trusted state, not further");
  assert.equal(restored.length, 1);
  // a new key that happens together with an allowed one is not accepted
  writeFileSync(join(repo, ".git", "config"), `${config()}[filter "x"]\n\tsmudge = touch /tmp/y\n[extensions]\n\tworktreeConfig = false\n`);
  assert.equal(guard.reconcile(repo), "restored");
  assert.ok(!/smudge/.test(config()));
});

// ============================================================ M5. refs are agent-writable: the hub pushes and merges commit ids it recorded

/** An unreferenced commit with `evil.txt` on top of the task's current head, built with plumbing in the task's folder. */
function evilCommit(cwd: string) {
  writeFileSync(join(cwd, "evil.txt"), "evil\n");
  git(cwd, "add", "evil.txt");
  const tree = git(cwd, "write-tree");
  const sha = git(cwd, ...IDENT, "commit-tree", tree, "-p", "HEAD", "-m", "evil");
  git(cwd, "rm", "--cached", "-q", "evil.txt"); rmSync(join(cwd, "evil.txt"));
  return sha;
}

test("M5: pushToOwner pushes the commit the hub recorded, and refuses and audits when the goal branch was moved", async () => {
  const data = dir("data-"), owner = ownerRepo();
  const { seen, fn } = security();
  const ws = new TaskWorkspaces({ dataDir: data, onSecurity: fn });
  const goal = { id: "goal_m5a", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_m5a" } };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  writeFileSync(join(w.path, "good.txt"), "good\n");
  const r1 = await ws.accept(goal, { id: "t1", title: "One" });
  assert.ok(r1.ok && r1.source?.mode === "granted-git" && r1.source.pushed === true, JSON.stringify(r1));
  const og = (...a: string[]) => git(owner, "-c", "core.fsmonitor=false", ...a);
  const good = og("rev-parse", "agent-room/goal_m5a");
  // an agent with write access to the shared .git moves the goal branch to a commit of its own
  const evil = evilCommit(w.path);
  git(w.base, "update-ref", "refs/heads/agent-room/goal_m5a", evil);
  const push = await (ws as unknown as { pushToOwner(id: string): Promise<{ pushed: boolean; error?: string }> }).pushToOwner(goal.id);
  assert.equal(push.pushed, false);
  assert.ok(seen.some((x) => x.a === "goal.source.push_refused"), JSON.stringify(seen));
  assert.equal(og("rev-parse", "agent-room/goal_m5a"), good, "the owner's branch did not move");
  assert.throws(() => og("cat-file", "-e", `${evil}^{commit}`), "and the owner never received the commit");
  await ws.cleanup(goal, ["t1"]);
});

test("M5: the next accept puts a moved goal branch back to the recorded commit before merging, so the agent's commit is never pushed", async () => {
  const data = dir("data-"), owner = ownerRepo();
  const { seen, fn } = security();
  const ws = new TaskWorkspaces({ dataDir: data, onSecurity: fn });
  const goal = { id: "goal_m5b", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_m5b" } };
  const w1 = await ws.open(goal, { id: "t1" }, "claude");
  writeFileSync(join(w1.path, "one.txt"), "1\n");
  assert.ok((await ws.accept(goal, { id: "t1", title: "One" })).ok);
  const w2 = await ws.open(goal, { id: "t2" }, "codex");
  const evil = evilCommit(w2.path);
  git(w2.base, "update-ref", "refs/heads/agent-room/goal_m5b", evil);
  writeFileSync(join(w2.path, "two.txt"), "2\n");
  const r2 = await ws.accept(goal, { id: "t2", title: "Two" });
  assert.ok(r2.ok && r2.source?.mode === "granted-git" && r2.source.pushed === true, JSON.stringify(r2));
  assert.ok(seen.some((x) => x.a === "goal.source.ref_repaired"), JSON.stringify(seen));
  const og = (...a: string[]) => git(owner, "-c", "core.fsmonitor=false", ...a);
  assert.equal(og("show", "agent-room/goal_m5b:two.txt"), "2");
  assert.throws(() => og("show", "agent-room/goal_m5b:evil.txt"), "evil.txt is not on the owner's branch");
  await ws.cleanup(goal, ["t1", "t2"]);
});

test("M5: a task's branch moved after the hub recorded its commit is not what gets merged (the recorded id is)", async () => {
  const data = dir("data-"), owner = ownerRepo(), ctl = join(dir("ctl-"), "move");
  // the "agent" moves ar/t1 to its own commit in the instant between the hub reading it and the merge
  const bin = gitWrapper(dir("bin-"), "git-race", `case " $* " in *" merge "*) if [ -f "${ctl}" ]; then read CL SHA < "${ctl}"; rm -f "${ctl}"; ${realGit} -C "$CL" update-ref refs/heads/ar/t1 "$SHA"; fi;; esac\nexec ${realGit} "$@"`);
  const ws = new TaskWorkspaces({ dataDir: data, git: bin });
  const goal = { id: "goal_m5c", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_m5c" } };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  writeFileSync(join(w.path, "good.txt"), "good\n");
  const evil = evilCommit(w.path);
  writeFileSync(ctl, `${w.base} ${evil}\n`);
  const r = await ws.accept(goal, { id: "t1", title: "T" });
  assert.ok(r.ok && r.merged.includes("good.txt"), JSON.stringify(r));
  const og = (...a: string[]) => git(owner, "-c", "core.fsmonitor=false", ...a);
  assert.equal(og("show", "agent-room/goal_m5c:good.txt"), "good");
  assert.throws(() => og("show", "agent-room/goal_m5c:evil.txt"), "the moved ref's commit was not merged");
  assert.equal(git(w.base, "rev-parse", "ar/t1"), evil, "(the ref really was moved)");
  await ws.cleanup(goal, ["t1"]);
});

// ============================================================ L6. the receiving side of the push refuses the checked-out branch whatever the owner's config says

test("L6: a push never updates a branch the owner has checked out, even with receive.denyCurrentBranch=updateInstead in their repo", async () => {
  const data = dir("data-"), owner = ownerRepo();
  git(owner, "branch", "agent-room/goal_l6"); git(owner, "checkout", "-q", "agent-room/goal_l6");
  git(owner, "config", "receive.denyCurrentBranch", "updateInstead");
  const before = git(owner, "rev-parse", "HEAD");
  const ws = new TaskWorkspaces({ dataDir: data });
  const goal = { id: "goal_l6", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_l6" } };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  writeFileSync(join(w.path, "new.txt"), "n\n");
  const r = await ws.accept(goal, { id: "t1", title: "T" });
  assert.ok(r.ok && r.source?.mode === "granted-git" && r.source.pushed === false, JSON.stringify(r));
  assert.equal(git(owner, "rev-parse", "HEAD"), before, "their branch did not move");
  assert.ok(!exists(join(owner, "new.txt")), "and their working tree was not rewritten");
  await ws.discard(goal, "t1");
  await ws.cleanup(goal, ["t1"]);
});

// ============================================================ L7. plain goals do not rely on .git/info/exclude

test("L7: with .git/info/exclude emptied by the agent, node_modules, the ledger and the hub's own files still never reach the base; node_modules is in the hard link scan", async () => {
  const data = dir("data-"), folder = dir("goal-"), outside = dir("outside-");
  writeFileSync(join(folder, "seed.txt"), "seed\n"); writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  const { seen, fn } = security();
  const ws = new TaskWorkspaces({ dataDir: data, onSecurity: fn });
  const goal = { id: "goal_l7", folder };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  writeFileSync(join(folder, ".git", "info", "exclude"), ""); // the agent's doing: it is shared by every worktree of the repository
  for (const f of ["node_modules/pkg/index.js", "packages/a/node_modules/x.js", "LEDGER.md", "docs/LEDGER.md", ".DS_Store", "sub/.DS_Store", ".agent-room-ctx.md", "keep.txt"]) {
    mkdirSync(join(w.path, f, ".."), { recursive: true }); writeFileSync(join(w.path, f), `${f}\n`);
  }
  linkSync(join(outside, "secret.txt"), join(w.path, "node_modules", "pkg", "stolen.js"));
  assert.ok(hardLinkedFiles(w.path).includes(join("node_modules", "pkg", "stolen.js")), "the scan looks into node_modules");
  const r = await ws.accept(goal, { id: "t1", title: "T" });
  assert.ok(r.ok && r.merged.includes("keep.txt"), JSON.stringify(r));
  const tree = git(folder, "ls-tree", "-r", "--name-only", "HEAD").split("\n").sort();
  assert.deepEqual(tree, ["keep.txt", "seed.txt"], `only the real work was committed: ${tree.join(", ")}`);
  assert.ok(seen.some((x) => x.a === "worktree.hardlink" && /node_modules/.test(x.d)));
  assert.ok(r.ok && !(r.hardLinks ?? []).some((p) => p.startsWith("node_modules")), "node_modules entries are not reported to the room as skipped work");
  await ws.cleanup(goal, ["t1"]);
});

// ============================================================ shared helpers for the rest

type Env = ReturnType<typeof setup>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) { for (let i = 0; i < ms / 10 && !fn(); i++) await sleep(10); assert.ok(fn(), "timed out waiting"); }
const audit = (store: Env["store"]) => store.listAudit(5000);

// ============================================================ M1. jsonOnly runs: no settings sources, a fresh empty folder

function fakeCli(binDir: string, name: string, outDir: string, extra = "") {
  const f = join(binDir, name);
  writeFileSync(f, `#!/bin/sh\npwd -P > "${outDir}/cwd"\nls -A > "${outDir}/ls"\nprintf '%s\\n' "$@" > "${outDir}/argv"\n${extra}\n`); chmodSync(f, 0o755);
  return f;
}

test("M1: a planner, judge or draft call by Claude Code reads no settings files and runs in a fresh empty folder that is deleted afterwards (not the folder a room run writes)", async () => {
  const e = setup(), out = dir("out-");
  const fake = fakeCli(dir("bin-"), "claude", out, `echo '{"type":"result","result":"{}","is_error":false}'`);
  const a = e.store.getAgent("claude")!; a.adapter = "claude-code"; a.settings = { ...a.settings, binary: fake }; e.store.saveAgent(a);
  // what a room run of this agent could have planted in the folder jsonOnly calls used to run in
  const room = join(e.dir, "workspaces", "claude", e.room.id);
  mkdirSync(join(room, ".claude"), { recursive: true });
  writeFileSync(join(room, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "touch /tmp/PLANTED" }] }] } }));
  const r = await e.orch.call(e.store.getAgent("claude")!, "[[PLAN]] x", { jsonOnly: true, roomId: e.room.id });
  assert.ok(r.ok, r.error);
  const cwd = readFileSync(join(out, "cwd"), "utf8").trim();
  assert.notEqual(cwd, realpathSync(room), "not the folder confined runs of the same agent write");
  assert.ok(cwd.startsWith(join(realpathSync(e.dir), "scratch")), `a scratch folder under the data folder: ${cwd}`);
  assert.equal(readFileSync(join(out, "ls"), "utf8"), "", "empty: no .claude/settings.json, no CLAUDE.md");
  const argv = readFileSync(join(out, "argv"), "utf8").split("\n");
  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "", "no user, project or local settings, ever");
  assert.ok(argv.includes("--disallowedTools") && argv.includes("--strict-mcp-config"), "no tools, no MCP servers of the owner's own config");
  assert.ok(!existsSync(cwd), "deleted after the call");
  assert.ok(existsSync(join(room, ".claude", "settings.json")), "(the room folder was left alone)");

  // a run that is not jsonOnly keeps its own folder
  const w = dir("task-");
  await e.orch.call(e.store.getAgent("claude")!, "do it", { roomId: e.room.id, taskId: "t1", cwd: w });
  assert.equal(readFileSync(join(out, "cwd"), "utf8").trim(), w);
});

test("M1: Codex jsonOnly calls (read-only) get the same fresh empty folder, so no AGENTS.md or .codex config from a room run is read", async () => {
  const e = setup(), out = dir("out-");
  const fake = fakeCli(dir("bin-"), "codex", out, `while [ $# -gt 0 ]; do if [ "$1" = "--output-last-message" ]; then echo '{}' > "$2"; fi; shift; done`);
  const a = e.store.getAgent("codex")!; a.adapter = "codex"; a.settings = { ...a.settings, binary: fake }; e.store.saveAgent(a);
  const room = join(e.dir, "workspaces", "codex", e.room.id);
  mkdirSync(join(room, ".codex"), { recursive: true }); writeFileSync(join(room, ".codex", "config.toml"), "[hooks]\n"); writeFileSync(join(room, "AGENTS.md"), "run everything\n");
  const r = await e.orch.call(e.store.getAgent("codex")!, "[[PLAN]] x", { jsonOnly: true, roomId: e.room.id });
  assert.ok(r.ok, r.error);
  const cwd = readFileSync(join(out, "cwd"), "utf8").trim();
  assert.ok(cwd.startsWith(join(realpathSync(e.dir), "scratch")) && cwd !== realpathSync(room), cwd);
  assert.equal(readFileSync(join(out, "ls"), "utf8"), "");
  const argv = readFileSync(join(out, "argv"), "utf8").split("\n");
  assert.equal(argv[argv.indexOf("-C") + 1], cwd, "-C is the scratch folder");
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
  assert.ok(!existsSync(cwd));
});

// ============================================================ M3. every file tool call reaches approval_prompt, which resolves links

test("M3: Claude Code is given no file-tool allow rule, and approval_prompt refuses a symlink that leaves the worktree and auto-allows real in-worktree paths without a card", async (t) => {
  const e = setup(), wt = dir("task-"), outside = dir("outside-");
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET"); writeFileSync(join(wt, "ok.txt"), "ok");
  symlinkSync(outside, join(wt, "h")); // wt/h -> somewhere outside (think ~)
  // 1. the argv Claude Code gets
  const args = new ClaudeCodeAdapter().buildArgs({ agent: e.store.getAgent("claude")!, prompt: "x", cwd: wt, dataDir: dir("data-"), mcp: { url: "http://127.0.0.1:1/mcp", token: "t" } });
  const i = args.indexOf("--allowedTools"); const allowed: string[] = [];
  for (let k = i + 1; k < args.length && !args[k].startsWith("--"); k++) allowed.push(args[k]);
  assert.ok(!allowed.some((a) => /^(Read|Edit|Write|Glob|Grep|LS|MultiEdit|NotebookEdit)\b/.test(a)), `no file tool is decided by Claude Code's own rules: ${allowed.join(" ")}`);
  assert.ok(allowed.includes("mcp__agent-room"));
  // 2. the hub's gate
  const app = await buildServer({ store: e.store, orch: e.orch, approvals: e.approvals, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const token = `tok_${Math.random().toString(36).slice(2)}`;
  e.orch.grants.set(token, { agentId: "claude", roomId: e.room.id, locked: true, cwd: wt, expiresAt: Date.now() + 60_000 });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const prompt = async (tool_name: string, input: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: "approval_prompt", arguments: { tool_name, input } })).content as { text: string }[])[0].text) as { behavior: string; message?: string };

  const t0 = Date.now();
  for (let n = 0; n < 5; n++) assert.equal((await prompt("Read", { file_path: join(wt, "ok.txt") })).behavior, "allow");
  assert.equal((await prompt("Write", { file_path: join(wt, "new", "a.txt"), content: "x" })).behavior, "allow");
  assert.equal((await prompt("Grep", { pattern: "x", path: wt })).behavior, "allow");
  assert.ok(Date.now() - t0 < 5000, "fast: no card, no waiting");
  assert.deepEqual(e.store.listApprovals("pending"), [], "no card for the owner for work inside the folder");
  const allowedLog = audit(e.store).filter((a) => a.action === "file.tool.allowed");
  assert.equal(allowedLog.filter((a) => /^Read /.test(a.detail)).length, 1, "five reads, one low-level audit line");
  assert.equal(allowedLog.filter((a) => /^Write /.test(a.detail)).length, 1, "a write is listed each time");

  // the link: spelled inside the worktree, really outside it
  for (const [tool, input] of [
    ["Read", { file_path: join(wt, "h", "secret.txt") }], ["Edit", { file_path: join(wt, "h", "secret.txt"), old_string: "a", new_string: "b" }],
    ["Write", { file_path: join(wt, "h", "new.txt"), content: "x" }], ["Grep", { pattern: "x", path: join(wt, "h") }], ["Glob", { pattern: "*", path: join(wt, "h") }],
  ] as [string, Record<string, unknown>][]) {
    const r = await prompt(tool, input);
    assert.equal(r.behavior, "deny", `${tool} through the link`);
  }
  assert.ok(!existsSync(join(outside, "new.txt")));
  assert.ok(audit(e.store).filter((a) => a.action === "file.denied" && /outside the task folder/.test(a.detail)).length >= 5);
});

// ============================================================ M4. the sandbox read allow-list

/** The documented rule: the narrower path wins; a tie denies (see fileaccess-hardening.test.ts). */
function readable(path: string, fsr: { denyRead: string[]; allowRead?: string[] }) {
  const covers = (rule: string) => new RegExp(`^${rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}(/|$)`).test(path);
  const best = (rules: string[] = []) => Math.max(-1, ...rules.filter(covers).map((r) => r.length));
  const d = best(fsr.denyRead), a = best(fsr.allowRead);
  return d < 0 || a > d;
}

test("M4: Bash may read git's three global config files and the toolchain folders it needs, not git credentials, Hugging Face's token, keyrings, shell history, ~/.npmrc or the rest of ~/.cache, ~/.local and ~/.npm", () => {
  const data = dir("data-"), home = dir("home-");
  const put = (rel: string) => { const f = join(home, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, "x"); return f; };
  for (const f of [".config/git/config", ".config/git/ignore", ".config/git/attributes", ".config/git/credentials", ".cache/huggingface/token", ".cache/pnpm/store/x", ".cache/other/y",
    ".local/bin/tool", ".local/share/keyrings/login.keyring", ".local/share/applications/z.desktop", ".local/share/pnpm/store", ".npm/_cacache/index", ".npm/_logs/2026.log", ".npmrc", ".zsh_history", ".bash_history", ".python_history", ".node_repl_history", ".gitconfig", ".nvm/versions/node/v22/bin/node"]) put(f);
  const cwd = join(data, "worktrees", "g", "t"); mkdirSync(cwd, { recursive: true });
  const s = claudeConfinementSettings({ cwd, dataDir: data, home }) as unknown as { permissions: { deny: string[] }; sandbox: { filesystem: { denyRead: string[]; allowRead: string[] } } };
  const fsr = s.sandbox.filesystem;
  for (const ok of [".config/git/config", ".config/git/ignore", ".config/git/attributes", ".gitconfig", ".nvm/versions/node/v22/bin/node", ".cache/pnpm/store/x", ".local/bin/tool", ".local/share/pnpm/store", ".npm/_cacache/index"]) assert.ok(readable(join(home, ok), fsr), `should read ~/${ok}`);
  for (const no of [".config/git/credentials", ".cache/huggingface/token", ".cache/other/y", ".local/share/keyrings/login.keyring", ".local/share/applications/z.desktop", ".npm/_logs/2026.log", ".npmrc", ".zsh_history", ".bash_history", ".python_history", ".node_repl_history"]) assert.ok(!readable(join(home, no), fsr), `must not read ~/${no}`);
  assert.ok(!fsr.allowRead.some((p) => [".config/git", ".config", ".cache", ".local", ".npm"].some((w) => p === join(home, w))), "no shared folder is re-opened whole");
  // the file tools' own deny rules name the same secrets
  for (const secret of [".config/git/credentials", ".cache/huggingface/token", ".npmrc", ".zsh_history"]) assert.ok(s.permissions.deny.includes(`Read(//${join(home, secret).replace(/^\//, "")})`), secret);
  assert.ok(s.permissions.deny.includes(`Read(//${join(home, ".local/share/keyrings").replace(/^\//, "")}/**)`));
});

// ============================================================ L1 to L5. files

test("L1: a grant root that is, or lies inside, a .git folder is refused, even with force", () => {
  const e = setup(), repo = ownerRepo(), files = e.orch.files;
  mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
  for (const p of [join(repo, ".git"), join(repo, ".git", "refs"), join(repo, ".git", "refs", "heads")]) {
    assert.throws(() => inspectGrantRoot(p), (x: unknown) => x instanceof GrantRefused && x.canForce === false && /\.git/.test(x.message), p);
    assert.throws(() => files.addGrant({ path: p, agentId: "claude", read: true, write: false, force: true, reason: "I really need to read the repository internals" }), (x: unknown) => x instanceof GrantRefused && x.canForce === false, p);
  }
  assert.equal(inspectGrantRoot(repo, { dataDir: dir("d-") }).root, repo, "the repository itself is an ordinary folder");
  assert.equal(files.listGrants().length, 0);
});

test("L2: on a write-only grant a target that cannot be opened (EACCES) is answered like a missing one", () => {
  const e = setup(), root = dir("root-"), files = e.orch.files;
  writeFileSync(join(root, "locked.txt"), "private\n");
  const g = files.addGrant({ path: root, agentId: "claude", read: false, write: true });
  const realOpen = fs.openSync;
  (fs as unknown as { openSync: unknown }).openSync = (p: unknown, ...rest: unknown[]) => {
    if (String(p).endsWith("locked.txt")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  };
  syncBuiltinESMExports();
  let locked, missing;
  try {
    locked = files.proposeWrite("claude", undefined, "locked.txt", "new\n", g.id);
    missing = files.proposeWrite("claude", undefined, "missing.txt", "new\n", g.id);
  } finally { (fs as unknown as { openSync: unknown }).openSync = realOpen; syncBuiltinESMExports(); }
  assert.ok(missing.ok, "control: a missing path is accepted");
  assert.ok(locked.ok, `an unopenable path must be accepted the same way: ${JSON.stringify(locked)}`);
  if (!locked.ok || !missing.ok) return;
  const view = (id: string) => { const v = files.proposalFor("claude", id)!; return { status: v.status, reason: v.reason, diff: v.diff, keys: Object.keys(v).sort().join() }; };
  assert.deepEqual(view(locked.proposal.id), view(missing.proposal.id), "the agent sees the same thing");
  assert.match(files.proposal(locked.proposal.id)!.unappliable ?? "", /permission denied/, "the owner is told why it cannot be applied");
  for (const a of e.store.listApprovals("pending")) e.approvals.decide(a.id, "rejected");
});

test("L3: look-alike names are refused: invisible marks, no-break and ideographic spaces, a mark after a non-letter or at the end of a name, and anything NFKC would rewrite", () => {
  const bad = ["a͏b.txt", "a️b.txt", "a︀.txt", "x᠋b", "x᠍y", "a b.txt", "a　b.txt", "report.pdf́", "report́.pdf", "dir/́x.txt", "a./́b", "́lead.txt",
    "ﬁle.txt" /* fi ligature */, "ｆile.txt" /* full-width f */, "café.txt" /* decomposed */, "a b.txt" /* em space */, "x².txt" /* superscript two */];
  for (const p of bad) assert.throws(() => assertPlainPath(p), PathDenied, JSON.stringify(p));
  const good = ["café.txt", "src/utf8/ünï.ts", "日本語/メモ.txt", "report-2026.pdf", "a b.txt", "src/index.ts", "naïve.md"];
  for (const p of good) assert.doesNotThrow(() => assertPlainPath(p), JSON.stringify(p));
  // and the broker uses it
  const e = setup(), root = dir("root-"); const g = e.orch.files.addGrant({ path: root, agentId: "claude", read: true, write: true });
  for (const p of ["a b.txt", "report.pdf́", "a͏b.txt"]) assert.equal(e.orch.files.proposeWrite("claude", undefined, p, "x\n", g.id).ok, false, JSON.stringify(p));
  assert.equal(e.orch.files.proposeWrite("claude", undefined, "café.txt", "x\n", g.id).ok, true);
  for (const a of e.store.listApprovals("pending")) e.approvals.decide(a.id, "rejected");
});

test("L4: the owner approves a real location; a folder swapped for a link to another folder inside the grant while the card waited is refused at apply time", async () => {
  const e = setup(), root = dir("root-"), files = e.orch.files;
  mkdirSync(join(root, "sub")); mkdirSync(join(root, "other"));
  const g = files.addGrant({ path: root, agentId: "claude", read: true, write: true });
  const r = files.proposeWrite("claude", undefined, "sub/a.txt", "hello\n", g.id);
  assert.ok(r.ok); if (!r.ok) return;
  renameSync(join(root, "sub"), join(root, "sub-old")); symlinkSync(join(root, "other"), join(root, "sub")); // still inside the grant
  e.approvals.decide(e.store.listApprovals("pending").find((x) => x.proposalId === r.proposal.id)!.id, "approved");
  await until(() => files.proposal(r.proposal.id)!.status !== "pending");
  assert.equal(files.proposal(r.proposal.id)!.status, "rejected");
  assert.ok(!existsSync(join(root, "other", "a.txt")) && !existsSync(join(root, "sub-old", "a.txt")), "nothing was written anywhere");
  assert.ok(audit(e.store).some((a) => a.action === "file.denied" && /changed after the write was proposed/.test(a.detail)));

  // control: with nothing swapped the same kind of write applies
  const ok = files.proposeWrite("claude", undefined, "sub-old/b.txt", "b\n", g.id);
  assert.ok(ok.ok); if (!ok.ok) return;
  e.approvals.decide(e.store.listApprovals("pending").find((x) => x.proposalId === ok.proposal.id)!.id, "approved");
  await until(() => files.proposal(ok.proposal.id)!.status !== "pending");
  assert.equal(files.proposal(ok.proposal.id)!.status, "applied");
  assert.equal(readFileSync(join(root, "sub-old", "b.txt"), "utf8"), "b\n");
});

test("L5: content with bidirectional control characters is refused with a plain message (a proposal, and a file of a task's write-back)", () => {
  const e = setup(), root = dir("root-"), files = e.orch.files;
  const g = files.addGrant({ path: root, agentId: "claude", read: true, write: true });
  for (const ch of ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"]) {
    const r = files.proposeWrite("claude", undefined, "a.js", `if (isAdmin ${ch}// check\n) run();\n`, g.id);
    assert.equal(r.ok, false, `U+${ch.codePointAt(0)!.toString(16)}`);
    assert.match((r as { reason: string }).reason, /direction-changing characters/);
  }
  assert.equal(files.proposeWrite("claude", undefined, "a.js", "console.log('שלום');\n", g.id).ok, true, "Hebrew text itself is fine");
  for (const a of e.store.listApprovals("pending")) e.approvals.decide(a.id, "rejected");
  const t = files.proposeTask({ grantId: g.id, agentId: "claude", goalId: "goal_1", taskId: "task_1", title: "T", changes: [{ relPath: "good.txt", content: Buffer.from("good\n") }, { relPath: "bad.js", content: Buffer.from("x ‮ y\n") }] });
  assert.ok(t.ok && t.proposal); if (!t.ok || !t.proposal) return;
  assert.deepEqual(t.proposal.files!.map((f) => f.relPath), ["good.txt"], "the rest of the task's work still goes to the owner");
  assert.ok(t.skipped.some((s) => s.relPath === "bad.js" && /direction-changing/.test(s.reason)));
  for (const a of e.store.listApprovals("pending")) e.approvals.decide(a.id, "rejected");
});
