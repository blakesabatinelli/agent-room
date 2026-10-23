import { resolve } from "node:path";
import { defaultControlRoot } from "./folder.js";
import { formatIssue, lint } from "./lint.js";

/**
 * `pnpm control:lint [folder]`: check the control folder and print every problem with its file and line.
 * Exit code 1 when anything blocks loading, 0 otherwise (flags are warnings).
 */
const [cmd, folder] = process.argv.slice(2);
if (cmd !== "lint") {
  console.error("Usage: control lint [folder]   (default: $AGENT_ROOM_HOME or ~/Agent Room)");
  process.exit(2);
}
const root = resolve(folder ?? defaultControlRoot());
const { blocks, flags } = lint(root);
for (const i of [...blocks, ...flags]) console.log(formatIssue(i));
console.log(`${root}: ${blocks.length} blocking, ${flags.length} flagged`);
process.exit(blocks.length ? 1 : 0);
