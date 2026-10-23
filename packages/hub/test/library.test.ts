import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DocFrontMatter, Goal, LibraryDoc, Task } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { emitFrontMatter, parseFrontMatter, readDocument, splitFrontMatter, validateFrontMatter } from "../src/library/frontmatter.js";
import { slugify } from "../src/library/library.js";
import { setup } from "./helpers.js";

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  return { ...ctx, app, base, code };
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? [p, ...walk(p)] : [p]; });
}

const fm = (over: Partial<DocFrontMatter> = {}): DocFrontMatter => ({
  id: "doc_1", title: "Q4 competitive read", room: "competitive", goal: "goal_1", status: "draft",
  authors: ["claude", "codex"], created: "2026-10-23", updated: "2026-10-23", sources: ["https://example.com/a?b=1", "notes.md"], tags: ["q4"], ...over,
});

test("front matter round trips, including quotes and colons in titles", () => {
  const titles = [
    "Q4 competitive read",
    'Say "hello": a study',
    "Colons: everywhere: here",
    "Trailing space and # hash",
    "true",
    "2026",
    "Café – naïve résumé",
    "back\\slash and\nnewline",
    "[brackets], commas, {braces}",
    "- leading dash",
  ];
  for (const title of titles) {
    const input = fm({ title, sources: ["a, b", 'q"uote', "https://x.test:8080/p#frag", "plain"], tags: ["x y", "z"] });
    const text = emitFrontMatter(input) + "\n# Body\n";
    const back = readDocument(text);
    assert.ok(back, `parse ${JSON.stringify(title)}`);
    assert.deepEqual(back.frontMatter, input, JSON.stringify(title));
    assert.equal(back.body, "# Body\n");
  }
  const plain = emitFrontMatter(fm());
  assert.match(plain, /^---\nid: doc_1\ntitle: Q4 competitive read\nroom: competitive\ngoal: goal_1\nstatus: draft\nauthors: \[claude, codex\]\ncreated: 2026-10-23\nupdated: 2026-10-23\nsources: \[/);
  assert.match(emitFrontMatter(fm({ title: "A: B" })), /^title: "A: B"$/m);
  assert.match(plain, /\n---\n$/);
  // optional fields are omitted, empty arrays round trip
  const bare = emitFrontMatter(fm({ goal: undefined, tags: undefined, sources: [], authors: ["a"] }));
  assert.doesNotMatch(bare, /goal:|tags:/);
  assert.deepEqual(parseFrontMatter(bare.split("\n").slice(1, -2).join("\n")).sources, []);
});

test("splitFrontMatter strips a leading block only, and validateFrontMatter enforces the schema", () => {
  assert.deepEqual(splitFrontMatter("---\ntitle: x\n---\nhello\n"), { raw: "title: x", body: "hello\n" });
  assert.equal(splitFrontMatter("---\n---\nhi").body, "hi");
  assert.equal(splitFrontMatter("no front matter\n---\nx: y\n---\n").raw, null);
  const rule = "---\nJust a horizontal rule and prose\n---\nmore";
  assert.equal(splitFrontMatter(rule).body, rule, "a Markdown rule is not front matter");

  assert.deepEqual(validateFrontMatter(fm()), []);
  assert.ok(validateFrontMatter(fm({ title: "" })).some((e) => /title/.test(e)));
  assert.ok(validateFrontMatter(fm({ title: "x".repeat(201) })).some((e) => /title/.test(e)));
  assert.deepEqual(validateFrontMatter(fm({ title: "x".repeat(200) })), []);
  assert.ok(validateFrontMatter(fm({ status: "done" as never })).some((e) => /status/.test(e)));
  assert.ok(validateFrontMatter(fm({ created: "2026-13-40" })).some((e) => /created/.test(e)));
  assert.ok(validateFrontMatter(fm({ updated: "yesterday" })).some((e) => /updated/.test(e)));
  assert.ok(validateFrontMatter(fm({ authors: [] })).some((e) => /authors/.test(e)));
  assert.ok(validateFrontMatter(null).length);
});

test("save writes front matter, names the file and creates assets/", () => {
  const { orch, store, room, dir } = setup();
  const root = join(dir, "Library");
  const { doc, created } = orch.library.save({ title: "Q4 Competitive Read!", body: "# Hello\n\nBody.", roomId: room.id, author: "claude", sources: ["https://x.test"] });
  assert.equal(created, true);
  assert.match(doc.id, /^doc_[0-9a-f]{16}$/);
  const roomSlug = slugify(room.name);
  assert.equal(doc.relPath, `${roomSlug}/general/${today()}-q4-competitive-read.md`);
  assert.equal(doc.path, join(root, roomSlug, "general", `${today()}-q4-competitive-read.md`));
  assert.ok(statSync(join(root, roomSlug, "general", "assets")).isDirectory());

  const onDisk = readFileSync(doc.path, "utf8");
  const parsed = readDocument(onDisk)!;
  assert.ok(parsed, "file has valid front matter");
  assert.equal(parsed.frontMatter.title, "Q4 Competitive Read!");
  assert.equal(parsed.frontMatter.room, roomSlug);
  assert.equal(parsed.frontMatter.goal, undefined);
  assert.equal(parsed.frontMatter.status, "draft");
  assert.deepEqual(parsed.frontMatter.authors, ["claude"]);
  assert.deepEqual(parsed.frontMatter.sources, ["https://x.test"]);
  assert.equal(parsed.frontMatter.created, today());
  assert.equal(parsed.body, "# Hello\n\nBody.\n");
  assert.equal(doc.bytes, Buffer.byteLength(onDisk));
  assert.deepEqual(walk(root).filter((p) => p.endsWith(".tmp")), [], "no temp files left behind");

  const g = store.listAudit().find((a) => a.action === "document.saved");
  assert.equal(g?.actor, "claude");
  assert.equal(g?.detail, doc.relPath);

  // goal folder
  const withGoal = orch.library.save({ title: "Plan", body: "x", roomId: room.id, goalId: "goal_abc123", author: "codex", status: "review", tags: ["a"] }).doc;
  assert.equal(withGoal.relPath, `${roomSlug}/goal_abc123/${today()}-plan.md`);
  assert.ok(existsSync(join(root, roomSlug, "goal_abc123", "assets")));
  assert.equal(withGoal.frontMatter.goal, "goal_abc123");
  assert.equal(withGoal.frontMatter.status, "review");
});

test("saving the same title again updates: keeps id and created, unions authors and sources", () => {
  const { orch, store, room, dir } = setup();
  const a = orch.library.save({ title: "Market sizing", body: "v1", roomId: room.id, goalId: "goal_x", author: "claude", sources: ["s1", "s2"], tags: ["t1"] });
  // pretend it was first saved on an earlier day
  const { doc: first } = a;
  const back = { ...first.frontMatter, created: "2026-01-02", updated: "2026-01-02" };
  const oldPath = first.path.replace(today(), "2026-01-02");
  renameSync(first.path, oldPath);
  writeFileSync(oldPath, readFileSync(oldPath, "utf8").replace(/created: .*/, "created: 2026-01-02").replace(/updated: .*/, "updated: 2026-01-02"));
  store.saveDocument({ ...first, path: oldPath, relPath: first.relPath.replace(today(), "2026-01-02"), frontMatter: back });

  const b = orch.library.save({ title: "Market  sizing", body: "v2 body", roomId: room.id, goalId: "goal_x", author: "codex", sources: ["s2", "s3"], status: "final" });
  assert.equal(b.created, false);
  assert.equal(b.doc.id, first.id, "id kept");
  assert.equal(b.doc.path, oldPath, "same file, no duplicate with a new date");
  assert.equal(b.doc.frontMatter.created, "2026-01-02", "created kept");
  assert.equal(b.doc.frontMatter.updated, today(), "updated bumped");
  assert.deepEqual(b.doc.frontMatter.authors, ["claude", "codex"]);
  assert.deepEqual(b.doc.frontMatter.sources, ["s1", "s2", "s3"]);
  assert.deepEqual(b.doc.frontMatter.tags, ["t1"], "omitted tags are kept");
  assert.equal(b.doc.frontMatter.status, "final");
  const text = readFileSync(oldPath, "utf8");
  assert.match(text, /v2 body/);
  assert.doesNotMatch(text, /v1/);
  assert.equal(orch.library.list({ roomId: room.id }).length, 1);
  assert.equal(walk(join(dir, "Library")).filter((p) => p.endsWith(".md")).length, 1);

  // same title in another goal is a different document
  const c = orch.library.save({ title: "Market sizing", body: "other", roomId: room.id, goalId: "goal_y", author: "claude" });
  assert.equal(c.created, true);
  assert.notEqual(c.doc.id, first.id);
  // saving again with the same author does not duplicate it
  const d = orch.library.save({ title: "Market sizing", body: "again", roomId: room.id, goalId: "goal_y", author: "claude" });
  assert.deepEqual(d.doc.frontMatter.authors, ["claude"]);
  assert.equal(d.doc.id, c.doc.id);
});

test("front matter the caller put in the body is stripped, not duplicated", () => {
  const { orch, room } = setup();
  const body = "---\ntitle: Evil\nstatus: final\nauthors: [mallory]\nid: doc_forged\n---\n\n# Real body\n";
  const { doc } = orch.library.save({ title: "Honest title", body, roomId: room.id, author: "claude" });
  const text = readFileSync(doc.path, "utf8");
  assert.equal(text.split("---\n").length, 3, "exactly one front matter block");
  const parsed = readDocument(text)!;
  assert.equal(parsed.frontMatter.title, "Honest title");
  assert.equal(parsed.frontMatter.status, "draft");
  assert.deepEqual(parsed.frontMatter.authors, ["claude"]);
  assert.notEqual(parsed.frontMatter.id, "doc_forged");
  assert.equal(parsed.body, "# Real body\n");
  assert.throws(() => orch.library.save({ title: "Only fm", body: "---\ntitle: x\n---\n", roomId: room.id, author: "claude" }), /empty/);
});

test("hostile titles, goals and rooms never escape the Library root", () => {
  const { orch, store, room, dir } = setup();
  const root = join(dir, "Library");
  const inside = (p: string) => assert.ok(!relative(root, p).startsWith("..") && !relative(root, p).split(sep).includes(".."), p);
  const hostile = ["../../etc/passwd", "..", "../", "/etc/passwd", "a/../../b", "\u0000null", "C:\\Windows\\System32", "!!!", "   ", "日本語", "x".repeat(500), "..\\..\\evil"];
  for (const title of hostile) {
    let saved: ReturnType<typeof orch.library.save> | undefined;
    try { saved = orch.library.save({ title, body: "x", roomId: room.id, author: "claude" }); }
    catch (e) { assert.match((e as Error).message, /Title|empty/, `rejected cleanly: ${JSON.stringify(title)}`); continue; }
    inside(saved.doc.path);
    const name = saved.doc.relPath.split("/").at(-1)!;
    assert.match(name, /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,60}\.md$/, name);
    assert.ok(saved.doc.frontMatter.title.length <= 200);
  }
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("!!!"), "untitled");
  assert.equal(slugify("x".repeat(500)).length, 60);
  assert.ok(!slugify("a".repeat(59) + " b").endsWith("-"));

  for (const goalId of ["../x", "a/b", "..", "", "x y", "g\u0000"]) {
    assert.throws(() => orch.library.save({ title: "t", body: "x", roomId: room.id, goalId, author: "claude" }), /Invalid goal/, JSON.stringify(goalId));
  }
  // a room named like a traversal still lands inside
  const evil = store.createRoom("../../../tmp/evil");
  inside(orch.library.save({ title: "t", body: "x", roomId: evil.id, author: "claude" }).doc.path);
  assert.throws(() => orch.library.save({ title: "t", body: "x", roomId: "room_nope", author: "claude" }), /Room not found/);
  assert.throws(() => orch.library.save({ title: "t", body: "x", roomId: room.id, status: "nope" as never, author: "claude" }), /Status/);
  for (const p of walk(root)) inside(p);
  assert.ok(!existsSync(join(dir, "etc")), "nothing written next to the Library");
});

