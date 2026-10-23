# Agent Room: Product Brief and Roadmap

> **You don't run just one agent. Why does your software?**

*Draft, October 23, 2026. Merges the product goal, the landscape research ("Agent Room: Landscape, Market, and What to Build", Oct 22-23, 2026) and the new feature ideas into one roadmap.*

---

## 1. Summary

Agent Room is a Mac app where agents from different providers work together in one room. You give the room a goal. An orchestrator breaks it into tasks, sends each task to the agent that has proven best at that kind of work, has a different vendor's model check the result, keeps the shared memory, and reports back. You can step in at any point.

No shipping product does the core of this: **learning which agent is best at which kind of work from graded results, across vendors.** The pieces exist in a dozen tools. Nobody has put them in one room.

---

## 2. Goal

**Agent Room is the default place to run work across multiple agents on an Apple silicon Mac, with local or cloud agents from any provider. Working through the Room beats going to any single agent directly, on result quality and on how much of the user's attention it takes. It gets measurably better with every goal, for both the agents and the person running them.**

---

## 3. The problem

People who use AI seriously already run several agents: Claude, ChatGPT, Codex, Muse, local models, and more. The average US AI user now uses 3.0 assistants, up from 2.2 (Menlo Ventures, 2026). Each agent lives in its own app, with its own context, its own data access and no memory of what the others did.

So the user becomes the router, the clipboard and the quality check. They switch apps, re-explain context, copy files back and forth, and judge every output by hand. Nothing learns from one task to the next.

---

## 4. Where Agent Room wins

More agents is not automatically better. The research is clear on that:

- Sampling one top model several times beat mixing different models by 6.6% (Self-MoA, 2025).
- Most of what multi-agent debate gains comes from simple majority voting.
- Multi-agent runs use about 15x the tokens of a normal chat (Anthropic).

So Agent Room can't win as "a crowd of agents." It wins on things no single vendor will offer:

1. **Cross-vendor checking.** Models grade their own work too kindly. A judge from a different model family removes that bias, and no vendor will grade itself against rivals in front of the user.
2. **Using capacity people already pay for.** Several subscriptions with separate limits, plus local models at zero marginal cost, scheduled as one pool.
3. **A track record the user owns.** Which agent works best for you is data that should outlive any one vendor. Vibe Kanban shut down in April 2026, Crystal was deprecated in February 2026, and OpenAI ends Agent Builder on Nov 30, 2026.
4. **Every agent keeps its own reach.** Each agent brings the data access it already has on its own platform. The Room combines them without rebuilding a single connector.

**Positioning:** the neutral layer above the vendors, below the enterprise.

---

## 5. Who it's for

| Segment | Their pain | Fit |
|---|---|---|
| **Operators and executives** | Goal-shaped work (plans, decks, analyses, inbox) that spans email, chat, CRM and documents, so trust and approvals matter | **Strongest and first.** Every multi-vendor tool is built for coders; nobody serves this group |
| **Builder power users with 2+ subscriptions** | Being the router, hitting rate limits, guessing which agent fits which job | **Strong**, but crowded with free tools (Conductor, Happy, Claude Squad) |
| **Small teams of 5 to 50** | Everyone has their own agents and context; nothing is shared | **Later.** Needs multiple people per room and a hosted relay |
| **Enterprise** | Governance, identity, audit | **Avoid.** Microsoft Agent 365, OpenAI Frontier and Gemini Enterprise own it. Publish an A2A agent card so their agents can join instead |

---

## 6. What the product does

### 6.1 One room, every agent

- A message with no @mention starts a goal. `@agent` goes straight to one agent. Room commands like `/pause`, `/resume` and `/stop` control the run.
- On first launch, the Room **finds the agents a user already has** (installed CLIs, signed-in subscriptions, local models) and brings them in with no manual setup.
- Local and cloud agents look the same to the orchestrator. Subscriptions, API keys and local models are all supported.

