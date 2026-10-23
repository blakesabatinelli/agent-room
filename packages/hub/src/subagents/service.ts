import type { AgentConfig, Goal, GoalProgress, GoalState, Profile, SubagentSettings, Task } from "@agent-room/shared";
import { SETTING_DEFAULTS } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { RunResult } from "../adapters/types.js";
import type { GoalRef, TaskWorkspace, TaskWorkspaces, WorkspaceHooks } from "../orchestrator/worktree.js";
import type { Floor } from "../orchestrator/contract.js";
import type { McpGrant } from "../orchestrator/orchestrator.js";
import { pickProfile } from "../orchestrator/contract.js";
import { newProgress } from "../orchestrator/ledger.js";
import { closeRecord, fixedDecision, openRecord, type RouteDecision } from "../orchestrator/routing.js";
import { snapshot } from "../orchestrator/workspace.js";
import { quotaDecide, quotaLimited } from "../quota/router.js";
import { barredSet } from "../resume/probation.js";
import { id, now } from "../util.js";
import { ChildSpaces } from "./childspace.js";
import type { NativeEvent } from "./native.js";
import { clashPrompt, helperPrompt, type HelperBrief } from "./prompts.js";

/**
 * 3.3 Subagents across the platform (PRODUCT.md 6.5, DECISIONS.md D8).
 *
 * A ROOM subagent is a child task an agent starts with the hub's spawn_agent tool. It is its own task in the store (kind "subagent",
 * parentTaskId, depth, spawnedBy), run by any agent (a different vendor from the parent when the parent says so), with a grant of its own, so it can
 * post, ask other agents and start helpers like any agent. It is NOT planned, judged or scored: the parent stays accountable and the
 * parent's own judgment covers what the helper did. Its routing record has reason "subagent" and no judgment.
 *
 * A NATIVE subagent is one the agent's own tool launched (Claude Code's Agent/Task tool, Codex); the adapter reports the events and this records
 * them as children of the running task, for the tree only (not routed, judged or budgeted).
 *
 * Limits (D8, settings `subagents`): depth, spawns per goal, helpers running at once per parent. A refusal is plain text for the parent and an audit entry.
 * Read-only helpers get no write tools and a throwaway copy of the parent's folder; a writing helper gets its own worktree (childspace.ts).
 */

export const SUBAGENT_DEFAULTS: SubagentSettings = SETTING_DEFAULTS.subagents;
export function subagentSettings(store: Store): SubagentSettings {
  const s = store.getSettings().subagents ?? {};
  const pick = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  return { maxDepth: pick(s.maxDepth, SUBAGENT_DEFAULTS.maxDepth), budgetPerGoal: pick(s.budgetPerGoal, SUBAGENT_DEFAULTS.budgetPerGoal), maxParallel: Math.max(1, pick(s.maxParallel, SUBAGENT_DEFAULTS.maxParallel)) };
}

export interface SpawnArgs {
  agent?: string; vendor?: string; instructions: string; readOnly?: boolean; files?: string[]; expects?: string; wait?: boolean; timeoutSeconds?: number;
}

/** What the service needs from the orchestrator (narrow, so the pieces can be driven with fakes). */
export interface SubagentHost {
  store: Store;
  dataDir: string;
  workspaces: TaskWorkspaces;
  ref(goal: Goal): GoalRef;
  readyAgents(roomId?: string): Promise<AgentConfig[]>;
  /** Is the agent holding a task or answering chat? With `set`, mark it busy or free. */
  busy(agentId: string, set?: boolean): boolean;
  governor: { admit(a: AgentConfig): boolean; start(key: string, a: AgentConfig): void; release(key: string): void; preferForOverflow(c: AgentConfig[]): AgentConfig[] };
  floor: Floor;
  call(agent: AgentConfig, prompt: string, o: { roomId: string; taskId: string; signal: AbortSignal; profile: Profile; cwd: string; hop?: number; readOnly?: boolean }): Promise<RunResult>;
  /** The abort signal of a task's live run (the parent's), so a stop or a redirect reaches its helpers. */
  runSignal(taskId: string): AbortSignal | undefined;
  /** A quiet line in the room's work log. */
  log(roomId: string, text: string, taskId?: string): void;
  hooks(): WorkspaceHooks;
  /** A plain folder for a read-only helper whose parent has no worktree (a direct answer). */
  scratch(agentId: string, roomId: string): string;
  settings(): { explorationRate: number };
  rand?: () => number;
}

