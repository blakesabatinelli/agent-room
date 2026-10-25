import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Goal, Room, RoomDeleteResponse, ServerEvent, Task } from "@agent-room/shared";
import { setup, localPairHeaders } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { appendStep, listSteps } from "../src/durable/steps.js";
import { saveFork } from "../src/fork/records.js";
import { quotaFor } from "../src/quota/index.js";

type Ctx = ReturnType<typeof setup>;

async function boot() {
  const ctx = setup();
  const app = await buildServer({ ...ctx, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const pair = await fetch(`${base}/pair/local`, { method: "POST", headers: localPairHeaders(ctx.dir), body: JSON.stringify({ deviceName: "Mac" }) });
  const { token } = (await pair.json()) as { token: string };
  return { ...ctx, app, base, h: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}
type B = Awaited<ReturnType<typeof boot>>;
const del = (b: B, roomId: string, q = "") => fetch(`${b.base}/rooms/${roomId}${q}`, { method: "DELETE", headers: b.h });

/** Fill every kind of row a room can have: a goal with two tasks, messages, routing, an approval, a document, memory, a reply turn and goal steps. */
function fill(ctx: Ctx, room: Room, tag: string, goalStatus: Goal["status"] = "done", taskStatus: Task["status"] = "done") {
  const { store, orch } = ctx;
  const goal: Goal = { id: `goal_${tag}`, roomId: room.id, text: `Goal ${tag}`, status: goalStatus, createdAt: Date.now() } as Goal;
  store.saveGoal(goal);
  for (const n of [1, 2]) store.saveTask({ id: `task_${tag}_${n}`, roomId: room.id, goalId: goal.id, title: `Task ${n}`, description: "d", taskType: "writing", acceptance: "a", dependsOn: [], status: n === 1 ? taskStatus : "done" } as never);
  store.addMessage({ roomId: room.id, author: { kind: "owner", id: "owner", name: "Blake" }, type: "chat", text: `hello ${tag}`, mentions: [] } as never);
  store.addMessage({ roomId: room.id, author: { kind: "owner", id: "owner", name: "Blake" }, type: "chat", text: `again ${tag}`, mentions: [] } as never);
  store.saveRouting({ id: `route_${tag}`, at: Date.now(), roomId: room.id, goalId: goal.id, goalText: "g", taskId: `task_${tag}_1`, taskTitle: "t", taskType: "writing", kind: "task", attempt: 1, revision: false, reason: "best", epsilon: 0, candidates: [], chosen: "claude", pChosen: 1, outcome: "pending" } as never);
  store.saveApproval({ id: `appr_${tag}`, roomId: room.id, agentId: "claude", tool: "shell", action: "run", detail: "ls", status: "pending", createdAt: Date.now() });
  store.saveDocument({ id: `doc_${tag}`, path: `/x/${tag}.md`, relPath: `${tag}.md`, roomId: room.id, goalId: goal.id, frontMatter: {} as never, bytes: 1, indexedAt: 1 });
  store.saveMemory({ id: `mem_${tag}`, scope: "shared", roomId: room.id, text: `fact ${tag}`, sourceAgentId: "claude", confidence: 0.9, createdAt: Date.now() } as never);
  store.saveMemory({ id: `memp_${tag}`, scope: "private", ownerAgentId: "claude", roomId: room.id, text: `note ${tag}`, sourceAgentId: "claude", confidence: 0.9, createdAt: Date.now() } as never);
  store.saveProposal({ id: `prop_${tag}`, roomId: room.id, text: "p", sourceAgentId: "claude", confidence: 0.5, status: "pending", createdAt: Date.now() });
  orch.turns.start(room.id, "claude", "owner", `trigger_${tag}`);
  appendStep(store, { goalId: goal.id, kind: "plan_made", data: {} });
  appendStep(store, { goalId: goal.id, taskId: `task_${tag}_1`, kind: "run_started" });
  saveFork(store, { id: `fork_${tag}`, roomId: room.id, text: "f", createdAt: Date.now(), sides: [], target: { kind: "hub" }, requirements: [] } as never);
  store.setKV("write_proposals", [...store.getKV<object[]>("write_proposals", []), { id: `wp_${tag}`, roomId: room.id }]);
  store.setKV("read_marks", { ...store.getKV<Record<string, number>>("read_marks", {}), [room.id]: 5 });
}

/** Row counts that belong to a room, across every table. */
function rows(ctx: Ctx, roomId: string) {
  const { store } = ctx;
  const n = (sql: string, ...a: unknown[]) => (store.db.prepare(sql).get(...a) as { n: number }).n;
  const goals = "SELECT id FROM goals WHERE room_id=?";
  return {
    room: store.getRoom(roomId) ? 1 : 0,
    goals: n("SELECT COUNT(*) n FROM goals WHERE room_id=?", roomId),
    tasks: n("SELECT COUNT(*) n FROM tasks WHERE room_id=?", roomId),
    messages: n("SELECT COUNT(*) n FROM messages WHERE room_id=?", roomId),
    routing: n(`SELECT COUNT(*) n FROM routing WHERE goal_id IN (${goals}) OR json_extract(data,'$.roomId')=?`, roomId, roomId),
    approvals: n("SELECT COUNT(*) n FROM approvals WHERE json_extract(data,'$.roomId')=?", roomId),
    documents: n("SELECT COUNT(*) n FROM documents WHERE room_id=?", roomId),
    memory: n("SELECT COUNT(*) n FROM memory WHERE room_id=?", roomId),
    proposals: n("SELECT COUNT(*) n FROM proposals WHERE json_extract(data,'$.roomId')=?", roomId),
    replyTurns: n("SELECT COUNT(*) n FROM reply_turns WHERE room_id=?", roomId),
    goalSteps: n(`SELECT COUNT(*) n FROM goal_steps WHERE goal_id IN (${goals})`, roomId),
    forks: n("SELECT COUNT(*) n FROM forks WHERE room_id=?", roomId),
  };
}

test("deleteroom: deleting a room removes it and its rows in every table, and leaves other rooms alone", async () => {
  const b = await boot();
  try {
    const keep = b.store.listRooms()[0];
    const doomed = b.store.createRoom("doomed");
    fill(b, keep, "keep");
    fill(b, doomed, "doomed");
    const before = rows(b, keep.id);
    assert.deepEqual(before, { room: 1, goals: 1, tasks: 2, messages: 2, routing: 1, approvals: 1, documents: 1, memory: 2, proposals: 1, replyTurns: 1, goalSteps: 2, forks: 1 });
    assert.deepEqual(rows(b, doomed.id), before, "the doomed room has one of everything too");
    const events: ServerEvent[] = [];
    b.store.on("event", (e: ServerEvent) => events.push(e));

    const res = await del(b, doomed.id);
    assert.equal(res.status, 200);
    const body = (await res.json()) as RoomDeleteResponse;
    assert.equal(body.ok, true);
    assert.deepEqual(body.counts, { goals: 1, tasks: 2, messages: 2, routing: 1, approvals: 1, documents: 1, replyTurns: 1, goalSteps: 2, memory: 2, proposals: 1, forks: 1, writeProposals: 1, rooms: 1 });
    assert.deepEqual(b.store.getKV<{ id: string }[]>("write_proposals", []).map((p) => p.id), ["wp_keep"], "a file write-back asked for in the room goes with it");

    assert.deepEqual(rows(b, doomed.id), { room: 0, goals: 0, tasks: 0, messages: 0, routing: 0, approvals: 0, documents: 0, memory: 0, proposals: 0, replyTurns: 0, goalSteps: 0, forks: 0 });
    assert.equal(b.store.getTask("task_doomed_1"), undefined);
    assert.deepEqual(listSteps(b.store, "goal_doomed"), []);
    assert.equal(b.store.getKV<Record<string, number>>("read_marks", {})[doomed.id], undefined);
    assert.ok(!(await (await fetch(`${b.base}/rooms`, { headers: b.h })).json() as Room[]).some((r) => r.id === doomed.id));
    assert.ok(events.some((e) => e.type === "room_deleted" && e.roomId === doomed.id), "clients are told to drop it");

    // The other room is exactly as it was.
    assert.deepEqual(rows(b, keep.id), before);
    assert.equal(listSteps(b.store, "goal_keep").length, 2);
    assert.equal(b.store.getKV<Record<string, number>>("read_marks", {})[keep.id], 5);
  } finally { await b.app.close(); }
});

test("deleteroom: the audit line names the room and what was removed", async () => {
  const b = await boot();
  try {
    const r = b.store.createRoom("old-news");
    fill(b, r, "old");
    await del(b, r.id);
    const line = b.store.listAudit().find((a) => a.action === "room.deleted")!;
    assert.equal(line.actor, "owner");
    assert.equal(line.detail, "old-news: removed goals 1, tasks 2, messages 2, routing rows 1, approvals 1, documents 1, reply turns 1, goal steps 2, memory 2, memory proposals 1, forks 1, write proposals 1");
    assert.ok(!/forced/.test(line.detail));
  } finally { await b.app.close(); }
});

test("deleteroom: a running goal blocks the delete without force, and nothing is removed", async () => {
  const b = await boot();
  try {
    const r = b.store.createRoom("busy");
    fill(b, r, "busy", "running", "running");
    const stops: string[] = [];
    const real = b.orch.stopRoom.bind(b.orch);
    b.orch.stopRoom = (id: string) => { stops.push(id); real(id); };
    const res = await del(b, r.id);
    assert.equal(res.status, 400);
    const { error } = (await res.json()) as { error: string };
    assert.match(error, /still going/i);
    assert.ok(!error.includes("—"), "plain message");
    assert.equal(stops.length, 0, "nothing was stopped");
    assert.equal(rows(b, r.id).goals, 1);
    assert.equal(rows(b, r.id).room, 1);
    assert.equal(b.store.getGoal("goal_busy")!.status, "running");
    assert.ok(!b.store.listAudit().some((a) => a.action === "room.deleted"));
  } finally { await b.app.close(); }
});

test("deleteroom: a task in review or revising blocks the delete too", async () => {
  const b = await boot();
  try {
    for (const status of ["review", "revising"] as const) {
      const r = b.store.createRoom(`judging-${status}`);
      fill(b, r, status, "paused", status);
      const res = await del(b, r.id);
      assert.equal(res.status, 400, status);
      assert.equal(rows(b, r.id).room, 1);
    }
  } finally { await b.app.close(); }
});

test("deleteroom: ?force=1 stops the room first, then deletes it", async () => {
  const b = await boot();
  try {
    const other = b.store.listRooms()[0];
    fill(b, other, "other", "running", "running");
    const r = b.store.createRoom("forced");
    fill(b, r, "forced", "running", "review");
    const order: string[] = [];
    const stop = b.orch.stopRoom.bind(b.orch);
    b.orch.stopRoom = (id: string) => { order.push(`stop:${id}:${b.store.getRoom(id) ? "present" : "gone"}`); stop(id); };
    const drop = b.orch.dropRoomWorktrees.bind(b.orch);
    b.orch.dropRoomWorktrees = (id: string) => { order.push(`worktrees:${id}`); return drop(id); };

    const res = await del(b, r.id, "?force=1");
    assert.equal(res.status, 200);
    assert.deepEqual(order, [`stop:${r.id}:present`, `worktrees:${r.id}`], "stopped while the room still existed, then its worktrees were dropped");
    assert.equal(rows(b, r.id).room, 0);
    assert.equal(rows(b, r.id).goals, 0);
    assert.equal(rows(b, r.id).messages, 0, "including the line stopRoom posted");
    assert.match(b.store.listAudit().find((a) => a.action === "room.deleted")!.detail, /\(forced\)$/);
    // Stopping the room did not touch another room's running goal.
    assert.equal(b.store.getGoal("goal_other")!.status, "running");
    assert.equal(rows(b, other.id).tasks, 2);
  } finally { await b.app.close(); }
});

test("deleteroom: a finished room deletes without force, a DM room like any other, the last channel never", async () => {
  const b = await boot();
  try {
    const channels = b.store.listRooms().filter((r) => !r.dmAgentId);
    const dm = b.store.dmRoom("claude", "Claude");
    fill(b, dm, "dm");
    assert.equal((await del(b, dm.id)).status, 200);
    assert.equal(b.store.getRoom(dm.id), undefined);
    assert.equal((await del(b, "room_nope")).status, 404);
    // Down to one channel: refused, with a plain message.
    for (const c of channels.slice(1)) assert.equal((await del(b, c.id)).status, 200);
    const last = await del(b, channels[0].id);
    assert.equal(last.status, 400);
    assert.match(((await last.json()) as { error: string }).error, /at least one channel/i);
    assert.ok(b.store.getRoom(channels[0].id));
  } finally { await b.app.close(); }
});

test("deleteroom: only the hub's own data is touched, not the control folder or a granted folder", async () => {
  const b = await boot();
  try {
    const control = join(b.dir, "Agent Room");
    mkdirSync(join(control, "rooms", "scratch"), { recursive: true });
    writeFileSync(join(control, "rooms", "scratch", "ROOM.md"), "# scratch\n");
    const granted = join(b.dir, "owner-project");
    mkdirSync(granted, { recursive: true });
    writeFileSync(join(granted, "notes.txt"), "mine");
    const r = b.store.createRoom("scratch");
    fill(b, r, "scratch");
    const doc = join(granted, "doc.md");
    writeFileSync(doc, "doc");
    assert.equal((await del(b, r.id)).status, 200);
    assert.ok(existsSync(join(control, "rooms", "scratch", "ROOM.md")));
    assert.ok(existsSync(join(granted, "notes.txt")));
    assert.ok(existsSync(doc), "a library document's row goes, never the file");
  } finally { await b.app.close(); }
});

test("deleteroom: history about agents stays (usage ledger, scores)", async () => {
  const b = await boot();
  try {
    const r = b.store.createRoom("hist");
    fill(b, r, "hist");
    const q = quotaFor(b.store);
    q.ledger.record({ agentId: "claude", subscriptionId: "claude", at: Date.now(), tokensIn: 10, tokensOut: 5, runs: 1, rateLimited: false, source: "task", taskId: "task_hist_1" });
    await del(b, r.id);
    assert.equal(q.ledger.since("claude", 0).length, 1);
  } finally { await b.app.close(); }
});

test("deleteroom: a room's fork lanes go with it, and a lane's running goal blocks the delete", async () => {
  const b = await boot();
  try {
    const r = b.store.createRoom("parent");
    const lane = { ...b.store.createRoom("fork-abc-a"), forkId: "fork_x", forkSide: "a", forkOf: r.id } as Room;
    b.store.saveRoom(lane);
    fill(b, lane, "lane", "running", "running");
    assert.equal((await del(b, r.id)).status, 400, "work on a lane is work in the room");
    assert.ok(b.store.getRoom(lane.id));
    const res = await del(b, r.id, "?force=1");
    assert.equal(res.status, 200);
    const { counts } = (await res.json()) as RoomDeleteResponse;
    assert.equal(counts.rooms, 2);
    assert.equal(counts.goals, 1);
    assert.equal(b.store.getRoom(lane.id), undefined);
    assert.equal(rows(b, lane.id).goals, 0);
  } finally { await b.app.close(); }
});