### 6.2 Orchestration that gets to done

Already built, and aimed at the three ways multi-agent systems usually fail: unclear specs (42% of failures), agents working against each other (37%) and weak verification (21%) (MAST, 1,642 traces).

- **Requirements first.** Every goal becomes a numbered "Done means" list, and every task must cover at least one item.
- **Self-contained tasks**, with decisions made along the way passed to all later tasks.
- **A progress ledger** (`LEDGER.md`) that the orchestrator rewrites after every change.
- **Recovery instead of quiet failure:** retries, a new approach when the same feedback comes back twice, and a replan when work stalls.
- **Done means verified:** a reviewer checks the whole goal against its requirements and the actual files before the goal is called done.

### 6.3 Agents bring their own data access

Each agent keeps the access it has on its own platform. Claude arrives with its connectors, Muse with Meta's access, Hermes with its local tools, Codex with its sandbox. The Room doesn't proxy or rebuild any of it.

- **Capability map.** During discovery, the Room records what each agent can reach (connectors, data sources, tools), from what the agent declares plus a light probe.
- **Routing by capability.** A task that needs CRM data goes to an agent that has CRM access. Learned quality only decides among agents that can do the task.
- **Room permissions narrow, never widen.** The Room can switch an agent's access off for a room or a goal. It can never give an agent access its platform didn't grant.
- **Data crossing boundaries.** Output from a sensitive source carries a label naming that source. The owner decides whether labeled data can enter shared memory or be passed to other agents.

### 6.4 Local file access, for every agent (critical)

Without reading and writing the user's files, the Room is a chat window. This is the most important open problem in the roadmap.

**Proposed approach (to be validated by a spike):**

- **The hub is the only thing that touches the disk.** Agents get file access through the hub, scoped to folders the user grants per room and per agent, with read and write granted separately.
- **Local agents** run inside a per-task worktree within the granted folders, with their own CLI sandbox limited to that path.
- **Cloud agents** reach the hub's file tools over MCP through an outbound-only secure relay, so nothing on the Mac is exposed to the internet. Writes arrive as diffs that the hub applies under the user's approval rules. Every operation goes to the audit log.
- **For heavy cloud coding**, the alternative is to sync a worktree to the agent's cloud sandbox and apply the result back as a diff.
- **One relay does two jobs.** The same relay that gives cloud agents file access also gives the phone access from anywhere, replacing the Tailscale requirement for general users.

The spike compares relayed MCP file tools, worktree sync, and each vendor's own remote-connect features on security, latency, vendor coverage and offline behavior.

### 6.5 Subagents that work across the platform

Any agent can launch subagents when it needs them, and those subagents can talk to other agents and subagents in the room, across vendors.

- **Visible.** Subagents show up as children of their parent: in the task panel, in the room and in the office view.
- **Two kinds.** *Native subagents* are the ones an agent spawns inside its own tool (Claude Code, Codex), surfaced where hooks or logs allow. *Room subagents* are spawned through a hub tool (`spawn_agent`) and can be a different vendor from the parent.
- **Cross-platform messaging** through the room: mentions and the MCP `post_message` tool.
- **Guardrails, because of token cost and conflicting writers:** a spawn budget per goal, a depth limit, free fan-out for read-only work, a separate worktree for any subagent that writes, and the parent stays accountable. Subagent output is judged as part of the parent's task.

### 6.6 Slash commands from each agent's skills

- The Room discovers the skills, commands and custom prompts each agent has in its own ecosystem (for example, Claude Code skills and plugins, Codex custom prompts, Hermes skills).
- They show up in the composer as namespaced commands, such as `/claude:board-deck` or `/hermes:research`. Typing `/` opens a palette grouped by agent, with a description for each command.
- Choosing one routes the message to that agent with that skill invoked.
- Room-level commands stay unprefixed: `/pause`, `/resume`, `/stop`, `/fork`, `/digest`.
- The orchestrator uses the same index, so routing knows when an agent has a skill that matches the task.

