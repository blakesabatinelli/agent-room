// 4.4 Fork a goal: two rosters on one goal, compared blind, one merged
export { Forks, type ForkHost, type Lane, type StartInput } from "./service.js";
export { parseForkLine, defaultSplit, resolveRoster, scrubber, sideBranch } from "./model.js";
export { compareSides, comparePrompt, candidateText, mergeVerdicts, pickJudges, type Dossier } from "./compare.js";
export { mergeBranch, mergeIntoFolder, mergeProposal } from "./merge.js";
export { folderDeltas, folderDeliverables, gitDeliverables, scan } from "./files.js";
export { getFork, listForks, saveFork, listPreferences, forkPreference, recordForkOutcome } from "./records.js";
export { registerForkRoutes } from "./routes.js";
