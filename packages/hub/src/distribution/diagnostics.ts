// 4.7 macOS's own crash reports for Agent Room, listed from ~/Library/Logs/DiagnosticReports. List only: the hub reads at most the first 4 KB of
// a file to see which app it belongs to, never uploads one, and shows only the name, date and size. The owner can open them in Finder and
// attach one to a bug report by hand (they hold paths and memory contents the Room can't scrub).
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MacCrashReport } from "@agent-room/shared";

export const diagnosticsDir = () => join(homedir(), "Library", "Logs", "DiagnosticReports");

const REPORT = /\.(ips|crash)$/;
const OURS_BY_NAME = /^(AgentRoom|Agent Room)[-_ .]/;
const BUNDLED_NODE_BY_NAME = /^node[-_ .]/; // the app's own node binary is named "node"

function head(path: string, n = 4096): string {
  const fd = openSync(path, "r");
  try { const b = Buffer.alloc(n); const read = readSync(fd, b, 0, n, 0); return b.toString("utf8", 0, read); } finally { closeSync(fd); }
}

/** Reports for Agent Room (the app) or its bundled node. A "node" report counts only when it says it ran from AgentRoom.app. */
export function listMacReports(dir = diagnosticsDir(), lastSeen = 0, limit = 30): MacCrashReport[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => REPORT.test(f)); } catch { return []; }
  const out: MacCrashReport[] = [];
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      const ours = OURS_BY_NAME.test(name) || (BUNDLED_NODE_BY_NAME.test(name) && /AgentRoom\.app|com\.agentroom\./.test(head(join(dir, name))));
      if (ours) out.push({ name, at: st.mtimeMs, bytes: st.size, isNew: st.mtimeMs > lastSeen });
    } catch { /* unreadable: skip */ }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
