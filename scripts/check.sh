#!/bin/sh
# Same gate CI runs. Use before merging a branch locally: ./scripts/check.sh
set -e
cd "$(dirname "$0")/.."
pnpm typecheck
pnpm test
