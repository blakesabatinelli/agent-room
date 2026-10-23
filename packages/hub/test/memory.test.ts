import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MemoryEntry } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { ControlFolder } from "../src/control/folder.js";
import { lint } from "../src/control/lint.js";
import { buildTaskContext } from "../src/control/context.js";
import { MemoryKeeper, type KeeperDeps as MemoryKeeperDeps } from "../src/memory/keeper.js";
import { BEGIN, END, locate, applyBlock } from "../src/memory/export.js";
import { DAY_MS, dateOf, endOfDay } from "../src/memory/model.js";
import { memoryPrompt, directPrompt } from "../src/orchestrator/prompts.js";
import { setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await sleep(15); }
}
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const write = (p: string, text: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

type Reply = Record<string, unknown> | null;
/** A keeper with its own fake keeper-model, clock and home folder; the orchestrator's own keeper is switched off so only this one acts. */
function own(ctx: Ctx, o: { control?: ControlFolder; ask?: (prompt: string) => Reply; clock?: { t: number } } = {}) {
  ctx.orch.memory.close();
  const home = join(ctx.dir, "home");
  const ask = (async (p: string) => (o.ask ? o.ask(p) : { decision: "accept" })) as unknown as MemoryKeeperDeps["ask"];
  const keeper = new MemoryKeeper(
    { store: ctx.store, approvals: ctx.approvals, control: () => o.control, ask, dataDir: ctx.dir },
    { debounceMs: 5, now: o.clock ? () => o.clock!.t : undefined, exportEnv: { home, vars: {} }, log: () => {} },
  );
  return { keeper, home };
}
async function withControl(t: TestContext, ctx: Ctx) {
  const root = join(ctx.dir, "Agent Room");
  const control = new ControlFolder(root, ctx.store, { watch: false, ownerName: "Blake", debounceMs: 20 });
  await control.init();
  t.after(() => control.close());
  return { control, root };
}
const mem = (p: Partial<MemoryEntry> & { id: string; text: string }): MemoryEntry => {
  const createdAt = p.createdAt ?? Date.now();
  return { scope: "shared", sourceAgentId: "claude", confidence: 0.8, createdAt, source: { kind: "owner", at: createdAt }, expiresAt: endOfDay(Date.now() + 30 * DAY_MS), ...p };
};
const inDays = (from: number, n: number) => endOfDay(from + n * DAY_MS);

// ---------------------------------------------------------------- AC1: every fact carries a source and an expiry

test("AC1: every new fact has a source and an expiry, by kind (fact 90, preference 365, status 14)", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const replies: Record<string, Reply> = {
    "Ships on Friday": { decision: "accept" },
    "Prefers short answers": { decision: "accept", kind: "preference" },
    "Currently drafting the Q4 deck": { decision: "accept", kind: "status" },
    "Venue count is 1,200": { decision: "accept", expiresInDays: 7 },
  };
  const { keeper } = own(ctx, { ask: (p) => replies[p.split("PROPOSAL:\n")[1].split("\n")[0]] ?? { decision: "accept" } });
  const at = Date.now();
  for (const text of Object.keys(replies)) await keeper.propose("claude", room.id, text, 0.7, { goalId: "g_12" });
  const rows = store.listShared(room.id);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.source.kind, "goal"); assert.equal(r.source.id, "g_12"); assert.equal(r.source.agentId, "claude"); assert.ok(r.source.at >= at - 1000);
    assert.equal(typeof r.expiresAt, "number");
  }
  const exp = (text: string) => rows.find((r) => r.text === text)!.expiresAt;
  assert.equal(exp("Ships on Friday"), inDays(at, 90));
  assert.equal(exp("Prefers short answers"), inDays(at, 365));
  assert.equal(exp("Currently drafting the Q4 deck"), inDays(at, 14));
  assert.equal(exp("Venue count is 1,200"), inDays(at, 7), "the keeper (or the proposer's hint) can set it");
  assert.ok(rows.every((r) => r.expiresAt === endOfDay(r.expiresAt)), "an expiry is the end of a UTC day, so the file's date and the database agree");
});

test("AC1: the owner's days-by-kind setting is used, and the keeper's prompt asks for a kind, an expiry and a contradiction", async () => {
  const ctx = setup(); const { store, room } = ctx;
  store.setSettings({ ...store.getSettings(), memoryTtlDays: { fact: 30, preference: 200, status: 3 } });
  const { keeper } = own(ctx);
  const at = Date.now();
  await keeper.propose("claude", room.id, "Invoices go to finance", 0.7);
  assert.equal(store.listShared(room.id)[0].expiresAt, inDays(at, 30));
  const p = memoryPrompt("x", [], { source: "goal g_1" });
  assert.match(p, /"kind":"fact"\|"preference"\|"status"/); assert.match(p, /expiresInDays/); assert.match(p, /contradicts/); assert.match(p, /default 14 days/);
});

test("AC1: a row saved without a source or expiry gets both (nothing without them is ever stored)", () => {
  const { store } = setup();
  const row = store.saveMemory({ id: "mem_bare", scope: "shared", text: "No provenance given", sourceAgentId: "codex", confidence: 0.5, createdAt: 1_700_000_000_000 });
  assert.deepEqual(row.source, { kind: "agent", agentId: "codex", at: 1_700_000_000_000 });
  assert.ok(row.expiresAt > Date.now());
  assert.equal(store.getMemory("mem_bare")!.expiresAt, row.expiresAt);
});

test("AC1: goals feed the source: a harvested MEMORY line from a goal task is sourced to that goal, with an expiry", async () => {
  const { store, orch, room } = setup();
  const goal = await orch.runGoal(room.id, "remember things");
  await until(() => store.listShared(room.id).length > 0, "shared memory");
  for (const m of store.listShared(room.id)) { assert.equal(m.source.kind, "goal"); assert.equal(m.source.id, goal.id); assert.ok(m.expiresAt > Date.now()); }
  const priv = store.allMemory().filter((m) => m.scope === "private");
  assert.ok(priv.length > 0 && priv.every((m) => m.source.kind === "goal" && m.source.id === goal.id), "task notes are sourced to the goal");
  assert.ok(priv.every((m) => m.expiresAt <= inDays(Date.now(), 14)), "task notes are status: 14 days");
});

// ---------------------------------------------------------------- migration

