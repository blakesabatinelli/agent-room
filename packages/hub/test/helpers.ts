import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.js";
import { Approvals } from "../src/orchestrator/approvals.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { seed } from "../src/seed.js";

export function setup(opts: { rand?: () => number; retryDelayMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ar-"));
  const store = new Store(join(dir, "t.db"));
  seed(store, true);
  const approvals = new Approvals(store, 2000);
  const orch = new Orchestrator(store, approvals, { dataDir: dir, mcpUrl: () => undefined, rand: opts.rand ?? (() => 0.99), retryDelayMs: opts.retryDelayMs ?? 1, libraryDir: join(dir, "Library") });
  const room = store.listRooms()[0];
  return { dir, store, approvals, orch, room };
}
