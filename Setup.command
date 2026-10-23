#!/bin/zsh -l
# Double-click this file in Finder (first time: right-click > Open).
# It installs anything missing and opens Agent Room in Xcode. Then press ⌘R.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/packages/app"
cd "$ROOT"
step() { print -P "\n%F{blue}%B$1%b%f"; }
fail() { print -P "\n%F{red}$1%f"; read -k1 "?Press any key to close."; exit 1; }

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

step "Stopping any older Agent Room that's still running"
launchctl unload "$HOME/Library/LaunchAgents/com.agentroom.hub.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.agentroom.hub.plist"
pkill -x AgentRoom 2>/dev/null || true
pkill -f "tsx src/main.ts" 2>/dev/null || true
pkill -f "dist/hub.mjs" 2>/dev/null || true
lsof -ti:4747,8081 2>/dev/null | xargs kill 2>/dev/null || true
rm -rf "${TMPDIR:-/tmp}"/metro-* 2>/dev/null || true
print "Agent Room $(cat "$ROOT/VERSION" 2>/dev/null)"

step "Checking Xcode"
# Use one Xcode for everything. With two installed, building in one while xcode-select points at the
# other mixes one's compiler with the other's SDK ("Could not build module 'DarwinFoundation'").
setopt null_glob; autoload -Uz is-at-least
XCODE=""; XCODE_VER=""
for x in /Applications/Xcode*.app "$HOME"/Applications/Xcode*.app "$HOME"/Desktop/Xcode*.app "$HOME"/Downloads/Xcode*.app; do
  [ -d "$x/Contents/Developer" ] || continue
  v="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$x/Contents/Info.plist" 2>/dev/null)"
  print "Found Xcode $v at $x"
  if [ -z "$XCODE" ] || { [ "$v" != "$XCODE_VER" ] && is-at-least "$XCODE_VER" "$v"; }; then
    XCODE="$x"; XCODE_VER="$v"
  fi
done
[ -n "$XCODE" ] || fail "Install Xcode from the App Store, open it once, then double-click Setup.command again."
print "Using Xcode $XCODE_VER at $XCODE"
if [ "$(xcode-select -p 2>/dev/null)" != "$XCODE/Contents/Developer" ]; then
  print "Pointing the command-line tools at that Xcode (your Mac password, once):"
  sudo xcode-select -s "$XCODE" || fail "Couldn't switch Xcode. Run: sudo xcode-select -s \"$XCODE\""
fi
sudo -n true 2>/dev/null && sudo xcodebuild -license accept >/dev/null 2>&1 || true

step "Checking Homebrew, Node and CocoaPods"
if ! command -v brew >/dev/null; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi
node -v >/dev/null 2>&1 || brew install node
print "Node: $(command -v node) $(node -v)"
command -v pod  >/dev/null || brew install cocoapods
command -v pnpm >/dev/null || npm install -g pnpm@9

step "Installing packages"
pnpm install --prefer-offline

step "Building the hub"
(cd "$ROOT/packages/hub" && pnpm build) || print "Couldn't prebuild the hub; it will compile itself on first launch instead."

# Native parts only need reinstalling, and Xcode only needs a clean build, when something native changed.
STAMP="$HOME/.agent-room/native-fingerprint"
mkdir -p "$HOME/.agent-room"
FINGER="$( { print "$XCODE $XCODE_VER"; cat "$APP/macos/Podfile" "$ROOT/node_modules/react-native-macos/package.json" \
  "$APP/macos/AgentRoom.xcodeproj/project.pbxproj" "$ROOT/pnpm-lock.yaml" 2>/dev/null; } | shasum | cut -d' ' -f1)"
NATIVE_CHANGED=1
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$FINGER" ] && [ -d "$APP/macos/Pods" ] \
   && cmp -s "$APP/macos/Podfile.lock" "$APP/macos/Pods/Manifest.lock"; then NATIVE_CHANGED=0; fi

if [ $NATIVE_CHANGED = 1 ]; then
  step "Installing the Mac app's native parts (a few minutes the first time)"
  rm -rf "$HOME"/Library/Developer/Xcode/DerivedData/AgentRoom-* \
         "$HOME"/Library/Developer/Xcode/DerivedData/ModuleCache.noindex 2>/dev/null || true
  (cd "$APP/macos" && pod install) || fail "pod install failed for the Mac app. Copy the error above to Claude."
  [ -d "$APP/macos/AgentRoom.xcworkspace" ] || fail "AgentRoom.xcworkspace wasn't created. Copy the output above to Claude."
  print "$FINGER" > "$STAMP"
else
  step "Mac app's native parts are unchanged; skipping reinstall"
fi

# The phone uses the web app; the native iPhone app is optional.
if [ "${AGENT_ROOM_IOS:-0}" = 1 ]; then
  step "Installing the iPhone app's native parts"
  (cd "$APP/ios" && pod install) || print "Skipped the iPhone app. The Mac app is ready."
fi

step "Opening Xcode"
osascript -e 'quit app "Xcode"' 2>/dev/null || true
open -a "$XCODE" "$APP/macos/AgentRoom.xcworkspace"
if [ $NATIVE_CHANGED = 1 ]; then
  NEXT="In Xcode: Product > Clean Build Folder (⇧⌘K), check the scheme says AgentRoom-macOS, then press ⌘R."
else
  NEXT="In Xcode: check the scheme says AgentRoom-macOS, then press ⌘R. No clean build needed this time."
fi
print -P "\n%F{green}%BReady.%b%f $NEXT
The app starts the hub itself and walks you through the rest."
read -k1 "?Press any key to close."
