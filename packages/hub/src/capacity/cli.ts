/**
 * Prints what the hub detects about this computer and the limits it would use.
 *   pnpm --filter @agent-room/hub exec tsx src/capacity/cli.ts
 * Preview another machine without owning it:  --gb 8 --cores 8   (also --local-models on|off, --max-tasks N, --json)
 */
import type { CapacitySettings } from "@agent-room/shared";
import { describeProfile, detectHardware, planCapacity } from "./hardware.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const hw = detectHardware();
if (flag("gb")) hw.totalGB = Number(flag("gb"));
if (flag("cores")) { hw.cores = Number(flag("cores")); delete hw.perfCores; }
const overrides: CapacitySettings = {};
const lm = flag("local-models");
if (lm === "on" || lm === "off" || lm === "auto") overrides.localModels = lm;
if (flag("max-tasks")) overrides.maxConcurrentTasks = Number(flag("max-tasks"));
const plan = planCapacity(hw, overrides);

if (args.includes("--json")) {
  console.log(JSON.stringify({ hardware: hw, plan, summary: describeProfile(hw, plan) }, null, 2));
} else {
  const simulated = flag("gb") || flag("cores") ? " (simulated)" : "";
  console.log(`Agent Room capacity${simulated}
  Machine:      ${hw.machine ?? "unknown"}${hw.chip ? `, ${hw.chip}` : ""}${hw.appleSilicon ? " (Apple silicon)" : ""}
  Memory:       ${hw.totalGB} GB total, ${hw.freeGB} GB available now
  Cores:        ${hw.cores}${hw.perfCores ? ` (${hw.perfCores} performance)` : ""}

  Tier:         ${plan.tier}
  Tasks at once:        ${plan.maxConcurrentTasks}
  Local CLI agents:     ${plan.maxLocalCliAgents} at a time
  Local models:         ${plan.localModelsAllowed ? `on, up to ${plan.localModelMaxGB} GB, needs ${plan.minFreeGB} GB free` : "off"}
  Why:          ${plan.reason}

  ${describeProfile(hw, plan)}`);
}
