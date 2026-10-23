import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Goal, Task } from "@agent-room/shared";
import { setup } from "./helpers.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { Approvals } from "../src/orchestrator/approvals.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { newProgress } from "../src/orchestrator/ledger.js";
import { goalFolder } from "../src/orchestrator/workspace.js";
import { TaskWorkspaces } from "../src/orchestrator/worktree.js";
import { id, now } from "../src/util.js";

type Env = ReturnType<typeof setup>;
const until = async (fn: () => boolean, ms = 5000) => { for (let i = 0; i < ms / 20 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const agent = (e: Env, aid: string, settings: Record<string, unknown>) => { const a = e.store.getAgent(aid)!; Object.assign(a.settings, settings); e.store.saveAgent(a); };
/** Hold both agents' task runs open until the two are running together (the mock's `barrier` knob). A worktree takes an unbounded time to cut on a loaded machine, so a delayMs alone cannot make them overlap. */
const together = (e: Env, a: string, b: string, extra: Record<string, unknown> = {}) => { for (const id of [a, b]) agent(e, id, { barrier: { key: e.dir, n: 2 }, ...extra }); };
const taskCalls = () => MockAdapter.calls.filter((c) => c.kind === "TASK");

interface Spec { key: string; owner: string; files?: string[]; deps?: string[] }
/** A running goal with ready-made tasks (the planner would never plan two tasks on one file, so tests build the plan by hand). */
function seedGoal(e: Env, specs: Spec[]) {
  const goalId = id("goal");
  const goal: Goal = {
    id: goalId, roomId: e.room.id, text: "Parallel work", status: "running", createdAt: now(), approvedAt: now(), folder: goalFolder(e.dir, goalId),
    contract: { objective: "Parallel work", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: now(), amendments: [], requirements: [] },
    state: { decisions: [], nextAction: "", progress: newProgress() },
  };
  e.store.saveGoal(goal);
  const ids = new Map(specs.map((s) => [s.key, id("task")]));
  const tasks = specs.map((s): Task => ({
    id: ids.get(s.key)!, roomId: e.room.id, goalId, title: `Task ${s.key}`, description: `Do the work for ${s.key}, carefully.`, taskType: "other",
    acceptance: "AC1: Done.", criteria: [{ id: "AC1", text: "Done." }], dependsOn: (s.deps ?? []).map((d) => ids.get(d)!), owner: s.owner, role: "worker",
    files: s.files ?? [], status: "pending", attempts: 0, history: [], createdAt: now(), updatedAt: now(),
  }));
  tasks.forEach((t) => e.store.saveTask(t));
  return { goalId, goal, tasks, base: goal.folder! };
}
const settle = async (e: Env, goalId: string) => { const g = await e.orch.advance(goalId); await e.orch.idle(); return g; };
const branches = (base: string) => git(base, "branch", "--list", "--format=%(refname:short)", "ar/*");
const worktreeDirs = (e: Env, goalId: string) => { try { return readdirSync(join(e.dir, "worktrees", goalId)); } catch { return []; } };

test("AC1: every task attempt runs in its own directory, never the goal folder or another task's", async () => {
  const e = setup();
  for (const a of e.store.listAgents()) agent(e, a.id, { checks: true });
  e.store.setSettings({ ...e.store.getSettings(), planApproval: "never", autoRunChecks: true });
  MockAdapter.calls.length = 0;
  const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const cwds = taskCalls().map((c) => c.cwd);
  assert.equal(cwds.length, 2);
  assert.equal(new Set(cwds).size, 2, "one directory per task");
  for (const c of cwds) {
    assert.notEqual(c, goal.folder, "never the shared goal folder");
    assert.ok(c.startsWith(join(e.dir, "worktrees", goal.id)), "worktrees live under <data>/worktrees, outside the base");
  }
  // the second task depends on the first and was cut after it merged, so it sees research.md
  assert.ok(taskCalls()[1].prompt.includes("research.md"), "files from accepted tasks reach later tasks");
  assert.ok(existsSync(join(goal.folder!, "research.md")) && existsSync(join(goal.folder!, "summary.md")), "accepted work is in the base");
  assert.match(taskCalls()[0].prompt, /LEDGER\.md|progress record is/, "the ledger is still pointed at");
  assert.ok(taskCalls()[0].prompt.includes(join(goal.folder!, "LEDGER.md")), "its path (in the base) is in the prompt");
});

test("AC1/AC2: the base is a git repo with the hub identity; LEDGER.md stays out of it; agents author their own commits", async () => {
  const e = setup();
  const { goalId, base } = seedGoal(e, [{ key: "a", owner: "claude", files: ["a.txt"] }, { key: "b", owner: "codex", files: ["b.txt"] }]);
  const g = await settle(e, goalId);
  assert.equal(g.status, "done");
  assert.ok(existsSync(join(base, ".git")));
  assert.ok(existsSync(join(base, "LEDGER.md")), "the ledger is written in the base");
  assert.equal(git(base, "status", "--porcelain"), "", "LEDGER.md is ignored, everything else is committed");
  assert.ok(!git(base, "ls-files").includes("LEDGER.md"));
  const authors = git(base, "log", "--format=%an|%ae").split("\n");
  assert.ok(authors.includes("claude|claude@agent-room.local") && authors.includes("codex|codex@agent-room.local"), "agent id is the author");
  assert.ok(authors.includes("Agent Room|hub@agent-room.local"), "hub identity for base and merges");
});

test("AC2: accepted work merges into the base; reassigned and failed work never does", async () => {
  // reassigned: Codex writes x.md then reports blocked; the task goes to someone else, who starts from a clean worktree
  const e = setup();
  agent(e, "codex", { status: "blocked" });
  const { goalId, base, tasks } = seedGoal(e, [{ key: "a", owner: "codex", files: ["x.md"] }]);
  MockAdapter.calls.length = 0;
  const g = await settle(e, goalId);
  assert.equal(g.status, "done");
  const t = e.store.getTask(tasks[0].id)!;
  assert.notEqual(t.assignee, "codex", "reassigned");
  assert.equal(read(base, "x.md"), `${e.store.getAgent(t.assignee!)!.name} wrote x.md\n`, "only the accepted agent's work is in the base");
  assert.ok(!read(base, "x.md").includes("Codex"));
  const [first, second] = taskCalls();
  assert.ok(!first.prompt.includes("- x.md") && !second.prompt.includes("- x.md"), "the new agent started from a fresh worktree, not Codex's leftovers");
  assert.ok(!existsSync(first.cwd) && !existsSync(second.cwd), "both worktrees are gone");

  // failed: the work is judged too thin on every attempt, so it is rejected and never merged
  const f = setup();
  for (const a of f.store.listAgents()) agent(f, a.id, { quality: 0.3 });
  f.store.setSettings({ ...f.store.getSettings(), maxAttempts: 2, maxGoalReplans: 0 });
  const s = seedGoal(f, [{ key: "a", owner: "claude", files: ["bad.md"] }]);
  MockAdapter.calls.length = 0;
  await settle(f, s.goalId);
  const bad = f.store.getTask(s.tasks[0].id)!;
  assert.equal(bad.status, "failed");
  assert.ok(!existsSync(join(s.base, "bad.md")), "rejected work is discarded, not merged");
  assert.ok(taskCalls().length >= 2 && existsSync(join(s.base, ".git")));
  assert.equal(new Set(taskCalls().map((c) => c.cwd)).size, 1, "a revision by the same agent keeps its worktree");
  assert.deepEqual(worktreeDirs(f, s.goalId), [], "and it is removed once the task fails");
  assert.equal(branches(s.base), "");
});

test("AC3: two agents write the same file in the same repo in parallel: separate directories, first merges, second is sent back to merge, nothing is overwritten", async () => {
  const e = setup();
  together(e, "claude", "codex");
  agent(e, "claude", { shared: "notes.txt", delayMs: 250 });
  agent(e, "codex", { shared: "notes.txt", delayMs: 700 });
  const { goalId, base, tasks } = seedGoal(e, [{ key: "a", owner: "claude", files: ["notes.txt"] }, { key: "b", owner: "codex", files: ["notes.txt"] }]);
  MockAdapter.calls.length = 0;
  const g = await settle(e, goalId);
  assert.equal(g.status, "done");

  const firstRuns = taskCalls().slice(0, 2);
  assert.notEqual(firstRuns[0].cwd, firstRuns[1].cwd, "never one directory");
  assert.ok(firstRuns.every((c) => c.cwd !== base && c.cwd.startsWith(join(e.dir, "worktrees"))));
  const firstJudge = MockAdapter.calls.findIndex((c) => c.kind === "JUDGE");
  assert.ok(MockAdapter.calls.slice(0, firstJudge).filter((c) => c.kind === "TASK").length === 2, "both started before either was judged: they ran in parallel");

  const [a, b] = tasks.map((t) => e.store.getTask(t.id)!);
  assert.equal(a.status, "done"); assert.equal(b.status, "done");
  assert.ok(!(a.history ?? []).some((h) => h.note.startsWith("merge conflict")), "the first to finish merged cleanly");
  const conflict = (b.history ?? []).find((h) => h.note.startsWith("merge conflict"));
  assert.ok(conflict?.note.includes("notes.txt"), "the second was sent back, naming the file");
  assert.equal(b.attempts, 1, "a conflict does not use up an attempt");
  const retry = taskCalls().filter((c) => c.agentId === "codex")[1];
  assert.ok(retry, "Codex ran again");
  assert.match(retry.prompt, /could not be merged: notes\.txt/);
  assert.match(retry.prompt, /keep BOTH/);
  assert.equal(retry.cwd, taskCalls().filter((c) => c.agentId === "codex")[0].cwd, "the retry reuses the same worktree");

  const merged = read(base, "notes.txt");
  assert.ok(merged.includes("Claude wrote notes.txt") && merged.includes("Codex wrote notes.txt"), "both changes are in the base");
  assert.ok(!/^(<{7}|={7}|>{7})/m.test(merged), "no conflict markers survive");
  assert.equal(git(base, "status", "--porcelain"), "");
  assert.deepEqual(worktreeDirs(e, goalId), []);
});

test("AC3: two parallel tasks writing different files both merge cleanly, and never conflict", async () => {
  const e = setup();
  together(e, "claude", "codex");
  agent(e, "claude", { delayMs: 250 }); agent(e, "codex", { delayMs: 700 });
  const { goalId, base, tasks } = seedGoal(e, [{ key: "a", owner: "claude", files: ["a.txt"] }, { key: "b", owner: "codex", files: ["docs/b.txt"] }]);
  MockAdapter.calls.length = 0;
  const g = await settle(e, goalId);
  assert.equal(g.status, "done");
  assert.equal(read(base, "a.txt"), "Claude wrote a.txt\n");
  assert.equal(read(base, "docs/b.txt"), "Codex wrote docs/b.txt\n");
  assert.ok(tasks.every((t) => !(e.store.getTask(t.id)!.history ?? []).some((h) => h.note.startsWith("merge conflict"))));
  assert.equal(taskCalls().length, 2, "no retries");
  assert.equal(git(base, "rev-list", "--merges", "--count", "HEAD"), "1", "the first fast-forwarded, the second needed a real merge");
});

test("AC4: worktrees and ar/* branches are gone when the goal finishes", async () => {
  const e = setup();
  const { goalId, base } = seedGoal(e, [{ key: "a", owner: "claude", files: ["a.txt"] }, { key: "b", owner: "codex", files: ["b.txt"], deps: ["a"] }]);
  const g = await settle(e, goalId);
  assert.equal(g.status, "done");
  assert.equal(branches(base), "");
  assert.deepEqual(worktreeDirs(e, goalId), []);
  assert.equal(git(base, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "git knows only the base");
  assert.ok(!existsSync(join(e.dir, "worktrees", goalId)));
  assert.ok(existsSync(join(base, "a.txt")) && existsSync(join(base, "b.txt")), "the merged work stays in the base");
});

test("AC4: worktrees and branches are gone after the goal is stopped, and the half-done work is not merged", async () => {
  const e = setup();
  together(e, "claude", "codex");
  agent(e, "claude", { delayMs: 800 }); agent(e, "codex", { delayMs: 800 });
  const { goalId, base, tasks } = seedGoal(e, [{ key: "a", owner: "claude", files: ["a.txt"] }, { key: "b", owner: "codex", files: ["b.txt"] }]);
  const run = e.orch.advance(goalId);
  await until(() => tasks.every((t) => e.orch.taskWorktree(t))); // both have a worktree
  await until(() => taskCalls().length >= 2);
  const dirs = tasks.map((t) => e.orch.taskWorktree(t)!);
  assert.ok(dirs.every((d) => existsSync(d)));
  assert.equal(git(base, "branch", "--list", "--format=%(refname:short)", "ar/*").split("\n").length, 2);
  e.orch.stopRoom(e.room.id);
  await run; await e.orch.idle();
  assert.ok(dirs.every((d) => !existsSync(d)), "worktrees removed");
  assert.equal(branches(base), "", "branches removed");
  assert.deepEqual(worktreeDirs(e, goalId), []);
  assert.ok(!existsSync(join(base, "a.txt")) && !existsSync(join(base, "b.txt")), "unaccepted work never reached the base");
  assert.equal(e.store.getGoal(goalId)!.status, "failed");
});

test("copy fallback: with no usable git, tasks get folder copies; accepted work is copied back, rejected work is not, conflicts are caught", async () => {
  const e = setup({ gitBin: "/bin/false" });
  together(e, "claude", "codex");
  agent(e, "claude", { shared: "notes.txt", delayMs: 250 });
  agent(e, "codex", { shared: "notes.txt", delayMs: 700 });
  const s = seedGoal(e, [{ key: "a", owner: "claude", files: ["notes.txt", "a.txt"] }, { key: "b", owner: "codex", files: ["notes.txt"] }]);
  MockAdapter.calls.length = 0;
  const g = await settle(e, s.goalId);
  assert.equal(g.status, "done");
  assert.ok(!existsSync(join(s.base, ".git")), "no repo was made");
  const cwds = taskCalls().map((c) => c.cwd);
  assert.ok(cwds.every((c) => c !== s.base && c.startsWith(join(e.dir, "worktrees"))));
  assert.notEqual(cwds[0], cwds[1]);
  const b = e.store.getTask(s.tasks[1].id)!;
  assert.ok((b.history ?? []).some((h) => h.note.startsWith("merge conflict") && h.note.includes("notes.txt")), "the second copy was caught, not copied over the first");
  const merged = read(s.base, "notes.txt");
  assert.ok(merged.includes("Claude wrote notes.txt") && merged.includes("Codex wrote notes.txt"));
  assert.ok(!/^(<{7}|={7}|>{7})/m.test(merged));
  assert.equal(read(s.base, "a.txt"), "Claude wrote a.txt\n");
  assert.deepEqual(worktreeDirs(e, s.goalId), []);

  // rejected: Codex is blocked, so its copy is discarded and a different agent's work is what lands
  const f = setup({ gitBin: "/nonexistent/git" });
  agent(f, "codex", { status: "blocked" });
  const r = seedGoal(f, [{ key: "a", owner: "codex", files: ["x.md"] }]);
  MockAdapter.calls.length = 0;
  const done = await settle(f, r.goalId);
  assert.equal(done.status, "done");
  assert.ok(!read(r.base, "x.md").includes("Codex"));
  assert.ok(taskCalls().every((c) => !existsSync(c.cwd)), "copies removed");
});

test("TaskWorkspaces: reuse for the same agent, fresh for another, base excludes the ledger, discard is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const ws = new TaskWorkspaces({ dataDir: dir });
  const base = join(dir, "goals", "g1", "files");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "seed.txt"), "seed\n"); writeFileSync(join(base, "LEDGER.md"), "# ledger\n"); mkdirSync(join(base, ".agent-room-x")); writeFileSync(join(base, ".agent-room-x", "p"), "p");
  const goal = { id: "g1", folder: base };
  const a = await ws.open(goal, { id: "t1" }, "claude");
  assert.equal(a.kind, "git"); assert.equal(a.reused, false);
  assert.ok(existsSync(join(a.path, "seed.txt")) && !existsSync(join(a.path, "LEDGER.md")), "ledger and .agent-room* stay in the base");
  assert.equal(git(base, "log", "--format=%an|%ae", "-1"), "Agent Room|hub@agent-room.local");
  writeFileSync(join(a.path, "wip.txt"), "in progress\n");
  const again = await ws.open(goal, { id: "t1" }, "claude");
  assert.equal(again.reused, true); assert.equal(again.path, a.path);
  assert.ok(existsSync(join(a.path, "wip.txt")), "a revision keeps its work in progress");
  const other = await ws.open(goal, { id: "t1" }, "codex");
  assert.equal(other.reused, false);
  assert.ok(!existsSync(join(other.path, "wip.txt")), "a reassignment starts clean");
  assert.equal(ws.find("g1", "t1")?.agentId, "codex");
  await ws.discard(goal, "t1"); await ws.discard(goal, "t1");
  assert.equal(ws.find("g1", "t1"), undefined);
  assert.ok(!existsSync(other.path));
  assert.equal(git(base, "branch", "--list", "--format=%(refname:short)", "ar/*"), "");
  assert.deepEqual(await ws.accept(goal, { id: "t1" }), { ok: true, merged: [], how: "empty" }, "accepting nothing is a no-op");
});

