# Releasing Agent Room 1.0 (item 4.7)

How to turn this repo into a signed, notarized, self-updating DMG, and what the owner has to supply. The scripts and code are built; the parts that need your Apple account, certificate, keys and a web address are marked **OWNER**. Parts that can only be run or proved on a Mac are marked **MAC**: they were written here but never run, and the first real run is their test.

Decisions this follows: D4 (Developer ID, outside the App Store), D5 (each CLI signs itself in; the Room never touches credentials), D6 (business model still open: nothing here takes payment).

## What exists, and what has been proved

| Part | Where | Proved here | Needs a Mac |
|---|---|---|---|
| Signing and notarization script | `scripts/package-mac.sh --release`, `scripts/verify-dmg.sh --release` | Fails clearly when settings are missing or placeholders; script syntax; the order of steps and flags (hardened runtime, timestamp, no `--deep`) by test | Everything that calls `codesign`, `xcrun notarytool`, `stapler`, `spctl` |
| Auto-update | Sparkle 2 in `AppDelegate.mm` behind `AR_SPARKLE`; `scripts/make-appcast.sh`; hub `GET /version` and the banner | `make-appcast.sh` output read back by the hub's appcast reader; the fixture; the banner's data | The Sparkle window, the update install, the EdDSA check |
| Crash reports | `packages/hub/src/distribution/` | Scrubbing, the crash files, off by default, no upload without switch and endpoint | The LaunchAgent restart after a crash; the macOS report list on a real Mac |
| Usage counts | same | The allow-list, the weekly timing, the exact preview | None |
| Licence drafts | `docs/legal/` | Present and marked draft | Legal review (OWNER) |
| Download page | `site/` | Renders in Chromium, makes no outside requests (`docs/screenshots/4.7-site.png`) | Publishing (OWNER) |
| User guides | `docs/user/` | Present, no em dashes | Read through by someone new |

## Order of work (OWNER)

1. **Join the Apple Developer Program** (developer.apple.com/programs, paid, per year). The plan has this in the first week of phase 4: approval can take days. It gives you a Team ID.
2. **Make a Developer ID Application certificate.** Xcode, Settings, Accounts, your team, Manage Certificates, plus, "Developer ID Application". It lands in your login keychain. Check: `security find-identity -v -p codesigning` lists `Developer ID Application: Your Name (TEAMID)`. That whole quoted name (or its SHA-1) is `AGENT_ROOM_SIGN_ID`. An "Apple Development" certificate will not do: it cannot be notarized.
3. **Store a notarization login.** Make an app-specific password at account.apple.com (Sign-In and Security), then:
   `xcrun notarytool store-credentials "agentroom-notary" --apple-id YOU@EXAMPLE.COM --team-id TEAMID --password APP-SPECIFIC-PASSWORD`
   The name you gave ("agentroom-notary") is `AGENT_ROOM_NOTARY_PROFILE`. The password lives in your keychain, never in this repo.
4. **Make the Sparkle signing keys.** Sparkle verifies every update with an EdDSA signature, separate from Apple's. After one `AGENT_ROOM_SPARKLE=1 pod install` in `packages/app/macos`, run `Pods/Sparkle/bin/generate_keys`. It puts the private key in your login keychain and prints the public key (44 characters, ends in `=`): that is `AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY`. **Back the private key up** (`generate_keys -x file`, keep the file somewhere safe and offline). If you lose it, no installed copy can ever be updated, and users must download a new DMG by hand.
5. **Pick where files will live** (a bucket, a static host, or your own site): one address for `appcast.xml` (`AGENT_ROOM_FEED_URL`, https) and one for each DMG. The address of the appcast is built into the app, so choose one you will keep for years.
6. **Optional: a report address** for opt-in crash reports and usage counts (`AGENT_ROOM_REPORT_URL`, https). Leave it unset and the app can send nothing at all. See "The report endpoint" below.
7. **Legal review** of `docs/legal/` (see `docs/legal/licence-options.md`), then choose a licence, add `LICENSE` yourself, and set the final addresses in `packages/app/src/legal.ts`.
8. **Provider terms** (also first week of phase 4): send OpenAI the "Sign in with ChatGPT" partner application and ask Anthropic in writing whether this use is approved. Until they answer, the app's onboarding says what it says today (`ProviderTerms.tsx`); if either says no, that provider moves to API keys only (the risk register's row).
9. **Set VERSION** to `1.0.0` (the release build refuses anything that does not start with x.y.z), commit.
10. **Build.** On an Apple silicon Mac with Xcode, pnpm and CocoaPods:

```
export AGENT_ROOM_SIGN_ID="Developer ID Application: Your Name (TEAMID)"
export AGENT_ROOM_NOTARY_PROFILE="agentroom-notary"
export AGENT_ROOM_FEED_URL="https://downloads.example.com/agent-room/appcast.xml"
export AGENT_ROOM_SPARKLE_ED_PUBLIC_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="
# optional: export AGENT_ROOM_REPORT_URL="https://reports.example.com/ingest"
bash scripts/package-mac.sh --release --preflight    # checks the settings, the identity, the notary login. Builds nothing.
bash scripts/package-mac.sh --release                 # 20 to 40 minutes, most of it Xcode and Apple's notary service
```

