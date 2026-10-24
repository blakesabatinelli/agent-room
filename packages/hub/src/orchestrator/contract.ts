import type { AgentConfig, Criterion, GateReport, Profile, Role, Task, TaskReport, Verdict } from "@agent-room/shared";
import { now } from "../util.js";

/** The block every task result must end with. Shown to agents verbatim. */
export const REPORT_FORMAT = `End your reply with this block, exactly:
STATUS: done | blocked | needs_input
AC1: PASS|FAIL — <evidence: where in your work it is met>
AC2: PASS|FAIL — <evidence>
OUT_OF_SCOPE: none | <anything you did outside your task's scope>
DECISIONS: none | <choices other tasks must match, e.g. file names, formats, terms, assumptions; separate with ;>
REASON: <only if blocked or needs_input: what you need, from whom>`;

const VERDICT = /^(PASS|FAIL|UNSURE)\b/i;

/** Pull the STATUS block off the end of an agent's reply. Missing block => status "missing". */
export function parseReport(text: string): { body: string; report: TaskReport } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*\**STATUS\**\s*:/i.test(l));
  const report: TaskReport = { status: "missing", criteria: {}, outOfScope: "none" };
  if (start < 0) return { body: text.trim(), report };
  for (const raw of lines.slice(start)) {
    const l = raw.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").trim();
    const m = l.match(/^([A-Z_]+\d*)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toUpperCase(); const val = m[2].trim();
    if (key === "STATUS") {
      const s = val.toLowerCase().replace(/[\s-]+/g, "_");
      report.status = s.startsWith("done") ? "done" : s.startsWith("blocked") ? "blocked" : s.startsWith("needs") ? "needs_input" : "missing";
    } else if (/^AC\d+$/.test(key)) {
      const v = val.match(VERDICT);
      report.criteria[key] = { verdict: (v?.[1].toUpperCase() ?? "UNSURE") as Verdict, evidence: val.replace(VERDICT, "").replace(/^[\s—–:-]+/, "").trim() };
    } else if (key === "OUT_OF_SCOPE") report.outOfScope = val || "none";
    else if (key === "REASON") report.reason = val;
    else if (key === "DECISIONS" && !/^none\b/i.test(val)) report.decisions = val.split(/\s*;\s*/).map((d) => d.trim()).filter(Boolean).slice(0, 8);
  }
  return { body: lines.slice(0, start).join("\n").trim() || text.trim(), report };
}

/** Normalise planner criteria: accept strings or {id,text}, number them AC1..n. */
export function normaliseCriteria(raw: unknown, fallback: string): Criterion[] {
  const list = Array.isArray(raw) ? raw : [];
  const items = list.map((c) => typeof c === "string" ? { text: c } : { text: String((c as { text?: string })?.text ?? ""), check: (c as { check?: string })?.check })
    .map((c) => ({ text: c.text.trim(), check: typeof c.check === "string" && c.check.trim() ? c.check.trim().slice(0, 500) : undefined }))
    .filter((c) => c.text);
  if (!items.length) items.push({ text: fallback || "Fully does what the task describes.", check: undefined });
  return items.slice(0, 6).map((c, i) => ({ id: `AC${i + 1}`, text: c.text, ...(c.check ? { check: c.check } : {}) }));
}

/** Things the agent's own report says are wrong, before any judge sees it. */
export function selfReportedDrift(task: Task, report: TaskReport): string[] {
  const flags: string[] = [];
  if (report.status === "missing") flags.push("No STATUS block at the end of the reply.");
  if (report.outOfScope && !/^none\b/i.test(report.outOfScope)) flags.push(`Worked outside scope: ${report.outOfScope}`);
  const missing = (task.criteria ?? []).filter((c) => !report.criteria[c.id]).map((c) => c.id);
  if (report.status === "done" && missing.length) flags.push(`Didn't report on ${missing.join(", ")}.`);
  return flags;
}

/** "Done means gated": every criterion of every task needs PASS from the judge. */
export function gate(tasks: Task[]): GateReport {
  const lines = tasks.flatMap((t) => (t.criteria ?? []).map((c) => {
    const j = t.judgment?.criteria?.[c.id];
    const verdict: Verdict = t.status !== "done" ? "FAIL" : j?.verdict ?? (t.judgment?.verdict === "accept" ? "PASS" : "UNSURE");
    const flagged = verdict === "UNSURE" && !!t.flagged?.includes(c.id);
    return { taskId: t.id, task: t.title, criterion: `${c.id}: ${c.text}`, verdict, flagged,
      evidence: flagged ? `couldn't be verified by two reviewers${j?.evidence ? `: ${j.evidence}` : ""}` : j?.evidence || (t.status !== "done" ? `Task ${t.status}.` : "") };
  }));
  // Unverifiable criteria the reviewers flagged don't block the goal; they're listed for the owner instead.
  return { passed: lines.length > 0 && lines.every((l) => l.verdict === "PASS" || l.flagged), at: now(), lines: lines.map(({ flagged, ...l }) => ({ ...l, ...(flagged ? { flagged } : {}) })) };
}

