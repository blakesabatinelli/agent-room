# Owner to-do

Everything in the plan that could be built without you is built and tested (hub 855 tests, relay 12, typecheck green in all four packages). What is left needs your decision, your accounts, or a real Mac. In rough order.

## 1. Decisions (DECISIONS.md)

| ID | What | Build's recommendation |
|---|---|---|
| D1 | How agents get local file access | Hub MCP file tools for every agent; vendor-cloud agents reach only `/mcp` through Tailscale Funnel. Built on it |
| D2 | Document source of truth and format | Markdown with front matter in the Library. Built on it |
| D3 | Where control files live | `~/Agent Room`, git-backed. Built on it |
| D4 | Distribution channel | Direct download (Developer ID + Sparkle), not the Mac App Store: the hub spawns CLIs, which the App Store sandbox forbids. 4.7 is built this way |
| D5 | Provider terms posture | Send the OpenAI "Sign in with ChatGPT" partner application and ask Anthropic for written approval before 1.0. Onboarding copy already cites both |
| D6 | Business model | Yours. Licence drafts (MIT/Apache vs EULA) are in `docs/legal/` |
| D7 | 3D office tech | three.js in a web view, 2D fallback. Built on it |
| D8 | Subagent limits | Depth 2, budget 6 per goal. Built on it |

Decided since: minimum macOS is 14 (D10, Oct 24).

## 2. Sign-offs
- `CONTROL.md` (the control-file spec).
- 3.1 design screenshots: `docs/screenshots/3.1-*` and the QA set `docs/screenshots/qa-*` (light and dark).
- 0.1 Mac app screenshot (the nested shell setting).

## 3. Accounts and services
1. GitHub remote: run `scripts/setup-remote.sh` (B1).
2. Apple Developer Program; a "Developer ID Application" certificate in your keychain.
3. `xcrun notarytool store-credentials <name>` with an app-specific password.
4. Sparkle 2: `generate_keys`, back up the private key, keep the public key.
5. Public URLs: DMG, `appcast.xml` (https), and, only if you want crash/telemetry uploads, a report endpoint and a collector (none is built; both switches are off by default).
6. Legal review of `docs/legal/*` drafts; add `LICENSE`; set `final: true` and the URLs in `packages/app/src/legal.ts`.
7. Test hardware (K4): one 8 GB and one 32 GB+ Apple silicon Mac, plus a clean macOS user account.

Full release steps: `docs/release.md`.

## 4. Checks only a real Mac can do
- Xcode builds of the Mac and iOS apps; `pod install` (react-native-webview; Sparkle with `AGENT_ROOM_SPARKLE=1`). Every Mac screen added this week (approval rules, fork view, two-key card, night-shift switch, office, personas) is typechecked only.
- `scripts/package-mac.sh` and `--release --preflight`; the clean-account install timing test in `docs/install-test.md` (DMG to first finished goal under 10 minutes, Tailscale sign-in included).
- Live confinement with real Claude Code and Codex: `docs/security/1.1-checklist.md` "Verify on a Mac" item 9. Claude Code file tools now all go through the hub's approval prompt (no allow rules), so confirm real work runs with no cards and at normal speed.
- Codex flags added by the security fixes (`-c mcp_servers={}`, `-c notify=[]` on helper calls): confirm a planner/judge call starts.
- Tailscale Funnel live: only `/mcp` reachable from outside (`docs/1.2-remote-access.md`).
- Two-key with two real vendors: ask for an email send, read both drafts on the card, in dark mode with long bodies.
- Night shift on real quota: turn it on in Settings, check the morning digest line.

## 5. Known gaps
- Reviews were by other models of the same vendor; the plan's cross-vendor review (Codex) is still owed for 1.1 and 4.1.
- Fork preferences are recorded but routing doesn't read them yet (the plan didn't require it).
- The shell scanner in two-key is a heuristic second layer; the real boundary for local agents is the sandbox and the task worktree.
