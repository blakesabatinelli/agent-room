#!/usr/bin/env bash
# Starts a staged hub with the given Node, on a spare port with a throwaway data folder and practice agents,
# and checks that it answers /health and serves the phone web app. Used by stage-hub.sh and verify-dmg.sh.
#   scripts/smoke-hub.sh <node-binary> <Hub folder>
set -euo pipefail
NODE_BIN="${1:?Usage: smoke-hub.sh <node-binary> <Hub folder>}"
HUB="${2:?Usage: smoke-hub.sh <node-binary> <Hub folder>}"
[ -f "$HUB/hub.mjs" ] || { echo "No hub.mjs in $HUB" >&2; exit 1; }

TMP="$(mktemp -d)"
PORT=$((20000 + RANDOM % 20000))
PID=""
# shellcheck disable=SC2329  # run by the EXIT trap
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

(cd "$HUB" && AGENT_ROOM_PORT="$PORT" AGENT_ROOM_DATA="$TMP/data" AGENT_ROOM_HOME="$TMP/home" AGENT_ROOM_DEMO=1 \
  exec "$NODE_BIN" --enable-source-maps hub.mjs >"$TMP/hub.log" 2>&1) &
PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:$PORT/" | grep -qi "<html" || { echo "The hub runs but doesn't serve the web app (is web/ next to hub.mjs?)" >&2; exit 1; }
    echo "Hub smoke test passed: $("$NODE_BIN" -v), port $PORT"
    exit 0
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
echo "The staged hub did not start. Its log:" >&2
cat "$TMP/hub.log" >&2
exit 1
