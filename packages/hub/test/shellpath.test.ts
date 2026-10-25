// "spawn claude ENOENT" from a Finder launch: the hub now adds the owner's login-shell PATH and the usual install folders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedShellPath, hubPath, knownCliDirs, loginShellPath, parseShellPath, readShellPathCache, writeShellPathCache } from "../src/env/shellPath.js";
import { runProc } from "../src/adapters/proc.js";

test("the PATH is read between markers, whatever the shell's rc files print around it", () => {
  assert.equal(parseShellPath("Welcome!\n__AGENT_ROOM_PATH__/a/bin:/usr/bin__AGENT_ROOM_PATH__\nbye"), "/a/bin:/usr/bin");
  assert.equal(parseShellPath("no markers"), undefined);
  assert.equal(parseShellPath("__AGENT_ROOM_PATH__ __AGENT_ROOM_PATH__"), undefined);
});

test("a login shell's PATH is read (a fake shell stands in for zsh), and a broken shell gives nothing instead of hanging", () => {
  const d = mkdtempSync(join(tmpdir(), "ar-sh-"));
  const sh = join(d, "fakesh");
  writeFileSync(sh, "#!/bin/sh\necho 'motd noise'\nPATH=/from/rc/bin:/usr/bin\nexec /bin/sh -c \"$2\"\n");
  chmodSync(sh, 0o755);
  assert.equal(loginShellPath(sh), "/from/rc/bin:/usr/bin");
  assert.equal(loginShellPath(join(d, "missing")), undefined);
  const slow = join(d, "slow");
  writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
  chmodSync(slow, 0o755);
  assert.equal(loginShellPath(slow, 300), undefined);
});

test("known install folders that exist are added: Claude Code's ~/.claude/local, nvm's Node versions newest first, Homebrew", () => {
  const home = "/Users/x";
  const have = new Set([`${home}/.claude/local`, `${home}/.local/bin`, `${home}/.nvm/versions/node/v20.11.0/bin`, `${home}/.nvm/versions/node/v22.3.0/bin`, "/opt/homebrew/bin"]);
  const dirs = knownCliDirs(home, (p) => have.has(p), (p) => (p.endsWith(".nvm/versions/node") ? ["v20.11.0", "v22.3.0", ".cache"] : []));
  assert.deepEqual(dirs, [`${home}/.local/bin`, `${home}/.claude/local`, `${home}/.nvm/versions/node/v22.3.0/bin`, `${home}/.nvm/versions/node/v20.11.0/bin`, "/opt/homebrew/bin"]);
  assert.equal(hubPath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin", dirs), ["/usr/bin", "/bin", "/opt/homebrew/bin", ...dirs.filter((x) => x !== "/opt/homebrew/bin")].join(":"));
});

test("a program that isn't installed says so plainly instead of a bare ENOENT", async () => {
  const r = await runProc("agent-room-no-such-cli", [], {});
  assert.match(r.stderr, /agent-room-no-such-cli wasn't found on this Mac/);
  const gone = await runProc("/bin/echo", ["x"], { cwd: join(tmpdir(), "agent-room-missing-folder-xyz") });
  assert.match(gone.stderr, /doesn't exist/);
});

// Speed: the login-shell PATH is cached to disk so a restart doesn't pay the ~5s shell probe again.

test("the shell-path cache round-trips, and rejects a value without a real path", () => {
  const store: Record<string, string> = {};
  const read = (f: string) => { if (!(f in store)) throw new Error("ENOENT"); return store[f]; };
  const write = (f: string, s: string) => { store[f] = s; };
  assert.equal(readShellPathCache("c.json", read), undefined, "no file yet");
  writeShellPathCache("c.json", "/opt/homebrew/bin:/usr/bin", "/bin/zsh", write);
  assert.equal(readShellPathCache("c.json", read)!.path, "/opt/homebrew/bin:/usr/bin");
  store["bad.json"] = JSON.stringify({ path: "nopaths" });
  assert.equal(readShellPathCache("bad.json", read), undefined, "a PATH with no '/' is not usable");
  store["junk.json"] = "{not json";
  assert.equal(readShellPathCache("junk.json", read), undefined);
});

test("cachedShellPath: probes and writes when there is no cache; reuses the cache and refreshes in the background", () => {
  const store: Record<string, string> = {};
  const read = (f: string) => { if (!(f in store)) throw new Error("ENOENT"); return store[f]; };
  const write = (f: string, s: string) => { store[f] = s; };
  const run = (fn: () => void) => fn(); // run the "background" refresh synchronously in the test

  // No cache: probe now and write it.
  let probed = "/first/bin:/usr/bin";
  const first = cachedShellPath({ file: "c.json", probe: () => probed, read, write, schedule: run });
  assert.equal(first, "/first/bin:/usr/bin");
  assert.equal(readShellPathCache("c.json", read)!.path, "/first/bin:/usr/bin", "cached for next start");

  // Cache present and the probe still returns the same value: used immediately, file unchanged.
  let refreshed: string | undefined;
  const second = cachedShellPath({ file: "c.json", probe: () => probed, read, write, schedule: run, onRefresh: (p) => { refreshed = p; } });
  assert.equal(second, "/first/bin:/usr/bin", "used the cache at once");
  assert.equal(refreshed, undefined, "unchanged, so no refresh callback");

  // Cache present but the probe now differs: still used immediately, and the background refresh rewrites the file.
  probed = "/second/bin:/usr/bin";
  const third = cachedShellPath({ file: "c.json", probe: () => probed, read, write, schedule: run, onRefresh: (p) => { refreshed = p; } });
  assert.equal(third, "/first/bin:/usr/bin", "the cached value is used now, not the fresh probe");
  assert.equal(refreshed, "/second/bin:/usr/bin", "the background refresh reported the change");
  assert.equal(readShellPathCache("c.json", read)!.path, "/second/bin:/usr/bin", "and rewrote the cache for next start");
});
