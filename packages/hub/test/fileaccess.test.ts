import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Approval, WriteProposal } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { ClaudeCodeAdapter } from "../src/adapters/claudeCode.js";
import { codexBaseArgs } from "../src/adapters/codex.js";
import { CommandAdapter } from "../src/adapters/command.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { FileBroker } from "../src/files/broker.js";
import { checkFileToolRequest } from "../src/files/confine.js";
import { GrantRefused } from "../src/files/paths.js";
import { McpTokens, hashToken } from "../src/mcp/tokens.js";
import { TaskWorkspaces, copyGrantedTree } from "../src/orchestrator/worktree.js";
import { setup } from "./helpers.js";

type Env = ReturnType<typeof setup>;
const dir = (p = "fa-") => realpathSync(mkdtempSync(join(tmpdir(), p)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) { for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20); assert.ok(fn(), "timed out waiting"); }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const audit = (store: Env["store"]) => store.listAudit(5000);
const count = (store: Env["store"], action: string) => audit(store).filter((a) => a.action === action).length;

/** A repository the owner is working in: one commit on main. */
function ownerRepo() {
  const d = dir("repo-");
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "README.md"), "# mine\n");
  git(d, "-c", "user.name=Owner", "-c", "user.email=o@example.com", "add", "-A");
  git(d, "-c", "user.name=Owner", "-c", "user.email=o@example.com", "commit", "-q", "-m", "init");
  return d;
}
/** Settings that let the mock planner plan two tasks with files (research.md then summary.md), and no plan approval. */
function goalSettings(e: Env) {
  for (const a of e.store.listAgents()) { const x = e.store.getAgent(a.id)!; Object.assign(x.settings, { checks: true }); e.store.saveAgent(x); }
  e.store.setSettings({ ...e.store.getSettings(), planApproval: "never", autoRunChecks: true });
}
const planCalls = () => MockAdapter.calls.filter((c) => c.kind === "PLAN");
const taskCalls = () => MockAdapter.calls.filter((c) => c.kind === "TASK");
const taskProposals = (e: Env) => e.orch.files.proposals().filter((p) => p.kind === "task").sort((a, b) => a.createdAt - b.createdAt);
const approvalFor = (e: Env, p: WriteProposal): Approval => e.store.listApprovals().find((a) => a.proposalId === p.id)!;

// ============================================================ goals on a granted folder

test("AC2/AC4: a goal on a granted git repo lands accepted work of two tasks on agent-room/<goal>; the owner's branch and working tree are untouched", async () => {
  const e = setup(); goalSettings(e);
  const repo = ownerRepo();
  const grant = e.orch.files.addGrant({ path: repo, label: "my-repo", agentId: "*", read: true, write: true });
  const head = git(repo, "rev-parse", "HEAD");
  MockAdapter.calls.length = 0;

  const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market", { folderGrantId: grant.id });
  await e.orch.idle();
  const done = e.store.getGoal(goal.id)!;
  assert.equal(done.status, "done");
  assert.equal(done.sourceGrantId, grant.id);
  const branch = `agent-room/${goal.id}`;
  assert.equal(done.sourceBranch, branch);

  // both tasks' accepted work is on the goal branch
  assert.match(git(repo, "show", `${branch}:research.md`), /wrote research\.md/);
  assert.match(git(repo, "show", `${branch}:summary.md`), /wrote summary\.md/);
  assert.equal(git(repo, "show", `${branch}:README.md`), "# mine", "the branch starts from the owner's commit");
  git(repo, "merge-base", "--is-ancestor", head, branch);

  // the owner's checkout never moved
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "status", "--porcelain"), "", "no file appeared, changed or got staged in the owner's tree");
  assert.ok(!existsSync(join(repo, "research.md")) && !existsSync(join(repo, "summary.md")));
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# mine\n");
  assert.equal(git(repo, "rev-parse", "main"), head);
  // nothing else is left in the owner's repo: no task branches, no extra worktrees
  assert.equal(git(repo, "branch", "--list", "ar/*"), "");
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);

  // the tasks worked in the hub's own worktrees, never in the owner's folder, and were told about the folder (label, not location)
  for (const c of taskCalls()) { assert.ok(!c.cwd.startsWith(repo)); assert.ok(c.prompt.includes('"my-repo"') && c.prompt.includes("read and write")); assert.ok(!c.prompt.includes(repo)); }
  const plan = planCalls();
  assert.ok(plan.length && plan.every((c) => c.prompt.includes('"my-repo"') && c.prompt.includes("read and write") && !c.prompt.includes(repo)));
  assert.equal(count(e.store, "goal.source.merged"), 2);
});

