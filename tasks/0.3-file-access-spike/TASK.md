# 0.3 Spike: local file access

**Size:** M  **Branch:** `item/0.3-file-access-spike`  **Locked:** 2026-10-23, owner instruction ("do all items"), criteria as written in PLAN.md

## Objective
Spike: local file access, per PLAN.md section 5 and PRODUCT.md.

## Files in scope
- `docs/spikes/0.3-file-access.md`
- `packages/hub/src/files/*`
- `packages/relay/*`
- `packages/hub/src/mcp/server.ts`
- `packages/hub/test/files.test.ts`
- `packages/hub/test/relay.test.ts`

## Acceptance criteria
- [ ] AC1: A decision memo comparing relayed MCP file tools, worktree sync, and vendor remote features on security, latency, vendor coverage and offline behaviour
- [ ] AC2: A working prototype of the leading option: a cloud agent reads a file in a granted folder and proposes a write, and the hub applies it as a diff after approval
- [ ] AC3: Reviewer sign-off on the memo

## How to verify
pnpm test (files.test.ts, relay.test.ts); reviewer report appended to the memo

## Status
Not started.
