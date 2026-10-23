# Agent Room: Project Plan

*Draft, October 23, 2026. This plan covers how and when to build what `PRODUCT.md` describes. Item numbers (0.1, 1.4, ...) match the roadmap in `PRODUCT.md`, section 13.*

---

## 1. At a glance

| Phase | Name | Dates (proposed) | Weeks | Ends with |
|---|---|---|---|---|
| 0 | Foundations | Oct 26 - Nov 6, 2026 | 2 | **M0:** the three foundational decisions closed; the routing log recording |
| 1 | Usable by anyone on a Mac | Nov 9 - Dec 18, 2026 | 6 | **M1:** private beta with 3 to 5 outside testers |
| 2 | Gets smarter | Jan 4 - Feb 5, 2027 | 5 | **M2:** the learning loop live; first kill-criteria review |
| 3 | Identity, design and presence | Feb 8 - Mar 19, 2027 | 6 | **M3:** design refresh, personas, subagents and the office shipped to beta |
| 4 | Trust at scale and distribution | Mar 22 - Apr 30, 2027 | 6 | **M4:** version 1.0 public release |

**Timing assumption:** one owner directing coding agents (Claude Code and Codex, and the Room itself once it can), part-time. Phase 1 includes the Thanksgiving week, and the plan pauses from Dec 21 to Jan 1. Each phase has about 20% slack built in. If an extra engineer joins, phases 3 and 4 can overlap.

---

## 2. Roles

| Role | Who | Responsibilities |
|---|---|---|
| **Owner** | Blake | Approves phase gates and decisions; writes and locks the acceptance criteria for each item; rates a sample of outputs; recruits beta testers |
| **Build agents** | Claude Code and Codex, run through the Room from phase 0 onward where possible | Implement items against their contracts, write tests, report decisions |
| **Reviewer** | An independent agent from a different vendor than the builder | Required on security-sensitive items: file access, the relay, signing, two-key actions, permissions |
| **Beta testers** | 3 to 5 people with two or more AI subscriptions, from M1 onward | Install on their own Macs, use it for real work, report friction |

---

## 3. How the work runs

- **Every item is a contract.** Before work starts, each item gets a short `TASK.md` with its objective, files in scope, acceptance criteria and how to verify them. The owner locks it. The acceptance criteria in this plan are the starting point.
- **One branch per item.** Nothing merges unless `pnpm test` and `pnpm typecheck` pass. New behaviour comes with new tests, building on the existing 67-test suite.
- **Dogfood from the start.** From phase 0 onward, build tasks run through the Room wherever it can handle them. Wherever it can't, record why. That list is the most honest backlog the project has.
- **Weekly rhythm.**
  - *Monday:* choose the week's items from this plan.
  - *Friday:* demo what shipped, bump `VERSION`, add a `CHANGELOG.md` entry, and update the status column in section 11.
- **Phase gates.** A phase closes when every item meets its acceptance criteria, every decision due in that phase is recorded, and the owner signs off. If an item slips, it either moves to the next phase or gets cut. It never blocks the gate silently.
- **Decision log.** Decisions go in `DECISIONS.md` at the repo root, each with its date, the options considered, the choice made and the reason.

---

## 4. Kickoff checklist (week of Oct 26)

| # | Task | Why | Owner |
|---|---|---|---|
| K1 | **Put the repo under version control.** `git init`, a private remote, branch protection on `main` | The repo isn't a git repository yet. Branches, review and rollback all depend on it | Owner + build agent |
| K2 | **Continuous integration:** run `pnpm test` and `pnpm typecheck` on every push | The merge rule in section 3 needs automated checks to enforce it | Build agent |
| K3 | Add `DECISIONS.md` and `CHANGELOG.md` | The decision log and weekly release notes | Build agent |
| K4 | **Join the Apple Developer Program** (Developer ID certificate) | Needed for signing and notarization in item 1.7. Approval can take days, so start it now | Owner |
| K5 | Line up test hardware: one 8 GB Apple silicon Mac and one 32 GB or larger | Item 1.5 has to be tested on both ends of the range | Owner |
| K6 | Start a beta tester list (target 5 names by Dec 1) | M1 needs testers lined up before the build is ready | Owner |
| K7 | Send the provider terms inquiries: OpenAI's "Sign in with ChatGPT" partner application, and a written-approval request to Anthropic | Answers take weeks, and they gate M1 (see T1) | Owner |
| K8 | Pick a hosting provider for the relay prototype | Spike 0.3 needs somewhere to run | Build agent proposes, owner approves |

