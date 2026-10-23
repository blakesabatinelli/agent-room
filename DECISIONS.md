# Decisions

One entry per decision: date, options considered, the choice, and why. Newest first.
IDs D1-D9 match the decisions register in `PLAN.md` section 10. Status is **Open**, **Proposed** (build agent's recommendation, waiting on the owner) or **Decided**.

| ID | Decision | Due | Status |
|---|---|---|---|
| D1 | How agents get local file access | End of phase 0 | Proposed, revised for D9 (see below) |
| D2 | Document source of truth and format | Phase 0 | Proposed |
| D3 | Where control files live | Phase 0 | Proposed |
| D4 | Distribution channel | Start of phase 1 | Open |
| D5 | Provider terms posture | Before 1.0 | Open |
| D6 | Business model | End of phase 2 | Open |
| D7 | 3D technology | Start of phase 3 | Proposed (built on it; see below) |
| D8 | Subagent limits | Start of phase 3 | Proposed (built on it; see below) |
| D9 | Remote access: Tailscale required | Phase 0 | **Decided** (owner, Oct 23) |
| K5 | Relay prototype hosting | Week of Oct 26 | Withdrawn (D9) |
| B1 | Version control host and CI | Week of Oct 26 | Decided (build), remote pending owner |

---

## D7: 3D technology for the office (Proposed, 2026-10-23; built on it)

- **Options:** react-three-fiber or plain three.js in a web view; native SceneKit or RealityKit.
- **Proposal:** three.js, rendered by the hub's web app and shown in the Mac app inside a web view, with a 2D fallback.
- **Why:** one implementation serves the phone web app and the Mac app; it can be tested headless in CI (Chromium); SceneKit would mean a second, Mac-only renderer that can't be built or tested without Xcode. Revisit if the Mac web view can't hold frame rate.
- **Owner to confirm.** Built this way so the work isn't blocked; switching later means replacing one view.

## D8: Subagent limits (Proposed, 2026-10-23; built on it)

- **Proposal (the brief's leaning):** depth 2; a spawn budget per goal (default 6 subagents, owner-adjustable); read-only fan-out is free of the per-task write rule; any subagent that writes gets its own worktree; the parent stays accountable and its subagents' output is judged as part of the parent's task.
- **Owner to confirm.** Start strict, loosen with data (watch tokens per goal: the risk register's early warning is +50%).
- **As built (3.3):** settings `subagents` = `maxDepth` 2, `budgetPerGoal` 6, `maxParallel` 3 per parent, all owner-adjustable. The budget counts read-only helpers too (they cost tokens as much as writers) and each helper also counts as a run in the goal's task-run budget. Subagents an agent's own tool launches are shown in the tree and counted in the ledger but not budgeted. A writing helper's changes reach its parent's worktree only when the parent accepts them.

## D9: Remote access (Decided by owner, 2026-10-23)

- **Options:** a hosted outbound relay (the spike's `packages/relay`, on Fly.io or similar); Tailscale as a requirement.
- **Decision:** Tailscale is a product requirement. The phone web app, agents on other devices (Muse joins this way today) and the hub all sit on the user's tailnet. Vendor-cloud agents that can only call a public HTTPS URL (claude.ai or ChatGPT connectors) reach the hub's `/mcp` path, and nothing else, through Tailscale Funnel (`--set-path`), which the owner switches on.
- **Why:** it's how the owner's setup already works, the web app depends on it, nothing on the Mac is exposed to the internet, and there is no relay service to host, pay for or secure. The spike's open end-to-end-encryption problem (TLS ending at a third-party relay) goes away.
- **Consequences:** K5 is withdrawn. Item 1.2 becomes "remote access over Tailscale" (detect, onboard, pair, Funnel for `/mcp` only). The relay code stays in the repo, shelved, as a fallback if Tailscale ever stops fitting. 1.7's 10-minute install test includes Tailscale sign-in. A relay subscription is off the table for D6.
- **Watch:** Funnel requests are proxied to the hub from localhost, so they pass the hub's interface check; only `/mcp` may be funneled, and `/mcp` must keep authenticating every call itself.

## D1: How agents get local file access (Proposed, 2026-10-23)

- **Options:** (A) relayed MCP file tools through the hub; (B) worktree sync to each vendor's cloud sandbox; (C) each vendor's own remote features.
- **Proposal (revised for D9):** A as the default for every agent, reached over Tailscale (Funnel for vendor-cloud agents) instead of a hosted relay; B only for heavy coding in a vendor cloud sandbox (push the task worktree as a branch, merge the result after approval); C not used as a foundation.
- **Why:** A is the only option that covers every vendor and every kind of folder while keeping the Room's own grants, approvals and audit. Cloud vendors (claude.ai and ChatGPT connectors, the Responses API) all need a public HTTPS MCP URL, which Funnel provides for `/mcp` only. No vendor bridges to other vendors. The prototype works end to end and passed an independent security review as a spike.
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

## K5: Relay prototype hosting (Withdrawn 2026-10-23, superseded by D9)

- **Options:** Fly.io; Cloudflare Workers + Durable Objects; Railway; Render; Google Cloud Run.
- **Proposal:** Fly.io, one Machine in `ord` or `dfw`, auto-stop off, 512 MB (about $4/month list). Fallback Railway.
- **Why:** cheapest always-on option that keeps a long-lived hub WebSocket; Render Free sleeps, Cloud Run caps sockets at 60 minutes and costs about $43/month always-on; Durable Objects is the right answer at scale but a rewrite. Soak-test SSE and idle WebSockets first.
- **Withdrawn:** Tailscale is required (D9), so no relay host is needed. Kept here for the record if the shelved relay is ever revived.

## B1: Version control and CI (Decided by build, 2026-10-23; remote pending owner)

- **Choice:** git with `main` as the default branch; GitHub Actions on macOS runs `pnpm typecheck` and `pnpm test` on every push and PR (`.github/workflows/ci.yml`); `scripts/check.sh` runs the same gate locally.
- **Pending:** create the private remote and protect `main` with `scripts/setup-remote.sh` (needs the owner's GitHub sign-in; branch protection on a private repo needs GitHub Pro or Team).
