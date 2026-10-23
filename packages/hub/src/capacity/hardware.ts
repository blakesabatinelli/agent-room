import nodeOs from "node:os";
import { execFileSync } from "node:child_process";
import type { CapacityPlan, CapacitySettings, CapacityTier, HardwareInfo } from "@agent-room/shared";

/**
 * 1.5 Scheduling that adapts to the hardware.
 *
 * The rule (every number can be overridden in settings.capacity):
 *
 *   tier    memory (GiB)        tasks at once                      local CLI agents   local models
 *   small   under 12 (8 GB)     2                                  1                  off
 *   medium  12 to under 28      3                                  2                  on, model up to 6 GB
 *   large   28 and up (32+ GB)  half the performance cores, 4 to 6 as many as tasks   on, model up to half of memory
 *
 * Every tier is also capped at the core count. "Tasks at once" counts local work only (local models and
 * local CLIs); agents that run elsewhere (MCP apps, cloud APIs) cost this machine nothing and never wait.
 * Local models also need free memory (minFreeGB) at the moment they start.
 */
export const THRESHOLDS = {
  smallBelowGB: 12,
  largeFromGB: 28,
  small: { tasks: 2, cliAgents: 1, modelGB: 0, minFreeGB: 0 },
  medium: { tasks: 3, cliAgents: 2, modelGB: 6, minFreeGB: 2 },
  large: { minTasks: 4, maxTasks: 6, minFreeGB: 3 },
} as const;

/** The bits of node:os the detector reads, so tests can stand in a different machine. */
export interface OsLike {
  totalmem(): number;
  freemem(): number;
  cpus(): unknown[];
  platform(): string;
  arch(): string;
}
/** Things only a Mac can tell us. Each returns undefined when unavailable. */
export interface Probes {
  sysctl(key: string): string | undefined;
  vmStat(): string | undefined;
}

