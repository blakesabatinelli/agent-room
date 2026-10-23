import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiscoveredAgent } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { buildCommandIndex, commandGroups, loadCommandIndex, plannerCommands, refreshCommandIndex, ROOM_COMMANDS, slugify } from "../src/commands/index.js";
import { buildInvocation, expandCodexPrompt, parseCommand, splitArgs, suggest } from "../src/commands/invoke.js";
import { defaultEnv, type DiscoveryEnv } from "../src/discovery/env.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { planPrompt } from "../src/orchestrator/prompts.js";
import { setup } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Agent runs the tests care about (the orchestrator also makes quiet memory calls after an answer). */
const runs = () => MockAdapter.calls.filter((c) => c.kind !== "MEMORY");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await sleep(15); }
}

// ---------------------------------------------------------------- a fake home folder with skills, commands and prompts

const SKILL = (name: string, description: string, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\nSteps go here.\n`;

const FILES: Record<string, string> = {
  // Claude Code: user skills (one the model may not load by itself), custom commands (one in a subfolder), a plugin
  ".claude/skills/board-deck/SKILL.md": SKILL("board-deck", "Build the quarterly board deck from the finance model"),
  ".claude/skills/pause/SKILL.md": SKILL("pause", "A skill that happens to share a name with a room command"),
  ".claude/skills/release-notes/SKILL.md": SKILL("release-notes", "Draft release notes", "disable-model-invocation: true\nargument-hint: [version]\n"),
  ".claude/commands/ship.md": `---\ndescription: Ship the current branch\nargument-hint: [branch]\n---\nRun the release checklist for $ARGUMENTS.\n`,
  ".claude/commands/frontend/build.md": `Build the frontend and report errors.\n`,
  ".claude/plugins/cache/market/my-plugin/1.2.0/.claude-plugin/plugin.json": JSON.stringify({ name: "my-plugin" }),
  ".claude/plugins/cache/market/my-plugin/1.2.0/skills/board-deck/SKILL.md": SKILL("board-deck", "The plugin's own board deck skill"),
  ".claude/plugins/cache/market/my-plugin/1.2.0/skills/lint-docs/SKILL.md": SKILL("lint-docs", "Lint the docs folder"),
  ".claude/plugins/cache/market/my-plugin/1.2.0/commands/review.md": `---\ndescription: Review a pull request\n---\nReview it.\n`,
  // Codex: custom prompts (front matter, or just a first line) and a skill
  ".codex/prompts/review-pr.md": `---\ndescription: Review a pull request\nargument-hint: PR_NUMBER\n---\nReview pull request #$1 with focus on "$ARGUMENTS". Costs are $$5 at most. Ticket: $TICKET.\n`,
  ".codex/prompts/draftpr.md": `# Draft PR\nDraft a PR titled $PR_TITLE touching $FILES.\n`,
  ".codex/skills/sql-tune/SKILL.md": SKILL("sql-tune", "Tune a slow SQL query"),
  // Hermes: skills under ~/.hermes/skills/<category>/<name>
  ".hermes/skills/research/web-research/SKILL.md": SKILL("web-research", "Research a topic on the web with sources"),
};

function fakeHome(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "ar-cmd-"));
  for (const [rel, text] of Object.entries({ ...FILES, ...extra })) { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), text); }
  const env: DiscoveryEnv = defaultEnv({ home, vars: {}, which: async () => undefined, run: async () => ({ code: 1, stdout: "", stderr: "" }), fetchJson: async () => undefined });
  return { home, env };
}
const agent = (id: string, adapter: DiscoveredAgent["adapter"] = "mock" as never, installed = true): DiscoveredAgent => ({
  id, name: id[0].toUpperCase() + id.slice(1), provider: id, adapter, installed, signedIn: true, detail: "", settings: {},
  capabilities: { connectors: [], dataSources: [], skills: [], tools: [] }, capabilitiesKnown: true, defaultEnabled: true,
});
const AGENTS = [agent("claude", "claude-code"), agent("codex", "codex"), agent("hermes", "mcp")];

// ---------------------------------------------------------------- AC1: the index

