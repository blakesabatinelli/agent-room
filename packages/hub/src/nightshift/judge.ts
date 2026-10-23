import type { AgentConfig, Contract, Judgment, Task, TournamentRun, TournamentSide } from "@agent-room/shared";
import type { RunResult } from "../adapters/types.js";
import type { Store } from "../db/store.js";
import { localModelsFor } from "../discovery/usage.js";
import { aggregate, familyOf, isLocalAgent, jurySettings, neutralize, pickRewriter, readJudge, selectJudges } from "../jury/index.js";
import type { JudgeRead } from "../jury/aggregate.js";
import { judgePrompt } from "../orchestrator/prompts.js";

/**
 * 4.5 Blind pairwise judging. The same task was done twice, once for real (and accepted) and once on a night-shift re-run by another
 * agent. Both results are graded against the task's own criteria with the usual judge prompt, with nothing to say who wrote which:
 *  - each reply is rewritten into a neutral voice (2.2), and then both workers' names, ids and provider names are taken out of the reply
 *    and of the file text, so a judge can't tell the two apart by who they claim to be (a persona's voice is stripped by the neutraliser);
 *  - the judges are agents from families that are neither worker's: a jury of them when enough families are ready, otherwise ONE
 *    judge from outside both. With no judge outside both families nothing is graded (a worker's own family would be judging itself);
 *  - the order the two results are shown in is random, and so is the order of the judges;
 *  - nobody sees the other result, so a score is a score against the criteria, comparable with any other graded run.
 * The preference is the difference in the two aggregate scores; a difference under `margin` is a tie.
 */

/** Scores closer than this are a tie. */
export const TIE_MARGIN = 0.05;

/** What the judges need from the orchestrator. Narrow, so tests can drive it with fakes. */
export interface BlindHost {
  store: Store;
  readyAgents(roomId?: string): Promise<AgentConfig[]>;
  call(agent: AgentConfig, prompt: string, o?: { jsonOnly?: boolean; signal?: AbortSignal; taskId?: string }): Promise<RunResult>;
  callJson<T>(prompt: string, agent: AgentConfig, signal: AbortSignal | undefined, role: "reviewer"): Promise<T | null>;
  /** 1.5: a local judge has to be admitted, and is counted while it runs. */
  governor?: { admit(a: AgentConfig): boolean; start(key: string, a: AgentConfig): void; release(key: string): void };
  /** 1.6: is this agent expected to be rate limited at `now`? */
  quotaLimited(agentId: string, now?: number): boolean;
  /** Other names an agent writes under (its persona's name), to be taken out of what the judges read. */
  aliases?(agent: AgentConfig): string[];
}

