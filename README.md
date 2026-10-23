# Agent Room

A local-first room where agents from different providers work together. You give the room a goal; an orchestrator splits it into tasks, hands each to the agent it has learned is best at that kind of work, judges the result, keeps the shared memory, and reports back. You can override it at any time.

## What's in the repo

| Package | What it is |
|---|---|
| `packages/hub` | Node/TypeScript daemon for your Mac: orchestrator, room, SQLite store, CLI agent runners, REST + WebSocket API, MCP server |
| `packages/app` | React Native app (macOS + iOS) for the room, approvals, agents, permissions, memory and settings |
| `packages/shared` | Types shared by both |
| `packages/relay` | Shelved (decision D9): an outbound-only relay built in spike 0.3. Tailscale is required instead |

## Get started

1. Install Xcode from the App Store and open it once.
2. In Finder, double-click **Setup.command** in this folder (the first time, right-click it and choose Open). It installs anything missing and opens the project in Xcode.
3. In Xcode, make sure the scheme at the top says **AgentRoom-macOS**, then press **⌘R**.

The app starts the hub on your Mac by itself and connects to it with no codes. A short welcome screen then lets you sign in Claude and Codex with your subscriptions (it opens their own sign-in in Terminal), switch on practice agents if you'd rather try it first, show the code for your phone, and keep the hub running when the app is closed.

**Phone:** Tailscale is required on the Mac and the phone. With Tailscale on both, open the Tailscale address from the Mac (Settings > Pair your phone) in Safari, tap Share > Add to Home Screen, open Agent Room from the home screen, and enter the pairing code. Pair from the home-screen icon, not Safari: iOS keeps their logins separate. The native iPhone app in `packages/app/ios` still works if you'd rather build it in Xcode.

**Without the app:** `pnpm install && pnpm hub` runs the hub on its own and prints a pairing code; `AGENT_ROOM_DEMO=1 pnpm hub` uses mock agents. If something goes wrong, the hub's log is at `~/.agent-room/hub.log`.

## How it works

**Talking to the room.** A message with no @mention starts a goal. While a goal is running, your messages become owner instructions that override the plan for the rest of it. `@codex …` goes straight to that agent. `/pause`, `/resume` and `/stop` also work as messages.

**Delegation and learning.** The orchestrator plans with its own agent (Claude by default), then routes each task with epsilon-greedy selection over learned per-agent, per-task-type scores. Judges rotate and never grade their own worker. Work can be accepted, sent back for revision, or reassigned. A sample of judgments shows up in the room for your spot check, and your rating nudges the agent's score and tracks how far off the judges are.

**Getting goals finished.** The orchestration layer is built around the failure modes multi-agent systems are known for: unclear specs, agents making clashing choices, and work called done before it is.
- *Requirements first.* The planner expands your request into a numbered "Done means" list (G1, G2…) and every task must cover at least one. A plan with missing coverage, circular or unknown dependencies, two tasks writing the same file, or tasks that don't say what they hand back is sent back to the planner once, then repaired mechanically. Nothing is silently dropped.
- *Self-contained tasks.* Each task gets an objective, what it hands back, its boundaries, its inputs, and the decisions everyone follows. Choices an agent makes while working (`DECISIONS:` in its report) are passed to every later task.
- *A progress ledger.* `LEDGER.md` in the goal folder is rewritten by the orchestrator after every change (agents read it, never edit it) and is restated at the end of every task prompt.
- *Recovery instead of quiet failure.* Rate limits and timeouts are retried without spending an attempt. The same feedback twice triggers a new approach. A task that fails for good is replaced by another route to its requirements, and if nothing has been accepted for `stallLimit` reviews the stuck part is replanned. After `maxGoalReplans` the goal stops and asks you one question; your reply picks it back up.
- *Done means verified.* When every task passes, every check is re-run (to catch regressions), then a reviewer checks the whole goal against the requirements and the actual files. Gaps become fix tasks, for up to `maxVerifyRounds` rounds. Criteria two reviewers can't verify are flagged for you instead of looping.
- *Bounded.* Each goal has a budget of `maxTaskRuns`; past it, it pauses and asks.

**Memory.** Each agent has private notes plus its own workspace folder (`~/.agent-room/workspaces/<agent>/<room>`). Agents propose shared memory with the `propose_memory` tool or `MEMORY:` lines; only the orchestrator writes shared memory, and anything it can't decide waits for you in the Memory screen.

**Agents.** Claude Code and Codex run as child processes using your subscriptions. Hermes, Muse or anything else plugs in with the `command` adapter (any CLI, with `{prompt}` or `{promptFile}` substitution); an OpenAI-compatible API adapter is the fallback.

