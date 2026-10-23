# Install test: DMG to first finished goal, on a clean account

Item 1.7, acceptance criterion 4. On a clean macOS user account, going from the DMG to a first finished goal takes **under 10 minutes**, with **no Terminal and no Xcode**, Tailscale sign-in included. You run this; this page is the script and the timing sheet.

- **Start the stopwatch:** you double-click the DMG.
- **Stop the stopwatch:** the first goal shows **done** in the room.
- **Pass:** 600 seconds or less, and nobody opened Terminal, Xcode or a text editor to get there.
- Run it at least three times on each test Mac (K4: one 8 GB Apple silicon Mac, one with 32 GB or more) and report the median and the worst run.

The app also keeps its own clock. The hub writes `setup.started` the first time it starts (the first launch of the app) and `setup.first_goal_done` when the first goal finishes. `GET /setup` returns `elapsedSeconds`, the onboarding screen shows "Setup time so far", and Settings > Setup shows the final number. The in-app clock misses everything before the first launch (drag, first-open warning), so the **stopwatch is the official number**; the in-app number cross-checks it.

## Before you start (not timed)

1. **A clean account.** System Settings > Users & Groups > Add User: a new Standard (or Administrator) user. Log in as that user. It must not have Tailscale, Claude Code, Codex, Homebrew, Node or Xcode command-line tools set up for it. (Tailscale installed system-wide by another account counts as not clean: remove it first.) Skip the Apple ID question and the setup assistant extras; the account just has to reach the desktop.
2. **Accounts at hand.** The Tailscale login (and the phone or key for its 2FA), a Claude plan login, a ChatGPT plan login. Have the second-factor device unlocked next to you. Time spent waiting on a code does count, because a real user waits too.
3. **The DMG arrives the way a user's would.** Send it to the test account by AirDrop or download it from a link, so macOS marks it as downloaded. A copy from a USB stick or `cp` has no quarantine mark, skips the first-open warning, and is not a fair test. Do not clear the mark.
4. **Normal Wi-Fi.** Note the network and, if you can, a speed test result.
5. **Record the screen** (Shift-Command-5). It settles disputes about where the time went.
6. **Plain settings.** Practice mode off. Firewall at its default.
7. Fill in the "Run details" block below.

## The script

Press **Lap** on the stopwatch at each ">>" line. Expected screens are in the order you should meet them.

### 1. Open the DMG  `>> T0: start`
Double-click `AgentRoom-<version>.dmg`. macOS may check it for a few seconds. A window opens showing **AgentRoom** and an **Applications** shortcut.

### 2. Drag to Applications  `>> T1`
Drag AgentRoom onto Applications. The copy takes a few seconds. (Ejecting the disk image is optional and not needed for the test.)

### 3. First open: the unidentified-developer warning  `>> T2: the Agent Room window is on screen`
The app is signed with a local (ad-hoc) signature, not an Apple Developer ID, so macOS warns the first time. That is expected until item 4.7 (Developer ID and notarization). The way past it needs no Terminal:

| macOS | What you see | What to do |
|---|---|---|
| 15 Sequoia and later | A dialog saying Apple could not verify "AgentRoom". Buttons: Done, Move to Bin. | Click **Done**. Open **System Settings > Privacy & Security**, scroll to **Security**, find "AgentRoom was blocked to protect your Mac", click **Open Anyway**, authenticate (password or Touch ID), then click **Open Anyway** again in the dialog that follows. |
| 14 Sonoma and earlier | A dialog saying "AgentRoom" cannot be opened because the developer cannot be verified. | Click **Cancel**. Control-click (or right-click) the app in Applications, choose **Open**, then **Open** again. |

Record the macOS version, which path you took, and how long the warning took to get past. Control-click Open no longer works on macOS 15, so tell testers on 15 to go straight to Privacy & Security.

Other first-launch prompts to expect or note: a firewall prompt ("accept incoming network connections" for `node`) only if the firewall was turned on. Anything else, write it down.

### 4. The welcome screen
The app starts its hub on its own (no codes). Within a few seconds the **Welcome** screen appears with: 1. Sign in your agents, 2. Connect Tailscale, 3. Connect your phone (optional), 4. Keep it running. If it shows an error instead, open `~/.agent-room/hub.log` from Finder (Go > Go to Folder) and copy the last lines into the notes. That is a failed run.

The three steps below can go in any order. The fastest order is usually Tailscale download first (it is the longest download and install), then agents while it installs.

### 5. Tailscale (step 2)  `>> T3: step 2 says Connected`
Step 2 says Tailscale isn't installed. Click **Get Tailscale**. The browser opens tailscale.com/download/mac. Download and install it the normal way, open it, sign in, and allow the system prompts (a VPN configuration and a network extension, in System Settings > Privacy & Security if macOS asks there). Switch back to Agent Room: step 2 turns to Connected on its own (it checks every few seconds), and step 3 shows the phone address and code. Use **Open Tailscale to sign in** if Tailscale is installed but asks for a login.

