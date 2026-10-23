#!/bin/sh
# Starts the hub. Runs the prebuilt bundle (about 5x faster to start than compiling TypeScript on launch),
# rebuilding it first only if any source file is newer. Falls back to tsx if the build can't run.
cd "$(dirname "$0")"
BUNDLE=dist/hub.mjs
ESBUILD=node_modules/.bin/esbuild
[ -x "$ESBUILD" ] || ESBUILD=../../node_modules/.bin/esbuild
if [ ! -f "$BUNDLE" ] || [ -n "$(find src ../shared/src package.json -newer "$BUNDLE" -print -quit 2>/dev/null)" ]; then
  "$ESBUILD" src/main.ts --bundle --platform=node --format=esm --target=node20 --outfile="$BUNDLE" \
    --external:better-sqlite3 --sourcemap --log-level=warning \
    '--banner:js=import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' \
    || exec npx tsx src/main.ts
fi
exec node --enable-source-maps "$BUNDLE"
