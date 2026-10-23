import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter } from "../src/adapters/mock.js";
import { codexBaseArgs } from "../src/adapters/codex.js";
import { claudeConfinementSettings } from "../src/files/confine.js";
import { HARDENED_GIT_CONFIG, hardenedGitArgs, hardenedGitEnv } from "../src/files/gitSafe.js";
import { McpTokens, hashToken } from "../src/mcp/tokens.js";
import { TaskWorkspaces, copyGrantedTree } from "../src/orchestrator/worktree.js";
import { setup } from "./helpers.js";

/**
 * 1.1 security review fixes. Each test here fails on the code as it was before the fix.
 * Run: cd packages/hub && npx tsx --test test/fileaccess-hardening.test.ts
 */
type Env = ReturnType<typeof setup>;
const dir = (p = "fh-") => realpathSync(mkdtempSync(join(tmpdir(), p)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) { for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20); assert.ok(fn(), "timed out waiting"); }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const audit = (store: Env["store"]) => store.listAudit(5000);
const count = (store: Env["store"], action: string) => audit(store).filter((a) => a.action === action).length;
function ownerRepo() {
  const d = dir("repo-");
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "README.md"), "# mine\n");
  git(d, "-c", "user.name=Owner", "-c", "user.email=o@example.com", "add", "-A");
  git(d, "-c", "user.name=Owner", "-c", "user.email=o@example.com", "commit", "-q", "-m", "init");
  return d;
}
function goalSettings(e: Env, planApproval: "never" | "always" = "never") {
  for (const a of e.store.listAgents()) { const x = e.store.getAgent(a.id)!; Object.assign(x.settings, { checks: true }); e.store.saveAgent(x); }
  e.store.setSettings({ ...e.store.getSettings(), planApproval, autoRunChecks: true });
}
const taskCalls = () => MockAdapter.calls.filter((c) => c.kind === "TASK");
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

// ============================================================ 1. the hub's git never runs what an agent wrote into the repo's config

test("1a: every hub git call carries the overrides for each option that can run a command, and the environment that closes the same doors", () => {
  const have = new Map(HARDENED_GIT_CONFIG);
  for (const [k, v] of [
    ["core.fsmonitor", "false"], ["core.hooksPath", "/dev/null"], ["diff.external", ""], ["core.sshCommand", ""], ["credential.helper", ""], ["core.askPass", ""],
    ["protocol.ext.allow", "never"], ["uploadpack.packObjectsHook", ""], ["core.alternateRefsCommand", ""], ["core.gitProxy", ""], ["core.editor", "true"],
  ]) assert.equal(have.get(k), v, k);
  const args = hardenedGitArgs();
  assert.ok(args.includes("--no-pager") && args.includes("core.fsmonitor=false") && args.includes("uploadpack.packObjectsHook="));
  const env = hardenedGitEnv();
  assert.equal(env.GIT_ATTR_NOSYSTEM, "1"); assert.equal(env.GIT_CONFIG_NOSYSTEM, "1"); assert.equal(env.GIT_ALLOW_PROTOCOL, "file");
  assert.ok("GIT_EXTERNAL_DIFF" in env && env.GIT_EXTERNAL_DIFF === undefined, "an inherited external diff program is removed");
});

test("1a: with a poisoned config, plain git runs the command and the hardened flags do not (so the attack is real here, and the flags close it)", () => {
  const repo = dir("poison-"), marker = join(dir("m-"), "ran");
  git(repo, "init", "-q"); writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "config", "core.fsmonitor", `touch ${marker}`);
  execFileSync("git", ["status", "--porcelain"], { cwd: repo });
  assert.ok(existsSync(marker), "control: an ordinary git call runs core.fsmonitor");
  rmSync(marker);
  git(repo, "config", "core.hooksPath", join(repo, "evil-hooks"));
  execFileSync("git", [...hardenedGitArgs(), "status", "--porcelain"], { cwd: repo, env: { ...process.env, ...hardenedGitEnv() } as NodeJS.ProcessEnv });
  assert.ok(!existsSync(marker), "the override wins over the repo's config");
});

