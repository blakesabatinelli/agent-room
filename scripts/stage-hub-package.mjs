#!/usr/bin/env node
// Writes the package.json that ships next to hub.mjs inside the app: exactly the dependencies the esbuild bundle
// leaves external (the --external:<name> flags in packages/hub/package.json "build"), pinned to the versions in
// pnpm-lock.yaml. Used by scripts/package-mac.sh; runs anywhere Node does, so the list can be tested on Linux.
//   node scripts/stage-hub-package.mjs <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hubPkg = JSON.parse(readFileSync(join(root, "packages/hub/package.json"), "utf8"));
const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");

const externalsOf = (text) => [...new Set([...text.matchAll(/--external:([^\s"']+)/g)].map((m) => m[1]))].sort();
const fromBuild = externalsOf(hubPkg.scripts.build);
const fromRunSh = externalsOf(readFileSync(join(root, "packages/hub/run.sh"), "utf8"));
if (JSON.stringify(fromBuild) !== JSON.stringify(fromRunSh)) {
  console.error(`packages/hub/package.json build leaves [${fromBuild}] external but run.sh leaves [${fromRunSh}]. Make them match.`);
  process.exit(1);
}

/** The version pnpm resolved for a hub dependency (the importers block for packages/hub). */
function lockedVersion(name) {
  const block = lock.split(/^ {2}packages\/hub:\n/m)[1]?.split(/^ {2}\S/m)[0] ?? "";
  const m = block.match(new RegExp(`^ {6}'?${name.replace(/[/@]/g, "\\$&")}'?:\\n {8}specifier: .*\\n {8}version: ([^\\n(]+)`, "m"));
  return m?.[1].trim();
}

const dependencies = {};
for (const name of fromBuild) {
  const range = hubPkg.dependencies?.[name];
  if (!range) { console.error(`${name} is external in the bundle but is not a dependency of @agent-room/hub.`); process.exit(1); }
  dependencies[name] = lockedVersion(name) ?? range;
}

const out = process.argv[2];
if (!out) { console.error("Usage: stage-hub-package.mjs <out-dir>"); process.exit(2); }
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "package.json"), `${JSON.stringify({
  name: "agent-room-hub-runtime", version: hubPkg.version, private: true, type: "module", dependencies,
}, null, 2)}\n`);
console.log(`Staged package.json with ${Object.entries(dependencies).map(([k, v]) => `${k}@${v}`).join(", ")}`);
