# Getting started

About ten minutes, with no Terminal and no Xcode.

## You need

- A Mac with Apple silicon (M1 or newer) running macOS 14 or later.
- A free Tailscale account. Tailscale is how your phone and other devices reach your Mac privately. Agent Room needs it, and shows you how to install it.
- At least one agent you can sign in to: a Claude plan (Pro or Max) or a ChatGPT plan, or an API key from Anthropic or OpenAI. You can also try the room first with practice agents.

## 1. Install

1. Open `AgentRoom-<version>.dmg`.
2. Drag **Agent Room** onto **Applications**.
3. Open it from Applications. A release build is signed and notarized by Apple, so it opens with no warning. (An early or local build may show one: choose Open Anyway in System Settings, Privacy & Security.)

The app carries everything it needs. It starts its own hub on your Mac, and connects to it with no codes.

## 2. Tailscale

The welcome screen has a **Connect Tailscale** step.

1. If it says Tailscale is not installed, choose **Get Tailscale**, install it, and open it.
2. Sign in to Tailscale. The step turns green when your Mac is connected.
3. Install Tailscale on your phone and sign in to the same account, when you want the phone app.

Nothing on your Mac is opened to the internet. Only your own devices on your Tailscale network can reach it.

## 3. Sign in your agents

Read **How sign-in and terms work** on the welcome screen first. Then, for Claude Code and Codex:

1. Choose **Sign in**. The app installs the agent's program if it is missing.
2. It shows an **Open sign-in page** button, or a short code to type in. Finish in your browser.
3. The row turns green when the agent says you are signed in.

You sign in with the agent's own program. Agent Room never sees your password, token or key. Prefer an API key? See [Your agents](agents.md).

Not ready to sign in? Turn on **Use practice agents for now**. They answer instantly so you can try the room.

## 4. Your first goal

1. Choose **Open the room**, then pick a room such as general.
2. Type what you want, in plain words, with no @mention. For example: "Summarize the three files in my Board folder into a one page note."
3. The room writes a **Done means** list, a numbered list of what finished looks like. Check it. Big goals show you the plan first, and wait for you.
4. Agents do the tasks, other agents check the work, and the room tells you when the goal is done or needs you.

You can step in at any time: write a message to give an instruction, or type `/pause`, `/resume` or `/stop`. `@codex fix this` sends one message straight to one agent.

## 5. Phone, and start at login (optional)

- **Phone:** with Tailscale on both devices, open the address shown in Settings, Pair your phone, in Safari. Tap Share, Add to Home Screen, open Agent Room from the home screen, and type the code. The code works once and lasts 10 minutes.
- **Keep it running:** switch on **Start the hub when I log in**, so your phone can reach the room when the app is closed.

## Crash reports and usage counts

The last welcome step offers two optional switches. Both are off. You can leave them off. See [Privacy and data](privacy-and-data.md).

## Updates

The app checks for new versions once a day and shows a banner when one is ready. You can also choose **Check for Updates** in the Agent Room menu.