test("2.6 AC1: skills, custom commands, plugins, Codex prompts and Hermes skills become namespaced commands", () => {
  const { env } = fakeHome();
  const index = buildCommandIndex({ agents: AGENTS }, env);
  const byName = new Map(index.entries.map((e) => [e.name, e]));
  const names = [...byName.keys()];

  const deck = byName.get("claude:board-deck")!;
  assert.equal(deck.kind, "skill"); assert.equal(deck.agentId, "claude");
  assert.match(deck.description, /quarterly board deck/);
  assert.match(deck.source, /\.claude\/skills\/board-deck\/SKILL\.md$/);
  assert.equal(byName.get("claude:ship")!.kind, "command");
  assert.equal(byName.get("claude:ship")!.argsHint, "[branch]");
  assert.equal(byName.get("claude:ship")!.description, "Ship the current branch");
  assert.equal(byName.get("claude:frontend-build")!.native, "frontend:build", "a subfolder is the command's own namespace");
  assert.equal(byName.get("claude:frontend-build")!.description, "Build the frontend and report errors.", "no front matter: the first line");
  assert.equal(byName.get("claude:lint-docs")!.kind, "plugin-skill");
  assert.equal(byName.get("claude:lint-docs")!.native, "my-plugin:lint-docs");
  assert.equal(byName.get("claude:review")!.kind, "command");
  assert.equal(byName.get("claude:review")!.native, "my-plugin:review");

  const pr = byName.get("codex:review-pr")!;
  assert.equal(pr.kind, "prompt"); assert.equal(pr.native, "prompts:review-pr"); assert.equal(pr.argsHint, "PR_NUMBER");
  assert.equal(pr.description, "Review a pull request");
  assert.equal(byName.get("codex:draftpr")!.description, "Draft a PR titled $PR_TITLE touching $FILES.", "first non-heading line");
  assert.equal(byName.get("codex:sql-tune")!.kind, "skill");
  assert.equal(byName.get("hermes:web-research")!.kind, "skill");

  // Every name is `<agent>:<slug>` and unique.
  assert.ok(names.every((n) => /^(claude|codex|hermes):[a-z0-9-]+$/.test(n)), names.join(", "));
  assert.equal(new Set(names).size, names.length);
});

test("2.6: names are slugified and a clash keeps the first, suffixing the rest", () => {
  assert.equal(slugify("Board Deck (v2)!"), "board-deck-v2");
  assert.equal(slugify("***"), "command");
  const { env } = fakeHome();
  const index = buildCommandIndex({ agents: [agent("claude", "claude-code")] }, env);
  const decks = index.entries.filter((e) => e.native.endsWith("board-deck"));
  assert.deepEqual(decks.map((e) => e.name).sort(), ["claude:board-deck", "claude:my-plugin-board-deck"]);
  assert.equal(index.entries.find((e) => e.name === "claude:board-deck")!.kind, "skill", "the owner's own skill wins the plain name");
  // Two files that slugify the same get numbers.
  const { env: env2 } = fakeHome({ ".codex/prompts/Fix Bug.md": "One\n", ".codex/prompts/fix-bug.md": "Two\n" });
  const names = buildCommandIndex({ agents: [agent("codex", "codex")] }, env2).entries.map((e) => e.name);
  assert.ok(names.includes("codex:fix-bug") && names.includes("codex:fix-bug-prompt"), names.join(", "));
  const { env: env3 } = fakeHome({ ".codex/prompts/a b.md": "One\n", ".codex/prompts/a-b.md": "Two\n", ".codex/prompts/a_b.md": "Three\n" });
  const abs = buildCommandIndex({ agents: [agent("codex", "codex")] }, env3).entries.map((e) => e.name).filter((n) => n.startsWith("codex:a-b"));
  assert.deepEqual(abs.sort(), ["codex:a-b", "codex:a-b-2", "codex:a-b-prompt"], "a third clash gets a number");
});

test("2.6: an agent that isn't installed, or that discovery can't read, contributes nothing", () => {
  const { env } = fakeHome();
  const index = buildCommandIndex({ agents: [agent("claude", "claude-code", false), agent("muse", "mcp")] }, env);
  assert.deepEqual(index.entries, []);
  assert.deepEqual(commandGroups(index).map((g) => g.id), ["room"]);
});