test("TaskWorkspaces: a conflict leaves the base untouched, marks the worktree, and refuses to merge until the markers are resolved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const ws = new TaskWorkspaces({ dataDir: dir });
  const base = join(dir, "g", "files");
  mkdirSync(base, { recursive: true }); writeFileSync(join(base, "f.txt"), "one\ntwo\nthree\n"); writeFileSync(join(base, "other.txt"), "x\n");
  const goal = { id: "g", folder: base };
  const a = await ws.open(goal, { id: "a" }, "claude"), b = await ws.open(goal, { id: "b" }, "codex");
  writeFileSync(join(a.path, "f.txt"), "ONE\ntwo\nthree\n");
  writeFileSync(join(b.path, "f.txt"), "uno\ntwo\nthree\n"); writeFileSync(join(b.path, "new.txt"), "b only\n");
  const ra = await ws.accept(goal, { id: "a", title: "A" });
  assert.deepEqual(ra, { ok: true, merged: ["f.txt"], how: "fast-forward" });
  const head = git(base, "rev-parse", "HEAD");
  const rb = await ws.accept(goal, { id: "b", title: "B" });
  assert.deepEqual(rb, { ok: false, conflict: ["f.txt"] });
  assert.equal(git(base, "rev-parse", "HEAD"), head, "the base did not move");
  assert.equal(git(base, "status", "--porcelain"), "", "and is clean (merge aborted)");
  assert.equal(read(base, "f.txt"), "ONE\ntwo\nthree\n", "the first task's change was not overwritten");
  assert.ok(!existsSync(join(base, "new.txt")));
  assert.match(read(b.path, "f.txt"), /^<<<<<<< /m, "the worktree holds the latest base with markers");
  assert.equal(read(b.path, "new.txt"), "b only\n", "the agent's own other work is untouched");
  assert.deepEqual(await ws.accept(goal, { id: "b" }), { ok: false, conflict: ["f.txt"], markers: true }, "unresolved markers never merge");
  writeFileSync(join(b.path, "f.txt"), "ONE\nuno\ntwo\nthree\n");
  const done = await ws.accept(goal, { id: "b", title: "B" });
  assert.equal(done.ok, true);
  assert.equal(read(base, "f.txt"), "ONE\nuno\ntwo\nthree\n");
  assert.equal(read(base, "new.txt"), "b only\n");
  assert.equal(git(base, "status", "--porcelain"), "");
});

