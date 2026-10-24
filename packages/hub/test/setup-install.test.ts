// The in-app "Install Claude Code" said "didn't install" right after the installer printed success: its clean-up of an older npm install can
// remove the link it just made. The script now checks that `claude` starts and runs the installer a second time if needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGIN } from "../src/setup.js";

function run(firstInstallWorks: boolean) {
  const home = mkdtempSync(join(tmpdir(), "ar-home-"));
  const bin = join(home, "stub");
  mkdirSync(join(home, ".agent-room"), { recursive: true });
  mkdirSync(bin);
  // curl stands in for the download: it prints an installer that makes ~/.local/bin/claude, except the first time when the "clean-up" removes it.
  writeFileSync(join(bin, "curl"), `#!/bin/sh
n=$(cat "$HOME/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$HOME/count"
if [ $n -eq 1 ] && [ "$FIRST_OK" != 1 ]; then echo 'echo "installed"; mkdir -p "$HOME/.local/bin"; rm -f "$HOME/.local/bin/claude"'; exit 0; fi
echo 'mkdir -p "$HOME/.local/bin"; printf "#!/bin/sh\\necho 2.1.0\\n" > "$HOME/.local/bin/claude"; chmod +x "$HOME/.local/bin/claude"; echo installed'
`);
  chmodSync(join(bin, "curl"), 0o755);
  const script = LOGIN["claude-code"].cmd;
  const r = spawnSync("/bin/bash", ["-c", script], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FIRST_OK: firstInstallWorks ? "1" : "0" }, input: "\n", encoding: "utf8", timeout: 20000 });
  return { r, home, log: readFileSync(join(home, ".agent-room", "signin-claude.log"), "utf8"), curls: Number(readFileSync(join(home, "count"), "utf8")) };
}

test("Claude install: a first install that leaves no working claude is finished by a second run, and the check is that claude starts", () => {
  const { r, home, log, curls } = run(false);
  assert.equal(curls, 2, "the installer ran twice");
  assert.ok(existsSync(join(home, ".local/bin/claude")));
  assert.doesNotMatch(log, /didn't install/);
  assert.match(log, /Claude Code: .*\.local\/bin\/claude 2\.1\.0/);
  assert.equal(r.status, 0, r.stderr);
});

test("Claude install: one run is enough when it works", () => {
  const { curls, log } = run(true);
  assert.equal(curls, 1);
  assert.match(log, /Claude Code: /);
});
