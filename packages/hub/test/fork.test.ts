import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, Fork, ForkView, Goal } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { familyOf } from "../src/jury/family.js";
import { defaultSplit, parseForkLine, resolveRoster, scrubber } from "../src/fork/model.js";
import { mergeVerdicts, pickJudges } from "../src/fork/compare.js";
import { forkPreference, listPreferences } from "../src/fork/records.js";
import { listFiles } from "../src/orchestrator/workspace.js";
import { setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 20_000) { for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20); assert.ok(fn(), "timed out waiting"); }
const dir = (p = "fk-") => realpathSync(mkdtempSync(join(tmpdir(), p)));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const compareCalls = () => MockAdapter.calls.filter((c) => c.kind === "COMPARE");

/** Five mock agents from five model families: claude, codex, hermes, muse, and gemini (who is on neither roster, so the judges are outside both). */
function ctx(o: Parameters<typeof setup>[0] = {}): Ctx {
  const c = setup(o);
  const base = c.store.getAgent("claude")!;
  c.store.saveAgent({ ...base, id: "muse", name: "Muse", provider: "muse", color: "#A63A86", settings: { quality: 0.85 }, canBeOrchestrator: false });
  c.store.saveAgent({ ...base, id: "gemini", name: "Gemini", provider: "google", color: "#4285F4", settings: { quality: 0.85, model: "gemini-3-pro" }, canBeOrchestrator: false });
  c.store.setSettings({ ...c.store.getSettings(), planApproval: "never", autoRunChecks: true });
  MockAdapter.calls.length = 0;
  return c;
}
/** Agents whose plans write real files (research.md, summary.md) and check them. The others plan the same tasks with no files. */
function withFiles(c: Ctx, ids: string[]) { for (const id of ids) { const a = c.store.getAgent(id)!; c.store.saveAgent({ ...a, settings: { ...a.settings, checks: true } }); } }
const setting = (c: Ctx, id: string, extra: Record<string, unknown>) => { const a = c.store.getAgent(id)!; c.store.saveAgent({ ...a, settings: { ...a.settings, ...extra } }); };

async function startFork(c: Ctx, text = "Summarize the venue TV market", o: { a?: string[]; b?: string[]; folderGrantId?: string } = {}): Promise<Fork> {
  const r = await c.orch.forks.start({ roomId: c.room.id, text, rosterA: o.a ?? ["claude", "codex"], rosterB: o.b ?? ["hermes", "muse"], folderGrantId: o.folderGrantId });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.fork;
}
async function finish(c: Ctx, f: Fork): Promise<Fork> {
  await c.orch.forks.settled(f.id);
  await c.orch.idle();
  const g = c.orch.forks.get(f.id)!;
  await until(() => !!c.orch.forks.get(f.id)!.comparison, 20_000);
  return c.orch.forks.get(f.id) ?? g;
}
const goalOf = (c: Ctx, f: Fork, side: "a" | "b"): Goal => c.store.getGoal(f.sides.find((s) => s.side === side)!.goalId)!;
const view = async (c: Ctx, f: Fork): Promise<ForkView> => (await c.orch.forks.view(f.id))!;
const family = (c: Ctx, id: string) => familyOf(c.store.getAgent(id)!);

/** A file the agents write has the writer's name in it: the roster it came from is readable from the content. */
const text = (path: string) => readFileSync(path, "utf8");

// ============================================================ the pure parts

test("the /fork line: goal text, rosterA, rosterB in any order; names with @ or spaces; a bare /fork", () => {
  assert.deepEqual(parseForkLine("/fork"), { ok: true, req: {} });
  assert.deepEqual(parseForkLine("/fork Write the plan | rosterA: claude,codex | rosterB: hermes, @muse"), { ok: true, req: { text: "Write the plan", rosterA: ["claude", "codex"], rosterB: ["hermes", "muse"] } });
  assert.deepEqual(parseForkLine("/FORK rosterB: hermes | a: claude codex | Write it"), { ok: true, req: { text: "Write it", rosterA: ["claude", "codex"], rosterB: ["hermes"] } });
  assert.deepEqual(parseForkLine("/fork rosterA: claude"), { ok: true, req: { rosterA: ["claude"] } });
  const bad = parseForkLine("/fork x | rosterA:");
  assert.ok(!bad.ok && /Roster A is empty/.test(bad.error));
  assert.ok(!parseForkLine("/fork x | rosterA: a | rosterA: b").ok, "a roster given twice is refused");
  const c = setup();
  assert.deepEqual(resolveRoster(["Claude", "CODEX", "nobody", "claude"], c.store.listAgents()), { ids: ["claude", "codex"], unknown: ["nobody"] });
});

test("the default split puts different vendors on each side and keeps a family together", () => {
  const c = ctx();
  const agents = c.store.listAgents();
  const fam = (a: AgentConfig) => familyOf(a);
  const split = defaultSplit(agents, fam) as { a: string[]; b: string[] };
  assert.deepEqual([...split.a, ...split.b].sort(), agents.map((x) => x.id).sort(), "everyone is on one side");
  assert.ok(split.a.length && split.b.length);
  assert.ok(!split.a.some((x) => split.b.some((y) => fam(c.store.getAgent(x)!) === fam(c.store.getAgent(y)!))), "no model family is on both sides");
  // two agents of one family on one side, one other: the family stays together
  const twin = { ...c.store.getAgent("claude")!, id: "claude2", name: "Claude Two" };
  const s2 = defaultSplit([c.store.getAgent("claude")!, twin, c.store.getAgent("codex")!], fam) as { a: string[]; b: string[] };
  assert.deepEqual([s2.a, s2.b].map((x) => x.sort()).sort(), [["claude", "claude2"], ["codex"]]);
  // one family only: dealt out in turn
  const s3 = defaultSplit([c.store.getAgent("claude")!, twin], fam) as { a: string[]; b: string[] };
  assert.deepEqual(s3, { a: ["claude"], b: ["claude2"] });
  assert.ok("error" in defaultSplit([c.store.getAgent("claude")!], fam));
  assert.ok("error" in defaultSplit([], fam));
});