test("TaskWorkspaces: copy kind only copies back files the base has not changed since the copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const ws = new TaskWorkspaces({ dataDir: dir, git: "/bin/false" });
  const base = join(dir, "g", "files");
  mkdirSync(base, { recursive: true }); writeFileSync(join(base, "f.txt"), "one\n"); writeFileSync(join(base, "keep.txt"), "keep\n"); writeFileSync(join(base, "gone.txt"), "bye\n");
  const goal = { id: "g", folder: base };
  const a = await ws.open(goal, { id: "a" }, "claude"), b = await ws.open(goal, { id: "b" }, "codex");
  assert.equal(a.kind, "copy");
  writeFileSync(join(a.path, "f.txt"), "from a\n"); writeFileSync(join(a.path, "sub.txt"), "a\n");
  writeFileSync(join(b.path, "f.txt"), "from b\n"); writeFileSync(join(b.path, "gone.txt"), "edited\n"); writeFileSync(join(b.path, "bonly.txt"), "b\n");
  const ra = await ws.accept(goal, { id: "a" });
  assert.equal(ra.ok, true);
  const rb = await ws.accept(goal, { id: "b" });
  assert.deepEqual(rb, { ok: false, conflict: ["f.txt"] });
  assert.equal(read(base, "f.txt"), "from a\n"); assert.ok(!existsSync(join(base, "bonly.txt")), "all or nothing: nothing of b landed");
  assert.equal(read(b.path, "sub.txt"), "a\n", "the copy was refreshed with the base's newer files");
  assert.match(read(b.path, "f.txt"), /<<<<<<< yours\nfrom b\n=======\nfrom a\n>>>>>>> accepted work/);
  assert.deepEqual(await ws.accept(goal, { id: "b" }), { ok: false, conflict: ["f.txt"], markers: true });
  writeFileSync(join(b.path, "f.txt"), "from a and b\n");
  const done = await ws.accept(goal, { id: "b" });
  assert.equal(done.ok, true);
  assert.equal(read(base, "f.txt"), "from a and b\n"); assert.equal(read(base, "gone.txt"), "edited\n"); assert.equal(read(base, "bonly.txt"), "b\n");
  await ws.discard(goal, "a"); await ws.discard(goal, "b");
  assert.ok(!existsSync(a.path) && !existsSync(b.path));
});

