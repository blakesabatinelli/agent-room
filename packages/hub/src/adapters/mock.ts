import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter, RunRequest, RunResult } from "./types.js";

/** The context file the hub wrote into this cwd (1.9), if any, so tests can see what the agent was given. */
function readContext(cwd: string): string | undefined {
  for (const f of ["CLAUDE.md", "AGENTS.md", ".agent-room/CONTEXT.md"]) { try { const p = join(cwd, f); if (existsSync(p)) return readFileSync(p, "utf8"); } catch { /* ignore */ } }
  return undefined;
}

/**
 * Deterministic stand-in used by tests and by practice mode, so the whole loop runs
 * without any CLI installed. It recognises the orchestrator's prompt kinds.
 *
 * Test knobs on agent.settings: quality (0..1), status ("blocked" | "needs_input"),
 * outOfScope (string), tag (agent id to tag in task/chat replies), noReport (true),
 * delayMs (task replies take this long, and can be interrupted), checks (plans include runnable
 * checks and files), bigPlan (three tasks), skipFiles (don't write deliverables), writeOutside
 * (also write this file, outside scope), verifyGap (the first goal check finds a gap),
 * recoverAsk (recovery asks the owner), recoverOwner (who recovery hands the new task to), transient (fail the
 * first N task runs with a rate-limit error; transientError sets its text, e.g. "5-hour limit reached ∙ resets 3pm"), unsure (as a judge, can't verify anything), decide (report this
 * DECISIONS line), badPlan (the first plan is broken; the repair round fixes it), failureCategory (as a judge,
 * the failure_category it gives work it sends back), noOwner (plans name no owner, so routing is learned),
 * shared (1.4: a file path; the task run MERGES one line "<name> wrote <path>" into that file instead of overwriting it,
 * and when the file holds git conflict markers it keeps both sides and drops the markers, like a careful agent would;
 * the file is not written again by the usual scope-file loop).
 * barrier ({ key, n }: a task run waits, before its delayMs, until n task runs carrying the same key are in flight at once. It never waits again once
 * the n-th has arrived, so retries and later waves are not held. Tests that assert overlap use it instead of racing delayMs against the time a worktree takes
 * to cut, which is unbounded under load. A run that is never joined gives up after 10 s, so a broken test fails on its assertions instead of hanging).
 * Every call also records the cwd it ran in (MockAdapter.calls[].cwd), so tests can see which worktree a task used.
 * wide (the plan is N independent tasks), needs (1.3: every planned task lists these data sources in its `needs`).
 * retro (2.1: how a `[[RETRO]]` call is answered: "invalid" | "empty" | "ghost" | "positive"; see the branch below).
 */
