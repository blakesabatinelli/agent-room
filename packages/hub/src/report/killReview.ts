import { main } from "./kill.js";

/** `pnpm review:kill [path to agent-room.db] [--force] [--no-save] [--library <folder>]`. The logic and the notes are in kill.ts. */
main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error((e as Error).message); process.exit(1); });