---

## 5. Phase 0: Foundations

**Dates:** Oct 26 - Nov 6, 2026 (2 weeks)
**Objective:** settle the decisions everything else builds on, and start recording the data that can't be collected after the fact.
**Starts when:** K1 to K3 are done.

| # | Item | Acceptance criteria | Depends on | Size |
|---|---|---|---|---|
| 0.1 | Fix the indented "Run shell commands without asking" setting | Rendered as a proper nested setting under Shell, in an indented container with a left rule, in both the Mac app and the phone web app. No leading spaces in any label. Before and after screenshots attached | None | XS |
| 0.2 | Routing decision log | Every routing pick records the goal, task, task type, each candidate's pick probability, the chosen agent, the model version, epsilon, tokens, cost, seconds, the outcome and the judgment score. Exportable as JSONL. Tests cover the write path | None | S |
| 0.3 | **Spike: local file access** | A decision memo comparing relayed MCP file tools, worktree sync, and vendor remote features on security, latency, vendor coverage and offline behaviour. A working prototype of the leading option: a cloud agent reads a file in a granted folder and proposes a write, and the hub applies it as a diff after approval. Reviewer sign-off on the memo | K8 | M |
| 0.4 | Document standard | Front matter schema implemented. A hub `save_document` tool writes to the Library with front matter and indexes the result. An agent-produced document lands correctly in a test | D2 | S |
| 0.5 | Failure tags | Every failed or sent-back task is tagged as spec, misalignment, verification or other. The tags are visible in the audit log and the JSONL export | 0.2 | S |
| 0.6 | Control file specification | `CONTROL.md` defines the folder layout, the front matter schema for each file, the order layers apply in, the ownership table and the size caps. Owner approved | D3 | S |

**Decisions due:** D1 (file access approach), D2 (document standard), D3 (where control files live).

**Exit criteria (M0):** all six items accepted. D1 to D3 recorded. The routing log has captured at least one real goal.

---

## 6. Phase 1: Usable by anyone on a Mac

**Dates:** Nov 9 - Dec 18, 2026 (6 weeks, including Thanksgiving week)
**Objective:** someone other than the builder installs the Room on their own Mac, connects their own agents, and finishes a real goal that reads and writes their files.
**Starts when:** M0 is reached and D4 is recorded.