export interface PairEntry {
  side: TournamentSide;
  agent: AgentConfig;
  /** The task as this side left it: its reply (`result`), self-report and checks. */
  task: Task;
  changed: string[];
  /** The text of the files it handed back, as read when its work was done. */
  files: string;
}
export interface PairInput {
  task: Task;
  contract?: Contract;
  notes: string[];
  entries: [PairEntry, PairEntry];
  signal?: AbortSignal;
  rand?: () => number;
  margin?: number;
  now?: number;
}
export interface SideRead { score: number; verdict: Judgment["verdict"]; feedback: string; criteria: NonNullable<Judgment["criteria"]>; onTask: boolean; answered: number }
export type PairOutcome =
  | {
      sides: Record<TournamentSide, SideRead>;
      preference: TournamentRun["preference"];
      margin: number;
      judging: "jury" | "single";
      judges: TournamentRun["judges"];
      order: TournamentSide[];
      note?: string;
    }
  | { skip: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The names an agent goes by that a judge could read as a signature: its name, id, provider and any persona name. */
function namesOf(agent: AgentConfig, aliases: string[] = []): string[] {
  return [...new Set([agent.name, agent.id, agent.provider, ...aliases].filter((n): n is string => typeof n === "string" && n.trim().length >= 3).map((n) => n.trim()))];
}

/** Both workers' names out of a text ("Claude wrote summary.md" reads "the agent wrote summary.md"). Code and numbers are untouched. */
export function scrubNames(text: string, names: string[]): string {
  if (!names.length || !text) return text;
  const re = new RegExp(`(?<![\\w@/.-])(?:${[...names].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![\\w-])`, "gi");
  return text.replace(re, "the agent");
}

/** Agents that may judge this pair: ready, not a worker, not in either worker's family, not out of quota. */
export function outsideBoth(ready: AgentConfig[], workers: AgentConfig[], localModels: string[], limited: (id: string) => boolean): AgentConfig[] {
  const families = new Set(workers.map((w) => familyOf(w, localModels)));
  return ready.filter((a) => a.enabled && !workers.some((w) => w.id === a.id) && !families.has(familyOf(a, localModels)) && !limited(a.id));
}

interface RawJudge { score?: number; verdict?: string; feedback?: string; criteria?: Record<string, { verdict?: string; evidence?: string }>; on_task?: boolean; drift?: string; failure_category?: string }

/** Judge both results of a pair. Resolves to a `skip` reason when no fair judging could be made. */
export async function judgePair(host: BlindHost, input: PairInput): Promise<PairOutcome> {
  const { store } = host;
  const rand = input.rand ?? Math.random, margin = input.margin ?? TIE_MARGIN, now = input.now ?? Date.now();
  const workers = input.entries.map((e) => e.agent);
  const localModels = localModelsFor(store);
  const limited = (id: string) => host.quotaLimited(id, now);
  const admit = (a: AgentConfig) => host.governor?.admit(a) ?? true;

  const ready = await host.readyAgents();
  const eligible = outsideBoth(ready, workers, localModels, limited);
  if (!eligible.length) return { skip: "no judge outside both workers' model families is ready" };

  // Who judges: a jury from families outside both workers, else one judge from outside both.
  const settings = store.getSettings();
  const cfg = jurySettings(settings);
  const sel = selectJudges({
    ready: eligible, worker: workers[0], workerFamily: familyOf(workers[0], localModels), localModels, settings: cfg,
    rotation: settings.judgeRotation, size: cfg.size, limited, admit,
  });
  const jury = cfg.enabled && !sel.fallback && sel.judges.length >= 2;
  const single = sel.judges.find((j) => !isLocalAgent(j, localModels)) ?? sel.judges[0] ?? eligible.find((j) => admit(j));
  const judges = jury ? sel.judges : single ? [single] : [];
  if (!judges.length) return { skip: "no judge outside both workers' model families could be used (the capacity governor did not admit one)" };

  // The same neutral voice for both: one rewriter (a local model when there is one, never a worker's family).
  const rewriter = pickRewriter({ ready: eligible, worker: workers[0], workerFamily: familyOf(workers[0], localModels), localModels, judges, limited, admit });
  const names = workers.flatMap((w) => namesOf(w, host.aliases?.(w)));
  const neutral = async (e: PairEntry): Promise<{ task: Task; files: string }> => {
    const rewrite = rewriter ? async (prompt: string) => {
      const key = `nightshift:rewrite:${input.task.id}:${e.side}`;
      if (isLocalAgent(rewriter, localModels)) host.governor?.start(key, rewriter);
      try { const r = await host.call(rewriter, prompt, { jsonOnly: true, signal: input.signal, taskId: input.task.id }); return r.ok ? r.text : undefined; }
      finally { if (isLocalAgent(rewriter, localModels)) host.governor?.release(key); }
    } : undefined;
    const n = await neutralize(scrubNames(e.task.result ?? "", names), input.task, { worker: e.agent, rewrite });
    return { task: { ...input.task, result: scrubNames(n.text, names), report: e.task.report, checks: e.task.checks }, files: scrubNames(e.files, names) };
  };
  const views = new Map<TournamentSide, { task: Task; files: string; changed: string[] }>();
  for (const e of input.entries) views.set(e.side, { ...(await neutral(e)), changed: e.changed });

  // Random order of the two results, and of the judges.
  const order: TournamentSide[] = rand() < 0.5 ? ["original", "challenger"] : ["challenger", "original"];
  const panel = [...judges].sort(() => rand() - 0.5);

  const sides = {} as Record<TournamentSide, SideRead>;
  for (const side of order) {
    const v = views.get(side)!;
    const failed = (v.task.checks ?? []).filter((r) => !r.ok);
    if (failed.length) {
      // As in a real run: a failed command settles it without a model looking.
      sides[side] = { score: 0.3, verdict: "revise", feedback: `These checks failed: ${failed.map((r) => `${r.criterionId} \`${r.command}\` exited ${r.exitCode}`).join("; ")}.`, criteria: {}, onTask: true, answered: 0 };
      continue;
    }
    const prompt = judgePrompt(v.task, input.contract, input.notes, v.changed, v.files);
    const reads = (await Promise.all(panel.map(async (agent): Promise<JudgeRead | undefined> => {
      const key = `nightshift:judge:${input.task.id}:${side}:${agent.id}`;
      const local = isLocalAgent(agent, localModels);
      if (local) host.governor?.start(key, agent);
      try {
        const raw = await host.callJson<RawJudge>(prompt, agent, input.signal, "reviewer");
        return raw ? readJudge(raw, agent, input.task, localModels) : undefined;
      } catch { return undefined; } finally { if (local) host.governor?.release(key); }
    }))).filter((r): r is JudgeRead => !!r);
    if (!reads.length) return { skip: `the judges did not answer (0 of ${panel.length})` };
    const agg = aggregate(reads, v.task);
    sides[side] = { score: agg.score, verdict: agg.verdict, feedback: agg.feedback, criteria: agg.criteria, onTask: agg.onTask, answered: reads.length };
  }

  const diff = Math.round((sides.challenger.score - sides.original.score) * 10000) / 10000;
  const preference: TournamentRun["preference"] = Math.abs(diff) < margin ? "tie" : diff > 0 ? "challenger" : "original";
  const short = Object.values(sides).some((s) => s.answered > 0 && s.answered < panel.length);
  return {
    sides, preference, margin: Math.abs(diff), judging: jury ? "jury" : "single",
    judges: panel.map((j) => ({ agentId: j.id, family: familyOf(j, localModels), local: isLocalAgent(j, localModels) })), order,
    ...(short ? { note: "some judges did not answer" } : {}),
  };
}
