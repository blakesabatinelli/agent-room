import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter, RunRequest, RunResult } from "./types.js";

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
 * the failure_category it gives work it sends back), noOwner (plans name no owner, so routing is learned).
 */
export class MockAdapter implements Adapter {
  /** Every run, for tests: which profile reached the agent. */
  static calls: { agentId: string; model?: string; effort?: string; kind: string; prompt: string }[] = [];
  static transientSeen = new Map<string, number>();
  async status() { return { ready: true, state: "ready" as const, detail: "Practice agent" }; }

  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    const p = req.prompt;
    const st = req.agent.settings as { quality?: number; status?: string; outOfScope?: string; tag?: string; noReport?: boolean; checks?: boolean; bigPlan?: boolean; skipFiles?: boolean; writeOutside?: string };
    const kind = (p.match(/^\[\[(\w+)\]\]/)?.[1] ?? (p.includes("# Your task:") ? "TASK" : "CHAT")).toUpperCase();
    MockAdapter.calls.push({ agentId: req.agent.id, model: req.model, effort: req.effort, kind, prompt: p });
    const quality = Number(st.quality ?? 0.8);
    const ids = [...new Set([...p.matchAll(/^(AC\d+):/gm)].map((m) => m[1]))];
    let text: string;
    if (p.includes("[[PLAN]]") && /^Goal: .*\?\s*$/m.test(p)) {
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
      if ((st as { noOwner?: boolean }).noOwner) for (const t of tasks as { owner?: string }[]) delete t.owner;
      const bad = !!(st as { badPlan?: boolean }).badPlan && !p.includes("can't run as written");
      for (const t of tasks as { key: string; output?: string; covers?: string[]; dependsOn?: string[] }[]) {
        if (bad) { if (t.key === "b") t.dependsOn = ["zz"]; continue; }
        t.output = checks ? (t.key === "a" ? "research.md" : t.key === "b" ? "summary.md" : "review notes") : "the result, in the reply";
        t.covers = t.key === "a" ? ["G1"] : t.key === "b" ? ["G2"] : ["G2"];
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
    } else if (p.includes("[[SUMMARY]]")) {
      text = "All tasks are complete. Research gathered and summary written.";
    } else if (p.includes("tagged you")) {
      text = `${req.agent.name} here: the answer is 42.`;
    } else if (p.includes("# Your task:")) {
      // write the files this task may change, like a real agent saving its deliverable
      const allowed = p.match(/You may create or change only: (.+?)\. Read anything else/)?.[1]?.split(", ") ?? [];
      if (!st.skipFiles) for (const f of [...allowed, ...(st.writeOutside ? [st.writeOutside] : [])]) {
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