### 6. Claude sign-in (step 1)  `>> T4a: the Claude row says Signed in`
Click **Sign in** on the Claude row.
1. It says **Installing Claude Code** for under a minute the first time (nothing to click).
2. It then says "A sign-in page should open in your browser" and shows **Open sign-in page**. Use the button if no browser tab opened.
3. Sign in at claude.ai and approve. The browser says login succeeded. If the browser instead shows a code, paste it into the **Code from the browser** field in the app and click **Send code**.
4. The row turns to **Signed in as ...** by itself.

### 7. Codex sign-in (step 1)  `>> T4b: the Codex row says Signed in`
Click **Sign in** on the Codex row. It installs Codex, opens the ChatGPT sign-in, and turns to signed in. If the browser step fails or the port is busy, the app switches to a one-time code by itself, or click **Use a code instead**: open the page it shows and type the code. (Device codes must be switched on in the ChatGPT security settings, and a workspace admin may have to allow them.)

One signed-in agent is enough for the first goal. Sign in both and record both laps.

### 8. Open the room  `>> T5`
At the bottom of the welcome screen the app shows "Setup time so far m:ss". Click **Open the room**. The phone step and start-at-login are optional and outside the 10 minutes; time them separately if you do them.

### 9. The first goal  `>> T6: goal sent`, `>> T7: stop the stopwatch when it says done`
Send the same goal every run so runs are comparable:

> Write a one-page summary of what a place-based TV network is, for a bar owner. Save it as a document.

Approve the plan if the room asks. Wait until the goal reads **done** with its summary and the document appears. **That is the stop.**

### 10. Read the in-app clock
Settings > Setup shows "First goal finished m:ss after you first opened Agent Room". Write it down. `stopwatch - in-app` is the time spent before the first launch (steps 1 to 3).

## Timing sheet

Copy this block for each run.

**Run details:** tester ____ date ____ Mac model / RAM ____ macOS version ____ DMG name and SHA-256 (printed by `package-mac.sh`) ____ network ____ order used for steps 5 to 7 ____

| Lap | What | Stopwatch (mm:ss) | Since previous (s) | Notes |
|---|---|---|---|---|
| T0 | Double-clicked the DMG (start) | 0:00 | | |
| T1 | App dragged to Applications | | | |
| T2 | Past the first-open warning, window on screen | | | which macOS path? |
| T3 | Tailscale connected (step 2) | | | |
| T4a | Claude signed in | | | in-app install seconds? browser code needed? |
| T4b | Codex signed in | | | browser or one-time code? |
| T5 | "Open the room" clicked | | | |
| T6 | First goal sent | | | |
| T7 | First goal done (stop) | | | |
| | **Total (T7)** | | | pass if 600 s or less |
| | In-app `elapsedSeconds` | | | from Settings > Setup |

**Also record:**
- Terminal, Xcode or any editor opened at any point? (yes means fail, and say why)
- Every dialog, prompt or error you did not expect, with a screenshot time from the recording.
- Seconds spent waiting on a second factor, on a download, on an install.
- Whether any "Terminal instead" button was needed.
- Claude and ChatGPT plan types, Tailscale account type.
- Anything you hesitated over (the longest pauses in the recording).

## When something goes wrong

| Symptom | Look at | Likely cause |
|---|---|---|
| Welcome screen never appears, or says the hub didn't start | `~/.agent-room/hub.log` | The bundled Node didn't start (blocked by Gatekeeper, missing better-sqlite3 binary). Run `scripts/verify-dmg.sh` on the build Mac. |
| "AgentRoom is damaged and can't be opened" | | The DMG was altered in transit, or the signature broke. Rebuild, compare SHA-256. |
| Sign-in row says "Couldn't install it automatically" | Row's **Log** button, `~/.agent-room/signin-<agent>.log` | No network, or the vendor's installer address changed. Use "Sign in with Terminal instead" and note it as a failed run. |
| Sign-in page never shows, only "A sign-in page should open" | The log | The CLI printed no link headless. A browser tab should still have opened; if not, note it and use the Terminal fallback. This is the main thing to find out on the first real run. |
| Tailscale step stays on "needs sign-in" | Open Tailscale from the app | The system extension was not allowed in Privacy & Security. |
| Goal never starts | Agents screen | Signed in but not enabled, or practice mode left on. |

## Record the real sign-in output (once, by the owner)

The parser was built from the vendors' documentation and published samples, not from a live run (`packages/hub/test/fixtures/README.md` lists which). After the first timed run, in your own account, run `claude auth login` and `codex login --device-auth` once in Terminal, paste what each prints (replace any code with `XXXX-XXXX`), and have Claude replace the "reconstructed" fixtures with the real text and re-run `pnpm test`.

## How the pieces fit (for whoever debugs a run)

- The app: `AgentRoom.app/Contents/Resources/node` (official Node, SHA-256 checked at build time) runs `Resources/Hub/hub.mjs` directly. `HubLauncher.m` uses them when present and falls back to `run.sh` in the repo for Xcode runs.
- Sign-in: `POST /setup/signin/:agent` runs `claude auth login` or `codex login` (or `codex login --device-auth`) headless, reads the link or code from its output, and `GET /setup/signin/:agent` reports it. Doc sources are in `packages/hub/src/install/signin.ts`.
- Build and check on the build Mac: `bash scripts/package-mac.sh` (it ends by running `scripts/verify-dmg.sh`).
