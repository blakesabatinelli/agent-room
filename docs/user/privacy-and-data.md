# Privacy and data

The short version: your work stays on your Mac, and Agent Room sends nothing to us unless you turn something on.

## What stays on your Mac

- Your goals, messages, files, memory, documents, scores and logs.
- The database and runtime files in `~/.agent-room`, and your control files and Library in `~/Agent Room`.
- There are no accounts and no sign-up.

You can read, copy and delete all of it. Deleting the app and those two folders removes everything.

## What the agents receive

A task and the context it needs go to the agent chosen for it: your instructions, relevant memory, and files from folders you granted. That agent's own program sends it to its provider (for example Anthropic or OpenAI), under their privacy terms. You sign in to each agent yourself. Agent Room never sees, stores or sends your passwords, tokens or keys.

Agents on your own devices reach the room over your private Tailscale network. A cloud agent can reach only the hub's `/mcp` address, and only if you switch on Tailscale Funnel in Settings, Remote access. Every call needs a key you made.

## Updates

The app checks once a day for a new version. It fetches one list file and sends your Agent Room version in the request. It sends no content. Turn this off in **Settings, Privacy and updates**.

## Crash reports (off)

If the hub crashes, it writes a small report to `~/.agent-room/crashes/` on your Mac. It holds where in the code it failed, the Agent Room, Node and macOS versions, and how long it had run. It never holds prompts, messages, file contents, names, keys or emails, and paths under your home folder show as `~`.

Those reports leave your Mac only if you turn on **Send crash reports** and the app has an address to send them to. Otherwise they stay local. Delete them any time in Settings.

macOS also keeps its own crash reports for Agent Room. Settings lists them. They are never sent.

## Usage counts (off)

If you turn on **Share usage counts**, once a week the app sends one small batch of counts, the first a week after you turn it on. It holds exactly these fields:

- the Agent Room version and the macOS version;
- how many agents you have of each kind (for example claude-code: 1, codex: 1), with no names;
- how many goals you started on each of the last 7 days;
- the share of finished tasks you accepted;
- how many crashes there were.

It has no names, text, paths, prompts, emails, tokens, or any id that could identify you or your Mac. **See what would be sent** in Settings shows the exact data before anything leaves.

## No address, nothing sent

Crash reports and usage counts need two things: your switch, and an address built into the app. If the app has no address (the default for builds that are not releases), Settings says so, and nothing can be sent even with the switch on.

## Other services you may use

- **Tailscale** has its own account and privacy policy.
- **ntfy** phone alerts, if you set a topic, go through ntfy's server and would show it the alert text. Leave it unset to avoid that.

## Full texts

The privacy notice and licence terms are drafts until the owner publishes the final ones. They are linked from Settings, About, once they are final.
