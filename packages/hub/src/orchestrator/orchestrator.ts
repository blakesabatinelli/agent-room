import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentStatus, Approval, AttemptLog, Author, Contract, Goal, GoalProgress, GoalState, Judgment, MemoryEntry, Message, OrchestratorSettings, Profile, Role, RoutingOutcome, RoutingRecord, RunUsage, SteerKind, Task, Verdict } from "@agent-room/shared";
import { SETTING_DEFAULTS } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { adapters, type RunResult } from "../adapters/index.js";
import { id, now, token } from "../util.js";
import type { Approvals } from "./approvals.js";
import { Floor, gate, gateText, normaliseCriteria, parseReport, pickProfile, profileText, resolveMentions, selfReportedDrift } from "./contract.js";
import { changedFiles, goalFolder, listFiles, outsideScope, runCheck, snapshot } from "./workspace.js";
import { extractJson } from "./json.js";
import { directPrompt, judgePrompt, memoryPrompt, planCard, planPrompt, recoverPrompt, replanPrompt, steerPrompt, summaryPrompt, tagPrompt, taskPrompt, verifyPrompt } from "./prompts.js";
import { MAX_TASKS, coverLeftovers, isTransient, ledgerMarkdown, newProgress, normaliseRequirements, readDeliverables, repairDeps, sameFeedback, validatePlan, writeLedger, type RawPlanTask } from "./ledger.js";
import { applyOwnerRating, recordOutcome } from "./scoring.js";
import { addUsage, closeRecord, decide, fixedDecision, openRecord, type RouteDecision } from "./routing.js";
import { quotaFor } from "../quota/index.js";
import { isRateLimit } from "../quota/limits.js";
import { quotaDecide, quotaLimited } from "../quota/router.js";
import { addFailure, classifyFailure, parseFailureCategory, type FailureEvidence } from "./failures.js";
import { Library, defaultLibraryRoot } from "../library/library.js";
import { FileBroker } from "../files/broker.js";
import { GoalSources, branchFor } from "../files/goalSource.js"; // 1.1
import { TaskWorkspaces, type TaskWorkspace, type WorkspaceHookContext, type WorkspaceHooks } from "./worktree.js";
import type { ControlFolder } from "../control/folder.js"; // 1.9
import { restoreTaskContext, writeTaskContext } from "../control/context.js"; // 1.9 x 1.4
import { CapacityGovernor } from "../capacity/governor.js";
import { detectHardware } from "../capacity/hardware.js";
import { cleanNeeds } from "../discovery/connectors.js"; // 1.3
import { needsGate, needsMessage, type NeedsGate } from "../discovery/routing.js"; // 1.3
import { juryLine, jurySummary, recordOwnerRating, review as juryReview, type JuryHost } from "../jury/index.js"; // 2.2
import { loadCommandIndex, plannerCommands } from "../commands/index.js"; // 2.6
import { buildInvocation, parseCommand, unknownReply, type Invocation } from "../commands/invoke.js"; // 2.6
import { learnedBlock, runRetro } from "../retro/index.js"; // 2.1

const firstLine = (e?: string) => (e ?? "unknown error").split("\n").find((l) => l.trim())?.slice(0, 300) ?? "unknown error";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Quick asks and chat skip the planning round trip entirely. */
export function isConversational(text: string) {
  const t = text.trim();
  if (t.length > 240 || t.includes("\n")) return false;
  return /\?\s*$/.test(t)
    || /^(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|great|nice|yes|no|sure|what|who|when|where|why|how|which|can you|could you|would you|is|are|do|does|did|should)\b/i.test(t);
}
const ORCH: Author = { kind: "orchestrator", id: "orchestrator", name: "Orchestrator" };
const SYS: Author = { kind: "system", id: "system", name: "System" };
const OPEN = (t: Task) => !["done", "failed", "cancelled"].includes(t.status);

export interface McpGrant { agentId: string; roomId?: string; taskId?: string; expiresAt?: number; hop?: number; /** 1.1: an external key pinned to one room: every room argument is ignored in favour of roomId */ locked?: boolean; /** 1.1: the external key behind this grant (for the audit log) */ tokenId?: string; /** 1.1: the folder this run works in; file tools aimed elsewhere are refused */ cwd?: string }

export interface OrchestratorOptions {
  dataDir: string;
  mcpUrl: () => string | undefined;
  rand?: () => number;
  /** Wait before retrying a task after a transient CLI failure (rate limit, timeout). */
  retryDelayMs?: number;
  /** Root of the document Library; defaults to ~/Agent Room/Library (or $AGENT_ROOM_LIBRARY). */
  libraryDir?: string;
  /** 1.4: git binary for task worktrees (default $AGENT_ROOM_GIT or "git"). A failing one makes tasks use folder copies. */
  gitBin?: string;
  /** 1.9: the control folder (rules, personas, permissions, scope as Markdown files). */
  control?: ControlFolder;
  /** 1.5: how much local work this machine takes at once. Defaults to what the hardware allows. */
  governor?: CapacityGovernor;
}

type PlanTask = RawPlanTask;
interface Plan { mode?: "direct" | "plan"; agent?: string; contract?: Partial<Contract> & { requirements?: unknown }; tasks?: PlanTask[] }

export class Orchestrator {
  private running = new Map<string, AbortController>(); // goalId -> controller
  /** Agents holding a task. Only the orchestrator puts an agent here, one task at a time. */
  private busy = new Set<string>();
  /** Agents answering a chat message or a tag. They take no new task until done. */
  private chatting = new Set<string>();
  private lanes = new Map<string, Promise<unknown>>();     // per-agent queue for chat/tag replies
  private ownerNotes = new Map<string, string[]>();        // goalId -> amendments
  /** Live runs, so one task can be interrupted without stopping the goal. */
  private taskRuns = new Map<string, { ctrl: AbortController; agentId: string; redirect?: string }>();
  /** Owner steering waiting to be picked up by a working agent via get_updates. */
  private steers = new Map<string, { at: number; text: string; delivered: boolean }[]>();
  /** Goals waiting on the owner to approve their plan. */
  private planWaiters = new Map<string, () => void>();
  private judgeTurn = 0;
  /** Who may speak in which room right now. */
  floor = new Floor();
  grants = new Map<string, McpGrant>();                    // MCP bearer token -> grant

  /** 0.4: the document Library (Markdown + front matter, indexed). */
  library: Library;
  /** 0.3 spike: folder grants, file reads, and diff-proposed writes. */
  files: FileBroker;
  /** 1.1: goals that work on a folder the owner granted (branch or private copy, approval of write-back). */
  goalSources: GoalSources;
  /** 1.4: every task attempt works in its own git worktree (or folder copy) cut from the goal folder. */
  workspaces: TaskWorkspaces;
  /** 1.4: hooks around each task's worktree (1.9 writes and restores the agent's context file here). */
  workspaceHooks: WorkspaceHooks = {};
  /** Worktree clean-ups in flight (stop/replan are synchronous callers); idle() waits for them. */
  private cleanups = new Set<Promise<unknown>>();
  /** 1.9: the control folder; undefined when the hub runs without one (most tests). */
  control?: ControlFolder;
  /** 1.5: limits for local work, from the hardware and the owner's overrides. */
  governor: CapacityGovernor;

  /** 1.2: the hub's data folder (the API server keeps local-pair.secret there). */
  get dataDir(): string { return this.opts.dataDir; }

  constructor(private store: Store, private approvals: Approvals, private opts: OrchestratorOptions) {
    this.library = new Library(store, opts.libraryDir ?? defaultLibraryRoot());
    // 1.1: the control folder's version history can never be granted to agents (it is read lazily: the control folder may be attached after this).
    this.files = new FileBroker(store, approvals, { extraProtected: () => (this.control ? [{ path: join(this.control.root, ".git"), because: "the Agent Room control folder's version history can't be shared with agents" }] : []) });
    this.goalSources = new GoalSources(this.files, store); // 1.1
    this.workspaces = new TaskWorkspaces({ dataDir: opts.dataDir, git: opts.gitBin, onSecurity: (action, detail) => store.audit("hub", action, detail) }); // 1.1: git config restored, hard links left out
    this.control = opts.control; // 1.9
    // 1.9 x 1.4: each task's worktree gets its agent's context file, built from the control folder's layers,
    // and it is taken back out before the work is merged so it never lands in the goal folder or the owner's repo.
    // (Read at call time, so a control folder attached after construction is used too.)
    this.workspaceHooks = {
      beforeRun: (c) => {
        const control = this.control; if (!control) return;
        const task = this.store.getTask(c.taskId), goal = this.store.getGoal(c.goalId), agent = this.store.getAgent(c.agentId);
        if (!task || !goal || !agent) return;
        const text = control.contextFor({ agentId: agent.id, roomSlug: control.slugFor(task.roomId), taskType: task.taskType, goal, task });
        writeTaskContext(c.path, agent.adapter, text);
      },
      beforeMerge: (c) => { if (this.control) restoreTaskContext(c.path); },
    };
    this.governor = opts.governor ?? new CapacityGovernor(store, detectHardware());
  }

  private cfg(): Required<OrchestratorSettings> {
    return { ...SETTING_DEFAULTS, ...this.store.getSettings() } as Required<OrchestratorSettings>;
  }