test("migration: rows from before 2.5 become source agent + expiry 90 days out, once, audited", () => {
  const ctx = setup(); const { store } = ctx;
  const old = { id: "mem_old1", scope: "shared", roomId: ctx.room.id, text: "Legacy fact", sourceAgentId: "hermes", confidence: 0.6, createdAt: 1_690_000_000_000 };
  const oldPriv = { id: "mem_old2", scope: "private", ownerAgentId: "claude", text: "Legacy note", sourceAgentId: "claude", confidence: 1, createdAt: 1_690_000_100_000 };
  for (const e of [old, oldPriv]) store.db.prepare("INSERT INTO memory (id, scope, owner, room_id, data) VALUES (?,?,?,?,?)").run(e.id, e.scope, (e as { ownerAgentId?: string }).ownerAgentId ?? null, (e as { roomId?: string }).roomId ?? null, JSON.stringify(e));
  assert.equal(store.listShared(ctx.room.id).length, 1, "a legacy row with no expiry is visible until it is migrated");
  const before = Date.now();
  const { keeper } = own(ctx); // a keeper migrates when the hub starts
  const row = store.getMemory("mem_old1")!;
  assert.deepEqual(row.source, { kind: "agent", agentId: "hermes", at: 1_690_000_000_000 });
  assert.equal(row.expiresAt, inDays(before, 90));
  assert.equal(row.text, "Legacy fact");
  assert.equal(row.createdAt, 1_690_000_000_000);
  assert.equal(store.getMemory("mem_old2")!.expiresAt, inDays(before, 90));
  assert.ok(store.listAudit().some((a) => a.action === "memory.migrated" && /2 memory rows/.test(a.detail)));
  assert.equal(keeper.migrate(), 0, "idempotent");
  store.db.prepare("INSERT INTO memory (id, scope, owner, room_id, data) VALUES (?,?,?,?,?)").run("mem_old3", "shared", null, null, JSON.stringify({ id: "mem_old3", scope: "shared", text: "Another", sourceAgentId: "codex", confidence: 1, createdAt: 5 }));
  assert.equal(keeper.migrate(), 1);
  assert.equal(store.getMemory("mem_old1")!.expiresAt, row.expiresAt, "a second pass doesn't push the expiry out");
});

// ---------------------------------------------------------------- expiry

test("expired facts drop out of every read path, stay in the database for 30 days, then are pruned", async (t) => {
  const ctx = setup(); const { store, room } = ctx;
  const { control, root } = await withControl(t, ctx);
  const { keeper } = own(ctx, { control });
  const day0 = Date.now();
  store.saveMemory(mem({ id: "m_live", roomId: room.id, text: "LIVEFACT is current" }));
  store.saveMemory(mem({ id: "m_dead", roomId: room.id, text: "DEADFACT lapsed", expiresAt: day0 - 5 * DAY_MS }));
  store.saveMemory(mem({ id: "m_old", roomId: room.id, text: "ANCIENT lapsed long ago", expiresAt: day0 - 40 * DAY_MS }));
  store.saveMemory(mem({ id: "p_dead", scope: "private", ownerAgentId: "claude", text: "DEADNOTE", expiresAt: day0 - 1000 }));
  // prompts and tools
  assert.deepEqual(store.listShared(room.id).map((m) => m.id), ["m_live"]);
  assert.deepEqual(store.listPrivate("claude"), []);
  const prompt = directPrompt("", store.listShared(room.id), store.listPrivate("claude"));
  assert.ok(prompt.includes("LIVEFACT") && !prompt.includes("DEADFACT") && !prompt.includes("DEADNOTE"));
  // the file and the context built from it
  await keeper.idle();
  const file = read(root, "rooms/general/MEMORY.md");
  assert.ok(file.includes("LIVEFACT") && !file.includes("DEADFACT") && !file.includes("ANCIENT"));
  const ctxText = buildTaskContext({ control: control.snapshot(), agentId: "claude", roomSlug: "general", taskType: "other", goal: { id: "g", text: "t" }, task: { title: "t", description: "d" } });
  assert.ok(ctxText.includes("LIVEFACT") && !ctxText.includes("DEADFACT"));
  // an expired note an owner left in a file never reaches context either
  write(join(root, "agents/claude/MEMORY.md"), `---\nkind: agent-memory\nschema: 1\nupdated: 2026-10-01\nupdated_by: claude\n---\n\n- STALENOTE — source: owner, expires: 2026-01-01\n- FRESHNOTE — source: owner, expires: 2099-01-01\n`);
  await control.load();
  const c2 = buildTaskContext({ control: control.snapshot(), agentId: "claude", roomSlug: "general", taskType: "other", goal: { id: "g", text: "t" }, task: { title: "t", description: "d" }, today: "2026-10-23" });
  assert.ok(c2.includes("FRESHNOTE") && !c2.includes("STALENOTE"));
  // kept 30 days, then pruned
  assert.ok(store.getMemory("m_dead"), "still in the database");
  assert.equal(keeper.sweep(day0), 1, "only the one that lapsed more than 30 days ago");
  assert.equal(store.getMemory("m_old"), undefined);
  assert.ok(store.getMemory("m_dead"));
  assert.equal(keeper.sweep(day0 + 26 * DAY_MS), 1, "m_dead goes 30 days after it lapsed");
  assert.equal(store.getMemory("m_dead"), undefined);
  assert.ok(store.getMemory("m_live"));
});

test("expired facts never reach an agent through MCP read_memory, which shows source and expiry on the rest", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    store.saveMemory(mem({ id: "m1", roomId: room.id, text: "Fresh fact", source: { kind: "goal", id: "g_7", agentId: "codex", at: Date.UTC(2026, 9, 20) }, expiresAt: Date.UTC(2027, 0, 5, 23, 59, 59, 999) }));
    store.saveMemory(mem({ id: "m2", roomId: room.id, text: "Lapsed fact", expiresAt: Date.now() - DAY_MS }));
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const code = (app as unknown as { pairingCode: () => string }).pairingCode();
    const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
    const key = ((await (await fetch(`${base}/mcp-tokens`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: "claude", name: "Claude" }) })).json()) as { token: string }).token;
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    const out = ((await client.callTool({ name: "read_memory", arguments: { roomId: room.id } })).content as { text: string }[])[0].text;
    assert.match(out, /- Fresh fact \(source: goal g_7, Oct 20; expires 2027-01-05\)/);
    assert.ok(!out.includes("Lapsed fact"));
    await client.close();
  } finally { await app.close(); }
});

