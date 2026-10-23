# Memory and control files

## Memory

The room remembers what matters, so you do not repeat yourself.

- **Private notes:** each agent keeps its own.
- **Shared memory:** agents propose facts and the orchestrator decides. What it cannot decide waits for you in **Memory** in the sidebar.
- **Facts expire.** Each fact has a source (a goal, you, or an agent) and an expiry. Expired facts stop reaching agents and stay for 30 days, then go. Choose **Still true** to renew one.
- **Contradictions:** if new evidence disagrees with a fact, you get one question in Approvals with three answers: keep the old, take the new, or both are wrong.
- **Sent back out:** shared memory is written into each agent's own context file (`CLAUDE.md`, `AGENTS.md`, Hermes's memory file) so it carries what the room knows. This is **off** for each agent until you switch it on, it stays within a size limit, and it sits between clearly marked lines. The original file is saved once.

## Control files

The rules that steer agents are plain Markdown files in a visible folder, `~/Agent Room`. Open them in any editor. The app's settings edit the same files.

| File | What it does |
|---|---|
| `AGENTS.md` | Rules for every agent in every room |
| `USER.md` | Who you are and how you like to work |
| `POLICY.md` | Approval rules and permission defaults |
| `agents/<agent>/SOUL.md` | An agent's name, colour and voice |
| `agents/<agent>/RESUME.md` | What an agent has proven good and bad at (written by the room) |
| `agents/<agent>/LESSONS.md` | Lessons learned, by kind of task |
| `rooms/<room>/ROOM.md` | A room's purpose, who works there, tools it narrows, folders it may use, and an optional schedule |
| `rooms/<room>/MEMORY.md` | The room's shared memory |
| `goals/<goal>/` | The ask, the progress ledger and the decisions for one goal |
| `Library/` | Documents agents save, as Markdown with front matter |

- The folder is a git repository, so every change is kept. In **Settings, Control files** you can see recent changes and **Undo** one (it adds a new change that reverses it). **Check files** reports problems, such as a misspelled file name.
- If you delete a file the room writes itself (`RESUME.md`, `LESSONS.md`, `LEDGER.md`), it makes it again.
- `Library/` is not in the repository, because documents can be large or synced by something else. Point it at a Google Drive for Desktop folder if you want them in Drive.

## Standing rooms

A `ROOM.md` can hold a schedule (five-field cron), a standing goal, a time zone and a catch-up window. The room then starts that goal for you, for example "Monday 8:00: summarize last week's board notes". It skips a run if the last is still going, and it runs a missed one once after your Mac wakes, within the catch-up window.

## Export

Everything is a plain file you own. Copy `~/Agent Room` and `~/.agent-room` to back it up or move to another Mac.