| # | Item | Acceptance criteria | Depends on | Size |
|---|---|---|---|---|
| 1.4 | Worktree per task | Every task runs in its own git worktree, or a folder copy for non-git folders. Accepted work merges back; rejected work is discarded. Two agents editing the same repository in parallel never collide (test). Worktrees are cleaned up | None | M |
| 1.1 | Local file access | Folder grants per room and per agent, with read and write set separately, managed in the app. Local agents are confined to their task worktree. Cloud agents reach files only through the hub. Writes arrive as diffs and follow the approval rules. Every file operation is audited. Reviewer passes a security checklist covering path traversal, symlinks and access outside granted folders | 0.3, 1.4, 1.2 | L |
| 1.2 | Relay | Outbound-only connection from the hub, so no inbound ports are opened. Authenticated, encrypted end to end. The phone works away from the local network without Tailscale. A cloud agent can reach the hub's MCP endpoint through it. Reviewer sign-off | 0.3, K8 | M |
| 1.3 | Agent discovery and capability map | On a fresh Mac with Claude Code and Codex installed and signed in, both appear in the room with no manual setup. Local model servers are detected. Each agent's `TOOLS.md` lists what it can reach. A task that needs a data source is only routed to agents that have it (test) | 1.9 | M |
| 1.9 | Control files as the source of truth | The hub reads its rules, personas, permissions and scope from the control folder. Edits in the app and edits in a text editor stay in sync in both directions. Each task's context file is built in its worktree from the layers that apply, under a size cap. The folder is a git repository with one commit per change. The linter blocks malformed files and flags contradictions | 0.6, 1.4 | M |
| 1.5 | Scheduling that adapts to the hardware | The hub detects memory and core count and sets concurrency and whether local models run. Tested on both an 8 GB machine and a 32 GB or larger one. Overflow work goes to cloud agents when the machine is at its limit | 1.3 | M |
| 1.6 | Quota awareness | Usage is tracked per subscription against its 5-hour and weekly windows. The router prefers capacity that's about to expire and treats local models as a free tier. Zero tasks fail on a rate limit that the hub could have predicted, measured over a week of dogfooding | 0.2, 1.3 | M |
| 1.8 | App icon | Concept A delivered as a 1024 px master, the macOS iconset, a menu bar glyph and the web app icons. Legible at 16 px on light and dark backgrounds | None | S |
| 1.7 | Distributable app | The hub's runtime is bundled inside the app. Developer ID signed and notarized, shipped as a DMG. CLI sign-in happens inside the app. A tester goes from a clean Mac to a first finished goal in under 10 minutes without Terminal or Xcode, observed and timed | K4, 1.3, 1.8 | M |

**Suggested order:** weeks 1 and 2 cover 1.4, 1.9, 1.2 and 1.8. Weeks 3 and 4 cover 1.1, 1.3 and 1.5. Weeks 5 and 6 cover 1.6, 1.7 and beta preparation.

**Gate before beta (T1):** the provider terms answers from K7 have been received and recorded as D5. If either provider hasn't answered or has said no, beta testers use API keys for that provider.

**Decisions due:** D4 (distribution channel, by the start of the phase) and D5 (terms posture, before M1).

**Exit criteria (M1):** all items accepted. At least 3 beta testers installed without help, and each finished at least one goal that touched their own files.

---

## 7. Phase 2: Gets smarter

**Dates:** Jan 4 - Feb 5, 2027 (5 weeks)
**Objective:** both the agents and the user measurably improve from one goal to the next.
**Starts when:** M1 is reached.

| # | Item | Acceptance criteria | Depends on | Size |
|---|---|---|---|---|
| 2.1 | Retros and playbooks | Every finished goal produces `LESSONS.md` entries for each agent and task type. The lessons that apply are included in later task context. First-pass acceptance is tracked weekly from the start of the phase | 1.9 | M |
| 2.2 | Blind cross-vendor juries | Outputs are rewritten into a neutral voice before judging. Three judges from different model families, one of them local. Jury agreement and distance from the owner's ratings are both recorded | 0.2 | M |
| 2.3 | Résumés and probation | The orchestrator keeps each agent's `RESUME.md` up to date from results and plans with it. A new agent runs shadow tasks until it reaches a set number of graded runs | 2.2 | S |
| 2.4 | Scores per model version | Scores are keyed by model version. Older evidence fades after a version change, and the Room flags a significant shift | 0.2 | S |
| 2.5 | Memory with sources and expiry; export | Every fact carries a source and an expiry date. A contradicted fact triggers one question to the user. Shared memory is compiled into each agent's own context files within a size cap | 1.9 | M |
| 2.6 | Slash commands from agent skills | Each agent's skills and custom prompts are discovered and appear as namespaced commands in a `/` palette. Choosing one routes to that agent with the skill invoked. Room commands stay unprefixed | 1.3 | M |
| 2.7 | Scorecard, return ledger, evening digest | A weekly scorecard and a monthly subscription return ledger. During the day the Room interrupts only on vendor disagreement or a needed decision, up to a daily cap; everything else goes into the evening digest | 0.2, 1.6 | M |