### 6.7 Personas

- Each agent has a persona the user can edit: name, avatar, colour, short bio, tone and role. A starter set of templates is included.
- **A persona is not a résumé.** The persona is how an agent presents itself. The résumé (6.9) is what it has proven it's good at, written from its results.
- Persona text shapes the agent's messages in the room, but it is **stripped before judging**, so a persona can never sway a score.

### 6.8 Memory and documents

- **Private and shared memory.** Each agent has private notes and a workspace. Agents propose shared memory, and only the orchestrator writes it. Items it can't decide on wait for the user.
- **Facts expire and get renewed.** Each fact carries a source and an expiry date. When new evidence contradicts a fact, the user gets one question. Stale context is worse than none.
- **Memory goes back out to the agents.** Shared memory is compiled into each agent's own context files (`CLAUDE.md`, `AGENTS.md`, Hermes's `MEMORY.md`), capped by size, so agents carry what the room knows even when used outside it.
- **A single document standard.** See section 7.

### 6.9 Gets smarter with every goal

- **Retros.** Every finished goal ends with a short retro that writes lessons and playbooks, per agent and per task type. Those are fed into later tasks of the same type.
- **Résumés written from the record.** The orchestrator keeps a résumé for each agent from its results ("strong on SQL and refactors; weak on slides") and plans with it. A new agent starts on probation with shadow tasks.
- **Blind juries.** Each output is rewritten into a neutral voice, then graded by three judges from different model families, including a free local model. Models recognize their own writing, and that recognition drives self-preference.
- **Scores per model version.** Old evidence fades when a vendor ships a new model, and the Room flags the shift ("Codex changed this week and is scoring lower on refactors").
- **Every routing decision is logged** with its pick probability, model version, cost and outcome. That makes it possible to replay history and ask "would more tasks have passed if Codex had taken every SQL task?" History that isn't logged can't be recovered later.
- **Night-shift tournaments.** Quota that would otherwise expire overnight re-runs the day's tasks on the agents that didn't get them, graded blind, for clean head-to-head data.

### 6.10 Makes the user smarter

- A **weekly scorecard**: which agents are best at what, where goals were vague and caused rework, how closely the judges match the user's own ratings, and what each goal cost.
- A **subscription return ledger**: accepted tasks per subscription each month, set against what each plan costs, with local models at $0. It answers which plan to cancel or upgrade.
- An **evening digest** instead of pings. The Room escalates during the day only when vendors disagree or a decision is needed, with a daily cap on interruptions.

### 6.11 Control and safety

- **Per-agent permissions** for web, files, shell, email, chat, documents and CRM. Risky actions wait for approval, on the Mac or the phone. Everything goes to an audit log.
- **A learned approval policy.** The user's approve and deny history becomes readable rules they can edit ("auto-approve Drive reads in /Board", "always ask before external email").
- **Permission leases.** Access can expire: "email send for 30 minutes, for this goal only," instead of a standing on/off switch.
- **Two-key actions.** To send email, write to a CRM or delete anything, two agents from different vendors draft the action independently. It runs only if the drafts match; otherwise the user decides.

### 6.12 The office: a visible, 3D working space

- A rendered office where each agent has a desk, and what it's doing is visible: working, waiting for approval, idle, being judged. Subagents appear as helpers at their parent's desk. The goal's "Done means" list lives on a whiteboard. A pending approval lights up at the door.
- It's another **view over the same live state** as the room, not a separate system. Clicking an agent opens its thread.
- It renders only when visible, has a low-power mode, and switches to a 2D fallback on 8 GB machines.
- Technology choice is open: react-three-fiber in a web view, or native SceneKit or RealityKit.

---

## 7. Document standard (proposal)

**Markdown is the canonical format. A local folder is the source of truth. Google Drive is just a location choice.**