/** What an agent with no OS sandbox can do from its worktree: run git there, which edits the SHARED config, hooks and attributes. */
function attack(w: { path: string }, base: string, marker: (n: string) => string) {
  git(w.path, "config", "core.fsmonitor", `touch ${marker("fsmonitor")}`);
  git(w.path, "config", "filter.evil.clean", `touch ${marker("filter")}; cat`);
  git(w.path, "config", "filter.evil.smudge", `touch ${marker("smudge")}; cat`);
  git(w.path, "config", "merge.evil.driver", `touch ${marker("merge")}; false`);
  git(w.path, "config", "diff.external", `touch ${marker("diff")}`);
  writeFileSync(join(w.path, ".gitattributes"), "*.txt filter=evil\n");
  writeFileSync(join(base, ".git", "info", "attributes"), "shared.md merge=evil\n");
  mkdirSync(join(base, ".git", "hooks"), { recursive: true });
  for (const h of ["post-commit", "post-merge", "reference-transaction", "pre-commit"]) { writeFileSync(join(base, ".git", "hooks", h), `#!/bin/sh\ntouch ${marker(h)}\n`); chmodSync(join(base, ".git", "hooks", h), 0o755); }
}

test("1: an agent that edits the shared git config, hooks and attributes cannot make the hub run them (fsmonitor, filter, merge driver, diff, hooks); the config is put back and audited", async () => {
  const data = dir("data-"), folder = dir("goal-"), markers = dir("markers-");
  const marker = (n: string) => join(markers, `RAN-${n}`);
  writeFileSync(join(folder, "seed.txt"), "seed\n"); writeFileSync(join(folder, "shared.md"), "one\ntwo\nthree\nfour\nfive\nsix\n");
  const seen: string[] = [];
  const ws = new TaskWorkspaces({ dataDir: data, onSecurity: (a) => seen.push(a) });
  const goal = { id: "goal_atk", folder };
  const t1 = await ws.open(goal, { id: "t1" }, "claude");
  const t2 = await ws.open(goal, { id: "t2" }, "codex");
  const configBefore = readFileSync(join(folder, ".git", "config"), "utf8");
  attack(t1, folder, marker);
  writeFileSync(join(t1.path, "shared.md"), "ONE\ntwo\nthree\nfour\nfive\nsix\n"); writeFileSync(join(t1.path, "a.txt"), "a\n");
  writeFileSync(join(t2.path, "shared.md"), "one\ntwo\nthree\nfour\nfive\nSIX\n"); writeFileSync(join(t2.path, "b.txt"), "b\n");
  const r1 = await ws.accept(goal, { id: "t1", title: "T1" });
  const r2 = await ws.accept(goal, { id: "t2", title: "T2" }); // a real merge: both changed shared.md
  assert.deepEqual(readdirSync(markers), [], `nothing the agent wrote ran: ${readdirSync(markers).join(", ")}`);
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.ok(r2.ok && r2.how === "merge", JSON.stringify(r2));
  assert.equal(readFileSync(join(folder, ".git", "config"), "utf8"), configBefore, "the config is byte for byte what the hub made");
  assert.ok(seen.includes("git.config.restored"), "and the restore was reported");
  assert.equal(readFileSync(join(folder, "shared.md"), "utf8"), "ONE\ntwo\nthree\nfour\nfive\nSIX\n", "the merge itself still worked");
  await ws.cleanup(goal, ["t1", "t2"]);
});

test("1: an agent that rewrites its worktree's commondir to a repository of its own cannot make the hub use that repository's config", async () => {
  const data = dir("data-"), folder = dir("goal-"), markers = dir("markers-"), evil = dir("evil-");
  writeFileSync(join(folder, "seed.txt"), "seed\n");
  const ws = new TaskWorkspaces({ dataDir: data });
  const goal = { id: "goal_cd", folder };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  // a copy of the real repository whose config the agent controls, and the worktree's admin folder pointed at it
  cpSync(join(folder, ".git"), join(evil, ".git"), { recursive: true });
  git(evil, "config", "filter.evil.clean", `touch ${join(markers, "RAN-filter")}; cat`);
  git(evil, "config", "core.fsmonitor", `touch ${join(markers, "RAN-fsmonitor")}`);
  const admin = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(w.path, ".git"), "utf8"))![1].trim();
  writeFileSync(join(admin, "commondir"), join(evil, ".git"));
  writeFileSync(join(w.path, ".gitattributes"), "*.txt filter=evil\n"); writeFileSync(join(w.path, "work.txt"), "work\n");
  const r = await ws.accept(goal, { id: "t1", title: "T" });
  assert.ok(r.ok && r.merged.includes("work.txt"), JSON.stringify(r));
  assert.deepEqual(readdirSync(markers), []);
  await ws.cleanup(goal, ["t1"]);
});