interface Flight { promise: Promise<void>; ctrl: AbortController; agentId: string; readOnly: boolean; parentId: string }

const OPEN_STATES = new Set(["running", "review"]);
const short = (s: string, n: number) => (s.replace(/\s+/g, " ").trim().length > n ? `${s.replace(/\s+/g, " ").trim().slice(0, n - 1)}…` : s.replace(/\s+/g, " ").trim());
const stripMemory = (t: string) => t.replace(/^[ \t]*MEMORY:.*(?:\r?\n|$)/gim, "").trim() || t.trim();

/** Which agents does this word mean? "claude", "anthropic", "openai", "codex" all work. */
const VENDOR_ALIASES: Record<string, string[]> = { claude: ["anthropic"], anthropic: ["anthropic"], openai: ["openai"], gpt: ["openai"], chatgpt: ["openai"], codex: ["openai"] };
export function matchesVendor(a: AgentConfig, vendor: string): boolean {
  const v = vendor.trim().toLowerCase();
  if (!v) return true;
  if ([a.provider, a.id, a.name, a.adapter].some((x) => String(x ?? "").toLowerCase() === v)) return true;
  return (VENDOR_ALIASES[v] ?? []).includes(String(a.provider).toLowerCase());
}

export class Subagents {
  readonly spaces: ChildSpaces;
  private flights = new Map<string, Flight>();
  private merging = new Set<string>();
  /** Native subagent task ids by `${parentTaskId}|${eventId}`, so a start and its end meet. */
  private natives = new Map<string, string>();
  constructor(private host: SubagentHost) { this.spaces = new ChildSpaces(host.workspaces, host.dataDir); }

  private get store() { return this.host.store; }

  // ---------- bookkeeping
  private bump(goalId: string, change: (p: GoalProgress) => void) {
    const g = this.store.getGoal(goalId); if (!g) return;
    const st: GoalState = g.state ?? { decisions: [], nextAction: "" };
    const p = st.progress ?? newProgress();
    change(p); st.progress = p; g.state = st; this.store.saveGoal(g);
  }
  /** Save a child and tell live clients (the tree in the apps and the office view listen for `subagent`). */
  private save(t: Task) {
    this.store.saveTask(t);
    if (t.parentTaskId) this.store.emit("event", { type: "subagent", parentTaskId: t.parentTaskId, task: t });
  }
  private refuse(agentId: string, why: string) {
    this.store.audit(agentId, "subagent.refused", why.slice(0, 300));
    return `NOT STARTED. ${why}`;
  }
  private children(parentId: string, goalId: string) { return this.store.listTasks({ goalId, subagents: true }).filter((t) => t.parentTaskId === parentId); }
  private childOf(grant: McpGrant, childId: string): Task | undefined {
    const t = this.store.getTask(childId);
    return t?.kind === "subagent" && !t.native && t.parentTaskId === grant.taskId && t.spawnedBy === grant.agentId ? t : undefined;
  }
  /** Is this agent running a read-only helper right now? (MCP agents use their own keys, so their file tools check this.) */
  readOnlyNow(agentId: string): boolean { return [...this.flights.values()].some((f) => f.agentId === agentId && f.readOnly); }

