#!/usr/bin/env bash
# Keeps the hub running in the background on your Mac (starts at login, restarts on crash).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.agentroom.hub.plist"
NODE_BIN="$(dirname "$(command -v node)")"
mkdir -p "$HOME/.agent-room"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agentroom.hub</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN/npx</string><string>tsx</string><string>$ROOT/packages/hub/src/main.ts</string></array>
  <key>WorkingDirectory</key><string>$ROOT/packages/hub</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$NODE_BIN:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.agent-room/hub.log</string>
  <key>StandardErrorPath</key><string>$HOME/.agent-room/hub.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Hub running. Pairing code is in ~/.agent-room/hub.log"