test("the blind text: agent names, ids, providers, models and vendor words are taken out", () => {
  const c = ctx();
  const scrub = scrubber(c.store.listAgents());
  const out = scrub("Claude and @codex (openai) agree with Hermes; Gemini-3-pro said so. Muse wrote muse-notes.md. Anthropic. Fine: the venue list, 42 bars.");
  assert.doesNotMatch(out, /claude|codex|openai|hermes|gemini|muse|anthropic/i, out);
  assert.match(out, /42 bars/, "everything else stays");
  assert.equal(scrub("a museum of music"), "a museum of music", "a word that only contains a name is left alone");
});

test("two passes agree, disagree, or one is unsure: the merged verdict", () => {
  assert.equal(mergeVerdicts("PASS", "PASS"), "PASS");
  assert.equal(mergeVerdicts("PASS", "FAIL"), "UNSURE");
  assert.equal(mergeVerdicts("UNSURE", "FAIL"), "FAIL");
  assert.equal(mergeVerdicts(undefined, "PASS"), "PASS");
});

test("judges come from outside both rosters' families when anyone there is ready; else anyone, and it says so", () => {
  const c = ctx();
  const get = (...ids: string[]) => ids.map((x) => c.store.getAgent(x)!);
  const r = (workers: string[]) => pickJudges({ ready: c.store.listAgents(), workers: get(...workers), localModels: [], limited: () => false, rotation: [] });
  const out = r(["claude", "codex", "hermes", "muse"]);
  assert.deepEqual(out.judges.map((x) => x.id), ["gemini"]);
  assert.equal(out.independence, "full");
  const all = r(["claude", "codex", "hermes", "muse", "gemini"]);
  assert.equal(all.independence, "partial");
  assert.equal(all.judges.length, 5);
  assert.deepEqual(pickJudges({ ready: get("gemini"), workers: get("claude"), localModels: [], limited: (x) => x === "gemini", rotation: [] }).judges, [], "an agent out of quota doesn't judge");
});

// ============================================================ AC1: two rosters on the same goal

test("AC1: /fork with two rosters makes two goals; their tasks, routing and judges stay with their roster; their folders are independent", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  await c.orch.handleOwnerMessage(c.room.id, "/fork Summarize the venue TV market | rosterA: claude,codex | rosterB: hermes,muse");
  await until(() => c.orch.forks.list(c.room.id).length === 1);
  const f0 = c.orch.forks.list(c.room.id)[0];
  const f = await finish(c, f0);

  assert.deepEqual(f.sides.map((s) => s.roster), [["claude", "codex"], ["hermes", "muse"]]);
  const card = c.store.listMessages(c.room.id).find((m) => m.forkId === f.id);
  assert.ok(card && /Side A: Claude, Codex/.test(card.text) && /Side B: Hermes, Muse/.test(card.text), "the room shows one fork card with both lanes");
  assert.equal(c.store.listGoals(c.room.id).length, 0, "the two goals live in their own lanes, not in the room");
  assert.deepEqual(c.store.listRooms().filter((r) => r.forkId === f.id).map((r) => r.forkSide).sort(), ["a", "b"]);

  const ga = goalOf(c, f, "a"), gb = goalOf(c, f, "b");
  assert.equal(ga.text, "Summarize the venue TV market");
  assert.equal(gb.text, ga.text, "the same goal text on both sides");
  assert.equal(ga.status, "done"); assert.equal(gb.status, "done");
  assert.equal(ga.fork?.side, "a"); assert.equal(gb.fork?.side, "b");
  assert.equal(ga.state?.progress?.budget, 20, "the run budget (40) is split between the sides");
  assert.equal(gb.state?.progress?.budget, 20);

  for (const [g, side] of [[ga, f.sides[0]], [gb, f.sides[1]]] as const) {
    const tasks = c.store.listTasks({ goalId: g.id });
    assert.ok(tasks.length >= 2, "each side planned and ran its own tasks");
    for (const t of tasks) {
      assert.ok(side.roster.includes(t.assignee!), `${t.title} went to ${t.assignee}, who is not on side ${side.side}`);
      assert.ok(!t.owner || side.roster.includes(t.owner), "the planner could only name its own roster");
      for (const j of (t.judgment?.judgeAgentId ?? "").split(",").filter(Boolean)) {
        assert.notEqual(j, t.assignee);
        assert.notEqual(family(c, j), family(c, t.assignee!), "a judge is never in the worker's own model family");
      }
    }
    const routing = c.store.listRouting({ goalId: g.id });
    assert.ok(routing.length >= 2);
    for (const r of routing) { assert.ok(side.roster.includes(r.chosen), `routing chose ${r.chosen}`); assert.ok(r.candidates.every((x) => side.roster.includes(x.agentId)), "candidates are the roster only"); }
  }
  // Every PLAN and TASK call went to an agent of the side it was for.
  const lanes = new Map(f.sides.map((s) => [s.roomId, s.roster]));
  for (const call of MockAdapter.calls.filter((x) => x.kind === "PLAN" || x.kind === "TASK")) {
    const goalRoster = [...lanes.values()].find((r) => r.includes(call.agentId));
    assert.ok(goalRoster, `${call.agentId} worked outside both rosters`);
    const named = [...call.prompt.matchAll(/^- ([\w-]+): /gm)].map((m) => m[1]).filter((x) => c.store.getAgent(x));
    assert.ok(named.every((x) => goalRoster.includes(x)), `${call.kind} prompt for ${call.agentId} listed ${named}`);
  }

  // Folders: each side its own; one side's files never appear in the other.
  assert.notEqual(ga.folder, gb.folder);
  const filesA = listFiles(ga.folder!), filesB = listFiles(gb.folder!);
  assert.ok(filesA.includes("research.md") && filesA.includes("summary.md"), "side A (files on) wrote its files");
  assert.deepEqual(filesB, [], "side B planned no files, and A's never reached it");
  for (const file of filesA.filter((x) => /\.md$/.test(x))) assert.doesNotMatch(text(join(ga.folder!, file)), /Hermes|Muse/, "side A's files hold only side A's agents' work");
  assert.ok(!existsSync(c.orch.workspaces.root(ga.id)) && !existsSync(c.orch.workspaces.root(gb.id)), "no worktree outlives a side");
});

