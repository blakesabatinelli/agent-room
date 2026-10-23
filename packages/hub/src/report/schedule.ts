import type { LibraryDoc } from "@agent-room/shared";
import { attentionFor } from "../attention/index.js";
import type { Store } from "../db/store.js";
import type { Library } from "../library/library.js";
import { isoWeek, weekStart } from "../retro/metrics.js";
import { buildLedger } from "./ledger.js";
import { monthOf, parseMonth, prevMonth } from "./periods.js";
import { buildScorecard } from "./scorecard.js";

/**
 * 2.7 Saving the reports where the owner keeps their files. Each Monday the scorecard for the week that just ended goes into the
 * Library (room general, status final); on the first of the month, so does the ledger for the month that just ended.
 * A hub that was off on that day does it at its next start. Only the latest finished period is saved (no back-filling of old ones),
 * and a period with nothing in it is skipped.
 */

interface Saved { weeks: string[]; months: string[] }
const KEY = "reports_saved";

export function runDueReports(store: Store, library: Library, now = Date.now()): { scorecard?: LibraryDoc; ledger?: LibraryDoc } {
  const room = store.listRooms().find((r) => r.name === "general") ?? store.listRooms()[0];
  if (!room) return {};
  const saved = store.getKV<Saved>(KEY, { weeks: [], months: [] });
  const out: { scorecard?: LibraryDoc; ledger?: LibraryDoc } = {};
  const att = attentionFor(store);

  const week = isoWeek(weekStart(now) - 1);
  if (!saved.weeks.includes(week)) {
    const sc = buildScorecard(store, week, { now });
    if (sc.totals.goals || sc.interruptions.total || sc.judges.rated) {
      const { doc } = library.save({ title: `Weekly scorecard ${week}`, body: sc.markdown, roomId: room.id, status: "final", author: "orchestrator", tags: ["scorecard", "report"] });
      out.scorecard = doc;
      att.notify("report", { title: `Scorecard for ${week} is in the Library`, body: doc.relPath, roomId: room.id, key: `report:${week}` });
    }
    saved.weeks = [...saved.weeks, week].slice(-60);
  }

  const month = prevMonth(monthOf(now));
  if (!saved.months.includes(month)) {
    const l = buildLedger(store, month, { now });
    if (store.listRouting({ since: parseMonth(month)!.start - 7 * 86_400_000 }).some((r) => monthOf(r.completedAt ?? r.at) === month)) {
      const { doc } = library.save({ title: `Subscription return ledger ${month}`, body: l.markdown, roomId: room.id, status: "final", author: "orchestrator", tags: ["ledger", "report"] });
      out.ledger = doc;
      att.notify("report", { title: `Return ledger for ${month} is in the Library`, body: doc.relPath, roomId: room.id, key: `report:${month}` });
    }
    saved.months = [...saved.months, month].slice(-36);
  }
  store.setKV(KEY, saved);
  return out;
}

/** Called once at hub start: the digest timer, and a check for reports that are due (every hour after). */
export function startScheduled(store: Store, library: Library, opts: { everyMs?: number } = {}) {
  const att = attentionFor(store);
  att.start();
  const run = () => { try { runDueReports(store, library); } catch (e) { store.audit("hub", "report.failed", (e as Error).message.slice(0, 200)); } };
  run();
  const timer = setInterval(run, opts.everyMs ?? 3_600_000);
  timer.unref?.();
  return () => { clearInterval(timer); att.stop(); };
}
