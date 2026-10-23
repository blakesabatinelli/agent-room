#!/usr/bin/env bash
# Mounts a built DMG and checks what the install test depends on: the app's structure, the bundled Node, the hub,
# better-sqlite3, the signature, and that the hub boots on the bundled Node. Unmounts on the way out.
#   bash scripts/verify-dmg.sh [--release] [path/to/AgentRoom-<VERSION>.dmg]     (default: the newest in build/mac)
# --release (4.7) expects what package-mac.sh --release makes instead of the ad-hoc signature: a Developer ID signature with the hardened
# runtime and a timestamp, one team on the app, node and the addon, stapled and Gatekeeper-approved app and DMG, com.agentroom.app as the
# bundle id, Sparkle inside, and no placeholder feed address or key. The hub must still boot on the bundled node under the hardened runtime.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "verify-dmg.sh only runs on macOS (it mounts the DMG with hdiutil and checks the signature with codesign)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE=0
if [ "${1:-}" = "--release" ]; then RELEASE=1; shift; fi
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
if [ "$RELEASE" = 1 ]; then
  INFO="$APP/Contents/Info.plist"
  plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$INFO" 2>/dev/null; }
  team() { codesign -dvv "$1" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2}'; }
  has_team() { local t; t="$(team "$APP")"; [ -n "$t" ] && [ "$t" != "not set" ]; }
  feed_ok() { local u; u="$(plist SUFeedURL)"; case "$u" in https://*) ;; *) return 1 ;; esac; case "$u" in *.invalid/*|*REPLACE*) return 1 ;; esac; }
  key_ok() { local k; k="$(plist SUPublicEDKey)"; [ -n "$k" ] && [ "${k#*REPLACE}" = "$k" ]; }
  ADDON="$(find "$HUB/node_modules/better-sqlite3" -name '*.node' -type f | head -1)"
  check "signed by a Developer ID Application identity"       bash -c "codesign -dvv \"$APP\" 2>&1 | grep -q 'Authority=Developer ID Application'"
  check "the hardened runtime is on for the app"              bash -c "codesign -dvv \"$APP\" 2>&1 | grep -q 'flags=0x[0-9a-f]*(runtime)'"
  check "the signature has a secure timestamp"                bash -c "codesign -dvv \"$APP\" 2>&1 | grep -q '^Timestamp='"
  check "the app has a team identifier"                       has_team
  check "node has the same team as the app"                   test "$(team "$NODE")" = "$(team "$APP")"
  check "the sqlite addon has the same team as the app"       test "$(team "$ADDON")" = "$(team "$APP")"
  check "node has the hardened runtime and its entitlements"  bash -c "codesign -dvv \"$NODE\" 2>&1 | grep -q 'flags=0x[0-9a-f]*(runtime)' && codesign -d --entitlements - \"$NODE\" 2>&1 | grep -q 'allow-jit'"
  check "the bundle id is com.agentroom.app"                  test "$(plist CFBundleIdentifier)" = "com.agentroom.app"
  check "Sparkle.framework is inside the app"                 test -d "$APP/Contents/Frameworks/Sparkle.framework"
  check "SUFeedURL is a real https address"                   feed_ok
  check "SUPublicEDKey is set and not the placeholder"        key_ok
  check "the app has a stapled notarization ticket"           xcrun stapler validate "$APP"
  check "Gatekeeper accepts the app (spctl --assess)"         spctl --assess --type execute "$APP"
  check "the DMG has a stapled notarization ticket"           xcrun stapler validate "$DMG"
  check "Gatekeeper accepts the DMG (spctl --assess)"         spctl --assess --type open --context context:primary-signature "$DMG"
else
  check "the signature is ad-hoc (local), as intended for now" bash -c "codesign -dv \"$APP\" 2>&1 | grep -q 'Signature=adhoc'"
fi
check "the hub boots on the bundled node and serves the web app" "$ROOT/scripts/smoke-hub.sh" "$NODE" "$HUB"

if [ "$FAILS" -gt 0 ]; then
  printf '\n\033[1;31m%s check(s) failed.\033[0m\n' "$FAILS" >&2
  exit 1
fi
printf '\n\033[1;32mAll checks passed.\033[0m\n'