- **Format.** Markdown with YAML front matter:
  ```yaml
  title: Q4 competitive read
  room: competitive
  goal: g_0142
  status: draft        # draft | review | final
  authors: [claude, codex, owner]
  created: 2026-10-23
  updated: 2026-10-23
  sources: [...]
  ```
- **Location.** A Room Library folder, by default `~/Agent Room/Library/<room>/<goal>/`. Users who want Drive point the library at a folder synced by Google Drive for Desktop. Drive sync then needs no API and no extra code path.
- **Naming.** `YYYY-MM-DD-slug.md`, with an `assets/` folder beside it.
- **Writes go through the hub.** Agents save documents with the hub's document tool, not arbitrary paths, so every document gets front matter and is indexed.
- **Sharing.** A one-click export to Google Docs, Word or PDF when a document needs to leave the Room.

*Why not Google Drive as the source of truth:* it would make every write depend on the network and an API, and local agents would lose direct file access. A synced local folder gives both.

---

## 8. Design direction

**Familiar, not Slack.** Keep the patterns people already know: a sidebar of rooms, a conversation, a composer, threads. Drop Slack's specifics: the purple sidebar, its icon set, its proportions, and a UI built around emoji reactions.

What makes it its own:

- **Built around goals.** A goal card sits at the top of the conversation, showing progress against its "Done means" list. Tasks live in a right-hand panel.
- **Agent identity** through colour, avatar and persona, used consistently in the room, the task panel and the office.
- **Compact verdict chips** for judgments (accepted, sent back, disputed) instead of long judge messages.
- **Light and calm:** a white canvas, a pale sidebar, hairlines instead of boxes, one deep teal accent, Avenir Next for names and headings. Full dark mode with the same structure.
- **A native Mac feel:** translucent sidebar, keyboard first, ⌘K for everything. Reference points are modern Mac apps such as Linear, Things and Notes, not chat apps.

**Known UI bug:** in the Permissions screen, "Run shell commands without asking" looks indented because its label string starts with four literal spaces (`PermissionsScreen.tsx`, line 26). Render it as a proper nested setting under the Shell switch: an indented container with a left rule and secondary text.

### App icon brief

- It has to read at 16 px, work on light and dark backgrounds, and follow the macOS icon grid (rounded square).
- **Concept A, "The table" (recommended):** a round table seen from above, with three or four seats in agent colours around a teal centre. It's literally agents in one room, and it ties directly to the office view.
- **Concept B, "Open door":** a doorway with light spilling out and small coloured dots inside.
- **Concept C, "Many voices":** three overlapping speech bubbles in agent colours, forming one shape.
- **Deliverables:** a 1024 px master, the macOS iconset sizes, a monochrome menu bar glyph, and web app icons at 180 and 512 px.

---

## 9. What success looks like

- **The Room comes first:** most of a user's non-trivial agent work starts in the Room, not in individual agents.
- **Less juggling:** users copy, paste and switch apps far less to finish a multi-agent task.
- **Agents improve:** first-pass acceptance rises, revisions per task fall, and the same mistake doesn't happen twice.
- **Users improve:** a weekly digest people actually read, and goals that need fewer clarification rounds over time.
- **Fast start:** a new user goes from download to a first completed goal in minutes, with no Xcode and no Terminal.

---

## 10. Scope

**In scope**

- **Hardware:** every Apple silicon Mac, from 8 GB machines to Studios. The hub detects its machine's memory and concurrency, schedules within them, and sends overflow work to cloud agents.
- **Agents:** local and cloud agents from any provider, on subscriptions, API keys or local models.
- **Access:** a native Mac app, plus phone access from anywhere.

**Out of scope for now**

- Intel Macs, Windows and Linux
- Running the hub anywhere other than a Mac
- Rebuilding connectors that agents already have on their own platforms
- Enterprise governance features

---

## 11. Principles

