import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig, Judgment, ServerEvent, Task } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { inbox } from "../src/adapters/mcp.js";
import { ControlFolder } from "../src/control/folder.js";
import { checkFile } from "../src/control/lint.js";
import { lint } from "../src/control/lint.js";
import { emitFile } from "../src/control/parse.js";
import { buildTaskContext } from "../src/control/context.js";
import { judgePrompt, taskPrompt, directPrompt } from "../src/orchestrator/prompts.js";
import {
  PERSONA_BEGIN as PB, PERSONA_END as PE, PERSONA_TEMPLATES, VOICE_ONLY, carriesPersona, matchTemplate, personaBlock, personaPromptBlock, readPersona, scrubPersona, soulText, withPersona, writePersona,
} from "../src/persona/index.js";
import { setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;

// ---------------------------------------------------------------- helpers

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const commits = (root: string) => git(root, "log", "--format=%an|%s").trim().split("\n").filter(Boolean);
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const write = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const head = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, schema: 1, updated: "2026-10-23", updated_by: "owner", ...extra });
const calls = (kind: string) => MockAdapter.calls.filter((c) => c.kind === kind);

async function withControl(t: TestContext, ctx: Ctx = setup()) {
  const root = join(ctx.dir, "Agent Room");
  const control = new ControlFolder(root, ctx.store, { debounceMs: 40, ownerName: "Blake", watch: false });
  await control.init();
  control.start();
  ctx.orch.control = control;
  t.after(() => control.close());
  return { ...ctx, control, root };
}

async function boot(t: TestContext, o: { control?: boolean } = {}) {
  const c = o.control ? await withControl(t) : { ...setup(), control: undefined as ControlFolder | undefined, root: "" };
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

/** A persona with a unique, greppable secret in it. */
const SECRET = (id: string) => `SECRET-${id.toUpperCase()}`;
const persona = (id: string) => ({ role: `Role of ${id}`, tone: `Tone of ${id}`, body: `Always wave first. ${SECRET(id)}` });
async function describeAll(ctx: Ctx, control?: ControlFolder) {
  for (const a of ctx.store.listAgents()) {
    const r = await writePersona(ctx.store, control, a.id, persona(a.id));
    assert.ok(r.ok, JSON.stringify(r));
  }
}
const agentOf = (ctx: Ctx, id: string) => ctx.store.getAgent(id)!;
/** Every persona secret and marker, which must be absent from anything a judge reads. */
function assertNoPersona(prompt: string, what: string) {
  for (const bad of [PB, PE, VOICE_ONLY, "SECRET-", "Your voice ("]) assert.ok(!prompt.includes(bad), `${what} carries persona text: ${bad}`);
}
/** The block sits between the markers, once, and after `after`. */
function assertBlock(prompt: string, who: string, after: string[]) {
  assert.equal(prompt.split(PB).length - 1, 1, "one block");
  assert.equal(prompt.split(PE).length - 1, 1);
  const b = prompt.indexOf(PB), e = prompt.indexOf(PE);
  assert.ok(b < e, "begin before end");
  const block = prompt.slice(b, e);
  assert.ok(block.includes(SECRET(who)) && block.includes(`Role of ${who}`) && block.includes(`Tone of ${who}`), `${who}'s persona is inside the markers`);
  assert.ok(block.includes(VOICE_ONLY), "the block says voice only");
  assert.ok(!prompt.slice(0, b).includes(SECRET(who)) && !prompt.slice(e).includes(SECRET(who)), "and only there");
  for (const a of after) { const i = prompt.indexOf(a); assert.ok(i >= 0 && i < b, `the block comes after "${a}"`); }
}

// ---------------------------------------------------------------- AC1: templates

test("AC1: six starter templates, each a valid SOUL.md", () => {
  assert.deepEqual(PERSONA_TEMPLATES.map((t) => t.id), ["analyst", "builder", "editor", "researcher", "operator", "skeptic"]);
  assert.equal(new Set(PERSONA_TEMPLATES.map((t) => t.body)).size, 6, "six different personas");
  for (const tpl of PERSONA_TEMPLATES) {
    const text = soulText({ name: "Test", color: "#6B4FD8", role: tpl.role, tone: tpl.tone, body: tpl.body });
    const r = checkFile("agents/test/SOUL.md", { kind: "soul", agent: "test" }, text);
    assert.deepEqual(r.blocks, [], `${tpl.id} validates against the SOUL.md schema`);
    const fm = r.fm as { role: string; tone: string } | undefined;
    assert.ok(fm && fm.role === tpl.role && fm.tone === tpl.tone, tpl.id);
    assert.ok(tpl.body.trim().length > 100 && Buffer.byteLength(text) < 2048, `${tpl.id} is a short bio`);
    assert.ok(!carriesPersona(tpl.body) && !/agent-room:/.test(tpl.body), `${tpl.id} has no marker text`);
    assert.ok(!/—/.test(`${tpl.label}${tpl.summary}${tpl.role}${tpl.tone}${tpl.body}`), `${tpl.id}: no em dashes`);
    assert.equal(matchTemplate(tpl), tpl.id);
  }
});

test("AC1: GET /personas/templates lists them", async (t) => {
  const c = await boot(t);
  const r = await api(c, "GET", "/personas/templates");
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 6);
  for (const tpl of r.body) for (const k of ["id", "label", "summary", "role", "tone", "body"]) assert.ok(tpl[k], `${tpl.id}.${k}`);
  assert.equal((await fetch(`${c.base}/personas/templates`)).status, 401, "paired devices only");
});

