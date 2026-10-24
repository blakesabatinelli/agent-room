import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Room } from "@agent-room/shared";
import { buildServer } from "../src/api/server.js";
import { setup } from "./helpers.js";

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "rf-")));

/** Wait until the room's goals have finished, so the next message starts a new goal instead of steering this one. */
async function settle(store: ReturnType<typeof setup>["store"], roomId: string) {
  for (let i = 0; i < 200 && store.listGoals(roomId).some((g) => ["planning", "running", "paused", "awaiting_approval"].includes(g.status)); i++) await new Promise((r) => setTimeout(r, 25));
}

async function boot() {
  const c = setup();
  c.store.setSettings({ ...c.store.getSettings(), planApproval: "never" }); // a goal runs to the end, so the next message starts a new one
  const app = await buildServer({ ...c, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = (app as unknown as { pairingCode: () => string }).pairingCode();
  const { token } = (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Mac" }) })).json()) as { token: string };
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const putRoom = (id: string, body: unknown) => fetch(`${base}/rooms/${id}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
  const send = async (id: string, body: Record<string, unknown>) => { const r = await fetch(`${base}/rooms/${id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Write a two line poem about bars", ...body }) }); await settle(c.store, id); return r; };
  const goals = (id: string) => c.store.listGoals(id).sort((a, b) => a.createdAt - b.createdAt);
  const audit = (action: string) => c.store.listAudit(5000).filter((a) => a.action === action).length;
  return { ...c, app, base, auth, putRoom, send, goals, audit };
}

test("set and clear a room's default folder over HTTP", async () => {
  const b = await boot();
  const g = b.orch.files.addGrant({ path: dir(), label: "notes", roomId: b.room.id, agentId: "*", read: true, write: false });
  const r = await b.putRoom(b.room.id, { folderGrantId: g.id });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as Room).folderGrantId, g.id);
  assert.equal(b.store.getRoom(b.room.id)!.folderGrantId, g.id);
  assert.equal(((await (await fetch(`${b.base}/rooms`, { headers: b.auth })).json()) as Room[]).find((x) => x.id === b.room.id)!.folderGrantId, g.id, "GET /rooms carries it");
  // renaming leaves the default alone
  assert.equal(((await (await b.putRoom(b.room.id, { topic: "venues" })).json()) as Room).folderGrantId, g.id);
  const c = await b.putRoom(b.room.id, { folderGrantId: null });
  assert.equal(c.status, 200);
  assert.equal(((await c.json()) as Room).folderGrantId, undefined);
  assert.equal(b.store.getRoom(b.room.id)!.folderGrantId, undefined);
  assert.equal(b.audit("room.folder.set"), 1);
  assert.equal(b.audit("room.folder.cleared"), 1);
  await b.app.close();
});

test("a goal started with no folder named uses the room's default", async () => {
  const b = await boot();
  const g = b.orch.files.addGrant({ path: dir(), label: "notes", agentId: "*", read: true, write: false }); // an all-rooms grant works too
  assert.equal((await b.putRoom(b.room.id, { folderGrantId: g.id })).status, 200);
  assert.equal((await b.send(b.room.id, {})).status, 200);
  assert.equal(b.goals(b.room.id)[0].sourceGrantId, g.id);
  await b.app.close();
});

test('folderGrantId "" means no folder for this message, and old clients that send nothing get the default', async () => {
  const b = await boot();
  const g = b.orch.files.addGrant({ path: dir(), roomId: b.room.id, agentId: "*", read: true, write: false });
  await b.putRoom(b.room.id, { folderGrantId: g.id });
  assert.equal((await b.send(b.room.id, { folderGrantId: "" })).status, 200);
  assert.equal(b.goals(b.room.id)[0].sourceGrantId, undefined, "explicit No folder wins");
  assert.equal((await b.send(b.room.id, {})).status, 200);
  assert.equal(b.goals(b.room.id)[1].sourceGrantId, g.id, "nothing sent = the default");
  assert.equal(b.store.getRoom(b.room.id)!.folderGrantId, g.id, "the default itself is unchanged");
  await b.app.close();
});

test("an explicit folder still beats the default", async () => {
  const b = await boot();
  const a = b.orch.files.addGrant({ path: dir(), roomId: b.room.id, agentId: "*", read: true, write: false });
  const other = b.orch.files.addGrant({ path: dir(), roomId: b.room.id, agentId: "*", read: true, write: false });
  await b.putRoom(b.room.id, { folderGrantId: a.id });
  await b.send(b.room.id, { folderGrantId: other.id });
  assert.equal(b.goals(b.room.id)[0].sourceGrantId, other.id);
  await b.app.close();
});

test("a grant this room can't use is refused with a plain message", async () => {
  const b = await boot();
  const elsewhere = b.store.createRoom("elsewhere");
  const mine = b.orch.files.addGrant({ path: dir(), agentId: "claude", read: true, write: true });
  const scoped = b.orch.files.addGrant({ path: dir(), agentId: "*", roomId: elsewhere.id, read: true, write: false });
  const noRead = b.orch.files.addGrant({ path: dir(), agentId: "*", read: false, write: true });
  for (const [id, why] of [[mine.id, /one agent only/], [scoped.id, /different room/], [noRead.id, /isn't readable/], ["grant_nope", /doesn't exist/]] as const) {
    const r = await b.putRoom(b.room.id, { folderGrantId: id });
    assert.equal(r.status, 400, id);
    assert.match(((await r.json()) as { error: string }).error, why);
  }
  assert.equal(b.store.getRoom(b.room.id)!.folderGrantId, undefined);
  const r = await b.putRoom(b.room.id, { name: "renamed", folderGrantId: scoped.id });
  assert.equal(r.status, 400);
  assert.notEqual(b.store.getRoom(b.room.id)!.name, "renamed", "a refused request changes nothing");
  assert.equal((await b.putRoom("room_nope", { folderGrantId: null })).status, 404);
  await b.app.close();
});

test("removing the grant clears the default; a default that stops working is skipped with one system line", async () => {
  const b = await boot();
  const g = b.orch.files.addGrant({ path: dir(), roomId: b.room.id, agentId: "*", read: true, write: false });
  await b.putRoom(b.room.id, { folderGrantId: g.id });
  assert.equal((await fetch(`${b.base}/folder-grants/${g.id}`, { method: "DELETE", headers: b.auth })).status, 200);
  assert.equal(b.store.getRoom(b.room.id)!.folderGrantId, undefined);
  assert.equal(b.audit("room.folder.cleared"), 1);
  await b.send(b.room.id, {});
  assert.equal(b.goals(b.room.id)[0].sourceGrantId, undefined);

  // narrowing the grant to one agent leaves the default pointing at a grant that can't carry a goal
  const h = b.orch.files.addGrant({ path: dir(), roomId: b.room.id, agentId: "*", read: true, write: false });
  await b.putRoom(b.room.id, { folderGrantId: h.id });
  b.orch.files.updateGrant(h.id, { agentId: "claude" });
  await b.send(b.room.id, {});
  assert.equal(b.goals(b.room.id)[1].sourceGrantId, undefined, "started with no folder");
  const notes = b.store.listMessages(b.room.id).filter((m) => m.type === "system" && /Starting without the room's folder/.test(m.text));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /one agent only/);
  await b.app.close();
});

test("a direct-message room can't have a default folder", async () => {
  const b = await boot();
  const g = b.orch.files.addGrant({ path: dir(), agentId: "*", read: true, write: false });
  const dm = b.store.dmRoom("claude", "Claude");
  const r = await b.putRoom(dm.id, { folderGrantId: g.id });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /direct message/i);
  assert.equal(b.store.getRoom(dm.id)!.folderGrantId, undefined);
  await b.app.close();
});

test("the phone's room info lists room folders without inline styles, and the Mac module exports chooseFolder", () => {
  const web = readFileSync(join(import.meta.dirname, "../web/app.js"), "utf8");
  for (const s of ["data-rf-default", "data-rf-remove", "Make default", "Remove from room", "Add folders from the Mac app.", "putRoom(null)"]) assert.ok(web.includes(s), s);
  const code = web.slice(web.indexOf("async function loadRoomFolders"), web.indexOf("// The control folder (CONTROL.md)"));
  assert.ok(code.length > 1000 && !/setAttribute\("style"|style="/.test(code), "no inline styles in the room folders code");
  const m = readFileSync(join(import.meta.dirname, "../../app/macos/AgentRoom-macOS/HubLauncher.m"), "utf8");
  const body = m.slice(m.indexOf("RCT_EXPORT_METHOD(chooseFolder:"), m.indexOf("RCT_EXPORT_METHOD(updaterAvailable:"));
  for (const s of ["dispatch_get_main_queue", "NSOpenPanel", "canChooseDirectories = YES", "canChooseFiles = NO", "allowsMultipleSelection = NO", "canCreateDirectories = YES", "[NSNull null]"]) assert.ok(body.includes(s), s);
});