test("TaskWorkspaces: prune removes worktrees of tasks that are no longer open, keeps open ones, and git forgets them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const ws = new TaskWorkspaces({ dataDir: dir });
  const base = join(dir, "g", "files"); mkdirSync(base, { recursive: true }); writeFileSync(join(base, "s.txt"), "s\n");
  const goal = { id: "g", folder: base };
  const open = await ws.open(goal, { id: "open" }, "claude"), stale = await ws.open(goal, { id: "stale" }, "claude");
  mkdirSync(join(dir, "worktrees", "g", "orphan")); // a directory nobody knows
  const removed = await ws.prune((_g, t) => t === "open");
  assert.deepEqual(removed.sort(), ["orphan", "stale"]);
  assert.ok(existsSync(open.path) && !existsSync(stale.path));
  assert.equal(git(base, "branch", "--list", "--format=%(refname:short)", "ar/*").replace(/\s+/g, ""), "ar/open");
  assert.ok(!git(base, "worktree", "list", "--porcelain").includes("stale"));
  await ws.prune(() => false);
  assert.ok(!existsSync(join(dir, "worktrees", "g")));
  assert.equal(git(base, "branch", "--list", "--format=%(refname:short)", "ar/*"), "");
});

test("hooks: beforeRun and beforeMerge wrap the agent run, and what the hub adds never reaches the base", async () => {
  const e = setup();
  const log: string[] = [];
  e.orch.workspaceHooks = {
    beforeRun: (c) => { log.push(`run:${c.agentId}:${c.kind}`); writeFileSync(join(c.path, "CLAUDE.md"), "# context\n"); assert.equal(e.orch.taskWorktree({ goalId: c.goalId, id: c.taskId }), c.path); },
    beforeMerge: (c) => { log.push(`merge:${c.agentId}`); assert.ok(existsSync(join(c.path, "CLAUDE.md"))); unlinkSync(join(c.path, "CLAUDE.md")); },
  };
  const s = seedGoal(e, [{ key: "a", owner: "claude", files: ["a.txt"] }]);
  const g = await settle(e, s.goalId);
  assert.equal(g.status, "done");
  assert.deepEqual(log, ["run:claude:git", "merge:claude"]);
  assert.ok(existsSync(join(s.base, "a.txt")));
  assert.ok(!existsSync(join(s.base, "CLAUDE.md")), "the context file was not merged into the base");
  assert.ok(!git(s.base, "ls-files").includes("CLAUDE.md"));
  // a failing hook is logged, never fatal
  const f = setup();
  f.orch.workspaceHooks = { beforeRun: () => { throw new Error("boom"); } };
  const t = seedGoal(f, [{ key: "a", owner: "claude", files: ["a.txt"] }]);
  assert.equal((await settle(f, t.goalId)).status, "done");
  assert.ok(f.store.listAudit().some((x) => x.action === "worktree.hook"), "the failure is audited");
});