**Checkpoint: kill-criteria review #1** (end of the phase). Using the routing log and jury data, check the first three kill criteria in `PRODUCT.md` section 15. If there are fewer than 200 graded tasks by then, schedule the review for the date the log reaches 200.

**Decisions due:** D6 (business model).

**Exit criteria (M2):** all items accepted. Kill-criteria review held or scheduled. First-pass acceptance is trending up over the phase.

---

## 8. Phase 3: Identity, design and presence

**Dates:** Feb 8 - Mar 19, 2027 (6 weeks)
**Objective:** the Room looks and feels like its own product, and agents can scale themselves without the user losing sight of what they're doing.
**Starts when:** M2 is reached and D7 and D8 are recorded.

| # | Item | Acceptance criteria | Depends on | Size |
|---|---|---|---|---|
| 3.1 | Design refresh | A goal card showing progress against its "Done means" list, verdict chips, a ⌘K command palette, full dark mode, and a translucent native sidebar. Nothing borrowed from Slack's visual identity. Owner sign-off on screenshots of every screen | None | M |
| 3.2 | Personas | Each agent's `SOUL.md` is editable in the app, with starter templates. Persona text shapes the agent's messages and is stripped before judging (test) | 1.9, 2.2 | S |
| 3.3 | Subagents across the platform | A hub `spawn_agent` tool, which can launch a different vendor from the parent. Subagents appear as a visible tree in the room and the task panel, and can message other agents through the room. Spawn budget and depth limit enforced. Any subagent that writes gets its own worktree. Native subagents are surfaced where the agent's tool allows it | 1.4, D8 | L |
| 3.4 | The 3D office | Shows live agent states (working, waiting for approval, idle, being judged), subagents as helpers at their parent's desk, the goal whiteboard and a light for pending approvals. Clicking an agent opens its thread. Renders only when visible. 2D fallback on 8 GB machines | 3.3, D7 | L |

**Decisions due:** D7 (3D technology) and D8 (subagent limits), both at the start of the phase.

**Exit criteria (M3):** all items accepted and shipped to beta testers. No drop in first-pass acceptance or rise in token cost per goal attributable to subagents.

---

## 9. Phase 4: Trust at scale and distribution

**Dates:** Mar 22 - Apr 30, 2027 (6 weeks)
**Objective:** users can safely grant real permissions, and the Room is ready for a public 1.0.
**Starts when:** M3 is reached.

| # | Item | Acceptance criteria | Depends on | Size |
|---|---|---|---|---|
| 4.1 | Two-key actions | Email send, CRM writes and deletes require independent drafts from two vendors. The action runs only if they match; otherwise the user decides. Reviewer sign-off | 2.2 | M |
| 4.2 | Learned approval policy and permission leases | Approval history becomes readable rules in `POLICY.md` that the user can edit. Permissions can be granted with a time limit or for one goal only, and expire on their own (test) | 1.9 | M |
| 4.3 | Standing rooms | A room can have its own roster, permissions, memory and a calendar trigger, all defined in `ROOM.md` | 1.9 | S |
| 4.4 | Fork a goal | Run two rosters on the same goal, see their results side by side, and merge the better one | 1.4 | S |
| 4.5 | Night-shift tournaments | Quota that would otherwise expire re-runs the day's tasks on other agents, judged blind. The results feed the scores | 1.6, 2.2 | S |
| 4.6 | A2A agent cards and an ACP adapter | The Room publishes an A2A agent card. At least one agent that speaks ACP joins with no custom adapter | 1.3 | M |
| 4.7 | 1.0 distribution | Auto-update, crash reporting, opt-in telemetry, licence terms, a public download page, and documentation. The terms position from D5 is reflected in onboarding | 1.7, D5, D6 | M |

**Checkpoint: kill-criteria review #2** before 1.0 ships.

**Exit criteria (M4):** all items accepted. Kill-criteria review #2 passed. Version 1.0 published.

---

## 10. Decisions register

