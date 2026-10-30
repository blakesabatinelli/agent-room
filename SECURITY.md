# Security

How Agent Room keeps agents inside what the owner allowed, what the tests prove, and what is still open.
Detailed checklists: `docs/security/1.1-checklist.md` (file access), `docs/security/4.1-checklist.md` (two-key), `docs/1.2-remote-access.md` (Tailscale and Funnel).

Report a problem privately to the owner. Do not open a public issue.

## Threats this design assumes

1. **Prompt injection through content.** A web page, email, CRM note, chat message or another agent's output tells an agent to act.
2. **A cloud agent reaching local files** beyond the folders the owner granted.
3. **The public endpoint.** Funnel exposes the hub's `/mcp` path to the internet.
4. **Persuading the judges or poisoning memory**, so bad work is accepted or a false "fact" steers later tasks.
5. **Theft of what is on disk**: the database, tokens, the audit log.

## Controls

| ID | Control | Where | Test |
|---|---|---|---|
| S1 | **Taint per task.** A run that could read untrusted content (web, Gmail, Slack, Drive, Salesforce, an MCP or ACP agent, an A2A goal) is tainted from its start, and so is every later task in its goal. A tainted run loses "run without asking". Every sensitive action it asks for becomes an owner card, even when POLICY.md allows it or two-key drafts match. A policy deny still refuses. | `src/security/taint.ts`, `Orchestrator.requestApproval`, `Orchestrator.call` | fixture 1, 1b |
| S2 | **Funnel hardening.** Proxied callers authenticate with a per-client key (hashed, expiring, revocable) before any tool is listed. Failed auth is rate-limited per forwarded IP. Write, spawn and save tools are left out of `tools/list`, and a `tools/call` naming one gets 403 and is audited. Any foreign `Origin` gets 403. Proxied bodies are capped at 1 MB. | `src/api/server.ts`, `src/mcp/server.ts` (`FUNNEL_BLOCKED_TOOLS`), `src/remote/guard.ts` | fixture 8, `remote.test.ts` |
| S3 | **File escapes.** Paths are resolved with realpath. Final symlinks aren't followed (`O_NOFOLLOW`), hard links aren't read, `.git` is never written, lookalike Unicode is refused, and writes go to a temp file then rename. The data folder, system roots and the control files (`AGENTS.md`, `USER.md`, `POLICY.md`, `agents/`, `rooms/`, `goals/`, `playbooks/`) can't be granted, and neither can a folder containing them. The Library can. | `src/files/paths.ts`, `src/files/broker.ts` | fixtures 3, 4, 5 |
| S4 | **CLI confinement.** Claude Code runs with its Bash sandbox (home and data folder unreadable, task folder writable) and every file tool goes through the hub's check. Codex runs under `--sandbox workspace-write` with no extra writable roots. Command agents (Hermes) run under `sandbox-exec` on macOS: writes only to the task folder, temp and `settings.writablePaths`, and no reads or writes of the data folder, the control files or other CLIs' credentials. Every spawn's environment loses the hub's secrets and other vendors' API keys. | `src/files/confine.ts`, `src/security/sandbox.ts`, `src/security/env.ts` | fixture 6 (the enforcement half runs on macOS only) |
| S5 | **Per-task identity.** Each run gets an MCP grant locked to its agent, room, task and folder, valid for 2 hours and removed when the run ends. | `Orchestrator.grantFor` | fixture 9 |
| S6 | **Secrets at rest.** MCP keys and device tokens are stored as SHA-256 hashes; devices paired before this change are migrated on start. Devices can be revoked (`DELETE /devices/:id`). The data folder is 0700. Pairing codes rotate, are single-use and are throttled. | `src/mcp/tokens.ts`, `src/db/store.ts`, `src/main.ts` | fixture 10, S6 tests |
| S7 | **Memory and judges.** A memory proposal that reads like an instruction is held for the owner and the keeper's model never sees it. A task output that addresses its reviewers can't be accepted: its score is held at 0.3 or below and the worker is told why. Personas are stripped before judging. | `src/security/injection.ts`, `src/memory/keeper.ts`, `Orchestrator.injectionGuard` | fixtures 2, 7 |
| S8 | **Audit integrity.** The audit log is append-only (SQLite triggers refuse UPDATE and DELETE) and hash-chained. `GET /security/status` reports whether the chain verifies and, if not, the first broken row. | `src/db/store.ts` (`verifyAudit`) | S8 test |
| S9 | **Two-key.** Drafts are compared on structure (recipients, subject, record, files), not free text. | `src/twokey/` | `twokey.test.ts` |
| S11 | **Supply chain.** CI installs with `--frozen-lockfile` and fails on any critical `pnpm audit` finding. | `.github/workflows/ci.yml` | CI |
| S12 | **Data boundaries.** Night shift never re-runs on another vendor a task that touched mail, chat, Drive or CRM data, unless `nightShift.allowLabeledData` is on. | `src/nightshift/service.ts` | (covered by fixture 1b's label check) |

## Known gaps

- **Taint is decided by capability, not by what was actually read.** The hub can't see what Claude Code's own WebFetch returned, so any run with web enabled is treated as tainted. That means more approval cards. Narrow this only with evidence from real runs.
- **The command-agent sandbox hasn't been run against real Hermes.** Hermes will probably need `writablePaths: ["~/.hermes"]` set on the agent.
- **No OAuth on Funnel.** Remote callers use per-client bearer keys. claude.ai custom connectors may require OAuth 2.1 before they can connect.
- **Proxy detection is a denylist** (`src/remote/guard.ts`). A local forwarder that adds no proxy marker looks like the Mac itself. Only `Origin` is checked, not `Host`.
- **The injection detector is a heuristic**, a second layer. S1 is the boundary for actions.
- **Labeled data still reaches cross-vendor judges.** S12 covers night shift only.
- **Open dependency findings (high):** `zod` 3 (fix is the major upgrade to 4.6.6) and `image-size` (via React Native tooling). CI blocks at critical until these are fixed.
- **A revoked device's open websocket** stays connected until it reconnects.
- **Reviews so far were by the same vendor.** The cross-vendor review the plan calls for is still owed for 1.1, 4.1 and this change.
