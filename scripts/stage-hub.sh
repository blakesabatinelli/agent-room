#!/usr/bin/env bash
# Stages the hub's runtime folder, the one that ships inside the app as Contents/Resources/Hub:
#   hub.mjs (+ .map), web/, package.json (only the dependencies the bundle leaves external), node_modules/better-sqlite3
# better-sqlite3 is installed for the Node version and platform given, not for whatever Node is on this machine.
# Runs on a Mac (called by package-mac.sh) and on Linux (for testing the staging itself).
#   scripts/stage-hub.sh <node-binary> <node-version> <out-dir> [platform=darwin] [arch=arm64]
# Expects packages/hub/dist/hub.mjs to be built already (pnpm --filter @agent-room/hub build).
set -euo pipefail
NODE_BIN="${1:?Usage: stage-hub.sh <node-binary> <node-version> <out-dir> [platform] [arch]}"
NODE_VERSION="${2:?node version, e.g. 22.22.0}"
OUT="${3:?out dir}"
PLATFORM="${4:-darwin}"
ARCH="${5:-arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
die() { echo "stage-hub: $*" >&2; exit 1; }

[ -f "$ROOT/packages/hub/dist/hub.mjs" ] || die "packages/hub/dist/hub.mjs is missing. Run: pnpm --filter @agent-room/hub build"
command -v npm >/dev/null || die "npm isn't installed (it comes with Node)."

rm -rf "$OUT"; mkdir -p "$OUT"
cp "$ROOT/packages/hub/dist/hub.mjs" "$OUT/hub.mjs"
[ -f "$ROOT/packages/hub/dist/hub.mjs.map" ] && cp "$ROOT/packages/hub/dist/hub.mjs.map" "$OUT/hub.mjs.map"
cp -R "$ROOT/packages/hub/web" "$OUT/web"
cp "$ROOT/VERSION" "$OUT/VERSION" # 4.7: the hub's /version and its crash reports read it from next to hub.mjs
node "$ROOT/scripts/stage-hub-package.mjs" "$OUT"

# Runtime dependencies only, for the target Node. prebuild-install (run by better-sqlite3's install script) reads these.
(
  cd "$OUT"
  npm_config_target="$NODE_VERSION" npm_config_runtime=node \
  npm_config_arch="$ARCH" npm_config_target_arch="$ARCH" \
  npm_config_platform="$PLATFORM" npm_config_target_platform="$PLATFORM" \
  npm_config_build_from_source=false \
  npm install --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error
)

# The SQLite sources are only needed to compile it; the .node binary is what runs.
BS="$OUT/node_modules/better-sqlite3"
[ -f "$BS/build/Release/better_sqlite3.node" ] || die "better-sqlite3 has no compiled addon for $PLATFORM $ARCH, Node $NODE_VERSION."
rm -rf "$BS/deps" "$BS/src" "$BS/build/Release/obj" "$BS/build/Release/.deps" "$BS/build/deps"

# Prove it loads under the Node that will run it, then that the whole hub boots on it.
(cd "$OUT" && "$NODE_BIN" -e "const D=require('better-sqlite3'); const v=new D(':memory:').prepare('select sqlite_version() v').get().v; console.log('better-sqlite3 OK, SQLite '+v)") \
  || die "better-sqlite3 does not load under $NODE_BIN."
"$ROOT/scripts/smoke-hub.sh" "$NODE_BIN" "$OUT"
echo "Staged hub: $OUT ($(du -sh "$OUT" | cut -f1))"