test("MCP propose_memory: the expiry and source hint land on the fact", async () => {
  const ctx = setup(); const { store } = ctx;
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const code = (app as unknown as { pairingCode: () => string }).pairingCode();
    const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
    const key = ((await (await fetch(`${base}/mcp-tokens`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: "claude", name: "Claude" }) })).json()) as { token: string }).token;
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    const tool = (await client.listTools()).tools.find((x) => x.name === "propose_memory")!;
    assert.ok("expiresInDays" in (tool.inputSchema.properties ?? {}) && "source" in (tool.inputSchema.properties ?? {}));
    await client.callTool({ name: "propose_memory", arguments: { text: "The venue list is final", expiresInDays: 10, source: "the venue sheet" } });
    await until(() => store.allMemory().some((m) => m.text === "The venue list is final"), "the fact");
    const m = store.allMemory().find((x) => x.text === "The venue list is final")!;
    assert.equal(m.expiresAt, inDays(Date.now(), 10));
    assert.deepEqual({ kind: m.source.kind, id: m.source.id, agentId: m.source.agentId }, { kind: "agent", id: "the venue sheet", agentId: "claude" });
    await client.close();
  } finally { await app.close(); }
});

// ---------------------------------------------------------------- renewal

test("renewal: the same fact asserted again from new evidence extends its expiry and updates its source (no duplicate)", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const clock = { t: Date.now() };
  const { keeper } = own(ctx, { clock });
  await keeper.propose("claude", room.id, "Shipping address is 12 Elm St", 0.6, { goalId: "g_1" });
  const first = store.listShared(room.id)[0];
  assert.equal(first.source.id, "g_1");
  clock.t += 60 * DAY_MS;
  const p = await keeper.propose("codex", room.id, "shipping address is 12 Elm St.", 0.9, { goalId: "g_2" });
  assert.equal(p.status, "merged");
  const rows = store.allMemory().filter((m) => m.scope === "shared");
  assert.equal(rows.length, 1, "one fact, not two");
  assert.equal(rows[0].id, first.id);
  assert.equal(rows[0].expiresAt, endOfDay(clock.t + 90 * DAY_MS), "expiry moved out from the new evidence");
  assert.ok(rows[0].expiresAt > first.expiresAt);
  assert.equal(rows[0].source.id, "g_2"); assert.equal(rows[0].source.agentId, "codex"); assert.equal(rows[0].source.at, clock.t);
  assert.equal(rows[0].confidence, 0.9);
  // an expired fact that is asserted again comes back
  store.saveMemory({ ...rows[0], expiresAt: Date.now() - DAY_MS });
  assert.equal(store.listShared(room.id).length, 0);
  await keeper.propose("claude", room.id, "Shipping address is 12 Elm St", 0.6, { goalId: "g_3" });
  assert.equal(store.listShared(room.id).length, 1);
  assert.equal(store.allMemory().filter((m) => m.scope === "shared").length, 1);
  // the keeper can also say "merge" with reworded text: that renews too
  const target = store.listShared(room.id)[0];
  const k2 = own(ctx, { clock, ask: () => ({ decision: "merge", mergeWith: target.id, text: "Shipping address: 12 Elm Street" }) }).keeper;
  clock.t += 10 * DAY_MS;
  await k2.propose("claude", room.id, "Ship to 12 Elm Street", 0.5, { goalId: "g_4" });
  const merged = store.getMemory(target.id)!;
  assert.equal(merged.text, "Shipping address: 12 Elm Street"); assert.equal(merged.source.id, "g_4");
  assert.ok(merged.expiresAt >= endOfDay(clock.t + 90 * DAY_MS));
});

// ---------------------------------------------------------------- AC2: contradictions

const OLD = () => mem({ id: "mem_board", text: "Board meeting is Nov 19", source: { kind: "goal", id: "g_12", agentId: "claude", at: Date.UTC(2026, 9, 20, 15) } });
const openQuestions = (ctx: Ctx) => ctx.store.listApprovals("pending").filter((a) => a.question);

async function contradict(ctx: Ctx, keeper: MemoryKeeper) {
  ctx.store.saveMemory({ ...OLD(), roomId: ctx.room.id });
  return keeper.propose("codex", ctx.room.id, "Board meeting is Nov 12", 0.7, { goalId: "g_99" });
}
const contradictsOld = (p: string) => (/board meeting is nov 12/i.test(p) ?{ decision: "accept", contradicts: "mem_board", expiresInDays: 20 } : { decision: "accept" });

test("AC2: a contradicting proposal makes exactly one owner question and changes nothing yet", async () => {
  const ctx = setup(); const { store } = ctx;
  const { keeper } = own(ctx, { ask: contradictsOld });
  const p = await contradict(ctx, keeper);
  assert.equal(p.status, "asked");
  const qs = openQuestions(ctx);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].action, "Memory: 'Board meeting is Nov 12' contradicts 'Board meeting is Nov 19' (from goal g_12, Oct 20). Which is right?");
  assert.equal(qs[0].tool, "memory");
  assert.deepEqual(qs[0].question!.choices.map((c) => c.id), ["keep_old", "take_new", "drop_both"]);
  assert.equal(qs[0].question!.oldId, "mem_board"); assert.equal(qs[0].question!.proposalId, p.id);
  assert.deepEqual(store.listShared(ctx.room.id).map((m) => m.text), ["Board meeting is Nov 19"], "the stored fact is untouched and nothing replaced it");
  assert.equal(store.getProposal(p.id)!.questionId, qs[0].id);
  assert.equal(store.listProposals("pending").length, 0, "it is a question, not a second card in the Memory list");
  // the same thing proposed again, by anyone, is not asked twice
  const again = await keeper.propose("hermes", ctx.room.id, "Board meeting is Nov 12", 0.9, { goalId: "g_100" });
  const alsoReworded = await keeper.propose("claude", ctx.room.id, "board meeting is nov 12.", 0.5);
  assert.equal(again.status, "rejected"); assert.equal(alsoReworded.status, "rejected");
  assert.equal(openQuestions(ctx).length, 1, "one question per fact pair");
  assert.ok(store.listAudit().some((a) => a.action === "memory.question.duplicate"));
});

test("AC2: two agents proposing the same contradiction at once still produce one question", async () => {
  const ctx = setup();
  const { keeper } = own(ctx, { ask: contradictsOld });
  ctx.store.saveMemory({ ...OLD(), roomId: ctx.room.id });
  await Promise.all([
    keeper.propose("codex", ctx.room.id, "Board meeting is Nov 12", 0.7),
    keeper.propose("claude", ctx.room.id, "Board meeting is Nov 12", 0.7),
    keeper.propose("hermes", ctx.room.id, "Board meeting is Nov 12", 0.7),
  ]);
  assert.equal(openQuestions(ctx).length, 1);
});