export const defaultProbes: Probes = {
  sysctl(key) {
    try { return execFileSync("/usr/sbin/sysctl", ["-n", key], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
  },
  vmStat() {
    try { return execFileSync("/usr/bin/vm_stat", [], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return undefined; }
  },
};

const GIB = 1024 ** 3;
const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * macOS reports almost nothing as "free" (the rest is cache it gives back on demand), so os.freemem()
 * makes a healthy Mac look full. Free + inactive + speculative + purgeable pages is closer to what an app can get.
 */
export function parseVmStat(text: string): number | undefined {
  const size = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!size) return undefined;
  const pages = (label: string) => Number(text.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  const n = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
  return n ? n * size : undefined;
}

/** Marketing family from the hw.model identifier ("MacBookPro18,3" -> "MacBook Pro"). */
export function machineName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const families: [RegExp, string][] = [
    [/^MacBookPro/i, "MacBook Pro"], [/^MacBookAir/i, "MacBook Air"], [/^MacBook\d/i, "MacBook"],
    [/^Macmini/i, "Mac mini"], [/^iMacPro/i, "iMac Pro"], [/^iMac/i, "iMac"], [/^MacPro/i, "Mac Pro"], [/^MacStudio/i, "Mac Studio"],
  ];
  return families.find(([re]) => re.test(model))?.[1] ?? (/^Mac\d/i.test(model) ? "Mac" : undefined);
}

/** Free memory right now, in GiB. Cheap enough to call every few seconds. */
export function readFreeGB(os: OsLike = nodeOs, probes: Probes = defaultProbes): number {
  let bytes = os.freemem();
  if (os.platform() === "darwin") {
    const v = probes.vmStat();
    const avail = v ? parseVmStat(v) : undefined;
    if (avail) bytes = Math.max(bytes, Math.min(avail, os.totalmem()));
  }
  return round1(bytes / GIB);
}

export function detectHardware(os: OsLike = nodeOs, probes: Probes = defaultProbes): HardwareInfo {
  const mac = os.platform() === "darwin";
  const num = (key: string) => { const n = Number(probes.sysctl(key)); return Number.isFinite(n) && n > 0 ? n : undefined; };
  const cores = Math.max(1, os.cpus().length);
  const perfCores = mac ? num("hw.perflevel0.physicalcpu") : undefined;
  const chip = mac ? probes.sysctl("machdep.cpu.brand_string") : undefined;
  return {
    totalGB: round1(os.totalmem() / GIB),
    freeGB: readFreeGB(os, probes),
    cores,
    ...(perfCores ? { perfCores } : {}),
    appleSilicon: mac && (os.arch() === "arm64" || /apple/i.test(chip ?? "")),
    ...(chip ? { chip } : {}),
    ...(mac && machineName(probes.sysctl("hw.model")) ? { machine: machineName(probes.sysctl("hw.model")) } : {}),
  };
}

const positive = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);

/** Turn the hardware (and the owner's overrides) into limits. Pure, so tests can try any machine. */
export function planCapacity(hw: HardwareInfo, overrides: CapacitySettings = {}): CapacityPlan {
  const smallBelow = positive(overrides.smallBelowGB) ?? THRESHOLDS.smallBelowGB;
  const largeFrom = positive(overrides.largeFromGB) ?? THRESHOLDS.largeFromGB;
  const tier: CapacityTier = hw.totalGB < smallBelow ? "small" : hw.totalGB >= largeFrom ? "large" : "medium";
  const cores = Math.max(1, hw.cores);
  let tasks: number, cli: number, modelGB: number, minFree: number;
  if (tier !== "large") {
    const t = THRESHOLDS[tier];
    tasks = t.tasks; cli = t.cliAgents; modelGB = t.modelGB; minFree = t.minFreeGB;
  } else {
    const heavy = hw.perfCores ?? cores;
    tasks = Math.min(THRESHOLDS.large.maxTasks, Math.max(THRESHOLDS.large.minTasks, Math.floor(heavy / 2)));
    cli = tasks; modelGB = Math.floor(hw.totalGB / 2); minFree = THRESHOLDS.large.minFreeGB;
  }
  tasks = Math.min(tasks, cores);
  const notes: string[] = [];

  const maxTasks = positive(overrides.maxConcurrentTasks);
  if (maxTasks !== undefined && maxTasks >= 1) { tasks = Math.floor(maxTasks); notes.push(`tasks at once set to ${tasks} in settings`); }
  const maxCli = positive(overrides.maxLocalCliAgents);
  if (maxCli !== undefined && maxCli >= 1) { cli = Math.floor(maxCli); notes.push(`local CLI agents set to ${cli} in settings`); }
  cli = Math.min(cli, tasks);
  minFree = positive(overrides.minFreeGB) ?? minFree;

  const mode = overrides.localModels ?? "auto";
  let allowed = tier !== "small";
  if (mode === "off") { allowed = false; notes.push("local models turned off in settings"); }
  if (mode === "on") {
    allowed = true; notes.push("local models turned on in settings");
    if (modelGB === 0) modelGB = Math.floor(hw.totalGB / 2); // owner opted in on a small machine: allow up to half of memory
  }
  modelGB = positive(overrides.localModelMaxGB) ?? modelGB;
  if (modelGB === 0 && allowed) allowed = false;

  const gb = Math.round(hw.totalGB);
  const base = tier === "small"
    ? `${gb} GB of memory is tight: ${tasks} tasks at once, local models off, one local CLI agent at a time`
    : tier === "medium"
      ? `${gb} GB of memory: ${tasks} tasks at once, local models up to ${modelGB} GB`
      : `${gb} GB and ${hw.perfCores ?? cores} ${hw.perfCores ? "performance " : ""}cores: ${tasks} tasks at once, local models allowed`;
  return {
    tier, maxConcurrentTasks: tasks, maxLocalCliAgents: cli, localModelsAllowed: allowed,
    localModelMaxGB: allowed ? modelGB : 0, minFreeGB: minFree,
    reason: [base, ...notes].join("; ") + ".",
  };
}

/** The one line the apps show: "MacBook Pro, 16 GB, 10 cores: up to 3 tasks at once; local models on". */
export function describeProfile(hw: HardwareInfo, plan: CapacityPlan): string {
  const gb = Number.isInteger(hw.totalGB) ? String(hw.totalGB) : String(Math.round(hw.totalGB));
  return `${hw.machine ?? "This computer"}, ${gb} GB, ${hw.cores} cores: up to ${plan.maxConcurrentTasks} ${plan.maxConcurrentTasks === 1 ? "task" : "tasks"} at once; local models ${plan.localModelsAllowed ? "on" : "off"}`;
}