// ---------------------------------------------------------------- AC1: editing

test("AC1: PUT /agents/:id/persona writes SOUL.md as the owner; the agent's name and colour follow", async (t) => {
  const c = await boot(t, { control: true });
  const events: ServerEvent[] = [];
  c.store.on("event", (e: ServerEvent) => events.push(e));
  const before = commits(c.root).length;

  const r = await api(c, "PUT", "/agents/codex/persona", { name: "Cody", color: "#112233", avatar: "🛠", template: "builder" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, "control");
  assert.equal(r.body.template, "builder");
  assert.equal(r.body.name, "Cody");

  const file = read(c.root, "agents/codex/SOUL.md");
  assert.match(file, /^kind: soul$/m); assert.match(file, /^name: Cody$/m); assert.match(file, /^color: ["']?#112233["']?$/m);
  assert.match(file, /^updated_by: owner$/m); assert.match(file, /^role: Gets the thing made and working$/m);
  assert.ok(file.includes("Say what you did, then what is left."), "the body is the template's");
  assert.deepEqual(lint(c.root).blocks, [], "the linter is happy");

  const log = commits(c.root);
  assert.equal(log.length, before + 1, "one commit");
  assert.match(log[0], /^owner\|Change Cody's persona/);

  const a = c.store.getAgent("codex")!;
  assert.equal(a.name, "Cody"); assert.equal(a.color, "#112233"); assert.equal(a.avatar, "🛠");
  assert.ok(events.some((e) => e.type === "agent" && e.agent.id === "codex" && e.agent.name === "Cody" && e.agent.color === "#112233"), "the apps hear about it over the socket");
  const list = await api(c, "GET", "/agents");
  assert.equal(list.body.find((x: AgentConfig) => x.id === "codex").name, "Cody", "and see it in /agents");
  assert.ok(c.store.listAudit().some((x) => x.action === "persona.updated" && x.actor === "owner" && x.detail.startsWith("codex:")));

  const got = await api(c, "GET", "/agents/codex/persona");
  assert.deepEqual({ ...got.body }, { ...r.body });
  assert.equal(got.body.avatar, "🛠");

  // The same persona again is not a new commit.
  const again = await api(c, "PUT", "/agents/codex/persona", { name: "Cody", color: "#112233" });
  assert.equal(again.status, 200);
  assert.equal(commits(c.root).length, before + 1, "no change, no commit");

  // The file's side of the sync: a name in SOUL.md is the name in the app, and the agent file does not go back.
  write(c.root, "agents/codex/SOUL.md", file.replace("name: Cody", "name: Codey"));
  await c.control!.load();
  assert.equal(c.store.getAgent("codex")!.name, "Codey");
  assert.equal((await api(c, "GET", "/agents/codex/persona")).body.name, "Codey");
});

test("AC1: a persona edited in a text editor is what GET returns (the file wins)", async (t) => {
  const c = await boot(t, { control: true });
  write(c.root, "agents/claude/SOUL.md", emitFile(head("soul", { name: "Claude", color: "#6B4FD8", role: "Lead", tone: "Warm" }), "Hand-written bio.\n"));
  await c.control!.load();
  const r = await api(c, "GET", "/agents/claude/persona");
  assert.equal(r.body.role, "Lead"); assert.equal(r.body.tone, "Warm"); assert.equal(r.body.body.trim(), "Hand-written bio."); assert.equal(r.body.template, null);
  assert.equal(r.body.source, "control"); assert.equal(r.body.updated, "2026-10-23");
});

test("AC1: without a control folder the persona lives in the agent's record, and becomes SOUL.md when one appears", async (t) => {
  const c = await boot(t);
  const r = await api(c, "PUT", "/agents/hermes/persona", { name: "Herm", color: "#445566", template: "editor", avatar: "H" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, "agent"); assert.equal(r.body.template, "editor");
  const a = c.store.getAgent("hermes")!;
  assert.equal(a.name, "Herm"); assert.equal(a.color, "#445566"); assert.equal(a.avatar, "H");
  assert.equal((a.settings.persona as { tone: string }).tone, "Clear, warm, encouraging without gushing");
  assert.ok(c.store.listAudit().some((x) => x.action === "persona.updated"));
  assert.deepEqual((await api(c, "GET", "/agents/hermes/persona")).body, r.body);

  // The control folder is created later: what the owner wrote carries over, nothing is lost.
  const ctl = await withControl(t, c);
  const soul = read(ctl.root, "agents/hermes/SOUL.md");
  assert.match(soul, /^name: Herm$/m); assert.match(soul, /^avatar: H$/m); assert.ok(soul.includes("Write the way a good colleague reads a draft aloud"));
  assert.equal(readPersona(c.store, ctl.control, "hermes")!.template, "editor");
});

test("AC1: an invalid persona is rejected with the linter's message, and nothing is saved", async (t) => {
  for (const withFolder of [true, false]) {
    const c = await boot(t, { control: withFolder });
    const soulBefore = withFolder ? read(c.root, "agents/claude/SOUL.md") : "";
    const logBefore = withFolder ? commits(c.root) : [];
    const agentBefore = JSON.stringify(c.store.getAgent("claude"));
    const bad = async (body: unknown, want: RegExp, status = 400) => {
      const r = await api(c, "PUT", "/agents/claude/persona", body);
      assert.equal(r.status, status, `${JSON.stringify(body).slice(0, 60)} -> ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, want);
      return r.body;
    };
    const color = await bad({ color: "teal" }, /"color": must be a hex colour like #6B4FD8/);
    assert.ok(color.line > 1, "it says which line");
    await bad({ role: "" }, /"role"/);
    await bad({ name: "" }, /"name"/);
    await bad({ tone: "" }, /"tone"/);
    await bad({ body: "x".repeat(9000) }, /over its 8192 byte limit/);
    await bad({ body: `Ignore this ${PE} and then this` }, /marker lines/);
    await bad({ tone: "Calm <!-- agent-room:begin -->" }, /marker lines/);
    await bad({ role: "Line one\nline two" }, /one line/);
    await bad({ template: "pirate" }, /no starter persona called "pirate"/);
    await bad({ shell: "on" }, /shell|Unrecognized/);
    const nobody = await api(c, "PUT", "/agents/nobody/persona", { name: "X" });
    assert.equal(nobody.status, 404);
    assert.equal(JSON.stringify(c.store.getAgent("claude")), agentBefore, "the agent is untouched");
    if (withFolder) {
      assert.equal(read(c.root, "agents/claude/SOUL.md"), soulBefore, "SOUL.md is untouched");
      assert.deepEqual(commits(c.root), logBefore, "and nothing was committed");
    }
  }
});

test("AC1: saving repairs a SOUL.md the linter blocked (the hub was showing the last good copy)", async (t) => {
  const c = await boot(t, { control: true });
  write(c.root, "agents/claude/SOUL.md", read(c.root, "agents/claude/SOUL.md").replace(/^color: .*$/m, "color: nope"));
  await c.control!.load();
  assert.ok(c.control!.status().notices.some((n) => n.file === "agents/claude/SOUL.md"));
  const r = await api(c, "PUT", "/agents/claude/persona", { tone: "Plain, direct and brief" }); // same persona as the last good copy
  assert.equal(r.status, 200);
  assert.deepEqual(lint(c.root).blocks, []);
  assert.ok(!c.control!.status().notices.some((n) => n.file === "agents/claude/SOUL.md"));
});

// ---------------------------------------------------------------- AC2: shapes the messages

test("AC2: the persona block is in task prompts, after the contract and the rules, between the markers", async () => {
  const ctx = setup();
  await describeAll(ctx);
  MockAdapter.calls.length = 0;
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const tasks = calls("TASK");
  assert.ok(tasks.length >= 2);
  for (const c of tasks) {
    assertBlock(c.prompt, c.agentId, ["# Work contract", "# Your task:", "# Rules", "End your reply with this block, exactly:", "STATUS: done"]);
    const others = ctx.store.listAgents().filter((a) => a.id !== c.agentId);
    for (const o of others) assert.ok(!c.prompt.includes(SECRET(o.id)), "only its own persona");
    assert.ok(c.prompt.trimEnd().endsWith(PE), "the persona is the last thing in the prompt");
  }
  // What the persona does not touch: the report format is intact, so the work is still parsed and judged.
  assert.ok(ctx.store.listTasks({ goalId: goal.id }).every((t) => t.report && t.report.status === "done"));
});

test("AC2: direct replies, tag replies and the orchestrator's summary carry the persona too", async () => {
  const ctx = setup();
  await describeAll(ctx);
  MockAdapter.calls.length = 0;
  await ctx.orch.handleOwnerMessage(ctx.room.id, "@codex what do you think?");
  await new Promise((r) => setTimeout(r, 50));
  const direct = calls("CHAT").filter((c) => c.agentId === "codex");
  assert.equal(direct.length, 1);
  assertBlock(direct[0].prompt, "codex", ["Reply naturally and directly", "Before any sensitive action"]);

  // Tag reply: claude asks codex something.
  MockAdapter.calls.length = 0;
  const reply = (ctx.orch as unknown as { reply: (room: string, a: AgentConfig, o: { from: string; text: string; hop: number }) => Promise<string | undefined> }).reply;
  await reply.call(ctx.orch, ctx.room.id, agentOf(ctx, "codex"), { from: "claude", text: "What is the capital of Texas?", hop: 0 });
  const tag = calls("CHAT").filter((c) => c.agentId === "codex")[0];
  assert.ok(tag.prompt.startsWith("Claude tagged you"), "it is a tag prompt");
  assertBlock(tag.prompt, "codex", ["Answer what they asked, briefly and concretely"]);

  // The final report is the orchestrator speaking, so it has the orchestrator's voice.
  MockAdapter.calls.length = 0;
  await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  const summary = calls("SUMMARY");
  assert.equal(summary.length, 1);
  assertBlock(summary[0].prompt, summary[0].agentId, ["Write the final report to the owner"]);
});

test("AC2: an MCP agent's assignment instructions carry the persona (direct, tag and task)", async () => {
  const ctx = setup();
  await describeAll(ctx);
  ctx.store.saveAgent({ ...agentOf(ctx, "hermes"), adapter: "mcp" });
  inbox.seen("hermes");
  const reply = (ctx.orch as unknown as { reply: (room: string, a: AgentConfig, o: { from: string; text: string; hop: number }) => Promise<string | undefined> }).reply;

  const p1 = reply.call(ctx.orch, ctx.room.id, agentOf(ctx, "hermes"), { from: "owner", text: "How is it going?", hop: 0 });
  const a1 = await inbox.next("hermes", 2000);
  assert.ok(a1, "the direct reply is an assignment");
  assertBlock(a1!.instructions, "hermes", ["Reply naturally and directly"]);
  inbox.submit("hermes", a1!.id, "Fine.");
  await p1;

  const p2 = reply.call(ctx.orch, ctx.room.id, agentOf(ctx, "hermes"), { from: "claude", text: "Which file has the venue list?", hop: 0 });
  const a2 = await inbox.next("hermes", 2000);
  assertBlock(a2!.instructions, "hermes", ["Answer what they asked"]);
  inbox.submit("hermes", a2!.id, "venues.csv");
  await p2;

  // A whole goal: hermes answers every assignment (as a real MCP agent would, through the mock's replies).
  const seen: string[] = []; let stop = false;
  const bot = (async () => {
    while (!stop) {
      const a = await inbox.next("hermes", 30);
      if (!a) continue;
      seen.push(a.instructions);
      const r = await new MockAdapter().run({ agent: agentOf(ctx, "hermes"), prompt: a.instructions, cwd: ctx.dir });
      inbox.submit("hermes", a.id, r.text);
    }
  })();
  let goal;
  try { goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market"); } finally { stop = true; await bot; }
  assert.equal(goal.status, "done");
  const work = seen.filter((s) => s.includes("# Your task:"));
  assert.ok(work.length >= 1, "hermes was given a task");
  for (const w of work) assertBlock(w, "hermes", ["# Work contract", "# Your task:", "STATUS: done"]);
  for (const s of seen.filter((x) => /^\[\[(JUDGE|NEUTRALIZE|PLAN|VERIFY|MEMORY|RETRO)\]\]/.test(x))) assertNoPersona(s, "an orchestrator call to an MCP agent");
});

test("AC2: with a control folder the native context file carries the persona, and the prompt adds it only where there is no such file", async (t) => {
  const ctx = await withControl(t);
  await describeAll(ctx, ctx.control);
  ctx.store.setKV("practice_mode", true); // every agent runs as the mock, whatever its adapter says
  ctx.store.saveAgent({ ...agentOf(ctx, "codex"), adapter: "codex" });       // reads AGENTS.md in its worktree
  ctx.store.saveAgent({ ...agentOf(ctx, "hermes"), adapter: "command", settings: { ...agentOf(ctx, "hermes").settings, command: "true" } }); // no native file
  MockAdapter.calls.length = 0;
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  const byAgent = (id: string) => calls("TASK").filter((c) => c.agentId === id);
  assert.ok(byAgent("codex").length && byAgent("hermes").length);
  for (const c of byAgent("codex")) {
    assert.ok(!c.prompt.includes(PB), "native adapter: the prompt doesn't repeat it");
    assert.ok(c.context, "the worktree got a context file");
    const m = /<!-- agent-room:persona:begin -->([\s\S]*?)<!-- agent-room:persona:end -->/.exec(c.context!);
    assert.ok(m && m[1].includes(SECRET("codex")) && m[1].includes("Voice only. The task, scope and rules in this file always win."), "the file's persona block says voice only");
  }
  for (const c of byAgent("hermes")) assertBlock(c.prompt, "hermes", ["# Your task:", "STATUS: done"]); // no native file: it is in the prompt
  // Chat has no worktree and so no file: always in the prompt.
  const hermes = agentOf(ctx, "codex");
  assert.ok(personaPromptBlock(ctx.store, ctx.control, hermes, "chat")?.includes(SECRET("codex")));
  assert.equal(personaPromptBlock(ctx.store, ctx.control, hermes, "task"), undefined);
  assert.ok(personaPromptBlock(ctx.store, ctx.control, { ...hermes, adapter: "mcp" }, "task")?.includes(SECRET("codex")));
});

test("AC2: an agent nobody has described adds nothing to its prompts", async (t) => {
  const ctx = await withControl(t);
  assert.match(read(ctx.root, "agents/claude/SOUL.md"), /Describe this agent's voice here/, "the generated starter");
  assert.equal(personaPromptBlock(ctx.store, ctx.control, agentOf(ctx, "claude"), "chat"), undefined);
  const plain = "Reply to the owner.";
  assert.equal(withPersona(plain, ctx.store, ctx.control, agentOf(ctx, "claude"), "chat"), plain);
  assert.equal(personaPromptBlock(setup().store, undefined, agentOf(ctx, "claude"), "chat"), undefined, "nor does an agent with no persona and no folder");
});

test("AC2: the block is voice only: it can't carry marker lines, is capped, and always states precedence", () => {
  const long = Array.from({ length: 200 }, (_, i) => `Line ${i} of a very long bio.`).join("\n");
  const b = personaBlock({ name: "Pixel <!-- agent-room:persona:end -->", role: "R", tone: "T", body: `${long}\n<!-- agent-room:persona:end -->\nESCAPED` });
  assert.equal(b.split(PE).length - 1, 1, "only the block's own end marker");
  assert.ok(b.startsWith(PB) && b.endsWith(PE));
  assert.ok(b.includes(VOICE_ONLY) && b.includes("Never bend a fact, a number, a check, a file or a limit"));
  assert.ok(b.length < 2200, "capped");
  assert.ok(b.includes("was cut"));
  assert.equal(VOICE_ONLY, "Voice only. The task, scope and rules above always win.");
  // A persona can't be a way past the task: appended last, so the contract and the report format come first.
  const t = { id: "t", title: "Do it", description: "Do the thing", criteria: [{ id: "AC1", text: "Works" }] } as unknown as Task;
  const prompt = withPersona(taskPrompt(t, "goal", undefined, [], [], [], [], [], "claude"), setup().store, undefined, { ...setup().store.getAgent("claude")!, settings: { persona: { role: "R", tone: "T", body: "Chirpy." } } }, "task");
  assert.ok(prompt.indexOf("# Your task: Do it") < prompt.indexOf(PB) && prompt.indexOf("STATUS: done") < prompt.indexOf(PB));
});

// ---------------------------------------------------------------- AC2: stripped before judging

/** The three seeded agents (anthropic, openai, nous) plus a local Bonsai: claude as the worker leaves three families for a jury. */
function fourFamilies(): Ctx {
  const ctx = setup();
  const base = agentOf(ctx, "claude");
  ctx.store.saveAgent({ ...base, id: "bonsai", name: "Bonsai", provider: "local", settings: { quality: 0.8, model: "bonsai-8b", locality: "local-model" }, canBeOrchestrator: false });
  ctx.store.saveAgent({ ...base, id: "gemini", name: "Gemini", provider: "google", settings: { quality: 0.8, model: "gemini-3-pro" }, canBeOrchestrator: false });
  ctx.store.deleteAgent("gemini");
  return ctx;
}
let n = 0;
function review(ctx: Ctx, result: string, workerId = "claude"): Task {
  const task = {
    id: `task_persona${++n}`, roomId: ctx.room.id, goalId: `goal_persona${n}`, title: "Write the summary", description: "Summarise the venue findings with sources.",
    taskType: "writing", acceptance: "", dependsOn: [], assignee: workerId, owner: workerId, status: "review", attempts: 1, createdAt: 1, updatedAt: 1,
    criteria: [{ id: "AC1", text: "At least 3 facts" }, { id: "AC2", text: "Each fact has a source" }], result, checks: [],
  } as unknown as Task;
  ctx.store.saveTask(task);
  return task;
}
const judge = (ctx: Ctx, t: Task, files = ""): Promise<Judgment> =>
  (ctx.orch as unknown as { judge: (...a: unknown[]) => Promise<Judgment> }).judge(t, agentOf(ctx, "claude"), undefined, [], new AbortController().signal, [], files, undefined, undefined);

/** A worker that echoes its persona block into its reply (the worst case), plus a second, hand-made block, and files that do the same. */
function echoing(ctx: Ctx) {
  const mine = readPersona(ctx.store, undefined, "claude")!;
  const block = personaBlock({ name: mine.name, role: mine.role, tone: mine.tone, body: mine.body });
  return {
    reply: `${block}\nSure! Here is the **summary**: 3 venues in \`venues.csv\`, 42% of them bars.\n${PB}\nSECRET-CLAUDE second block, hand made\n${PE}\n\n— Claude`,
    files: `## summary.md\n${block}\nThree venues.`,
  };
}

test("AC2: judges never see the persona: jury, single-judge fallback and jury off, even when the worker echoes the block", async () => {
  const modes: [string, () => Ctx, (c: Ctx) => void][] = [
    ["jury", fourFamilies, (c) => c.store.setSettings({ ...c.store.getSettings(), judging: "full" })], // Speed: the jury is now opt-in
    ["fallback (too few families)", setup, () => {}],
    ["jury off", fourFamilies, (c) => c.store.setSettings({ ...c.store.getSettings(), jury: { enabled: false } })],
  ];
  for (const [mode, make, tweak] of modes) {
    const ctx = make(); tweak(ctx);
    await describeAll(ctx); // the judges have personas too: none of it may show
    const e = echoing(ctx);
    assert.ok(carriesPersona(e.reply));
    MockAdapter.calls.length = 0;
    const j = await judge(ctx, review(ctx, e.reply), e.files);
    assert.ok(j.verdict, mode);
    const judged = [...calls("JUDGE"), ...calls("NEUTRALIZE")];
    assert.ok(calls("JUDGE").length >= 1, `${mode}: it was judged`);
    if (mode === "jury") { assert.equal(calls("JUDGE").length, 3); assert.equal(calls("NEUTRALIZE").length, 1, "the neutral rewrite ran first"); assert.ok(calls("JUDGE").every((c) => c.prompt.includes("Neutral rewrite:"))); }
    for (const c of judged) {
      assertNoPersona(c.prompt, `${mode}: ${c.kind} prompt to ${c.agentId}`);
      for (const keep of ["venues.csv", "42%"]) assert.ok(c.kind !== "JUDGE" || c.prompt.includes(keep), `${mode}: the work itself is still there (${keep})`);
    }
    const files = calls("JUDGE").map((c) => c.prompt).join("\n");
    assert.ok(!files.includes("SECRET-"), `${mode}: not even in the deliverable files section`);
  }
});

test("AC2: a whole goal: no judge, rewriter, planner, verifier, memory or retro prompt carries any persona", async () => {
  const ctx = fourFamilies();
  ctx.store.setSettings({ ...ctx.store.getSettings(), judging: "full" }); // Speed: exercise the full jury so the NEUTRALIZE rewriter runs
  await describeAll(ctx);
  MockAdapter.calls.length = 0;
  const goal = await ctx.orch.runGoal(ctx.room.id, "Summarize the venue TV market");
  assert.equal(goal.status, "done");
  await new Promise((r) => setTimeout(r, 50));
  const kinds = new Set(MockAdapter.calls.map((c) => c.kind));
  for (const k of ["JUDGE", "NEUTRALIZE", "PLAN", "VERIFY"]) assert.ok(kinds.has(k), `${k} ran`);
  for (const c of MockAdapter.calls.filter((x) => !["TASK", "CHAT", "SUMMARY"].includes(x.kind))) assertNoPersona(c.prompt, `${c.kind} prompt to ${c.agentId}`);
  // What the agents did say with their voice is the work, and it is still there for the judges to read.
  assert.ok(calls("TASK").every((c) => c.prompt.includes(PB)));
});

test("AC2: judgePrompt itself strips persona blocks and stray markers from the reply and the files", () => {
  const task = { id: "t", title: "T", description: "D", criteria: [{ id: "AC1", text: "X" }], result: `${PB}\nSECRET-A\n${PE}\nReal answer: 42.\n${PE}` } as unknown as Task;
  const p = judgePrompt(task, undefined, [], [], `file one\n${PB}\nSECRET-C\n${PE}\nkept`);
  assertNoPersona(p, "judgePrompt");
  assert.ok(p.includes("Real answer: 42.") && p.includes("kept"));
  assert.equal(scrubPersona(`a ${PB} b ${PE} c`), "a  c");
  assert.ok(directPrompt("", [], [], [], [], "claude").length > 0);
});

// ---------------------------------------------------------------- persona is not a résumé

test("AC2: RESUME.md never carries persona text", async (t) => {
  const c = await withControl(t);
  await describeAll(c, c.control);
  const resume = emitFile(head("resume", { runs: 3, strengths: ["sql"], weaknesses: ["slides"], model_versions: [], probation: false }),
    `Strong on SQL.\n${PB}\n${SECRET("claude")} Your voice (Claude). ${VOICE_ONLY}\n${PE}\nWeak on slides.\n`);
  const r = await c.control.writeManaged("agents/claude/RESUME.md", () => resume, "Résumé for claude", "orchestrator");
  assert.equal(r, "written");
  const onDisk = read(c.root, "agents/claude/RESUME.md");
  assert.ok(!carriesPersona(onDisk) && !onDisk.includes("SECRET-"), "scrubbed on the way to the file");
  assert.ok(onDisk.includes("Strong on SQL.") && onDisk.includes("Weak on slides."), "the rest of the résumé stays");
  assert.deepEqual(lint(c.root).blocks, []);
  assert.ok(!buildTaskContext({ control: c.control.snapshot(), agentId: "claude", taskType: "x", goal: { id: "g", text: "t" }, task: { title: "T", description: "D" } }).includes("Strong on SQL"), "RESUME.md stays out of agent context (1.9)");
  // And the other way round: nothing from a résumé is in a persona (they are separate files, with separate writers).
  assert.ok(!read(c.root, "agents/claude/SOUL.md").includes("Strong on SQL"));
});

test("AC2: the persona section of the context file says it is voice only, and the persona's own markers hold", async (t) => {
  const c = await withControl(t);
  await describeAll(c, c.control);
  const text = buildTaskContext({ control: c.control.snapshot(), agentId: "claude", taskType: "writing", goal: { id: "g", text: "t" }, task: { title: "T", description: "D" } });
  const m = /<!-- agent-room:persona:begin -->([\s\S]*?)<!-- agent-room:persona:end -->/.exec(text);
  assert.ok(m, "marked");
  assert.ok(m![1].includes("Voice only. The task, scope and rules in this file always win.") && m![1].includes(SECRET("claude")));
  assert.equal(scrubPersona(text).includes(SECRET("claude")), false, "and one strip removes it all");
});

// ---------------------------------------------------------------- AC1: both apps edit it

test("AC1: the Mac app and the phone app both have a persona editor with templates, wired to the hub's routes", async (t) => {
  const { readFileSync: rf } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const mac = (f: string) => rf(join(here, "../../app/src", f), "utf8");
  const web = rf(join(here, "../web/app.js"), "utf8");
  const editor = mac("components/PersonaEditor.tsx");
  for (const field of ["Name", "Hex colour", "Avatar", "Role", "Tone", "Bio and voice notes", "Start from a template"]) assert.ok(editor.includes(field), `Mac: ${field}`);
  assert.match(mac("screens/AgentsScreen.tsx"), /<PersonaEditor a=\{a\} \/>/, "on the agent card");
  assert.match(mac("api/client.ts"), /\/agents\/\$\{agentId\}\/persona/);
  assert.match(mac("api/client.ts"), /"\/personas\/templates"/);
  assert.match(mac("components/ui.tsx"), /glyph \|\| name\.slice\(0, 1\)\.toUpperCase\(\)/, "the avatar letter or emoji is shown");
  for (const bit of ["renderPersonas", "renderPersona", "/personas/templates", '`/agents/${encodeURIComponent(p.id)}/persona`', 'method: "PUT"', "Start from a template", "Bio and voice notes", 'data-nav="personas"']) assert.ok(web.includes(bit), `phone: ${bit}`);
  assert.doesNotMatch(editor, /—|–/);
  // The phone app's route table check (fileaccess-ui.test.ts) covers that these routes exist; here: they do, for a paired device.
  const c = await boot(t);
  assert.equal((await api(c, "GET", "/agents/claude/persona")).status, 200);
});
