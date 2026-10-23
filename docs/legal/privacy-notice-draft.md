# Agent Room Privacy Notice

> **DRAFT: needs legal review.** A plain-language statement of what the product does today, written from the code. A lawyer must check it against the laws that apply ([GDPR, UK GDPR, CCPA/CPRA and others, depending on where users are]) before it is published. Square brackets are blanks. If the product changes what it sends, this text must change in the same release (`docs/release.md` has the checklist).

Version: draft 1, October 23, 2026. For Agent Room [1.0.0].

## The short version

- Agent Room runs on your Mac. Your goals, messages, files, memory, documents and logs stay on your Mac.
- We have no accounts, no sign-up and no server that holds your content.
- We receive nothing by default. Two things can send us small reports, **both off until you turn them on**, and only if the build has an address to send them to.
- Agents you use (Claude Code, Codex and others) receive what you and the Room send them, under their providers' privacy terms, not ours.

## What stays on your Mac

Everything the Room keeps: the database in `~/.agent-room`, your control files and library in `~/Agent Room`, task folders, the audit log and the hub's log. You can read, export and delete all of it. Deleting the app and those two folders removes it.

## What the agents you use receive

When a task runs, the Room sends the task and the context it needs (your instructions, the relevant memory, files from folders you granted) to the agent chosen for it. That agent's own program sends it on to the provider (for example Anthropic or OpenAI) over the agent's own connection, under that provider's terms and privacy policy. You sign in to each agent yourself; the Room never sees, stores or sends your passwords, tokens or keys. Read the providers' policies: [links to be confirmed at publication, see `ProviderTerms.tsx`].

Agents on your own devices (for example one on another computer on your Tailscale network) reach the hub over that private network. Cloud agents reach only the hub's `/mcp` address, and only if you switch on Tailscale Funnel; every call needs a key you made.

## What can leave your Mac that is ours

| What | When | What it holds | Off by default? |
|---|---|---|---|
| **Update check** | Once a day, if the build has an update address | A request for the update list. The request carries your Agent Room version in its user agent, and your IP address reaches whoever hosts the file | **On** (you can turn it off in Settings, Privacy and updates). It sends no content and no identifier |
| **Crash reports** | After the hub crashes, at its next start | Error class and code, where in the code it happened (function and file names), Agent Room, Node and macOS versions, platform, how long it ran. **Never** prompts, messages, file contents, names, folder names outside the home folder, keys, tokens or emails. Paths under your home folder appear as `~`. Error messages are left out except for built-in system and JavaScript errors, with quoted text removed | **Yes, off** |
| **Usage counts** | One batch a week, the first a week after you turn it on | Agent Room version, macOS version, how many agents of each kind you have (such as "claude-code: 1"), how many goals you started on each of the last 7 days, the share of finished tasks you accepted, and how many crashes there were. **Never** names of anything, text, paths, prompts, emails, tokens, or any id that identifies you or your Mac | **Yes, off** |

Crash reports and usage counts go only to the address in your build of the app, shown in Settings (it shows the host). If the build has no address, which is the default, nothing can be sent even with the switch on, and Settings says so. "See what would be sent" in Settings shows the exact data. macOS's own crash reports for Agent Room are only listed, never sent.

## Why, and how long we keep it

[To decide with a lawyer: purposes (fixing crashes, knowing which versions and macOS releases to support, whether features are used), lawful basis (consent, for the two switches), retention (suggested: crash reports 90 days, usage counts 24 months), where stored, who can access, and any processor used for the receiving service.]

## Your choices and rights

You can turn each switch off at any time; nothing already sent is linked to you, because it carries no identifier, so there is nothing to look up or delete. [Lawyer: confirm this reasoning, and add the rights and the contact route required where users live.] Deleting the hub's crash reports from Settings removes the copies on your Mac.

## Other services you may choose to use

- **Tailscale** connects your phone and other devices to your Mac. It has its own account and privacy policy.
- **ntfy** (optional phone alerts, if you set a topic) is a third-party service that would see the alert text. Leave it off to avoid that.
- **Our website** [and download host] may log requests (address, time, page) as web servers do. [Detail once decided.]

## Children

The product is not meant for children under [13/16]. [Lawyer to confirm.]

## Changes

If we change what the product sends, we will update this notice and say so in the app before the change applies. Anything new that sends data will be off until you turn it on.

## Contact

[Company name, address, privacy contact email.]
