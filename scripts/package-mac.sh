#!/usr/bin/env bash
# One command on your Mac: build Agent Room with its own Node and hub inside, and pack it into a drag-to-install DMG.
#
#   bash scripts/package-mac.sh                      a local build: ad-hoc signed, for your own Mac
#   bash scripts/package-mac.sh --release            the 1.0 build: Developer ID signed, hardened runtime, notarized, stapled (item 4.7)
#   bash scripts/package-mac.sh --release --preflight   only check that a release build would start (environment, version, Mac tools)
#
# Output: build/mac/AgentRoom-<VERSION>.dmg (and a .sha256 next to it)
# Needs: macOS on Apple silicon, Xcode (opened once), pnpm, CocoaPods. Setup.command installs the last two.
# Knobs (environment): NODE_VERSION (default 22.22.0), NODE_SHA256 (pin the Node download's hash as well as checking nodejs.org's),
#                      BUILD_DIR (default build/mac).
#
# --release needs these four, and stops with a plain message when any is missing (docs/release.md says how to get each):
#   AGENT_ROOM_SIGN_ID                  a "Developer ID Application" identity in your keychain: its full name or its SHA-1
#   AGENT_ROOM_NOTARY_PROFILE           a notarytool keychain profile (xcrun notarytool store-credentials)
#   AGENT_ROOM_FEED_URL                 where appcast.xml will be published (https), written into the app as SUFeedURL
#   AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY    Sparkle's public EdDSA key (from generate_keys), written into the app as SUPublicEDKey
# Optional: AGENT_ROOM_REPORT_URL           the https address opt-in crash reports and usage counts go to (built into the app; unset: none can be sent)
# Optional: AGENT_ROOM_APP_ALLOW_JIT=1 adds the allow-jit entitlement to the app itself, only if the notarized app turns out to need it
#           for its JavaScript engine (see docs/release.md, "Entitlements").
#
# Release mode signs inside out with the hardened runtime and a secure timestamp: first everything the Node runtime loads and the
# Frameworks, then node with NodeRuntime.entitlements, then the app with AgentRoom.entitlements. The app is notarized and stapled,
# then put in the DMG, and the DMG is signed, notarized and stapled too. Nothing is signed with --deep.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[1;34m%s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$1" >&2; exit 1; }
usage() {
  echo "Usage: bash scripts/package-mac.sh [--release [--preflight]]" >&2
  echo "  (no option)  a local build, ad-hoc signed" >&2
  echo "  --release    Developer ID signed, notarized, stapled; needs AGENT_ROOM_SIGN_ID, AGENT_ROOM_NOTARY_PROFILE," >&2
  echo "               AGENT_ROOM_FEED_URL and AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY (see docs/release.md)" >&2
}

RELEASE=0
PREFLIGHT=0
for arg in "$@"; do
  case "$arg" in
    --release) RELEASE=1 ;;
    --preflight) PREFLIGHT=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Unknown option: $arg" ;;
  esac
done
[ "$PREFLIGHT" = 0 ] || [ "$RELEASE" = 1 ] || die "--preflight only goes with --release."

VERSION="$(awk '{print $1; exit}' VERSION)"
PLIST_VERSION="${VERSION//-/.}"

