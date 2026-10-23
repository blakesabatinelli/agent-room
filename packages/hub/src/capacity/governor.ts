import type { AgentConfig, AgentLocality, CapacityPlan, CapacitySnapshot, HardwareInfo, OrchestratorSettings } from "@agent-room/shared";
import { describeProfile, planCapacity, readFreeGB } from "./hardware.js";
import { classifyAgent, estimateModelGB } from "./locality.js";

export interface GovernorOptions {
  /** Free memory in GB. Defaults to the live reading (os.freemem, corrected on macOS). */
  freeGB?: () => number;
  now?: () => number;
  /** Re-read free memory at most this often. */
  sampleMs?: number;
}

const RANK: Record<AgentLocality, number> = { remote: 0, "local-cli": 1, "local-model": 2 };

/**
 * Decides whether this machine can take another task for a given agent, and keeps the count of what is running.
 * Only local work (local models and local CLIs) counts against the limits; remote agents never wait on this Mac.
 * Limits are re-planned from settings on every call, so a change in Settings applies to the next task.
 */
export class CapacityGovernor {
  private running = new Map<string, AgentLocality>();
  private sampled = { at: -Infinity, gb: 0 };
  private readonly freeFn: () => number;
  private readonly clock: () => number;
  private readonly sampleMs: number;

  constructor(private store: { getSettings(): OrchestratorSettings }, readonly hardware: HardwareInfo, opts: GovernorOptions = {}) {
    this.freeFn = opts.freeGB ?? (() => readFreeGB());
    this.clock = opts.now ?? Date.now;
    this.sampleMs = opts.sampleMs ?? 5000;
  }

  plan(): CapacityPlan { return planCapacity(this.hardware, this.store.getSettings().capacity ?? {}); }

  /** Free memory in GB, read at most every 5 seconds. */
  freeGB(): number {
    const t = this.clock();
    if (t - this.sampled.at >= this.sampleMs) this.sampled = { at: t, gb: this.freeFn() };
    return this.sampled.gb;
  }

  classify(agent: AgentConfig): AgentLocality { return classifyAgent(agent); }

  private counts() {
    let localModel = 0, localCli = 0, remote = 0;
    for (const l of this.running.values()) { if (l === "local-model") localModel++; else if (l === "local-cli") localCli++; else remote++; }
    return { total: this.running.size, localModel, localCli, remote };
  }

  /** Can this agent start a task now? Remote agents always can. */
  admit(agent: AgentConfig): boolean {
    const loc = classifyAgent(agent);
    if (loc === "remote") return true;
    const p = this.plan(), c = this.counts();
    if (c.localModel + c.localCli >= p.maxConcurrentTasks) return false;
    if (loc === "local-cli") return c.localCli < p.maxLocalCliAgents;
    if (!p.localModelsAllowed) return false;
    const need = estimateModelGB(agent);
    if (need !== undefined && need > p.localModelMaxGB) return false;
    return this.freeGB() >= p.minFreeGB;
  }

  /** Local work is at its limit, so the next task should go to a cloud agent if one is free. */
  atLimit(): boolean {
    const p = this.plan(), c = this.counts();
    return c.localModel + c.localCli >= p.maxConcurrentTasks || c.localCli >= p.maxLocalCliAgents;
  }

  /** Close to the limit, or short on memory: favour agents that cost this machine the least. */
  private underPressure(): boolean {
    const p = this.plan(), c = this.counts();
    return c.localModel + c.localCli >= Math.max(1, p.maxConcurrentTasks - 1) || (p.minFreeGB > 0 && this.freeGB() < p.minFreeGB * 2);
  }

  /**
   * The candidates this machine can take, in the order to prefer them (AC3). Agents it can't take are dropped,
   * so at the limit only cloud agents are left. Under pressure, cloud agents come first, then local CLIs, then local models.
   */
  preferForOverflow(candidates: AgentConfig[]): AgentConfig[] {
    const ok = candidates.filter((a) => this.admit(a));
    if (!this.underPressure()) return ok;
    return ok.map((a, i) => ({ a, i })).sort((x, y) => RANK[classifyAgent(x.a)] - RANK[classifyAgent(y.a)] || x.i - y.i).map((x) => x.a);
  }

  /** A task started on this agent. `key` is the task id; release it with the same key. */
  start(key: string, agent: AgentConfig) { this.running.set(key, classifyAgent(agent)); }
  release(key: string) { this.running.delete(key); }

  snapshot(): CapacitySnapshot {
    const plan = this.plan();
    const hardware = { ...this.hardware, freeGB: this.freeGB() };
    return { hardware, plan, running: this.counts(), atLimit: this.atLimit(), summary: describeProfile(hardware, plan) };
  }
}
