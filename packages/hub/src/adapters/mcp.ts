import type { AgentConfig } from "@agent-room/shared";
import { id } from "../util.js";
import type { Adapter, AdapterStatus, RunRequest, RunResult } from "./types.js";

/** Work waiting for an agent that lives outside the hub and connects over MCP. */
export interface Assignment {
  id: string;
  agentId: string;
  roomId?: string;
  taskId?: string;
  instructions: string;
  createdAt: number;
  claimedAt?: number;
}

type Pending = Assignment & { done: (r: { ok: boolean; text: string; error?: string }) => void };

/**
 * Mailbox between the orchestrator and external MCP agents (Hermes, Muse...).
 * The orchestrator enqueues work and awaits it; the agent long-polls
 * wait_for_assignment and answers with submit_result.
 */
export class McpInbox {
  private queue = new Map<string, Pending[]>();
  private waiters = new Map<string, ((a: Assignment) => void)[]>();
  private lastSeen = new Map<string, number>();
  /** Called whenever an agent's connection state may have changed. */
  onSeen?: (agentId: string) => void;

  seen(agentId: string) {
    const was = this.connected(agentId);
    this.lastSeen.set(agentId, Date.now());
    if (!was) this.onSeen?.(agentId);
  }
  connected(agentId: string, withinMs = 3 * 60_000) {
    return Date.now() - (this.lastSeen.get(agentId) ?? 0) < withinMs;
  }
  lastSeenAt(agentId: string) { return this.lastSeen.get(agentId); }

  enqueue(agentId: string, a: Omit<Assignment, "id" | "agentId" | "createdAt">, signal?: AbortSignal, timeoutMs = 30 * 60_000, claimMs = 0): Promise<{ ok: boolean; text: string; error?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const item: Pending = { ...a, id: id("asg"), agentId, createdAt: Date.now(), done: (r) => finish(r) };
      const list = this.queue.get(agentId) ?? [];
      list.push(item); this.queue.set(agentId, list);
      const finish = (r: { ok: boolean; text: string; error?: string }) => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearTimeout(claimTimer); signal?.removeEventListener("abort", onAbort);
        this.queue.set(agentId, (this.queue.get(agentId) ?? []).filter((x) => x.id !== item.id));
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, text: "", error: "The agent didn't submit a result in time." }), timeoutMs);
      // Unclaimed work goes back to the orchestrator instead of sitting in a dead mailbox.
      const claimTimer = claimMs > 0 ? setTimeout(() => {
        if (!item.claimedAt) finish({ ok: false, text: "", error: `Didn't pick up the assignment within ${Math.round(claimMs / 60_000)} min.` });
      }, claimMs) : undefined;
      const onAbort = () => finish({ ok: false, text: "", error: "Cancelled." });
      signal?.addEventListener("abort", onAbort);
      // hand it straight to an agent that is already waiting
      const w = this.waiters.get(agentId)?.shift();
      if (w) { item.claimedAt = Date.now(); w(strip(item)); }
    });
  }

  /** Next unclaimed assignment, or wait up to `ms` for one. */
  async next(agentId: string, ms: number): Promise<Assignment | undefined> {
    this.seen(agentId);
    const ready = (this.queue.get(agentId) ?? []).find((x) => !x.claimedAt);
    if (ready) { ready.claimedAt = Date.now(); return strip(ready); }
    if (ms <= 0) return undefined;
    return new Promise((resolve) => {
      const fn = (a: Assignment) => { clearTimeout(t); resolve(a); };
      const t = setTimeout(() => {
        this.waiters.set(agentId, (this.waiters.get(agentId) ?? []).filter((x) => x !== fn));
        this.seen(agentId); resolve(undefined);
      }, ms);
      this.waiters.set(agentId, [...(this.waiters.get(agentId) ?? []), fn]);
    });
  }

  submit(agentId: string, assignmentId: string, text: string, failed = false): boolean {
    this.seen(agentId);
    const item = (this.queue.get(agentId) ?? []).find((x) => x.id === assignmentId);
    if (!item) return false;
    item.done(failed ? { ok: false, text: "", error: text } : { ok: true, text });
    return true;
  }

  pending(agentId: string) { return (this.queue.get(agentId) ?? []).map(strip); }
}

const strip = ({ done: _d, ...a }: Pending): Assignment => a;

export const inbox = new McpInbox();

export class ExternalMcpAdapter implements Adapter {
  async status(agent: AgentConfig): Promise<AdapterStatus> {
    const at = inbox.lastSeenAt(agent.id);
    if (inbox.connected(agent.id)) return { ready: true, state: "ready", detail: "Connected over MCP" };
    return {
      ready: false, state: "offline",
      detail: at ? `Last checked in ${new Date(at).toLocaleString()}` : "Waiting to connect",
    };
  }

  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    const instructions = req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
    const timeout = Number(req.agent.settings.timeoutMinutes ?? 30) * 60_000;
    const r = await inbox.enqueue(req.agent.id, { instructions, roomId: req.roomId, taskId: req.taskId }, req.signal, timeout, req.claimTimeoutMs ?? 0);
    return { ok: r.ok && !!r.text, text: r.text, durationMs: Date.now() - t0, error: r.ok ? undefined : r.error ?? r.text };
  }
}