# ---- release: the checks that need nothing from macOS, so a missing setting is reported on any machine
if [ "$RELEASE" = 1 ]; then
  missing=""
  for v in AGENT_ROOM_SIGN_ID AGENT_ROOM_NOTARY_PROFILE AGENT_ROOM_FEED_URL AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY; do
    [ -n "${!v:-}" ] || missing="$missing $v"
  done
  if [ -n "$missing" ]; then
    {
      printf '\n\033[1;31m--release needs these set, and they are not:\033[0m%s\n\n' "$missing"
      echo "  AGENT_ROOM_SIGN_ID                  your Developer ID Application identity (name or SHA-1; see: security find-identity -v -p codesigning)"
      echo "  AGENT_ROOM_NOTARY_PROFILE           the notarytool keychain profile (xcrun notarytool store-credentials <name> ...)"
      echo "  AGENT_ROOM_FEED_URL                 the https address appcast.xml will be published at"
      echo "  AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY    Sparkle's public EdDSA key (the output of Sparkle's generate_keys)"
      echo
      echo "docs/release.md has the steps to get each one. Nothing was built."
    } >&2
    exit 1
  fi
  [[ "$AGENT_ROOM_FEED_URL" =~ ^https://[^[:space:]]+$ ]] || die "AGENT_ROOM_FEED_URL must be an https address."
  case "$AGENT_ROOM_FEED_URL" in *.invalid/*|*REPLACE*|*example.invalid*) die "AGENT_ROOM_FEED_URL is still a placeholder." ;; esac
  [[ "$AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]] || die "AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY doesn't look like a Sparkle public key (44 characters of base64, ending in =)."
  [[ "$PLIST_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "A release build needs VERSION to start with x.y.z (for example 1.0.0). It starts with: $VERSION"
fi

if [ "$(uname -s)" != "Darwin" ]; then
  if [ "$PREFLIGHT" = 1 ]; then
    echo "Release settings look right. The checks that need a Mac (the signing identity, the notary profile, Xcode) were skipped: this is $(uname -s)."
    exit 0
  fi
  echo "package-mac.sh only runs on macOS: it needs Xcode, codesign and hdiutil, and this is $(uname -s)." >&2
  echo "Run it on your Mac:  bash scripts/package-mac.sh" >&2
  exit 1
fi

NODE_VERSION="${NODE_VERSION:-22.22.0}"
BUILD="${BUILD_DIR:-$ROOT/build/mac}"
MACOS="$ROOT/packages/app/macos"
ENT="$MACOS/AgentRoom-macOS/AgentRoom.entitlements"
NODE_ENT="$MACOS/AgentRoom-macOS/NodeRuntime.entitlements"
DMG="$BUILD/AgentRoom-$VERSION.dmg"
BUNDLE_ID="com.agentroom.app"
if [ "$RELEASE" = 1 ]; then TOTAL=8; else TOTAL=6; fi

step "Checking this Mac"
[ "$(uname -m)" = "arm64" ] || die "This builds an Apple silicon app and tests it here, so it needs an Apple silicon Mac."
xcodebuild -version >/dev/null 2>&1 || die "Xcode isn't ready. Install it from the App Store, open it once, then run this again. (With two Xcodes, set DEVELOPER_DIR to the one you want.)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null || die "Node isn't installed. Double-click Setup.command once, or: brew install node"
command -v pnpm >/dev/null || die "pnpm isn't installed. Double-click Setup.command once, or: npm install -g pnpm@9"
command -v pod  >/dev/null || die "CocoaPods isn't installed. Double-click Setup.command once, or: brew install cocoapods"
if [ "$RELEASE" = 1 ]; then
  security find-identity -v -p codesigning | grep -qF "$AGENT_ROOM_SIGN_ID" \
    || die "No code-signing identity matching \"$AGENT_ROOM_SIGN_ID\" is in your keychains. See: security find-identity -v -p codesigning"
  security find-identity -v -p codesigning | grep -F "$AGENT_ROOM_SIGN_ID" | grep -q "Developer ID Application" \
    || die "\"$AGENT_ROOM_SIGN_ID\" is not a Developer ID Application identity. Distribution outside the App Store needs that kind (an Apple Development one will not notarize)."
  xcrun --find notarytool >/dev/null 2>&1 || die "xcrun can't find notarytool. It comes with Xcode 13 or newer."
  xcrun --find stapler >/dev/null 2>&1 || die "xcrun can't find stapler."
  xcrun notarytool history --keychain-profile "$AGENT_ROOM_NOTARY_PROFILE" >/dev/null 2>&1 \
    || die "The notarytool profile \"$AGENT_ROOM_NOTARY_PROFILE\" doesn't work. Make it with: xcrun notarytool store-credentials \"$AGENT_ROOM_NOTARY_PROFILE\" --apple-id ... --team-id ..."
  echo "Release build: signing as \"$AGENT_ROOM_SIGN_ID\", notarizing with profile \"$AGENT_ROOM_NOTARY_PROFILE\"."
  if [ "$PREFLIGHT" = 1 ]; then
    printf '\n\033[1;32mPreflight passed.\033[0m A release build would start. Run it without --preflight.\n'
    exit 0
  fi
fi
echo "Agent Room $VERSION, Node $NODE_VERSION (arm64)"
rm -rf "$BUILD/stage" "$BUILD/dmg"; mkdir -p "$BUILD/cache" "$BUILD/stage"

step "1/$TOTAL Building the hub"
pnpm install --frozen-lockfile
pnpm --filter @agent-room/hub build

step "2/$TOTAL Getting Node $NODE_VERSION (official build, checked against nodejs.org's SHA-256 list)"
NODE_TGZ="node-v$NODE_VERSION-darwin-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION"
# HTTP/1.1 and retries: nodejs.org's CDN sometimes drops HTTP/2 streams ("Error in the HTTP2 framing layer"). A version's list never changes, so
# when nodejs.org can't be reached, the copy saved by an earlier build is used.
fetch() { curl -fSL --http1.1 --retry 4 --retry-delay 2 --retry-all-errors "$@"; }
SUMS="$BUILD/cache/SHASUMS256-$NODE_VERSION.txt"
if fetch -s "$NODE_URL/SHASUMS256.txt" -o "$SUMS.part"; then mv "$SUMS.part" "$SUMS"
elif [ -s "$SUMS" ]; then rm -f "$SUMS.part"; echo "Couldn't reach nodejs.org; using the checksum list saved by an earlier build."
else die "Couldn't download Node's checksum list from nodejs.org. Check the connection and run this again."; fi
EXPECTED="$(awk -v f="$NODE_TGZ" '$2 == f { print $1 }' "$SUMS")"
[ -n "$EXPECTED" ] || die "nodejs.org's list has no $NODE_TGZ. Check NODE_VERSION."
[ -z "${NODE_SHA256:-}" ] || [ "$NODE_SHA256" = "$EXPECTED" ] || die "NODE_SHA256 doesn't match nodejs.org's list for $NODE_TGZ."
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }
if [ ! -f "$BUILD/cache/$NODE_TGZ" ] || [ "$(sha_of "$BUILD/cache/$NODE_TGZ")" != "$EXPECTED" ]; then
  fetch --progress-bar "$NODE_URL/$NODE_TGZ" -o "$BUILD/cache/$NODE_TGZ.part" || die "Couldn't download Node from nodejs.org. Check the connection and run this again."
  mv "$BUILD/cache/$NODE_TGZ.part" "$BUILD/cache/$NODE_TGZ"
fi
[ "$(sha_of "$BUILD/cache/$NODE_TGZ")" = "$EXPECTED" ] || die "The Node download's SHA-256 doesn't match nodejs.org's list. Not using it."
echo "SHA-256 OK: $EXPECTED"
mkdir -p "$BUILD/stage/node-extract"
tar -xzf "$BUILD/cache/$NODE_TGZ" -C "$BUILD/stage/node-extract" --strip-components=2 "node-v$NODE_VERSION-darwin-arm64/bin/node"
NODE="$BUILD/stage/node-extract/node"
chmod +x "$NODE"
[ "$("$NODE" -v)" = "v$NODE_VERSION" ] || die "The bundled Node reports $("$NODE" -v), not v$NODE_VERSION."

step "3/$TOTAL Staging the hub runtime (hub.mjs, web app, better-sqlite3 built for this Node)"
"$ROOT/scripts/stage-hub.sh" "$NODE" "$NODE_VERSION" "$BUILD/stage/Hub" darwin arm64

step "4/$TOTAL Building the Mac app (Release, arm64). This is the slow part; the log is $BUILD/xcodebuild.log"
XCB_EXTRA=()
if [ "$RELEASE" = 1 ]; then
  # Sparkle is a pod only in release builds (see the Podfile), and AR_SPARKLE=1 turns on the code that uses it.
  (cd "$MACOS" && AGENT_ROOM_SPARKLE=1 pod install)
  XCB_EXTRA=('GCC_PREPROCESSOR_DEFINITIONS=$(inherited) AR_SPARKLE=1')
else
  # Native modules come from the app's package.json (autolinked by the Podfile), so pod install is needed when that list changes, not only
  # when Podfile.lock does: a dependency added since the last pod install (react-native-webview, for the office) is otherwise left out of
  # the app and the screen that uses it crashes.
  POD_STAMP="$MACOS/Pods/.agent-room-fingerprint"
  POD_FINGER="$(cat "$MACOS/Podfile" "$ROOT/packages/app/package.json" "$ROOT/pnpm-lock.yaml" "$ROOT/node_modules/react-native-macos/package.json" 2>/dev/null | shasum | cut -d' ' -f1)"
  if ! cmp -s "$MACOS/Podfile.lock" "$MACOS/Pods/Manifest.lock" 2>/dev/null || [ "$(cat "$POD_STAMP" 2>/dev/null)" != "$POD_FINGER" ]; then
    (cd "$MACOS" && pod install) || die "pod install failed for the Mac app. Copy the error above to Claude."
    echo "$POD_FINGER" > "$POD_STAMP"
  fi
fi
if ! xcodebuild -workspace "$MACOS/AgentRoom.xcworkspace" -scheme AgentRoom-macOS -configuration Release \
     -destination 'generic/platform=macOS' ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
     -derivedDataPath "$BUILD/derived" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
     ${XCB_EXTRA[@]+"${XCB_EXTRA[@]}"} \
     build >"$BUILD/xcodebuild.log" 2>&1; then
  tail -40 "$BUILD/xcodebuild.log" >&2
  die "xcodebuild failed. The last lines are above; the whole log is $BUILD/xcodebuild.log. Copy them to Claude."
fi
APP="$BUILD/derived/Build/Products/Release/AgentRoom.app"
[ -d "$APP" ] || die "xcodebuild finished but $APP isn't there."

# ---- release helpers
deepest_first() { awk '{ n = gsub("/", "/"); print n "\t" $0 }' | sort -rn | cut -f2-; }
is_macho() { file -b "$1" | grep -q 'Mach-O'; }
sign_release() { # sign_release <entitlements file or ""> <path> [extra codesign options]
  local ent="$1" target="$2"; shift 2
  if [ -n "$ent" ]; then
    codesign --force --timestamp --options runtime --entitlements "$ent" -s "$AGENT_ROOM_SIGN_ID" "$@" "$target"
  else
    codesign --force --timestamp --options runtime -s "$AGENT_ROOM_SIGN_ID" "$@" "$target"
  fi
}
notarize() { # notarize <file> <label>: uploads, waits, and stops with Apple's own reasons when it isn't accepted
  local f="$1" label="$2" log="$BUILD/notary-$2.log" id status
  xcrun notarytool submit "$f" --keychain-profile "$AGENT_ROOM_NOTARY_PROFILE" --wait >"$log" 2>&1 || true
  cat "$log"
  id="$(awk '/^ *id: /{print $2; exit}' "$log")"
  status="$(awk '/^ *status: /{s=$2} END{print s}' "$log")"
  if [ "$status" != "Accepted" ]; then
    if [ -n "$id" ]; then xcrun notarytool log "$id" --keychain-profile "$AGENT_ROOM_NOTARY_PROFILE" >&2 || true; fi
    die "Apple's notary service did not accept the $label (status: ${status:-none}). The reasons are above; the log is $log."
  fi
}

RES="$APP/Contents/Resources"
if [ "$RELEASE" = 1 ]; then
  step "5/$TOTAL Putting the runtime inside the app and signing it (Developer ID, hardened runtime, timestamp)"
else
  step "5/$TOTAL Putting the runtime inside the app and signing it (ad-hoc)"
fi
rm -rf "$RES/Hub" "$RES/node"
ditto "$BUILD/stage/Hub" "$RES/Hub"
install -m 755 "$NODE" "$RES/node"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PLIST_VERSION" -c "Set :CFBundleVersion $PLIST_VERSION" "$APP/Contents/Info.plist"

if [ "$RELEASE" = 1 ]; then
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = "$BUNDLE_ID" ] || die "The built app's bundle id isn't $BUNDLE_ID. Check PRODUCT_BUNDLE_IDENTIFIER in the Xcode project."
  [ -d "$APP/Contents/Frameworks/Sparkle.framework" ] || die "Sparkle.framework isn't inside the app, so it would ship with no updater. Was AGENT_ROOM_SPARKLE=1 pod install run, and AR_SPARKLE=1 defined for the build?"
  /usr/libexec/PlistBuddy -c "Set :SUFeedURL $AGENT_ROOM_FEED_URL" -c "Set :SUPublicEDKey $AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY" "$APP/Contents/Info.plist"
  # Optional: the address opt-in crash reports and usage counts go to. Left empty, the app can send nothing, whatever its switches say.
  if [ -n "${AGENT_ROOM_REPORT_URL:-}" ]; then
    [[ "$AGENT_ROOM_REPORT_URL" =~ ^https://[^[:space:]]+$ ]] || die "AGENT_ROOM_REPORT_URL must be an https address."
    /usr/libexec/PlistBuddy -c "Set :AgentRoomReportURL $AGENT_ROOM_REPORT_URL" "$APP/Contents/Info.plist"
    echo "Report address built into the app: $AGENT_ROOM_REPORT_URL (still off until a user turns a switch on)."
  else
    echo "No AGENT_ROOM_REPORT_URL: this build can send no crash reports or usage counts."
  fi

  APP_ENT="$ENT"
  if [ "${AGENT_ROOM_APP_ALLOW_JIT:-0}" = "1" ]; then
    APP_ENT="$BUILD/AgentRoom.release.entitlements"
    cp "$ENT" "$APP_ENT"
    /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.allow-jit bool true" "$APP_ENT"
    echo "Adding allow-jit to the app itself (AGENT_ROOM_APP_ALLOW_JIT=1)."
  fi

  # Inside out. 1: native code the Node runtime loads (better-sqlite3's addon and anything else compiled in Hub/).
  while IFS= read -r f; do
    is_macho "$f" && [ "$f" != "$RES/node" ] && sign_release "" "$f"
  done < <(find "$RES/Hub" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -perm -u+x \) | deepest_first)
  # 2: node itself, with the entitlements V8 needs (docs/release.md, "Entitlements", says why each one is there). The official build was signed and
  # notarized by the Node.js project with its own entitlements; this prints them (from the copy in the app, before it is re-signed) so
  # they can be compared with ours.
  echo "Entitlements of the official Node build, for comparison with NodeRuntime.entitlements:"
  codesign -d --entitlements - "$RES/node" 2>&1 | sed 's/^/  /' || true
  sign_release "$NODE_ENT" "$RES/node"
  # 3: Frameworks (Sparkle): loose executables, then XPC services and helper apps, deepest first, then each framework.
  if [ -d "$APP/Contents/Frameworks" ]; then
    while IFS= read -r f; do
      is_macho "$f" && sign_release "" "$f"
    done < <(find "$APP/Contents/Frameworks" -type f \( -perm -u+x -o -name '*.dylib' \) | deepest_first)
    while IFS= read -r b; do
      case "$b" in *.xpc) sign_release "" "$b" --preserve-metadata=entitlements ;; *) sign_release "" "$b" ;; esac
    done < <(find "$APP/Contents/Frameworks" -type d \( -name '*.xpc' -o -name '*.app' \) | deepest_first)
    while IFS= read -r b; do sign_release "" "$b"; done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -type d -name '*.framework')
  fi
  # 4: the app, last.
  sign_release "$APP_ENT" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  codesign -dvv "$APP" 2>&1 | grep -q 'flags=0x[0-9a-f]*(runtime)' || die "The app is signed without the hardened runtime. Notarization would refuse it."

  step "6/$TOTAL Notarizing the app (Apple's notary service; usually a few minutes), then stapling the ticket"
  rm -f "$BUILD/AgentRoom-notarize.zip"
  ditto -c -k --keepParent "$APP" "$BUILD/AgentRoom-notarize.zip"
  notarize "$BUILD/AgentRoom-notarize.zip" "app"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=4 "$APP" || die "Gatekeeper (spctl --assess) rejects the notarized app."
else
  # Inside out: the runtime's own binaries first, then the app around them.
  codesign --force -s - --entitlements "$NODE_ENT" "$RES/node"
  while IFS= read -r addon; do codesign --force -s - "$addon"; done < <(find "$RES/Hub/node_modules" -name '*.node' -type f)
  codesign --force --deep -s - --entitlements "$ENT" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
fi

if [ "$RELEASE" = 1 ]; then step "7/$TOTAL Making the DMG, then signing, notarizing and stapling it"; else step "6/$TOTAL Making the DMG"; fi
mkdir -p "$BUILD/dmg"
ditto "$APP" "$BUILD/dmg/AgentRoom.app"
ln -s /Applications "$BUILD/dmg/Applications"
rm -f "$DMG"
# A DMG from an earlier build that is still open in Finder makes hdiutil fail with "Resource busy": eject it first.
for dev in $(hdiutil info | awk -v img="$DMG" '/^=+$/ {p=0} /^image-path/ {sub(/^image-path[ \t]*:[ \t]*/, ""); p=($0==img)} p && /^\/dev\/disk[0-9]+[ \t]/ {print $1}'); do
  echo "Ejecting the earlier $(basename "$DMG"), still open as $dev"
  hdiutil detach "$dev" -quiet 2>/dev/null || hdiutil detach "$dev" -force -quiet