- **Dogfood first.** The Room has to become its builders' own default before it ships to anyone else.
- **Done means verified.** Work isn't finished until it has been checked against what the user asked for.
- **The user stays in control.** Any decision can be overridden, sensitive actions need approval, and everything is audited.
- **One agent per task by default.** Fan out only for read-only work or cleanly separated files. More agents costs tokens and adds conflicts.
- **Agents bring their own reach.** The Room combines access; it never widens it.
- **Learning compounds.** Every goal should leave the Room better than it found it.
- **The user owns the record.** Scores, memory and documents are plain files they can export.

---

## 12. Where it stands today

The hub (version 2026-10-22.16) runs on a Mac and passes 67 tests. Already built: the room and orchestrator described in 6.1 and 6.2, epsilon-greedy routing over learned per-agent, per-task-type scores, rotating judges that never grade their own work, Claude Code and Codex on subscriptions, any CLI through a command adapter, an OpenAI-compatible API fallback, gated shared memory, per-agent permissions with phone approvals, an audit log, a React Native Mac app, a phone web app over Tailscale, and the room exposed as an MCP server.

**Known gaps:** local file access for cloud agents, an isolated workspace per task, knowing how much quota each subscription has left, blind judging, anything that keeps running while the Mac sleeps, more than one person per room, standard interop (A2A, ACP), and installing without Xcode.

---

## 13. Roadmap

Each phase is ordered by dependency. **[New]** marks items from the latest round of ideas; **[R]** marks items from the landscape research.

### Phase 0: Foundations (now)

| # | Item | Why now | Size |
|---|---|---|---|
| 0.1 | Fix the indented "Run shell commands" setting **[New]** | Visible polish bug; a two-line fix | XS |
| 0.2 | Log every routing decision with pick probability, model version, cost and outcome **[R]** | Unlocks replay, scorecards and any future index. History you don't log is gone | S |
| 0.3 | **Spike: local file access for local and cloud agents [New]** | Without it the product doesn't work. Decides the relay design | M |
| 0.4 | Decide and implement the document standard (section 7) **[New]** | Every later feature writes documents; settle the format once | S |
| 0.5 | Tag every failure by category (spec, misalignment, verification) **[R]** | Shows which failure modes still bite | S |

### Phase 1: Usable by anyone on a Mac

| # | Item | Why | Size |
|---|---|---|---|
| 1.1 | Local file access, built from the spike: folder grants, hub file tools, diffs for writes, audit **[New]** | The core requirement | L |
| 1.2 | Outbound relay for cloud agents and phone access from anywhere **[New]** | One piece of infrastructure, two jobs; removes Tailscale for general users | M |
| 1.3 | Agent discovery and capability map, with routing by capability **[New]** | Delivers the tagline on first launch; agents bring their own access | M |
| 1.4 | A worktree per task **[R]** | Table stakes elsewhere. Stops agents overwriting each other; needed for subagents and forks | M |
| 1.5 | Scheduling that adapts to the hardware, with overflow to cloud agents | 8 GB to Studio on one build | M |
| 1.6 | Quota awareness per subscription, with local models as a free tier **[R]** | Stops rate-limit thrashing; spends capacity that's about to expire first | M |
| 1.7 | Signed, notarized app; bundled hub runtime; CLI sign-in inside the app; drag-to-install **[New]** | No Xcode, no Terminal | M |
| 1.8 | App icon **[New]** | Needed to ship | S |

### Phase 2: Gets smarter

