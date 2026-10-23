import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HardwareInfo } from "@agent-room/shared";
import { Store } from "../src/db/store.js";
import { Approvals } from "../src/orchestrator/approvals.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { CapacityGovernor } from "../src/capacity/governor.js";
import { seed } from "../src/seed.js";

/** Simulated machines for capacity tests. Everything else runs on LARGE so the tests' own concurrency is never throttled. */
export const HW = {
  small: { totalGB: 8, freeGB: 5, cores: 8, perfCores: 4, appleSilicon: true, chip: "Apple M1", machine: "MacBook Air" } as HardwareInfo,
  medium: { totalGB: 16, freeGB: 9, cores: 10, perfCores: 8, appleSilicon: true, chip: "Apple M2 Pro", machine: "MacBook Pro" } as HardwareInfo,
  large: { totalGB: 64, freeGB: 40, cores: 16, appleSilicon: true, chip: "Apple M3 Max", machine: "Mac Studio" } as HardwareInfo,
};

export function setup(opts: { rand?: () => number; retryDelayMs?: number; hardware?: HardwareInfo; freeGB?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ar-"));
  const store = new Store(join(dir, "t.db"));
  seed(store, true);
  const approvals = new Approvals(store, 2000);
  const hw = opts.hardware ?? HW.large;
  const governor = new CapacityGovernor(store, hw, { freeGB: opts.freeGB ?? (() => hw.freeGB) });
  const orch = new Orchestrator(store, approvals, { dataDir: dir, mcpUrl: () => undefined, rand: opts.rand ?? (() => 0.99), retryDelayMs: opts.retryDelayMs ?? 1, libraryDir: join(dir, "Library"), governor });
  const room = store.listRooms()[0];
  return { dir, store, approvals, orch, room, governor };
}
