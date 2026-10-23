# Control files: specification

*Item 0.6. Draft for owner approval, October 23, 2026. Builds on `PRODUCT.md` 7.1 and makes it exact enough to implement in 1.9. Later items fill in the files marked with their number (2.1, 2.3, 2.5, 3.2, 4.2, 4.3). Assumes D3 = a visible `~/Agent Room/` folder (proposed in `DECISIONS.md`).*

Everything that steers an agent lives in plain Markdown the owner can read, edit in any editor, diff and back up. The app's settings screens edit these files; they keep no separate copy. Settings the hub must read exactly go in YAML front matter; rules and guidance go in the body.

---

## 1. Folder layout

```
~/Agent Room/                      the control folder: a git repository (Library/ excluded)
├── AGENTS.md                      rules for every agent in every room: scope, conventions, hard limits
├── USER.md                        who the owner is, how they work, what they expect from agents
├── POLICY.md                      approval rules and permission defaults; learned rules (4.2)
├── agents/<agent-id>/
│   ├── SOUL.md                    persona and identity: name, colour, voice, role (3.2)
│   ├── TOOLS.md                   how it runs, what its platform lets it reach, what the Room allows (1.3)
│   ├── RESUME.md                  what it has proven good and bad at (2.3)
│   ├── LESSONS.md                 lessons from retros, by task type (2.1)
│   └── MEMORY.md                  the agent's private notes
├── rooms/<room-slug>/
│   ├── ROOM.md                    purpose, roster, scope, permission overrides, schedule (4.3)
│   └── MEMORY.md                  the room's shared memory, with sources and expiry (2.5)
├── goals/<goal-id>/
│   ├── GOAL.md                    the ask, the "Done means" list, in scope and out of scope
│   ├── LEDGER.md                  progress, rewritten after every change
│   └── DECISIONS.md               decisions every later task must follow
├── playbooks/<task-type>.md       reusable how-tos built from retros (2.1)
└── Library/                       documents (0.4, docs/DOCUMENTS.md); not in the control repo
```

- `<agent-id>` is the hub's agent id (`claude`, `codex`, `hermes`). `<room-slug>` is the same slug the Library uses. `<goal-id>` is the hub's goal id.
- Unknown files are ignored and reported by the linter, so a typo (`SOUL.MD`) is caught instead of silently doing nothing.
- The database keeps only runtime state: messages, tasks, scores, the routing log and the audit log. Files the orchestrator writes from that state (`RESUME.md`, `LESSONS.md`, `LEDGER.md`) are regenerated if deleted.
- `Library/` has its own `.gitignore` entry: documents can be large, binary, or synced by Google Drive, and they already carry their own front matter and index.

## 2. Front matter

Same YAML dialect as Library documents (quoted strings where needed, inline arrays).

**Every file:**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `kind` | enum | yes | `agents`, `user`, `policy`, `soul`, `tools`, `resume`, `lessons`, `agent-memory`, `room`, `room-memory`, `goal`, `ledger`, `decisions`, `playbook` |
| `schema` | int | yes | Format version, starting at `1`. The hub migrates older versions and refuses newer ones |
| `updated` | date | yes | `YYYY-MM-DD` |
| `updated_by` | string | yes | `owner`, `orchestrator`, `hub`, or an agent id (agent `MEMORY.md` only) |

**Per file** (beyond the fields above):

| File | Front matter | Body |
|---|---|---|
| `AGENTS.md` | `hard_limits: [..]` (short machine-checkable lines, e.g. `no-external-email-without-approval`) | Rules, conventions, scope for all agents |
| `USER.md` | `name`, `timezone`, `working_hours?` | How the owner works and what they expect |
| `POLICY.md` | `defaults: { <tool>: on\|ask\|off }`, `rules: [{ id, effect: allow\|ask\|deny, tool, match, scope, expires?, source: owner\|learned, accepted: bool }]` | One plain-English line per rule |
| `SOUL.md` | `name`, `color`, `avatar?`, `role`, `tone` | Bio and voice notes. Stripped before judging (3.2) |
| `TOOLS.md` | `runtime: { adapter, provider, enabled, binary?, model?, profiles? }`, `platform: { connectors: [..], data_sources: [..], skills: [..] }` (written by discovery), `room_allows: { <tool>: on\|ask\|off }` (owner), `discovered: date` | Notes |
| `RESUME.md` | `runs`, `strengths: [..]`, `weaknesses: [..]`, `model_versions: [..]`, `probation: bool` | Written from results |
| `LESSONS.md` | `task_types: [..]` | One `## <task-type>` section each; one lesson per bullet, ending `(from <goal-id>)` |
| agent `MEMORY.md` | (none) | One note per bullet |
| `ROOM.md` | `name`, `roster: [agent ids]`, `tools: { <tool>: ask\|off }`, `folders: [grant ids]`, `schedule?: <cron>`, `in_scope: [..]`, `out_of_scope: [..]` | What the room is for |
| room `MEMORY.md` | (none) | One fact per bullet: `<fact> — source: <goal or owner>, expires: YYYY-MM-DD` |
| `GOAL.md` | `id`, `room`, `status`, `locked: date?`, `requirements: [{ id: G1, text }]`, `in_scope: [..]`, `out_of_scope: [..]` | The ask in the owner's words |
| `LEDGER.md` | `goal` | As today (`ledgerMarkdown`) |
| goal `DECISIONS.md` | `goal` | One decision per bullet, with who made it |
| `playbooks/<type>.md` | `task_type`, `applies_to: [agent ids] \| "*"` | The playbook |

Agent runtime settings (adapter, binary, model, profiles) move out of the database into `TOOLS.md`'s `runtime` block, and identity (name, colour) into `SOUL.md`, so that "the database keeps only runtime state" holds.