**Permissions.** Per-agent switches for web, files, shell, Gmail, Slack, Drive and Salesforce. For Claude Code they become `--allowedTools`/`--disallowedTools`, and enabled sensitive tools are routed through the hub's approval tool, so Claude Code pauses until you approve on your phone. Codex maps onto its sandbox modes; because `codex exec` can't pause mid-run, its sensitive actions rely on it calling `request_approval`. Every run, decision and change goes to the audit log.

**Routing log.** Every routing pick is recorded with each candidate's pick probability, epsilon, the model that ran, tokens, cost, seconds, the outcome, the judge's score and, for work sent back, a failure tag (spec, misalignment, verification, other). Export it with `GET /routing/export.jsonl`.

**Documents.** Agents save documents with the `save_document` MCP tool. Each lands as Markdown with front matter in `~/Agent Room/Library/<room>/<goal>/YYYY-MM-DD-slug.md` and is indexed (`GET /documents`). See `docs/DOCUMENTS.md`.

**Local files (spike).** The owner grants folders per room and per agent (`/folder-grants`); agents read through `read_file` and write only by proposing a diff (`propose_file_write`) that the owner approves. Agents on other tailnet devices (Muse) reach the same tools over Tailscale; vendor-cloud agents can reach `/mcp` only through Tailscale Funnel (planned in 1.2). See `docs/spikes/0.3-file-access.md`.

**MCP.** The hub serves the room at `POST /mcp` (Streamable HTTP). Tools: `read_room`, `post_message`, `read_memory`, `propose_memory`, `list_tasks`, `update_task`, `request_approval`. CLI agents get a short-lived token per run. For Claude Desktop or another MCP app, use Settings > Let MCP apps join the room on the Mac.

**Security.** The hub only answers on localhost and Tailscale addresses. Devices pair with the one-time code and then use a bearer token. Provider logins stay with each CLI.

**Phone alerts.** When the app is open, approvals arrive live. For alerts when it's closed, set `AGENT_ROOM_NTFY_TOPIC` to a long random string and subscribe to that topic in the ntfy app.

**Speed.** The hub runs from a prebuilt bundle (`packages/hub/run.sh`), rebuilt in under a second only when its source changes; starting it takes about half a second instead of compiling TypeScript on every launch. Setup.command reinstalls the Mac app's native parts, and asks for a clean Xcode build, only when something native changed. Each screen re-renders only when the data it shows changes.

**Look.** Light: white conversation, a pale sidebar, hairlines instead of boxes, one deep teal accent, Avenir Next for names and headings. Agents carry their own colours. The phone web app uses the same palette.

## Settings (environment)

`AGENT_ROOM_PORT` (4747), `AGENT_ROOM_DATA` (`~/.agent-room`), `AGENT_ROOM_OWNER` (Blake), `AGENT_ROOM_TAILSCALE_IP` (auto-detected), `AGENT_ROOM_NTFY_TOPIC`, `AGENT_ROOM_DEMO`, `AGENT_ROOM_LIBRARY` (`~/Agent Room/Library`), and, to dial out to a relay, `AGENT_ROOM_RELAY_URL`, `AGENT_ROOM_RELAY_HUB_ID`, `AGENT_ROOM_RELAY_SECRET`.

## Tests

`pnpm test` runs every package's tests (123 in the hub, 12 in the relay) with mock agents: planning, delegation, judging, revision and failure, memory keeping, @mentions, owner overrides, pause, approvals, calibration, routing, permission mapping, pairing/auth (including the Mac app's own local pairing), a real MCP client against the server, the routing log and failure tags, the document Library, file grants and diff-approved writes, and the relay end to end. `scripts/check.sh` runs typecheck and tests, the same gate CI runs on every push.

## Working on it

`PLAN.md` is the build plan; `PRODUCT.md` the brief. Each item has a work contract in `tasks/`; decisions go in `DECISIONS.md`; each Friday's release goes in `CHANGELOG.md` and `VERSION`.

## Getting started on a Mac (fresh copy)

1. Unzip, then in Terminal: `xattr -dr com.apple.quarantine ~/Downloads/agent-room`
2. Double-click `Setup.command`. It stops any older Agent Room, installs packages, and runs
   `pod install`, which **creates `packages/app/macos/AgentRoom.xcworkspace`**. The workspace
   isn't in the zip; it only exists after Setup.command has run.
3. Xcode opens the workspace. Product > Clean Build Folder, scheme `AgentRoom-macOS`, ⌘R.