  // ---------- spawn_agent
  async spawn(grant: McpGrant, args: SpawnArgs): Promise<string> {
    const refuse = (why: string) => this.refuse(grant.agentId, why);
    if (grant.shadow) return refuse("Practice runs can't start helpers.");
    if (!grant.taskId) return refuse("Only an agent working on a task can start helpers. This key has no task.");
    const parent = this.store.getTask(grant.taskId);
    if (!parent || parent.assignee !== grant.agentId || parent.status !== "running") return refuse("You can start helpers only while you are working on your task.");
    const goal = this.store.getGoal(parent.goalId);
    if (!goal || ["done", "failed", "superseded"].includes(goal.status)) return refuse("This goal is no longer running.");
    const instructions = (args.instructions ?? "").trim();
    if (instructions.length < 5) return refuse("Say what the helper should do (instructions).");
    const readOnly = args.readOnly !== false;
    const cfg = subagentSettings(this.store);
    const parentAgent = this.store.getAgent(grant.agentId);
    if (!parentAgent) return refuse("Your agent record is missing.");
    const depth = (parent.depth ?? 0) + 1;

    const limits = (): string | undefined => {
      if (depth > cfg.maxDepth) return `Helpers can go ${cfg.maxDepth} level${cfg.maxDepth === 1 ? "" : "s"} deep and you are already at level ${depth - 1}. Do this part yourself.`;
      const p = this.store.getGoal(goal.id)?.state?.progress ?? newProgress();
      const spawned = p.subagents?.spawned ?? 0;
      if (spawned >= cfg.budgetPerGoal) return `This goal has used its budget of ${cfg.budgetPerGoal} helper${cfg.budgetPerGoal === 1 ? "" : "s"}. Do the rest yourself, or say in your reply that it needs more.`;
      const taskBudget = p.budget ?? (this.store.getSettings().maxTaskRuns ?? SETTING_DEFAULTS.maxTaskRuns);
      if (p.runs >= taskBudget) return `This goal has used its budget of ${taskBudget} task runs, and helper runs count in it.`;
      const live = this.children(parent.id, goal.id).filter((t) => !t.native && t.status === "running").length;
      if (live >= cfg.maxParallel) return `You already have ${live} helpers running (the limit is ${cfg.maxParallel} at once). Wait for one to finish with subagent_status.`;
      return undefined;
    };
    const early = limits();
    if (early) return refuse(early);

    const parentWs = this.spaces.parent(goal.id, parent.id);
    if (!readOnly && !parentWs) return refuse("A helper can write only into a folder of yours, and you don't have one on this task. Ask for a read-only helper (readOnly: true) and make the change yourself.");

    const picked = await this.pick(args, parentAgent, parent);
    if ("why" in picked) return refuse(picked.why);
    // Everything above could have changed while agents were looked up: check again and take the spot in the same tick.
    const again = limits();
    if (again) return refuse(again);
    const { agent, route } = picked;
    this.bump(goal.id, (p) => { p.runs += 1; p.subagents = { spawned: (p.subagents?.spawned ?? 0) + 1, native: p.subagents?.native ?? 0 }; });
    this.host.busy(agent.id, true);

    const title = short(instructions.split("\n")[0], 80);
    const child: Task = {
      id: id("sub"), roomId: parent.roomId, goalId: parent.goalId, title, description: instructions, taskType: parent.taskType || "other",
      acceptance: "Answers the parent's request.", dependsOn: [], owner: agent.id, assignee: agent.id, role: readOnly ? "explorer" : "worker",
      files: (args.files ?? []).filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()).slice(0, 40), output: args.expects?.trim() || undefined,
      status: "running", attempts: 1, history: [], createdAt: now(), updatedAt: now(),
      parentTaskId: parent.id, depth, spawnedBy: grant.agentId, kind: "subagent", readOnly,
    };
    this.host.governor.start(child.id, agent); // counted like any run; released when it ends
    child.routingId = openRecord(this.store, { ...route, reason: "subagent" }, child, goal.text, "subagent").id; // 0.2: in the routing log, never judged
    this.save(child);
    this.store.audit(grant.agentId, "subagent.spawned", `${child.id} for ${parent.id}: ${agent.id} ${readOnly ? "read-only" : "writes"}, level ${depth}: ${title}`.slice(0, 300));
    this.host.log(parent.roomId, `${parentAgent.name} started a helper: ${agent.name} (${readOnly ? "read-only" : "can write"}): ${title}`, child.id);
    this.host.floor.give(agent.id, parent.roomId);