// ============================================================ 2. Bash reads: an allow-list

/** The documented rule: the narrower path wins (https://code.claude.com/docs/en/sandboxing, "denyRead ... allowRead"); a tie denies. */
function readable(path: string, fs: { denyRead: string[]; allowRead?: string[] }) {
  const covers = (rule: string) => new RegExp(`^${rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}(/|$)`).test(path);
  const best = (rules: string[] = []) => Math.max(-1, ...rules.filter(covers).map((r) => r.length));
  const d = best(fs.denyRead), a = best(fs.allowRead);
  return d < 0 || a > d;
}

test("2: Bash may read its own worktree and toolchains, and nothing of any other goal or task, the hub's database or the owner's home, including goals made after launch", () => {
  const data = dir("data-"), home = dir("home-");
  const mk = (...p: string[]) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
  const cwd = mk(data, "worktrees", "goal_a", "task_1");
  const base = mk(data, "goals", "goal_a", "files"); mkdirSync(join(base, ".git"));
  writeFileSync(join(data, "worktrees", "goal_a", "task_1.json"), JSON.stringify({ base }));
  const sibling = mk(data, "worktrees", "goal_a", "task_2"), shadow = mk(data, "worktrees", "goal_b", "_shadow"), integration = mk(data, "worktrees", "goal_b", "_integration"), repo = mk(data, "worktrees", "goal_b", "_repo");
  mk(home, ".nvm"); mk(home, ".ssh"); mk(home, "Documents"); writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = x\n"); writeFileSync(join(data, "t.db"), "db");
  const { sandbox } = claudeConfinementSettings({ cwd, dataDir: data, home }) as { sandbox: { filesystem: { denyRead: string[]; allowRead: string[] } } };
  const fs = sandbox.filesystem;
  for (const ok of [join(cwd, "src", "a.ts"), join(base, ".git", "objects", "ab"), join(home, ".nvm", "versions", "node"), join(home, ".gitconfig"), "/usr/bin/env", "/etc/hosts"]) assert.ok(readable(ok, fs), `should read ${ok}`);
  for (const no of [join(sibling, "a.ts"), join(shadow, "x"), join(integration, "x"), join(repo, ".git", "config"), join(data, "worktrees", "goal_new", "task_9", "a.ts"), join(data, "goals", "goal_a", "files", "LEDGER.md"), join(data, "t.db"), join(home, "Documents", "plan.docx"), join(home, ".ssh", "id_rsa")])
    assert.ok(!readable(no, fs), `must not read ${no}`);
  // a pointer an agent rewrote is not believed: only the hub's own record of the base decides which git dir is re-opened
  writeFileSync(join(cwd, ".git"), `gitdir: ${join(home, ".ssh")}/worktrees/x\n`);
  const again = (claudeConfinementSettings({ cwd, dataDir: data, home }) as { sandbox: { filesystem: { denyRead: string[]; allowRead: string[] } } }).sandbox.filesystem;
  assert.ok(!readable(join(home, ".ssh", "id_rsa"), again));
  // the owner can re-open a toolchain kept somewhere unusual
  const extra = mk(home, "weird-tools");
  const s2 = (claudeConfinementSettings({ cwd, dataDir: data, home, readAllow: ["~/weird-tools"] }) as { sandbox: { filesystem: { denyRead: string[]; allowRead: string[] } } }).sandbox.filesystem;
  assert.ok(!readable(join(extra, "bin"), fs) && readable(join(extra, "bin"), s2));
});