| ID | Decision | Due | Leaning (from `PRODUCT.md`) |
|---|---|---|---|
| D1 | How agents get local file access | End of phase 0 (spike 0.3) | Relayed MCP by default; worktree sync for heavy cloud coding |
| D2 | Document source of truth and format | Phase 0 | Local Markdown; Google Drive as a synced location |
| D3 | Where control files live | Phase 0 | A visible `~/Agent Room/` folder |
| D4 | Distribution channel | Start of phase 1 | Developer ID, outside the Mac App Store |
| D5 | Provider terms posture | Before M1 (gate T1) | Support subscriptions and API keys; each CLI signs itself in |
| D6 | Business model | End of phase 2 | Open; a relay subscription is the natural fit |
| D7 | 3D technology | Start of phase 3 | Open |
| D8 | Subagent limits | Start of phase 3 | Depth 2; anything that writes gets its own worktree |

---

## 11. Milestones and status

| Milestone | Target date | Status |
|---|---|---|
| Kickoff checklist complete | Oct 30, 2026 | Not started |
| M0: Foundations | Nov 6, 2026 | Not started |
| T1: Terms answers received | Dec 11, 2026 | Not started |
| M1: Private beta | Dec 18, 2026 | Not started |
| M2: Learning loop live | Feb 5, 2027 | Not started |
| M3: Identity and presence | Mar 19, 2027 | Not started |
| M4: 1.0 public release | Apr 30, 2027 | Not started |

---

## 12. Risks

| Risk | Likelihood | Impact | Early warning | Mitigation |
|---|---|---|---|---|
| File access design runs long or fails review | Medium | High: blocks M1 | Spike 0.3 has no working prototype by Nov 4 | Fall back to local agents only for M1; cloud file access moves to phase 2 |
| Providers don't answer or say no on subscription use | Medium | High for distribution | No reply by Dec 1 | Beta and 1.0 use API keys for that provider; subscription path stays for personal use |
| Notarization or bundling problems | Medium | Medium | First notarized build fails in week 4 of phase 1 | Start 1.7 early; K4 done in week 1 |
| Learned routing doesn't beat the single best agent | Medium | High for the thesis | Kill-criteria review #1 | Keep the Room as a launcher with cross-checking; double down on juries and file access |
| Subagents blow up token cost | High | Medium | Tokens per goal up more than 50% after 3.3 | Tighter budgets; read-only fan-out only |
| 3D office eats time or performance | Medium | Low | Frame drops on 8 GB; schedule slip in phase 3 | It's the first item to cut or defer; the 2D view stays |
| Part-time capacity | High | Medium | Two straight weeks without a shipped item | Cut scope at the next gate rather than stretching dates |

---

## 13. What gets measured, from when

| Metric | Starts | Source |
|---|---|---|
| Routing decisions, cost, outcomes | Phase 0 (0.2) | Routing log |
| Failure categories | Phase 0 (0.5) | Failure tags |
| Rate-limit failures | Phase 1 (1.6) | Quota tracker |
| Time from install to first goal | Phase 1 (1.7) | Beta onboarding, observed |
| First-pass acceptance, revisions per task | Phase 2 (2.1) | Routing log and judgments |
| Judge distance from the owner's ratings | Phase 2 (2.2) | Jury records |
| Share of the owner's agent work started in the Room | Phase 0 onward, tracked by hand weekly | Owner |
| Interruptions per day | Phase 2 (2.7) | Digest |

---

## 14. First week, day by day

| Day | Work |
|---|---|
| Mon Oct 26 | K1 to K3: git, remote, CI, `DECISIONS.md` and `CHANGELOG.md`. Owner starts K4 and K7 |
| Tue Oct 27 | 0.1 (the shell setting fix) and 0.2 (routing log) contracts written and started |
| Wed Oct 28 | 0.2 lands. Spike 0.3 starts; relay hosting picked (K8) |
| Thu Oct 29 | 0.6 control file specification drafted; 0.4 document standard drafted |
| Fri Oct 30 | Demo: shell setting fix, routing log recording live goals. D2 and D3 put to the owner |
