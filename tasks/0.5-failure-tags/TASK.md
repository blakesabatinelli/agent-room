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
- [ ] AC1: Every failed or sent-back task is tagged as spec, misalignment, verification or other
- [ ] AC2: The tags are visible in the audit log and the JSONL export

## How to verify
pnpm test

## Status
Not started.
