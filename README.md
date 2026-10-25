# Agent Room

A local-first room where agents from different providers work together. You give the room a goal; an orchestrator splits it into tasks, hands each to the agent it has learned is best at that kind of work, judges the result, keeps the shared memory, and reports back. You can override it at any time.

## What's in the repo

| Package | What it is |
|---|---|
| `packages/hub` | Node/TypeScript daemon for your Mac: orchestrator, room, SQLite store, CLI agent runners, REST + WebSocket API, MCP server |
| `packages/app` | React Native app (macOS + iOS) for the room, approvals, agents, permissions, memory and settings |
| `packages/shared` | Types shared by both |
| `packages/relay` | Shelved (decision D9): an outbound-only relay built in spike 0.3. Tailscale is required instead |

## Install from the DMG

1. Open `AgentRoom-<version>.dmg` and drag **AgentRoom** onto **Applications**.
2. Open it from Applications. The app is signed locally until the owner publishes a notarized release (`docs/release.md`), so a local build makes macOS warn the first time. On macOS 15 and later, click **Done**, open System Settings > Privacy & Security, and choose **Open Anyway**. On macOS 14 and earlier, right-click the app and choose **Open**. No Terminal needed.
3. Follow the welcome screen: **Sign in** for Claude and Codex (the app installs each CLI if it's missing, opens its sign-in page, and notices when you're done), connect Tailscale (the app shows how if it isn't installed), and open the room.

The DMG carries its own Node and the hub, so there is nothing else to install: no Xcode, no Homebrew, no Terminal. The app starts the hub on your Mac by itself and connects to it with no codes. A short welcome screen signs in Claude and Codex with your subscriptions, switches on practice agents if you'd rather try it first, shows the code for your phone, and keeps the hub running when the app is closed. If something goes wrong, the hub's log is at `~/.agent-room/hub.log`. The timed clean-account install test is `docs/install-test.md`.

**Phone:** Tailscale is required on the Mac and the phone. With Tailscale on both, open the Tailscale address from the Mac (Settings > Pair your phone) in Safari, tap Share > Add to Home Screen, open Agent Room from the home screen, and enter the pairing code. Pair from the home-screen icon, not Safari: iOS keeps their logins separate. The native iPhone app in `packages/app/ios` still works if you'd rather build it in Xcode.


## How it works

**Talking to the room.** A message with no @mention starts a goal. While a goal is running, your messages become owner instructions that override the plan for the rest of it. `@codex …` goes straight to that agent; tag several and they answer in that order. `@all …` (or a short ask like "have each agent respond") is a roll call: every connected agent in the room answers in turn, and any that can't are named. `/pause`, `/resume` and `/stop` also work as messages.

**Delegation and learning.** The orchestrator plans with its own agent (Claude by default), then routes each task with epsilon-greedy selection over learned per-agent, per-task-type scores. Judges rotate and never grade their own worker. Work can be accepted, sent back for revision, or reassigned. A sample of judgments shows up in the room for your spot check, and your rating nudges the agent's score and tracks how far off the judges are.

**Getting goals finished.** The orchestration layer is built around the failure modes multi-agent systems are known for: unclear specs, agents making clashing choices, and work called done before it is.
- *Requirements first.* The planner expands your request into a numbered "Done means" list (G1, G2…) and every task must cover at least one. A plan with missing coverage, circular or unknown dependencies, two tasks writing the same file, or tasks that don't say what they hand back is sent back to the planner once, then repaired mechanically. Nothing is silently dropped.
- *Self-contained tasks.* Each task gets an objective, what it hands back, its boundaries, its inputs, and the decisions everyone follows. Choices an agent makes while working (`DECISIONS:` in its report) are passed to every later task.
- *A progress ledger.* `LEDGER.md` in the goal folder is rewritten by the orchestrator after every change (agents read it, never edit it) and is restated at the end of every task prompt.
- *Recovery instead of quiet failure.* Rate limits and timeouts are retried without spending an attempt. The same feedback twice triggers a new approach. A task that fails for good is replaced by another route to its requirements, and if nothing has been accepted for `stallLimit` reviews the stuck part is replanned. After `maxGoalReplans` the goal stops and asks you one question; your reply picks it back up.
- *Tasks agents can actually do.* An agent writes only inside its task folder, so a plan that tells one to write to `/tmp` or another absolute path goes back to the planner, and a task that works on that folder goes only to an agent that runs on this Mac (an MCP agent counts as here when it connects from loopback; set `location` on the agent to override), while one on another machine, like Muse over Tailscale, gets text-only work. One exception is the save relay: a folder task with no command check that must run on this Mac can still go to an off-machine agent, which hands each deliverable file back in its reply as a `=== FILE: path … === END FILE` block, and a local step writes it into the task's worktree through the same path guards before the work is judged and merged. A replacement task is skipped when an accepted task already met its requirements, and an agent that says its sandbox or machine can't do the work is tagged `placement`, not a quality failure.
- *Done means verified.* When every task passes, every check is re-run (to catch regressions), then a reviewer checks the whole goal against the requirements and the actual files. Gaps become fix tasks, for up to `maxVerifyRounds` rounds. Criteria two reviewers can't verify are flagged for you instead of looping.
- *Bounded.* Each goal has a budget of `maxTaskRuns`; past it, it pauses and asks.
- *Durable.* Every step that changes a goal (plan made, plan approved, task assigned, run started, run finished with its reply, judged, accepted, merged, sent back, replanned, goal done, failed or stopped) is written to the `goal_steps` table in the hub's database before the change counts as done. When the hub restarts, each goal that was running picks up from its last completed step: a run that was in flight is tried again once and does not count as an attempt, a run that had finished goes straight to judging, accepted work that was not merged is merged, and nothing already accepted runs again. A goal waiting on you (plan approval, a question, an approval card) keeps waiting. The room gets one quiet line per resumed goal ("Picked up where it left off after a restart: 2 tasks done, 1 resumed."). Resuming twice changes nothing, because a step of a run is written only once.

**Memory.** Each agent has private notes plus its own workspace folder (`~/.agent-room/workspaces/<agent>/<room>`). Agents propose shared memory with the `propose_memory` tool or `MEMORY:` lines; only the orchestrator writes shared memory, and anything it can't decide waits for you in the Memory screen.

**Agents.** Claude Code and Codex run as child processes using your subscriptions. Hermes, Muse or anything else plugs in with the `command` adapter (any CLI, with `{prompt}` or `{promptFile}` substitution); an OpenAI-compatible API adapter is the fallback.

**Permissions.** Per-agent switches for web, files, shell, Gmail, Slack, Drive and Salesforce. For Claude Code they become `--allowedTools`/`--disallowedTools`, and enabled sensitive tools are routed through the hub's approval tool, so Claude Code pauses until you approve on your phone. Codex maps onto its sandbox modes; because `codex exec` can't pause mid-run, its sensitive actions rely on it calling `request_approval`. Every run, decision and change goes to the audit log.

**Routing log.** Every routing pick is recorded with each candidate's pick probability, epsilon, the model that ran, tokens, cost, seconds, the outcome, the judge's score and, for work sent back, a failure tag (spec, misalignment, verification, placement, other). Export it with `GET /routing/export.jsonl`.

**Trace and Issues.** `GET /goals/:id/trace` shows one goal as a single tree: the plan and its approval, each task in plan order, every attempt (agent, model, time, tokens, outcome, failure, judge and score, sent back or accepted), and under each attempt the approvals, reply turns and room posts from that time, with helpers under their parent. `GET /issues` (also in Settings on the phone and the sidebar on the Mac) groups problems that keep coming back over the last 7 days, each with a plain title, trace links and one next step; Dismiss hides one until it happens again.

**Documents.** Agents save documents with the `save_document` MCP tool. Each lands as Markdown with front matter in `~/Agent Room/Library/<room>/<goal>/YYYY-MM-DD-slug.md` and is indexed (`GET /documents`). See `docs/DOCUMENTS.md`.

**Local files (spike).** The owner grants folders per room and per agent (`/folder-grants`); agents read through `read_file` and write only by proposing a diff (`propose_file_write`) that the owner approves. Agents on other tailnet devices (Muse) reach the same tools over Tailscale; vendor-cloud agents can reach `/mcp` only through Tailscale Funnel, which the owner switches on in Settings (1.2; `docs/1.2-remote-access.md`). A room can also have a default folder (`PUT /rooms/:id` with `folderGrantId`, or null to clear it): goals started in the room use it unless the message sends `folderGrantId: ""` for no folder. See `docs/spikes/0.3-file-access.md`.

**MCP.** The hub serves the room at `POST /mcp` (Streamable HTTP). Tools: `read_room`, `post_message`, `read_memory`, `propose_memory`, `list_tasks`, `update_task`, `request_approval`. CLI agents get a short-lived token per run. For Claude Desktop or another MCP app, use Settings > Let MCP apps join the room on the Mac.

**Security.** The hub only answers on localhost and Tailscale addresses. Devices pair with the one-time code and then use a bearer token. Provider logins stay with each CLI.

**Phone alerts.** When the app is open, approvals arrive live. For alerts when it's closed, set `AGENT_ROOM_NTFY_TOPIC` to a long random string and subscribe to that topic in the ntfy app.

**Speed.** The hub runs from a prebuilt bundle (`packages/hub/run.sh`), rebuilt in under a second only when its source changes; starting it takes about half a second instead of compiling TypeScript on every launch. Setup.command reinstalls the Mac app's native parts, and asks for a clean Xcode build, only when something native changed. Each screen re-renders only when the data it shows changes.

**Look.** Light: white conversation, a pale sidebar, hairlines instead of boxes, one deep teal accent, Avenir Next for names and headings. Agents carry their own colours. The phone web app uses the same palette.

## Settings (environment)

`AGENT_ROOM_PORT` (4747), `AGENT_ROOM_DATA` (`~/.agent-room`), `AGENT_ROOM_OWNER` (Blake), `AGENT_ROOM_TAILSCALE_IP` (auto-detected; forces the address given to other devices), `AGENT_ROOM_TAILSCALE_BIN` (path to the `tailscale` CLI; default is PATH, then the Mac app), `AGENT_ROOM_FUNNEL_PORT` (443, 8443 or 10000), `AGENT_ROOM_NTFY_TOPIC`, `AGENT_ROOM_DEMO`, `AGENT_ROOM_LIBRARY` (`~/Agent Room/Library`), and, to dial out to a relay, `AGENT_ROOM_RELAY_URL`, `AGENT_ROOM_RELAY_HUB_ID`, `AGENT_ROOM_RELAY_SECRET`.

## Tests

`pnpm test` runs every package's tests (123 in the hub, 12 in the relay) with mock agents: planning, delegation, judging, revision and failure, memory keeping, @mentions, owner overrides, pause, approvals, calibration, routing, permission mapping, pairing/auth (including the Mac app's own local pairing), a real MCP client against the server, the routing log and failure tags, the document Library, file grants and diff-approved writes, and the relay end to end. `scripts/check.sh` runs typecheck and tests, the same gate CI runs on every push.