test("6: Codex runs without /tmp and without $TMPDIR as writable roots", () => {
  const e = setup();
  const seeded = e.store.getAgent("codex")!;
  const agent = { ...seeded, tools: { ...seeded.tools, filesystem: true } };
  const args = codexBaseArgs({ agent, cwd: dir("task-") }, "/tmp/out.txt");
  assert.ok(args.includes("sandbox_workspace_write.exclude_slash_tmp=true") && args.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true"));
});

// ============================================================ 3. granted-git mode: the agent never sees the owner's .git

test("3: a granted repo is cloned into the hub's data folder; the agent's worktree shares the clone's .git, which has no trace of the owner's repo; accepted work is pushed back", async () => {
  const data = dir("data-"), owner = ownerRepo(), markers = dir("markers-");
  git(owner, "remote", "add", "origin", "https://user:SECRET-TOKEN-123@example.com/x.git");
  const probe = join(markers, "fsmonitor.sh"); writeFileSync(probe, `#!/bin/sh\ntouch ${join(markers, "RAN-owner-fsmonitor")}\n`); chmodSync(probe, 0o755);
  git(owner, "config", "core.fsmonitor", probe);
  rmSync(join(markers, "RAN-owner-fsmonitor"), { force: true });
  for (const h of ["post-checkout", "update", "pre-receive", "post-receive"]) { writeFileSync(join(owner, ".git", "hooks", h), `#!/bin/sh\ntouch ${join(markers, `RAN-${h}`)}\nexit 0\n`); chmodSync(join(owner, ".git", "hooks", h), 0o755); }
  const ownerConfig = readFileSync(join(owner, ".git", "config"));
  const head = git(owner, "rev-parse", "HEAD");
  const ws = new TaskWorkspaces({ dataDir: data });
  const goal = { id: "goal_gg", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_gg" } };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  assert.equal(w.mode, "granted-git");
  assert.ok(w.base.startsWith(data) && !w.base.startsWith(owner), "the work folder's repository is inside the hub's data folder");
  const pointer = readFileSync(join(w.path, ".git"), "utf8");
  assert.ok(pointer.includes(data) && !pointer.includes(owner));
  for (const f of walk(join(w.base, ".git")).filter((f) => !f.includes(`${join(".git", "objects")}`))) {
    const text = readFileSync(f, "latin1");
    assert.ok(!text.includes("SECRET-TOKEN-123") && !text.includes(owner) && !text.includes("example.com"), `${f} names the owner's repository`);
  }
  assert.deepEqual(existsSync(join(w.base, ".git", "hooks")) ? readdirSync(join(w.base, ".git", "hooks")) : [], [], "no hooks were copied");
  assert.equal(git(w.base, "remote"), "", "the clone has no remote");
  assert.deepEqual(git(w.base, "branch", "--list", "--format=%(refname:short)").split("\n").sort(), ["agent-room/goal_gg", "ar/t1"], "only the goal's own history was fetched, on the goal branch");

  writeFileSync(join(w.path, "new.txt"), "hi\n");
  const r = await ws.accept(goal, { id: "t1", title: "T" });
  assert.ok(r.ok && r.source?.mode === "granted-git" && r.source.pushed === true, JSON.stringify(r));
  assert.deepEqual(readdirSync(markers).filter((n) => n.startsWith("RAN-")), [], `neither the owner's config nor their hooks were run by the hub: ${readdirSync(markers).join(", ")}`);
  assert.deepEqual(readFileSync(join(owner, ".git", "config")), ownerConfig, "the owner's own config was never rewritten");
  const og = (...a: string[]) => git(owner, "-c", "core.fsmonitor=false", ...a); // the test's own look at the owner's repo must not trip the probe either
  assert.equal(og("show", "agent-room/goal_gg:new.txt"), "hi", "the owner's repo has the branch with the accepted work");
  assert.equal(og("rev-parse", "HEAD"), head); assert.equal(og("branch", "--show-current"), "main");
  assert.equal(og("status", "--porcelain"), "");
  assert.equal(og("worktree", "list").split("\n").length, 1); assert.equal(og("branch", "--list", "ar/*"), "");
  await ws.discard(goal, "t1");
  await ws.cleanup(goal, ["t1"]);
  assert.ok(!existsSync(join(data, "worktrees", "goal_gg")), "the clone is gone after the goal; the branch stays in the owner's repo");
  assert.ok(og("log", "-1", "--format=%s", "agent-room/goal_gg").length > 0);
});

test("3: when the owner has the goal branch checked out the push is refused and reported, nothing of theirs moves, and the work is pushed with the next task or kept at cleanup", async () => {
  const data = dir("data-"), owner = ownerRepo();
  git(owner, "branch", "agent-room/goal_pr"); git(owner, "checkout", "-q", "agent-room/goal_pr");
  const before = git(owner, "rev-parse", "HEAD");
  const ws = new TaskWorkspaces({ dataDir: data });
  const goal = { id: "goal_pr", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_pr" } };
  const w1 = await ws.open(goal, { id: "t1" }, "claude");
  writeFileSync(join(w1.path, "one.txt"), "1\n");
  const r1 = await ws.accept(goal, { id: "t1", title: "One" });
  assert.ok(r1.ok && r1.source?.mode === "granted-git" && r1.source.pushed === false && /./.test(r1.source.pushError ?? ""), JSON.stringify(r1));
  assert.equal(git(owner, "rev-parse", "HEAD"), before, "their checked-out branch did not move"); assert.equal(git(owner, "status", "--porcelain"), "");
  await ws.discard(goal, "t1");
  // the owner moves away; the next accepted task carries the first one's work too
  git(owner, "checkout", "-q", "main");
  const w2 = await ws.open(goal, { id: "t2" }, "claude");
  writeFileSync(join(w2.path, "two.txt"), "2\n");
  const r2 = await ws.accept(goal, { id: "t2", title: "Two" });
  assert.ok(r2.ok && r2.source?.mode === "granted-git" && r2.source.pushed === true, JSON.stringify(r2));
  assert.equal(git(owner, "show", "agent-room/goal_pr:one.txt"), "1"); assert.equal(git(owner, "show", "agent-room/goal_pr:two.txt"), "2");
  await ws.cleanup(goal, ["t2"]);

  // a push that still fails at cleanup does not lose the work: the clone is kept in the data folder
  const g3 = { id: "goal_up", folder: dir("goal-"), source: { grantId: "grant_1", path: owner, write: true, branch: "agent-room/goal_up" } };
  git(owner, "branch", "agent-room/goal_up"); git(owner, "checkout", "-q", "agent-room/goal_up");
  const seen: string[] = [];
  const ws3 = new TaskWorkspaces({ dataDir: data, onSecurity: (a) => seen.push(a) });
  const w3 = await ws3.open(g3, { id: "t3" }, "claude");
  writeFileSync(join(w3.path, "kept.txt"), "k\n");
  const r3 = await ws3.accept(g3, { id: "t3", title: "Three" });
  assert.ok(r3.ok && r3.source?.mode === "granted-git" && r3.source.pushed === false);
  await ws3.cleanup(g3, ["t3"]);
  assert.ok(seen.includes("goal.source.unpushed"));
  assert.equal(git(join(data, "unpushed", "goal_up"), "show", "agent-room/goal_up:kept.txt"), "k");
});

// ============================================================ 4. a narrowed grant stops what the old audience proposed

test("4: narrowing a grant to another agent or room settles the writes already waiting; and the apply step checks again even if the narrowing bypassed updateGrant", async () => {
  const e = setup();
  const root = dir("root-"), files = e.orch.files;
  const g = files.addGrant({ path: root, agentId: "*", read: true, write: true });
  const a = files.proposeWrite("claude", undefined, "a.txt", "a\n", g.id);
  const b = files.proposeWrite("codex", undefined, "b.txt", "b\n", g.id);
  assert.ok(a.ok && b.ok); if (!a.ok || !b.ok) return;
  files.updateGrant(g.id, { agentId: "codex" });
  assert.equal(files.proposal(a.proposal.id)!.status, "rejected", "claude is no longer covered");
  assert.match(files.proposal(a.proposal.id)!.reason ?? "", /no longer covers/);
  assert.equal(files.proposal(b.proposal.id)!.status, "pending", "codex still is");
  assert.equal(e.store.listApprovals().find((x) => x.proposalId === a.proposal.id)!.status, "expired");
  files.updateGrant(g.id, { roomId: "room_elsewhere" });
  assert.equal(files.proposal(b.proposal.id)!.status, "rejected", "a grant moved to another room stops what waited in this one... ");
  // (b was proposed with no room, the grant now needs room_elsewhere)

  // bypass: change the stored grant behind updateGrant's back, then the owner approves
  const g2 = files.addGrant({ path: dir("root-"), agentId: "*", read: true, write: true });
  const c = files.proposeWrite("claude", undefined, "c.txt", "c\n", g2.id);
  assert.ok(c.ok); if (!c.ok) return;
  e.store.setKV("folder_grants", files.listGrants().map((x) => (x.id === g2.id ? { ...x, agentId: "hermes" } : x)));
  e.approvals.decide(e.store.listApprovals("pending").find((x) => x.proposalId === c.proposal.id)!.id, "approved");
  await until(() => files.proposal(c.proposal.id)!.status !== "pending");
  assert.equal(files.proposal(c.proposal.id)!.status, "rejected");
  assert.ok(!existsSync(join(g2.path, "c.txt")), "nothing was written");
  assert.ok(audit(e.store).some((x) => x.action === "file.denied" && /no longer covers this agent here \(at apply time\)/.test(x.detail)));
});

// ============================================================ 5. a goal on a folder keeps checking its authority

test("5: GoalSources.ref re-checks the grant: narrowed to one agent, moved to another room, made unreadable or removed all mean revoked", () => {
  const e = setup(); const files = e.orch.files;
  const folder = dir("plain-");
  const mk = () => files.addGrant({ path: dir("plain-"), agentId: "*", read: true, write: true });
  const goalFor = (grantId: string) => ({ id: "goal_r", roomId: e.room.id, text: "x", status: "running" as const, createdAt: 1, sourceGrantId: grantId });
  const refOf = (grantId: string) => e.orch.goalSources.ref(goalFor(grantId), folder).source!;
  void folder;
  const g = mk();
  assert.equal(refOf(g.id).revoked, undefined); assert.equal(refOf(g.id).write, true);
  files.updateGrant(g.id, { agentId: "claude" }); assert.equal(refOf(g.id).revoked, true, "narrowed to one agent");
  files.updateGrant(g.id, { agentId: "*" }); assert.equal(refOf(g.id).revoked, undefined);
  files.updateGrant(g.id, { roomId: "room_other" }); assert.equal(refOf(g.id).revoked, true, "granted to a different room");
  files.updateGrant(g.id, { roomId: "" }); files.updateGrant(g.id, { read: false }); assert.equal(refOf(g.id).revoked, true, "no longer readable");
  files.updateGrant(g.id, { read: true }); files.removeGrant(g.id); assert.equal(refOf(g.id).revoked, true, "removed");
  assert.equal(refOf(g.id).write, false);
});

test("5: narrowing the grant while a goal waits for plan approval stops the goal: no task runs, nothing is written, the owner is told once", async () => {
  const e = setup(); goalSettings(e, "always");
  const folder = dir("plain-"); writeFileSync(join(folder, "old.txt"), "old\n");
  const grant = e.orch.files.addGrant({ path: folder, agentId: "*", read: true, write: true });
  MockAdapter.calls.length = 0;
  void e.orch.runGoal(e.room.id, "Summarize the venue TV market", { folderGrantId: grant.id });
  await until(() => e.store.listGoals(e.room.id)[0]?.status === "awaiting_approval");
  const goalId = e.store.listGoals(e.room.id)[0].id;
  e.orch.files.updateGrant(grant.id, { agentId: "claude" });
  e.orch.decidePlan(goalId, "approve");
  await e.orch.idle();
  const g = e.store.getGoal(goalId)!;
  assert.equal(g.status, "failed"); assert.match(g.summary ?? "", /no longer open/);
  assert.equal(taskCalls().length, 0, "no agent was started");
  assert.equal(e.orch.files.proposals().length, 0);
  assert.deepEqual(readdirSync(folder), ["old.txt"]);
  assert.equal(count(e.store, "goal.source.revoked"), 1);
  const told = e.store.listMessages(e.room.id).filter((m) => /no longer shared with it/.test(m.text));
  assert.equal(told.length, 1, "told once");
});

// ============================================================ 7. hard links

test("7: a file with more than one hard link is not readable through the broker", () => {
  const e = setup(); const files = e.orch.files;
  const root = dir("root-"), outside = dir("outside-");
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET"); writeFileSync(join(root, "plain.txt"), "plain\n");
  linkSync(join(outside, "secret.txt"), join(root, "innocent.txt"));
  const g = files.addGrant({ path: root, agentId: "claude", read: true, write: true });
  const ok = files.read("claude", undefined, "plain.txt", g.id);
  assert.ok(ok.ok && !ok.binary && ok.content === "plain\n");
  const bad = files.read("claude", undefined, "innocent.txt", g.id);
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes("TOP SECRET"));
  assert.match((bad as { reason: string }).reason, /hard link/);
  const w = files.proposeWrite("claude", undefined, "innocent.txt", "overwrite\n", g.id);
  assert.equal(w.ok, false, "and it is not diffed against either");
});

test("7: a hard link in a task's work folder is not committed, not merged and not written back; and copying a granted tree skips hard links with a reason", async () => {
  const data = dir("data-"), folder = dir("goal-"), outside = dir("outside-");
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET"); writeFileSync(join(folder, "seed.txt"), "seed\n");
  const seen: string[] = [];
  const ws = new TaskWorkspaces({ dataDir: data, onSecurity: (a) => seen.push(a) });
  const goal = { id: "goal_hl", folder };
  const w = await ws.open(goal, { id: "t1" }, "claude");
  linkSync(join(outside, "secret.txt"), join(w.path, "stolen.txt")); writeFileSync(join(w.path, "ok.txt"), "ok\n");
  const r = await ws.accept(goal, { id: "t1", title: "T" });
  assert.ok(r.ok && r.merged.includes("ok.txt") && !r.merged.includes("stolen.txt"), JSON.stringify(r));
  assert.ok(r.ok && r.hardLinks?.includes("stolen.txt"));
  assert.ok(!existsSync(join(folder, "stolen.txt")), "the content never reached the base");
  assert.throws(() => git(folder, "cat-file", "-e", "HEAD:stolen.txt"));
  assert.ok(seen.includes("worktree.hardlink"));
  await ws.cleanup(goal, ["t1"]);

  // collecting what a task changed for write-back
  const shadow = dir("shadow-"); writeFileSync(join(shadow, "a.txt"), "a\n"); linkSync(join(outside, "secret.txt"), join(shadow, "b.txt"));
  const got = (ws as unknown as { collectChanges(s: string, f: string[], n: number): { changes: { relPath: string }[]; skipped: { relPath: string; reason: string }[] } }).collectChanges(shadow, ["a.txt", "b.txt"], 1000);
  assert.deepEqual(got.changes.map((c) => c.relPath), ["a.txt"]);
  assert.deepEqual(got.skipped.map((s) => s.relPath), ["b.txt"]); assert.match(got.skipped[0].reason, /hard link/);

  // copying a granted folder
  const src = dir("src-"), dst = join(dir("dst-"), "copy");
  writeFileSync(join(src, "keep.txt"), "k"); linkSync(join(outside, "secret.txt"), join(src, "second-name.txt"));
  const c = copyGrantedTree(src, dst);
  assert.equal(c.files, 1); assert.equal(c.skippedHardLinks, 1);
  assert.deepEqual(c.skipped, [{ relPath: "second-name.txt", reason: "hard link" }]);
  assert.deepEqual(readdirSync(dst), ["keep.txt"]);
});

// ============================================================ 8. one agent cannot fill the owner's queue

test("8: one agent gets 20 waiting writes; other agents can still propose; the hub-wide cap stays 50", () => {
  const e = setup(); const files = e.orch.files;
  const root = dir("root-");
  const g = files.addGrant({ path: root, agentId: "*", read: true, write: true });
  for (let i = 0; i < 20; i++) assert.ok(files.proposeWrite("claude", undefined, `c${i}.txt`, "x\n", g.id).ok, `proposal ${i}`);
  const over = files.proposeWrite("claude", undefined, "c-over.txt", "x\n", g.id);
  assert.equal(over.ok, false); assert.match((over as { reason: string }).reason, /20 writes waiting/);
  assert.ok(files.proposeWrite("codex", undefined, "x0.txt", "x\n", g.id).ok, "another agent is not blocked");
  assert.ok(audit(e.store).some((a) => a.action === "file.denied" && /already has 20/.test(a.detail)));
  for (const a of e.store.listApprovals("pending")) e.approvals.decide(a.id, "rejected");
});

// ============================================================ 9. legacy keys leave no trace in free pages

test("9: after legacy plaintext keys are migrated the database is rebuilt, so no free page still holds them", () => {
  const e = setup();
  const legacy: Record<string, { agentId: string; name: string }> = {};
  const keys = Array.from({ length: 400 }, (_, i) => `legacy-key-${i}-${"x".repeat(60)}`);
  for (const k of keys) legacy[k] = { agentId: "hermes", name: "Hermes" };
  e.store.setKV("mcp_tokens", legacy);
  new McpTokens(e.store);
  assert.deepEqual(e.store.getKV("mcp_tokens", {}), {});
  assert.equal(e.store.db.pragma("freelist_count", { simple: true }), 0, "VACUUM released every free page");
  e.store.db.pragma("wal_checkpoint(TRUNCATE)");
  const file = readFileSync(join(e.dir, "t.db"));
  assert.ok(!file.includes(keys[0]) && !file.includes(keys[399]), "no plaintext key is left in the file");
  assert.ok(JSON.stringify(e.store.getKV("mcp_tokens_v2", [])).includes(hashToken(keys[0])));
});