done
hdiutil create -volname "Agent Room" -srcfolder "$BUILD/dmg" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
hdiutil verify "$DMG" >/dev/null

if [ "$RELEASE" = 1 ]; then
  codesign --force --timestamp -s "$AGENT_ROOM_SIGN_ID" "$DMG"
  notarize "$DMG" "dmg"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG" || die "Gatekeeper (spctl --assess) rejects the DMG."
  step "8/$TOTAL Checking the finished DMG"
  "$ROOT/scripts/verify-dmg.sh" --release "$DMG"
else
  "$ROOT/scripts/verify-dmg.sh" "$DMG"
fi

SIZE="$(du -h "$DMG" | awk '{print $1}')"
SUM="$(sha_of "$DMG")"
echo "$SUM  $(basename "$DMG")" > "$DMG.sha256"
printf '\n\033[1;32mDone.\033[0m\n  DMG:     %s\n  Size:    %s\n  SHA-256: %s\n' "$DMG" "$SIZE" "$SUM"
if [ "$RELEASE" = 1 ]; then
  echo "Next: bash scripts/make-appcast.sh \"$DMG\" <download URL>   (signs it for Sparkle and writes appcast.xml), then docs/release.md, \"Publishing\"."
  echo "Podfile.lock now lists Sparkle. Run pod install (without AGENT_ROOM_SPARKLE) to go back to day-to-day builds."
else
  echo "Next: docs/install-test.md (the clean-account timed test)."
fi
