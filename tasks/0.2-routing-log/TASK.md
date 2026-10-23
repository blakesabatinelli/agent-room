# 0.2 Routing decision log

**Size:** S  **Branch:** `item/0.2-routing-log`  **Locked:** 2026-10-23, owner instruction ("do all items"), criteria as written in PLAN.md

## Objective
Routing decision log, per PLAN.md section 5 and PRODUCT.md.

## Files in scope
- `packages/hub/src/orchestrator/routing.ts`
- `packages/hub/src/orchestrator/scoring.ts`
- `packages/hub/src/orchestrator/orchestrator.ts`
- `packages/hub/src/db/store.ts`
- `packages/hub/src/adapters/*`
- `packages/hub/src/api/server.ts`
- `packages/shared/src/index.ts`
- `packages/hub/test/routing.test.ts`

## Acceptance criteria
- [ ] AC1: Every routing pick records the goal, task, task type, each candidate's pick probability, the chosen agent, the model version, epsilon, tokens, cost, seconds, the outcome and the judgment score
- [ ] AC2: Exportable as JSONL
- [ ] AC3: Tests cover the write path

## How to verify
pnpm test (routing.test.ts); GET /routing/export.jsonl on a live hub

## Status
Not started.