test("AC2: the mechanical check from facts.ts catches key: value and negation clashes when the keeper model misses them", async () => {
  const ctx = setup();
  const { keeper } = own(ctx, { ask: () => ({ decision: "accept" }) });
  ctx.store.saveMemory(mem({ id: "m_dl", roomId: ctx.room.id, text: "Deadline: May 3" }));
  ctx.store.saveMemory(mem({ id: "m_bud", roomId: ctx.room.id, text: "Budget is approved" }));
  assert.equal((await keeper.propose("claude", ctx.room.id, "Deadline: May 9", 0.7)).status, "asked");
  assert.equal((await keeper.propose("claude", ctx.room.id, "Budget is not approved", 0.7)).status, "asked");
  assert.equal(openQuestions(ctx).length, 2, "one per pair");
  assert.equal((await keeper.propose("claude", ctx.room.id, "Offices are in Austin", 0.7)).status, "accepted", "no contradiction, no question");
  assert.equal(openQuestions(ctx).length, 2);
});

test("AC2: answer keep_old: the stored fact stays (and is confirmed), the new one is dropped", async () => {
  const ctx = setup(); const { store, approvals } = ctx;
  const { keeper } = own(ctx, { ask: contradictsOld });
  const p = await contradict(ctx, keeper);
  const before = store.getMemory("mem_board")!;
  const q = openQuestions(ctx)[0];
  const done = approvals.decide(q.id, "approved", "owner", "keep_old")!;
  assert.equal(done.status, "approved"); assert.equal(done.choice, "keep_old");
  assert.deepEqual(store.listShared(ctx.room.id).map((m) => m.text), ["Board meeting is Nov 19"]);
  assert.ok(store.getMemory("mem_board")!.expiresAt >= before.expiresAt, "the owner just confirmed it, so it isn't shortened");
  assert.equal(store.getProposal(p.id)!.status, "rejected"); assert.equal(store.getProposal(p.id)!.decidedBy, "owner");
  assert.equal(openQuestions(ctx).length, 0);
  assert.ok(store.listAudit().some((a) => a.actor === "owner" && a.action === "memory.question.resolved" && a.detail.startsWith("keep_old")));
});

test("AC2: answer take_new: the new fact replaces the old, which is expired and linked by supersedes", async () => {
  const ctx = setup(); const { store, approvals } = ctx;
  const { keeper } = own(ctx, { ask: contradictsOld });
  const p = await contradict(ctx, keeper);
  approvals.decide(openQuestions(ctx)[0].id, "approved", "owner", "take_new");
  const live = store.listShared(ctx.room.id);
  assert.deepEqual(live.map((m) => m.text), ["Board meeting is Nov 12"]);
  assert.equal(live[0].supersedes, "mem_board"); assert.equal(live[0].confidence, 1);
  assert.equal(live[0].source.id, "g_99", "the new fact keeps its own source");
  assert.equal(live[0].expiresAt, inDays(Date.now(), 20), "and the expiry the keeper proposed");
  assert.ok(store.getMemory("mem_board")!.expiresAt < Date.now(), "the old row is expired, kept for 30 days");
  assert.equal(store.getProposal(p.id)!.status, "accepted");
});

test("AC2: answer drop_both: neither fact is kept", async () => {
  const ctx = setup(); const { store, approvals } = ctx;
  const { keeper } = own(ctx, { ask: contradictsOld });
  const p = await contradict(ctx, keeper);
  approvals.decide(openQuestions(ctx)[0].id, "approved", "owner", "drop_both");
  assert.deepEqual(store.listShared(ctx.room.id), []);
  assert.ok(store.getMemory("mem_board")!.expiresAt < Date.now());
  assert.equal(store.getProposal(p.id)!.status, "rejected");
  assert.equal(store.allMemory().filter((m) => m.text === "Board meeting is Nov 12").length, 0, "the new wording was never stored");
});

