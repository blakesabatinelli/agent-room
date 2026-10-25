import { test } from "node:test";
import assert from "node:assert/strict";
import { takeHubLock, type HubLock } from "../src/main/hublock.js";

// Single-hub guard: two hubs must not both drive the orchestrator loops against one DB.

/** An in-memory lock file for the tests (no real filesystem or process). */
function fakeFile() {
  let content: string | undefined;
  return {
    read: (_f: string) => { if (content === undefined) throw new Error("ENOENT"); return content; },
    write: (_f: string, s: string) => { content = s; },
    get value() { return content ? (JSON.parse(content) as HubLock) : undefined; },
  };
}

test("a fresh start takes the lock and records its pid", () => {
  const f = fakeFile();
  const r = takeHubLock({ file: "x", pid: 100, port: 4747, read: f.read, write: f.write, alive: () => true, now: () => 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(f.value, { pid: 100, at: 1, port: 4747 });
  assert.match(r.message, /took the hub lock/);
});

test("a second live hub is refused and the lock is left untouched", () => {
  const f = fakeFile();
  takeHubLock({ file: "x", pid: 100, read: f.read, write: f.write, alive: () => true, now: () => 1 });
  const r = takeHubLock({ file: "x", pid: 200, read: f.read, write: f.write, alive: (pid) => pid === 100, now: () => 2 });
  assert.equal(r.ok, false);
  assert.equal(r.held!.pid, 100);
  assert.match(r.message, /Another Agent Room hub is already running/);
  assert.equal(f.value!.pid, 100, "the holder's lock is not overwritten");
});

test("a stale lock (dead pid) is taken over", () => {
  const f = fakeFile();
  takeHubLock({ file: "x", pid: 100, read: f.read, write: f.write, alive: () => true, now: () => 1 });
  const r = takeHubLock({ file: "x", pid: 200, read: f.read, write: f.write, alive: () => false, now: () => 2 });
  assert.equal(r.ok, true);
  assert.match(r.message, /took over a stale lock/);
  assert.equal(f.value!.pid, 200);
});

test("re-taking our own lock is fine", () => {
  const f = fakeFile();
  takeHubLock({ file: "x", pid: 100, read: f.read, write: f.write, alive: () => true, now: () => 1 });
  const r = takeHubLock({ file: "x", pid: 100, read: f.read, write: f.write, alive: () => true, now: () => 2 });
  assert.equal(r.ok, true);
  assert.equal(f.value!.at, 2, "the lock is refreshed");
});

test("no lock file yet: the first hub takes it", () => {
  const f = fakeFile();
  const r = takeHubLock({ file: "x", pid: 7, read: f.read, write: f.write, alive: () => true });
  assert.equal(r.ok, true);
  assert.equal(f.value!.pid, 7);
});
