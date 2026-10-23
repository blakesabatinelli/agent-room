import type Database from "better-sqlite3";

/**
 * 1.6 Quota ledger. One row per agent run (task runs and the orchestrator's own planner/judge calls), so usage can be
 * added up per subscription over any window. Vendors don't say how much quota is left; this is what the Room itself sent.
 */
export interface UsageRow {
  agentId: string;
  subscriptionId: string;
  at: number;
  tokensIn: number;
  tokensOut: number;
  runs: number;
  rateLimited: boolean;
  /** When the CLI said the limit lifts, or the hub's guess. */
  resetAt?: number;
  /** Rate-limit rows only: the hub's own estimate already said this subscription was at its limit. */
  predicted?: boolean;
  /** "task" = an agent doing a task or answering; "orchestrator" = planner, judge, memory and other JSON-only calls. */
  source: "task" | "orchestrator";
  taskId?: string;
  model?: string;
  /** Tokens were estimated from text length because the adapter reported none. */
  estimated?: boolean;
}

export class QuotaLedger {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, subscription_id TEXT NOT NULL, at INTEGER NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 1,
        rate_limited INTEGER NOT NULL DEFAULT 0, reset_at INTEGER, predicted INTEGER, source TEXT NOT NULL,
        task_id TEXT, model TEXT, estimated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS usage_sub_at ON usage(subscription_id, at);
      CREATE INDEX IF NOT EXISTS usage_limited ON usage(rate_limited, at);
      CREATE INDEX IF NOT EXISTS usage_task ON usage(task_id);
    `);
  }

  record(r: UsageRow) {
    this.db.prepare(`INSERT INTO usage (agent_id, subscription_id, at, tokens_in, tokens_out, runs, rate_limited, reset_at, predicted, source, task_id, model, estimated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.agentId, r.subscriptionId, r.at, Math.round(r.tokensIn), Math.round(r.tokensOut), r.runs, r.rateLimited ? 1 : 0, r.resetAt ?? null,
      r.predicted === undefined ? null : r.predicted ? 1 : 0, r.source, r.taskId ?? null, r.model ?? null, r.estimated ? 1 : 0);
  }

  /** Rows for one subscription with `at` in (since, until], oldest first. */
  since(subscriptionId: string, since: number, until = Number.MAX_SAFE_INTEGER): UsageRow[] {
    return (this.db.prepare("SELECT * FROM usage WHERE subscription_id=? AND at>? AND at<=? ORDER BY at ASC, id ASC").all(subscriptionId, since, until) as Raw[]).map(row);
  }

  /** 2.7: every run recorded for one task (all attempts and retries), oldest first. */
  byTask(taskId: string): UsageRow[] {
    return (this.db.prepare("SELECT * FROM usage WHERE task_id=? ORDER BY at ASC, id ASC").all(taskId) as Raw[]).map(row);
  }

  /** Every rate-limit failure since a time, oldest first. */
  rateLimited(since: number): UsageRow[] {
    return (this.db.prepare("SELECT * FROM usage WHERE rate_limited=1 AND at>=? ORDER BY at ASC, id ASC").all(since) as Raw[]).map(row);
  }

  /** How many times this task has been rate limited (how many agents it has already bounced off). */
  rateLimitsForTask(taskId: string): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM usage WHERE task_id=? AND rate_limited=1").get(taskId) as { n: number }).n;
  }
}

interface Raw {
  agent_id: string; subscription_id: string; at: number; tokens_in: number; tokens_out: number; runs: number; rate_limited: number;
  reset_at: number | null; predicted: number | null; source: "task" | "orchestrator"; task_id: string | null; model: string | null; estimated: number;
}
const row = (r: Raw): UsageRow => ({
  agentId: r.agent_id, subscriptionId: r.subscription_id, at: r.at, tokensIn: r.tokens_in, tokensOut: r.tokens_out, runs: r.runs,
  rateLimited: !!r.rate_limited, ...(r.reset_at !== null ? { resetAt: r.reset_at } : {}), ...(r.predicted !== null ? { predicted: !!r.predicted } : {}),
  source: r.source, ...(r.task_id ? { taskId: r.task_id } : {}), ...(r.model ? { model: r.model } : {}), ...(r.estimated ? { estimated: true } : {}),
});