test("2.6 AC1: discovery keeps the index fresh and a restart reads it back", async () => {
  const { home, env } = fakeHome();
  // Discovery itself, over the fake Mac: claude, codex and hermes are "found".
  const found = { ...env, which: async (b: string) => (["claude", "codex", "hermes"].includes(b) ? `/fake/${b}` : undefined) } as DiscoveryEnv;
  const { store } = setup();
  assert.deepEqual(loadCommandIndex(store).entries, [], "nothing before discovery runs");
  await new DiscoveryService(store, { env: found, mcpUrl: () => undefined }).run();
  const index = loadCommandIndex(store);
  assert.ok(index.entries.some((e) => e.name === "claude:board-deck"));
  assert.ok(index.entries.some((e) => e.name === "codex:review-pr"));
  assert.ok(index.entries.some((e) => e.name === "hermes:web-research"));
  // A new prompt shows up at the next discovery run.
  writeFileSync(join(home, ".codex/prompts/new-one.md"), "Brand new\n");
  refreshCommandIndex(store, { agents: AGENTS }, env);
  assert.ok(loadCommandIndex(store).entries.some((e) => e.name === "codex:new-one"));
});

// ---------------------------------------------------------------- AC3: room commands

test("2.6 AC3: room commands are listed first, unprefixed, and nothing can shadow them", async () => {
  const { env } = fakeHome();
  const index = buildCommandIndex({ agents: AGENTS }, env);
  const groups = commandGroups(index);
  assert.equal(groups[0].id, "room");
  assert.deepEqual(groups[0].commands.map((c) => c.name), ["pause", "resume", "stop", "fork", "digest", "redirect", "replan"]);
  assert.ok(groups[0].commands.every((c) => !c.name.includes(":") && c.description));
  assert.deepEqual(groups.slice(1).map((g) => g.id), ["claude", "codex", "hermes"]);
  for (const g of groups.slice(1)) assert.ok(g.commands.every((c) => c.name.startsWith(`${g.id}:`)), `${g.id} commands are prefixed`);
  // A skill called "pause" is /claude:pause. It is never /pause.
  assert.ok(index.entries.some((e) => e.name === "claude:pause"));
  assert.ok(!index.entries.some((e) => ROOM_COMMANDS.some((r) => r.name === e.name)));
  assert.deepEqual(parseCommand("/pause", index), { kind: "room", name: "pause" });
  assert.equal(parseCommand("/redirect @codex shorter", index).kind, "room");
  // An agent whose id is a room command word never gets a namespace.
  assert.deepEqual(buildCommandIndex({ agents: [{ ...agent("stop", "mcp"), id: "stop" }] }, env).entries, []);

  // Through the orchestrator: /pause pauses the room and reaches no agent; /claude:pause runs the skill.
  const { store, orch, room } = setup();
  refreshCommandIndex(store, { agents: AGENTS }, env);
  MockAdapter.calls.length = 0;
  await orch.handleOwnerMessage(room.id, "/pause");
  assert.equal(store.getRoom(room.id)!.paused, true);
  await orch.handleOwnerMessage(room.id, "/resume");
  assert.equal(store.getRoom(room.id)!.paused, false);
  assert.equal(runs().length, 0, "room commands reach no agent");
  await orch.handleOwnerMessage(room.id, "/claude:pause now");
  await until(() => runs().length === 1, "the claude run");
  assert.equal(runs()[0].agentId, "claude");
  assert.equal(store.getRoom(room.id)!.paused, false);
});

// ---------------------------------------------------------------- AC2: invocation