| # | Item | Why | Size |
|---|---|---|---|
| 2.1 | Retro at the end of each goal; lessons and playbooks fed into later tasks | The agents themselves improve, not just the routing | M |
| 2.2 | Blind cross-vendor juries: neutral rewrite, then three judges including a local model **[R]** | The strongest evidence-backed piece of the product | M |
| 2.3 | Agent résumés from the record, and probation for new agents **[R]** | The team documents itself; trust is earned | S |
| 2.4 | Scores per model version, with fading evidence **[R]** | Vendors change models silently | S |
| 2.5 | Memory with expiry and sources; export to each agent's context files **[R]** | Memory stays fresh and travels with the agents | M |
| 2.6 | Slash commands from each agent's skills **[New]** | Uses what each ecosystem already has; makes the Room faster than going direct | M |
| 2.7 | Weekly scorecard, subscription return ledger, evening digest **[R]** | The first visible payoff for the user | M |

### Phase 3: Identity, design and presence

| # | Item | Why | Size |
|---|---|---|---|
| 3.1 | Design refresh to the direction in section 8: goal card, verdict chips, ⌘K, dark mode **[New]** | Familiar without copying Slack | M |
| 3.2 | Agent personas, stripped before judging **[New]** | Agents feel like a team without biasing scores | S |
| 3.3 | Subagents across the platform: `spawn_agent`, visible tree, budgets and depth limits **[New]** | Agents scale themselves while the user keeps visibility and cost control | L |
| 3.4 | The 3D office view, with a 2D fallback **[New]** | Shows at a glance who is doing what. Comes after the core works | L |

### Phase 4: Trust at scale and distribution

| # | Item | Why | Size |
|---|---|---|---|
| 4.1 | Two-key actions for email, CRM writes and deletes **[R]** | Lets users grant real permissions safely | M |
| 4.2 | Learned approval policy and permission leases **[R]** | Attention is the scarcest resource; spend it like a budget | M |
| 4.3 | Standing rooms with their own roster, permissions, memory and calendar trigger **[R]** | Recurring work already has a shape; the room should remember it | S |
| 4.4 | Fork a goal: two rosters on the same goal, then compare and merge **[R]** | Variety pays most on judgment work with no test to run | S |
| 4.5 | Night-shift tournaments **[R]** | Clean head-to-head data from capacity already paid for | S |
| 4.6 | A2A agent cards and an ACP adapter **[R]** | Muse Code, Gemini CLI and others on ACP join with no custom glue | M |
| 4.7 | Full distribution: auto-update, crash reporting, opt-in telemetry, licensing, a clean position on provider terms **[New]** | From "anyone can install it" to a real product | M |

**Later, if the data earns it:** calibrated bids (agents state their odds before a task), side bets (other agents predict whether the assignee will pass), more than one person per room, and an opt-in Agent Index built from anonymized outcomes.

---

## 14. Open decisions

| Decision | Options | Leaning |
|---|---|---|
| How agents get local file access | Relayed MCP file tools; worktree sync to cloud sandboxes; each vendor's own remote features | Relayed MCP as the default, worktree sync for heavy cloud coding. Decided by spike 0.3 |
| Document source of truth | Local Markdown; Google Drive | Local Markdown, with Drive as a synced location |
| Distribution channel | Mac App Store; Developer ID outside the store | Developer ID. The App Store sandbox blocks spawning the user's CLIs and broad file access |
| Provider terms posture | Subscriptions only; API keys only; both | Both. Each CLI signs itself in and the Room never touches credentials. API keys are the clean default for distribution |
| Business model | Open-source hub with a paid relay; paid app; Agent Index | Open. A relay subscription fits naturally once 1.2 exists |
| 3D technology | react-three-fiber in a web view; SceneKit or RealityKit | Open. Decide when 3.4 starts |
| Subagent limits | Spawn budget, depth, write rules | Start strict (depth 2, writers need their own worktree), then loosen with data |

---

## 15. Risks and kill criteria

