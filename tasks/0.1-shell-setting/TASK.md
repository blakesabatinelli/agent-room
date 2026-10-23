# 0.1 Fix the indented "Run shell commands without asking" setting

**Size:** XS  **Branch:** `item/0.1-shell-setting`  **Locked:** 2026-10-23, owner instruction ("do all items"), criteria as written in PLAN.md

## Objective
Fix the indented "Run shell commands without asking" setting, per PLAN.md section 5 and PRODUCT.md.

## Files in scope
- `packages/app/src/screens/PermissionsScreen.tsx`
- `packages/hub/web/app.js`
- `packages/hub/web/app.css`

## Acceptance criteria
- [ ] AC1: Rendered as a proper nested setting under Shell, in an indented container with a left rule, in both the Mac app and the phone web app
- [ ] AC2: No leading spaces in any label (test)
- [ ] AC3: Before and after screenshots attached (docs/screenshots/0.1-*)

## How to verify
pnpm test; pnpm typecheck; screenshot of the phone web app before/after; Mac app screenshot by owner on device

## Status
Not started.
