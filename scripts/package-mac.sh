#!/usr/bin/env bash
# One command on your Mac: build Agent Room with its own Node and hub inside, and pack it into a drag-to-install DMG.
#
#   bash scripts/package-mac.sh
#
# Output: build/mac/AgentRoom-<VERSION>.dmg  (ad-hoc signed; Developer ID signing and notarization wait for item 4.7)
# Needs: macOS on Apple silicon, Xcode (opened once), pnpm, CocoaPods. Setup.command installs the last two.
# Knobs (environment): NODE_VERSION (default 22.22.0), NODE_SHA256 (pin the Node download's hash as well as checking nodejs.org's),
#                      BUILD_DIR (default build/mac).
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "package-mac.sh only runs on macOS: it needs Xcode, codesign and hdiutil, and this is $(uname -s)." >&2
  echo "Run it on your Mac:  bash scripts/package-mac.sh" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NODE_VERSION="${NODE_VERSION:-22.22.0}"
BUILD="${BUILD_DIR:-$ROOT/build/mac}"
VERSION="$(awk '{print $1; exit}' VERSION)"
PLIST_VERSION="${VERSION//-/.}"
MACOS="$ROOT/packages/app/macos"
ENT="$MACOS/AgentRoom-macOS/AgentRoom.entitlements"
NODE_ENT="$MACOS/AgentRoom-macOS/NodeRuntime.entitlements"
DMG="$BUILD/AgentRoom-$VERSION.dmg"

step() { printf '\n\033[1;34m%s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$1" >&2; exit 1; }

step "Checking this Mac"
[ "$(uname -m)" = "arm64" ] || die "This builds an Apple silicon app and tests it here, so it needs an Apple silicon Mac."
xcodebuild -version >/dev/null 2>&1 || die "Xcode isn't ready. Install it from the App Store, open it once, then run this again. (With two Xcodes, set DEVELOPER_DIR to the one you want.)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null || die "Node isn't installed. Double-click Setup.command once, or: brew install node"
command -v pnpm >/dev/null || die "pnpm isn't installed. Double-click Setup.command once, or: npm install -g pnpm@9"
command -v pod  >/dev/null || die "CocoaPods isn't installed. Double-click Setup.command once, or: brew install cocoapods"
echo "Agent Room $VERSION, Node $NODE_VERSION (arm64)"
rm -rf "$BUILD/stage" "$BUILD/dmg"; mkdir -p "$BUILD/cache" "$BUILD/stage"

step "1/6 Building the hub"
pnpm install --frozen-lockfile
pnpm --filter @agent-room/hub build

step "2/6 Getting Node $NODE_VERSION (official build, checked against nodejs.org's SHA-256 list)"
NODE_TGZ="node-v$NODE_VERSION-darwin-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION"
curl -fsSL "$NODE_URL/SHASUMS256.txt" -o "$BUILD/cache/SHASUMS256-$NODE_VERSION.txt"
EXPECTED="$(awk -v f="$NODE_TGZ" '$2 == f { print $1 }' "$BUILD/cache/SHASUMS256-$NODE_VERSION.txt")"
[ -n "$EXPECTED" ] || die "nodejs.org's list has no $NODE_TGZ. Check NODE_VERSION."
[ -z "${NODE_SHA256:-}" ] || [ "$NODE_SHA256" = "$EXPECTED" ] || die "NODE_SHA256 doesn't match nodejs.org's list for $NODE_TGZ."
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }
if [ ! -f "$BUILD/cache/$NODE_TGZ" ] || [ "$(sha_of "$BUILD/cache/$NODE_TGZ")" != "$EXPECTED" ]; then
  curl -fSL --progress-bar "$NODE_URL/$NODE_TGZ" -o "$BUILD/cache/$NODE_TGZ"
fi
[ "$(sha_of "$BUILD/cache/$NODE_TGZ")" = "$EXPECTED" ] || die "The Node download's SHA-256 doesn't match nodejs.org's list. Not using it."
echo "SHA-256 OK: $EXPECTED"
mkdir -p "$BUILD/stage/node-extract"
tar -xzf "$BUILD/cache/$NODE_TGZ" -C "$BUILD/stage/node-extract" --strip-components=2 "node-v$NODE_VERSION-darwin-arm64/bin/node"
NODE="$BUILD/stage/node-extract/node"
chmod +x "$NODE"
[ "$("$NODE" -v)" = "v$NODE_VERSION" ] || die "The bundled Node reports $("$NODE" -v), not v$NODE_VERSION."

step "3/6 Staging the hub runtime (hub.mjs, web app, better-sqlite3 built for this Node)"
"$ROOT/scripts/stage-hub.sh" "$NODE" "$NODE_VERSION" "$BUILD/stage/Hub" darwin arm64

step "4/6 Building the Mac app (Release, arm64). This is the slow part; the log is $BUILD/xcodebuild.log"
if ! cmp -s "$MACOS/Podfile.lock" "$MACOS/Pods/Manifest.lock" 2>/dev/null; then
  (cd "$MACOS" && pod install)
fi
if ! xcodebuild -workspace "$MACOS/AgentRoom.xcworkspace" -scheme AgentRoom-macOS -configuration Release \
     -destination 'generic/platform=macOS' ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
     -derivedDataPath "$BUILD/derived" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
     build >"$BUILD/xcodebuild.log" 2>&1; then
  tail -40 "$BUILD/xcodebuild.log" >&2
  die "xcodebuild failed. The last lines are above; the whole log is $BUILD/xcodebuild.log. Copy them to Claude."
fi
APP="$BUILD/derived/Build/Products/Release/AgentRoom.app"
[ -d "$APP" ] || die "xcodebuild finished but $APP isn't there."

step "5/6 Putting the runtime inside the app and signing it (ad-hoc)"
RES="$APP/Contents/Resources"
rm -rf "$RES/Hub" "$RES/node"
ditto "$BUILD/stage/Hub" "$RES/Hub"
install -m 755 "$NODE" "$RES/node"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PLIST_VERSION" -c "Set :CFBundleVersion $PLIST_VERSION" "$APP/Contents/Info.plist"
# Inside out: the runtime's own binaries first, then the app around them.
codesign --force -s - --entitlements "$NODE_ENT" "$RES/node"
while IFS= read -r addon; do codesign --force -s - "$addon"; done < <(find "$RES/Hub/node_modules" -name '*.node' -type f)
codesign --force --deep -s - --entitlements "$ENT" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

step "6/6 Making the DMG"
mkdir -p "$BUILD/dmg"
ditto "$APP" "$BUILD/dmg/AgentRoom.app"
ln -s /Applications "$BUILD/dmg/Applications"
rm -f "$DMG"
hdiutil create -volname "Agent Room" -srcfolder "$BUILD/dmg" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
hdiutil verify "$DMG" >/dev/null

"$ROOT/scripts/verify-dmg.sh" "$DMG"

SIZE="$(du -h "$DMG" | awk '{print $1}')"
SUM="$(sha_of "$DMG")"
echo "$SUM  $(basename "$DMG")" > "$DMG.sha256"
printf '\n\033[1;32mDone.\033[0m\n  DMG:     %s\n  Size:    %s\n  SHA-256: %s\n' "$DMG" "$SIZE" "$SUM"
echo "Next: docs/install-test.md (the clean-account timed test)."
