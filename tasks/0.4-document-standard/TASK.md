# 0.4 Document standard

**Size:** S  **Branch:** `item/0.4-document-standard`  **Locked:** 2026-10-23, owner instruction ("do all items"), criteria as written in PLAN.md

## Objective
Document standard, per PLAN.md section 5 and PRODUCT.md.

## Files in scope
- `packages/hub/src/library/*`
- `packages/hub/src/mcp/server.ts`
- `packages/hub/src/db/store.ts`
- `packages/shared/src/index.ts`
- `packages/hub/test/library.test.ts`
- `docs/DOCUMENTS.md`

## Acceptance criteria
- [ ] AC1: Front matter schema implemented
- [ ] AC2: A hub save_document tool writes to the Library with front matter and indexes the result
- [ ] AC3: An agent-produced document lands correctly in a test

## How to verify
pnpm test (library.test.ts)

## Status
Not started.
