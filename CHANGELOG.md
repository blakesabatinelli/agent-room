# Changelog

Weekly release notes. Each Friday: bump `VERSION`, add an entry here, update the status column in `PLAN.md` section 11.
Format: `## <VERSION>` then what shipped, grouped by plan item.

## 2026-10-23.1 (Phase 0, week 1)

Tests: 67 to 123 in the hub, plus 12 in the new relay package. `pnpm test` now runs every package.

- **K1-K3:** the repo is under git (`main`); CI runs typecheck and tests on every push (`.github/workflows/ci.yml`); `scripts/check.sh` is the local merge gate; `scripts/setup-remote.sh` creates the private GitHub remote and protects `main` (owner runs it once). `DECISIONS.md`, this changelog, and a work contract per item in `tasks/`.
- **0.1:** "Run shell commands without asking" is a proper nested setting under Shell (indented container, left rule, secondary text) in the Mac app. The phone web app gets a Permissions screen with the same layout. A test fails the build if any label starts or ends with spaces. Screenshots: `docs/screenshots/0.1-*`.
- **0.2:** routing decision log. Every pick (planned owner, revision, learned, explore, direct answer) records each candidate's pick probability, epsilon, profile, requested and reported model version, tokens, cost, seconds, outcome and judgment. `GET /routing`, `GET /routing/export.jsonl`. Claude Code and Codex runs now report tokens, cost and the model that actually ran.
- **0.3 (spike):** hub file broker (folder grants, reads, diff-proposed writes applied after approval, full audit), MCP file tools, an outbound-only relay (`packages/relay`) and the hub tunnel. Decision memo: `docs/spikes/0.3-file-access.md`. Independent review: acceptable as a spike; its high and medium findings were fixed in the spike.
- **0.4:** document standard. Markdown with front matter in `~/Agent Room/Library/<room>/<goal>/YYYY-MM-DD-slug.md`, indexed by the hub; `save_document` and `list_documents` MCP tools; `GET /documents`. Spec: `docs/DOCUMENTS.md`.
- **0.5:** failure tags. Every failed or sent-back attempt is tagged spec, misalignment, verification or other: on the task, in the audit log (`task.failure`) and in the routing export.
- **0.6:** `CONTROL.md` specification drafted for owner approval.

## 2026-10-22.16 (baseline)

The state of the hub when version control started: 67 tests passing. See `PRODUCT.md` section 12 for what was built.
