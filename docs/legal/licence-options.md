# Licence options

**DRAFT: needs legal review.** This compares choices so the owner can decide with a lawyer. It is not legal advice, and nothing here is final. No `LICENSE` file has been added to the repo root on purpose: that is the owner's decision, and it depends on D6.

## The question

D6 (business model) is open: *open-source hub*, *paid app*, or *Agent Index* (an opt-in index of which agents do what well, built from anonymized outcomes; see `PRODUCT.md` section 13, phase 4 "later"). An Agent Index would need its own consent and privacy terms: the usage counts in this release are not it and carry no outcomes. The licence has to fit whichever is chosen, and it can be chosen per package. Today the repo has five packages and ships two things to users: the hub (a daemon, `packages/hub`, with `packages/shared`) and the Mac app (`packages/app`). Both go in one DMG.

## Three shapes

| Shape | Hub and shared | Mac app | Fits D6 option | Main cost |
|---|---|---|---|---|
| **A. All open** | MIT or Apache-2.0 | same | Open-source hub, with money made elsewhere (Agent Index, services) | Anyone may sell a fork, including a competitor |
| **B. Open hub, proprietary app** | MIT or Apache-2.0 | EULA (`eula-draft.md`) | Open-source hub and a paid app | Two licences to explain; the app's source stays closed; the app imports `shared`, so `shared` must stay permissive |
| **C. All proprietary** | EULA | EULA | Paid app, nothing open | No community contribution, less trust for a tool that touches files and credentials |

The product's pitch is trust ("the user owns the record"; the Room never touches credentials). Open source for the part that touches files, approvals and the audit log is a real trust argument. That is a reason to lean toward A or B, but it is the owner's call and weighs against the business model.

## MIT versus Apache-2.0 (for the open parts)

| | MIT | Apache-2.0 |
|---|---|---|
| Length and wording | One short paragraph. Very widely understood | Longer, more precise |
| Use, copy, modify, sell | Yes, keep the notice | Yes, keep the notice, state changes, carry any NOTICE file |
| **Patents** | Silent. A grant is arguable but not explicit | **Explicit patent licence** from each contributor, ending for anyone who sues over the work (patent retaliation) |
| Trademarks | Silent | Says the licence gives no right to the names or marks |
| Contributor terms | None built in | Contributions are licensed under the same terms unless said otherwise (section 5) |
| Fits with the dependencies | Yes | Yes (both are permissive; Apache-2.0 is not compatible with GPLv2-only code, which this repo does not use) |
| Usual choice when a company stands behind the project | Smaller projects | Projects with a company, patents or outside contributors |

A common reading: MIT if the aim is simplicity and the project is small; Apache-2.0 if a company will own the product, take outside contributions, or worry about patents. Neither stops a competitor from forking, and neither lets a hosted service keep its changes private any more than a fork would. If the worry is a competitor reselling the hub as a service, the options that address it (AGPL-3.0, or source-available licences such as FSL or BUSL) are a different conversation and are not compared here.

## Proprietary EULA for the app (shape B or C)

- The app is installed software the user runs on their own Mac. A EULA grants a licence to use it, forbids copying and reverse engineering, disclaims warranties and caps liability. `eula-draft.md` is a starting text.
- It is the only shape that lets the app be paid (D6) without the source being free to fork.
- It must say, because the app launches other companies' agents: Agent Room is independent of the providers; each agent signs itself in with the user's own plan or key under that provider's terms (D5); AI output can be wrong and is the user's to check.
- It must list the open-source parts and keep their notices (see below).

## Things any choice has to handle

1. **Third-party notices.** The DMG carries Node.js, better-sqlite3 (and SQLite, public domain), Fastify, ws, zod, the MCP SDK, yaml, three.js, React Native macOS and its pods, and (release builds) Sparkle. All are permissive (MIT, ISC, BSD or similar; Sparkle's licence also lists the notices of the code it includes), and all require their notices to travel with the app. A `THIRD-PARTY-NOTICES` file and an Acknowledgements line in About are needed before 1.0. Generate it from the lockfile with a licence scanner and have it checked; this repo has not done that yet.
2. **Names.** "Agent Room" is the product name; nothing here licenses it. Providers' names are theirs: Anthropic's page says you may say your product runs Claude Code but may not use the Claude Code or Anthropic names or logos in your own product name or logo, or suggest endorsement. Keep that in the app and site copy (it is, today).
3. **Contributions.** Everything so far was written by the owner and agents working for the owner. Before accepting outside contributions to an open package, decide between a CLA and a DCO sign-off, or Apache-2.0's built-in contributor terms.
4. **Who owns the code.** Confirm the repo is the owner's (or the company's) to license: work done on a company's time, in company tools, or under an employment agreement may belong to the employer. A lawyer should check this first.
5. **The specs and decisions in this repo.** `PRODUCT.md`, `PLAN.md` and the research are internal. Decide whether the repository becomes public as is or whether those move out first.

## Leaning (not a decision)

- If D6 lands on "open-source hub": Apache-2.0 for `packages/hub`, `packages/shared` and (if kept) `packages/relay`; EULA for `packages/app`.
- If D6 lands on "paid app" with nothing open: EULA for everything.
- If D6 stays open at 1.0: ship under the EULA only. It is easy to open source later and impossible to take back.
- In every case the privacy notice stands on its own and should be final before the first public DMG.

## What the app does today

The About section in Settings shows "Licence terms: draft, awaiting legal review" and links nothing. When the owner publishes final texts, set `LEGAL.eulaUrl`, `LEGAL.privacyUrl` and `LEGAL.final` in `packages/app/src/legal.ts`, and the section links them. `site/index.html` has the same placeholders.
