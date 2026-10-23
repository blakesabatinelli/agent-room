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
- [x] AC1: Every routing pick records the goal, task, task type, each candidate's pick probability, the chosen agent, the model version, epsilon, tokens, cost, seconds, the outcome and the judgment score
- [x] AC2: Exportable as JSONL
- [x] AC3: Tests cover the write path

## How to verify
pnpm test (routing.test.ts); GET /routing/export.jsonl on a live hub

## Status
Done 2026-10-23 (commit 8a8c368).
- [x] AC1: tests `routing log: every task attempt is recorded with candidates, model, tokens, cost, time, outcome and score`, `routing: epsilon-greedy probabilities are exact and match the pick`, `routing log: learned picks record the policy's probabilities; planned owners record p = 1`, `routing log: a direct answer is recorded too`.
- [x] AC2: `GET /routing/export.jsonl`; test `JSONL export round-trips and sits behind device auth`.
- [x] AC3: 13 tests in `packages/hub/test/routing.test.ts`.
- Live check for M0: run one real goal and confirm `curl -H "Authorization: Bearer <token>" http://127.0.0.1:4747/routing/export.jsonl` shows it (owner).