test("a fork from a goal starts both sides from that goal's files; /fork with no arguments forks the room's last goal with a vendor split", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex", "hermes", "muse", "gemini"]);
  const original = await c.orch.runGoal(c.room.id, "Summarize the venue TV market");
  await c.orch.idle();
  assert.equal(c.store.getGoal(original.id)!.status, "done");
  const originalFiles = new Map(listFiles(original.folder!).map((p) => [p, text(join(original.folder!, p))]));
  assert.ok(originalFiles.size >= 2);
  const before = c.store.listGoals(c.room.id).length;

  await c.orch.handleOwnerMessage(c.room.id, "/fork");
  await until(() => c.orch.forks.list(c.room.id).length === 1);
  const f0 = c.orch.forks.list(c.room.id)[0];
  assert.equal(f0.sourceGoalId, original.id, "the last goal is the one forked");
  assert.equal(f0.text, original.text);
  assert.equal(c.store.listGoals(c.room.id).length, before, "the fork added no goal to the room");
  const [ra, rb] = f0.sides.map((s) => s.roster);
  assert.ok(ra.length && rb.length);
  const fam = (id: string) => family(c, id);
  assert.ok(!ra.some((x) => rb.some((y) => fam(x) === fam(y))), "different vendors on each side");
  assert.deepEqual([...ra, ...rb].sort(), c.store.listAgents().map((x) => x.id).sort(), "everyone ready took a side");
  // The copied start state is the original's files, and each side's folder began as a copy of it.
  const startDir = c.orch.forks.startDir(f0.id);
  assert.deepEqual(new Map(listFiles(startDir).map((p) => [p, text(join(startDir, p))])), originalFiles);
  const f = await finish(c, f0);
  const v = await view(c, f);
  assert.equal(v.sides.length, 2);
  assert.ok(v.sides.every((s) => s.deliverables.files.every((x) => x.change === "modified")), "against the shared start, the sides changed what was there");
  assert.equal(c.store.getGoal(original.id)!.folder, original.folder);
  assert.deepEqual(new Map(listFiles(original.folder!).map((p) => [p, text(join(original.folder!, p))])), originalFiles, "the forked goal itself is untouched until a merge");
});

// ============================================================ AC2: side by side, blind comparison

/** The text of one candidate in a COMPARE prompt. */
const candidate = (prompt: string, n: 1 | 2) => (prompt.split(`=== CANDIDATE ${n} ===\n`)[1] ?? "").split(/\n=== (?:CANDIDATE 2|END) ===/)[0];