export function gateText(g: GateReport) {
  const pass = g.lines.filter((l) => l.verdict === "PASS").length;
  const unverified = g.lines.filter((l) => l.flagged);
  const head = g.passed && !unverified.length ? `All ${g.lines.length} checks passed.`
    : g.passed ? `${pass} of ${g.lines.length} checks passed; ${unverified.length} couldn't be verified (check these yourself).`
    : `${pass} of ${g.lines.length} checks passed.`;
  const fails = g.lines.filter((l) => l.verdict !== "PASS").map((l) => `- ${l.task} — ${l.criterion}: ${l.flagged ? "UNVERIFIED" : l.verdict}${l.evidence ? ` (${l.evidence})` : ""}`);
  return fails.length ? `${head}\n${fails.join("\n")}` : head;
}

/** Compact handle for an agent: its id, or its name with spaces removed. */
export const handle = (a: AgentConfig) => a.id.toLowerCase();
const nameHandle = (a: AgentConfig) => a.name.toLowerCase().replace(/[^a-z0-9_-]/g, "");

/** Agents tagged in text, in the order they first appear. Unknown tags are ignored. */
export function resolveMentions(text: string, agents: AgentConfig[]): AgentConfig[] {
  // ignore tags inside code spans/blocks so pasted code doesn't ping anyone
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const out: AgentConfig[] = [];
  for (const m of plain.matchAll(/(?:^|[^\w@])@([\w-]+)/g)) {
    const tag = m[1].toLowerCase();
    const a = agents.find((x) => handle(x) === tag || nameHandle(x) === tag);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * A roll call: the owner wants every agent in the room to answer, not one picked by routing. Either a room-wide tag (`@all`, `@everyone`,
 * `@here`, `@agents`) or a short message that names everyone ("each agent", "all of you", "everyone") and asks them to speak ("respond",
 * "reply", "introduce", "chime in"...). A longer message is a real request and goes to planning as before.
 */
export function isRollCall(text: string): boolean {
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  if (/(?:^|[^\w@])@(all|everyone|everybody|here|agents|room)\b/i.test(plain)) return true;
  if (plain.length > 300) return false;
  const everyone = /\b(each|every)\s+(agent|one\s+of\s+(you|the\s+agents|them)|model|bot)s?\b|\ball\s+(of\s+)?(you|the\s+)?agents\b|\ball\s+of\s+(you|them)\b|\b(everyone|everybody|you\s+all|y'all)\b/i;
  const speak = /\b(respond|reply|answer|introduce|chime\s+in|weigh\s+in|sound\s+off|check\s+in|say\s+(hi|hello)|share|vote|give\s+(me\s+)?(your|their))\b/i;
  return everyone.test(plain) && speak.test(plain);
}

export function roster(agents: AgentConfig[], self?: string) {
  return agents.filter((a) => a.id !== self).map((a) => `@${handle(a)} (${a.name})`).join(", ") || "(nobody else)";
}

/**
 * Floor control: who may speak in a room right now. An agent may post when it holds
 * work there, was tagged there recently, or the room is its own DM.
 */
export class Floor {
  private grants = new Map<string, number>(); // `${agentId}|${roomId}` -> expiry
  give(agentId: string, roomId: string, ms = 20 * 60_000) { this.grants.set(`${agentId}|${roomId}`, Date.now() + ms); }
  take(agentId: string, roomId: string) { this.grants.delete(`${agentId}|${roomId}`); }
  has(agentId: string, roomId: string) {
    const exp = this.grants.get(`${agentId}|${roomId}`);
    if (exp && exp < Date.now()) this.grants.delete(`${agentId}|${roomId}`);
    return !!exp && exp >= Date.now();
  }
}

// ---------- profiles (delegation-policy roles with model and effort)

/** An agent's profiles; agents without any get one default profile from settings.model. */
export function profilesOf(a: AgentConfig): Profile[] {
  return a.profiles?.length ? a.profiles
    : [{ id: "default", label: "Default", role: "worker", model: a.settings.model as string | undefined, tier: 2 }];
}

/**
 * The cheapest profile on this agent that fits the role, at or above minTier.
 * Explorer and researcher work falls back to the cheapest profile; reviews to the strongest.
 */
export function pickProfile(a: AgentConfig, role: Role = "worker", minTier = 1): Profile {
  const all = profilesOf(a);
  const top = Math.max(...all.map((p) => p.tier));
  const pool = all.filter((p) => p.tier >= Math.min(minTier, top));
  const byTier = (xs: Profile[], desc = false) => [...xs].sort((x, y) => desc ? y.tier - x.tier : x.tier - y.tier);
  const exact = pool.filter((p) => p.role === role);
  if (exact.length) return byTier(exact, role === "reviewer")[0];
  if (role === "reviewer") return byTier(pool, true)[0];
  if (role === "explorer" || role === "researcher") return byTier(pool)[0];
  return byTier(pool.filter((p) => p.role === "worker"))[0] ?? byTier(pool)[0];
}

export const profileText = (p: Profile) => [p.model, p.effort].filter(Boolean).join(" · ") || "default model";
