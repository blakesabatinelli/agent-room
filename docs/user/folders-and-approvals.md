# Folders and approvals

Agents work only where you let them, and risky steps wait for you.

## Folders

Agents do not get your whole disk. You grant folders, one at a time, in **Folders** in the sidebar.

1. Choose **Add**, and pick a folder with the chooser.
2. Choose who it is for (one room or all, one agent or all) and what is allowed: **read**, **write**, or both. They are separate switches.
3. The app checks the folder first. Some folders are protected (anything starting with a dot in your home folder, Library, system folders, the hub's own data). A protected folder needs **Grant anyway** and a written reason, and the choice is logged.

To work on a folder, pick it under **Work in folder** when you write a goal.

- **Git repositories:** the work goes on a separate branch named `agent-room/<goal>`. Your own checkout is never touched.
- **Other folders:** each task's changes come back to you as one approval with every file's full change shown.
- **Read-only folders:** nothing is written back.

## Approvals

Open **Approvals** in the sidebar, or on your phone. A badge shows how many are waiting.

- **File changes:** you see a diff for every file, and the files that will not be written, with the reason. Approve or reject. A change that cannot be applied can only be rejected.
- **Risky actions:** things like sending email or running a shell command, depending on **Permissions**.
- **Questions:** when judges disagree, or the room needs a decision, or facts in memory contradict each other.

Nothing in an approval is changed by the agent after you read it: you approve exactly what you saw.

## Permissions

**Permissions** in the sidebar sets what each agent may use: web, files, shell, Gmail, Slack, Drive and Salesforce. Switch an agent's tool off and the room never gives it that tool. The room can only narrow what an agent has on its own platform. It can never give an agent more.

A room can narrow things further (see [Memory and control files](memory-and-control-files.md), ROOM.md). A tool set to `ask` always asks, even if auto-approve is on.

## The audit log

Everything is written to the activity log in **Settings**: grants, approvals, key changes, sign-ins, privacy switches. It is yours to read.

## Interruptions

During the day the room interrupts you only for a disagreement or a decision it needs. The rest waits for the evening digest. You set the daily cap and quiet hours in Settings. See [The digest, scorecard and ledger](digest-and-scorecard.md).