export class MockAdapter implements Adapter {
  /** Every run, for tests: which profile reached the agent. */
  static calls: { agentId: string; model?: string; effort?: string; kind: string; prompt: string; cwd: string; context?: string; readOnly?: boolean }[] = [];
  static transientSeen = new Map<string, number>();
  private static barriers = new Map<string, { arrived: number; open: boolean; open_: () => void; opened: Promise<void> }>();
  /** Wait until `n` runs with this key have started (see the `barrier` knob). Returns false if the signal aborted first. */
  private static async arrive(key: string, n: number, signal?: AbortSignal): Promise<boolean> {
    let b = MockAdapter.barriers.get(key);
    if (!b) { let open_!: () => void; const opened = new Promise<void>((r) => { open_ = r; }); b = { arrived: 0, open: false, open_, opened }; MockAdapter.barriers.set(key, b); }
    if (!b.open && ++b.arrived >= n) { b.open = true; b.open_(); }
    if (b.open) return true;
    const gaveUp = new Promise<void>((r) => { const t = setTimeout(r, 10_000); t.unref?.(); });
    const aborted = new Promise<void>((r) => signal?.addEventListener("abort", () => r()));
    await Promise.race([b.opened, gaveUp, aborted]);
    return !signal?.aborted;
  }
  async status() { return { ready: true, state: "ready" as const, detail: "Practice agent" }; }

  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    const p = req.prompt;
    const st = req.agent.settings as { quality?: number; status?: string; outOfScope?: string; tag?: string; noReport?: boolean; checks?: boolean; bigPlan?: boolean; skipFiles?: boolean; writeOutside?: string };
    const kind = (p.match(/^\[\[(\w+)\]\]/)?.[1] ?? (p.includes("# Your task:") ? "TASK" : "CHAT")).toUpperCase();
    MockAdapter.calls.push({ agentId: req.agent.id, model: req.model, effort: req.effort, kind, prompt: p, cwd: req.cwd, context: readContext(req.cwd), ...(req.readOnly ? { readOnly: true } : {}) });
    const quality = Number(st.quality ?? 0.8);
    const ids = [...new Set([...p.matchAll(/^(AC\d+):/gm)].map((m) => m[1]))];
    let text: string;
    if (p.startsWith("[[RETRO]]")) {
      // 2.1: a retro that reads the INPUT json. For every (agent, task type) pair that had a send-back it writes one lesson from the first
      // reviewer feedback, and one playbook line per task type; clean pairs get nothing. settings.retro = "invalid" answers with prose (the mechanical floor takes over),
      // "empty" answers with no lessons, "ghost" names an agent that wasn't in the goal (must be dropped), "positive" also writes a lesson for pairs that passed first time.
      const mode = (st as { retro?: string }).retro;
      if (mode === "invalid") text = "I could not produce JSON for this retro, sorry.";
      else {
        type T = { title: string; agentId: string; taskType: string; firstPass: boolean; feedback: { agentId: string; text: string }[]; failures: { agentId: string }[] };
        const input = JSON.parse(p.split("\nINPUT:\n")[1] ?? "{}") as { pairs?: { agentId: string; taskType: string }[]; tasks?: T[] };
        const lessons: unknown[] = []; const playbook: unknown[] = [];
        for (const pair of mode === "empty" ? [] : input.pairs ?? []) {
          const mine = (input.tasks ?? []).filter((t) => t.taskType === pair.taskType);
          const back = mine.flatMap((t) => t.feedback.filter((f) => f.agentId === pair.agentId).map((f) => ({ t, f })));
          if (back.length) lessons.push({ agentId: pair.agentId, taskType: pair.taskType, lesson: `Address review feedback before reporting done: ${back[0].f.text}`, evidence: `${back.length} send-back(s), first on "${back[0].t.title}"` });
          else if (mode === "positive" && mine.some((t) => t.firstPass && t.agentId === pair.agentId)) lessons.push({ agentId: pair.agentId, taskType: pair.taskType, lesson: "Keep stating each criterion's evidence in the reply; it passed first time.", evidence: `accepted first time on "${mine[0].title}"` });
        }
        if (mode !== "empty") for (const type of new Set((input.tasks ?? []).filter((t) => t.feedback.length).map((t) => t.taskType))) playbook.push({ taskType: type, add: [`For ${type} tasks, check every criterion against the files before reporting done.`], remove: [] });
        if (mode === "ghost") lessons.push({ agentId: "nobody", taskType: "coding", lesson: "This names an agent that was not in the goal.", evidence: "none" });
        text = JSON.stringify({ lessons, playbook });
      }
    } else if (p.includes("[[PLAN]]") && /^Goal: .*\?\s*$/m.test(p)) {
      text = JSON.stringify({ mode: "direct", agent: req.agent.id });
    } else if (p.includes("[[PLAN]]")) {
      const agents = [...p.matchAll(/^- ([\w-]+): /gm)].map((m) => m[1]);
      const checks = !!st.checks;
      const tasks: unknown[] = [
        { key: "a", owner: agents[1] ?? agents[0], role: "researcher", title: "Research the topic", description: "Gather at least three key facts on the topic, each with its source.", scope: "Facts only", outOfScope: ["Writing the summary"],
          files: checks ? ["research.md"] : [], criteria: checks ? ["At least 3 facts", { text: "research.md has content", check: "test -s research.md" }] : ["At least 3 facts", "Each fact has a source"], taskType: "research", dependsOn: [] },
        { key: "b", owner: agents[2] ?? agents[0], role: "worker", title: "Write the summary", description: "Write a short summary from the research task's facts, under 200 words.", scope: "The summary text", outOfScope: ["New research"],
          files: checks ? ["summary.md"] : [], criteria: checks ? [{ text: "summary.md has content", check: "test -s summary.md" }] : ["Under 200 words"], taskType: "writing", dependsOn: ["a"] },
      ];
      if (st.bigPlan) tasks.push({ key: "c", owner: agents[0], role: "reviewer", title: "Review it", description: "Check the summary against the research for errors.", criteria: ["No errors"], taskType: "analysis", dependsOn: ["b"] });
      // wide (N): N independent tasks, none depending on another (capacity tests).
      const wide = Number((st as { wide?: number }).wide ?? 0);
      if (wide) {
        tasks.length = 0;
        for (let i = 0; i < wide; i++) tasks.push({ key: `w${i}`, owner: agents[i % agents.length], role: "worker", title: `Part ${i + 1}`, description: `Write part ${i + 1} of the summary on its own, a few lines.`,
          files: [], criteria: ["A few lines"], taskType: "writing", dependsOn: [] });
      }
      if ((st as { noOwner?: boolean }).noOwner) for (const t of tasks as { owner?: string }[]) delete t.owner;
      // needs (1.3): every planned task names these data sources, like a planner that saw they need them.
      const needs = (st as { needs?: string[] }).needs;
      if (needs) for (const t of tasks as { needs?: string[] }[]) t.needs = needs;
      const bad = !!(st as { badPlan?: boolean }).badPlan && !p.includes("can't run as written");
      for (const t of tasks as { key: string; output?: string; covers?: string[]; dependsOn?: string[] }[]) {
        if (bad) { if (t.key === "b") t.dependsOn = ["zz"]; continue; }
        t.output = checks ? (t.key === "a" ? "research.md" : t.key === "b" ? "summary.md" : "review notes") : "the result, in the reply";
        t.covers = t.key === "a" || t.key === "w0" ? ["G1"] : t.key === "b" ? ["G2"] : ["G2"];
      }
      text = JSON.stringify({ mode: "plan",
        contract: { objective: "A short, sourced summary.", requirements: ["At least 3 sourced facts", "A summary under 200 words"],
          decisions: ["Facts are listed as bullets with a source each"], constraints: ["Under 200 words"], deliverables: ["summary"], outOfScope: ["Publishing anything"] },
        tasks });
    } else if (p.includes("[[JUDGE]]")) {
      const pass = quality >= 0.6;
      const drift = /out of scope: (?!none)/i.test(p);
      if ((st as { unsure?: boolean }).unsure) {
        text = JSON.stringify({ criteria: Object.fromEntries(ids.map((k) => [k, { verdict: "UNSURE", evidence: "needs the live dashboard to confirm" }])),
          on_task: true, drift: "", score: 0.7, verdict: "revise", feedback: "Can't confirm from the work shown." });
        req.onChunk?.(text);
        return { ok: true, text, durationMs: Date.now() - t0 };
      }
      text = JSON.stringify({
        criteria: Object.fromEntries(ids.map((k) => [k, { verdict: pass ? "PASS" : "FAIL", evidence: pass ? "shown in the work" : "missing" }])),
        on_task: !drift, drift: drift ? "did work outside its scope" : "",
        score: quality, verdict: pass ? "accept" : "revise", feedback: pass ? "Meets the criteria." : "Too thin, add detail.",
        ...(pass ? {} : { failure_category: (st as { failureCategory?: string }).failureCategory ?? "other" }),
      });
    } else if (p.includes("[[VERIFY]]")) {
      // verifyGap: the first whole-goal check finds G2 missing; the re-check passes.
      const recheck = p.includes("re-check after fixes");
      const gap = !!(st as { verifyGap?: boolean }).verifyGap && !recheck;
      const reqIds = [...new Set([...p.matchAll(/^(G\d+):/gm)].map((m) => m[1]))];
      text = JSON.stringify({
        requirements: Object.fromEntries(reqIds.map((g) => [g, { verdict: gap && g === "G2" ? "FAIL" : "PASS", evidence: gap && g === "G2" ? "no word count stated" : "in the files" }])),
        complete: !gap,
        gaps: gap ? [{ covers: ["G2"], owner: req.agent.id, title: "State the word count", description: "Add the summary's word count at the end so G2 can be checked.", output: "the summary, in the reply", criteria: ["Word count is stated"], taskType: "writing" }] : [],
      });
    } else if (p.includes("[[RECOVER]]")) {
      const ask = !!(st as { recoverAsk?: boolean }).recoverAsk;
      text = JSON.stringify(ask
        ? { action: "ask_owner", question: "Which audience is this for?" }
        : { action: "retry", approach: "split into a smaller step", tasks: [{ key: "r1", owner: (st as { recoverOwner?: string }).recoverOwner ?? req.agent.id, title: "Smaller first step", description: "Do the narrowest version of the stuck work first, building on finished files.", output: "the result, in the reply", criteria: ["Narrow version is done"], taskType: "other", dependsOn: [] }] });
    } else if (p.includes("[[REPLAN]]")) {
      text = JSON.stringify({ description: "Smaller step: gather the facts first, then check each one.", scope: "narrowed", criteria: ["At least 3 facts"], approach: "narrow and verify" });
    } else if (p.includes("[[STEER]]")) {
      const msg = (p.split('"""')[1] ?? "").toLowerCase();
      const kind = /\binstead\b|change direction|different goal/.test(msg) ? "replan"
        : /\bactually\b|switch to|scrap that/.test(msg) ? "redirect"
        : /\bstop\b/.test(msg) ? "stop" : /\?\s*$/.test(msg.trim()) ? "aside" : "amend";
      text = JSON.stringify({ kind, tasks: [], why: "keyword" });
    } else if (p.includes("[[MEMORY]]")) {
      text = JSON.stringify({ decision: "accept", text: p.split("PROPOSAL:")[1]?.split("\n")[1]?.trim() || "noted" });
    } else if (p.includes("[[NEUTRALIZE]]")) {
      // 2.2: a rewriter. It hands back the text between the quotes in a flat voice (badRewrite: drops the facts, like a careless one).
      const body = p.split('"""')[1]?.trim() ?? "";
      text = (st as { badRewrite?: boolean }).badRewrite ? "Work was done." : `Neutral rewrite: ${body}`;
    } else if (p.includes("[[COMPARE]]")) {
      // 4.4: a pairwise judge of a fork's two results. It prefers the candidate with more text (files and summary) unless `comparePick` says
      // otherwise: "first" / "second" always pick by position (a judge with a position bias), "tie" says they are equal, "none" answers with prose.
      const c1 = p.split("=== CANDIDATE 1 ===")[1]?.split("=== CANDIDATE 2 ===")[0] ?? "";
      const c2 = p.split("=== CANDIDATE 2 ===")[1]?.split("=== END ===")[0] ?? "";
      const mode = (st as { comparePick?: string }).comparePick;
      const reqIds2 = [...new Set([...p.matchAll(/^(R\d+):/gm)].map((m) => m[1]))];
      const pick = mode === "first" ? "1" : mode === "second" ? "2" : mode === "tie" || c1.length === c2.length ? "tie" : c1.length > c2.length ? "1" : "2";
      text = mode === "none" ? "I could not decide." : JSON.stringify({
        preferred: pick, reasons: [pick === "tie" ? "Candidate 1 and Candidate 2 are equally complete." : `Candidate ${pick} delivers more of what was asked.`],
        requirements: Object.fromEntries(reqIds2.map((k) => [k, { "1": c1.trim().length > 40 ? "PASS" : "FAIL", "2": c2.trim().length > 40 ? "PASS" : "FAIL", note: "judged from the files shown" }])),
      });
    } else if (p.includes("[[SUMMARY]]")) {
      text = "All tasks are complete. Research gathered and summary written.";
    } else if (p.includes("tagged you")) {
      text = `${req.agent.name} here: the answer is 42.`;
    } else if (p.includes("# Your task:")) {
      // write the files this task may change, like a real agent saving its deliverable
      const allowed = p.match(/You may create or change only: (.+?)\. Read anything else/)?.[1]?.split(", ") ?? [];
      const shared = (st as { shared?: string }).shared;
      if (shared) {
        const full = join(req.cwd, shared); mkdirSync(dirname(full), { recursive: true });
        const mine = `${req.agent.name} wrote ${shared}`;
        const kept = (existsSync(full) ? readFileSync(full, "utf8") : "").split("\n").filter((l) => l && !/^(<{7}|={7}|>{7})( .*)?$/.test(l));
        if (!kept.includes(mine)) kept.push(mine);
        writeFileSync(full, kept.join("\n") + "\n");
      }
      if (!st.skipFiles) for (const f of [...allowed, ...(st.writeOutside ? [st.writeOutside] : [])]) {
        if (f === shared) continue;
        const full = join(req.cwd, f); mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, `${req.agent.name} wrote ${f}\n`);
      }
      const tag = st.tag ? `\n@${st.tag} can you double-check one number for me?` : "";
      const block = st.noReport ? "" : `\nSTATUS: ${st.status ?? "done"}\n${ids.map((k) => `${k}: ${quality >= 0.6 ? "PASS" : "FAIL"} — see above`).join("\n")}\nOUT_OF_SCOPE: ${st.outOfScope ?? "none"}${(st as { decide?: string }).decide ? `\nDECISIONS: ${(st as { decide?: string }).decide}` : ""}${st.status ? "\nREASON: need the target audience" : ""}`;
      text = `${req.agent.name} finished the task.${tag}\nMEMORY: ${req.agent.name} prefers concise output.${block}`;
    } else {
      text = `${req.agent.name} finished the task.${st.tag ? `\n@${st.tag} what do you think?` : ""}\nMEMORY: ${req.agent.name} prefers concise output.`;
    }
    if (p.includes("# Your task:")) {
      const n = Number((st as { transient?: number }).transient ?? 0);
      const k = `${req.agent.id}`;
      MockAdapter.transientSeen.set(k, (MockAdapter.transientSeen.get(k) ?? 0) + 1);
      if (MockAdapter.transientSeen.get(k)! <= n) return { ok: false, text: "", durationMs: Date.now() - t0, error: (st as { transientError?: string }).transientError ?? "429 rate limit exceeded, try again later" };
    }
    const barrier = p.includes("# Your task:") ? (req.agent.settings as { barrier?: { key: string; n: number } }).barrier : undefined;
    if (barrier && !(await MockAdapter.arrive(barrier.key, barrier.n, req.signal))) return { ok: false, text: "", durationMs: Date.now() - t0, error: "Cancelled." };
    const delay = p.includes("# Your task:") ? Number((req.agent.settings as { delayMs?: number }).delayMs ?? 0) : 0;
    if (delay) {
      const aborted = await new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), delay);
        req.signal?.addEventListener("abort", () => { clearTimeout(t); r(true); });
      });
      if (aborted) return { ok: false, text: "", durationMs: Date.now() - t0, error: "Cancelled." };
    }
    req.onChunk?.(text);
    // Rough token counts (4 chars/token) so the routing log has something real to record in tests.
    const usage = { inputTokens: Math.ceil(p.length / 4), outputTokens: Math.ceil(text.length / 4), costUsd: 0 };
    return { ok: true, text, durationMs: Date.now() - t0, usage, model: `mock-${req.model ?? "default"}` };
  }
}