async function pair(c: Ctx) {
  const app = await buildServer({ ...c, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async <T,>(path: string) => (await (await fetch(`${base}${path}`, { headers: h })).json()) as T;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { app, base, h, get, post };
}

test("AC2: GET /forks/:id shows both sides next to each other: summary, files with diffs, cost, time, accepted tasks, requirement checks", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  const api = await pair(c);
  try {
    const r = await api.post("/goals/fork", { roomId: c.room.id, text: "Summarize the venue TV market", rosterA: ["claude", "codex"], rosterB: ["hermes", "muse"] });
    assert.equal(r.status, 200);
    const started = (await r.json()) as ForkView;
    assert.equal(started.sides.length, 2);
    assert.ok(["running", "waiting"].includes(started.state));
    const f = await finish(c, c.orch.forks.get(started.id)!);
    const v = await api.get<ForkView>(`/forks/${f.id}`);
    assert.equal(v.state, "compared");
    assert.equal(v.text, "Summarize the venue TV market");
    assert.equal(v.sides.length, 2);
    const [a, b] = v.sides;
    assert.deepEqual(a.roster.map((x) => x.id), ["claude", "codex"]);
    assert.deepEqual(b.roster.map((x) => x.id), ["hermes", "muse"]);
    for (const s of v.sides) {
      assert.equal(s.status, "done");
      assert.ok(s.summary && s.summary.length > 10, "each side has its summary");
      assert.ok(s.tasks.total >= 2 && s.tasks.done === s.tasks.total);
      assert.ok(s.accepted.length >= 2 && s.accepted.every((t) => t.agentName && s.roster.some((x) => x.id === t.agentId)), "the accepted tasks, by the agent that did them");
      assert.ok(s.requirements.length === 2 && s.requirements.every((q) => q.status === "met"), "the contract's requirement checks");
      assert.ok(s.cost.runs >= 2 && s.cost.inputTokens > 0 && s.cost.outputTokens > 0, JSON.stringify(s.cost));
      assert.ok(s.time.endedAt && s.time.seconds >= 0 && s.time.startedAt <= s.time.endedAt);
    }
    assert.deepEqual(a.deliverables.files.map((x) => x.path).sort(), ["research.md", "summary.md"]);
    const diff = a.deliverables.files.find((x) => x.path === "research.md")!;
    assert.equal(diff.change, "added");
    assert.match(diff.diff, /^--- \/dev\/null\n\+\+\+ b\/research\.md\n@@ /, "a unified diff against the shared start");
    assert.match(diff.diff, /\+(Claude|Codex) wrote research\.md/);
    assert.deepEqual(b.deliverables.files, []);
    assert.ok(v.requirements.length >= 2 && v.comparison?.requirements.every((q) => ["PASS", "FAIL", "UNSURE"].includes(q.a) && ["PASS", "FAIL", "UNSURE"].includes(q.b)));
    // The lanes are rooms the apps can read, but the room list leaves them out.
    const rooms = await api.get<{ id: string; forkId?: string }[]>("/rooms");
    assert.ok(rooms.every((x) => !x.forkId) && rooms.some((x) => x.id === c.room.id));
    assert.ok((await api.get<unknown[]>(`/rooms/${a.roomId}/messages`)).length > 0, "a lane's own conversation is readable");
    const list = await api.get<ForkView[]>(`/forks?roomId=${c.room.id}`);
    assert.deepEqual(list.map((x) => x.id), [f.id]);
    assert.equal((await fetch(`${api.base}/forks/nope`, { headers: api.h })).status, 404);
  } finally { await api.app.close(); }
});

test("AC2: the blind comparison: no roster, agent or vendor names reach the judges; both orders are judged, in opposite order; agreement is reported", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  const f = await finish(c, await startFork(c, "Summarize the venue TV market (Claude and Hermes read the numbers differently)"));
  const calls = compareCalls();
  assert.equal(calls.length, 2, "two passes");
  const everyName = /claude|codex|hermes|muse|gemini|anthropic|openai|nous|google|roster|side a|side b/i;
  for (const call of calls) {
    assert.doesNotMatch(call.prompt, everyName, "the judge's prompt names no agent, vendor or roster");
    assert.match(call.prompt, /^\[\[COMPARE\]\]/);
    assert.match(call.prompt, /R1: /, "the requirements are listed");
    assert.match(call.prompt, /\[agent\] wrote research\.md/, "file contents are there, with names replaced");
  }
  // The same two texts, in opposite order.
  assert.equal(candidate(calls[0].prompt, 1), candidate(calls[1].prompt, 2));
  assert.equal(candidate(calls[0].prompt, 2), candidate(calls[1].prompt, 1));
  assert.notEqual(candidate(calls[0].prompt, 1), candidate(calls[0].prompt, 2), "and the two results differ");
  const cmp = f.comparison!;
  assert.deepEqual(cmp.passes.map((p) => p.order).sort(), ["ab", "ba"]);
  assert.equal(cmp.state, "done");
  assert.equal(cmp.independence, "full", "gemini is on neither roster");
  assert.ok(cmp.passes.every((p) => p.judge === "gemini"));
  assert.equal(cmp.agreement, true);
  assert.equal(cmp.preference, "a", "the side with the files is preferred, in both orders");
  assert.ok(cmp.reasons.length && cmp.reasons.every((x) => /Side [AB]/.test(x) && !/Candidate/.test(x)), "reasons name the real sides");
  assert.equal(cmp.requirements.length, 2);
  assert.ok(c.store.listAudit(500).some((x) => x.action === "fork.compared"));
  const said = c.store.listMessages(c.room.id).filter((m) => m.forkId === f.id);
  assert.ok(said.some((m) => /The judges lean to side A/.test(m.text)), said.map((m) => m.text).join("\n"));
});

test("AC2: which side is read first is random, and the second pass always swaps it", async () => {
  const lowRand = ctx({ rand: () => 0.1 }), highRand = ctx({ rand: () => 0.9 });
  const orders: string[][] = [];
  for (const c of [lowRand, highRand]) {
    withFiles(c, ["claude", "codex"]);
    const f = await finish(c, await startFork(c));
    orders.push(f.comparison!.passes.map((p) => p.order));
  }
  assert.deepEqual(orders, [["ab", "ba"], ["ba", "ab"]]);
});

test("AC2: a judge that always picks whatever it reads first gives no clear preference: the orders disagree and it says so", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  setting(c, "gemini", { comparePick: "first" });
  const f = await finish(c, await startFork(c));
  assert.equal(f.comparison!.agreement, false);
  assert.equal(f.comparison!.preference, "unclear");
  assert.match(f.comparison!.note ?? "", /orders disagreed/);
  assert.equal(f.comparison!.state, "done");
  const v = await view(c, f);
  assert.equal(v.state, "compared", "the owner can still merge either side");
});

test("a comparison nobody answers is reported as failed, and the owner can ask again", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  setting(c, "gemini", { comparePick: "none" });
  const f = await finish(c, await startFork(c));
  assert.equal(f.comparison!.state, "failed");
  assert.equal(f.comparison!.preference, "unclear");
  setting(c, "gemini", { comparePick: undefined });
  assert.ok((await c.orch.forks.recompare(f.id)).ok);
  const again = c.orch.forks.get(f.id)!.comparison!;
  assert.equal(again.state, "done");
  assert.equal(again.preference, "a");
});

// ============================================================ AC3: merge the better one

