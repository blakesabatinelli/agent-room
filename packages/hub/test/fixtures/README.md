# Sign-in output samples (item 1.7)

None of these were captured from a live run (the build machine is Linux with no Claude or Codex account). Each is built
from what the vendors document or print, so the parser is tested against realistic text. The first run on a Mac should
replace the "reconstructed" ones with real captures (`docs/install-test.md`, section "Record the real sign-in output").

| File | Source | Notes |
|---|---|---|
| `signin-claude-login.txt` | Reconstructed. Docs say `claude auth login` opens the browser and that the login URL can be copied when it doesn't open: https://code.claude.com/docs/en/authentication | One-line URL after "visit:" |
| `signin-claude-paste.txt` | Reconstructed. The docs name the prompt `Paste code here if prompted`: https://code.claude.com/docs/en/authentication | With ANSI dimming codes |
| `signin-codex-browser.txt` | Reconstructed from the Codex CLI's login server behaviour: local server on port 1455, URL printed if the browser doesn't open: https://developers.openai.com/codex/auth | |
| `signin-codex-device.txt` | Shape taken from a sample run published at https://lucaberton.com/blog/codex-device-code-auth-chatgpt-security-2026/ (URL `https://auth.openai.com/codex/device`, code like `AAAAB-BB6TU`, "expires in 15 minutes"), with ANSI colour added | |
| `signin-codex-device-docs.txt` | Docs sample, https://mintlify.wiki/openai/codex/cli/login ("Visit https://chatgpt.com/activate", "Enter code: ABCD-1234") | Wording differs from the real CLI; the parser has to cope with both |
| `signin-codex-port-busy.txt` | Reconstructed: what a port 1455 clash looks like | Triggers the fall back to a one-time code |
| `signin-hostile.txt` | Made up: lookalike and non-https links the app must never open | |