test("the store index lists, filters and finds documents", () => {
  const { orch, store, room } = setup();
  const other = store.createRoom("other");
  const a = orch.library.save({ title: "A", body: "a", roomId: room.id, author: "claude" }).doc;
  const b = orch.library.save({ title: "B", body: "b", roomId: room.id, goalId: "goal_1", author: "claude" }).doc;
  const c = orch.library.save({ title: "C", body: "c", roomId: other.id, goalId: "goal_1", author: "codex" }).doc;
  const ids = (l: LibraryDoc[]) => l.map((d) => d.id).sort();
  assert.deepEqual(ids(orch.library.list({ roomId: room.id })), ids([a, b]));
  assert.deepEqual(ids(orch.library.list({ goalId: "goal_1" })), ids([b, c]));
  assert.deepEqual(ids(orch.library.list({ roomId: room.id, goalId: "goal_1" })), [b.id]);
  assert.equal(orch.library.list().length, 3);
  assert.deepEqual(orch.library.get(a.id), a);
  assert.deepEqual(store.findDocumentByPath(c.path), c);
  assert.equal(store.getDocument("doc_missing"), undefined);
  assert.equal(orch.library.get(a.id)!.roomId, room.id);
});

test("end to end: an agent saves a document over MCP and it lands in the Library and the API", async () => {
  const { app, base, code, room, store, orch } = await boot();
  const goal: Goal = { id: "goal_e2e0001", roomId: room.id, text: "Q4 competitive read", status: "running", createdAt: Date.now() };
  store.saveGoal(goal);
  const task: Task = { id: "task_e2e0001", roomId: room.id, goalId: goal.id, title: "Write the read", description: "d", taskType: "writing", acceptance: "a", dependsOn: [], assignee: "claude", status: "running", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() };
  store.saveTask(task);
  const mcpToken = "tok_e2e_agent";
  orch.grants.set(mcpToken, { agentId: "claude", roomId: room.id, taskId: task.id });

  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }));
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some((t) => t.name === "save_document"));
  assert.ok(tools.some((t) => t.name === "list_documents"));
  assert.match(tools.find((t) => t.name === "save_document")!.description ?? "", /instead of writing/);

  const call = async (args: Record<string, unknown>) => (await client.callTool({ name: "save_document", arguments: args })).content as { text: string }[];
  const first = JSON.parse((await call({
    title: 'Q4: "competitive" read', body: "---\ntitle: spoof\n---\n# Findings\n\nTAIV is a box.", status: "review",
    sources: ["https://example.com/taiv"], tags: ["taiv"],
  }))[0].text) as { id: string; path: string; relPath: string; created: boolean };
  assert.equal(first.created, true);
  assert.match(first.id, /^doc_/);
  assert.ok(first.path.startsWith(join(orch.library.root, "")), "inside the Library root");
  assert.ok(first.relPath.includes(`/${goal.id}/`), "filed under the task's goal");

  const text = readFileSync(first.path, "utf8");
  const parsed = readDocument(text)!;
  assert.ok(parsed, "file on disk has valid front matter");
  assert.equal(parsed.frontMatter.id, first.id);
  assert.equal(parsed.frontMatter.title, 'Q4: "competitive" read');
  assert.ok(parsed.frontMatter.authors.includes("claude"));
  assert.equal(parsed.frontMatter.room, slugify(room.name));
  assert.equal(parsed.frontMatter.goal, goal.id);
  assert.equal(parsed.frontMatter.status, "review");
  assert.equal(parsed.frontMatter.created, today());
  assert.deepEqual(parsed.frontMatter.sources, ["https://example.com/taiv"]);
  assert.deepEqual(parsed.frontMatter.tags, ["taiv"]);
  assert.equal(parsed.body, "# Findings\n\nTAIV is a box.\n");
  assert.ok(existsSync(join(first.path, "..", "assets")));

  // A second agent updates the same document.
  orch.grants.set("tok_e2e_codex", { agentId: "codex", roomId: room.id, taskId: task.id });
  const c2 = new Client({ name: "test2", version: "1" });
  await c2.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer tok_e2e_codex" } } }));
  const second = JSON.parse(((await c2.callTool({ name: "save_document", arguments: { title: 'Q4: "competitive" read', body: "# Findings v2" } })).content as { text: string }[])[0].text);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.deepEqual(readDocument(readFileSync(first.path, "utf8"))!.frontMatter.authors, ["claude", "codex"]);

  // Bad input is refused without writing.
  assert.match((await call({ title: "x", body: "y", goalId: "nope" }))[0].text, /NOT SAVED/);
  assert.match((await call({ title: "x", body: "y", goalId: "../../etc" }))[0].text, /NOT SAVED/);
  assert.equal(orch.library.list().length, 1);

  const listed = (await client.callTool({ name: "list_documents", arguments: {} })).content as { text: string }[];
  assert.equal(listed[0].text, `${first.relPath} | Q4: "competitive" read | review`);

  // REST: behind device auth, filterable.
  assert.equal((await fetch(`${base}/documents`)).status, 401);
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  const h = { authorization: `Bearer ${token}` };
  const all = (await (await fetch(`${base}/documents`, { headers: h })).json()) as LibraryDoc[];
  assert.equal(all.length, 1);
  assert.equal(all[0].id, first.id);
  assert.equal(all[0].path, first.path);
  assert.equal(all[0].frontMatter.goal, goal.id);
  assert.equal(((await (await fetch(`${base}/documents?roomId=${room.id}&goalId=${goal.id}`, { headers: h })).json()) as LibraryDoc[]).length, 1);
  assert.equal(((await (await fetch(`${base}/documents?goalId=goal_other`, { headers: h })).json()) as LibraryDoc[]).length, 0);

  // An agent with no task still saves, under general/.
  const t = await fetch(`${base}/mcp-tokens`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ agentId: "ext", name: "External" }) });
  const ext = new Client({ name: "ext", version: "1" });
  await ext.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${((await t.json()) as { token: string }).token}` } } }));
  const loose = JSON.parse(((await ext.callTool({ name: "save_document", arguments: { title: "Loose notes", body: "n" } })).content as { text: string }[])[0].text);
  assert.ok(loose.relPath.includes("/general/"));
  assert.deepEqual(readDocument(readFileSync(loose.path, "utf8"))!.frontMatter.authors, ["ext"]);

  await client.close(); await c2.close(); await ext.close();
  await app.close();
});