## 3. The order layers apply in

When a task starts, the hub builds that agent's context from the layers that apply and writes it into the task's worktree as the agent's native file: `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, Hermes's own files for Hermes. If the repository already has that file, the hub's block goes at the top between `<!-- agent-room:begin -->` and `<!-- agent-room:end -->` markers, and the file is restored before the worktree merges back, so the owner's repo never picks up the Room's context.

Layers, broadest first:

1. `AGENTS.md`
2. `USER.md`
3. `rooms/<room>/ROOM.md`
4. `agents/<id>/SOUL.md` (voice only; stripped before judging)
5. `agents/<id>/TOOLS.md` (the effective reach in this room, after narrowing)
6. `playbooks/<task-type>.md`
7. `agents/<id>/LESSONS.md`, only the section for this task type
8. `rooms/<room>/MEMORY.md`, unexpired facts only, plus the agent's own `MEMORY.md`
9. `goals/<goal>/GOAL.md`, `DECISIONS.md` and the task contract (objective, criteria, files, owner amendments)

**Layers only tighten.** A narrower layer can add rules and restrict access; it can never loosen a broader rule or grant access. Concretely:

- **Permissions** are the intersection of: what the agent's platform grants (`TOOLS.md` `platform`), `POLICY.md` defaults and rules, `TOOLS.md` `room_allows`, `ROOM.md` `tools`, and any lease. `off` beats `ask`, which beats `on`.
- **Rules** accumulate. When two rules conflict, the narrower one applies only if it is stricter; a looser narrower rule is ignored and flagged by the linter.
- **The goal and the owner's amendments** decide what the task is. They can narrow scope; they can't lift a hard limit in `AGENTS.md`.

`RESUME.md` and `POLICY.md` are read by the orchestrator and the hub, never put in an agent's context.

## 4. Who writes what

| File | Written by | Owner can edit | Agents |
|---|---|---|---|
| `AGENTS.md`, `USER.md`, `SOUL.md`, `ROOM.md` | Owner; the orchestrator can propose changes | Yes | Read only |
| `POLICY.md` | Owner; the hub proposes learned rules (`source: learned, accepted: false`) that apply only once accepted | Yes | Never see it |
| `TOOLS.md` | Discovery writes `runtime` and `platform`; the owner sets `room_allows` | `room_allows` and `runtime` only | Read only |
| `RESUME.md`, `LESSONS.md`, playbooks, room `MEMORY.md` | The orchestrator | Yes (edit or delete) | Propose via retros and `propose_memory` |
| agent `MEMORY.md` | That agent, through a hub tool | Yes | Its own only |
| `GOAL.md` | The orchestrator drafts; the owner approves | Before the plan locks | Read only |
| `LEDGER.md`, goal `DECISIONS.md` | The orchestrator | Read only | Read only; decisions arrive in task reports |

Agents never write a control file directly. Everything they contribute arrives as a proposal (the Memory screen flow), except an agent's own private `MEMORY.md`, which it edits through a hub tool so the write is still audited and committed.

## 5. Size caps (bytes)

| What | Cap | Near or over the cap |
|---|---|---|
| `AGENTS.md`, `USER.md`, `POLICY.md`, `ROOM.md`, `SOUL.md`, `TOOLS.md` | 8 KB each | Linter error at the cap; the hub keeps the last good version |
| `LESSONS.md` | 12 KB | At 80% the orchestrator condenses: merges duplicates, retires the oldest lessons |
| `RESUME.md`, playbooks | 8 KB | Condensed at 80% |
| room `MEMORY.md` | 16 KB | Expired facts drop first, then the lowest-confidence ones |
| agent `MEMORY.md` | 8 KB | The agent is told to condense; past the cap, writes are refused |
| `GOAL.md` | 16 KB | Linter error |
| Built context per task | 24 KB (about 6,000 tokens) | Trimmed in this order until it fits: memory (oldest first), lessons (oldest first), playbook (tail), `TOOLS.md` notes. `AGENTS.md` hard limits, `ROOM.md` scope and the goal and task contract are never trimmed |

Item 1.5 may lower the context cap per agent for small local models.

## 6. Sync and history

- `~/Agent Room/` is a git repository. Every change, from the app, the orchestrator, the hub or a text editor, is one commit whose author records who made it (`owner`, `orchestrator`, `hub`, `<agent-id>`) and whose message says why. The app can revert any commit.
- The hub watches the folder. An edit in a text editor is validated, committed and loaded within a few seconds. An edit in the app is written to the file first and then follows the same path, so there is one way in.
- A file that fails validation isn't loaded. The hub keeps the last good version, shows one notice in the app, and the linter says which line is wrong.

## 7. Linter

Runs on every change and on demand. It **blocks** loading when:

- front matter is malformed, `kind` is unknown or doesn't match the file's place, a required field is missing, or `schema` is newer than the hub knows
- a file is over its cap
- a `ROOM.md` roster names an unknown agent, or a goal folder doesn't match `GOAL.md`'s `id`

It **flags** (loads the file, tells the owner) when:

- a narrower layer tries to loosen a broader one (for example `ROOM.md` setting `shell: on` where `POLICY.md` says `ask`): the looser line is ignored
- two `POLICY.md` rules have opposite effects on the same match
- a room `MEMORY.md` fact contradicts another, or has expired
- a lease is past its expiry
- a file in the folder isn't in this spec

---

**For owner approval.** Open points: (1) the 24 KB context cap; (2) learned `POLICY.md` rules applying only after an explicit accept (proposed: yes); (3) moving agent runtime settings out of the database into `TOOLS.md` (proposed: yes, in 1.9, with a one-time migration).