test("AC3: merging side A into a hub-owned fork: A's files become the result, its documents are kept, B's are superseded, B is archived and cleaned; routing records the preference", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  const f = await finish(c, await startFork(c));
  const ga = goalOf(c, f, "a"), gb = goalOf(c, f, "b");
  const docA = c.orch.library.save({ title: "Venue summary A", body: "Findings from side A.", roomId: ga.roomId, goalId: ga.id, author: "claude" }).doc;
  const docB = c.orch.library.save({ title: "Venue summary B", body: "Findings from side B.", roomId: gb.roomId, goalId: gb.id, author: "hermes" }).doc;
  assert.equal(f.target.kind, "hub");
  assert.equal(existsSync(f.target.folder!) ? listFiles(f.target.folder!).length : 0, 0, "nothing in the result before a merge");

  const r = await c.orch.forks.merge(f.id, "a");
  assert.ok(r.ok, r.ok ? "" : r.error);
  const m = c.orch.forks.get(f.id)!;
  assert.equal(m.merged?.side, "a");
  assert.equal(m.merged?.how, "folder");
  assert.deepEqual(listFiles(f.target.folder!), ["research.md", "summary.md"], "A's files are the goal's result");
  assert.equal(text(join(f.target.folder!, "research.md")), text(join(ga.folder!, "research.md")));
  assert.equal(r.ok && r.view.state, "merged");

  // Documents: A's kept, B's marked superseded (in the index and in the file).
  assert.equal(c.store.getDocument(docA.id)!.frontMatter.status, "draft");
  assert.equal(c.store.getDocument(docB.id)!.frontMatter.status, "superseded");
  assert.match(readFileSync(docB.path, "utf8"), /^status: superseded$/m);
  assert.match(readFileSync(docB.path, "utf8"), /Findings from side B\./, "the body is untouched");
  assert.match(readFileSync(docA.path, "utf8"), /^status: draft$/m);

  // The other side is archived: its work kept for comparison, nothing left running or on disk but its result.
  assert.equal(m.sides.find((s) => s.side === "b")!.archived, true);
  assert.equal(m.sides.find((s) => s.side === "a")!.archived, undefined);
  assert.ok(!existsSync(c.orch.workspaces.root(gb.id)) && !existsSync(c.orch.workspaces.root(ga.id)));
  assert.ok(existsSync(gb.folder!), "the archived side's folder stays for comparison");
  assert.equal((await view(c, m)).sides[1].archived, true);

  // The outcome is a recorded preference, not a judge score.
  const prefs = listPreferences(c.store);
  for (const a of ["claude", "codex"]) for (const t of ["research", "writing"]) assert.deepEqual(prefs.find((p) => p.agentId === a && p.taskType === t) && { w: prefs.find((p) => p.agentId === a && p.taskType === t)!.wins, l: prefs.find((p) => p.agentId === a && p.taskType === t)!.losses }, { w: 1, l: 0 }, `${a} on ${t}`);
  for (const a of ["hermes", "muse"]) assert.deepEqual(forkPreference(c.store, a, "writing"), { wins: 0, losses: 1, net: -0.5 });
  assert.deepEqual(forkPreference(c.store, "gemini", "writing"), { wins: 0, losses: 0, net: 0 }, "an agent that was on neither side gets nothing");
  assert.ok(forkPreference(c.store, "claude", "writing").net > 0);
  assert.equal(c.store.getScore("claude", "writing").runs > 0, true);
  assert.ok(c.store.listAudit(1000).some((x) => x.action === "fork.merged"));

  assert.equal((await c.orch.forks.merge(f.id, "b")).ok, false, "a fork is merged once");
  const again = await c.orch.forks.merge(f.id, "a");
  assert.ok(!again.ok && again.status === 409);
});

test("AC3: merging into a goal that was forked replaces its files with the chosen side's, and its summary", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex", "hermes", "muse", "gemini"]);
  const original = await c.orch.runGoal(c.room.id, "Summarize the venue TV market");
  await c.orch.idle();
  await c.orch.handleOwnerMessage(c.room.id, "/fork");
  await until(() => c.orch.forks.list(c.room.id).length === 1);
  const f = await finish(c, c.orch.forks.list(c.room.id)[0]);
  const side = f.comparison?.preference === "b" ? "b" : "a";
  const chosen = goalOf(c, f, side);
  assert.equal(f.target.kind, "hub");
  assert.equal(f.target.folder, original.folder);
  const r = await c.orch.forks.merge(f.id, side);
  assert.ok(r.ok, r.ok ? "" : r.error);
  for (const p of listFiles(chosen.folder!)) assert.equal(text(join(original.folder!, p)), text(join(chosen.folder!, p)), `${p} is the chosen side's`);
  assert.equal(c.store.getGoal(original.id)!.summary, chosen.summary);
});

test("merge refuses a side that is still working; the other side is stopped when the owner merges the finished one", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  for (const id of ["hermes", "muse"]) setting(c, id, { delayMs: 30_000 });
  const f0 = await startFork(c);
  await until(() => goalOf(c, f0, "a").status === "done");
  const early = await c.orch.forks.merge(f0.id, "b");
  assert.ok(!early.ok && early.status === 409 && /still working/.test(early.error), "B isn't finished");
  assert.equal((await view(c, f0)).state, "running");
  const r = await c.orch.forks.merge(f0.id, "a");
  assert.ok(r.ok, r.ok ? "" : r.error);
  await c.orch.forks.settled(f0.id); await c.orch.idle();
  const gb = goalOf(c, f0, "b");
  assert.notEqual(gb.status, "running", "the other side was stopped");
  assert.ok(c.store.listTasks({ goalId: gb.id }).every((t) => !["running", "pending", "revising"].includes(t.status)));
  assert.ok(!existsSync(c.orch.workspaces.root(gb.id)));
  assert.equal(c.orch.forks.get(f0.id)!.comparison, undefined, "no comparison for a fork merged before both finished");
  assert.deepEqual(listFiles(c.orch.forks.get(f0.id)!.target.folder!), ["research.md", "summary.md"]);
});

// ---- a git repository the owner granted

const ownerRepo = () => {
  const d = dir("repo-");
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "README.md"), "# mine\n");
  git(d, "-c", "user.name=Owner", "-c", "user.email=o@example.com", "add", "-A");
  git(d, "-c", "user.name=Owner", "-c", "user.email=o@example.com", "commit", "-q", "-m", "init");
  return d;
};

