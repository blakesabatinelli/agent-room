# Decisions

One entry per decision: date, options considered, the choice, and why. Newest first.
IDs D1-D8 match the decisions register in `PLAN.md` section 10. Status is **Open**, **Proposed** (build agent's recommendation, waiting on the owner) or **Decided**.

| ID | Decision | Due | Status |
|---|---|---|---|
| D1 | How agents get local file access | End of phase 0 | Proposed (see below and `docs/spikes/0.3-file-access.md`) |
| D2 | Document source of truth and format | Phase 0 | Proposed |
| D3 | Where control files live | Phase 0 | Proposed |
| D4 | Distribution channel | Start of phase 1 | Open |
| D5 | Provider terms posture | Before 1.0 | Open |
| D6 | Business model | End of phase 2 | Open |
| D7 | 3D technology | Start of phase 3 | Open |
| D8 | Subagent limits | Start of phase 3 | Open |
| K5 | Relay prototype hosting | Week of Oct 26 | Proposed |
| B1 | Version control host and CI | Week of Oct 26 | Decided (build), remote pending owner |

---

## D1: How agents get local file access (Proposed, 2026-10-23)

- **Options:** (A) relayed MCP file tools through the hub; (B) worktree sync to each vendor's cloud sandbox; (C) each vendor's own remote features.
- **Proposal:** A as the default for every agent; B only for heavy coding in a vendor cloud sandbox (push the task worktree as a branch, merge the result after approval); C not used as a foundation.
- **Why:** A is the only option that covers every vendor and every kind of folder while keeping the Room's own grants, approvals and audit. Cloud vendors (claude.ai and ChatGPT connectors, the Responses API) all need a public HTTPS MCP URL, which the relay provides with no inbound port on the Mac. No vendor bridges to other vendors. The prototype works end to end and passed an independent security review as a spike.
- **Evidence:** `docs/spikes/0.3-file-access.md`; test "I1: an agent that reaches the hub only through the relay ..." in `packages/hub/test/relay.test.ts`.
- **Owner to confirm.** Cross-vendor review of the file-access code still owed before 1.1 merges.

## D2: Document source of truth and format (Proposed, 2026-10-23)

- **Options:** local Markdown files; Google Drive as the source of truth.
- **Proposal:** local Markdown with YAML front matter in `~/Agent Room/Library/<room>/<goal>/YYYY-MM-DD-slug.md`; Google Drive only as a location (point the Library at a Drive-for-Desktop folder). Implemented in 0.4; `AGENT_ROOM_LIBRARY` overrides the root.
- **Why:** every write stays local and fast, works offline, and local agents keep direct file access; Drive sync needs no API or extra code path.
- **Owner to confirm.**

## D3: Where control files live (Proposed, 2026-10-23)

- **Options:** a visible `~/Agent Room/` folder; hidden in `~/.agent-room/`; inside the app's Application Support folder.
- **Proposal:** visible `~/Agent Room/`, with the control files at its root as laid out in `PRODUCT.md` 7.1, the whole folder a git repository, and `Library/` inside it but excluded from that repository. Runtime state (database, logs, task workspaces) stays in `~/.agent-room/`.
- **Why:** the owner can open, edit, diff and back up the rules in any editor, and Finder shows them; "the user owns the record" (`PRODUCT.md` 11). Spec: `CONTROL.md`.
- **Owner to confirm,** together with the `CONTROL.md` review (item 0.6).

## K5: Relay prototype hosting (Proposed, 2026-10-23)

- **Options:** Fly.io; Cloudflare Workers + Durable Objects; Railway; Render; Google Cloud Run.
- **Proposal:** Fly.io, one Machine in `ord` or `dfw`, auto-stop off, 512 MB (about $4/month list). Fallback Railway.
- **Why:** cheapest always-on option that keeps a long-lived hub WebSocket; Render Free sleeps, Cloud Run caps sockets at 60 minutes and costs about $43/month always-on; Durable Objects is the right answer at scale but a rewrite. Soak-test SSE and idle WebSockets first.
- **Owner to approve** the account and spend.

## B1: Version control and CI (Decided by build, 2026-10-23; remote pending owner)

- **Choice:** git with `main` as the default branch; GitHub Actions on macOS runs `pnpm typecheck` and `pnpm test` on every push and PR (`.github/workflows/ci.yml`); `scripts/check.sh` runs the same gate locally.
- **Pending:** create the private remote and protect `main` with `scripts/setup-remote.sh` (needs the owner's GitHub sign-in; branch protection on a private repo needs GitHub Pro or Team).
