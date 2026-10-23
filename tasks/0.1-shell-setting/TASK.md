# 0.1 Fix the indented "Run shell commands without asking" setting

**Size:** XS  **Branch:** `item/0.1-shell-setting`  **Locked:** 2026-10-23, owner instruction ("do all items"), criteria as written in PLAN.md

## Objective
Fix the indented "Run shell commands without asking" setting, per PLAN.md section 5 and PRODUCT.md.

## Files in scope
- `packages/app/src/screens/PermissionsScreen.tsx`
- `packages/hub/web/app.js`
- `packages/hub/web/app.css`

## Acceptance criteria
- [x] AC1: Rendered as a proper nested setting under Shell, in an indented container with a left rule, in both the Mac app and the phone web app
- [x] AC2: No leading spaces in any label (test)
- [ ] AC3: Before and after screenshots attached (docs/screenshots/0.1-*)

## How to verify
pnpm test; pnpm typecheck; screenshot of the phone web app before/after; Mac app screenshot by owner on device

## Status
Built 2026-10-23 (commit c5b4358).
- [x] AC1 (phone web app): new Permissions screen; the sub-setting sits in `.nested` (28 px indent, 2 px left rule, secondary text). Screenshot `docs/screenshots/0.1-phone-after.png`; before: `0.1-phone-before.png` (the phone had no permissions screen at all).
- [x] AC1 (Mac app, code): `Toggle nested` renders an indented container with a left rule and secondary text. **Owner to confirm on device** with a Mac app screenshot (React Native macOS can't be rendered in CI).
- [x] AC2: test `0.1: no UI label carries leading or trailing spaces` (fails on the old code).
- [ ] AC3: Mac app before/after screenshots: owner, on the Mac.
