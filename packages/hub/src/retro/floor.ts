import type { RetroInput } from "./input.js";
import { splitNote } from "./input.js";
import { cleanLine, similarity, LESSON_MAX } from "./text.js";

/**
 * 2.1 The mechanical floor: lessons worked out from failure tags and repeated feedback alone, with no model call.
 * Used when the orchestrator's retro call fails or comes back unusable, so a goal that went wrong still teaches something.
 * One lesson per pattern per (agent, task type), at most three each.
 */

export interface DraftLesson { agentId: string; taskType: string; text: string; evidence: string }

const TAG_NAME: Record<string, string> = { spec: "Spec", misalignment: "Misalignment", verification: "Verification", other: "Quality" };
const LIMIT = 3;
const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

function lessonFor(tag: string, why: string, detail: string): string | undefined {
  const d = detail.replace(/\s+/g, " ").trim();
  if (tag === "other" && /^(run error|quality)$/.test(why)) return undefined; // crashes and rate limits say nothing about the agent's work
  if (tag === "placement") return undefined; // where the agent runs, not how it works: no lesson to teach it
  if (tag === "verification" && /^claimed PASS/.test(why)) return `Verification: ${why}${d ? ` (${d.slice(0, 80)})` : ""}. Run the check and open the file before marking PASS.`;
  if (tag === "verification" && why === "no self-check") return "Verification: no STATUS block in the reply. End every reply with the STATUS block and check each criterion first.";
  if (tag === "misalignment") return `Misalignment: ${why === "drift" ? "drifted off the task or out of scope" : why}${d ? ` (${d.slice(0, 90)})` : ""}. Stay inside the task's scope and files.`;
  if (tag === "spec") return `Spec: ${why}${d ? `: ${d.slice(0, 90)}` : ""}. Settle that gap in your first message instead of guessing.`;
  return `${TAG_NAME[tag] ?? "Quality"}: ${why === "judge" ? "the reviewer sent it back" : why}${d ? ` (${d.slice(0, 90)})` : ""}.`;
}

export function mechanicalLessons(input: RetroInput): DraftLesson[] {
  const out: DraftLesson[] = [];
  for (const pair of input.pairs) {
    const mine = input.tasks.filter((t) => t.taskType === pair.taskType);
    const found: DraftLesson[] = [];
    const add = (text: string | undefined, evidence: string) => {
      const clean = cleanLine(text, LESSON_MAX);
      if (clean && !found.some((f) => similarity(f.text, clean) >= 0.7)) found.push({ agentId: pair.agentId, taskType: pair.taskType, text: clean, evidence: evidence.slice(0, 160) });
    };
    // failure tags: one lesson per distinct tag and reason, with the criterion ids folded together
    const groups = new Map<string, { tag: string; why: string; detail: string; n: number; title: string }>();
    for (const t of mine) for (const f of t.failures.filter((x) => x.agentId === pair.agentId)) {
      const { why, detail } = splitNote(f.note);
      const key = `${f.tag}|${why.replace(/\bAC\d+\b/g, "AC").replace(/[\s,]+/g, " ")}`;
      const g = groups.get(key) ?? { tag: f.tag, why, detail, n: 0, title: t.title };
      g.n++; groups.set(key, g);
    }
    for (const g of [...groups.values()].sort((a, b) => b.n - a.n)) add(lessonFor(g.tag, g.why, g.detail), `${g.n} ${g.tag} failure${g.n > 1 ? "s" : ""}, first on "${g.title}"`);
    // feedback the reviewer gave this agent more than once, in nearly the same words
    const fb = mine.flatMap((t) => t.feedback.filter((f) => f.agentId === pair.agentId).map((f) => ({ text: f.text, title: t.title })));
    const used = new Set<number>();
    fb.forEach((a, i) => {
      if (used.has(i)) return;
      const same = fb.map((b, j) => ({ b, j })).filter(({ b, j }) => j === i || (!used.has(j) && similarity(a.text, b.text) >= 0.55));
      if (same.length < 2) return;
      same.forEach(({ j }) => used.add(j));
      add(`Sent back ${same.length} times for the same point: ${lower(a.text)}`, `${same.length} similar send-backs, first on "${a.title}"`);
    });
    out.push(...found.slice(0, LIMIT));
  }
  return out;
}
