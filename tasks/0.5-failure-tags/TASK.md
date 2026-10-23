# 0.5 Failure tags

**Size:** S  **Branch:** `item/0.5-failure-tags`  **Locked:** 2026-10-23, owner instruction ("do all items"), criteria as written in PLAN.md

## Objective
Failure tags, per PLAN.md section 5 and PRODUCT.md.

## Files in scope
- `packages/hub/src/orchestrator/failures.ts`
- `packages/hub/src/orchestrator/orchestrator.ts`
- `packages/hub/src/orchestrator/prompts.ts`
- `packages/hub/test/routing.test.ts`

## Acceptance criteria
- [x] AC1: Every failed or sent-back task is tagged as spec, misalignment, verification or other
- [x] AC2: The tags are visible in the audit log and the JSONL export

## How to verify
pnpm test

## Status
Done 2026-10-23 (commit 8a8c368).
- [x] AC1: `packages/hub/src/orchestrator/failures.ts`; tests `failure tags: mechanical evidence first...`, drift → misalignment, blocked → spec, overclaimed PASS → verification, honest shortfall → judge's category.
- [x] AC2: audit action `task.failure` with `[tag]` prefix; `failureTag` and `failureNote` on each routing record (JSONL export).