test("2.6 AC2: /codex:review-pr 42 reaches Codex with the prompt inlined and the arguments replaced", async () => {
  const { env } = fakeHome();
  const { store, orch, room } = setup();
  refreshCommandIndex(store, { agents: AGENTS }, env);
  MockAdapter.calls.length = 0;
  await orch.handleOwnerMessage(room.id, "/codex:review-pr 42");
  await until(() => runs().length === 1, "the codex run");
  const call = runs()[0];
  assert.equal(call.agentId, "codex");
  assert.match(call.prompt, /^Review pull request #42 with focus on "42"\. Costs are \$5 at most\. Ticket: \./, "$1 and $ARGUMENTS replaced, $$ is a dollar sign");
  assert.ok(!call.prompt.includes("$ARGUMENTS") && !call.prompt.includes("description:"), "no placeholder or front matter left");
  assert.ok(!call.prompt.includes("/codex:review-pr"), "the slash text itself isn't what Codex gets");

  await until(() => store.listTasks({ roomId: room.id }).some((t) => t.status === "done"), "the task to finish");
  const task = store.listTasks({ roomId: room.id })[0];
  assert.equal(task.assignee, "codex");
  assert.deepEqual(task.command, { name: "codex:review-pr", agentId: "codex", kind: "prompt", mode: "inline", args: "42" });
  const rec = store.listRouting({ taskId: task.id });
  assert.equal(rec.length, 1);
  assert.equal(rec[0].reason, "command");
  assert.equal(rec[0].chosen, "codex");
  assert.equal(rec[0].kind, "direct");
  assert.ok(store.listMessages(room.id).some((m) => m.author.id === "codex" && m.type === "agent"), "Codex's answer is in the room");
  assert.ok(store.listMessages(room.id).some((m) => /Routed to Codex by \/codex:review-pr/.test(m.text)), "the work log says why");
  // No planning round trip happened.
  assert.ok(!MockAdapter.calls.some((c) => c.kind === "PLAN"));
});

test("2.6 AC2: /claude:<skill> reaches Claude with the skill instruction; a command goes in as its own /name", async () => {
  const { env } = fakeHome();
  const { store, orch, room } = setup();
  refreshCommandIndex(store, { agents: AGENTS }, env);
  MockAdapter.calls.length = 0;

  await orch.handleOwnerMessage(room.id, "/claude:board-deck for Q3 with the new model");
  await until(() => runs().length === 1, "the skill run");
  assert.equal(runs()[0].agentId, "claude");
  assert.match(runs()[0].prompt, /^Use the board-deck skill to handle this request: for Q3 with the new model\./);
  await orch.idle();
  await until(() => store.listTasks({ roomId: room.id }).every((t) => t.status === "done"), "first run to finish");

  // A custom command (and a skill the model may not load itself) starts the prompt with `/<name> <args>`.
  await orch.handleOwnerMessage(room.id, "/claude:ship main");
  await until(() => runs().length === 2, "the command run");
  assert.equal(runs()[1].prompt, "/ship main");
  await until(() => store.listTasks({ roomId: room.id }).every((t) => t.status === "done"), "second run to finish");
  await orch.handleOwnerMessage(room.id, "/claude:review 7");
  await until(() => runs().length === 3, "the plugin command run");
  assert.equal(runs()[2].prompt, "/my-plugin:review 7");
  await until(() => store.listTasks({ roomId: room.id }).every((t) => t.status === "done"), "third run to finish");
  await orch.handleOwnerMessage(room.id, "/claude:release-notes 2.0");
  await until(() => runs().length === 4, "the manual skill run");
  assert.equal(runs()[3].prompt, "/release-notes 2.0");
  await until(() => store.listTasks({ roomId: room.id }).every((t) => t.status === "done"), "fourth run to finish");

  const tasks = store.listTasks({ roomId: room.id });
  assert.deepEqual(tasks.map((t) => t.command?.name).sort(), ["claude:board-deck", "claude:release-notes", "claude:review", "claude:ship"]);
  assert.ok(store.listRouting().every((r) => r.reason === "command"));
});

test("2.6 AC2: Hermes is told to run its skill with the arguments", async () => {
  const { env } = fakeHome();
  const { store, orch, room } = setup();
  refreshCommandIndex(store, { agents: AGENTS }, env);
  MockAdapter.calls.length = 0;
  await orch.handleOwnerMessage(room.id, "/hermes:web-research best bar TV vendors");
  await until(() => runs().length === 1, "the hermes run");
  assert.equal(runs()[0].agentId, "hermes");
  assert.match(runs()[0].prompt, /^Run your web-research skill with: best bar TV vendors\./);
});

test("2.6: a command for an agent that is switched off says so and runs nothing", async () => {
  const { env } = fakeHome();
  const { store, orch, room } = setup();
  refreshCommandIndex(store, { agents: AGENTS }, env);
  const c = store.getAgent("codex")!; c.enabled = false; store.saveAgent(c);
  MockAdapter.calls.length = 0;
  await orch.handleOwnerMessage(room.id, "/codex:review-pr 1");
  await until(() => store.listMessages(room.id).some((m) => m.type === "system"), "the reply");
  assert.match(store.listMessages(room.id).at(-1)!.text, /Codex is switched off/);
  assert.equal(runs().length, 0);
  assert.equal(store.listTasks({ roomId: room.id }).length, 0);
});

test("2.6: an unknown command gets close matches and reaches no agent", async () => {
  const { env } = fakeHome();
  const { store, orch, room } = setup();
  refreshCommandIndex(store, { agents: AGENTS }, env);
  MockAdapter.calls.length = 0;
  await orch.handleOwnerMessage(room.id, "/claude:boad-deck Q3");
  const reply = store.listMessages(room.id).at(-1)!;
  assert.equal(reply.type, "system");
  assert.match(reply.text, /There is no \/claude:boad-deck command\. Close matches: \/claude:board-deck/);
  assert.ok(!reply.text.includes("—"), "no em dashes");
  await orch.handleOwnerMessage(room.id, "/pasue");
  assert.match(store.listMessages(room.id).at(-1)!.text, /Close matches: \/pause/);
  await orch.handleOwnerMessage(room.id, "/zzzzzzzz");
  assert.match(store.listMessages(room.id).at(-1)!.text, /There is no \/zzzzzzzz command\. Type \/ to see what is available\./);
  await orch.idle(); await sleep(50);
  assert.equal(runs().length, 0, "no agent was called");
  assert.equal(store.listGoals(room.id).length, 0);
  assert.equal(store.listTasks({ roomId: room.id }).length, 0);
  // Text that merely starts with a slash (a path) is an ordinary message, not a command.
  const index = loadCommandIndex(store);
  assert.equal(parseCommand("/Users/blake/notes.md is the file I mean", index).kind, "none");
  assert.deepEqual(suggest("claude:board", index, 2).length, 2);
});

test("2.6: Codex prompt expansion: positional, all, named, quoted and literal dollars", () => {
  assert.deepEqual(splitArgs(`a "b c" FOCUS="loading state" T=7`), ["a", "b c", "FOCUS=loading state", "T=7"]);
  assert.equal(expandCodexPrompt("$1-$2 [$ARGUMENTS] $FOCUS $$ $9", `x "y z" FOCUS="loading state"`), `x-y z [x "y z" FOCUS="loading state"] loading state $ `);
  assert.equal(expandCodexPrompt("cost $$1 and $1", "9"), "cost $1 and 9");
  assert.equal(expandCodexPrompt("an argument $FOO stays text: $ARGUMENTS", "$FOO"), "an argument  stays text: $FOO", "arguments are not expanded a second time");
  const { env } = fakeHome();
  const e = buildCommandIndex({ agents: [agent("codex", "codex")] }, env).entries.find((x) => x.name === "codex:draftpr")!;
  const r = buildInvocation(e, `PR_TITLE="Add hero animation" FILES="src/lib/api.ts"`);
  assert.ok(r.ok && /Draft a PR titled Add hero animation touching src\/lib\/api\.ts\./.test(r.invocation.prompt));
  const gone = buildInvocation({ ...e, source: "/nope/missing.md" }, "");
  assert.ok(!gone.ok && /couldn't read/.test(gone.error));
});

// ---------------------------------------------------------------- routing use

test("2.6: planPrompt lists each agent's commands, the best matches first, within the cap", () => {
  const { env } = fakeHome();
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) files[`.codex/prompts/filler-${String(i).padStart(2, "0")}.md`] = `---\ndescription: Filler number ${i} that does something unrelated and quite long to describe in a row\n---\nx\n`;
  const { env: big } = fakeHome(files);
  const index = buildCommandIndex({ agents: AGENTS }, big);
  const agents = setup().store.listAgents();

  const text = plannerCommands(index, ["claude", "codex", "hermes"], "build the board deck for the quarter");
  assert.match(text, /\* claude has \/claude:board-deck/, "the matching skill leads its agent's line");
  assert.match(text, /\* hermes has \/hermes:web-research/);
  assert.ok(text.length <= 1800);
  for (const line of text.split("\n")) assert.ok((line.match(/\/(claude|codex|hermes):/g) ?? []).length <= 6, "at most 6 commands per agent");
  assert.ok(!/filler-3\d/.test(text), "the cap keeps the long tail out");

  const prompt = planPrompt("build the board deck", agents, [], [], "", [], undefined, [], undefined, text);
  assert.match(prompt, /Skills and commands each agent has \(an agent whose skill matches a task is a good owner for it\):\n\* claude has \/claude:board-deck/);
  assert.ok(!planPrompt("hello", agents, [], []).includes("Skills and commands each agent has"), "nothing added when there are none");
  assert.equal(plannerCommands({ at: 0, agents: [], entries: [] }, ["claude"], "x"), "");
  void env;
});

test("2.6: the planner prompt the orchestrator builds carries the index", async () => {
  const { env } = fakeHome();
  const { store, orch, room } = setup();
  refreshCommandIndex(store, { agents: AGENTS }, env);
  MockAdapter.calls.length = 0;
  await orch.handleOwnerMessage(room.id, "Put together the board deck, then write release notes and a short research brief");
  await until(() => MockAdapter.calls.some((c) => c.kind === "PLAN"), "the planner call");
  const plan = MockAdapter.calls.find((c) => c.kind === "PLAN")!;
  assert.match(plan.prompt, /\* claude has [^\n]*\/claude:board-deck/);
  orch.stopRoom(room.id);
  await orch.idle();
});

// ---------------------------------------------------------------- GET /commands and the apps

test("2.6: GET /commands returns groups by agent with descriptions, Room first, and no file paths", async () => {
  const { env } = fakeHome();
  const ctx = setup();
  refreshCommandIndex(ctx.store, { agents: AGENTS }, env);
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    assert.equal((await fetch(`${base}/commands`)).status, 401, "needs a paired device");
    const code = (app as unknown as { pairingCode: () => string }).pairingCode();
    const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
    const res = await fetch(`${base}/commands`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { at: number; groups: { id: string; label: string; commands: { name: string; title: string; description: string; kind: string }[] }[] };
    assert.ok(body.at > 0);
    assert.deepEqual(body.groups.map((g) => [g.id, g.label]), [["room", "Room"], ["claude", "Claude Code"], ["codex", "Codex"], ["hermes", "Hermes"]]);
    assert.equal(body.groups[0].commands[0].name, "pause");
    const claude = body.groups[1].commands;
    const deck = claude.find((c) => c.name === "claude:board-deck")!;
    assert.deepEqual([deck.title, deck.kind], ["Board deck", "skill"]);
    assert.match(deck.description, /quarterly board deck/);
    assert.ok(body.groups.slice(1).every((g) => g.commands.every((c) => c.name.startsWith(`${g.id}:`) && "description" in c)));
    assert.ok(!JSON.stringify(body).includes("SKILL.md"), "local file paths stay on the Mac");
  } finally { await app.close(); }
});

test("2.6: both apps wire the / palette (web app.js and the Mac app's RoomScreen)", () => {
  const web = readFileSync(join(here, "../web/app.js"), "utf8");
  assert.match(web, /api\("\/commands"\)/, "the web app fetches /commands");
  assert.match(web, /\^\\\/\(\\S\*\)\$/, "and watches for a / at the start of the composer");
  assert.match(web, /"data-cmd": c\.name/);
  for (const key of ["ArrowDown", "ArrowUp", "Escape", "Enter"]) assert.ok(web.includes(`"${key}"`), `keyboard: ${key}`);
  assert.match(web, /chooseCommand/);
  assert.match(readFileSync(join(here, "../web/index.html"), "utf8"), /id="palette"/);
  assert.match(readFileSync(join(here, "../web/app.css"), "utf8"), /#palette \{/);
  const room = readFileSync(join(here, "../../app/src/screens/RoomScreen.tsx"), "utf8");
  assert.match(room, /hub\.commands\(\)/);
  assert.match(room, /\^\\\/\(\\S\*\)\$/);
  for (const key of ["ArrowDown", "ArrowUp", "Escape"]) assert.ok(room.includes(`"${key}"`), `Mac keyboard: ${key}`);
  assert.match(readFileSync(join(here, "../../app/src/api/client.ts"), "utf8"), /commands = \(\) => this\.req<CommandsResponse>\("\/commands"\)/);
});