test("AC1+AC3: on a granted git repo each side works on its own branch; merging pushes the chosen branch to agent-room/<goal> and never touches the owner's branch or files", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  const repo = ownerRepo();
  const head = git(repo, "rev-parse", "HEAD");
  const grant = c.orch.files.addGrant({ path: repo, label: "my-repo", agentId: "*", read: true, write: true });
  const f = await finish(c, await startFork(c, "Summarize the venue TV market", { folderGrantId: grant.id }));
  assert.equal(f.target.kind, "git");
  assert.equal(f.target.startSha, head);
  assert.equal(f.target.branch, `agent-room/${f.id}`);
  assert.deepEqual(f.sides.map((s) => s.branch), [`agent-room/${f.id}-a`, `agent-room/${f.id}-b`]);
  const branches = git(repo, "branch", "--list", "--format=%(refname:short)").split("\n").sort();
  assert.ok(branches.includes(`agent-room/${f.id}-a`) && branches.includes(`agent-room/${f.id}-b`), branches.join(","));
  assert.ok(!branches.includes(f.target.branch!), "nothing lands on the goal's branch before a merge");
  assert.equal(git(repo, "show", `agent-room/${f.id}-a:research.md`).includes("wrote research.md"), true);
  assert.throws(() => git(repo, "show", `agent-room/${f.id}-b:research.md`), "B's branch has no such file: sides are independent");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);

  const v = await view(c, f);
  assert.deepEqual(v.sides[0].deliverables.files.map((x) => x.path).sort(), ["research.md", "summary.md"], "the files come from the branch, against the owner's head");
  assert.match(v.sides[0].deliverables.files[0].diff, /^--- \/dev\/null\n\+\+\+ b\//);
  assert.deepEqual(v.sides[1].deliverables.files, []);
  assert.equal(v.target.kind, "git");

  const r = await c.orch.forks.merge(f.id, "a");
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(c.orch.forks.get(f.id)!.merged?.how, "branch");
  assert.equal(git(repo, "rev-parse", `agent-room/${f.id}`), git(repo, "rev-parse", `agent-room/${f.id}-a`), "the goal's branch now holds A's work");
  assert.equal(git(repo, "show", `agent-room/${f.id}:summary.md`).includes("wrote summary.md"), true);
  // The owner's checked-out branch, head and working tree are untouched.
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.deepEqual(readdirSync(repo).filter((x) => x !== ".git"), ["README.md"]);
  // B is archived and cleaned; its branch stays in the owner's repo for comparison.
  assert.equal(c.orch.forks.get(f.id)!.sides[1].archived, true);
  assert.ok(!existsSync(c.orch.workspaces.root(f.sides[1].goalId)));
  assert.ok(git(repo, "branch", "--list", `agent-room/${f.id}-b`).length > 0);
});

test("a branch that moved since the fork started is never overwritten; and the checked-out branch is never the target", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  const repo = ownerRepo();
  const grant = c.orch.files.addGrant({ path: repo, agentId: "*", read: true, write: true });
  const f = await finish(c, await startFork(c, "Summarize the venue TV market", { folderGrantId: grant.id }));
  // the owner made their own work on the goal's branch in the meantime
  git(repo, "branch", f.target.branch!, "main");
  git(repo, "checkout", "-q", f.target.branch!);
  writeFileSync(join(repo, "mine.txt"), "mine\n");
  git(repo, "-c", "user.name=Owner", "-c", "user.email=o@example.com", "add", "-A");
  git(repo, "-c", "user.name=Owner", "-c", "user.email=o@example.com", "commit", "-q", "-m", "mine");
  const checkedOut = await c.orch.forks.merge(f.id, "a");
  assert.ok(!checkedOut.ok && checkedOut.status === 409 && /checked out/.test(checkedOut.error), JSON.stringify(checkedOut));
  git(repo, "checkout", "-q", "main");
  const moved = await c.orch.forks.merge(f.id, "a");
  assert.ok(!moved.ok && moved.status === 409 && /changed since/.test(moved.error), JSON.stringify(moved));
  assert.equal(c.orch.forks.get(f.id)!.merged, undefined, "nothing was recorded as merged");
  assert.equal(git(repo, "show", `${f.target.branch}:mine.txt`), "mine", "the owner's commit is still there");
});

// ---- a folder that is not a git repository

test("AC3: on a granted folder that isn't a git repo, merging makes ONE write proposal with the chosen side's whole diff; nothing is written until the owner approves", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  const folder = dir("plain-");
  writeFileSync(join(folder, "notes.txt"), "my notes\n");
  const grant = c.orch.files.addGrant({ path: folder, label: "plain", agentId: "*", read: true, write: true });
  const f = await finish(c, await startFork(c, "Summarize the venue TV market", { folderGrantId: grant.id }));
  assert.equal(f.target.kind, "copy");
  assert.deepEqual(c.orch.files.proposals(), [], "the sides never sent anything to the owner while they worked");
  assert.deepEqual(readdirSync(folder), ["notes.txt"]);
  const ga = goalOf(c, f, "a"), gb = goalOf(c, f, "b");
  assert.ok(listFiles(ga.folder!).includes("notes.txt") && listFiles(gb.folder!).includes("notes.txt"), "both sides started from the owner's folder");

  const r = await c.orch.forks.merge(f.id, "a");
  assert.ok(r.ok, r.ok ? "" : r.error);
  const merged = c.orch.forks.get(f.id)!.merged!;
  assert.equal(merged.how, "proposal");
  const proposals = c.orch.files.proposals();
  assert.equal(proposals.length, 1, "one proposal, not one per task");
  const p = proposals[0];
  assert.equal(p.id, merged.proposalId);
  assert.equal(p.kind, "task");
  assert.equal(p.taskId, f.id);
  assert.deepEqual(p.files!.map((x) => `${x.op} ${x.relPath}`).sort(), ["create research.md", "create summary.md"]);
  assert.match(p.diff, /\+(Claude|Codex) wrote research\.md/);
  assert.equal(p.status, "pending");
  assert.deepEqual(readdirSync(folder), ["notes.txt"], "nothing changes until the owner approves");
  const approval = c.store.listApprovals("pending").find((a) => a.proposalId === p.id)!;
  assert.ok(approval, "it waits in the owner's approvals");
  c.approvals.decide(approval.id, "approved");
  await until(() => c.orch.files.proposal(p.id)!.status !== "pending");
  assert.deepEqual(readdirSync(folder).sort(), ["notes.txt", "research.md", "summary.md"]);
  assert.equal(text(join(folder, "research.md")), text(join(ga.folder!, "research.md")));
  assert.equal(c.orch.forks.get(f.id)!.sides[1].archived, true);
});

