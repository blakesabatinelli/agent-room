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
- [x] AC1: Front matter schema implemented
- [x] AC2: A hub save_document tool writes to the Library with front matter and indexes the result
- [x] AC3: An agent-produced document lands correctly in a test

## How to verify
pnpm test (library.test.ts)

## Status
Done 2026-10-23 (commit bd6deb9).
- [x] AC1: `packages/hub/src/library/frontmatter.ts`; tests `front matter round trips, including quotes and colons in titles`, `splitFrontMatter strips a leading block only, and validateFrontMatter enforces the schema`.
- [x] AC2: `save_document` / `list_documents` MCP tools, `GET /documents`, SQLite index; tests in `library.test.ts`.
- [x] AC3: test `end to end: an agent saves a document over MCP and it lands in the Library and the API`.