test("AC2: the owner answers over HTTP (Mac and phone use the same call); a plain Reject means keep the old one; a made-up answer is refused", async () => {
  const ctx = setup(); const { store } = ctx;
  const { keeper } = own(ctx, { ask: contradictsOld });
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const code = (app as unknown as { pairingCode: () => string }).pairingCode();
    const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Phone" }) })).json()) as { token: string };
    const post = (id: string, body: unknown) => fetch(`${base}/approvals/${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await contradict(ctx, keeper);
    const listed = (await (await fetch(`${base}/approvals?status=pending`, { headers: { authorization: `Bearer ${token}` } })).json()) as { id: string; question?: { choices: unknown[] } }[];
    assert.equal(listed.filter((a) => a.question).length, 1, "the question shows in the same list as every approval");
    const id = listed.find((a) => a.question)!.id;
    assert.equal((await post(id, { choice: "maybe" })).status, 400);
    assert.equal((await post(id, { decision: "approved" })).status, 400, "an Approve with no answer picked is ambiguous");
    assert.equal(store.getApproval(id)!.status, "pending");
    assert.equal((await post(id, { decision: "rejected" })).status, 200);
    assert.equal(store.getApproval(id)!.choice, "keep_old");
    assert.deepEqual(store.listShared(ctx.room.id).map((m) => m.text), ["Board meeting is Nov 19"]);
    // a second proposal, answered with take_new through the API
    await keeper.propose("codex", ctx.room.id, "Board meeting is Nov 12", 0.7);
    const id2 = openQuestions(ctx)[0].id;
    assert.equal((await post(id2, { choice: "take_new" })).status, 200);
    assert.deepEqual(store.listShared(ctx.room.id).map((m) => m.text), ["Board meeting is Nov 12"]);
    // plain approvals still work as before
    store.saveApproval({ id: "apr_x", agentId: "claude", tool: "gmail", action: "send", detail: "", status: "pending", createdAt: Date.now() });
    assert.equal((await post("apr_x", { decision: "approved" })).status, 200);
    assert.equal(store.getApproval("apr_x")!.status, "approved");
    assert.equal((await post("apr_x", {})).status, 400);
  } finally { await app.close(); }
});

test("AC2: a proposal the keeper couldn't decide waits for the owner, and Keep goes through the same check (a contradiction still asks)", async () => {
  const ctx = setup(); const { store } = ctx;
  const { keeper } = own(ctx, { ask: () => null }); // the keeper model is unavailable
  store.saveMemory(mem({ id: "m_dl", roomId: ctx.room.id, text: "Deadline: May 3" }));
  const p = await keeper.propose("claude", ctx.room.id, "Deadline: May 9", 0.7);
  assert.equal(p.status, "pending");
  keeper.decide(p.id, true);
  assert.equal(store.getProposal(p.id)!.status, "asked", "the owner pressed Keep without seeing the clash; they get the question instead");
  assert.equal(openQuestions(ctx).length, 1);
  const p2 = await keeper.propose("claude", ctx.room.id, "Parking is on level 2", 0.7);
  assert.equal(p2.status, "pending");
  keeper.decide(p2.id, true);
  assert.equal(store.getProposal(p2.id)!.status, "accepted"); assert.equal(store.getProposal(p2.id)!.decidedBy, "owner");
  const entry = store.listShared(ctx.room.id).find((m) => m.text === "Parking is on level 2")!;
  assert.equal(entry.confidence, 1); assert.equal(entry.source.kind, "agent");
});

// ---------------------------------------------------------------- two-way with the control folder

test("files: shared memory is written to rooms/<slug>/MEMORY.md in the spec's format, valid, committed by the orchestrator", async (t) => {
  const ctx = setup(); const { store, room } = ctx;
  const { control, root } = await withControl(t, ctx);
  const { keeper } = own(ctx, { control });
  await keeper.propose("claude", room.id, "Offices are in Austin", 0.7, { goalId: "g_12" });
  store.saveMemory(mem({ id: "m_o", roomId: room.id, text: "Prefers short answers", source: { kind: "owner", at: Date.now() }, expiresAt: Date.UTC(2027, 9, 1, 23, 59, 59, 999) }));
  await keeper.idle();
  const file = read(root, "rooms/general/MEMORY.md");
  assert.match(file, /^---\nkind: room-memory\nschema: 1\nupdated: \d{4}-\d{2}-\d{2}\nupdated_by: orchestrator\n---\n/);
  assert.match(file, new RegExp(`^- Offices are in Austin — source: g_12, expires: ${dateOf(Date.now() + 90 * DAY_MS)}$`, "m"));
  assert.match(file, /^- Prefers short answers — source: owner, expires: 2027-10-01$/m);
  assert.deepEqual(lint(root), { blocks: [], flags: [] });
  const log = git(root, "log", "--format=%an|%s", "--", "rooms/general/MEMORY.md").trim().split("\n");
  assert.ok(log.length >= 1 && log.every((l) => l.startsWith("orchestrator|")), log.join("\n"));
  // global (no room) and direct-message memory stay in the database only
  store.saveMemory(mem({ id: "m_g", text: "GLOBALFACT" }));
  await keeper.idle();
  assert.ok(!read(root, "rooms/general/MEMORY.md").includes("GLOBALFACT"));
  // no churn: nothing changed, so nothing is written
  const n = git(root, "rev-list", "--count", "HEAD").trim();
  keeper["markAllDirty"](); await keeper.idle();
  assert.equal(git(root, "rev-list", "--count", "HEAD").trim(), n);
});

test("files: the owner's edits in MEMORY.md update the database (date, source, added fact, removed fact) and their prose survives", async (t) => {
  const ctx = setup(); const { store, room } = ctx;
  const { control, root } = await withControl(t, ctx);
  const { keeper } = own(ctx, { control });
  await keeper.propose("claude", room.id, "Offices are in Austin", 0.7, { goalId: "g_12" });
  await keeper.propose("claude", room.id, "Fiscal year starts in July", 0.7, { goalId: "g_12" });
  await keeper.propose("claude", room.id, "Legal is Dana", 0.7, { goalId: "g_12" });
  await keeper.idle();
  const path = join(root, "rooms/general/MEMORY.md");
  const text = readFileSync(path, "utf8")
    .replace(/(- Offices are in Austin — source: )g_12(, expires: )\d{4}-\d{2}-\d{2}/, (_m, a: string, b: string) => `${a}owner${b}2030-01-15`)
    .replace(/^- Legal is Dana.*\n/m, "")
    .replace(/\n+$/, "\n") + "- Parking is validated on level 2\n\nNotes to self: keep this short.\n";
  writeFileSync(path, text.replace("---\n\n", "---\n\nMy own heading line.\n\n"));
  await control.load(); await keeper.idle();
  const rows = store.allMemory().filter((m) => m.scope === "shared");
  const austin = rows.find((m) => m.text === "Offices are in Austin")!;
  assert.equal(dateOf(austin.expiresAt), "2030-01-15"); assert.equal(austin.source.kind, "owner");
  assert.ok(!rows.some((m) => m.text === "Legal is Dana"), "a line the owner deleted is gone from the database");
  const added = rows.find((m) => m.text === "Parking is validated on level 2")!;
  assert.equal(added.source.kind, "owner"); assert.equal(added.confidence, 1); assert.equal(added.expiresAt, inDays(Date.now(), 90));
  assert.ok(rows.some((m) => m.text === "Fiscal year starts in July"), "untouched facts stay");
  await until(() => /Parking is validated on level 2 — source: owner, expires:/.test(readFileSync(path, "utf8")), "the hand-written line to get its source and expiry");
  const after = readFileSync(path, "utf8");
  assert.ok(after.includes("My own heading line.") && after.includes("Notes to self: keep this short."), "prose the owner wrote stays");
  assert.ok(after.includes("- Offices are in Austin — source: owner, expires: 2030-01-15"), "the line they edited is exactly as they typed it");
  assert.deepEqual(lint(root).blocks, []);
});

test("files: a fact edited in the app (or deleted) reaches the file", async (t) => {
  const ctx = setup(); const { store, room } = ctx;
  const { control, root } = await withControl(t, ctx);
  const { keeper } = own(ctx, { control });
  await keeper.propose("claude", room.id, "Offices are in Austin", 0.7, { goalId: "g_12" });
  await keeper.propose("claude", room.id, "Fiscal year starts in July", 0.7, { goalId: "g_12" });
  await keeper.idle();
  const a = store.listShared(room.id).find((m) => m.text.includes("Austin"))!, b = store.listShared(room.id).find((m) => m.text.includes("Fiscal"))!;
  keeper.ownerEdit(a.id, "Offices are in Dallas");
  store.deleteMemory(b.id);
  await keeper.idle();
  const file = read(root, "rooms/general/MEMORY.md");
  assert.match(file, /^- Offices are in Dallas — source: owner, expires:/m);
  assert.ok(!file.includes("Austin") && !file.includes("Fiscal"));
});

test("files: after each answer to a contradiction the file follows", async (t) => {
  for (const choice of ["keep_old", "take_new", "drop_both"] as const) {
    const ctx = setup();
    const { control, root } = await withControl(t, ctx);
    const { keeper } = own(ctx, { control, ask: contradictsOld });
    ctx.store.saveMemory({ ...OLD(), roomId: ctx.room.id, expiresAt: Date.UTC(2099, 11, 31, 23, 59, 59, 999) });
    await keeper.propose("codex", ctx.room.id, "Board meeting is Nov 12", 0.7, { goalId: "g_99" });
    await keeper.idle();
    const asked = read(root, "rooms/general/MEMORY.md");
    assert.ok(asked.includes("Board meeting is Nov 19 — source: g_12, expires: 2099-12-31") && !asked.includes("Nov 12"), "while the question is open the file keeps the old fact only");
    ctx.approvals.decide(openQuestions(ctx)[0].id, "approved", "owner", choice);
    await keeper.idle();
    const file = read(root, "rooms/general/MEMORY.md");
    assert.equal(file.includes("Board meeting is Nov 19"), choice === "keep_old", `${choice}: old`);
    assert.equal(file.includes("Board meeting is Nov 12 — source: g_99"), choice === "take_new", `${choice}: new`);
    assert.ok(git(root, "log", "--format=%an", "--", "rooms/general/MEMORY.md").split("\n").every((a) => !a || a === "orchestrator"));
    keeper.close();
  }
});

test("files: room MEMORY.md stays under 16 KB, dropping the lowest-confidence facts first; the database keeps them", async (t) => {
  const ctx = setup(); const { store, room } = ctx;
  const { control, root } = await withControl(t, ctx);
  const { keeper } = own(ctx, { control });
  const t0 = Date.now();
  for (let i = 0; i < 90; i++) store.saveMemory(mem({ id: `m_${String(i).padStart(2, "0")}`, roomId: room.id, text: `FACT-${String(i).padStart(2, "0")} ${"x".repeat(150)}`, confidence: i < 30 ? 0.2 : 0.9, createdAt: t0 + i }));
  await keeper.idle();
  const file = read(root, "rooms/general/MEMORY.md");
  assert.ok(Buffer.byteLength(file) <= 16 * 1024, `${Buffer.byteLength(file)} bytes`);
  assert.deepEqual(lint(root).blocks, [], "under the cap the linter loads it");
  const inFile = [...file.matchAll(/FACT-(\d\d)/g)].map((m) => Number(m[1]));
  assert.ok(inFile.length > 60 && inFile.length < 90, `${inFile.length} facts in the file`);
  for (let i = 30; i < 90; i++) assert.ok(inFile.includes(i), `high-confidence FACT-${i} is kept`);
  const lowKept = inFile.filter((n) => n < 30), lowGone = Array.from({ length: 30 }, (_, i) => i).filter((n) => !inFile.includes(n));
  assert.ok(lowGone.length > 0 && Math.min(...lowKept) > Math.max(...lowGone), "of the low-confidence ones, the oldest went first");
  assert.equal(store.listShared(room.id).length, 90, "nothing was deleted, only left out of the file");
  assert.ok(store.listAudit().some((a) => a.action === "memory.file.capped"));
  // reloading the file doesn't mistake the facts that were never in it for lines the owner deleted
  await control.load(); await keeper.idle();
  assert.equal(store.listShared(room.id).length, 90);
});

test("files: an agent's own MEMORY.md follows its private notes within 8 KB", async (t) => {
  const ctx = setup(); const { store } = ctx;
  const { control, root } = await withControl(t, ctx);
  const { keeper } = own(ctx, { control });
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) store.saveMemory(mem({ id: `p_${i}`, scope: "private", ownerAgentId: "claude", text: `NOTE-${String(i).padStart(2, "0")} ${"y".repeat(200)}`, confidence: 1, createdAt: t0 + i }));
  store.saveMemory(mem({ id: "p_dead", scope: "private", ownerAgentId: "claude", text: "EXPIREDNOTE", expiresAt: t0 - DAY_MS }));
  await keeper.idle();
  const file = read(root, "agents/claude/MEMORY.md");
  assert.match(file, /^---\nkind: agent-memory\nschema: 1\n/);
  assert.ok(Buffer.byteLength(file) <= 8 * 1024);
  assert.ok(!file.includes("EXPIREDNOTE"));
  assert.ok(file.includes("NOTE-59") && !file.includes("NOTE-00"), "newest kept when confidence ties");
  assert.deepEqual(lint(root).blocks, []);
});

test("files: a MEMORY.md the owner broke is left alone (the linter tells them) and nothing is lost", async (t) => {
  const ctx = setup(); const { store, room } = ctx;
  const { control, root } = await withControl(t, ctx);
  const { keeper } = own(ctx, { control });
  await keeper.propose("claude", room.id, "Offices are in Austin", 0.7);
  await keeper.idle();
  const path = join(root, "rooms/general/MEMORY.md");
  writeFileSync(path, "this is not front matter\n- Offices are in Austin\n");
  await control.load(); await keeper.propose("claude", room.id, "Fiscal year starts in July", 0.7); await keeper.idle();
  assert.equal(readFileSync(path, "utf8"), "this is not front matter\n- Offices are in Austin\n");
  assert.equal(store.listShared(room.id).length, 2);
});

// ---------------------------------------------------------------- AC3: export to agents' own context files

const ORIGINAL = "# My Claude rules\n\nBe terse. No emojis.\n\n- never use semicolons\n\nTrailing note without a final newline";
function exportSetup(ctx: Ctx, o: { claude?: string | null; codex?: string | null } = {}) {
  const { keeper, home } = own(ctx);
  if (o.claude !== null) write(join(home, ".claude/CLAUDE.md"), o.claude ?? ORIGINAL);
  if (o.codex !== undefined && o.codex !== null) write(join(home, ".codex/AGENTS.md"), o.codex);
  return { keeper, home, claudeFile: join(home, ".claude/CLAUDE.md"), backup: join(ctx.dir, "memory-export", "claude-CLAUDE.md.original") };
}
const enable = (ctx: Ctx, id: string, on = true) => { const a = ctx.store.getAgent(id)!; a.settings = { ...a.settings, memoryExport: on }; ctx.store.saveAgent(a); };

test("AC3: export is off by default: with shared memory and every file in place, nothing is touched", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const { keeper, home, claudeFile } = exportSetup(ctx, { codex: "codex own rules\n" });
  store.saveMemory(mem({ id: "m1", roomId: room.id, text: "Offices are in Austin" }));
  assert.equal(store.getAgent("claude")!.settings.memoryExport, undefined);
  await keeper.idle();
  keeper.exportNow();
  assert.equal(readFileSync(claudeFile, "utf8"), ORIGINAL);
  assert.equal(readFileSync(join(home, ".codex/AGENTS.md"), "utf8"), "codex own rules\n");
  assert.ok(!existsSync(join(ctx.dir, "memory-export")), "not even a backup");
  assert.ok(!store.listAudit().some((a) => a.action.startsWith("memory.export")));
  const info = keeper.exportInfo().find((i) => i.agentId === "claude")!;
  assert.equal(info.enabled, false); assert.equal(info.supported, true);
  assert.equal(info.file, "~/.claude/CLAUDE.md"); assert.equal(info.capBytes, 4096);
});

test("AC3: export writes only between the markers, within the cap, highest confidence and newest first, and keeps the rest byte for byte", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const { keeper, claudeFile } = exportSetup(ctx);
  store.setSettings({ ...store.getSettings(), memoryExportBytes: 700 });
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) store.saveMemory(mem({ id: `m${i}`, roomId: room.id, text: `EXPORTFACT-${String(i).padStart(2, "0")} ${"z".repeat(60)}`, confidence: i % 2 ? 0.95 : 0.5, createdAt: t0 + i }));
  store.saveMemory(mem({ id: "m_dead", roomId: room.id, text: "EXPIREDFACT", expiresAt: t0 - DAY_MS, confidence: 1 }));
  enable(ctx, "claude");
  const r = keeper.exportNow("claude")[0];
  assert.equal(r.status, "written");
  const text = readFileSync(claudeFile, "utf8");
  const b = text.indexOf(BEGIN), e = text.indexOf(END) + END.length;
  assert.ok(b > 0 && e > b);
  assert.equal(text.slice(0, b), ORIGINAL + "\n\n", "everything before the block is the owner's, unchanged");
  assert.equal(text.slice(e), "\n", "and nothing after it");
  const block = text.slice(b, e);
  assert.ok(Buffer.byteLength(block) <= 700, `${Buffer.byteLength(block)} bytes`);
  const shown = [...block.matchAll(/EXPORTFACT-(\d\d)/g)].map((m) => Number(m[1]));
  assert.ok(shown.length >= 3 && shown.length < 20);
  assert.ok(shown.every((n) => n % 2 === 1), "high confidence first: the 0.95 ones fill the cap before any 0.5");
  assert.deepEqual(shown, [...shown].sort((a, b) => b - a), "newest first within a confidence");
  assert.ok(!block.includes("EXPIREDFACT"));
  assert.match(block, /<!-- \d+ more not shown: over the 700 byte cap -->/);
  assert.match(block, /\(until \d{4}-\d{2}-\d{2}\)/);
  assert.ok(store.listAudit().some((a) => a.action === "memory.export" && a.detail.startsWith("claude: wrote") && a.detail.includes("~/.claude/CLAUDE.md")));
  // it changes with the facts and never touches the owner's text
  store.saveMemory(mem({ id: "m_new", roomId: room.id, text: "BRANDNEW fact", confidence: 1, createdAt: t0 + 100 }));
  assert.equal(keeper.exportNow("claude")[0].status, "written");
  const text2 = readFileSync(claudeFile, "utf8");
  assert.ok(text2.includes("BRANDNEW") && text2.startsWith(ORIGINAL + "\n\n" + BEGIN));
  assert.equal(text2.indexOf(BEGIN), b); assert.equal(text2.split(BEGIN).length, 2, "one block");
});

test("AC3: the owner's original file is backed up once, before the first change", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const { keeper, claudeFile, backup } = exportSetup(ctx);
  store.saveMemory(mem({ id: "m1", roomId: room.id, text: "First fact" }));
  enable(ctx, "claude");
  keeper.exportNow("claude");
  assert.equal(readFileSync(backup, "utf8"), ORIGINAL, "the backup is the file as the owner left it");
  store.saveMemory(mem({ id: "m2", roomId: room.id, text: "Second fact" }));
  keeper.exportNow("claude");
  writeFileSync(claudeFile, readFileSync(claudeFile, "utf8") + "\nOwner added this later.\n");
  store.saveMemory(mem({ id: "m3", roomId: room.id, text: "Third fact" }));
  keeper.exportNow("claude");
  assert.equal(readFileSync(backup, "utf8"), ORIGINAL, "never overwritten");
  assert.deepEqual(readdirSync(join(ctx.dir, "memory-export")), ["claude-CLAUDE.md.original"]);
  assert.equal(store.listAudit().filter((a) => a.action === "memory.export.backup").length, 1);
  assert.ok(readFileSync(claudeFile, "utf8").endsWith("Owner added this later.\n"), "text the owner added after the block is kept");
});

test("AC3: export rewrites only when the content changed (no write, no audit, no new mtime when it hasn't)", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const { keeper, claudeFile } = exportSetup(ctx);
  store.saveMemory(mem({ id: "m1", roomId: room.id, text: "Stable fact" }));
  enable(ctx, "claude");
  assert.equal(keeper.exportNow("claude")[0].status, "written");
  const bytes1 = readFileSync(claudeFile); const m1 = lstatSync(claudeFile).mtimeMs;
  const exports = () => store.listAudit().filter((a) => a.action === "memory.export").length;
  const n = exports();
  await sleep(20);
  for (let i = 0; i < 3; i++) assert.equal(keeper.exportNow("claude")[0].status, "unchanged");
  assert.deepEqual(readFileSync(claudeFile), bytes1); assert.equal(lstatSync(claudeFile).mtimeMs, m1); assert.equal(exports(), n);
  // a fact that expires drops out of the block at the next run
  store.saveMemory({ ...store.getMemory("m1")!, expiresAt: Date.now() - 1 });
  assert.equal(keeper.exportNow("claude")[0].status, "written");
  assert.ok(!readFileSync(claudeFile, "utf8").includes("Stable fact"));
});

test("AC3: switching export off (or having nothing left to share) takes the block out and restores the file exactly", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const { keeper, claudeFile } = exportSetup(ctx, { claude: "# Mine\n\nKeep me.\n" });
  store.saveMemory(mem({ id: "m1", roomId: room.id, text: "A fact" }));
  enable(ctx, "claude");
  keeper.exportNow("claude");
  assert.ok(readFileSync(claudeFile, "utf8").includes(BEGIN));
  enable(ctx, "claude", false);
  assert.equal(keeper.exportNow("claude")[0].status, "removed");
  assert.equal(readFileSync(claudeFile, "utf8"), "# Mine\n\nKeep me.\n");
  assert.equal(keeper.exportNow("claude")[0].status, "off", "and then it leaves the file alone");
  enable(ctx, "claude");
  keeper.exportNow("claude");
  store.deleteMemory("m1");
  keeper.exportNow("claude");
  assert.equal(readFileSync(claudeFile, "utf8"), "# Mine\n\nKeep me.\n", "no facts, no block");
});

test("AC3: the scheduled path exports too: a new fact reaches the file after the debounce, and only the rooms the agent is in", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const { keeper, home, claudeFile } = exportSetup(ctx, { codex: "codex rules\n" });
  enable(ctx, "claude"); enable(ctx, "codex");
  const dm = store.dmRoom("claude", "Claude");
  store.saveMemory(mem({ id: "m_room", roomId: room.id, text: "ROOMFACT everyone" }));
  store.saveMemory(mem({ id: "m_dm", roomId: dm.id, text: "DMFACT claude only" }));
  store.saveMemory(mem({ id: "m_global", text: "GLOBALFACT everyone" }));
  await keeper.idle();
  const claude = readFileSync(claudeFile, "utf8"), codex = readFileSync(join(home, ".codex/AGENTS.md"), "utf8");
  for (const f of ["ROOMFACT", "DMFACT", "GLOBALFACT"]) assert.ok(claude.includes(f), `claude ${f}`);
  assert.ok(codex.includes("ROOMFACT") && codex.includes("GLOBALFACT") && !codex.includes("DMFACT"), "codex isn't in claude's direct-message room");
  assert.ok(codex.startsWith("codex rules\n"));
  assert.match(codex, /AGENTS|Agent Room/);
});

test("AC3: unsupported agents get nothing; a missing folder or damaged markers are left alone and reported", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const { keeper, home, claudeFile } = exportSetup(ctx);
  store.saveMemory(mem({ id: "m1", roomId: room.id, text: "A fact" }));
  store.saveAgent({ id: "muse", name: "Muse", provider: "mcp", adapter: "mcp", enabled: true, color: "#5A6B7D", settings: { memoryExport: true }, tools: {} });
  enable(ctx, "codex");
  const res = keeper.exportNow();
  assert.ok(res.find((r) => r.agentId === "muse")!.status === "unsupported");
  assert.equal(keeper.exportInfo().find((i) => i.agentId === "muse")!.supported, false);
  assert.equal(res.find((r) => r.agentId === "codex")!.status, "skipped", "no ~/.codex on this Mac");
  assert.ok(!existsSync(join(home, ".codex")), "the folder wasn't created");
  assert.match(keeper.exportInfo().find((i) => i.agentId === "codex")!.note ?? "", /doesn't exist yet/);
  // damaged markers
  const broken = `${ORIGINAL}\n${BEGIN}\nhalf a block\n`;
  writeFileSync(claudeFile, broken);
  enable(ctx, "claude");
  const r = keeper.exportNow("claude")[0];
  assert.equal(r.status, "skipped"); assert.match(r.detail, /unpaired or repeated/);
  assert.equal(readFileSync(claudeFile, "utf8"), broken);
  assert.equal(locate(`${BEGIN}a${END}${BEGIN}b${END}`), "damaged"); assert.equal(locate(`${END}a${BEGIN}`), "damaged");
});

test("AC3: Codex and Hermes find their files where their docs say, honouring CODEX_HOME and HERMES_HOME; Hermes's 2,200 character limit holds", async () => {
  const ctx = setup(); const { store, room } = ctx;
  ctx.orch.memory.close();
  const home = join(ctx.dir, "h");
  const keeper = new MemoryKeeper({ store, approvals: ctx.approvals, control: () => undefined, ask: async () => null, dataDir: ctx.dir },
    { debounceMs: 5, exportEnv: { home, vars: { CODEX_HOME: join(ctx.dir, "elsewhere/codex") } }, log: () => {} });
  write(join(ctx.dir, "elsewhere/codex/AGENTS.md"), "codex mine\n");
  const hermesOwn = "Owner likes tea.\n§\nRepo lives in ~/code.\n";
  write(join(home, ".hermes/memories/MEMORY.md"), hermesOwn);
  assert.equal(keeper.exportInfo().find((i) => i.agentId === "codex")!.file, join(ctx.dir, "elsewhere/codex/AGENTS.md"));
  assert.equal(keeper.exportInfo().find((i) => i.agentId === "hermes")!.file, "~/.hermes/memories/MEMORY.md");
  for (let i = 0; i < 30; i++) store.saveMemory(mem({ id: `m${i}`, roomId: room.id, text: `HERMESFACT-${i} ${"w".repeat(80)}`, createdAt: Date.now() + i }));
  enable(ctx, "codex"); enable(ctx, "hermes");
  keeper.exportNow();
  assert.ok(readFileSync(join(ctx.dir, "elsewhere/codex/AGENTS.md"), "utf8").includes("HERMESFACT-29"));
  const h = readFileSync(join(home, ".hermes/memories/MEMORY.md"), "utf8");
  assert.ok(h.startsWith(hermesOwn), "Hermes's own notes are kept as they were");
  assert.ok(h.length <= 2200, `${h.length} characters`);
  assert.ok(h.includes(BEGIN) && h.includes("HERMESFACT-29"));
  assert.equal(keeper.exportInfo().find((i) => i.agentId === "hermes")!.capBytes, 2200);
  // when its own notes already fill the file, nothing is written
  write(join(home, ".hermes/memories/MEMORY.md"), "n".repeat(2190));
  const r = keeper.exportNow("hermes")[0];
  assert.equal(r.status, "unchanged");
  assert.equal(readFileSync(join(home, ".hermes/memories/MEMORY.md"), "utf8"), "n".repeat(2190));
});

test("AC3: a symlinked CLAUDE.md is written through and stays a link; CRLF files keep their line endings", async () => {
  const ctx = setup(); const { store, room } = ctx;
  const { keeper, home } = exportSetup(ctx, { claude: null });
  write(join(ctx.dir, "dotfiles/CLAUDE.md"), "linked rules\r\nline two\r\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  symlinkSync(join(ctx.dir, "dotfiles/CLAUDE.md"), join(home, ".claude/CLAUDE.md"));
  store.saveMemory(mem({ id: "m1", roomId: room.id, text: "A fact" }));
  enable(ctx, "claude");
  keeper.exportNow("claude");
  assert.ok(lstatSync(join(home, ".claude/CLAUDE.md")).isSymbolicLink());
  const real = readFileSync(join(ctx.dir, "dotfiles/CLAUDE.md"), "utf8");
  assert.ok(real.startsWith("linked rules\r\nline two\r\n\r\n" + BEGIN + "\r\n") && real.includes("A fact") && !/[^\r]\n/.test(real.slice(0, real.indexOf(END))));
});

test("applyBlock: round trip restores a file that ended with a newline; a new file is just the block", () => {
  const orig = "line one\nline two\n";
  const block = [BEGIN, "x", END];
  const withBlock = applyBlock(orig, block) as string;
  assert.equal(withBlock, `${orig}\n${BEGIN}\nx\n${END}\n`);
  assert.equal(applyBlock(withBlock, null), orig);
  assert.equal(applyBlock("", block), `${BEGIN}\nx\n${END}\n`);
  assert.equal(applyBlock(orig, null), orig);
  assert.equal(applyBlock(`a\n${BEGIN}`, block), "damaged");
});
