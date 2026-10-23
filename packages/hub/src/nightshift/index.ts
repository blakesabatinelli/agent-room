// 4.5 Night-shift tournaments: see PLAN.md item 4.5 and PRODUCT.md 6.9. The loop and its two hooks are in service.ts, the blind judging in judge.ts.
export { NightShift, NIGHT_TUNING } from "./service.js";
export type { NightHost, NightShiftDeps } from "./service.js";
export { judgePair, scrubNames, outsideBoth, TIE_MARGIN } from "./judge.js";
export type { BlindHost, PairEntry, PairInput, PairOutcome, SideRead } from "./judge.js";
export { headToHead, headToHeadOf, headlineOf, nightLine, evidenceCount } from "./headToHead.js";
export { nightOf, nightSettings } from "./settings.js";
export { getSource, listTournaments, listNights, getNight, saveTournament, saveSource } from "./records.js";
export type { TaskSource } from "./records.js";
export { registerNightShiftRoutes } from "./routes.js";
