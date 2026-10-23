#!/usr/bin/env bash
# Mounts a built DMG and checks what the install test depends on: the app's structure, the bundled Node, the hub,
# better-sqlite3, the ad-hoc signature, and that the hub boots on the bundled Node. Unmounts on the way out.
#   bash scripts/verify-dmg.sh [path/to/AgentRoom-<VERSION>.dmg]     (default: the newest in build/mac)
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "verify-dmg.sh only runs on macOS (it mounts the DMG with hdiutil and checks the signature with codesign)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC2012  # the names are ours (AgentRoom-<VERSION>.dmg); ls -t picks the newest
DMG="${1:-$(ls -t "$ROOT"/build/mac/AgentRoom-*.dmg 2>/dev/null | head -1 || true)}"
[ -f "$DMG" ] || { echo "No DMG found. Build one with: bash scripts/package-mac.sh" >&2; exit 1; }

MNT="$(mktemp -d /tmp/agentroom-dmg.XXXXXX)"
FAILS=0
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; }
trap cleanup EXIT

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else fail "$what"; fi; }

echo "Verifying $DMG"
hdiutil attach "$DMG" -nobrowse -readonly -noverify -mountpoint "$MNT" >/dev/null
APP="$MNT/AgentRoom.app"
RES="$APP/Contents/Resources"
HUB="$RES/Hub"
NODE="$RES/node"

check "AgentRoom.app is in the DMG"                          test -d "$APP"
check "an Applications shortcut is next to it"               test "$(readlink "$MNT/Applications")" = "/Applications"
check "the app's executable is there"                        test -x "$APP/Contents/MacOS/AgentRoom"
if [ -f "$RES/main.jsbundle" ]; then ok "the React Native bundle is inside the app"; else printf '  \033[33mwarn\033[0m  no Resources/main.jsbundle (the app would need Metro; check the Release build log)\n'; fi
check "bundled node is executable"                           test -x "$NODE"
check "bundled node is arm64"                                test "$(lipo -archs "$NODE" 2>/dev/null)" = "arm64"
check "bundled node runs (v22)"                              bash -c "\"$NODE\" -v | grep -q '^v22\\.'"
check "Hub/hub.mjs is there"                                 test -f "$HUB/hub.mjs"
check "Hub/web/index.html is there"                          test -f "$HUB/web/index.html"
check "Hub/package.json lists better-sqlite3"                grep -q '"better-sqlite3"' "$HUB/package.json"
check "better-sqlite3 loads under the bundled node"          bash -c "cd \"$HUB\" && \"$NODE\" -e \"new (require('better-sqlite3'))(':memory:').prepare('select 1').get()\""
check "codesign --verify --deep --strict passes"             codesign --verify --deep --strict "$APP"
check "the signature is ad-hoc (local), as intended for now" bash -c "codesign -dv \"$APP\" 2>&1 | grep -q 'Signature=adhoc'"
check "the hub boots on the bundled node and serves the web app" "$ROOT/scripts/smoke-hub.sh" "$NODE" "$HUB"

if [ "$FAILS" -gt 0 ]; then
  printf '\n\033[1;31m%s check(s) failed.\033[0m\n' "$FAILS" >&2
  exit 1
fi
printf '\n\033[1;32mAll checks passed.\033[0m\n'