// ============================================================ the rest of the surface

test("/fork problems are answered in the room: an unknown agent, an agent outside the room, nothing to fork; a direct-message room is refused", async () => {
  const c = ctx();
  const last = () => c.store.listMessages(c.room.id).at(-1)!.text;
  await c.orch.handleOwnerMessage(c.room.id, "/fork");
  await until(() => /no goal to fork/.test(last()));
  await c.orch.handleOwnerMessage(c.room.id, "/fork Do a thing | rosterA: claude | rosterB: nobody");
  await until(() => /don't know "nobody"/.test(last()));
  await c.orch.handleOwnerMessage(c.room.id, "/fork Do a thing | rosterA: claude");
  await until(() => c.orch.forks.list(c.room.id).length === 1);
  assert.deepEqual(c.orch.forks.list(c.room.id)[0].sides.map((s) => s.roster.length > 0), [true, true], "one named roster: the other is whoever is left");
  assert.deepEqual(c.orch.forks.list(c.room.id)[0].sides[0].roster, ["claude"]);
  assert.ok(!c.orch.forks.list(c.room.id)[0].sides[1].roster.includes("claude"));
  const dm = c.store.dmRoom("claude", "Claude");
  const r = await c.orch.forks.start({ roomId: dm.id, text: "x" });
  assert.ok(!r.ok && /direct message/.test(r.error));
  const lane = c.orch.forks.list(c.room.id)[0].sides[0].roomId;
  const inLane = await c.orch.forks.start({ roomId: lane, text: "x" });
  assert.ok(!inLane.ok && /one side of a fork/.test(inLane.error));
  await c.orch.forks.settled(c.orch.forks.list(c.room.id)[0].id); await c.orch.idle();
});

test("a roster is limited to the agents the room allows, and a lane's own roster rules planning even when the room has a ROOM.md roster", async () => {
  const c = ctx();
  c.orch.rooms.fork = c.orch.rooms.fork; // installed by the fork service
  const ids = (id: string) => c.orch.rooms.rosterIds(id);
  const f = await startFork(c);
  assert.deepEqual(ids(f.sides[0].roomId), ["claude", "codex"]);
  assert.deepEqual(ids(f.sides[1].roomId), ["hermes", "muse"]);
  assert.equal(ids(c.room.id), undefined, "the room the fork came from is as open as before");
  assert.equal(c.orch.rooms.allows(f.sides[0].roomId, "hermes"), false);
  const pool = c.store.listAgents();
  // a worker's judges are never of its own family, whether they sit on the other roster or outside both
  const judges = c.orch.rooms.judgePool(f.sides[0].roomId, pool, ["claude"]);
  assert.ok(judges.pool.every((a) => a.id !== "claude"));
  assert.deepEqual([...judges.pool.map((a) => a.id)], ["codex"], "inside the roster first");
  const outside = c.orch.rooms.judgePool(f.sides[0].roomId, pool, ["codex", "claude"]);
  assert.ok(outside.pool.length && outside.pool.every((a) => !["claude", "codex"].includes(a.id)) && outside.outside.size === outside.pool.length, "when nobody inside can judge, others do and it is recorded");
  await c.orch.forks.settled(f.id); await c.orch.idle();
});

test("a stop in the room stops both sides", async () => {
  const c = ctx();
  for (const id of ["claude", "codex", "hermes", "muse"]) setting(c, id, { delayMs: 30_000 });
  const f = await startFork(c);
  await until(() => c.store.listTasks({ goalId: f.sides[0].goalId }).some((t) => t.status === "running") && c.store.listTasks({ goalId: f.sides[1].goalId }).some((t) => t.status === "running"));
  c.orch.stopRoom(c.room.id);
  await c.orch.forks.settled(f.id); await c.orch.idle();
  for (const s of f.sides) assert.equal(c.store.getGoal(s.goalId)!.status, "failed");
  assert.ok(f.sides.every((s) => !existsSync(c.orch.workspaces.root(s.goalId))));
});

test("a fork that needs plan approval waits for it per side, and POST /forks/:id/plan approves both", async () => {
  const c = ctx();
  c.store.setSettings({ ...c.store.getSettings(), planApproval: "always" });
  const api = await pair(c);
  try {
    const f = await startFork(c);
    await until(() => f.sides.every((s) => c.store.getGoal(s.goalId)?.status === "awaiting_approval"));
    const v = await api.get<ForkView>(`/forks/${f.id}`);
    assert.equal(v.state, "waiting");
    assert.ok(v.sides.every((s) => s.awaitingApproval));
    const r = await api.post(`/forks/${f.id}/plan`, {});
    assert.deepEqual(await r.json(), { ok: true, approved: 2 });
    await finish(c, f);
    assert.equal((await api.get<ForkView>(`/forks/${f.id}`)).state, "compared");
  } finally { await api.app.close(); }
});

test("POST /forks/:id/merge: the jury's pick is only a suggestion; the owner's side is the one merged; bad input is refused", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  const api = await pair(c);
  try {
    const f = await finish(c, await startFork(c));
    assert.equal(f.comparison!.preference, "a");
    assert.equal((await api.post(`/forks/${f.id}/merge`, { side: "c" })).status, 400);
    assert.equal((await api.post(`/forks/nope/merge`, { side: "a" })).status, 404);
    const r = await api.post(`/forks/${f.id}/merge`, { side: "b" }); // the owner overrules the jury
    assert.equal(r.status, 200);
    const v = (await r.json()) as ForkView;
    assert.equal(v.merged?.side, "b");
    assert.equal(v.sides[0].archived, true);
    assert.deepEqual(listFiles(f.target.folder!), [], "B changed no files, so the result has none");
    assert.equal((await api.post(`/forks/${f.id}/merge`, { side: "a" })).status, 409);
    const prefs = await api.get<{ agentId: string; wins: number; losses: number }[]>("/forks/preferences?agentId=hermes");
    assert.ok(prefs.length && prefs.every((p) => p.wins === 1 && p.losses === 0), "the owner's choice is what is recorded");
    assert.equal((await fetch(`${api.base}/forks`)).status, 401, "paired devices only");
  } finally { await api.app.close(); }
});

