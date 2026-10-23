# The digest, scorecard and ledger

The room works quietly during the day and tells you what happened at set times.

## The evening digest

At 18:00 the room posts one digest in the **general** room. It lists what finished, what is waiting for you, and what it held back during the day. Type `/digest` in any room to get it now, in that room.

If your Mac was asleep at 18:00, the digest goes out once when it wakes, marked as late.

You set the daily cap on interruptions and your quiet hours in Settings. Between those, the room only breaks in for a disagreement or a decision it needs.

## The weekly scorecard

Each Monday the room saves a scorecard for the week that just ended (Monday to Sunday, UTC) to your Library, in the general room. It shows:

- which agent did best at which kind of work;
- which goals needed the most rework;
- how far apart the judges were;
- what each goal cost, in tokens and at API prices.

A week with nothing in it is skipped. Open it from **Library** in the sidebar, or find the file in `~/Agent Room/Library/general/`.

## The monthly ledger

On the 1st of each month the room saves the ledger for the month that just ended. It sets what each plan costs against the tasks you accepted on it, and gives each a verdict: keep, watch, cancel or upgrade. The thresholds are printed at the bottom of the report. If your Mac was off on the 1st, it is saved at the next start.

## What first-pass acceptance means

Many numbers say "accepted first time". It is the share of finished tasks you approved without asking for changes. A low number means goals are too vague, or an agent is a poor fit for that kind of work. The scorecard names which.

## Agent résumés

Each agent has a `RESUME.md` that the room keeps up to date from graded work: what it has proven good and bad at. The room reads it when it chooses who gets a task. You can read it too, in `~/Agent Room/agents/<agent>/`. See [Memory and control files](memory-and-control-files.md).

## Where everything is

- Reports: the Library, in `~/Agent Room/Library/general/`.
- The same numbers in the app: **Scorecard** in the sidebar.
- Nothing here is sent anywhere. See [Privacy and data](privacy-and-data.md).
