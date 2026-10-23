import type { Approval } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { id, now } from "../util.js";

/** Owner approval gate for sensitive actions. Requests block until decided or expired. */
export class Approvals {
  private waiters = new Map<string, (a: Approval) => void>();
  constructor(private store: Store, private timeoutMs = 30 * 60_000) {}

  /** `proposalId` (1.1) names the file-write proposal an approval card is about, so a UI can fetch the full diff. */
  request(p: { agentId: string; roomId?: string; tool: string; action: string; detail: string; proposalId?: string; /** 4.1: a two-key card (both agents' drafts) */ twoKey?: Approval["twoKey"] }, o: { ttlMs?: number } = {}): Promise<Approval> {
    const a: Approval = { id: id("apr"), ...p, status: "pending", createdAt: now() };
    this.store.saveApproval(a);
    this.store.audit(p.agentId, "approval.requested", `${p.tool}: ${p.action}`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(a.id, "expired", "system"), o.ttlMs ?? this.timeoutMs);
      if (o.ttlMs) timer.unref?.(); // 1.1: a long wait (12 h for a task's write-back) must never keep a stopping process alive
      this.waiters.set(a.id, (done) => { clearTimeout(timer); resolve(done); });
    });
  }

  /** Record an action the owner pre-approved for this agent. Logged like any approval, never waits. */
  auto(p: { agentId: string; roomId?: string; tool: string; action: string; detail: string }): Approval {
    const a: Approval = { id: id("apr"), ...p, status: "approved", auto: true, createdAt: now(), decidedAt: now() };
    this.store.saveApproval(a);
    this.store.audit(p.agentId, "approval.auto", `${p.tool}: ${p.action}`);
    return a;
  }

  /** 2.5: `choice` answers a question card (a memory contradiction); listeners added with onDecided hear every decision once. */
  decide(approvalId: string, status: "approved" | "rejected" | "expired", by = "owner", choice?: string): Approval | undefined {
    const a = this.store.getApproval(approvalId);
    if (!a || a.status !== "pending") return a;
    a.status = status; a.decidedAt = now();
    if (choice) a.choice = choice;
    this.store.saveApproval(a);
    this.store.audit(by, `approval.${status}`, `${a.tool}: ${a.action}`);
    this.waiters.get(approvalId)?.(a);
    this.waiters.delete(approvalId);
    for (const fn of this.decided) { try { fn(a); } catch { /* a listener never blocks a decision */ } }
    return a;
  }

  private decided = new Set<(a: Approval) => void>();
  /** 2.5: be told when any approval is decided (the memory keeper resolves its questions this way). */
  onDecided(fn: (a: Approval) => void) { this.decided.add(fn); return () => { this.decided.delete(fn); }; }
}