test("a fork keeps working after a restart: sides that finished get their comparison, and lanes keep their rosters", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  const f = await finish(c, await startFork(c));
  const row = c.orch.forks.get(f.id)!;
  // pretend the comparison never happened (the hub stopped first)
  c.store.db.prepare("UPDATE forks SET data=? WHERE id=?").run(JSON.stringify({ ...row, comparison: undefined, comparing: true }), f.id);
  MockAdapter.calls.length = 0;
  c.orch.recover();
  await c.orch.forks.settled(f.id);
  await until(() => !!c.orch.forks.get(f.id)!.comparison);
  assert.equal(compareCalls().length, 2);
  assert.equal(c.orch.forks.get(f.id)!.comparing, false);
});

// ---- the phone and Mac screens

test("the phone fork view: served, no inline styles, A/B/Compare tabs, summaries, requirement checks, cost and the jury's pick; the Mac has the same", async () => {
  const c = ctx();
  withFiles(c, ["claude", "codex"]);
  const api = await pair(c);
  try {
    const r = await api.post("/goals/fork", { roomId: c.room.id, text: "Summarize the venue TV market", rosterA: ["claude", "codex"], rosterB: ["hermes", "muse"] });
    const f = await finish(c, c.orch.forks.get(((await r.json()) as ForkView).id)!);
    const v = await api.get<ForkView>(`/forks/${f.id}`);
    assert.ok(v.comparison, "compared");

    assert.equal((await fetch(`${api.base}/web/fork.js`)).status, 200);
    const html = await (await fetch(`${api.base}/`)).text();
    assert.ok(html.indexOf("/web/fork.js") > 0 && html.indexOf("/web/fork.js") < html.indexOf("/web/app.js"), "fork.js loads before app.js");
    const web = join(import.meta.dirname, "../web");
    const src = readFileSync(join(web, "fork.js"), "utf8");
    assert.doesNotMatch(src, /\sstyle\s*=\s*["'`\\]|setAttribute\(\s*["']style["']|—|–/, "no inline styles, no dashes in copy");
    assert.doesNotMatch(readFileSync(join(web, "app.css"), "utf8").split("/* 4.4 fork")[1] ?? "", /—|–/);

    // Run the view against a tiny DOM.
    class El {
      children: (El | string)[] = []; attrs: Record<string, string> = {}; className = ""; listeners: Record<string, ((e: unknown) => void)[]> = {};
      dataset: Record<string, string> = {}; open = false; disabled = false; title = ""; nodeType = 1;
      constructor(public tag: string) {}
      set textContent(t: string) { this.children = [t]; }
      get textContent(): string { return this.children.map((k) => (typeof k === "string" ? k : k.textContent)).join(" "); }
      setAttribute(k: string, val: string) { this.attrs[k] = val; if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-(\w)/g, (_, ch: string) => ch.toUpperCase())] = val; }
      append(...k: (El | string)[]) { this.children.push(...k); }
      replaceChildren(...k: El[]) { this.children = k; }
      addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ??= []).push(fn); }
      get classList() { return { toggle: () => {} }; }
      all(f: (e: El) => boolean, out: El[] = []): El[] { for (const k of this.children) if (typeof k !== "string") { if (!(k instanceof El)) throw new Error("child " + typeof k + " " + String(Object.keys(k as object)).slice(0, 80)); if (f(k)) out.push(k); k.all(f, out); } return out; }
    }
    const document = { createElement: (t: string) => new El(t), createTextNode: (t: string) => t };
    const sandbox: Record<string, unknown> = { document, window: undefined };
    sandbox.window = sandbox; sandbox.globalThis = sandbox;
    const vm = await import("node:vm");
    vm.runInNewContext(src, sandbox);
    const host = new El("div");
    let painted = 0;
    const ui = { safeColor: (x: string) => x, paint: () => { painted++; }, onAct: () => {} };
    (sandbox.ARFork as { render(h: El, v: ForkView, s: object, u: object): void }).render(host, v, {}, ui);
    assert.equal(painted, 1);
    const text = host.textContent;
    const tabs = host.all((e) => e.tag === "button" && "fkTab" in e.dataset).map((e) => e.textContent.trim());
    assert.deepEqual(tabs, ["Side A", "Side B", "Compare"]);
    for (const s of v.sides) {
      assert.ok(text.includes(s.summary!.slice(0, 30)), `side ${s.side} summary shown`);
      for (const q of s.requirements) assert.ok(text.includes(q.text), "requirement shown");
      assert.ok(text.includes(`${s.cost.runs} run`), "cost shown");
    }
    assert.ok(text.includes("The judges"), "the jury's preference is shown");
    const merge = host.all((e) => e.dataset.fk === "merge");
    assert.deepEqual(merge.map((e) => e.dataset.side), ["a", "b"], "two merge buttons, one per side");
    assert.ok(merge.every((e) => !e.disabled), "both sides finished, so both can be merged");

    // The Mac app reads the same routes and shows the same things.
    const app = join(import.meta.dirname, "../../app/src");
    const mac = readFileSync(join(app, "components/ForkView.tsx"), "utf8");
    assert.match(readFileSync(join(app, "api/client.ts"), "utf8"), /\/forks\/\$\{id\}\/merge/);
    for (const needle of ["Compare", "Done means", "Judges' pick", "Merge ", "tokens"]) assert.ok(mac.includes(needle), `Mac fork view: ${needle}`);
    assert.doesNotMatch(mac, /—|–/);
    assert.match(readFileSync(join(app, "screens/RoomScreen.tsx"), "utf8"), /m\.forkId/, "the room shows an Open fork button on the fork message");
  } finally { await api.app.close(); }
});