| Risk | What the research shows | What to do |
|---|---|---|
| **Provider terms** | Anthropic bars third-party developers from routing requests through Free, Pro or Max plan credentials on behalf of their users, and blocked spoofing harnesses in January 2026. An Oct 7, 2026 help update says the Agent SDK, `claude -p` and third-party apps can use subscription limits. OpenAI points scripted Codex use to API keys but opened a partner route ("Sign in with ChatGPT") | Each CLI signs itself in; the Room never touches credentials. Before distribution, apply to OpenAI's partner program and get written approval from Anthropic. Support API keys from day one |
| **Token burn** | Multi-agent runs use about 15x the tokens of chat. Read-only helpers work; parallel writers still fail (Cognition, Apr 2026) | One agent per task by default; subagent budgets; writers isolated |
| **Coordination failure** | 42% spec, 37% misalignment, 21% verification (MAST) | The existing "Done means" list, decision passing and verify rounds; tag failures to track them |
| **Hardware range** | 8 GB machines can't run local models alongside the hub and several CLIs | Adaptive scheduling, cloud overflow, 2D fallback for the office |
| **Security of file access** | Cloud agents touching local files is the largest attack surface in the product | Outbound-only relay, granted folders, diffs for writes, approvals, full audit |
| **Vendor churn** | Multiple tools in this space shut down in 2026 | Every record exportable as plain files the user owns |

**Kill criteria** (proposed thresholds):

- **Routing doesn't pay.** After 200 graded tasks, replay shows learned routing beats "always use the single best agent" by under 5 points of pass rate. Then drop learned routing and keep the Room as a launcher with cross-checking.
- **Juries are worse than the user.** Cross-vendor judges disagree with the user's spot ratings more often than same-vendor judges do. Then drop cross-vendor judging.
- **It costs more attention than it saves.** Users spend more minutes a week approving and reviewing than the Room saves them. Then cut to two agents and digest-only.
- **Subscriptions close.** A provider bars orchestrating its CLI on a subscription. Then that provider moves to API keys only, and the cost model gets re-checked.

---

## 16. Landscape at a glance

| Camp | Examples | What they lack |
|---|---|---|
| One vendor's agent managers | Claude Code agent teams, Codex, Cursor, Antigravity, Jules, Devin, Meta Muse Code | One vendor; the same model family grades its own work; no learning about which agent is better |
| Multi-vendor CLI managers | Conductor, Happy, Claude Squad, Nimbalyst, Sculptor | No orchestrator. The user is the router, the judge and the memory |
| Platform control rooms | GitHub Agent HQ, Factory Missions, Warp Oz, Amp | Tied to a repo or platform, cloud-run, code only, no learning per user |
| Multi-model chat | Poe and ChatGPT group chats, LLM Council, Dust, Slack agent channels | Mostly talk, not action; no learning from outcomes |
| Personal agents in messaging apps | OpenClaw, Hermes Agent, Meta Muse | One agent per seat; nothing coordinates them |
| Developer frameworks | Microsoft Agent Framework, CrewAI, LangGraph, OpenAI Agents SDK, Google ADK, Claude Agent SDK | Libraries to build with, not a product; they assume API keys |
| Enterprise control planes | Microsoft Agent 365, OpenAI Frontier, Gemini Enterprise, AWS AgentCore | Governance for IT, not a room for a person |
| Protocols | MCP, A2A 1.0, Zed ACP, AG-UI | Plumbing. Integration is cheap for everyone, so it's no moat |

**Biggest threats:** vendors opening their own control rooms to rivals (GitHub Agent HQ already hosts rival agents), a multi-vendor manager adding an orchestrator (Conductor and Happy have distribution), and models converging so that routing matters less. The answer to all three is the same: cross-vendor judging and the user's own track record take months of real use to build, and no vendor will grade itself against rivals.

---

*Sources: the Agent Room landscape research (Oct 22-23, 2026), which cites MAST, Anthropic's multi-agent research system, Cognition, Self-MoA, PoLL, Panickssery et al. (2024), Menlo Ventures' State of Consumer AI 2026, Gartner, and vendor documentation and terms pages. The figures were pulled from opened pages but not hand-checked. Verify before quoting externally.*