test("resume: a task that was mid-run when the hub stopped continues in its existing worktree", async () => {
  const e = setup();
  agent(e, "claude", { delayMs: 300 });
  const s = seedGoal(e, [{ key: "a", owner: "claude", files: ["a.txt"] }]);
  MockAdapter.calls.length = 0;
  void e.orch.advance(s.goalId);
  await until(() => !!e.orch.taskWorktree(s.tasks[0]) && e.store.getTask(s.tasks[0].id)!.status === "running");
  const before = e.orch.taskWorktree(s.tasks[0])!;
  await until(() => taskCalls().length === 1);
  writeFileSync(join(before, "draft.txt"), "work in progress\n");
  (e.orch as unknown as { running: Map<string, AbortController> }).running.forEach((c) => c.abort());
  await new Promise((r) => setTimeout(r, 50));
  e.store.saveTask({ ...e.store.getTask(s.tasks[0].id)!, status: "running" }); // what the DB holds after a crash
  const next = new Orchestrator(e.store, new Approvals(e.store, 2000), { dataDir: e.dir, mcpUrl: () => undefined, rand: () => 0.99, retryDelayMs: 1 });
  assert.deepEqual(await next.pruneWorktrees(), [], "an open task's worktree survives the start-up prune");
  assert.equal(next.taskWorktree(s.tasks[0]), before, "the new hub finds it");
  next.recover();
  await until(() => e.store.getGoal(s.goalId)!.status === "done", 8000);
  await next.idle();
  assert.equal(e.store.getGoal(s.goalId)!.status, "done");
  assert.equal(taskCalls().at(-1)!.cwd, before, "resumed in the same worktree");
  assert.equal(read(s.base, "draft.txt"), "work in progress\n", "work saved before the restart is kept");
  assert.ok(!existsSync(before));
});