## Working on it

`PLAN.md` is the build plan; `PRODUCT.md` the brief. Each item has a work contract in `tasks/`; decisions go in `DECISIONS.md`; each Friday's release goes in `CHANGELOG.md` and `VERSION`.

## Develop

For working on the code, not for installing it.

**Run from Xcode (Mac app).**
1. Install Xcode from the App Store and open it once.
2. Unzip a fresh copy, then in Terminal: `xattr -dr com.apple.quarantine ~/Downloads/agent-room`
3. In Finder, double-click **Setup.command** (the first time, right-click it and choose Open). It stops any older Agent Room, installs anything missing, installs packages, and runs `pod install`, which **creates `packages/app/macos/AgentRoom.xcworkspace`** (the workspace isn't in a zip; it only exists after Setup.command has run). Xcode opens the workspace.
4. In Xcode, Product > Clean Build Folder, make sure the scheme says **AgentRoom-macOS**, then press **⌘R**.

A run from Xcode has no bundled runtime, so the app starts the hub from this folder with `packages/hub/run.sh` (the `AgentRoomHubDir` entry in the app's Info.plist). The installed app prefers the bundled Node and `Hub/hub.mjs` when they are there.

**Run the hub alone.** `pnpm install && pnpm hub` runs the hub on its own and prints a pairing code; `AGENT_ROOM_DEMO=1 pnpm hub` uses mock agents.

**Build the DMG.** On an Apple silicon Mac with Xcode, pnpm and CocoaPods (Setup.command installs them): `bash scripts/package-mac.sh`. It builds the hub bundle, downloads the official Node 22 build and checks it against nodejs.org's SHA-256 list, installs better-sqlite3 for that Node, builds the Release app, puts the runtime inside it, signs it ad-hoc, makes `build/mac/AgentRoom-<version>.dmg`, and ends by running `scripts/verify-dmg.sh` (mounts the DMG, checks the structure, signature, bundled Node, better-sqlite3 and a hub start). It prints the DMG path, size and SHA-256. `scripts/stage-hub.sh` does the runtime staging step alone and also runs on Linux, for testing it.
