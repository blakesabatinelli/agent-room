# Troubleshooting

## The app says it could not start

The hub did not start. Choose **Try again**. If it keeps happening, quit Agent Room and open it again. The hub's log is `~/.agent-room/hub.log`. If the hub crashed, a report is in `~/.agent-room/crashes/`.

## macOS warns that the app cannot be opened

A release build is notarized and should open normally. If you see a warning anyway, check the app came from the download page and the DMG's checksum matches the one published next to it (`shasum -a 256 AgentRoom-<version>.dmg`). An early or local build is signed only for the Mac that made it: choose Done, then Open Anyway in System Settings, Privacy & Security (macOS 15 and later), or right-click the app and choose Open (macOS 14 and earlier).

## An agent will not sign in

- Choose **Log** next to it on the welcome screen to see what its program printed.
- Claude Code may ask you to paste a code back: paste it into the box the app shows.
- If the sign-in page does not open, use the link or code the app shows, in any browser.
- If the browser's sign-in cannot reach your Mac, the app falls back to a code you type in.
- **Open in Terminal** runs the agent's own sign-in there instead.
- An agent whose program is missing is installed for you first. If that fails, install the program yourself and choose **Check again**.

## An agent says it is signed in but work fails

Check you are not out of plan limits (Settings, Subscriptions shows each plan's windows). Work stops going to a plan that is at its limit. Check also whether `ANTHROPIC_API_KEY` is set to a key from a disabled account: Claude Code uses a key it was told to use before your plan. Unset it to fall back to your plan.

## Tailscale will not connect

The step shows what is wrong: not installed, turned off, or needs sign-in. Choose **Open Tailscale to sign in**. If Tailscale is connected but the phone cannot reach the Mac, both devices must be signed in to the same Tailscale account, and the phone must have Tailscale on.

## The phone will not pair

The code works once and lasts 10 minutes. Get a new one in Settings, Pair your phone. Open the address from the home-screen icon, not in Safari: iOS keeps their sign-ins separate.

## A goal is stuck

Type `/pause` then `/resume`, or `/stop` to end it. A goal that has used its budget of task runs pauses and asks you a question: answer it in the room. If the hub restarted mid-goal, work picks up where it left off (Settings, Pick up work after a restart).

## An approval is waiting but I was not told

Open **Approvals** in the sidebar. During the day the room only interrupts you for a few things, and the rest wait for the digest. Change the daily cap in Settings. For phone alerts when the app is closed, set an ntfy topic.

## "Check for Updates" does nothing, or no banner

This build may have no update address (builds that are not releases do not). In a release build, make sure your Mac is online. A banner appears when the update list offers a newer version than yours.

## Crash reports will not send

By design they need your switch and an address built into the app. Settings, Privacy and updates says which is missing. See [Privacy and data](privacy-and-data.md).

## Start over

Quit Agent Room. Move `~/.agent-room` somewhere else, and open the app again for a fresh start. Your control files and Library in `~/Agent Room` are not touched. Put `~/.agent-room` back to return.

## Still stuck

Send the owner the last 50 lines of `~/.agent-room/hub.log`. It holds no passwords or keys.