11. **Sign the update feed and publish.**
    `bash scripts/make-appcast.sh build/mac/AgentRoom-1.0.0.dmg https://downloads.example.com/agent-room/AgentRoom-1.0.0.dmg --notes notes.html`
    Upload the DMG and `appcast.xml`. Put the DMG's address in `site/index.html` (the download button) and publish the `site/` folder.
12. **Test on a clean Mac account** with `docs/install-test.md`: the first open should show no Gatekeeper warning. Then run the update test below.

## What `--release` does (MAC)

1. Refuses to start unless the four settings are present and sane, `VERSION` is x.y.z, and (on a Mac) the identity is a Developer ID Application one and the notary login works.
2. Builds the hub and Mac app as for a local build, but with the Sparkle pod (`AGENT_ROOM_SPARKLE=1 pod install`) and `AR_SPARKLE=1` so the updater is compiled in. It checks the app's bundle id is `com.agentroom.app` and that `Sparkle.framework` is inside.
3. Writes `SUFeedURL`, `SUPublicEDKey` (and `AgentRoomReportURL`, if set) into the built app's Info.plist.
4. Signs inside out, each with the hardened runtime and a secure timestamp, never with `--deep`: native code under `Hub/` (better-sqlite3's addon), then `node` with `NodeRuntime.entitlements`, then Sparkle's helpers, XPC services and framework, then the app with `AgentRoom.entitlements`.
5. Zips the app, submits it with `xcrun notarytool submit --wait`, prints Apple's reasons if it is not accepted, then `xcrun stapler staple` and `spctl --assess` on the app.
6. Puts the stapled app in the DMG, signs the DMG, notarizes and staples it, and checks `spctl --assess` on it.
7. Runs `scripts/verify-dmg.sh --release`: Developer ID authority, hardened runtime, timestamp, one team on the app, node and the addon, the bundle id, Sparkle present, no placeholder feed address or key, both tickets stapled, Gatekeeper accepts both, and the hub boots on the bundled node under the hardened runtime.

The bundle id changes from the old `org.reactjs.native.AgentRoom` to `com.agentroom.app`. The LaunchAgent label is `com.agentroom.hub`, so the two share the `com.agentroom.` prefix (a test keeps `HubLauncher.m`, `Setup.command` and `scripts/install-hub-launchagent.sh` on the same label). A new bundle id means the app's saved settings start fresh once: the Mac app pairs with its own hub again without a code, so this is invisible to users.

## Entitlements (and why)

The app is **not sandboxed** on purpose (D4): it starts the user's own CLIs and reads folders the user grants, both blocked by the App Store sandbox.

| File | Key | Why |
|---|---|---|
| `AgentRoom.entitlements` (the app) | `app-sandbox` false, `network.client` true | The app talks to the hub on 127.0.0.1 and Sparkle reads the appcast. **No** `allow-jit`, **no** `disable-library-validation`: only node needs those. |
| `NodeRuntime.entitlements` (only `Contents/Resources/node`) | `allow-jit` | V8 compiles JavaScript to machine code at run time. Without it the hardened runtime kills node. |
| same | `allow-unsigned-executable-memory` | Kept to match the official Node build (the release script prints the official entitlements beside ours). Try removing it. |
| same | `disable-library-validation` | Lets node load a native addon signed by someone else. The release signs node and the addon with one identity, so it should not be needed. Try removing it. |

To tighten: delete a key, run `--release`, and see whether `verify-dmg.sh --release` still passes (it loads better-sqlite3 under the bundled node and boots the hub). If the app's own JavaScript engine turns out to need `allow-jit` (the hardened app shows a blank window or crashes on launch, and `Console.app` mentions JIT or `MAP_JIT`), build once with `AGENT_ROOM_APP_ALLOW_JIT=1`; that adds only that key, to the app.

The agent CLIs (`claude`, `codex`, `hermes`) are separate programs the hub starts. They are not loaded into node, so these entitlements do not apply to them.

## Auto-update (MAC)

Sparkle 2 runs inside the app (`SPUStandardUpdaterController`, created in `AppDelegate.mm`). It checks the appcast once a day (`SUScheduledCheckInterval` 86400), shows its own window, downloads the DMG, checks the EdDSA signature against `SUPublicEDKey`, and replaces the app. The bundled hub is part of the app, so it updates with it; the LaunchAgent restarts it.

"Check for Updates…" is in the app menu and in Settings, About. The hub (`GET /version`, `POST /version/check`) reads the same appcast once a day with a small XML reader and the app shows "Agent Room X is available" with Update and Later buttons. That banner is information; Sparkle does the install. In a build without Sparkle (a developer's Xcode run) the banner's button opens the download address instead.

Day-to-day builds do not have Sparkle: `Podfile` includes it only when `AGENT_ROOM_SPARKLE=1`, and the code only when the build defines `AR_SPARKLE=1`. After a release build run `pod install` (Setup.command does) to go back.

**Update test to run once:** build 1.0.0 and install it; set `VERSION` to 1.0.1, build again, run `make-appcast.sh` for it, upload both files, then in the installed 1.0.0 choose Check for Updates… It should offer 1.0.1, install it, and relaunch with the hub running and no sign-in lost. Also check the banner shows in the old version a day later (or after `POST /version/check`).

## Crash reports and usage counts

Both are **off by default**, are switched on only by the user (onboarding step and Settings, Privacy and updates), and nothing leaves the Mac unless a switch is on **and** an endpoint is configured. Every upload goes through one function (`upload()` in `packages/hub/src/distribution/reporting.ts`) that checks both; tests prove no request is made otherwise.

**Crash reports.** The hub writes an uncaught exception or unhandled rejection to `~/.agent-room/crashes/<timestamp>.json` and exits. The LaunchAgent has `KeepAlive`, so it comes back in 10 seconds; the app starts it again otherwise. The report holds: when, which kind, the error's class name and code, **the message only for built-in JavaScript and system errors with every quoted piece removed** (our own errors' messages are withheld, since they can quote a goal), the stack as function names and file locations with `/Users/<name>` and the home folder shown as `~`, the app, Node, platform and macOS versions, and uptime. Never a prompt, message, file content, name or token. Strings that look like keys, bearer tokens, emails or tailnet names are removed even from the stack. The newest 50 are kept, files are mode 0600. With the switch on, waiting reports upload at the next hub start and move to `crashes/sent/`.

macOS's own crash reports for Agent Room (`~/Library/Logs/DiagnosticReports/AgentRoom*.ips` and the bundled `node`'s) are only **listed** in Settings (name, date, size) so the user can attach one to a bug report by hand. They hold more than ours do (memory, paths), so they are never uploaded.