  // ---------- helpers
  private post(roomId: string, author: Author, text: string, type: "directive" | "agent" | "task_update" | "system" | "tool_call", taskId?: string, quiet = false, hop?: number) {
    // MEMORY: lines are a note to the orchestrator (harvested before posting), not part of the conversation.
    if (author.kind === "agent") text = text.replace(/^[ \t]*MEMORY:.*(?:\r?\n|$)/gim, "").trim() || text.trim();
    const mentions = [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1].toLowerCase());
    return this.store.addMessage({ roomId, author, text, type, mentions, taskId, ...(quiet ? { quiet: true } : {}), ...(hop ? { hop } : {}) });
  }
  /** Behind-the-scenes coordination: kept for the work log, hidden from the conversation. */
  private log(roomId: string, text: string, taskId?: string, type: "directive" | "task_update" = "directive") {
    return this.post(roomId, ORCH, text, type, taskId, true);
  }
  private working(roomId: string, agent: AgentConfig, active: boolean, label?: string) {
    this.store.emit("event", { type: "working", roomId, agentId: agent.id, label, active });
  }
  /** Run chat/tag replies for one agent one at a time, in order. */
  private lane<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lanes.get(agentId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.lanes.set(agentId, next.catch(() => undefined));
    return next;
  }
  /** Wait for in-flight chat/tag replies to settle (tests, shutdown). */
  async idle() {
    await Promise.allSettled([...this.cleanups]);
    for (let i = 0; i < 50; i++) {
      const all = [...this.lanes.values()];
      await Promise.allSettled(all); await sleep(5);
      if ([...this.lanes.values()].every((p) => all.includes(p))) return;
    }
  }

  /** Update a goal's running state (work-contract STATE.md). */
  private checkpoint(goalId: string, o: { decision?: string; next?: string } = {}) {
    const g = this.store.getGoal(goalId); if (!g) return;
    const st: GoalState = g.state ?? { decisions: [], nextAction: "" };
    if (o.decision) st.decisions = [...st.decisions, { at: now(), text: o.decision }].slice(-50);
    if (o.next !== undefined) st.nextAction = o.next;
    g.state = st; this.store.saveGoal(g);
    this.writeLedger(g);
  }

  // ---------- progress ledger (Magentic-One style: what we're doing vs. how it's going)
  private ledgerText(g: Goal) { return ledgerMarkdown(g, this.store.listTasks({ goalId: g.id }), this.store.listAgents()); }
  private lastLedger = new Map<string, string>();
  private writeLedger(g: Goal) {
    if (!g.folder) return;
    const md = this.ledgerText(g);
    if (this.lastLedger.get(g.id) === md) return;
    this.lastLedger.set(g.id, md); writeLedger(g.folder, md);
  }
  private progress(goalId: string, change?: (p: GoalProgress) => void): GoalProgress {
    const g = this.store.getGoal(goalId);
    if (!g) return newProgress();
    const st: GoalState = g.state ?? { decisions: [], nextAction: "" };
    const p = st.progress ?? newProgress();
    if (change) { change(p); st.progress = p; g.state = st; this.store.saveGoal(g); }
    return p;
  }
  /** Decisions every task must follow: the contract's, plus what agents reported as they worked. */
  private decisionsFor(g: Goal): string[] {
    return [...(g.contract?.decisions ?? []), ...(g.state?.shared ?? []).map((d) => `${d.text} (decided in "${d.taskTitle}")`)].slice(-30);
  }
  /** Stop and ask the owner. Their next message in the room answers and resumes the goal. */
  private waitForOwner(goalId: string, question: string) {
    const g = this.store.getGoal(goalId); if (!g) return;
    g.status = "paused";
    g.state = { ...(g.state ?? { decisions: [] }), nextAction: `Waiting on the owner: ${question}`, waitingOnOwner: question };
    this.store.saveGoal(g); this.writeLedger(g);
    this.post(g.roomId, SYS, `I need a decision from you before this can continue.\n\n${question}\n\nReply here and the work picks back up. Finished work is kept.`, "system");
  }

  /** Turn planner/recovery/verification task specs into stored tasks. Keys resolve within the batch. */
  private buildTasks(goal: Goal, raw: PlanTask[], agents: AgentConfig[], origin: Task["origin"], extraDeps: string[] = []): Task[] {
    const ids = new Set(agents.map((a) => a.id));
    const roles = new Set(["explorer", "researcher", "worker", "reviewer"]);
    const reqIds = new Set((this.store.getGoal(goal.id)?.contract?.requirements ?? []).map((r) => r.id));
    const keyToId = new Map(raw.map((r) => [r.key, id("task")]));
    return raw.map((r) => {
      const criteria = normaliseCriteria(r.criteria, r.acceptance ?? "");
      const deps = (r.dependsOn ?? []).map((k) => keyToId.get(k)).filter(Boolean) as string[];
      return {
        id: keyToId.get(r.key)!, roomId: goal.roomId, goalId: goal.id, title: r.title || "Untitled task", description: r.description || r.title || "",
        taskType: (r.taskType || "other").toLowerCase(), acceptance: criteria.map((c) => `${c.id}: ${c.text}`).join("; "),
        criteria, scope: r.scope, outOfScope: (r.outOfScope ?? []).filter(Boolean),
        owner: r.owner && ids.has(r.owner) ? r.owner : undefined,
        role: (r.role && roles.has(r.role) ? r.role : "worker") as Role,
        files: (r.files ?? []).filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()),
        output: r.output?.trim() || undefined,
        needs: cleanNeeds(r.needs), // 1.3: data sources this task needs; routing only considers agents that have them
        covers: (r.covers ?? []).filter((c) => reqIds.has(c)),
        origin,
        dependsOn: deps.length ? deps : extraDeps,
        status: "pending", attempts: 0, history: [], createdAt: now(), updatedAt: now(),
      } as Task;
    });
  }
  private addHistory(t: Task, agentId: string, outcome: AttemptLog["outcome"], note: string) {
    t.history = [...(t.history ?? []), { at: now(), agentId, outcome, note: note.slice(0, 300) }];
  }

  // ---------- agent readiness (cached so routing never picks a signed-out agent)
  private statusCache = new Map<string, AgentStatus>();
  async agentStatus(agent: AgentConfig, fresh = false): Promise<AgentStatus> {
    const c = this.statusCache.get(agent.id);
    if (!fresh && c && Date.now() - c.checkedAt < 60_000) return c;
    const practice = this.store.getKV("practice_mode", false);
    const st = practice ? { ready: true, state: "ready" as const, detail: "Practice agent" } : await adapters[agent.adapter].status(agent);
    const next: AgentStatus = { id: agent.id, ...st, checkedAt: Date.now() };
    const changed = !c || c.ready !== next.ready || c.state !== next.state || c.detail !== next.detail;
    this.statusCache.set(agent.id, next);
    if (changed) this.store.emit("event", { type: "agent_status", status: next });
    return next;
  }
  forgetStatus(agentId: string) { this.statusCache.delete(agentId); }
  async readyAgents(): Promise<AgentConfig[]> {
    const enabled = this.enabledAgents();
    const st = await Promise.all(enabled.map((a) => this.agentStatus(a)));
    return enabled.filter((_, i) => st[i].ready);
  }
  private agentAuthor(a: AgentConfig): Author { return { kind: "agent", id: a.id, name: a.name }; }
  private enabledAgents() { return this.store.listAgents().filter((a) => a.enabled); }
  private orchestratorAgent(): AgentConfig | undefined {
    const s = this.store.getSettings();
    return this.store.getAgent(s.orchestratorAgentId) ?? this.enabledAgents()[0];
  }
  private workspace(agentId: string, roomId: string) {
    const dir = join(this.opts.dataDir, "workspaces", agentId, roomId);
    mkdirSync(dir, { recursive: true }); return dir;
  }
  private grantFor(agentId: string, roomId?: string, taskId?: string, hop = 0, cwd?: string) {
    const t = token();
    // 1.1: a run's own key is locked to its room, and carries its worktree so approval_prompt can refuse file tools outside it.
    this.grants.set(t, { agentId, roomId, taskId, hop, expiresAt: now() + 2 * 3600_000, locked: !!roomId, cwd });
    return t;
  }

  async call(agent: AgentConfig, prompt: string, o: { jsonOnly?: boolean; roomId?: string; taskId?: string; signal?: AbortSignal; systemPrompt?: string; hop?: number; profile?: Profile; cwd?: string } = {}): Promise<RunResult> {
    const url = this.opts.mcpUrl();
    const cwd = o.cwd ?? this.workspace(agent.id, o.roomId ?? "_orchestrator");
    const grant = url && !o.jsonOnly ? { url, token: this.grantFor(agent.id, o.roomId, o.taskId, o.hop, cwd) } : undefined;
    const adapter = this.store.getKV("practice_mode", false) ? adapters.mock : adapters[agent.adapter];
    const res = await adapter.run({
      agent, prompt, jsonOnly: o.jsonOnly, signal: o.signal, systemPrompt: o.systemPrompt,
      cwd, dataDir: this.opts.dataDir, mcp: grant, roomId: o.roomId, taskId: o.taskId, // 1.1: dataDir keeps the hub's own files off limits to a confined run
      model: o.profile?.model, effort: o.profile?.effort,
      claimTimeoutMs: this.cfg().claimTimeoutMinutes * 60_000,
    });
    if (!res.ok) this.forgetStatus(agent.id); // re-check sign-in before routing to it again
    if (grant) this.grants.delete(grant.token);
    this.store.audit(agent.id, o.jsonOnly ? "orchestrator.call" : "agent.run", `${res.ok ? "ok" : "failed"} in ${res.durationMs}ms${o.profile ? ` (${o.profile.label})` : ""}`);
    if (!this.store.getKV("practice_mode", false)) quotaFor(this.store).recordRun(agent, res, { prompt, jsonOnly: o.jsonOnly, taskId: o.taskId, model: o.profile?.model }); // 1.6: usage ledger, rate-limit learning
    return res;
  }

  /** Planning and replanning use the agent's strongest worker; quick reads (steer, memory) its cheapest. */
  private async callJson<T>(prompt: string, prefer?: AgentConfig, signal?: AbortSignal, role: Role | "quick" | "lead" = "lead"): Promise<T | null> {
    const agent = prefer ?? this.orchestratorAgent();
    if (!agent) return null;
    const profile = role === "quick" ? pickProfile(agent, "explorer") : role === "lead" ? pickProfile(agent, "worker", 3) : pickProfile(agent, role);
    for (let i = 0; i < 2; i++) {
      const r = await this.call(agent, i ? prompt + "\n\nYour last reply was not valid JSON. Reply with the JSON object only." : prompt, { jsonOnly: true, signal, profile });
      const parsed = r.ok ? extractJson<T>(r.text) : null;
      if (parsed) return parsed;
    }
    return null;
  }

  // ---------- owner input
  async handleOwnerMessage(roomId: string, text: string, ownerName = "Blake", opts: { folderGrantId?: string } = {}) {
    const msg = this.store.addMessage({
      roomId, author: { kind: "human", id: "owner", name: ownerName }, text, type: "human",
      mentions: [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1].toLowerCase()),
    });
    const cmd = text.trim().toLowerCase();
    if (cmd === "/pause") return this.setPaused(roomId, true);
    if (cmd === "/resume") return this.setPaused(roomId, false);
    if (cmd === "/stop") return this.stopRoom(roomId);
    if (this.slashCommand(roomId, text)) return msg; // 2.6: /<agent>:<command> args, or an unknown /command

    // Direct-message room: the agent answers, nobody else is involved.
    const room = this.store.getRoom(roomId);
    const dm = room?.dmAgentId ? this.store.getAgent(room.dmAgentId) : undefined;
    if (dm) { void this.lane(dm.id, () => this.reply(roomId, dm, { from: "owner", text, hop: 0 })); return msg; }

    const tagged = resolveMentions(text, this.enabledAgents());
    const active = this.activeGoal(roomId);
    // Explicit steering commands: /redirect [@agent] text, /replan text
    const forced = /^\/redirect\b/i.test(text) ? "redirect" : /^\/replan\b/i.test(text) ? "replan" : undefined;
    const body = text.replace(/^\/(redirect|replan|goal)\s*/i, "").trim();
    if (active?.status === "awaiting_approval" && !tagged.length) {
      // The owner is answering the plan.
      const t = text.trim();
      if (/^(\/approve|approve[ds]?|go( ahead)?|looks good|lgtm|yes|yep|ship it|do it|start)\b[.!]*$/i.test(t)) this.decidePlan(active.id, "approve");
      else if (/^(\/cancel|cancel|never ?mind|scrap it|don't)\b/i.test(t)) this.decidePlan(active.id, "cancel");
      else this.decidePlan(active.id, "revise", body || t);
      return msg;
    }
    if (active?.state?.waitingOnOwner && !/^\/?stop\b/i.test(text.trim())) {
      // The orchestrator asked the owner something; this is the answer.
      this.amendContract(active, body || text);
      return msg;
    }
    if (active) {
      // A tag to an agent that isn't working on this goal is just a conversation with it.
      const working = this.inFlight(active.id);
      const steerable = !tagged.length || tagged.some((a) => working.some((t) => t.assignee === a.id));
      if (steerable || forced) { void this.steer(active, body, tagged, forced); return msg; }
    } else if (forced) {
      this.post(roomId, SYS, "Nothing is running to steer. Send it as a new request instead.", "system");
      return msg;
    }

    // Tagged agents answer, in the order tagged, each seeing the earlier replies.
    if (tagged.length) {
      for (const a of tagged) void this.lane(a.id, () => this.reply(roomId, a, { from: "owner", text, hop: 0 }));
      return msg;
    }
    void this.runGoal(roomId, body, { folderGrantId: opts.folderGrantId });
    return msg;
  }

  /**
   * 2.6: `/<agent>:<command> args` goes straight to that agent (no planning), with the skill invoked the way that agent supports.
   * A `/word` that is neither a room command nor an indexed command gets a short reply and reaches no agent.
   * Returns true when the message was handled here; room commands and ordinary text return false and carry on below.
   */
  private slashCommand(roomId: string, text: string): boolean {
    const p = parseCommand(text, loadCommandIndex(this.store));
    if (p.kind === "none" || p.kind === "room") return false;
    if (p.kind === "unknown") { this.post(roomId, SYS, unknownReply(p), "system"); return true; }
    const built = buildInvocation(p.entry, p.args);
    if (!built.ok) { this.post(roomId, SYS, built.error, "system"); return true; }
    this.store.audit("owner", "command.run", `/${p.entry.name} in ${roomId}`);
    void this.runCommand(roomId, text, p.entry.agentId, built.invocation);
    return true;
  }

  private async runCommand(roomId: string, text: string, agentId: string, inv: Invocation) {
    const ready = await this.readyAgents();
    const agent = ready.find((a) => a.id === agentId);
    if (!agent) {
      const a = this.store.getAgent(agentId);
      this.post(roomId, SYS, a?.enabled ? `${a.name} isn't connected right now, so /${inv.command.name} didn't run.` : `${a?.name ?? agentId} is switched off. Turn it on from the sidebar to use /${inv.command.name}.`, "system");
      return;
    }
    const goal: Goal = { id: id("goal"), roomId, text, status: "planning", createdAt: now() };
    this.store.saveGoal(goal);
    const ctrl = new AbortController();
    this.running.set(goal.id, ctrl);
    try { await this.lane(agent.id, () => this.answerDirect(goal, fixedDecision(this.store, agent, ready, "other", "command", 0), ctrl.signal, inv)); }
    finally { if (this.running.get(goal.id) === ctrl) this.running.delete(goal.id); }
  }

  private activeGoal(roomId: string) {
    return this.store.listGoals(roomId).find((g) => ["running", "planning", "paused", "awaiting_approval"].includes(g.status));
  }
  private inFlight(goalId: string) {
    return this.store.listTasks({ goalId }).filter((t) => ["running", "review", "revising", "waiting"].includes(t.status));
  }

  /**
   * The owner can steer at any time. A message sent while work runs is read as one of:
   * aside (answer it, don't touch the work), amend (pass it to the agents mid-task),
   * redirect (restart the affected tasks with it), replan (change direction), or stop.
   */
  async steer(goal: Goal, text: string, tagged: AgentConfig[] = [], forced?: SteerKind): Promise<SteerKind> {
    const tasks = this.inFlight(goal.id);
    const targets = tagged.length ? tasks.filter((t) => tagged.some((a) => a.id === t.assignee)) : tasks;
    const name = (aid?: string) => this.store.getAgent(aid ?? "")?.name ?? "the team";
    let kind: SteerKind = forced ?? "amend";
    let affected = targets;
    if (!forced) {
      const c = await this.callJson<{ kind?: SteerKind; tasks?: string[] }>(steerPrompt(text, goal.contract?.objective ?? goal.text,
        targets.map((t) => ({ id: t.id, title: t.title, agent: name(t.assignee), status: t.status })), tagged.map((a) => a.name).join(", ") || undefined), undefined, undefined, "quick");
      kind = c?.kind && ["aside", "amend", "redirect", "replan", "stop"].includes(c.kind) ? c.kind : /\?\s*$/.test(text) ? "aside" : "amend";
      if (c?.tasks?.length) affected = targets.filter((t) => c.tasks!.includes(t.id)).length ? targets.filter((t) => c.tasks!.includes(t.id)) : targets;
    }
    this.log(goal.roomId, `Owner steer read as ${kind}${affected.length && kind !== "aside" ? ` for ${affected.map((t) => `"${t.title}"`).join(", ")}` : ""}.`);
    const who = [...new Set(affected.map((t) => name(t.assignee)))].join(" and ") || "the team";

    switch (kind) {
      case "stop": this.stopRoom(goal.roomId); break;
      case "aside": {
        const busyIds = new Set([...this.busy, ...this.chatting]);
        const pick = tagged[0] ?? this.enabledAgents().find((a) => !busyIds.has(a.id) && a.id === this.store.getSettings().orchestratorAgentId)
          ?? this.enabledAgents().find((a) => !busyIds.has(a.id)) ?? this.orchestratorAgent();
        if (pick) void this.lane(pick.id, () => this.reply(goal.roomId, pick, { from: "owner", text, hop: 0, inProgress: this.progressBrief(goal.id) }));
        break;
      }
      case "amend":
        this.amendContract(goal, text, affected);
        this.post(goal.roomId, SYS, affected.some((t) => t.status === "running")
          ? `↪ Passed to ${who} mid-task. They'll work it in at their next check-in, and it's checked before anything is accepted.`
          : `↪ Added to the brief for ${who}.`, "system");
        break;
      case "redirect": {
        this.amendContract(goal, text, affected);
        for (const t of affected) this.redirectTask(t, text);
        this.post(goal.roomId, SYS, `↪ Restarting ${who}'s work with your change.`, "system");
        break;
      }
      case "replan":
        this.post(goal.roomId, SYS, "↪ Changing direction: replanning the remaining work. Finished results are kept.", "system");
        await this.changeDirection(goal, text);
        break;
    }
    return kind;
  }

  /** Short status of a goal for answering "how's it going?". */
  private progressBrief(goalId: string) {
    const g = this.store.getGoal(goalId); if (!g) return "";
    const name = (aid?: string) => this.store.getAgent(aid ?? "")?.name ?? "unassigned";
    return [`Objective: ${g.contract?.objective ?? g.text}`,
      ...this.store.listTasks({ goalId }).map((t) => `- "${t.title}": ${t.status}${t.assignee ? `, ${name(t.assignee)}` : ""}${t.attempts > 1 ? `, attempt ${t.attempts}` : ""}`),
      g.state?.nextAction ? `Next: ${g.state.nextAction}` : ""].filter(Boolean).join("\n");
  }

  /** Interrupt one running task; it restarts with the same agent and the owner's change. */
  private redirectTask(task: Task, text: string) {
    const run = this.taskRuns.get(task.id);
    if (run) { run.redirect = text; run.ctrl.abort(); return; }
    if (task.status === "revising" || task.status === "pending") {
      task.judgment = { score: 0, verdict: "revise", feedback: `Owner changed this before you started: ${text}`, judgeAgentId: "owner" };
      this.store.saveTask(task);
    }
  }

  /** Steer kind "replan": keep what's finished, stop the rest, plan again from here. */
  private async changeDirection(goal: Goal, text: string) {
    const g = this.store.getGoal(goal.id)!;
    this.running.get(goal.id)?.abort();
    for (const r of this.store.listTasks({ goalId: goal.id }).map((t) => this.taskRuns.get(t.id)).filter(Boolean)) r!.ctrl.abort();
    const tasks = this.store.listTasks({ goalId: goal.id });
    const done = tasks.filter((t) => t.status === "done");
    for (const t of tasks.filter(OPEN)) { t.status = "cancelled"; this.store.saveTask(t); }
    void this.dropWorktrees(g.id); // 1.4
    g.status = "superseded"; g.summary = `Owner changed direction: ${text}`;
    g.state = { ...(g.state ?? { decisions: [] }), nextAction: "Replaced by a new plan." };
    this.store.saveGoal(g);
    const notes = this.ownerNotes.get(goal.id) ?? [];
    this.ownerNotes.delete(goal.id);
    const next = [
      g.text,
      ...notes.map((n) => `Owner note: ${n}`),
      `Owner changed direction: ${text}`,
      done.length ? `Already finished (reuse it, don't redo it):\n${done.map((t) => `- ${t.title}: ${(t.result ?? "").slice(0, 600)}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    void this.runGoal(goal.roomId, next, { folderGrantId: goal.sourceGrantId }); // 1.1: the new plan keeps the folder
  }

  /** MCP get_updates: owner steering for the caller's current task since it started. */
  takeUpdates(grant: McpGrant): string {
    const task = this.store.getTask(grant.taskId ?? "")
      ?? this.store.listRooms().flatMap((r) => this.store.listTasks({ roomId: r.id })).find((t) => t.assignee === grant.agentId && t.status === "running");
    if (!task) return "No updates.";
    const fresh = (this.steers.get(task.id) ?? []).filter((x) => !x.delivered);
    fresh.forEach((x) => { x.delivered = true; });
    return fresh.length
      ? `The owner sent new instructions while you were working. They override earlier ones:\n${fresh.map((x) => `- ${x.text}`).join("\n")}`
      : "No updates. Carry on.";
  }

  /** Owner input during a goal amends the frozen contract. Only the owner can do this. */
  private amendContract(goal: Goal, note: string, affected?: Task[]) {
    for (const t of affected ?? this.inFlight(goal.id)) {
      if (t.status === "running" || t.status === "review") this.steers.set(t.id, [...(this.steers.get(t.id) ?? []), { at: now(), text: note, delivered: false }]);
    }
    const notes = this.ownerNotes.get(goal.id) ?? [];
    notes.push(note); this.ownerNotes.set(goal.id, notes);
    const g = this.store.getGoal(goal.id)!;
    if (g.contract) {
      g.contract = { ...g.contract, version: g.contract.version + 1, amendments: [...g.contract.amendments, { at: now(), text: note }] };
      this.store.saveGoal(g);
    }
    // Anyone waiting on the owner gets the answer and goes back to work.
    for (const t of this.store.listTasks({ goalId: goal.id }).filter((x) => x.status === "waiting")) {
      t.status = "revising"; t.judgment = { score: 0, verdict: "revise", feedback: `Owner replied: ${note}`, judgeAgentId: "owner" };
      this.store.saveTask(t);
    }
    this.log(goal.roomId, `Owner amended the work contract${g.contract ? ` (now v${g.contract.version})` : ""}: ${note.slice(0, 200)}`);
    this.checkpoint(goal.id, { decision: `Owner amendment: ${note.slice(0, 200)}` });
    this.resumeIfWaiting(goal.id, note);
  }

  /** The owner answered the question the goal stopped on: grant a bit more room and pick the work back up. */
  private resumeIfWaiting(goalId: string, answer: string) {
    const g = this.store.getGoal(goalId);
    if (!g?.state?.waitingOnOwner) return;
    const cfg = this.cfg();
    const p = g.state.progress ?? newProgress();
    p.goalReplans = Math.min(p.goalReplans, Math.max(0, cfg.maxGoalReplans - 1));
    p.stall = 0;
    if (p.runs >= (p.budget ?? cfg.maxTaskRuns)) p.budget = p.runs + Math.ceil(cfg.maxTaskRuns / 2);
    g.state = { ...g.state, waitingOnOwner: undefined, progress: p, nextAction: `Resuming with the owner's answer: ${answer.slice(0, 120)}` };
    g.status = "running";
    this.store.saveGoal(g);
    this.post(g.roomId, SYS, "↪ Got it. Picking the work back up with your answer.", "system");
    if (!this.running.has(goalId)) void this.advance(goalId);
  }

  /**
   * One agent answers a message: the owner's, or another agent's tag.
   * Replies are routed onward if they tag someone, up to the hop limit.
   */
  private async reply(roomId: string, agent: AgentConfig, o: { from: string; text: string; hop: number; inProgress?: string }): Promise<string | undefined> {
    const hops = this.cfg().maxAgentHops;
    this.chatting.add(agent.id);
    this.floor.give(agent.id, roomId);
    this.working(roomId, agent, true, "replying");
    const agents = this.enabledAgents();
    const asker = agents.find((a) => a.id === o.from);
    const prompt = asker
      ? tagPrompt(asker.name, o.text, this.conversation(roomId), this.store.listShared(roomId), this.store.listPrivate(agent.id), agents, agent.id, hops - o.hop - 1)
      : directPrompt(this.conversation(roomId), this.store.listShared(roomId), this.store.listPrivate(agent.id), [], agents, agent.id, o.inProgress);
    const res = await this.call(agent, prompt, { roomId, hop: o.hop + (asker ? 1 : 0) });
    this.working(roomId, agent, false);
    this.chatting.delete(agent.id);
    if (!res.ok) {
      this.post(roomId, SYS, `${agent.name} couldn't reply: ${firstLine(res.error)}`, "system");
      return undefined;
    }
    const hop = o.hop + (asker ? 1 : 0);
    const m = this.post(roomId, this.agentAuthor(agent), res.text, "agent", undefined, false, hop);
    this.harvestMemory(agent.id, roomId, res.text);
    // Don't bounce straight back to whoever asked: the reply already goes to them.
    this.routeTags(m, hop, asker ? [asker.id] : []);
    return res.text;
  }

  /** An agent's message tagged other agents: each tagged agent gets a turn to answer. */
  private routeTags(m: Message, hop: number, skip: string[] = []) {
    if (m.author.kind !== "agent") return;
    const targets = resolveMentions(m.text, this.enabledAgents()).filter((a) => a.id !== m.author.id && !skip.includes(a.id));
    if (!targets.length) return;
    if (hop >= this.cfg().maxAgentHops) {
      this.post(m.roomId, SYS, `The agents have gone back and forth ${hop} times on this. Over to you: reply here or tag one of them.`, "system");
      return;
    }
    for (const a of targets) {
      this.log(m.roomId, `${m.author.name} tagged ${a.name}.`);
      void this.lane(a.id, () => this.reply(m.roomId, a, { from: m.author.id, text: m.text, hop }));
    }
  }

  /** May this agent speak in this room right now? */
  mayPost(agentId: string, roomId: string): { ok: boolean; why?: string } {
    const room = this.store.getRoom(roomId);
    if (!room) return { ok: false, why: "Room not found." };
    if (room.dmAgentId === agentId) return { ok: true };
    if (this.floor.has(agentId, roomId)) return { ok: true };
    if (this.store.listTasks({ roomId }).some((t) => t.assignee === agentId && ["running", "review"].includes(t.status))) return { ok: true };
    return { ok: false, why: "Not your turn: you can post here only while you hold an assignment in this room or after someone tags you. Work comes from wait_for_assignment; don't pick up work from the room yourself." };
  }

  /** Which room an MCP call is about: explicit, from the grant, or where the agent holds work. */
  private roomFor(grant: McpGrant, roomId?: string) {
    return roomId ?? grant.roomId ?? this.store.getTask(grant.taskId ?? "")?.roomId
      ?? this.store.listRooms().flatMap((r) => this.store.listTasks({ roomId: r.id }))
        .find((t) => t.assignee === grant.agentId && t.status === "running")?.roomId;
  }

  /** MCP post_message: gated by the floor, then routed like any agent message. */
  agentPost(grant: McpGrant, text: string, roomId?: string): { ok: boolean; why?: string } {
    const a = this.store.getAgent(grant.agentId);
    const rid = this.roomFor(grant, roomId);
    if (!a || !rid) return { ok: false, why: "Room or agent not found. You can post only while you hold an assignment or after being tagged." };
    const gate = this.mayPost(a.id, rid);
    if (!gate.ok) { this.store.audit(a.id, "post.denied", text.slice(0, 200)); return gate; }
    const m = this.post(rid, this.agentAuthor(a), text, "agent", grant.taskId, false, grant.hop);
    this.routeTags(m, grant.hop ?? 0);
    return { ok: true };
  }

  /** MCP ask_agent: ask one agent a question and wait for the answer. */
  async askAgent(grant: McpGrant, target: string, question: string, roomId?: string): Promise<string> {
    const asker = this.store.getAgent(grant.agentId);
    const agent = resolveMentions(`@${target.replace(/^@/, "")}`, this.enabledAgents())[0];
    const rid = this.roomFor(grant, roomId);
    if (!asker || !rid) return "Room not found. Pass the roomId from your assignment.";
    if (!agent) return `No agent called "${target}". Agents here: ${this.enabledAgents().map((a) => "@" + a.id).join(", ")}.`;
    if (agent.id === asker.id) return "You can't ask yourself.";
    const hop = grant.hop ?? 0;
    if (hop >= this.cfg().maxAgentHops) return "This thread has gone back and forth enough. Continue without it, or report STATUS: needs_input.";
    const gate = this.mayPost(asker.id, rid);
    if (!gate.ok) return gate.why!;
    this.post(rid, this.agentAuthor(asker), `@${agent.id} ${question}`, "agent", grant.taskId, false, hop);
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      this.lane(agent.id, () => this.reply(rid, agent, { from: asker.id, text: question, hop })),
      new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), 10 * 60_000); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    return answer ?? `${agent.name} didn't answer in time. Continue without it, or report STATUS: needs_input.`;
  }

  /** Recent visible conversation, oldest first, for conversational prompts. */
  private conversation(roomId: string) {
    return this.store.listMessages(roomId, 40).filter((m) => !m.quiet).slice(-20)
      .map((m) => `${m.author.name}: ${m.text}`).join("\n");
  }

  setPaused(roomId: string, paused: boolean) {
    const room = this.store.getRoom(roomId); if (!room) return;
    room.paused = paused; this.store.saveRoom(room);
    this.post(roomId, SYS, paused ? "Room paused. Running tasks will finish; nothing new starts." : "Room resumed.", "system");
  }

  stopRoom(roomId: string) {
    for (const g of this.store.listGoals(roomId)) {
      const c = this.running.get(g.id);
      if (c) { c.abort(); this.running.delete(g.id); }
      for (const t of this.store.listTasks({ goalId: g.id })) this.taskRuns.get(t.id)?.ctrl.abort();
      if (g.status === "running" || g.status === "planning" || g.status === "paused") {
        g.status = "failed"; g.summary = "Stopped by owner."; this.store.saveGoal(g);
        for (const t of this.store.listTasks({ goalId: g.id })) {
          if (OPEN(t)) { t.status = "cancelled"; this.store.saveTask(t); }
        }
        void this.dropWorktrees(g.id); // 1.4
      }
    }
    for (const a of this.enabledAgents()) this.floor.take(a.id, roomId);
    this.post(roomId, SYS, "Stopped all work in this room.", "system");
  }

  // ---------- goals
  async runGoal(roomId: string, text: string, opts: { folderGrantId?: string } = {}): Promise<Goal> {
    const goal: Goal = { id: id("goal"), roomId, text, status: "planning", createdAt: now() };
    // 1.1: a goal on a granted folder. The work lands on agent-room/<goal> (git) or comes back as an approval (anything else).
    const src = opts.folderGrantId ? this.goalSources.usable(opts.folderGrantId, roomId) : undefined;
    if (opts.folderGrantId && src?.ok) { goal.sourceGrantId = opts.folderGrantId; goal.sourceBranch = branchFor(goal.id); }
    this.store.saveGoal(goal);
    return this.advance(goal.id);
  }

  /**
   * Drive a goal forward from whatever state it is in: planning, waiting for the owner to
   * approve the plan, or running. New goals start here, and so do goals picked back up after
   * the hub restarts.
   */
  async advance(goalId: string): Promise<Goal> {
    const ctrl = new AbortController();
    this.running.set(goalId, ctrl);
    try {
      for (let guard = 0; guard < 20 && !ctrl.signal.aborted; guard++) {
        const goal = this.store.getGoal(goalId);
        if (!goal) break;
        if (goal.status === "planning") { await this.planStage(goal, ctrl.signal); continue; }
        if (goal.status === "awaiting_approval") { await this.awaitPlanDecision(goal, ctrl.signal); continue; }
        if (goal.status === "running" || goal.status === "paused") { await this.drive(goal, ctrl.signal); break; }
        break; // done, failed, superseded
      }
      return this.store.getGoal(goalId)!;
    } finally {
      if (this.running.get(goalId) === ctrl) this.running.delete(goalId);
    }
  }

  private needsApproval(tasks: Task[]) {
    const mode = this.cfg().planApproval;
    if (mode === "always") return true;
    if (mode === "never") return false;
    return tasks.length >= 3 || tasks.some((t) => t.criteria?.some((c) => c.check));
  }

  /** Plan the goal: answer directly, or write a contract and tasks (then maybe ask for approval). */
  private async planStage(goal: Goal, signal: AbortSignal) {
    const roomId = goal.roomId, text = goal.text;
    const agents = await this.readyAgents();
    if (!agents.length) {
      goal.status = "failed"; goal.summary = "No agents are connected."; this.store.saveGoal(goal);
      this.post(roomId, SYS, this.enabledAgents().length
        ? "None of your agents are connected right now. Open an agent in the sidebar to sign it in."
        : "No agents are switched on. Add or enable one from the sidebar.", "system");
      return;
    }
    const notes = this.ownerNotes.get(goal.id) ?? [];
    // One connected agent, or a quick ask: no planning round trip, it just answers.
    const eps = this.store.getSettings().explorationRate;
    if (agents.length === 1 && !notes.length) { await this.answerDirect(goal, fixedDecision(this.store, agents[0], [], "other", "only_candidate", eps), signal); return; }
    const orch = agents.find((a) => a.id === this.store.getSettings().orchestratorAgentId) ?? agents[0];
    if (isConversational(text) && !notes.length) {
      const pick = quotaDecide(this.store, agents, "other", eps, [], this.opts.rand) ?? fixedDecision(this.store, orch, agents, "other", "only_candidate", eps); // 1.6: quota-aware pool
      await this.answerDirect(goal, pick, signal); return;
    }
    this.store.emit("event", { type: "working", roomId, agentId: "orchestrator", label: "planning", active: true });
    const folderNote = this.goalSources.note(goal); // 1.1: tell the planner about the granted folder (label, read/write)
    const plan = await this.callJson<Plan>(
      planPrompt(text + folderNote, agents, this.store.listShared(roomId), notes, this.conversation(roomId), this.store.listScores(), orch.name, [], undefined, plannerCommands(loadCommandIndex(this.store), agents.map((a) => a.id), text)), orch, signal, // 2.6
    );
    this.store.emit("event", { type: "working", roomId, agentId: "orchestrator", active: false });
    if (signal.aborted) return;
    if (!notes.length && (plan?.mode === "direct" || (plan && !plan.tasks?.length))) {
      const named = agents.find((a) => a.id === plan?.agent && !quotaLimited(this.store, a.id)); // 1.6: not an agent that is out of quota
      const pick = named ? fixedDecision(this.store, named, agents, "other", "planner_choice", 0)
        : quotaDecide(this.store, agents, "other", 0, [], this.opts.rand) ?? fixedDecision(this.store, agents[0], agents, "other", "only_candidate", 0);
      await this.answerDirect(goal, pick, signal); return;
    }

    let current = plan;
    let raw: PlanTask[] = current?.tasks?.length ? current.tasks
      : [{ key: "t1", title: text.slice(0, 80), description: text, output: "your answer, in your reply", taskType: "other", acceptance: "Fully addresses the goal.", dependsOn: [] }];
    const agentIds = new Set(agents.map((a) => a.id));
    const reqsOf = (pl: Plan | null) => normaliseRequirements(pl?.contract?.requirements, pl?.contract?.deliverables ?? [], pl?.contract?.objective || text);
    // Check the plan before anyone works on it; hand problems back to the planner once.
    let problems = validatePlan(raw, reqsOf(current), agentIds);
    if (problems.length && current?.tasks?.length) {
      this.log(roomId, `Plan needs fixing before work starts: ${problems.join(" ")}`);
      this.store.emit("event", { type: "working", roomId, agentId: "orchestrator", label: "planning", active: true });
      const fixed = await this.callJson<Plan>(planPrompt(text + folderNote, agents, this.store.listShared(roomId), notes, this.conversation(roomId), this.store.listScores(), orch.name, problems, JSON.stringify(current), plannerCommands(loadCommandIndex(this.store), agents.map((a) => a.id), text)), orch, signal); // 2.6
      this.store.emit("event", { type: "working", roomId, agentId: "orchestrator", active: false });
      if (signal.aborted) return;
      if (fixed?.tasks?.length) { current = fixed; raw = fixed.tasks; problems = validatePlan(raw, reqsOf(current), agentIds); }
    }
    const requirements = reqsOf(current);
    // Whatever is still wrong gets a safe mechanical repair instead of a dropped task or a stuck goal.
    if (raw.length > MAX_TASKS) raw = raw.slice(0, MAX_TASKS);
    repairDeps(raw);
    coverLeftovers(raw, requirements);
    if (problems.length) this.log(roomId, `Repaired the plan automatically: ${problems.slice(0, 4).join(" ")}`);
    const draft = this.store.getGoal(goal.id)!;
    draft.contract = { ...(draft.contract ?? { objective: text, constraints: [], deliverables: [], outOfScope: [], version: 0, lockedAt: now(), amendments: [] }), requirements };
    this.store.saveGoal(draft);
    const tasks = this.buildTasks(goal, raw, agents, "plan");
    const c = current?.contract ?? {};
    const g = this.store.getGoal(goal.id)!;
    g.folder = goalFolder(this.opts.dataDir, goal.id);
    g.contract = {
      objective: c.objective || text, constraints: c.constraints ?? [], deliverables: c.deliverables ?? [],
      outOfScope: c.outOfScope ?? [], version: 1 + (g.contract?.version ?? 0), lockedAt: now(),
      amendments: notes.map((n) => ({ at: now(), text: n })),
      requirements, decisions: (c.decisions ?? []).filter((d) => typeof d === "string" && d.trim()).slice(0, 15),
    };
    g.state = { decisions: [...(g.state?.decisions ?? []), { at: now(), text: `Plan written: ${tasks.length} tasks for ${requirements.length} requirements.` }], nextAction: "", progress: newProgress() };
    tasks.forEach((t) => this.store.saveTask(t));
    const name = (aid?: string) => agents.find((a) => a.id === aid)?.name ?? "best available";
    const prof = (t: Task) => { const a = agents.find((x) => x.id === t.owner); return a ? profileText(pickProfile(a, t.role)) : "best fit"; };
    this.log(roomId, `Work contract v${g.contract.version}: ${g.contract.objective}\n${tasks.map((t, i) => `${i + 1}. ${t.title} → ${name(t.owner)} as ${t.role} (${prof(t)}, ${t.criteria!.length} checks)`).join("\n")}`);

    if (this.needsApproval(tasks)) {
      g.status = "awaiting_approval";
      g.state.nextAction = "Waiting for the owner to approve the plan.";
      this.store.saveGoal(g);
      this.store.addMessage({ roomId, author: SYS, type: "system", text: planCard(g.contract, tasks, agents, prof), mentions: [], planGoalId: g.id });
      return;
    }
    g.status = "running";
    g.state.nextAction = `Start ${tasks.filter((t) => !t.dependsOn.length).map((t) => `"${t.title}"`).join(", ")}.`;
    this.store.saveGoal(g);
  }

  private awaitPlanDecision(goal: Goal, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const done = () => { this.planWaiters.delete(goal.id); signal.removeEventListener("abort", done); resolve(); };
      if (this.store.getGoal(goal.id)?.status !== "awaiting_approval") return resolve();
      this.planWaiters.set(goal.id, done);
      signal.addEventListener("abort", done);
    });
  }

  /** The owner's answer to a plan: approve it, ask for changes, or cancel. */
  decidePlan(goalId: string, decision: "approve" | "revise" | "cancel", text = "") {
    const g = this.store.getGoal(goalId);
    if (!g || g.status !== "awaiting_approval") return { ok: false, why: "That plan isn't waiting for approval." };
    const tasks = this.store.listTasks({ goalId });
    if (decision === "approve") {
      g.status = "running"; g.approvedAt = now();
      g.state = { ...(g.state ?? { decisions: [] }), decisions: [...(g.state?.decisions ?? []), { at: now(), text: "Owner approved the plan." }],
        nextAction: `Start ${tasks.filter((t) => !t.dependsOn.length).map((t) => `"${t.title}"`).join(", ")}.` };
      this.store.saveGoal(g);
      this.post(g.roomId, SYS, "✓ Plan approved. Work is starting.", "system");
    } else if (decision === "revise") {
      const notes = this.ownerNotes.get(goalId) ?? [];
      notes.push(text); this.ownerNotes.set(goalId, notes);
      for (const t of tasks) this.store.deleteTask(t.id);
      g.status = "planning";
      g.state = { ...(g.state ?? { decisions: [] }), decisions: [...(g.state?.decisions ?? []), { at: now(), text: `Owner asked for plan changes: ${text.slice(0, 200)}` }], nextAction: "Rewriting the plan." };
      this.store.saveGoal(g);
      this.post(g.roomId, SYS, "↪ Rewriting the plan with your changes.", "system");
    } else {
      for (const t of tasks) { t.status = "cancelled"; this.store.saveTask(t); }
      g.status = "failed"; g.summary = "Plan cancelled by owner."; this.store.saveGoal(g);
      this.post(g.roomId, SYS, "Plan cancelled. Nothing was started.", "system");
    }
    this.planWaiters.get(goalId)?.();
    return { ok: true };
  }

  /**
   * After a restart, pick running work back up. Tasks that were mid-run start again with the
   * same agent; nothing counts against them. Plans waiting for approval keep waiting.
   */
  recover() {
    const resumed: Goal[] = [];
    for (const room of this.store.listRooms()) {
      for (const g of this.store.listGoals(room.id).filter((x) => ["planning", "awaiting_approval", "running", "paused"].includes(x.status))) {
        const tasks = this.store.listTasks({ goalId: g.id });
        if (!this.cfg().autoResume) {
          for (const t of tasks.filter(OPEN)) { t.status = "cancelled"; this.store.saveTask(t); }
          g.status = "failed"; g.summary = "Interrupted by a restart."; this.store.saveGoal(g);
          void this.dropWorktrees(g.id); // 1.4
          this.post(room.id, SYS, `"${g.text.slice(0, 80)}" stopped when the hub restarted.`, "system");
          continue;
        }
        if (g.contract?.amendments.length) this.ownerNotes.set(g.id, g.contract.amendments.map((a) => a.text));
        for (const t of tasks.filter((x) => x.status === "running" || x.status === "review")) {
          t.attempts = Math.max(0, t.attempts - 1);
          t.status = t.assignee ? "revising" : "pending";
          t.judgment = { score: 0, verdict: "revise", feedback: "The hub restarted while you were on this. Pick it up again; check the shared folder for anything you already saved.", judgeAgentId: "system" };
          this.addHistory(t, "system", "redirect", "hub restarted");
          closeRecord(this.store, t.routingId, { outcome: "interrupted", failureNote: "hub restarted" });
          t.routingId = undefined;
          this.store.saveTask(t);
        }
        if (g.state?.waitingOnOwner) {
          this.post(room.id, SYS, `Still waiting on you for "${(g.contract?.objective ?? g.text).slice(0, 100)}": ${g.state.waitingOnOwner}`, "system");
        } else if (g.status !== "awaiting_approval") {
          const done = tasks.filter((t) => t.status === "done").length;
          this.post(room.id, SYS, `↻ Picked up where we left off after a restart: "${(g.contract?.objective ?? g.text).slice(0, 100)}"${tasks.length ? ` (${done} of ${tasks.length} tasks done)` : ""}.`, "system");
        }
        this.checkpoint(g.id, { decision: "Resumed after a hub restart." });
        resumed.push(g);
        void this.advance(g.id);
      }
    }
    return resumed;
  }

  /** Conversational fast path: one agent replies, no plan, judge or summary. */
  private async answerDirect(goal: Goal, route: RouteDecision, signal: AbortSignal, command?: Invocation): Promise<Goal> {
    const agent = route.agent;
    const task: Task = {
      id: id("task"), roomId: goal.roomId, goalId: goal.id, title: goal.text.slice(0, 80), description: goal.text,
      taskType: "other", acceptance: "Answers the owner.", dependsOn: [], assignee: agent.id, owner: agent.id,
      status: "running", attempts: 1, createdAt: now(), updatedAt: now(),
      ...(command ? { command: command.command } : {}), // 2.6: the skill this task was started with
    };
    task.routingId = openRecord(this.store, route, task, goal.text, "direct").id;
    this.store.saveTask(task);
    goal.status = "running"; this.store.saveGoal(goal);
    this.log(goal.roomId, command ? `Routed to ${agent.name} by /${command.command.name}.` : `Routed to ${agent.name} directly.`, task.id);
    this.busy.add(agent.id);
    this.governor.start(task.id, agent); // 1.5: counted, never refused (the owner asked)
    this.floor.give(agent.id, goal.roomId);
    this.working(goal.roomId, agent, true, "replying");
    let convo = this.conversation(goal.roomId);
    if (!convo.includes(goal.text)) convo += `${convo ? "\n" : ""}Owner: ${goal.text}`;
    const res = await this.call(agent,
      command ? command.prompt : // 2.6: the skill invocation itself (a Claude Code `/command` has to start the prompt)
      directPrompt(convo, this.store.listShared(goal.roomId), this.store.listPrivate(agent.id), this.ownerNotes.get(goal.id) ?? [], this.enabledAgents(), agent.id),
      { roomId: goal.roomId, taskId: task.id, signal });
    this.working(goal.roomId, agent, false);
    this.busy.delete(agent.id);
    this.governor.release(task.id);
    const ran = { usage: res.usage, seconds: res.durationMs / 1000, modelVersion: res.model };
    if (signal.aborted) { closeRecord(this.store, task.routingId, { ...ran, outcome: "interrupted" }); return goal; }
    recordOutcome(this.store, agent.id, task.taskType, { seconds: res.durationMs / 1000, failed: !res.ok, revision: false }, res.model /* 2.4 */);
    if (res.ok) closeRecord(this.store, task.routingId, { ...ran, outcome: "answered" });
    else closeRecord(this.store, task.routingId, { ...ran, outcome: "run_failed", ...this.tagFailure(task, agent.id, { kind: "run_error" }, firstLine(res.error)) });
    if (res.ok) {
      task.result = res.text; task.status = "done";
      const m = this.post(goal.roomId, this.agentAuthor(agent), res.text, "agent", task.id);
      this.harvestMemory(agent.id, goal.roomId, res.text);
      this.routeTags(m, 0);
    } else {
      task.status = "failed";
      this.post(goal.roomId, SYS, `${agent.name} couldn't reply: ${firstLine(res.error)}`, "system", task.id);
    }
    this.store.saveTask(task);
    goal.status = res.ok ? "done" : "failed"; goal.summary = res.ok ? res.text.slice(0, 2000) : res.error; this.store.saveGoal(goal);
    this.ownerNotes.delete(goal.id);
    return goal;
  }

  /**
   * The inner loop. Each pass: recover from anything that failed for good, check the goal is still moving,
   * start whatever is ready, and when nothing is left, verify the goal as a whole before calling it done.
   */
  private async drive(goal: Goal, signal: AbortSignal) {
    const inflight = new Map<string, Promise<void>>();
    const cfg = this.cfg();
    while (!signal.aborted) {
      const g = this.store.getGoal(goal.id);
      if (!g || g.state?.waitingOnOwner) break; // paused for a decision; the owner's reply restarts it
      this.writeLedger(g);
      let tasks = this.store.listTasks({ goalId: goal.id });

      // Outer loop 1: a task failed for good. Find another route to its requirements before giving up on them.
      const lost = tasks.filter((t) => t.status === "failed" && !t.recovered);
      if (lost.length && !inflight.size) {
        const ok = await this.recoverGoal(g, lost, `"${lost.map((t) => t.title).join('", "')}" failed after every retry.`, signal);
        if (signal.aborted) break;
        if (!ok) break;
        continue;
      }
      // Outer loop 2: nothing accepted for a while. Re-plan the stuck part rather than grinding on it.
      const p = this.progress(goal.id);
      if (p.stall >= cfg.stallLimit && !inflight.size) {
        const stuck = tasks.filter((t) => OPEN(t) && t.status !== "waiting" && (t.history ?? []).some((h) => h.outcome !== "ok"));
        if (stuck.length) {
          const ok = await this.recoverGoal(g, stuck, `${p.stall} reviews in a row accepted nothing.`, signal);
          if (signal.aborted) break;
          if (!ok) break;
          continue;
        }
        this.progress(goal.id, (x) => { x.stall = 0; });
      }
      tasks = this.store.listTasks({ goalId: goal.id });
      const byId = new Map(tasks.map((t) => [t.id, t]));
      // Only failures already routed around (or given up on with the owner's say-so) cascade.
      for (const t of tasks) {
        if (t.status === "pending" && t.dependsOn.some((d) => ["failed", "cancelled"].includes(byId.get(d)?.status ?? ""))) {
          t.status = "cancelled"; this.store.saveTask(t);
        }
      }
      const open = tasks.filter(OPEN);
      if (!open.length && !inflight.size) {
        // Done means verified: the whole goal is checked against its requirements, gaps become new tasks.
        if (await this.verifyGoal(goal, signal)) continue;
        break;
      }

      const room = this.store.getRoom(goal.roomId);
      if (!room?.paused) {
        const ready = open.filter((t) => (t.status === "pending" || t.status === "revising") && !inflight.has(t.id)
          && t.dependsOn.every((d) => byId.get(d)?.status === "done"));
        const budget = p.budget ?? cfg.maxTaskRuns;
        if (ready.length && p.runs >= budget && !inflight.size) {
          this.waitForOwner(goal.id, `This goal has used its budget of ${budget} task runs and isn't finished.\n${this.ledgerText(g).split("## Tasks")[1]?.split("##")[0]?.trim() ?? ""}\nSay "keep going" to allow more runs, or tell me what to change.`);
          break;
        }
        const live = ready.length ? new Set((await this.readyAgents()).map((a) => a.id)) : new Set<string>();
        for (const t of ready) {
          if (this.progress(goal.id).runs + inflight.size >= budget) break;
          const agent = this.assign(t, live, g.text);
          if (!agent) continue;
          const pr = this.runTask(goal, t, agent, signal).finally(() => { inflight.delete(t.id); this.busy.delete(agent.id); this.governor.release(t.id); });
          inflight.set(t.id, pr);
        }
      }
      if (inflight.size) await Promise.race([...inflight.values(), sleep(1000)]);
      else await sleep(500); // paused, waiting on the owner, or waiting for a free agent
    }
    await Promise.allSettled(inflight.values());
    if (signal.aborted || this.store.getGoal(goal.id)?.state?.waitingOnOwner) return;
    await this.finish(goal);
    // 2.1 HOOK: the retro for a goal that ended (lessons per agent and task type, playbooks). Never throws; skips superseded goals.
    await runRetro({ store: this.store, control: this.control, callJson: (p, role) => this.callJson(p, undefined, undefined, role), post: (t) => this.log(goal.roomId, t) }, goal.id);
  }

  /**
   * Route around a dead end: replacement tasks for the stuck ones, keeping finished work.
   * Bounded by maxGoalReplans; past that, or if the planner says only the owner can decide, ask the owner.
   * Returns false when the goal is now waiting on the owner.
   */
  private async recoverGoal(goal: Goal, stuck: Task[], why: string, signal: AbortSignal): Promise<boolean> {
    const cfg = this.cfg();
    const p = this.progress(goal.id);
    const unmet = () => {
      const covers = [...new Set(stuck.flatMap((t) => t.covers ?? []))];
      return covers.length ? ` It was meant to deliver ${covers.join(", ")}.` : "";
    };
    if (p.goalReplans >= cfg.maxGoalReplans) {
      this.waitForOwner(goal.id, `${why}${unmet()} I've already tried ${p.goalReplans} other approach${p.goalReplans === 1 ? "" : "es"}.\nLast problem: ${stuck[0]?.history?.at(-1)?.note?.slice(0, 300) ?? "unknown"}\nTell me how you'd like to proceed: a different approach, a narrower goal, or the missing information.`);
      return false;
    }
    const agents = await this.readyAgents();
    if (!agents.length) { this.waitForOwner(goal.id, "No agents are connected, so the remaining work can't continue. Connect one and reply here."); return false; }
    this.store.emit("event", { type: "working", roomId: goal.roomId, agentId: "orchestrator", label: "replanning", active: true });
    const notes = this.ownerNotes.get(goal.id) ?? [];
    const r = await this.callJson<{ action?: string; question?: string; approach?: string; tasks?: PlanTask[] }>(
      recoverPrompt(goal.text + (notes.length ? `\nOwner notes: ${notes.join("; ")}` : ""), this.store.getGoal(goal.id)?.contract, this.ledgerText(this.store.getGoal(goal.id)!), stuck, agents, why), undefined, signal);
    this.store.emit("event", { type: "working", roomId: goal.roomId, agentId: "orchestrator", active: false });
    if (signal.aborted) return false;
    this.progress(goal.id, (x) => { x.goalReplans += 1; x.stall = 0; });
    if (r?.action === "ask_owner" && r.question) { this.waitForOwner(goal.id, r.question); return false; }
    const raw = (r?.tasks ?? []).slice(0, 4);
    // Live tasks still waiting on a stuck one move to the replacements.
    for (const t of stuck) {
      if (OPEN(t)) { this.taskRuns.get(t.id)?.ctrl.abort(); t.status = "cancelled"; }
      t.recovered = true; this.store.saveTask(t);
      await this.discardWorktree(goal, t); // 1.4
    }
    if (!raw.length) {
      // No new route: retry the stuck tasks once more, a tier up, rather than ending the goal quietly.
      for (const t of stuck) {
        t.status = "pending"; t.attempts = 0; t.triedBy = []; t.assignee = undefined; t.recovered = false; t.judgment = undefined;
        t.minTier = Math.min(3, (t.minTier ?? 1) + 1) as 1 | 2 | 3;
        this.addHistory(t, "orchestrator", "replan", "retry at a higher tier"); this.store.saveTask(t);
      }
      this.log(goal.roomId, `Recovery: no new route found, retrying ${stuck.map((t) => `"${t.title}"`).join(", ")} at a higher tier. ${why}`);
      this.checkpoint(goal.id, { decision: `Recovery retry: ${why}` });
      return true;
    }
    // Replacements inherit what the stuck tasks delivered and what they depended on.
    for (const t of raw) if (!t.covers?.length) t.covers = [...new Set(stuck.flatMap((x) => x.covers ?? []))];
    repairDeps(raw);
    const doneIds = new Set(this.store.listTasks({ goalId: goal.id }).filter((t) => t.status === "done").map((t) => t.id));
    const inherited = [...new Set(stuck.flatMap((t) => t.dependsOn).filter((d) => doneIds.has(d)))];
    const fresh = this.buildTasks(goal, raw, agents, "recovery", inherited);
    fresh.forEach((t) => this.store.saveTask(t));
    const sinks = fresh.filter((t) => !fresh.some((x) => x.dependsOn.includes(t.id))).map((t) => t.id);
    const stuckIds = new Set(stuck.map((t) => t.id));
    for (const t of this.store.listTasks({ goalId: goal.id }).filter((x) => OPEN(x) && x.dependsOn.some((d) => stuckIds.has(d)))) {
      t.dependsOn = [...new Set([...t.dependsOn.filter((d) => !stuckIds.has(d)), ...sinks])];
      this.store.saveTask(t);
    }
    this.log(goal.roomId, `Recovery (${this.progress(goal.id).goalReplans}/${cfg.maxGoalReplans}): ${r?.approach ?? "new approach"}. ${why} New tasks: ${fresh.map((t) => `"${t.title}"`).join(", ")}.`);
    this.checkpoint(goal.id, { decision: `Recovery: ${r?.approach ?? "new approach"} (${why})` });
    return true;
  }

  /**
   * Every task passed its own review; now check the goal as a whole, against the requirements and the
   * actual files. Re-runs every check (regressions), then a reviewer looks for gaps between tasks.
   * Returns true when it added work.
   */
  private async verifyGoal(goal: Goal, signal: AbortSignal): Promise<boolean> {
    const cfg = this.cfg();
    const g = this.store.getGoal(goal.id);
    if (!g?.contract) return false;
    const tasks = this.store.listTasks({ goalId: goal.id });
    if (!tasks.length || tasks.some((t) => t.status === "failed" && !t.recovered)) return false;
    const done = tasks.filter((t) => t.status === "done");
    if (!done.length) return false;
    const p = this.progress(goal.id);
    if (p.verifyRounds >= cfg.maxVerifyRounds) return false;
    const folder = this.workspaces.stateFolder(g.id) ?? g.folder; // 1.1: for a goal on a granted folder, accepted work lives in the integration worktree or private copy

    // Regression: a later task can break an earlier one's checks.
    const mayRun = !!g.approvedAt || cfg.autoRunChecks;
    if (mayRun && folder) {
      let broke = false;
      for (const t of done) for (const c of (t.criteria ?? []).filter((x) => x.check)) {
        const r = await runCheck(c.id, c.check!, folder);
        if (!r.ok) {
          broke = true; t.status = "revising";
          t.judgment = { score: 0.3, verdict: "revise", judgeAgentId: "checks", feedback: `A later task broke this: ${c.id} \`${c.check}\` now exits ${r.exitCode}. Fix it without undoing the other tasks' work.` };
          this.addHistory(t, "checks", "fail", `regression on ${c.id}`); this.store.saveTask(t);
        }
      }
      if (broke) { this.progress(goal.id, (x) => { x.verifyRounds += 1; }); this.log(goal.roomId, "Final check: a later change broke an earlier task's check; sending it back."); return true; }
    }
    // One small task meeting one requirement has already been reviewed against exactly that.
    if (done.length < 2 && (g.contract.requirements?.length ?? 0) < 2) return false;

    const agents = await this.readyAgents();
    if (!agents.length) return false;
    const files = folder ? readDeliverables(folder, listFiles(folder).filter((f) => f !== "LEDGER.md"), 24000) : "";
    const pool = this.store.getSettings().judgeRotation.map((j) => agents.find((a) => a.id === j)).filter(Boolean) as AgentConfig[];
    this.store.emit("event", { type: "working", roomId: goal.roomId, agentId: "orchestrator", label: "checking the whole goal", active: true });
    const v = await this.callJson<{ requirements?: Record<string, { verdict?: string; evidence?: string }>; complete?: boolean; gaps?: PlanTask[] }>(
      verifyPrompt(g.text, g.contract, tasks, files, agents, p.verifyRounds), pool[0], signal, "reviewer");
    this.store.emit("event", { type: "working", roomId: goal.roomId, agentId: "orchestrator", active: false });
    if (signal.aborted) return false;
    this.progress(goal.id, (x) => { x.verifyRounds += 1; });
    if (!v) { this.log(goal.roomId, "Final check couldn't be read; finishing on the task reviews alone."); return false; }

    const fresh = this.store.getGoal(goal.id)!;
    const reqs = (fresh.contract?.requirements ?? []).map((r) => {
      const x = v.requirements?.[r.id];
      const verdict = String(x?.verdict ?? "").toUpperCase();
      return { ...r, status: verdict === "PASS" ? "met" as const : verdict === "FAIL" ? "unmet" as const : r.status, evidence: x?.evidence ? String(x.evidence).slice(0, 300) : r.evidence };
    });
    fresh.contract = { ...fresh.contract!, requirements: reqs };
    this.store.saveGoal(fresh);
    const unmet = reqs.filter((r) => r.status === "unmet");
    let gaps = (v.gaps ?? []).filter((t) => t && (t.title || t.description)).slice(0, 4);
    if (!gaps.length && unmet.length) {
      gaps = unmet.map((r) => ({ key: `fix-${r.id}`, title: `Close the gap: ${r.text.slice(0, 60)}`, description: `The finished work doesn't yet meet ${r.id}: ${r.text}. ${r.evidence ?? ""} Make the smallest change that meets it, building on the existing files.`, output: "the updated deliverable files", covers: [r.id], criteria: [`${r.id} is met: ${r.text}`], taskType: "other" }));
    }
    if (!gaps.length || (v.complete && !unmet.length)) {
      this.log(goal.roomId, `Final check: all ${reqs.length} requirements met.`);
      return false;
    }
    gaps.forEach((t, i) => { t.key ||= `gap${i}`; t.dependsOn = []; });
    const added = this.buildTasks(goal, gaps, agents, "verify");
    added.forEach((t) => this.store.saveTask(t));
    this.log(goal.roomId, `Final check found ${unmet.length || gaps.length} gap${(unmet.length || gaps.length) === 1 ? "" : "s"}${unmet.length ? ` (${unmet.map((r) => r.id).join(", ")})` : ""}. Fixing: ${added.map((t) => `"${t.title}"`).join(", ")}.`);
    this.checkpoint(goal.id, { decision: `Final check round ${this.progress(goal.id).verifyRounds}: ${added.length} fix task(s).` });
    return true;
  }

  /**
   * Exactly one agent per task, one task per agent. The plan's owner gets it when it's
   * connected; a busy owner is waited for (briefly) rather than handing the job to whoever is free.
   */
  private assign(t: Task, live: Set<string>, goalText: string): AgentConfig | undefined {
    const s = this.store.getSettings();
    const free = (a: AgentConfig) => !this.busy.has(a.id) && !this.chatting.has(a.id) && live.has(a.id);
    const enabled = this.enabledAgents();
    // 1.3: a task that needs a data source goes only to agents that have it. If no agent can, it waits and the owner is told once.
    const gate = needsGate(t, enabled, this.control);
    if (gate && !gate.ok.size) { this.holdForNeeds(t, gate, enabled); return undefined; }
    // 1.5: only agents this machine can take right now; cloud agents are the overflow when local work is at its limit.
    const idle = this.governor.preferForOverflow(enabled.filter(free).filter((a) => !gate || gate.ok.has(a.id)));
    const tried = t.triedBy ?? [];
    let agent: AgentConfig | undefined;
    let route: RouteDecision | undefined;

    if (t.status === "revising" && t.assignee) {
      // a revision stays with the same agent; if it went offline, the task goes back in the pool
      const same = enabled.find((a) => a.id === t.assignee);
      if (same && live.has(same.id) && !quotaLimited(this.store, same.id)) { if (!free(same) || !this.governor.admit(same)) return undefined; agent = same; route = fixedDecision(this.store, same, idle, t.taskType, "revision", s.explorationRate); }
      else { t.triedBy = [...tried, t.assignee]; t.assignee = undefined; t.status = "pending"; this.store.saveTask(t); }
    }
    if (!agent && t.owner && !tried.includes(t.owner) && live.has(t.owner) && (!gate || gate.ok.has(t.owner)) && !quotaLimited(this.store, t.owner)) { // 1.6: a planned owner out of quota is skipped
      const owner = enabled.find((a) => a.id === t.owner)!;
      if (free(owner) && this.governor.admit(owner)) { agent = owner; route = fixedDecision(this.store, owner, idle, t.taskType, "planned_owner", s.explorationRate); }
      else if (!free(owner) && now() - t.updatedAt < 10 * 60_000) return undefined; // wait for the planned owner (an owner the machine can't take right now is overflowed instead)
    }
    // 1.6: routing sees only agents with capacity, free (local) agents first within a margin, expiring capacity nudged up.
    const waiting = enabled.filter((a) => live.has(a.id) && !free(a) && !tried.includes(a.id)); // busy, but with quota: worth waiting for if every idle agent is limited
    route ??= quotaDecide(this.store, idle, t.taskType, s.explorationRate, tried, this.opts.rand, waiting)
           ?? quotaDecide(this.store, idle, t.taskType, s.explorationRate, [], this.opts.rand, waiting);
    if (!route) return undefined;
    agent = route.agent;
    // 0.2: every pick is logged with each candidate's probability, before the work starts.
    t.routingId = openRecord(this.store, route, t, goalText).id;
    if (gate) closeRecord(this.store, t.routingId, { needs: gate.needs, needsFilteredOut: gate.filteredOut }); // 1.3: who was left out for lacking the source
    this.busy.add(agent.id);
    this.governor.start(t.id, agent); // 1.5: released in drive() when the task ends
    return agent;
  }

  /** 1.3: no agent can reach what this task needs. Tell the owner once (kept in the task's history, so a restart doesn't repeat it) and leave the task waiting; it starts by itself once an agent has the source. */
  private holdForNeeds(t: Task, gate: NeedsGate, agents: AgentConfig[]) {
    const note = `Needs ${gate.needs.join(", ")}; no agent can reach it${gate.switchedOff.length ? " (switched off for some)" : ""}.`;
    if ((t.history ?? []).some((h) => h.outcome === "blocked" && h.agentId === "hub" && h.note === note.slice(0, 300))) return;
    this.addHistory(t, "hub", "blocked", note);
    this.store.saveTask(t);
    this.post(t.roomId, SYS, needsMessage(gate, t.title, agents), "system", t.id);
  }

  private async runTask(goal: Goal, task: Task, agent: AgentConfig, goalSignal: AbortSignal) {
    if (this.goalSources.lost(this.store.getGoal(goal.id) ?? goal)) { this.stopForLostFolder(goal.id); return; } // 1.1: the folder's grant no longer covers this goal
    // Each task gets its own controller so the owner can interrupt it without stopping the goal.
    const ctrl = new AbortController();
    const onGoal = () => ctrl.abort();
    goalSignal.addEventListener("abort", onGoal);
    const run = { ctrl, agentId: agent.id } as { ctrl: AbortController; agentId: string; redirect?: string };
    this.taskRuns.set(task.id, run);
    this.steers.delete(task.id); // anything earlier is already in the brief
    try { return await this.runTaskInner(goal, task, agent, ctrl.signal, goalSignal, run); }
    finally { goalSignal.removeEventListener("abort", onGoal); this.taskRuns.delete(task.id); }
  }

  /** Owner redirected this task mid-run: same agent starts over with the change. Not a failure. */
  private redirected(goal: Goal, task: Task, agent: AgentConfig, text: string) {
    this.working(goal.roomId, agent, false);
    task.attempts = Math.max(0, task.attempts - 1);
    task.status = "revising";
    task.judgment = { score: 0, verdict: "revise", feedback: `The owner redirected you mid-task: ${text}. Start over with this.`, judgeAgentId: "owner" };
    this.addHistory(task, "owner", "redirect", text);
    this.store.saveTask(task);
    this.log(goal.roomId, `${agent.name} was redirected on "${task.title}".`, task.id, "task_update");
    this.checkpoint(goal.id, { decision: `Owner redirected "${task.title}": ${text.slice(0, 200)}` });
  }

  // ---------- 1.4 worktree per task
  /** The task's own working directory (its git worktree or folder copy), if it has one right now. */
  taskWorktree(task: Pick<Task, "goalId" | "id">): string | undefined { return this.workspaces.find(task.goalId, task.id)?.path; }

  /** Remove every worktree and branch the goal still holds. Tracked so idle() can wait for it. */
  private dropWorktrees(goalId: string): Promise<void> {
    const g = this.store.getGoal(goalId);
    const folder = g?.folder;
    if (!g || !folder) return Promise.resolve();
    const p: Promise<void> = this.workspaces.cleanup(this.goalSources.ref(g, folder), this.store.listTasks({ goalId }).map((t) => t.id)) // 1.1: ref carries the granted folder
      .catch(() => undefined).finally(() => { this.cleanups.delete(p); });
    this.cleanups.add(p);
    return p;
  }
  private async discardWorktree(goal: Goal, task: Task) {
    const g = this.store.getGoal(goal.id) ?? goal;
    if (g.folder) await this.workspaces.discard(this.goalSources.ref(g, g.folder), task.id).catch(() => undefined);
  }
  private async workspaceHook(name: keyof WorkspaceHooks, ws: TaskWorkspace, agentId: string) {
    const fn = this.workspaceHooks[name]; if (!fn) return;
    const ctx: WorkspaceHookContext = { goalId: ws.goalId, taskId: ws.taskId, agentId, path: ws.path, kind: ws.kind };
    try { await fn(ctx); } catch (e) { this.store.audit(agentId, "worktree.hook", `${name} failed: ${firstLine(String(e))}`); }
  }
  /**
   * 1.1: the owner points an existing goal at a granted folder (or clears it). Only before any task has run, so no work is half on
   * one base and half on another.
   */
  setGoalFolder(goalId: string, grantId: string | null): { ok: true; goal: Goal } | { ok: false; reason: string } {
    const g = this.store.getGoal(goalId);
    if (!g) return { ok: false, reason: "No such goal." };
    if (!["planning", "awaiting_approval"].includes(g.status)) return { ok: false, reason: "The folder can only be set before work starts." };
    if (grantId) {
      const u = this.goalSources.usable(grantId, g.roomId);
      if (!u.ok) return u;
      g.sourceGrantId = grantId; g.sourceBranch = branchFor(g.id);
    } else { delete g.sourceGrantId; delete g.sourceBranch; }
    this.store.saveGoal(g);
    this.store.audit("owner", "goal.source.set", `${g.id} ${grantId ?? "none"}`);
    return { ok: true, goal: g };
  }

  /**
   * 1.1: the grant behind a goal's folder was removed, narrowed to other agents or rooms, or made unreadable. The goal stops, nothing more is
   * written to the folder, and the owner is told once.
   */
  private stopForLostFolder(goalId: string) {
    const g = this.store.getGoal(goalId);
    if (!g || ["done", "failed", "superseded"].includes(g.status)) return;
    g.status = "failed"; g.summary = "Stopped: the folder this goal works on is no longer open to it."; this.store.saveGoal(g);
    for (const t of this.store.listTasks({ goalId })) {
      this.taskRuns.get(t.id)?.ctrl.abort();
      if (OPEN(t)) { t.status = "cancelled"; this.store.saveTask(t); }
    }
    this.running.get(goalId)?.abort();
    if (this.goalSources.firstLoss(goalId)) {
      this.store.audit("hub", "goal.source.revoked", `${goalId} ${g.sourceGrantId}: the folder grant no longer covers this goal; work stopped`);
      this.post(g.roomId, SYS, "The folder this goal works on is no longer shared with it (the grant was removed or changed), so work on it has stopped and nothing more will be written to the folder.", "system");
    }
    void this.dropWorktrees(goalId);
  }

  /** Hub start: remove worktrees of tasks that are no longer open. Call before recover(). */
  pruneWorktrees() {
    return this.workspaces.prune((goalId, taskId) => {
      const g = this.store.getGoal(goalId), t = this.store.getTask(taskId);
      return !!g && ["planning", "awaiting_approval", "running", "paused"].includes(g.status) && !!t && OPEN(t);
    }, (goalId) => { // 1.1: a goal still going keeps its integration worktree or private copy
      const g = this.store.getGoal(goalId);
      return !!g && ["planning", "awaiting_approval", "running", "paused"].includes(g.status);
    });
  }

  /**
   * The judge accepted the work but it collides with work already merged from another task. Never done, never an overwrite:
   * the task goes back to the same agent, whose worktree now holds the latest base with conflict markers to resolve.
   * Conflicts are not the agent's fault, so they don't use up an attempt (three in a row do).
   */
  private async sendBackConflict(goal: Goal, task: Task, agent: AgentConfig, judgment: Judgment, files: string[], markers: boolean, goalSignal: AbortSignal) {
    const list = files.length ? files.join(", ") : "the files you changed";
    const feedback = markers
      ? `Not merged yet: ${list} still contain conflict markers (<<<<<<<, =======, >>>>>>>). Resolve them so the file keeps BOTH your change and the other task's accepted change, remove every marker, and finish again.`
      : `Your work was accepted but could not be merged: ${list} changed in another task's accepted work too. Your folder now holds the latest accepted state, and the conflicting files contain conflict markers (<<<<<<<, =======, >>>>>>>). Open each one, keep BOTH your change and the other task's change (never drop theirs), remove the markers, and finish again.`;
    const strikes = (task.history ?? []).filter((h) => h.outcome === "redirect" && h.note.startsWith("merge conflict")).length;
    task.judgment = { ...judgment, verdict: "revise", feedback };
    this.addHistory(task, agent.id, strikes >= 3 ? "fail" : "redirect", `merge conflict: ${list}`);
    this.log(goal.roomId, `"${task.title}" passed review but conflicts with accepted work in ${list}; sending it back to ${agent.name} to merge.`, task.id, "task_update");
    this.store.audit(agent.id, "worktree.conflict", `"${task.title}": ${list}`.slice(0, 300));
    if (strikes >= 3) return this.retryOrFail(goal, task, agent, "revise", goalSignal);
    this.floor.take(agent.id, goal.roomId);
    task.attempts = Math.max(0, task.attempts - 1);
    task.status = "revising"; this.store.saveTask(task);
  }

  private async runTaskInner(goal: Goal, task: Task, agent: AgentConfig, signal: AbortSignal, goalSignal: AbortSignal, run: { redirect?: string }) {
    const s = this.cfg();
    const stopped = () => signal.aborted;
    const interrupted = () => { if (goalSignal.aborted) return true; if (run.redirect) { this.redirected(goal, task, agent, run.redirect); return true; } return false; };
    const isRevision = task.status === "revising";
    const feedback = isRevision ? task.judgment?.feedback : undefined;
    this.progress(goal.id, (p) => { p.runs += 1; });
    task.assignee = agent.id; task.status = "running"; task.attempts += 1; task.claimedAt = now();
    this.store.saveTask(task);
    this.floor.give(agent.id, goal.roomId, 2 * 3600_000);
    this.log(goal.roomId, isRevision ? `${agent.name} is revising "${task.title}". ${feedback ?? ""}` : `${agent.name} owns "${task.title}".`, task.id);
    this.checkpoint(goal.id, { next: `${agent.name} working on "${task.title}".` });
    this.working(goal.roomId, agent, true, task.title);

    const fresh = this.store.getGoal(goal.id) ?? goal;
    const folder = fresh.folder ?? goalFolder(this.opts.dataDir, goal.id); // the goal's BASE folder (LEDGER.md, final checks)
    // 1.4: the agent never works in the base. Its own worktree (or copy) is `work`: the cwd, the checks and the judge's view.
    const ref = this.goalSources.ref(fresh, folder); // 1.1: carries the granted folder, when the goal has one
    const ws = await this.workspaces.open(ref, task, agent.id);
    const work = ws.path;
    await this.workspaceHook("beforeRun", ws, agent.id); // 1.9 HOOK: write the agent's context file into `work` here
    // The owner may have stopped or cancelled this while the worktree was being cut: don't resurrect the task or leak the worktree.
    if (this.store.getTask(task.id)?.status === "cancelled" || (stopped() && interrupted())) {
      this.working(goal.roomId, agent, false); closeRecord(this.store, task.routingId, { outcome: "interrupted" });
      if (this.store.getTask(task.id)?.status === "cancelled") await this.discardWorktree(goal, task);
      return;
    }
    const profile = pickProfile(agent, task.role ?? "worker", task.minTier ?? 1);
    task.profileId = profile.id; this.store.saveTask(task);
    const rid = task.routingId;
    closeRecord(this.store, rid, { profileId: profile.id, modelRequested: profile.model ?? ((agent.settings?.model as string | undefined) || undefined) });
    const deps = this.store.listTasks({ goalId: goal.id }).filter((t) => task.dependsOn.includes(t.id));
    const notes = this.ownerNotes.get(goal.id) ?? [];
    const before = snapshot(work);
    const prompt = taskPrompt(task, goal.text, fresh.contract, deps, this.store.listShared(goal.roomId), this.store.listPrivate(agent.id), notes, this.enabledAgents(), agent.id, feedback, { path: work, files: [...before.keys()], ledger: join(folder, "LEDGER.md"), note: this.goalSources.note(fresh) /* 1.1 */ }, this.ledgerText(fresh), this.decisionsFor(fresh), learnedBlock(this.store, this.control, agent, task.taskType) /* 2.1 */);
    let res = await this.call(agent, prompt, { roomId: goal.roomId, taskId: task.id, signal, profile, cwd: work });
    let usage: RunUsage | undefined = res.usage, ms = res.durationMs, ranModel = res.model;
    // A rate limit or timeout says nothing about the agent's work: wait and retry, without spending an attempt.
    for (let retry = 1; !res.ok && retry <= 2 && isTransient(res.error) && !isRateLimit(res.error) && !stopped(); retry++) { // 1.6: rate limits move to another agent, below
      this.log(goal.roomId, `${agent.name} hit a temporary error on "${task.title}" (${firstLine(res.error)}); retrying in a moment.`, task.id, "task_update");
      await sleep((this.opts.retryDelayMs ?? 5000) * retry * retry);
      if (stopped()) break;
      res = await this.call(agent, prompt, { roomId: goal.roomId, taskId: task.id, signal, profile, cwd: work });
      usage = addUsage(usage, res.usage); ms += res.durationMs; ranModel = res.model ?? ranModel;
    }
    const changed = changedFiles(before, snapshot(work));
    this.working(goal.roomId, agent, false);
    // 0.2: close the routing record on every way out of this attempt.
    const route = (outcome: RoutingOutcome, extra: Partial<RoutingRecord> = {}) =>
      closeRecord(this.store, rid, { outcome, usage, seconds: Math.round(ms) / 1000, ...(ranModel ? { modelVersion: ranModel } : {}), ...extra });
    if (stopped() && interrupted()) { route("interrupted"); return; }

    if (!res.ok) {
      // 1.6: a rate limit isn't the agent's work: hand the task to another agent now rather than waiting on this one.
      if (isRateLimit(res.error) && quotaFor(this.store).mayReroute(task.id, this.enabledAgents().length)) return this.rerouteRateLimited(goal, task, agent, res.error, route);
      route("run_failed", this.tagFailure(task, agent.id, { kind: "run_error" }, firstLine(res.error)));
      recordOutcome(this.store, agent.id, task.taskType, { seconds: res.durationMs / 1000, failed: true, revision: isRevision }, ranModel ?? profile.model /* 2.4 */);
      this.addHistory(task, agent.id, "fail", firstLine(res.error));
      this.log(goal.roomId, `${agent.name} couldn't finish "${task.title}": ${firstLine(res.error)}`, task.id, "task_update");
      return this.retryOrFail(goal, task, agent, "reassign", goalSignal);
    }

    const { body, report } = parseReport(res.text);
    const previous = task.judgment?.feedback;
    task.result = body; task.report = report; task.status = "review"; this.store.saveTask(task);
    if (report.decisions?.length) {
      // Implicit choices made explicit, so the next task doesn't contradict them.
      const g = this.store.getGoal(goal.id)!;
      const st: GoalState = g.state ?? { decisions: [], nextAction: "" };
      const have = new Set((st.shared ?? []).map((d) => d.text.toLowerCase()));
      st.shared = [...(st.shared ?? []), ...report.decisions.filter((d) => !have.has(d.toLowerCase())).map((text) => ({ at: now(), agentId: agent.id, taskTitle: task.title, text }))].slice(-30);
      g.state = st; this.store.saveGoal(g);
    }
    const m = this.post(goal.roomId, this.agentAuthor(agent), body, "agent", task.id);
    this.harvestMemory(agent.id, goal.roomId, body);
    this.routeTags(m, 0);
    this.store.saveMemory({ id: id("mem"), scope: "private", ownerAgentId: agent.id, roomId: goal.roomId,
      text: `Did "${task.title}" for goal "${goal.text.slice(0, 80)}".`, sourceAgentId: agent.id, confidence: 1, createdAt: now() });

    // The agent itself says it can't finish: don't judge, act on it.
    if (report.status === "needs_input") {
      route("needs_input", this.tagFailure(task, agent.id, { kind: "needs_input", report }, report.reason ?? "needs input"));
      task.status = "waiting"; this.addHistory(task, agent.id, "needs_input", report.reason ?? "needs input");
      this.store.saveTask(task); this.floor.take(agent.id, goal.roomId);
      this.post(goal.roomId, SYS, `${agent.name} needs your input on "${task.title}"${report.reason ? `: ${report.reason}` : "."} Reply here and the work continues.`, "system", task.id);
      this.checkpoint(goal.id, { next: `Waiting on owner for "${task.title}".` });
      return;
    }
    if (report.status === "blocked") {
      route("blocked", this.tagFailure(task, agent.id, { kind: "blocked", report }, report.reason ?? "blocked"));
      this.addHistory(task, agent.id, "blocked", report.reason ?? "blocked");
      this.log(goal.roomId, `${agent.name} is blocked on "${task.title}": ${report.reason ?? "no reason given"}`, task.id, "task_update");
      return this.retryOrFail(goal, task, agent, "reassign", goalSignal);
    }

    // Runnable checks: decided by a command, not a model. Only on an approved plan (or if the owner allows it).
    const runnable = (task.criteria ?? []).filter((c) => c.check);
    const mayRun = !!fresh.approvedAt || this.cfg().autoRunChecks;
    task.checks = [];
    if (runnable.length && mayRun) {
      for (const c of runnable) task.checks.push(await runCheck(c.id, c.check!, work));
      this.store.saveTask(task);
      this.log(goal.roomId, `Checks on "${task.title}": ${task.checks.map((r) => `${r.criterionId} ${r.ok ? "PASS" : `FAIL (exit ${r.exitCode})`}`).join(", ")}.`, task.id, "task_update");
    }
    const failedChecks = task.checks.filter((r) => !r.ok);
    const fileDrift = outsideScope(changed, task.files);

    // Failed checks send it straight back; no model needs to look at it.
    const judgment: Judgment = failedChecks.length
      ? { score: 0.3, verdict: "revise", judgeAgentId: "checks",
          feedback: `These checks failed: ${failedChecks.map((r) => `${r.criterionId} \`${r.command}\` exited ${r.exitCode}${r.output ? `: ${r.output.split("\n").slice(-3).join(" ").slice(0, 300)}` : ""}`).join("; ")}.`,
          criteria: {}, onTask: true }
      : await this.judge(task, agent, fresh.contract, this.ownerNotes.get(goal.id) ?? notes, signal, changed, this.deliverableText(work, task, changed), isRevision ? feedback : undefined);
    if (stopped() && interrupted()) { route("interrupted"); return; }
    // A command's verdict beats a model's.
    for (const r of task.checks) (judgment.criteria ??= {})[r.criterionId] = { verdict: r.ok ? "PASS" : "FAIL", evidence: r.ok ? `\`${r.command}\` passed` : `\`${r.command}\` exited ${r.exitCode}` };

    // UNSURE is "can't tell", not "wrong". Ask once for evidence; if it's still only UNSURE, get a second
    // reviewer; if they can't tell either, accept and flag it for the owner instead of looping forever.
    const checked = new Set(task.checks.filter((r) => r.ok).map((r) => r.criterionId));
    const blockers = Object.entries(judgment.criteria ?? {}).filter(([k, v]) => v.verdict !== "PASS" && !checked.has(k));
    const onlyUnsure = judgment.verdict !== "accept" && !failedChecks.length && blockers.length > 0
      && blockers.every(([, v]) => v.verdict === "UNSURE") && judgment.onTask !== false && !judgment.drift;
    task.unsureRounds = onlyUnsure ? (task.unsureRounds ?? 0) + 1 : 0;
    if (onlyUnsure && task.unsureRounds >= 2) {
      const second = await this.judge(task, agent, fresh.contract, this.ownerNotes.get(goal.id) ?? notes, signal, changed, this.deliverableText(work, task, changed), undefined, judgment.judgeAgentId);
      if (stopped() && interrupted()) { route("interrupted"); return; }
      const still = Object.entries(second.criteria ?? {}).filter(([k, v]) => v.verdict !== "PASS" && !checked.has(k));
      if (still.every(([, v]) => v.verdict === "UNSURE") && second.onTask !== false) {
        task.flagged = still.map(([k]) => k);
        Object.assign(judgment, { ...second, verdict: "accept", feedback: `Accepted; ${task.flagged.join(", ")} couldn't be verified by two reviewers and are flagged for you.` });
      } else Object.assign(judgment, second);
    } else if (onlyUnsure) {
      judgment.feedback = `Show the evidence for ${blockers.map(([k]) => k).join(", ")}: ${blockers.map(([k, v]) => `${k}: ${v.evidence || "what would prove it"}`).join("; ")}. ${judgment.feedback}`.trim();
    }

    // Drift control: the agent's own report, files it shouldn't have touched, and the judge's read.
    const drift = selfReportedDrift(task, report);
    if (fileDrift.length) drift.push(`Changed files outside its scope: ${fileDrift.slice(0, 8).join(", ")}`);
    if (judgment.onTask === false || judgment.drift) drift.push(`Judge: ${judgment.drift || "off task"}`);
    const hard = drift.filter((d) => !d.startsWith("No STATUS block"));
    if (hard.length && judgment.verdict === "accept") {
      judgment.verdict = "revise";
      judgment.feedback = `Stay on your task and in scope. ${hard.join(" ")} ${judgment.feedback}`.trim();
    }
    task.judgment = judgment;
    if (drift.length) task.drift = [...(task.drift ?? []), ...drift].slice(-10);
    recordOutcome(this.store, agent.id, task.taskType, { judgment, seconds: res.durationMs / 1000, failed: false, revision: isRevision }, ranModel ?? profile.model /* 2.4 */);
    const crit = Object.entries(judgment.criteria ?? {}).map(([k, v]) => `${k} ${v.verdict}`).join(", ");
    this.log(goal.roomId, `Checked "${task.title}": ${Math.round(judgment.score * 100)}/100, ${judgment.verdict}${crit ? ` (${crit})` : ""}.${drift.length ? ` Drift: ${drift.join(" ")}` : ""} ${judgment.feedback}${juryLine(judgment) ? `\n${juryLine(judgment)}` : ""}`, task.id, "task_update"); // 2.2: jury chips line
    if ((this.opts.rand ?? Math.random)() < s.calibrationSampleRate) this.store.emit("event", { type: "calibration", task });

    this.progress(goal.id, (p) => { if (judgment.verdict === "accept") { p.stall = 0; p.lastAcceptAt = now(); } else p.stall += 1; });
    const judged = { judgment: { score: judgment.score, verdict: judgment.verdict, judgeAgentId: judgment.judgeAgentId }, ...(judgment.jury ? { juryId: judgment.jury.id } : {}) }; // 2.2: the routing record points at its jury
    if (judgment.verdict === "accept") {
      // 1.4: accepted work merges into the goal folder. A conflict with another task's accepted work is a send-back, never "done".
      await this.workspaceHook("beforeMerge", ws, agent.id); // 1.9 HOOK: restore the agent's context file in `work` before it is committed
      const merge = await this.workspaces.accept(this.goalSources.ref(this.store.getGoal(goal.id) ?? fresh, folder), task); // 1.1: the grant is checked again at the moment of merging
      if (!merge.ok) { route("revise", judged); return this.sendBackConflict(goal, task, agent, judgment, merge.conflict, !!merge.markers, goalSignal); }
      await this.discardWorktree(goal, task);
      if (merge.source) this.goalSources.afterAccept(fresh, task, agent, merge.source, (t) => this.post(goal.roomId, SYS, t, "system", task.id)); // 1.1
      if (merge.merged.length) this.store.audit(agent.id, "worktree.merge", `"${task.title}" merged (${merge.how}): ${merge.merged.slice(0, 12).join(", ")}`.slice(0, 400));
      route("accepted", judged);
      this.addHistory(task, agent.id, "ok", `${Math.round(judgment.score * 100)}/100`);
      task.status = "done"; this.store.saveTask(task); this.floor.take(agent.id, goal.roomId);
      this.checkpoint(goal.id, { decision: `"${task.title}" accepted from ${agent.name}.` });
      return;
    }
    this.addHistory(task, agent.id, hard.length ? "drift" : "fail", judgment.feedback);
    const strikes = (task.history ?? []).filter((h) => h.outcome === "drift" && h.agentId === agent.id).length;
    const mode = strikes >= s.driftStrikes ? "reassign" : judgment.verdict;
    if (strikes >= s.driftStrikes) this.log(goal.roomId, `${agent.name} drifted ${strikes} times on "${task.title}"; taking it back.`, task.id, "task_update");
    // The same problem sent back twice is a loop, not progress: change the approach now.
    const looping = isRevision && sameFeedback(previous, judgment.feedback);
    route(mode, { ...judged, ...this.tagFailure(task, agent.id, { kind: "sent_back", report, judgment, drift, failedChecks: failedChecks.map((r) => r.criterionId) }, judgment.feedback) });
    if (looping) this.log(goal.roomId, `"${task.title}" came back with the same problem twice; changing the approach.`, task.id, "task_update");
    return this.retryOrFail(goal, task, agent, mode, goalSignal, looping);
  }

  /** Two failures on one approach means replan, not a third try of the same thing. */
  private async retryOrFail(goal: Goal, task: Task, agent: AgentConfig, mode: "revise" | "reassign", signal: AbortSignal, looping = false) {
    this.floor.take(agent.id, goal.roomId);
    const s = this.cfg();
    const sinceReplan = [...(task.history ?? [])].reverse();
    const cut = sinceReplan.findIndex((h) => h.outcome === "replan");
    const fails = (cut < 0 ? sinceReplan : sinceReplan.slice(0, cut)).filter((h) => ["fail", "drift", "blocked"].includes(h.outcome)).length;
    if ((fails >= 2 || looping) && (task.replans ?? 0) < 1 && !signal.aborted && await this.replan(goal, task, signal)) return;
    if (task.attempts >= s.maxAttempts) {
      task.status = "failed"; this.store.saveTask(task);
      await this.discardWorktree(goal, task); // 1.4: rejected work is discarded
      this.post(task.roomId, SYS, `"${task.title}" failed after ${task.attempts} attempt${task.attempts > 1 ? "s" : ""}${task.replans ? " and a replan" : ""}.`, "system", task.id);
      this.checkpoint(goal.id, { decision: `"${task.title}" failed.` });
      return;
    }
    if (mode === "reassign") { task.triedBy = [...(task.triedBy ?? []), agent.id]; task.assignee = undefined; task.status = "pending"; await this.discardWorktree(goal, task); /* 1.4: the next agent starts fresh */ }
    else task.status = "revising";
    this.store.saveTask(task);
  }

  /** 1.6: the run hit a rate limit (the quota ledger already marked the subscription). No attempt is spent and the agent's score is untouched. */
  private rerouteRateLimited(goal: Goal, task: Task, agent: AgentConfig, error: string | undefined, route: (o: RoutingOutcome, x?: Partial<RoutingRecord>) => void) {
    route("run_failed", this.tagFailure(task, agent.id, { kind: "run_error" }, `rate limit: ${firstLine(error)}`));
    task.attempts = Math.max(0, task.attempts - 1);
    task.triedBy = [...(task.triedBy ?? []), agent.id]; task.assignee = undefined;
    if (task.status !== "revising") task.status = "pending";
    this.floor.take(agent.id, goal.roomId);
    this.store.saveTask(task);
    this.log(goal.roomId, `${agent.name} hit a usage limit on "${task.title}" (${firstLine(error)}); moving it to another agent.`, task.id, "task_update");
  }

  private async replan(goal: Goal, task: Task, signal: AbortSignal): Promise<boolean> {
    const agents = await this.readyAgents();
    const contract = this.store.getGoal(goal.id)?.contract;
    const r = await this.callJson<{ owner?: string; description?: string; scope?: string; criteria?: unknown; approach?: string }>(
      replanPrompt(task, contract, agents), undefined, signal);
    if (!r?.description) return false;
    task.description = r.description;
    if (r.scope) task.scope = r.scope;
    if (Array.isArray(r.criteria) && r.criteria.length) {
      task.criteria = normaliseCriteria(r.criteria, "");
      task.acceptance = task.criteria.map((c) => `${c.id}: ${c.text}`).join("; ");
    }
    task.owner = agents.some((a) => a.id === r.owner) ? r.owner : task.owner;
    // Escalate the model, not the turns: the next attempt runs a tier up.
    const used = this.store.getAgent(task.assignee ?? task.owner ?? "");
    const usedTier = used ? (used.profiles?.find((p) => p.id === task.profileId)?.tier ?? pickProfile(used, task.role).tier) : 1;
    task.minTier = Math.min(3, usedTier + 1) as 1 | 2 | 3;
    task.replans = (task.replans ?? 0) + 1; task.attempts = 0; task.triedBy = [];
    task.assignee = undefined; task.status = "pending"; task.judgment = undefined;
    await this.discardWorktree(goal, task); // 1.4: a new approach starts from the current base
    this.addHistory(task, "orchestrator", "replan", r.approach ?? "new approach");
    this.store.saveTask(task);
    this.log(goal.roomId, `Replanned "${task.title}" after two failures: ${r.approach ?? "new approach"}; next attempt runs at tier ${task.minTier} or above.`, task.id, "task_update");
    this.checkpoint(goal.id, { decision: `Replan "${task.title}": ${r.approach ?? "new approach"}` });
    return true;
  }

  /** What the reviewer reads: the files this task wrote or was given, not just its chat reply. */
  private deliverableText(folder: string | undefined, task: Task, changed: string[]) {
    const exact = (task.files ?? []).filter((f) => !/[*?[]/.test(f));
    return readDeliverables(folder, [...new Set([...changed, ...exact])], 16000);
  }

  /** 0.5: tag a failure or send-back, keep it on the task, and put it in the audit log. Returns the routing-log fields. */
  private tagFailure(task: Task, agentId: string, e: FailureEvidence, note: string) {
    const { tag, why } = classifyFailure(e);
    addFailure(task, agentId, tag, `${why}: ${note}`, task.routingId);
    this.store.audit(agentId, "task.failure", `[${tag}] "${task.title}" (${why}): ${firstLine(note)}`.slice(0, 600));
    return { failureTag: tag, failureNote: `${why}: ${firstLine(note)}`.slice(0, 300) };
  }

  /**
   * 2.2 HOOK: blind cross-vendor jury. The reply is neutralised and three judges from other model families grade it;
   * with too few families ready (or the jury switched off) this is the single rotating judge it always was (judgeOne).
   */
  private async judge(task: Task, worker: AgentConfig, contract: Contract | undefined, notes: string[], signal: AbortSignal, changed: string[] = [], files = "", previousFeedback?: string, notJudge?: string): Promise<Judgment> {
    const host: JuryHost = { store: this.store, readyAgents: () => this.readyAgents(), call: (a, p, o) => this.call(a, p, o), callJson: (p, a, sig, r) => this.callJson(p, a, sig, r), governor: this.governor, quotaLimited: (aid) => quotaLimited(this.store, aid) };
    const r = await juryReview(host, { task, worker, contract, notes, signal, changed, files, previousFeedback, notJudge });
    if ("judgment" in r) return r.judgment;
    if ("off" in r) return this.judgeOne(task, worker, contract, notes, signal, changed, files, previousFeedback, notJudge);
    return r.finish(await this.judgeOne(r.task, worker, contract, notes, signal, changed, files, previousFeedback, notJudge?.split(",")[0]));
  }

  private async judgeOne(task: Task, worker: AgentConfig, contract: Contract | undefined, notes: string[], signal: AbortSignal, changed: string[] = [], files = "", previousFeedback?: string, notJudge?: string): Promise<Judgment> {
    const s = this.store.getSettings();
    const ready = new Set((await this.readyAgents()).map((a) => a.id));
    const pool = s.judgeRotation.map((j) => this.store.getAgent(j)).filter((a): a is AgentConfig => !!a && a.enabled && ready.has(a.id) && !quotaLimited(this.store, a.id)); // 1.6: not a judge that is out of quota
    // rotate judges; avoid letting an agent grade its own work when possible
    let judge: AgentConfig | undefined;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[(this.judgeTurn + i) % pool.length];
      if (cand.id !== worker.id && cand.id !== notJudge) { judge = cand; this.judgeTurn += i + 1; break; }
    }
    judge ??= pool[0] ?? this.orchestratorAgent();
    const j = await this.callJson<{ score: number; verdict: Judgment["verdict"]; feedback: string; criteria?: Record<string, { verdict?: string; evidence?: string }>; on_task?: boolean; drift?: string; failure_category?: string }>(
      judgePrompt(task, contract, notes, changed, files, previousFeedback), judge, signal, "reviewer");
    if (!j) return { score: 0.5, verdict: "revise", feedback: "The check couldn't be read; please resubmit with the STATUS block.", judgeAgentId: judge?.id ?? "none" };
    const score = Math.min(1, Math.max(0, Number(j.score) || 0));
    const criteria: NonNullable<Judgment["criteria"]> = {};
    for (const c of task.criteria ?? []) {
      const v = j.criteria?.[c.id];
      const verdict = String(v?.verdict ?? "UNSURE").toUpperCase();
      criteria[c.id] = { verdict: (["PASS", "FAIL", "UNSURE"].includes(verdict) ? verdict : "UNSURE") as Verdict, evidence: String(v?.evidence ?? "") };
    }
    let verdict = ([`accept`, `revise`, `reassign`] as const).includes(j.verdict) ? j.verdict : score >= 0.6 ? "accept" : "revise";
    const verified = new Set((task.checks ?? []).filter((r) => r.ok).map((r) => r.criterionId));
    const failing = Object.entries(criteria).filter(([k, v]) => v.verdict !== "PASS" && !verified.has(k)).map(([k]) => k);
    if (verdict === "accept" && failing.length && j.criteria) verdict = "revise"; // done means every check passes
    const feedback = String(j.feedback ?? "") + (verdict === "revise" && failing.length && j.criteria ? ` Not yet passing: ${failing.join(", ")}.` : "");
    const failureCategory = verdict === "accept" ? undefined : parseFailureCategory(j.failure_category);
    return { score, verdict, feedback: feedback.trim(), judgeAgentId: judge?.id ?? "none", criteria, onTask: j.on_task !== false, drift: j.drift ? String(j.drift) : undefined, ...(failureCategory ? { failureCategory } : {}) };
  }

  private async finish(goal: Goal) {
    await this.dropWorktrees(goal.id); // 1.4: nothing outlives the goal
    const tasks = this.store.listTasks({ goalId: goal.id });
    const g = this.store.getGoal(goal.id) ?? goal;
    // Tasks that were replaced by a recovery don't count against the goal; their replacements do.
    const live = tasks.filter((t) => !(t.recovered && t.status !== "done"));
    const report = gate(live);
    const unmet = (g.contract?.requirements ?? []).filter((r) => r.status === "unmet");
    const ok = live.every((t) => t.status === "done") && report.passed && !unmet.length;
    g.status = ok ? "done" : "failed";
    g.state = { ...(g.state ?? { decisions: [] }), nextAction: ok ? "Complete." : unmet.length ? `Needs the owner: ${unmet.map((r) => r.id).join(", ")} not met.` : "Needs the owner: some checks didn't pass.", gate: report };
    if (tasks.length === 1) {
      g.summary = tasks[0].result ?? (ok ? "Done." : "Failed.");
      this.store.saveGoal(g); this.ownerNotes.delete(goal.id); return;
    }
    const orch = (await this.readyAgents()).find((a) => a.id === this.store.getSettings().orchestratorAgentId) ?? this.orchestratorAgent()!;
    this.writeLedger(g);
    const text = await this.call(orch, summaryPrompt(g.text, g.contract, live, report), { jsonOnly: true });
    const checks = (report.passed ? `✓ ${gateText(report)}` : `⚠︎ ${gateText(report)}`) + jurySummary(this.store, g.id); // 2.2: how it was judged
    const reqLine = g.contract?.requirements?.length
      ? `\n${g.contract.requirements.map((r) => `${r.status === "met" ? "✓" : r.status === "unmet" ? "✗" : "·"} ${r.id} ${r.text}`).join("\n")}` : "";
    g.summary = text.ok ? `${text.text.trim()}\n\n${checks}${reqLine}` : `${live.filter((t) => t.status === "done").length}/${live.length} tasks done.\n${checks}${reqLine}`;
    this.store.saveGoal(g);
    if (text.ok) this.post(g.roomId, this.agentAuthor(orch), g.summary, "agent");
    else this.post(g.roomId, SYS, g.summary, "system");
    this.ownerNotes.delete(goal.id);
  }

  // ---------- memory (orchestrator is the only writer of shared memory)
  harvestMemory(agentId: string, roomId: string | undefined, text: string) {
    for (const m of text.matchAll(/^\s*MEMORY:\s*(.+)$/gim)) void this.proposeMemory(agentId, roomId, m[1].trim(), 0.6);
  }

  async proposeMemory(agentId: string, roomId: string | undefined, text: string, confidence = 0.6) {
    const p = { id: id("prop"), roomId, text, sourceAgentId: agentId, confidence, status: "pending" as const, createdAt: now() };
    this.store.saveProposal(p);
    const existing = this.store.listShared(roomId);
    const d = await this.callJson<{ decision: "accept" | "reject" | "merge"; text?: string; mergeWith?: string }>(memoryPrompt(text, existing), undefined, undefined, "quick");
    if (!d) return p; // stays pending for the owner to decide in the Memory screen
    if (d.decision === "reject") { this.store.saveProposal({ ...p, status: "rejected", decidedBy: "orchestrator" }); return p; }
    const finalText = d.text?.trim() || text;
    const target = d.decision === "merge" ? existing.find((e) => e.id === d.mergeWith) : undefined;
    const entry: MemoryEntry = target
      ? { ...target, text: finalText, confidence: Math.max(target.confidence, confidence) }
      : { id: id("mem"), scope: "shared", roomId, text: finalText, sourceAgentId: agentId, confidence, createdAt: now() };
    this.store.saveMemory(entry);
    this.store.saveProposal({ ...p, status: target ? "merged" : "accepted", decidedBy: "orchestrator" });
    this.store.audit("orchestrator", "memory.write", finalText.slice(0, 200));
    return p;
  }

  /** Owner override on a pending proposal. */
  decideProposal(proposalId: string, accept: boolean, text?: string) {
    const p = this.store.getProposal(proposalId); if (!p) return;
    if (accept) this.store.saveMemory({ id: id("mem"), scope: "shared", roomId: p.roomId, text: text ?? p.text, sourceAgentId: p.sourceAgentId, confidence: 1, createdAt: now() });
    this.store.saveProposal({ ...p, status: accept ? "accepted" : "rejected", decidedBy: "owner" });
    this.store.audit("owner", accept ? "memory.accept" : "memory.reject", p.text.slice(0, 200));
  }

  rateJudgment(taskId: string, ownerScore: number) {
    const t = this.store.getTask(taskId);
    if (!t?.judgment || !t.assignee) return;
    applyOwnerRating(this.store, t.assignee, t.taskType, t.judgment.score, ownerScore, (t.routingId ? this.store.getRouting(t.routingId) : undefined)?.modelVersion /* 2.4 */);
    recordOwnerRating(this.store, t.judgment, ownerScore); // 2.2: per-judge and jury distance from the owner's rating
    this.store.audit("owner", "judgment.rated", `${t.title}: judge ${t.judgment.score} owner ${ownerScore}`);
  }

  requestApproval(grant: McpGrant, tool: string, action: string, detail: string): Promise<Approval> {
    const p = { agentId: grant.agentId, roomId: grant.roomId, tool, action, detail };
    const a = this.store.getAgent(grant.agentId);
    // "Run without asking" only counts while the tool itself is switched on.
    if (a?.tools[tool] && a.autoApprove?.[tool]) return Promise.resolve(this.approvals.auto(p));
    return this.approvals.request(p);
  }
}