test("AC4: a goal on a granted non-git folder writes nothing until the owner approves each task's proposal; a rejection leaves the folder untouched", async () => {
  const e = setup(); goalSettings(e);
  const folder = dir("plain-");
  writeFileSync(join(folder, "old.txt"), "old\n");
  const grant = e.orch.files.addGrant({ path: folder, label: "notes", agentId: "*", read: true, write: true });
  MockAdapter.calls.length = 0;

  const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market", { folderGrantId: grant.id });
  await e.orch.idle();
  assert.equal(e.store.getGoal(goal.id)!.status, "done");
  assert.deepEqual(readdirSyncSorted(folder), ["old.txt"], "the real folder is untouched until the owner approves");
  assert.ok(taskCalls().every((c) => !c.cwd.startsWith(folder)));

  // one proposal per accepted task, each listing every file it changed, each with its approval card and proposalId
  const ps = taskProposals(e);
  assert.equal(ps.length, 2);
  assert.deepEqual(ps.map((p) => p.files!.map((f) => f.relPath)), [["research.md"], ["summary.md"]]);
  for (const p of ps) {
    assert.equal(p.goalId, goal.id); assert.equal(p.status, "pending"); assert.equal(p.grantId, grant.id);
    assert.equal(approvalFor(e, p).status, "pending"); assert.equal(approvalFor(e, p).tool, "filesystem");
    assert.match(p.diff, /\+\+\+ b\//); assert.match(p.diff, /wrote /);
  }

  // approve the first, reject the second
  e.approvals.decide(approvalFor(e, ps[0]).id, "approved");
  e.approvals.decide(approvalFor(e, ps[1]).id, "rejected");
  await until(() => e.orch.files.proposal(ps[0].id)!.status === "applied" && e.orch.files.proposal(ps[1].id)!.status === "rejected");
  assert.match(readFileSync(join(folder, "research.md"), "utf8"), /wrote research\.md/);
  assert.ok(!existsSync(join(folder, "summary.md")), "a rejected proposal leaves the folder untouched");
  assert.equal(readFileSync(join(folder, "old.txt"), "utf8"), "old\n");
  assert.equal(count(e.store, "file.write.applied"), 1);
  assert.equal(count(e.store, "file.write.rejected"), 1);
});

test("a non-git proposal conflicts, and writes nothing, when the owner changed the file meanwhile", async () => {
  const e = setup(); goalSettings(e);
  const folder = dir("plain-");
  const grant = e.orch.files.addGrant({ path: folder, agentId: "*", read: true, write: true });
  const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market", { folderGrantId: grant.id });
  await e.orch.idle();
  const [first] = taskProposals(e);
  assert.ok(first && goal.id);
  writeFileSync(join(folder, "research.md"), "the owner wrote this first\n");
  e.approvals.decide(approvalFor(e, first).id, "approved");
  await until(() => e.orch.files.proposal(first.id)!.status !== "pending");
  assert.equal(e.orch.files.proposal(first.id)!.status, "conflict");
  assert.equal(readFileSync(join(folder, "research.md"), "utf8"), "the owner wrote this first\n");
});

test("a read-only grant: tasks read the folder but nothing is ever written back", async () => {
  const e = setup(); goalSettings(e);
  const folder = dir("plain-"); writeFileSync(join(folder, "data.txt"), "numbers\n");
  const repo = ownerRepo();
  for (const [path, label] of [[folder, "data"], [repo, "repo"]] as const) {
    const grant = e.orch.files.addGrant({ path, label, agentId: "*", read: true, write: false });
    MockAdapter.calls.length = 0;
    const goal = await e.orch.runGoal(e.room.id, "Summarize the venue TV market", { folderGrantId: grant.id });
    await e.orch.idle();
    assert.equal(e.store.getGoal(goal.id)!.status, "done", label);
    assert.ok(taskCalls().length >= 2 && taskCalls().every((c) => c.prompt.includes("read only") && c.prompt.includes("Nothing is ever written back")), label);
    assert.equal(taskProposals(e).filter((p) => p.goalId === goal.id).length, 0, `${label}: no write proposals`);
  }
  assert.deepEqual(readdirSyncSorted(folder), ["data.txt"]);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(git(repo, "branch", "--list", "agent-room/*"), "", "a read-only grant doesn't even make a branch");
  assert.equal(git(repo, "branch", "--list", "ar/*"), "");
  assert.equal(e.store.listApprovals("pending").length, 0);
});

test("the owner can point a goal at a folder, or an agent-only grant is refused up front", async () => {
  const b = await boot();
  const folder = dir("plain-");
  const mine = b.orch.files.addGrant({ path: folder, agentId: "claude", read: true, write: true });
  const all = b.orch.files.addGrant({ path: dir("plain-"), agentId: "*", read: true, write: true });
  const otherRoom = b.store.createRoom("elsewhere");
  const scoped = b.orch.files.addGrant({ path: dir("plain-"), agentId: "*", roomId: otherRoom.id, read: true, write: true });
  const send = (folderGrantId: string) => fetch(`${b.base}/rooms/${b.room.id}/messages`, { method: "POST", headers: b.auth, body: JSON.stringify({ text: "hello there", folderGrantId }) });
  for (const [g, why] of [[mine.id, /one agent only/], [scoped.id, /different room/], ["grant_nope", /doesn't exist/]] as const) {
    const r = await send(g);
    assert.equal(r.status, 400); assert.match(((await r.json()) as { error: string }).error, why);
  }
  assert.equal((await send(all.id)).status, 200);
  await b.orch.idle();

  // POST /goals/:id/folder-grant: only before work starts
  b.store.saveGoal({ id: "goal_done", roomId: b.room.id, text: "x", status: "done", createdAt: Date.now() });
  const set = (grantId: string | null) => fetch(`${b.base}/goals/goal_done/folder-grant`, { method: "POST", headers: b.auth, body: JSON.stringify({ grantId }) });
  assert.equal((await set(all.id)).status, 409, "a finished goal can't be re-pointed");
  assert.equal((await fetch(`${b.base}/goals/nope/folder-grant`, { method: "POST", headers: b.auth, body: JSON.stringify({ grantId: null }) })).status, 404);
  const planning = { id: "goal_x", roomId: b.room.id, text: "x", status: "planning" as const, createdAt: Date.now() };
  b.store.saveGoal(planning);
  const r = await fetch(`${b.base}/goals/goal_x/folder-grant`, { method: "POST", headers: b.auth, body: JSON.stringify({ grantId: all.id }) });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { sourceGrantId: string }).sourceGrantId, all.id);
  assert.equal(count(b.store, "goal.source.set"), 1);
  await b.app.close();
});

function readdirSyncSorted(d: string) { return readdirSync(d).sort(); }

test("copying a granted folder into a private base skips links, and never reads through them", () => {
  const src = dir("src-"), outside = dir("outside-"), dst = join(dir("dst-"), "copy");
  writeFileSync(join(outside, "secret.txt"), "SECRET");
  mkdirSync(join(src, "sub")); writeFileSync(join(src, "sub", "a.txt"), "a"); writeFileSync(join(src, "b.txt"), "b");
  symlinkSync(join(outside, "secret.txt"), join(src, "link.txt")); symlinkSync(outside, join(src, "sub", "linkdir"));
  const r = copyGrantedTree(src, dst);
  assert.equal(r.files, 2); assert.equal(r.skippedLinks, 2);
  assert.deepEqual(readdirSyncSorted(dst), ["b.txt", "sub"]);
  assert.deepEqual(readdirSyncSorted(join(dst, "sub")), ["a.txt"]);
});

test("AC2: an agent that swaps its work folder's .git for a repository of its own cannot make the hub run the config it wrote", async () => {
  const data = dir("data-"), folder = dir("goal-");
  writeFileSync(join(folder, "seed.txt"), "seed\n");
  const ws = new TaskWorkspaces({ dataDir: data });
  const goal = { id: "goal_p", folder };
  const w = await ws.open(goal, { id: "task_p" }, "claude");
  assert.equal(w.kind, "git");
  const marker = join(data, "RAN-THE-AGENTS-COMMAND");
  const pointer = readFileSync(join(w.path, ".git"), "utf8");
  rmSync(join(w.path, ".git"));
  mkdirSync(join(w.path, ".git"));
  writeFileSync(join(w.path, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch ${marker}\n`);
  writeFileSync(join(w.path, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(w.path, "work.txt"), "work\n");
  const r = await ws.accept(goal, { id: "task_p", title: "T" });
  assert.ok(r.ok && r.merged.includes("work.txt"), JSON.stringify(r));
  assert.ok(!existsSync(marker), "the agent's config never ran");
  assert.equal(readFileSync(join(w.path, ".git"), "utf8"), pointer, "the pointer is back as git wrote it");
  assert.equal(readFileSync(join(folder, "work.txt"), "utf8"), "work\n", "and the work still merged");
  await ws.cleanup(goal, ["task_p"]);
});

// ============================================================ confinement

test("AC2: Claude Code argv confines the run to its worktree: cwd, one --add-dir, no settings files, deny rules, scoped allow rules, sandbox on", () => {
  const e = setup();
  const wt = dir("task-"), data = dir("data-");
  const agent = e.store.getAgent("claude")!;
  const args = new ClaudeCodeAdapter().buildArgs({ agent, prompt: "do it", cwd: wt, dataDir: data, mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" } });
  const at = (flag: string) => args.flatMap((a, i) => (a === flag ? [i] : []));
  assert.deepEqual(at("--add-dir").map((i) => args[i + 1]), [wt], "the worktree is the only extra directory");
  assert.equal(args[at("--setting-sources")[0] + 1], "", "no user, project or local settings files");
  const settings = JSON.parse(args[at("--settings")[0] + 1]) as { permissions: { blockReadsOutsideWorkingDirectories: boolean; additionalDirectories: string[]; deny: string[] }; sandbox: Record<string, unknown> & { filesystem: { denyRead: string[] } } };
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.deepEqual(settings.permissions.additionalDirectories, []);
  const home = process.env.HOME ?? "/root";
  for (const secret of [".ssh", ".aws", ".gnupg", ".config", ".claude", "Library"]) assert.ok(settings.permissions.deny.includes(`Read(//${`${home}/${secret}`.replace(/^\//, "")}/**)`), secret);
  assert.ok(settings.permissions.deny.includes(`Read(//${data.replace(/^\//, "")}/*.db)`), "the hub database");
  assert.ok(settings.permissions.deny.includes(`Read(//${data.replace(/^\//, "")}/goals/**)`) && settings.permissions.deny.includes(`Read(//${data.replace(/^\//, "")}/workspaces/**)`));
  assert.equal(settings.sandbox.enabled, true); assert.equal(settings.sandbox.failIfUnavailable, true); assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  // Bash reads are an allow-list (docs: sandbox.filesystem.denyRead + narrower allowRead): the hub's whole data folder and the owner's home are
  // denied, and only this task's worktree (plus toolchains) is re-opened. So every sibling goal and task is denied, including ones made later.
  const fsr = settings.sandbox.filesystem as unknown as { denyRead: string[]; allowRead: string[] };
  assert.ok(fsr.denyRead.includes(data) && fsr.denyRead.includes(home), "the data folder and the home folder are denied as a whole");
  assert.ok(fsr.allowRead.includes(wt), "the task's own worktree is the one thing re-opened inside them");
  assert.ok(!fsr.allowRead.some((a) => a === data || a === home), "nothing wide is re-opened");
  assert.ok(fsr.denyRead.includes(`${home}/.ssh`) && fsr.denyRead.includes(`${home}/.npmrc`));

  // allow rules name the worktree; a bare Read/Write/Edit/Glob/Grep would allow every path
  const i = at("--allowedTools")[0];
  const allowed: string[] = [];
  for (let k = i + 1; k < args.length && !args[k].startsWith("--"); k++) allowed.push(args[k]);
  for (const bare of ["Read", "Write", "Edit", "Glob", "Grep", "LS", "MultiEdit"]) assert.ok(!allowed.includes(bare), `bare ${bare}`);
  assert.ok(allowed.includes(`Read(//${wt.replace(/^\//, "")}/**)`) && allowed.includes(`Edit(//${wt.replace(/^\//, "")}/**)`), allowed.join(" "));
  assert.ok(allowed.includes("mcp__agent-room"));
  assert.ok(!args.includes("--dangerously-skip-permissions") && !args.includes("--permission-mode"));

  // the owner can switch the Bash sandbox off per agent if their Claude Code can't sandbox; the file rules stay
  const noBox = { ...agent, settings: { ...agent.settings, bashSandbox: false } };
  const a2 = new ClaudeCodeAdapter().buildArgs({ agent: noBox, prompt: "x", cwd: wt, dataDir: data });
  const s2 = JSON.parse(a2[a2.indexOf("--settings") + 1]) as { permissions: { blockReadsOutsideWorkingDirectories: boolean }; sandbox?: unknown };
  assert.equal(s2.sandbox, undefined); assert.equal(s2.permissions.blockReadsOutsideWorkingDirectories, true);
});

test("AC2: Codex runs with -C <worktree>, workspace-write and no extra writable roots; planning calls are read-only", () => {
  const e = setup();
  const wt = dir("task-");
  const seeded = e.store.getAgent("codex")!;
  const agent = { ...seeded, tools: { ...seeded.tools, filesystem: true } };
  const args = codexBaseArgs({ agent, cwd: wt }, "/tmp/out.txt");
  assert.equal(args[args.indexOf("-C") + 1], wt);
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(args.includes("sandbox_workspace_write.writable_roots=[]") && args.includes("sandbox_workspace_write.exclude_slash_tmp=true") && args.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true"));
  assert.ok(!args.includes("--add-dir") && !args.includes("--dangerously-bypass-approvals-and-sandbox") && !args.includes("danger-full-access"));
  assert.ok(!args.some((a) => a.includes(wt) && a !== wt), "the worktree is named once, as the working root");
  const ro = codexBaseArgs({ agent, cwd: wt, jsonOnly: true }, "/tmp/out.txt");
  assert.equal(ro[ro.indexOf("--sandbox") + 1], "read-only");
  assert.ok(!ro.includes("sandbox_workspace_write.writable_roots=[]"));
});

test("AC2: a command adapter gets the worktree as its cwd and nothing about any granted folder", async () => {
  const e = setup();
  const wt = dir("task-");
  const agent = { ...e.store.getAgent("claude")!, adapter: "command" as const, settings: { command: "pwd", args: [] as string[] } };
  const r = await new CommandAdapter().run({ agent, prompt: "x", cwd: wt, mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" } });
  assert.ok(r.ok, r.error);
  assert.equal(realpathSync(r.text.trim()), wt);
});

test("AC2: the hub refuses a file tool aimed outside the task folder, whatever the owner's approval settings are", () => {
  const wt = dir("task-"), outside = dir("outside-");
  writeFileSync(join(outside, "secret.txt"), "s"); writeFileSync(join(wt, "ok.txt"), "ok");
  symlinkSync(outside, join(wt, "link"));
  const home = dir("home-");
  const ask = (tool: string, input: Record<string, unknown>) => checkFileToolRequest(tool, input, wt, home);
  assert.deepEqual(ask("Read", { file_path: join(wt, "ok.txt") }), { allow: true });
  assert.deepEqual(ask("Write", { file_path: "new/sub.txt" }), { allow: true }, "a relative path is the worktree's");
  for (const [tool, input] of [
    ["Read", { file_path: join(outside, "secret.txt") }], ["Read", { file_path: "../secret.txt" }], ["Edit", { file_path: "/etc/passwd" }],
    ["Write", { file_path: join(home, ".ssh", "id_rsa") }], ["Read", { file_path: "~/.ssh/id_rsa" }], ["Read", { file_path: join(wt, "link", "secret.txt") }],
    ["Grep", { pattern: "/etc/passwd" }], ["Glob", { pattern: "../**" }], ["Read", {}],
  ] as [string, Record<string, unknown>][]) assert.equal(ask(tool, input).allow, false, `${tool} ${JSON.stringify(input)}`);
  assert.deepEqual(ask("Bash", { command: "ls /" }), { allow: true }, "not a file tool: the sandbox and the owner's approval decide");
});

// ============================================================ ungrantable folders

test("ungrantable folders are refused; protected ones are allowed only with force and a reason, and that is audited", () => {
  const e = setup();
  const home = dir("home-"), control = dir("control-");
  for (const d of [".ssh", ".config", ".aws", ".hidden-tool", "Library", "Documents"]) mkdirSync(join(home, d));
  mkdirSync(join(home, "Library", "Application Support"), { recursive: true });
  mkdirSync(join(home, "Documents", "work")); mkdirSync(join(control, ".git"));
  const broker = new FileBroker(e.store, e.approvals, { home, extraProtected: () => [{ path: join(control, ".git"), because: "the control folder's version history" }] });
  // the system folders that exist on this machine (a Mac has /System, /Library, /Applications; Linux has /etc, /usr, /bin...)
  const systemDirs = ["/System", "/Library", "/Applications", "/private", "/etc", "/usr", "/usr/bin", "/bin", "/sbin", "/var", "/lib", "/proc", "/sys"].filter((p) => existsSync(p));
  assert.ok(systemDirs.length >= 3);
  const protectedPaths = [join(home, ".ssh"), join(home, ".config"), join(home, ".aws"), join(home, ".hidden-tool"), join(home, "Library"), join(home, "Library", "Application Support"), join(control, ".git"), ...systemDirs];
  for (const p of protectedPaths) {
    const c = broker.checkFolder(p);
    assert.ok(c.ok && c.protected && c.because, `${p} is protected`);
    assert.throws(() => broker.addGrant({ path: p, agentId: "claude", read: true, write: false }), (x: unknown) => x instanceof GrantRefused && x.canForce === true, p);
  }
  assert.ok(broker.checkFolder(join(home, "Documents", "work")).ok && !(broker.checkFolder(join(home, "Documents", "work")) as { protected: boolean }).protected, "an ordinary folder is fine");
  assert.equal(broker.listGrants().length, 0);

  // never allowed, even with force: /, the home folder and the folders that contain it, and things that aren't folders
  for (const p of ["/", home, join(home, ".."), "relative", join(home, "missing"), join(home, "Documents", "work", "nope")]) {
    assert.throws(() => broker.addGrant({ path: p, agentId: "claude", read: true, write: false, force: true, reason: "I really want this one" }), (x: unknown) => x instanceof GrantRefused && x.canForce === false, p);
  }
  // force without a real reason is refused
  for (const reason of [undefined, "", "because", "   short  "]) assert.throws(() => broker.addGrant({ path: join(home, ".config"), agentId: "claude", read: true, write: false, force: true, reason }), GrantRefused);
  assert.equal(count(e.store, "grant.override"), 0);

  // with force and a reason it works and the reason is on the grant and in the audit log
  const g = broker.addGrant({ path: join(home, ".config"), agentId: "claude", read: true, write: false, force: true, reason: "my dotfiles repo lives here" });
  assert.equal(g.override?.reason, "my dotfiles repo lives here");
  assert.match(g.override!.because, /\.config/);
  const ov = audit(e.store).filter((a) => a.action === "grant.override");
  assert.equal(ov.length, 1); assert.match(ov[0].detail, /my dotfiles repo lives here/); assert.equal(ov[0].actor, "owner");
  assert.equal(count(e.store, "grant.added"), 1);

  // the hub's data folder is protected too (the broker learns it from the database path)
  const real = e.orch.files.checkFolder(e.dir);
  assert.ok(real.ok && real.protected && /data folder/.test(real.because!), "the hub's own data folder");
  const worktrees = join(e.dir, "workspaces"); mkdirSync(worktrees, { recursive: true });
  assert.ok((e.orch.files.checkFolder(worktrees) as { protected: boolean }).protected);
});

// ============================================================ the write-only oracle

test("a write-only grant never reveals whether a path exists, what it is, or whether content is identical", () => {
  const e = setup();
  const root = dir("wo-"), outside = dir("outside-");
  writeFileSync(join(outside, "target.txt"), "outside\n");
  writeFileSync(join(root, "exists.txt"), "different\n");
  writeFileSync(join(root, "same.txt"), "new\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0xff]));
  writeFileSync(join(root, "badutf8.txt"), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  mkdirSync(join(root, "adir")); symlinkSync(join(outside, "target.txt"), join(root, "link.txt"));
  const grant = e.orch.files.addGrant({ path: root, agentId: "claude", read: false, write: true });
  const files = e.orch.files;

  // every target, whatever it is, accepts the same proposal with the same answer to the agent
  const names = ["missing.txt", "exists.txt", "same.txt", "bin.dat", "badutf8.txt", "adir", "link.txt"];
  const views = names.map((n) => {
    const r = files.proposeWrite("claude", undefined, n, "new\n", grant.id);
    assert.ok(r.ok, `${n}: ${r.ok ? "" : r.reason}`); if (!r.ok) throw new Error();
    const v = files.proposalFor("claude", r.proposal.id)!;
    return { n, id: r.proposal.id, v, shape: { ...v, id: "", relPath: "", createdAt: 0 } };
  });
  for (const x of views) {
    assert.deepEqual(x.shape, views[0].shape, `${x.n} looks like ${views[0].n}`);
    assert.equal(x.v.baseSha256, null); assert.match(x.v.diff, /withheld/);
    assert.equal(x.v.relPath, x.n, "the agent sees its own spelling of the path");
  }
  // the owner sees the truth: which of them cannot be applied, and why
  const owner = Object.fromEntries(views.map((x) => [x.n, files.proposal(x.id)!]));
  for (const n of ["same.txt", "bin.dat", "badutf8.txt", "adir", "link.txt"]) assert.ok(owner[n].unappliable, `${n} is flagged for the owner`);
  assert.ok(!owner["missing.txt"].unappliable && !owner["exists.txt"].unappliable);
  assert.ok(approvalDetail(e, owner["bin.dat"]).includes("CANNOT BE APPLIED"));

  // after the owner decides, every outcome that is not "applied" reads the same to the agent
  const decide = async (x: { n: string; id: string }, status: "approved" | "rejected") => { e.approvals.decide(approvalFor(e, owner[x.n]).id, status); await until(() => files.proposal(x.id)!.status !== "pending"); };
  return (async () => {
    // The owner approves every one that cannot be applied and rejects the two ordinary ones; plus one that goes stale (a conflict).
    for (const x of views) await decide(x, x.n === "missing.txt" || x.n === "exists.txt" ? "rejected" : "approved");
    writeFileSync(join(root, "stale.txt"), "v1\n");
    const stale = files.proposeWrite("claude", undefined, "stale.txt", "new\n", grant.id);
    assert.ok(stale.ok); if (!stale.ok) return;
    writeFileSync(join(root, "stale.txt"), "changed by someone else\n");
    owner["stale.txt"] = files.proposal(stale.proposal.id)!;
    await decide({ n: "stale.txt", id: stale.proposal.id }, "approved");
    assert.equal(files.proposal(stale.proposal.id)!.status, "conflict", "the owner's own view says why");
    // To the agent: owner said no, cannot be applied, and conflict all read exactly alike.
    const settled = [...views.map((x) => x.id), stale.proposal.id].map((pid) => ({ ...files.proposalFor("claude", pid)!, id: "", relPath: "", createdAt: 0, decidedAt: 0 }));
    for (const s of settled) assert.deepEqual(s, settled[0]);
    assert.equal(settled[0].status, "rejected");
    assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "outside\n", "nothing was written through the link");
    assert.equal(readFileSync(join(root, "bin.dat")).length, 4);
    assert.equal(readFileSync(join(root, "same.txt"), "utf8"), "new\n");
    assert.equal(readFileSync(join(root, "exists.txt"), "utf8"), "different\n");
    assert.equal(readFileSync(join(root, "stale.txt"), "utf8"), "changed by someone else\n");

    // the same wall around reading and listing: no answer depends on what is there
    const reasons = new Set(["missing.txt", "exists.txt", "adir", "link.txt", "bin.dat"].map((n) => { const r = files.read("claude", undefined, n, grant.id); return r.ok ? "ok" : r.reason; }));
    assert.equal(reasons.size, 1, [...reasons].join(" | "));
    const lists = new Set([".", "adir", "missing"].map((n) => { const r = files.list("claude", undefined, n, grant.id); return r.ok ? "ok" : r.reason; }));
    assert.equal(lists.size, 1, [...lists].join(" | "));
    // path refusals on a write-only grant don't say whether the path is a link, a git folder or missing
    const refusals = new Set(["link.txt/x", "link.txt/../x", ".git/config", "adir/.git/x", "missing/.git/y"].map((n) => { const r = files.proposeWrite("claude", undefined, n, "x", grant.id); return r.ok ? "ok" : r.reason; }));
    assert.ok(refusals.size <= 2, [...refusals].join(" | "));
  })();
});
const approvalDetail = (e: Env, p: WriteProposal) => approvalFor(e, p).detail;

// ============================================================ spike gaps: the diff, text rules, audit

test("d: /write-proposals/:id returns the whole stored diff; the approval carries proposalId; the list leaves diffs out", async () => {
  const b = await boot();
  const root = dir("big-");
  const grant = b.orch.files.addGrant({ path: root, agentId: "claude", read: true, write: true });
  const content = Array.from({ length: 700 }, (_, i) => `line number ${i} with some padding to make the diff long`).join("\n") + "\n";
  const r = b.orch.files.proposeWrite("claude", undefined, "long.txt", content, grant.id);
  assert.ok(r.ok); if (!r.ok) return;
  const apr = approvalFor(b, r.proposal);
  assert.equal(apr.proposalId, r.proposal.id);
  assert.match(apr.detail, /DIFF TRUNCATED/, "the approval card is cut short");
  assert.ok(!apr.detail.includes("line number 699"));

  const full = (await (await fetch(`${b.base}/write-proposals/${r.proposal.id}`, { headers: b.auth })).json()) as WriteProposal;
  assert.ok(full.diff.includes("line number 699 with some padding"), "the whole diff is there");
  assert.equal(full.files![0].relPath, "long.txt");
  const list = (await (await fetch(`${b.base}/write-proposals?status=pending`, { headers: b.auth })).json()) as (WriteProposal & { diffBytes: number })[];
  assert.equal(list.length, 1); assert.equal((list[0] as unknown as Record<string, unknown>).diff, undefined); assert.ok(list[0].diffBytes > 30_000);
  assert.equal((await fetch(`${b.base}/write-proposals/wp_nope`, { headers: b.auth })).status, 404);
  assert.equal((await fetch(`${b.base}/write-proposals?grantId=nope`, { headers: b.auth }).then((x) => x.json()) as unknown[]).length, 0);
  await b.app.close();
});

test("e: read and write refuse binary and invalid UTF-8 the same way", () => {
  const e = setup();
  const root = dir("text-");
  writeFileSync(join(root, "nul.dat"), Buffer.from([65, 0, 66]));
  writeFileSync(join(root, "bad.txt"), Buffer.from([0x68, 0xc3, 0x28, 0x69]));
  writeFileSync(join(root, "ok.txt"), "héllo\n");
  const g = e.orch.files.addGrant({ path: root, agentId: "claude", read: true, write: true });
  const files = e.orch.files;
  for (const n of ["nul.dat", "bad.txt"]) {
    const rd = files.read("claude", undefined, n, g.id);
    assert.ok(rd.ok && rd.binary && rd.note.includes("binary or not valid UTF-8"), n);
    const wr = files.proposeWrite("claude", undefined, n, "replacement\n", g.id);
    assert.ok(!wr.ok && wr.reason.includes("binary or not valid UTF-8"), `${n}: ${wr.ok ? "accepted" : wr.reason}`);
  }
  const nulWrite = files.proposeWrite("claude", undefined, "new.txt", "a\0b", g.id);
  assert.ok(!nulWrite.ok && nulWrite.reason.includes("binary or not valid UTF-8"));
  const lone = files.proposeWrite("claude", undefined, "new.txt", "a\ud800b", g.id);
  assert.ok(!lone.ok && lone.reason.includes("binary or not valid UTF-8"), "an unpaired surrogate would not survive as UTF-8");
  const ok = files.read("claude", undefined, "ok.txt", g.id);
  assert.ok(ok.ok && !ok.binary && ok.content === "héllo\n");
  // a read cut in the middle of a character is still text
  const cut = files.read("claude", undefined, "ok.txt", g.id, 2);
  assert.ok(cut.ok && !cut.binary && cut.truncated, "a limit that falls inside é is not 'invalid UTF-8'");
});

test("AC5: every file operation, grant change and key change is audited with who and what, never with contents or keys", async () => {
  const e = setup();
  const root = dir("audit-");
  writeFileSync(join(root, "a.txt"), "alpha SECRETCONTENT-A\n"); writeFileSync(join(root, "c.txt"), "gamma\n");
  const files = e.orch.files;
  const g = files.addGrant({ path: root, agentId: "claude", read: true, write: true });                    // grant.added
  files.updateGrant(g.id, { label: "Work" });                                                                // grant.changed
  files.list("claude", undefined, ".", g.id);                                                                // file.list
  files.read("claude", undefined, "a.txt", g.id);                                                            // file.read
  files.read("claude", undefined, "../nope", g.id);                                                          // file.denied
  const p1 = files.proposeWrite("claude", undefined, "a.txt", "alpha SECRETCONTENT-B\n", g.id);             // file.write.proposed
  const p2 = files.proposeWrite("claude", undefined, "b.txt", "beta SECRETCONTENT-C\n", g.id);              // file.write.proposed
  const p3 = files.proposeWrite("claude", undefined, "c.txt", "gamma two SECRETCONTENT-D\n", g.id);         // file.write.proposed
  assert.ok(p1.ok && p2.ok && p3.ok); if (!p1.ok || !p2.ok || !p3.ok) return;
  e.approvals.decide(approvalFor(e, p1.proposal).id, "approved");                                            // file.write.applied
  e.approvals.decide(approvalFor(e, p2.proposal).id, "rejected");                                            // file.write.rejected
  writeFileSync(join(root, "c.txt"), "the owner changed this\n");
  e.approvals.decide(approvalFor(e, p3.proposal).id, "approved");                                            // file.write.conflict
  await until(() => ["applied", "rejected", "conflict"].every((s) => files.proposals().some((p) => p.status === s)));
  const t = files.proposeTask({ grantId: g.id, agentId: "claude", roomId: e.room.id, goalId: "goal_1", taskId: "task_1", title: "T", changes: [{ relPath: "x.txt", content: Buffer.from("x\n") }, { relPath: "y/z.txt", content: Buffer.from("z\n") }] }); // file.write.proposed x2
  assert.ok(t.ok && t.proposal); if (!t.ok || !t.proposal) return;
  e.approvals.decide(approvalFor(e, t.proposal).id, "approved");                                             // file.write.applied x2
  await until(() => files.proposal(t.proposal!.id)!.status === "applied");
  files.removeGrant(g.id);                                                                                   // grant.removed

  const tokens = new McpTokens(e.store);
  const k = tokens.create({ agentId: "claude", name: "Hermes" });                                            // mcp.token.created
  const k2 = tokens.rotate(k.info.id)!;                                                                      // mcp.token.rotated
  tokens.revoke(k.info.id);                                                                                  // mcp.token.revoked

  const entries = audit(e.store);
  const tally = (a: string) => entries.filter((x) => x.action === a).length;
  assert.deepEqual(
    Object.fromEntries(["grant.added", "grant.changed", "file.list", "file.read", "file.denied", "file.write.proposed", "file.write.applied", "file.write.rejected", "file.write.conflict", "grant.removed", "mcp.token.created", "mcp.token.rotated", "mcp.token.revoked"].map((a) => [a, tally(a)])),
    { "grant.added": 1, "grant.changed": 1, "file.list": 1, "file.read": 1, "file.denied": 1, "file.write.proposed": 5, "file.write.applied": 3, "file.write.rejected": 1, "file.write.conflict": 1, "grant.removed": 1, "mcp.token.created": 1, "mcp.token.rotated": 1, "mcp.token.revoked": 1 });
  // who and what: the actor and the path are on the entry
  const wrote = entries.filter((x) => x.action === "file.write.applied").map((x) => `${x.actor} ${x.detail}`);
  assert.ok(wrote.some((l) => l.startsWith("claude") && l.includes('"a.txt"')) && wrote.some((l) => l.includes('"x.txt"')) && wrote.some((l) => l.includes('"y/z.txt"')));
  assert.ok(entries.filter((x) => x.action === "grant.added" || x.action === "grant.changed" || x.action === "grant.removed").every((x) => x.actor === "owner" && x.detail.includes(root)));
  assert.ok(entries.filter((x) => x.action.startsWith("mcp.token.")).every((x) => x.actor === "owner"));
  // never contents, never keys
  const all = JSON.stringify(audit(e.store));
  for (const secret of ["SECRETCONTENT", "the owner changed this", k.token, k2.token]) assert.ok(!all.includes(secret), `the log must not contain ${secret}`);
});

// ============================================================ external MCP keys

async function boot(pre?: (c: Env) => void) {
  const c = setup();
  pre?.(c);
  const app = await buildServer({ ...c, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  return { ...c, app, base, code, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}
const RPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const mcpHeaders = (key: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });
const rpcStatus = async (base: string, key: string, extra: Record<string, string> = {}) => (await fetch(`${base}/mcp`, { method: "POST", headers: mcpHeaders(key, extra), body: RPC })).status;
const makeKey = async (b: Awaited<ReturnType<typeof boot>>, body: Record<string, unknown>) => {
  const r = await fetch(`${b.base}/mcp-tokens`, { method: "POST", headers: b.auth, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.json()) as { id: string; token: string; roomId?: string; expiresAt?: number };
};

test("c: MCP keys are hashed at rest: the database, the list and the audit log never hold a key", async () => {
  const b = await boot();
  const k = await makeKey(b, { agentId: "hermes", name: "Hermes key" });
  assert.match(k.token, /\S{16,}/);
  assert.equal(await rpcStatus(b.base, k.token), 200);
  assert.equal(await rpcStatus(b.base, k.token + "x"), 401);

  const stored = JSON.stringify(b.store.getKV("mcp_tokens_v2", []));
  assert.ok(stored.includes(hashToken(k.token)), "the SHA-256 of the key is what is stored");
  assert.ok(!stored.includes(k.token));
  assert.deepEqual(b.store.getKV("mcp_tokens", {}), {}, "nothing in the legacy plaintext place");
  b.store.db.pragma("wal_checkpoint(TRUNCATE)");
  assert.ok(!readFileSync(join(b.dir, "t.db")).includes(k.token), "the key is not in the database file");
  const list = await (await fetch(`${b.base}/mcp-tokens`, { headers: b.auth })).text();
  assert.ok(!list.includes(k.token) && list.includes(k.id), "listing shows the record, never the key");
  assert.ok(!JSON.stringify(audit(b.store)).includes(k.token));
  assert.equal((await fetch(`${b.base}/mcp-tokens`)).status, 401, "listing keys needs a paired device");
  await b.app.close();
});

test("c: legacy plaintext keys are migrated to hashes on start and keep working", async () => {
  const legacy = "legacy-key-0123456789abcdef";
  const b = await boot((c) => c.store.setKV("mcp_tokens", { [legacy]: { agentId: "hermes", name: "Hermes" } }));
  assert.deepEqual(b.store.getKV("mcp_tokens", {}), {}, "plaintext is gone");
  assert.ok(JSON.stringify(b.store.getKV("mcp_tokens_v2", [])).includes(hashToken(legacy)));
  assert.equal(count(b.store, "mcp.token.migrated"), 1);
  assert.equal(await rpcStatus(b.base, legacy), 200, "the old key still works");
  b.store.db.pragma("wal_checkpoint(TRUNCATE)");
  assert.ok(!readFileSync(join(b.dir, "t.db")).includes(legacy), "and is not left in the database file");
  assert.ok(!JSON.stringify(audit(b.store)).includes(legacy));
  const rec = ((await (await fetch(`${b.base}/mcp-tokens`, { headers: b.auth })).json()) as { agentId: string; roomId?: string }[]);
  assert.equal(rec.length, 1); assert.equal(rec[0].agentId, "hermes"); assert.equal(rec[0].roomId, undefined);
  // a second start doesn't migrate again
  await b.app.close();
  const again = await buildServer({ ...b, ownerName: "Blake" });
  assert.equal(count(b.store, "mcp.token.migrated"), 1);
  await again.close();
});

test("c: expiry is enforced, an expired key is audited without the key, rotation retires the old key, revoke ends it", async () => {
  const b = await boot();
  const soon = await makeKey(b, { agentId: "hermes", name: "Short", expiresAt: Date.now() + 1500 });
  assert.ok(soon.expiresAt);
  assert.equal(await rpcStatus(b.base, soon.token), 200);
  await sleep(1600);
  assert.equal(await rpcStatus(b.base, soon.token), 401, "expired");
  assert.equal(count(b.store, "mcp.token.expired"), 1);
  assert.ok(!JSON.stringify(audit(b.store)).includes(soon.token));
  const listed = ((await (await fetch(`${b.base}/mcp-tokens`, { headers: b.auth })).json()) as { id: string; expired: boolean }[]).find((x) => x.id === soon.id)!;
  assert.equal(listed.expired, true);

  // rotate: a new key, new expiry, the old one is dead at once, same record
  const rot = await (await fetch(`${b.base}/mcp-tokens/${soon.id}/rotate`, { method: "POST", headers: b.auth, body: JSON.stringify({ expiresInDays: 1 }) })).json() as { id: string; token: string; expiresAt: number };
  assert.equal(rot.id, soon.id); assert.notEqual(rot.token, soon.token);
  assert.ok(rot.expiresAt > Date.now() + 20 * 3600_000);
  assert.equal(await rpcStatus(b.base, soon.token), 401);
  assert.equal(await rpcStatus(b.base, rot.token), 200);
  // bad bodies
  for (const body of [{ agentId: "hermes", name: "x", expiresAt: Date.now() - 1000 }, { agentId: "hermes", name: "x", roomId: "room_nope" }, { name: "x" }]) {
    assert.equal((await fetch(`${b.base}/mcp-tokens`, { method: "POST", headers: b.auth, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await fetch(`${b.base}/mcp-tokens/mtk_nope/rotate`, { method: "POST", headers: b.auth, body: "{}" })).status, 404);

  assert.equal((await fetch(`${b.base}/mcp-tokens/${soon.id}`, { method: "DELETE", headers: b.auth })).status, 200);
  assert.equal(await rpcStatus(b.base, rot.token), 401);
  assert.equal((await fetch(`${b.base}/mcp-tokens/${soon.id}`, { method: "DELETE", headers: b.auth })).status, 404);
  assert.equal(count(b.store, "mcp.token.created"), 1); assert.equal(count(b.store, "mcp.token.rotated"), 1); assert.equal(count(b.store, "mcp.token.revoked"), 1);
  await b.app.close();
});

test("c: a key pinned to a room only sees that room's folder grants and cannot name another room", async () => {
  const b = await boot();
  const roomA = b.room, roomB = b.store.createRoom("other-room");
  b.store.addMessage({ roomId: roomA.id, author: { kind: "human", id: "owner", name: "Blake" }, text: "hello-from-A", type: "human", mentions: [] });
  b.store.addMessage({ roomId: roomB.id, author: { kind: "human", id: "owner", name: "Blake" }, text: "secret-from-B", type: "human", mentions: [] });
  const gA = b.orch.files.addGrant({ path: dir("ga-"), label: "A-folder", agentId: "*", roomId: roomA.id, read: true, write: false });
  const gB = b.orch.files.addGrant({ path: dir("gb-"), label: "B-folder", agentId: "*", roomId: roomB.id, read: true, write: false });
  const gN = b.orch.files.addGrant({ path: dir("gn-"), label: "Any-folder", agentId: "*", read: true, write: false });

  const scopedKey = await makeKey(b, { agentId: "cloud", name: "cloud in A", roomId: roomA.id });
  const openKey = await makeKey(b, { agentId: "cloud", name: "cloud anywhere" });
  const cloud = b.store.getAgent("cloud")!; cloud.tools.filesystem = true; b.store.saveAgent(cloud);
  const client = async (key: string) => { const c = new Client({ name: "t", version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(`${b.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } })); return c; };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => ((await c.callTool({ name, arguments: args })).content as { text: string }[])[0].text;

  const scoped = await client(scopedKey.token);
  const seen = await call(scoped, "list_granted_folders");
  assert.ok(seen.includes(gA.id) && seen.includes(gN.id) && !seen.includes(gB.id), seen);
  const room = await call(scoped, "read_room", { roomId: roomB.id });
  assert.ok(room.includes("hello-from-A") && !room.includes("secret-from-B"), "the roomId argument is ignored for a pinned key");
  assert.ok(!(await call(scoped, "list_tasks", { roomId: roomB.id })).includes("secret"));

  const open = await client(openKey.token);
  const seenOpen = await call(open, "list_granted_folders");
  assert.ok(seenOpen.includes(gN.id) && !seenOpen.includes(gA.id) && !seenOpen.includes(gB.id), "an unpinned key reaches only grants that name no room");
  await scoped.close(); await open.close();
  await b.app.close();
});

// ============================================================ AC3: only /mcp is reachable from outside

const PROXY = { "x-forwarded-for": "203.0.113.7", "x-forwarded-host": "mac.tail1234.ts.net", "x-forwarded-proto": "https" };

test("AC3: a proxied request to /goals/:id/files, /goals/:id/reveal and /documents is refused, even with a paired device's token", async () => {
  const b = await boot();
  const goal = { id: "goal_files", roomId: b.room.id, text: "x", status: "done" as const, createdAt: Date.now(), folder: join(b.dir, "goals", "goal_files") };
  mkdirSync(goal.folder, { recursive: true }); writeFileSync(join(goal.folder, "report.md"), "report");
  b.store.saveGoal(goal);
  const direct = await fetch(`${b.base}/goals/${goal.id}/files`, { headers: b.auth });
  assert.equal(direct.status, 200, "the same request on the Mac itself works");
  assert.ok((await direct.text()).includes("report.md"));
  for (const [method, path] of [["GET", `/goals/${goal.id}/files`], ["POST", `/goals/${goal.id}/reveal`], ["GET", "/documents"], ["GET", "/write-proposals"], ["GET", "/folder-grants"], ["GET", "/mcp-tokens"]] as const) {
    const r = await fetch(`${b.base}${path}`, { method, headers: { ...b.auth, ...PROXY } });
    assert.equal(r.status, 404, `${method} ${path} through Funnel`);
    assert.ok(!(await r.text()).includes("report.md"));
  }
  await b.app.close();
});

test("AC3: no route but /mcp answers a proxied request, and every route needs a paired device (inventory of every registered route)", async () => {
  const b = await boot();
  const routes = (b.app as unknown as { routeTable: () => { method: string; url: string }[] }).routeTable();
  assert.ok(routes.length > 60, `saw ${routes.length} routes`);
  const open = new Set(["/health", "/pair", "/pair/local", "/mcp", "/", "/web/:file"]);
  let checked = 0;
  for (const r of routes) {
    if (r.url.includes("*")) continue;
    const url = r.url.replace(/:[A-Za-z]+/g, "x");
    if (r.url === "/mcp" && (r.method === "POST" || r.method === "GET")) continue; // the one path Funnel may reach
    const proxied = await fetch(`${b.base}${url}`, { method: r.method, headers: { ...b.auth, ...PROXY }, body: ["GET", "HEAD"].includes(r.method) ? undefined : "{}" });
    assert.equal(proxied.status, 404, `proxied ${r.method} ${r.url}`);
    if (!open.has(r.url)) {
      const bare = await fetch(`${b.base}${url}`, { method: r.method, body: ["GET", "HEAD"].includes(r.method) ? undefined : "{}", headers: { "content-type": "application/json" } });
      assert.equal(bare.status, 401, `unpaired ${r.method} ${r.url}`);
    }
    checked++;
  }
  assert.ok(checked > 60);
  // /mcp itself: proxied calls need a valid key
  assert.equal(await rpcStatus(b.base, "not-a-key", PROXY), 401);
  const k = await makeKey(b, { agentId: "hermes", name: "k" });
  assert.equal(await rpcStatus(b.base, k.token, PROXY), 200);
  await b.app.close();
});

test("AC3/AC5: a cloud agent reaches files only through the MCP tools, and each call is audited as that agent", async () => {
  const b = await boot();
  const root = dir("cloud-"); writeFileSync(join(root, "plan.md"), "# Plan\n");
  const k = await makeKey(b, { agentId: "cloud", name: "cloud" });
  const a = b.store.getAgent("cloud")!; a.tools.filesystem = true; b.store.saveAgent(a);
  const g = b.orch.files.addGrant({ path: root, agentId: "cloud", read: true, write: true });
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${b.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${k.token}`, ...PROXY } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await c.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
  assert.equal(await call("read_file", { path: "plan.md", grantId: g.id }), "# Plan\n");
  assert.match(await call("read_file", { path: "../../etc/passwd", grantId: g.id }), /^DENIED:/);
  const proposed = await call("propose_file_write", { path: "plan.md", content: "# Plan\nmore\n", grantId: g.id });
  assert.match(proposed, /proposalId: \S+/);
  assert.equal(readFileSync(join(root, "plan.md"), "utf8"), "# Plan\n", "nothing is written before the owner approves");
  const pid = /proposalId: (\S+)/.exec(proposed)![1];
  assert.equal(approvalFor(b, b.orch.files.proposal(pid)!).proposalId, pid);
  const log = audit(b.store);
  for (const action of ["mcp.remote", "file.read", "file.denied", "file.write.proposed"]) assert.ok(log.some((x) => x.action === action && x.actor === "cloud"), action);
  assert.ok(!JSON.stringify(log).includes(k.token));
  await c.close(); await b.app.close();
});

test("the grant API: PUT changes who and what, DELETE removes, a refused folder says whether it can be forced, and the effective view matches the file tools", async () => {
  const b = await boot();
  const folder = dir("api-");
  const post = (body: unknown) => fetch(`${b.base}/folder-grants`, { method: "POST", headers: b.auth, body: JSON.stringify(body) });
  const made = (await (await post({ path: folder, agentId: "claude", label: "Docs", read: true, write: false })).json()) as { id: string; write: boolean };
  assert.equal(made.write, false);

  const put = async (id: string, body: unknown) => fetch(`${b.base}/folder-grants/${id}`, { method: "PUT", headers: b.auth, body: JSON.stringify(body) });
  const r1 = await put(made.id, { write: true, label: "Docs RW", roomId: b.room.id });
  assert.equal(r1.status, 200);
  const g1 = (await r1.json()) as { write: boolean; label: string; roomId: string; path: string };
  assert.equal(g1.write, true); assert.equal(g1.label, "Docs RW"); assert.equal(g1.roomId, b.room.id); assert.equal(g1.path, folder);
  assert.equal((await put(made.id, { roomId: null })).status, 200);
  assert.equal(b.orch.files.grant(made.id)!.roomId, undefined);
  assert.equal((await put(made.id, { read: false, write: false })).status, 400, "a grant needs read or write");
  assert.equal((await put(made.id, { agentId: "nobody" })).status, 400);
  assert.equal((await put("grant_nope", { write: false })).status, 404);
  assert.equal(count(b.store, "grant.changed"), 2);
  // taking away write settles a waiting write at once: the owner is not left an approval that can only fail
  assert.equal((await put(made.id, { write: true })).status, 200);
  writeFileSync(join(folder, "w.txt"), "old\n");
  const waiting = b.orch.files.proposeWrite("claude", undefined, "w.txt", "new\n", made.id);
  assert.ok(waiting.ok); if (!waiting.ok) return;
  assert.equal(b.store.listApprovals("pending").length, 1);
  assert.equal((await put(made.id, { write: false })).status, 200);
  assert.equal(b.orch.files.proposal(waiting.proposal.id)!.status, "rejected");
  assert.equal(b.store.listApprovals("pending").length, 0);
  assert.equal(readFileSync(join(folder, "w.txt"), "utf8"), "old\n");
  assert.equal((await put(made.id, { write: true })).status, 200);

  const filtered = (q: string) => fetch(`${b.base}/folder-grants?${q}`, { headers: b.auth }).then((x) => x.json()) as Promise<{ id: string }[]>;
  assert.equal((await filtered("agentId=claude")).length, 1); assert.equal((await filtered("agentId=codex")).length, 0);
  const eff = (await fetch(`${b.base}/folder-grants/effective?agentId=claude`, { headers: b.auth }).then((x) => x.json())) as { id: string }[];
  assert.deepEqual(eff.map((x) => x.id), [made.id]);
  assert.equal((await fetch(`${b.base}/folder-grants/effective`, { headers: b.auth })).status, 400);

  // refusals: the body tells the UI whether to offer "Grant anyway"
  const home = process.env.HOME ?? "/root";
  const hard = await post({ path: "/", agentId: "claude" });
  assert.equal(hard.status, 400);
  const hb = (await hard.json()) as { code: string; canForce: boolean };
  assert.equal(hb.code, "hard_refused"); assert.equal(hb.canForce, false);
  const prot = await post({ path: b.dir, agentId: "claude" });
  const pb = (await prot.json()) as { code: string; canForce: boolean; because: string };
  assert.equal(prot.status, 400); assert.equal(pb.code, "protected_folder"); assert.equal(pb.canForce, true); assert.match(pb.because, /data folder/);
  const chk = (await (await fetch(`${b.base}/folder-grants/check`, { method: "POST", headers: b.auth, body: JSON.stringify({ path: b.dir }) })).json()) as { ok: boolean; protected: boolean };
  assert.equal(chk.ok, true); assert.equal(chk.protected, true);
  assert.equal(b.orch.files.listGrants().length, 1, "check and refusals stored nothing");
  void home;
  const forced = await post({ path: b.dir, agentId: "claude", force: true, reason: "testing the override end to end" });
  assert.equal(forced.status, 200);
  const fg = (await forced.json()) as { id: string; override: { reason: string } };
  assert.equal(fg.override.reason, "testing the override end to end");
  assert.equal(count(b.store, "grant.override"), 1);

  assert.equal((await fetch(`${b.base}/folder-grants/${made.id}`, { method: "DELETE", headers: b.auth })).status, 200);
  assert.equal((await fetch(`${b.base}/folder-grants/${made.id}`, { method: "DELETE", headers: b.auth })).status, 404);
  assert.equal(count(b.store, "grant.removed"), 1);
  await b.app.close();
});
