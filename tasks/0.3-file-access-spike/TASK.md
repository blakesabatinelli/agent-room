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
- [x] AC1: A decision memo comparing relayed MCP file tools, worktree sync, and vendor remote features on security, latency, vendor coverage and offline behaviour
- [x] AC2: A working prototype of the leading option: a cloud agent reads a file in a granted folder and proposes a write, and the hub applies it as a diff after approval
- [x] AC3: Reviewer sign-off on the memo

## How to verify
pnpm test (files.test.ts, relay.test.ts); reviewer report appended to the memo

## Status
Done 2026-10-23 (commits a1234db, ed7cc73, 0239f14).
- [x] AC1: `docs/spikes/0.3-file-access.md`.
- [x] AC2: test `I1: an agent that reaches the hub only through the relay reads a granted file and gets a write applied after the owner approves`.
- [x] AC3: independent review (read-only reviewer agent): acceptable as a spike; findings H1, M1, M3, L1, L3, I1-I3 fixed. Cross-vendor (Codex) review still owed before 1.1 merges.