    const ctrl = new AbortController();
    const up = this.host.runSignal(parent.id) ?? this.flights.get(parent.id)?.ctrl.signal;
    const onUp = () => ctrl.abort();
    if (up?.aborted) ctrl.abort(); else up?.addEventListener("abort", onUp, { once: true });
    const flight: Flight = { promise: Promise.resolve(), ctrl, agentId: agent.id, readOnly, parentId: parent.id };
    flight.promise = this.run(child, agent, parentAgent, flight, grant.hop ?? 0).finally(() => {
      up?.removeEventListener("abort", onUp);
      this.flights.delete(child.id); // over: its agent is no longer read-only
      this.host.busy(agent.id, false);
      this.host.floor.take(agent.id, parent.roomId);
      this.host.governor.release(child.id);
    });
    this.flights.set(child.id, flight);
    return this.waitOrReturn(child.id, flight, args.wait !== false, args.timeoutSeconds);
  }

  private async waitOrReturn(childId: string, flight: Flight, wait: boolean, timeoutSeconds?: number): Promise<string> {
    if (!wait) return `Started helper ${childId}. It runs on its own. Call subagent_status with id ${childId} to see when it is done and read its answer.`;
    const limit = Math.min(1800, Math.max(5, timeoutSeconds ?? 600)) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), limit); timer.unref?.(); });
    const r = await Promise.race([flight.promise.then(() => "done" as const), late]);
    clearTimeout(timer);
    if (r === "late") return `The helper ${childId} is still running after ${Math.round(limit / 1000)} seconds. Carry on with something else and call subagent_status with id ${childId} later.`;
    return this.render(this.store.getTask(childId)!);
  }

  /** Choose who runs it: the named agent, or one of a vendor, or learned routing among everyone free except the parent. */
  private async pick(args: SpawnArgs, parentAgent: AgentConfig, parent: Task): Promise<{ agent: AgentConfig; route: RouteDecision } | { why: string }> {
    const store = this.store, host = this.host;
    const ready = await host.readyAgents(parent.roomId); // 4.4: the roster of the parent's room (a fork lane has its own)
    const barred = barredSet(store, ready); // agents on probation practise on copies; they take no real work
    const usable = (a: AgentConfig) => a.id !== parentAgent.id && !host.busy(a.id) && !barred.has(a.id) && !quotaLimited(store, a.id);
    const want = (args.agent ?? "").trim().replace(/^@/, "");
    const named = want && want.toLowerCase() !== "any" ? want : "";
    const vendor = (args.vendor ?? "").trim();
    if (named) {
      const a = store.listAgents().find((x) => x.id === named.toLowerCase()) ?? store.listAgents().find((x) => x.name.toLowerCase() === named.toLowerCase());
      if (!a) return { why: `No agent called "${named}". Agents here: ${store.listAgents().filter((x) => x.enabled).map((x) => x.id).join(", ")}.` };
      if (a.id === parentAgent.id) return { why: "That is you. A helper of the same agent is not started here; use your own subagent tool for that." };
      if (!a.enabled) return { why: `${a.name} is switched off.` };
      if (!ready.some((x) => x.id === a.id)) return { why: `${a.name} isn't connected right now.` };
      if (vendor && !matchesVendor(a, vendor)) return { why: `${a.name} isn't a "${vendor}" agent.` };
      if (host.busy(a.id)) return { why: `${a.name} is busy with another task. Try another agent or "any".` };
      if (barred.has(a.id)) return { why: `${a.name} is still on probation and takes no real work.` };
      if (quotaLimited(store, a.id)) return { why: `${a.name} is out of quota right now.` };
      if (!host.governor.admit(a)) return { why: `This Mac can't take more work for ${a.name} right now.` };
      return { agent: a, route: fixedDecision(store, a, ready.filter((x) => x.id !== a.id), parent.taskType || "other", "subagent", 0) };
    }
    let pool = ready.filter(usable);
    if (vendor) {
      pool = pool.filter((a) => matchesVendor(a, vendor));
      if (!pool.length) return { why: `No ${vendor} agent is free and connected right now.` };
    }
    pool = host.governor.preferForOverflow(pool);
    if (!pool.length) return { why: "No other agent is free right now. Do it yourself, or try again in a moment." };
    const route = quotaDecide(store, pool, parent.taskType || "other", host.settings().explorationRate, [parentAgent.id], host.rand);
    if (!route) return { why: "No other agent is free right now." };
    return { agent: route.agent, route };
  }

  // ---------- running a helper
  private brief(child: Task, parentAgent: AgentConfig, parent: Task, folder?: string): HelperBrief {
    return {
      parentName: parentAgent.name, parentTitle: parent.title, title: child.title, instructions: child.description, expects: child.output, files: child.files ?? [],
      readOnly: !!child.readOnly, depth: child.depth ?? 1, maxDepth: subagentSettings(this.store).maxDepth, folder,
      others: this.store.listAgents().filter((a) => a.enabled && a.id !== child.assignee).map((a) => ({ id: a.id, name: a.name })),
    };
  }

  private async run(child: Task, agent: AgentConfig, parentAgent: AgentConfig, flight: Flight, hop: number, resolve?: string[]): Promise<void> {
    const store = this.store, host = this.host;
    const goal = store.getGoal(child.goalId), parent = store.getTask(child.parentTaskId!);
    const rid = child.routingId;
    const t0 = Date.now();
    let work: TaskWorkspace | undefined;
    let res: RunResult | undefined;
    try {
      if (!goal || !parent) throw new Error("The goal or the parent task is gone.");
      // Where it works: its own worktree cut from the parent's current state (a writing helper's, and a read-only helper's throwaway copy), or a plain folder.
      work = this.spaces.find(goal.id, child.id) ?? await this.spaces.open(goal.id, parent.id, child.id, agent.id);
      if (!work && !child.readOnly) throw new Error("Could not cut a work folder from the parent's folder.");
      const cwd = work?.path ?? host.scratch(agent.id, child.roomId);
      if (work) await this.hook("beforeRun", work, agent.id);
      const prompt = resolve ? clashPrompt(this.brief(child, parentAgent, parent, cwd), resolve) : helperPrompt(this.brief(child, parentAgent, parent, child.readOnly ? undefined : cwd));
      const profile = pickProfile(agent, child.readOnly ? "explorer" : "worker");
      child.profileId = profile.id; this.save(child);
      closeRecord(store, rid, { profileId: profile.id, modelRequested: profile.model ?? ((agent.settings?.model as string | undefined) || undefined) });
      res = await host.call(agent, prompt, { roomId: child.roomId, taskId: child.id, signal: flight.ctrl.signal, profile, cwd, hop, readOnly: !!child.readOnly });
    } catch (e) {
      res = { ok: false, text: "", durationMs: Date.now() - t0, error: (e as Error).message };
    }
    await this.settle(child.id); // this helper's own helpers are over with it
    const ran = { usage: res.usage, seconds: Math.round(res.durationMs) / 1000, ...(res.model ? { modelVersion: res.model } : {}) };
    const fresh = store.getTask(child.id) ?? child;
    Object.assign(child, { ...fresh, history: fresh.history ?? [] });
    if (flight.ctrl.signal.aborted) {
      closeRecord(store, rid, { ...ran, outcome: "interrupted" });
      child.status = "cancelled"; child.result = child.result ?? "Stopped before it finished.";
      await this.spaces.discard(child.goalId, child.id).catch(() => undefined);
      this.save(child); return;
    }
    if (!res.ok) {
      closeRecord(store, rid, { ...ran, outcome: "run_failed", failureNote: (res.error ?? "failed").split("\n")[0].slice(0, 300) });
      child.status = "failed"; child.result = `It could not finish: ${(res.error ?? "unknown error").split("\n").find((l) => l.trim())?.slice(0, 300) ?? "unknown error"}`;
      child.history = [...(child.history ?? []), { at: now(), agentId: agent.id, outcome: "fail", note: child.result.slice(0, 300) }];
      await this.spaces.discard(child.goalId, child.id).catch(() => undefined);
      this.save(child);
      this.host.log(child.roomId, `${agent.name} couldn't finish the helper task: ${child.title}`, child.id);
      return;
    }
    closeRecord(store, rid, { ...ran, outcome: "answered" }); // no judgment: the parent's judgment covers it
    child.result = stripMemory(res.text).slice(0, 20000);
    child.history = [...(child.history ?? []), { at: now(), agentId: agent.id, outcome: "ok", note: resolve ? "merge fix" : "finished" }];
    if (child.readOnly || !work) {
      child.status = "done";
      await this.spaces.discard(child.goalId, child.id).catch(() => undefined); // a read-only helper's copy is thrown away: nothing is ever merged from it
    } else {
      await this.hook("beforeMerge", work, agent.id);
      const w = await this.spaces.finish(child.goalId, child.id, agent.id, child.title);
      if (w.files.length) {
        child.pendingMerge = { files: w.files, conflictRounds: child.pendingMerge?.conflictRounds ?? 0 };
        child.status = "review"; // waits for the parent: accept_subagent or discard_subagent
        this.diffs.set(child.id, w);
      } else {
        child.status = "done"; child.pendingMerge = undefined;
        await this.spaces.discard(child.goalId, child.id).catch(() => undefined);
      }
    }
    this.save(child);
    if (!resolve) this.host.log(child.roomId, `${agent.name} finished the helper task: ${child.title}${child.status === "review" ? ` (${child.pendingMerge!.files.length} changed file${child.pendingMerge!.files.length === 1 ? "" : "s"} waiting for ${parentAgent.name})` : ""}`, child.id);
  }
  private diffs = new Map<string, { files: string[]; stat: string; diff: string }>();

  private async hook(name: keyof WorkspaceHooks, ws: TaskWorkspace, agentId: string) {
    const fn = this.host.hooks()[name]; if (!fn) return;
    try { await fn({ goalId: ws.goalId, taskId: ws.taskId, agentId, path: ws.path, kind: ws.kind }); } catch (e) { this.store.audit(agentId, "worktree.hook", `${name} failed: ${String(e).slice(0, 200)}`); }
  }

  // ---------- what the parent reads back
  private render(t: Task): string {
    const agent = this.store.getAgent(t.assignee ?? "")?.name ?? t.assignee ?? "the helper";
    const mode = t.readOnly ? "read-only" : "can write";
    const rec = t.routingId ? this.store.getRouting(t.routingId) : undefined;
    const tokens = (rec?.usage?.inputTokens ?? 0) + (rec?.usage?.outputTokens ?? 0);
    const report = `Report: ${agent}${rec?.modelVersion ? ` (${rec.modelVersion})` : ""} · ${mode}${rec?.seconds !== undefined ? ` · ${rec.seconds}s` : ""}${tokens ? ` · about ${tokens} tokens` : ""}`;
    if (t.status === "running") return `Helper ${t.id} (${agent}, ${mode}) is still running.`;
    if (t.status === "failed") return `Helper ${t.id} (${agent}) failed: ${t.result ?? "no reason given"}\nTry another agent, or do this part yourself.`;
    if (t.status === "cancelled") return `Helper ${t.id} (${agent}) was stopped${t.result ? `: ${t.result}` : "."}`;
    const lines = [`Helper ${t.id}: ${agent} (${mode}) finished "${t.title}".`, ``, t.result ?? "(no answer)", ``, `---`, report];
    if (t.status === "review" && t.pendingMerge) {
      const d = this.diffs.get(t.id);
      lines.push(``, `It changed ${t.pendingMerge.files.length} file${t.pendingMerge.files.length === 1 ? "" : "s"} in its OWN folder: ${t.pendingMerge.files.slice(0, 20).join(", ")}. None of this is in your folder yet.`);
      if (d?.stat) lines.push(d.stat);
      if (d?.diff) lines.push("", "```diff", d.diff.slice(0, 4000), "```");
      lines.push(``, `Read the change. Call accept_subagent with id ${t.id} to bring it into your folder, or discard_subagent to drop it. You are accountable for what you accept; it is judged as part of your task.`);
    }
    return lines.join("\n");
  }

  /** subagent_status: one helper, or (no id) all of this task's helpers. */
  status(grant: McpGrant, childId?: string): string {
    if (!grant.taskId) return "This key has no task, so it has no helpers.";
    if (childId) {
      const c = this.childOf(grant, childId);
      return c ? this.render(c) : `No helper ${childId} of yours.`;
    }
    const parent = this.store.getTask(grant.taskId);
    if (!parent) return "No helpers.";
    const kids = this.children(parent.id, parent.goalId);
    if (!kids.length) return "You have no helpers on this task.";
    return kids.map((t) => `${t.id} | ${t.native ? "native" : t.readOnly ? "read-only" : "writes"} | ${t.status} | ${this.store.getAgent(t.assignee ?? "")?.name ?? "-"} | ${t.title}`).join("\n");
  }

  // ---------- accept / discard (writing helpers)
  async accept(grant: McpGrant, childId: string): Promise<string> {
    const child = this.childOf(grant, childId);
    if (!child) return `No helper ${childId} of yours.`;
    if (child.readOnly) return "A read-only helper has nothing to merge.";
    const parent = this.store.getTask(child.parentTaskId!);
    if (child.status === "running") return "That helper is still working. Wait for it with subagent_status.";
    if (child.status !== "review" || !child.pendingMerge || !parent) return `Nothing to accept: the helper is ${child.status}.`;
    if (this.merging.has(child.id)) return "That change is already being merged.";
    this.merging.add(child.id);
    try {
      const agent = this.store.getAgent(child.assignee ?? "")!, parentAgent = this.store.getAgent(grant.agentId)!;
      const merge = (round: number) => this.spaces.merge(child.goalId, parent.id, child.id, { childAgentId: agent.id, parentAgentId: parentAgent.id, title: child.title, round });
      let r = await merge(child.pendingMerge.conflictRounds);
      if (!r.ok && r.to === "child" && child.pendingMerge.conflictRounds < 1) {
        // First clash: back to the child, once, with the parent's latest work in its folder.
        const rerun = await this.reRun(child, agent, parentAgent, r.conflict, grant.hop ?? 0);
        if (!rerun.ok) return `The change clashes with your latest work in ${r.conflict.join(", ")}. ${rerun.why} Discard it with discard_subagent, or redo that part yourself.`;
        r = await merge(1);
      }
      if (r.ok) {
        child.pendingMerge = undefined; child.status = "done"; this.save(child);
        await this.spaces.discard(child.goalId, child.id).catch(() => undefined);
        this.diffs.delete(child.id);
        this.store.audit(grant.agentId, "subagent.merged", `${child.id} into ${parent.id}: ${r.merged.slice(0, 12).join(", ") || "nothing new"}`.slice(0, 300));
        this.host.log(child.roomId, `${parentAgent.name} took ${agent.name}'s helper changes into its own folder (${r.merged.length} file${r.merged.length === 1 ? "" : "s"}): ${child.title}`, child.id);
        return r.merged.length ? `Merged into your folder: ${r.merged.join(", ")}. They are part of your work now and are judged with it.` : "Already in your folder. Nothing to merge.";
      }
      if (r.to === "parent") {
        child.pendingMerge = { ...child.pendingMerge, conflictRounds: 2 }; child.status = "done"; child.result = `${child.result ?? ""}\n(Its change clashed with yours; the conflict is in your folder.)`.trim(); this.save(child);
        await this.spaces.discard(child.goalId, child.id).catch(() => undefined);
        this.store.audit(grant.agentId, "subagent.conflict", `${child.id} into ${parent.id}: ${r.conflict.slice(0, 12).join(", ")} left for the parent`.slice(0, 300));
        return `The helper's change still clashes with yours in ${r.conflict.join(", ")}, after it tried once to fix it. The conflict markers (<<<<<<<, =======, >>>>>>>) are now in YOUR folder. Open those files, keep both changes, remove every marker. Your task can't be accepted while markers remain.`;
      }
      return `The change still has conflict markers in ${r.conflict.join(", ")}. The helper has to resolve them first; call accept_subagent again once it has.`;
    } finally { this.merging.delete(child.id); }
  }

  /** The child's change clashed with its parent's: run the child once more to resolve it (in its own folder). */
  private async reRun(child: Task, agent: AgentConfig, parentAgent: AgentConfig, conflict: string[], hop: number): Promise<{ ok: true } | { ok: false; why: string }> {
    const host = this.host;
    if (host.busy(agent.id)) return { ok: false, why: `${agent.name} is busy with something else, so it couldn't be asked to fix it.` };
    child.pendingMerge = { files: child.pendingMerge?.files ?? [], conflictRounds: 1 };
    child.status = "running"; this.save(child);
    host.busy(agent.id, true); host.floor.give(agent.id, child.roomId);
    const key = `sub:${agent.id}:${child.id}:fix`;
    host.governor.start(key, agent);
    const ctrl = new AbortController();
    const up = host.runSignal(child.parentTaskId!) ?? this.flights.get(child.parentTaskId!)?.ctrl.signal;
    up?.addEventListener("abort", () => ctrl.abort(), { once: true });
    const flight: Flight = { promise: Promise.resolve(), ctrl, agentId: agent.id, readOnly: false, parentId: child.parentTaskId! };
    this.flights.set(child.id, flight);
    try {
      child.routingId = openRecord(this.store, { ...fixedDecision(this.store, agent, [], child.taskType, "subagent", 0) }, child, this.store.getGoal(child.goalId)?.text ?? "", "subagent").id;
      await (flight.promise = this.run(child, agent, parentAgent, flight, hop, conflict));
    } finally { this.flights.delete(child.id); host.busy(agent.id, false); host.floor.take(agent.id, child.roomId); host.governor.release(key); }
    const now_ = this.store.getTask(child.id);
    if (!now_ || now_.status === "failed" || now_.status === "cancelled") return { ok: false, why: `${agent.name} couldn't fix it.` };
    Object.assign(child, now_);
    return { ok: true };
  }

  async discard(grant: McpGrant, childId: string): Promise<string> {
    const child = this.childOf(grant, childId);
    if (!child) return `No helper ${childId} of yours.`;
    if (["done", "failed", "cancelled"].includes(child.status) && !child.pendingMerge) return `That helper is already ${child.status}.`;
    const flight = this.flights.get(child.id);
    if (child.status === "running") { flight?.ctrl.abort(); await flight?.promise.catch(() => undefined); }
    const t = this.store.getTask(child.id) ?? child;
    t.status = "cancelled"; t.pendingMerge = undefined; t.result = "Dropped by the agent that started it."; this.save(t);
    await this.spaces.discard(child.goalId, child.id).catch(() => undefined);
    this.diffs.delete(child.id);
    this.store.audit(grant.agentId, "subagent.discarded", `${child.id} of ${child.parentTaskId}`);
    this.host.log(child.roomId, `${this.store.getAgent(grant.agentId)?.name ?? grant.agentId} dropped a helper's work: ${child.title}`, child.id);
    return "Dropped. Nothing from it reached your folder.";
  }

  // ---------- the parent's run is over
  /** Helpers still running are stopped; changes the parent never accepted are dropped. Called right after a task's run returns. */
  async settle(parentTaskId: string): Promise<void> {
    const parent = this.store.getTask(parentTaskId);
    if (!parent) return;
    for (const c of this.children(parentTaskId, parent.goalId)) {
      if (c.native) continue;
      if (c.status === "running") { const f = this.flights.get(c.id); f?.ctrl.abort(); await f?.promise.catch(() => undefined); }
      else if (c.status === "review") {
        const t = this.store.getTask(c.id) ?? c;
        t.status = "cancelled"; t.pendingMerge = undefined; t.result = `${t.result ?? ""}\n(Its changes were never accepted, so they were dropped.)`.trim(); this.save(t);
        await this.spaces.discard(c.goalId, c.id).catch(() => undefined);
        this.host.log(c.roomId, `Dropped a helper's unaccepted changes: ${c.title}`, c.id);
      }
    }
    for (const k of [...this.flights.keys()]) if (this.store.getTask(k)?.status !== "running") this.flights.delete(k);
  }

  /** Hub restart: helpers that were mid-run died with it. They are never picked up again. */
  cancelOrphans(): number {
    let n = 0;
    for (const room of this.store.listRooms()) for (const t of this.store.listTasks({ roomId: room.id, subagents: true })) {
      if (t.kind === "subagent" && (t.status === "running" || t.status === "review" || t.status === "pending")) {
        t.status = "cancelled"; t.pendingMerge = undefined; t.result = t.result ?? "Stopped when the hub restarted."; this.store.saveTask(t); n++;
        void this.spaces.discard(t.goalId, t.id).catch(() => undefined); // its folder and snapshot ref go with it
      }
    }
    return n;
  }

  // ---------- native subagents (AC5)
  /** The agent's own tool launched or finished a subagent inside this task's run. For the tree only. */
  native(taskId: string, agentId: string, ev: NativeEvent): void {
    try {
      const parent = this.store.getTask(taskId);
      if (!parent || parent.kind === "subagent" && parent.native) return;
      const key = `${taskId}|${ev.id}`;
      let tid = this.natives.get(key);
      if (ev.phase === "start") {
        if (tid) return;
        tid = id("nat"); this.natives.set(key, tid);
        const agent = this.store.getAgent(agentId);
        const t: Task = {
          id: tid, roomId: parent.roomId, goalId: parent.goalId, title: short(ev.description || ev.subagentType || "Subagent", 80),
          description: [ev.subagentType ? `Agent type: ${ev.subagentType}` : "", ev.prompt ?? ""].filter(Boolean).join("\n\n").slice(0, 4000),
          taskType: "other", acceptance: "", dependsOn: [], owner: agentId, assignee: agentId, status: "running", attempts: 1, createdAt: now(), updatedAt: now(),
          parentTaskId: parent.id, depth: (parent.depth ?? 0) + 1, spawnedBy: agentId, kind: "subagent", native: true,
        };
        this.save(t);
        this.bump(parent.goalId, (p) => { p.subagents = { spawned: p.subagents?.spawned ?? 0, native: (p.subagents?.native ?? 0) + 1 }; }); // visibility only: not in the budget
        this.host.log(parent.roomId, `${agent?.name ?? agentId} started a built-in helper: ${t.title}`, t.id);
      } else if (tid) {
        const t = this.store.getTask(tid); if (!t) return;
        t.status = ev.ok === false ? "failed" : "done";
        if (ev.result) t.result = ev.result.slice(0, 20000);
        this.save(t); this.natives.delete(key);
      }
    } catch (e) { this.store.audit(agentId, "subagent.native.error", String((e as Error).message).slice(0, 200)); }
  }
}