**Usage counts** (`packages/hub/src/distribution/telemetry.ts`): one batch a week, the first a week after the switch is turned on. The fields are fixed by an allow-list that rebuilds the object, so a field added by mistake upstream cannot reach the wire:

```
{ "type": "telemetry", "schema": 1, "periodDays": 7,
  "appVersion": "1.0.0", "macosVersion": "15.1",
  "agentsByKind": { "claude-code": 1, "codex": 1 },
  "goalsPerDay": [2, 0, 3, 1, 0, 0, 4],
  "taskAcceptanceRate": 0.82, "crashCount": 0 }
```

No install id, so batches cannot be tied to one Mac. Settings has "See what would be sent" showing the exact JSON for the next batch. If you want to add a field, add it to `TELEMETRY_FIELDS` and `sanitizeTelemetry` and update the privacy notice and `site/` in the same change.

### The report endpoint

`AGENT_ROOM_REPORT_URL` (or the Info.plist key `AgentRoomReportURL`, which `--release` fills from it). Unset by default: Settings then says "this build has no place to send reports to". It must be https (plain http only to this Mac, for testing). The app POSTs JSON with `content-type: application/json`: a crash report (`"type": "crash"`) or a usage batch (`"type": "telemetry"`), to that exact address, with no cookies or credentials, and treats any 2xx as received. You build and run the receiving side: accept both, store little, delete on a schedule, and do not log IP addresses longer than you need to. Nothing in this repo runs it.

## Publishing (OWNER)

- Upload `AgentRoom-<version>.dmg`, its `.sha256`, and `appcast.xml`. The appcast must be reachable at exactly `AGENT_ROOM_FEED_URL`.
- Edit `site/index.html`: the download button points at a placeholder (`https://downloads.example.invalid/...`); set the real DMG address, the version line, and the docs link. The page has no scripts and makes no requests, so any static host will do. Nothing in this repo publishes it.
- Keep the old DMGs: `make-appcast.sh` keeps earlier items in the appcast, and users on old versions update from them.

## Before the first public release, checklist

- [ ] Apple Developer Program joined; certificate and notary login made (steps 1 to 3)
- [ ] Sparkle keys made and the private key backed up (step 4)
- [ ] Feed, DMG and report addresses chosen (steps 5 and 6)
- [ ] `docs/legal/` reviewed by a lawyer; licence chosen; `LICENSE` added; `packages/app/src/legal.ts` updated
- [ ] Provider terms answered, or the fallback to API keys decided (step 8); `ProviderTerms.tsx` text still true
- [ ] `--release --preflight` passes, then `--release` finishes with "All checks passed"
- [ ] Clean-account install test passes with no Gatekeeper warning (`docs/install-test.md`)
- [ ] The update test above passes
- [ ] The privacy notice and `site/` privacy summary match what the build really sends (turn both switches on against a test endpoint and read what arrives)
- [ ] `site/` published with the real download address
