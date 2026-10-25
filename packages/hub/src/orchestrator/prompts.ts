import type { AgentConfig, AgentScore, Contract, GateReport, MemoryEntry, Requirement, Task } from "@agent-room/shared";
import { REPORT_FORMAT, gateText, handle, profileText, profilesOf, roster } from "./contract.js";
import { capabilityText } from "../discovery/routing.js"; // 1.3
import { stripPersona } from "../jury/neutralize.js"; // 3.2: persona text never reaches a judge
import { runsHere } from "../placement/index.js"; // where an agent runs: only agents on this Mac can use a task folder
import { WRITE_RULE, WRITE_RULE_PLAN } from "../placement/paths.js";
import { RELAY_RULE } from "../placement/relay.js"; // save relay: an off-machine agent hands files back in its reply for a local step to save

const TYPES = "writing | research | coding | analysis | data | other";
const mem = (m: MemoryEntry[]) => m.map((x) => `- ${x.text}`).join("\n") || "- (none)";
const list = (xs: string[] | undefined) => xs?.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)";

const TAG_RULES = (agents: AgentConfig[], self?: string) => `Other agents here: ${roster(agents, self)}.
To ask one of them something, use the ask_agent tool, or tag them in your reply with @id and one
specific question. Only tag when you genuinely need something from them. Never tag to hand off or
split your own work, and never start work you were not given.`;

/** 2.3: what the planner is told about each agent's résumé (strengths and weaknesses, one short line each), and who is on probation. */
export interface ResumeNotes { lines: Record<string, string[]>; probation?: string }

function track(agents: AgentConfig[], resumes: ResumeNotes) {
  return agents.map((a) => {
    const s = (resumes.lines[a.id] ?? []).join("; "); // 2.3: the résumé's lines, not the raw score table
    const ps = profilesOf(a).map((p) => `${p.role} tier ${p.tier} (${profileText(p)})`).join("; ");
    return `- ${handle(a)}: ${a.name} — profiles: ${ps}${capabilityText(a)}${runsHere(a) ? "" : " — runs on another machine: no task folder or shell, give it text-only work (answers, research, writing or reviews handed back in the reply)"}${s ? ` — track record: ${s}` : " — no track record yet"}`; // 1.3: capabilityText says what data sources it can reach
  }).join("\n");
}

const PLAN_TASK_SCHEMA = `{"key":"t1","owner":"<agent id>","title":"...","role":"explorer|researcher|worker|reviewer",
  "description":"self-contained: what to do, which inputs to use, and why it matters to the objective",
  "output":"exactly what it hands back: a file name in the shared folder, or a precise format",
  "covers":["G1"],
  "scope":"what this task may touch","outOfScope":["what belongs to other tasks"],
  "files":["files this task alone may create or change, e.g. research.md"],
  "criteria":["checkable statement", {"text":"statement a command can decide","check":"shell command"}],
  "needs":["data sources or connectors this task must read, e.g. salesforce, gmail, drive, slack, snowflake; [] when none"],
  "workspace":true,
  "taskType":"research","dependsOn":[]}`;

export const planPrompt = (goal: string, agents: AgentConfig[], memory: MemoryEntry[], ownerNotes: string[], conversation = "", /** 2.3: no longer shown (résumés replace the raw table); kept so callers needn't change */ _scores: AgentScore[] = [], lead?: string, problems: string[] = [], previous?: string, commands = "", /** 2.3: each agent's résumé lines, and who is on probation */ resumes: ResumeNotes = { lines: {} }) => `[[PLAN]]
You are the orchestrator of a multi-agent chat room. Decide how to handle the owner's latest message.

Goal: ${goal}
${ownerNotes.length ? `Owner instructions (these override everything else):\n- ${ownerNotes.join("\n- ")}\n` : ""}
Recent conversation:
${conversation || "(none)"}

Available agents:
${track(agents, resumes)}
${resumes.probation ? `${resumes.probation}\n` : ""}${commands ? `Skills and commands each agent has (an agent whose skill matches a task is a good owner for it):\n${commands}\n` : ""}
Shared memory:
${mem(memory)}

If one agent can simply answer (a question, a quick ask, chat, a follow-up), reply:
{"mode":"direct","agent":"<agent id best suited>"}

Otherwise write a work contract and a plan:
{"mode":"plan",
 "contract":{"objective":"one sentence: what done looks like for the owner",
             "requirements":["every concrete thing the finished work must include, one checkable item each"],
             "decisions":["choices made now so tasks don't contradict each other: file names, formats, terms, tone, structure"],
             "constraints":["limits the owner set or implied"],
             "deliverables":["what gets handed back"],
             "outOfScope":["things nobody should do"]},
 "tasks":[${PLAN_TASK_SCHEMA}]}

How to plan:
- Requirements first. Expand the request into the full list of what "done" includes, the way a careful
  engineer writes a spec before starting. Missing one here is how work ends up half-finished. Each is
  numbered G1, G2… in the order you list them.
- Every requirement must be covered by at least one task ("covers"). Nothing is dropped to fit.
- 1 to ${10} tasks. Each has exactly ONE owner from the agent ids above.
- Each description must stand on its own: an agent who sees only that task must know what to do, what
  inputs to use (earlier tasks' files), what to hand back, and where its job ends. Say what and why;
  leave how to the agent.
- Tasks must not overlap. Put anything another task covers in that task's outOfScope.
- One owner per file. Later tasks read earlier tasks' files; they don't rewrite them.
- Parallel work makes hidden choices that can clash. Anything two tasks must agree on goes in
  "decisions" now. Work that edits the same deliverable runs in sequence (dependsOn), not in parallel.
- Each criterion is one statement a reviewer can mark PASS or FAIL from the files alone.
- When a script can decide a criterion, give it a "check": a read-only shell command run in the shared
  folder, exit 0 = pass (e.g. test -s summary.md, [ $(wc -w < summary.md) -le 200 ], npm test).
- A task that must read a data source (CRM, email, files in Drive, Slack, a warehouse) lists it in "needs" and goes to an
  agent whose line above says it can reach that source. Never give it to one that can't; if none can, still list the need.
  Use "needs": [] for work that needs no outside source.
- ${WRITE_RULE_PLAN}
- "workspace": true when the task creates or changes files or runs commands in its task folder; false when it only hands back text (an
  answer, research, writing or a review whose material is in its description). Only agents that run on this Mac get workspace tasks.
- Prefer the agent with the best track record for the task type; spread work only when it helps.
${lead ? `- ${lead} coordinates; don't give it every task.\n` : ""}- Roles: explorer to sweep many files for one answer, researcher for outside facts, worker to build,
  reviewer only for an independent check of hard-to-undo work. Don't use the strongest profile for routine work.
${problems.length ? `
Your previous plan can't run as written. Fix every one of these and send the whole plan again:
${problems.map((p) => `- ${p}`).join("\n")}
${previous ? `Previous plan:\n${previous.slice(0, 6000)}\n` : ""}` : ""}
taskType is one of: ${TYPES}. Reply with JSON only, no prose.`;

export const directPrompt = (conversation: string, shared: MemoryEntry[], priv: MemoryEntry[], ownerNotes: string[] = [], agents: AgentConfig[] = [], self?: string, inProgress = "") => `You are in a shared chat room with the owner and other AI agents. Reply to the owner's latest message.
${inProgress ? `\nWork in progress right now (answer from this if they ask how it's going; don't start or change any of it):\n${inProgress}\n` : ""}
Conversation so far:
${conversation || "(none)"}
${ownerNotes.length ? `\nOwner instructions (highest priority):\n- ${ownerNotes.join("\n- ")}\n` : ""}
Shared memory:
${mem(shared)}
Your private notes:
${mem(priv)}

${TAG_RULES(agents, self)}

Reply naturally and directly, the way a capable colleague would in Slack. To suggest something
for shared memory, add a line starting with "MEMORY:". Before any sensitive action (sending
email, posting to Slack, changing CRM records, deleting files) call request_approval.`;

const reqList = (reqs: Requirement[] | undefined, mine?: string[]) => reqs?.length
  ? reqs.map((r) => `- ${r.id}${mine?.includes(r.id) ? " (yours)" : ""}: ${r.text}`).join("\n") : "- (none)";

export const taskPrompt = (task: Task, goal: string, contract: Contract | undefined, deps: Task[], shared: MemoryEntry[], priv: MemoryEntry[], ownerNotes: string[], agents: AgentConfig[], self: string, feedback?: string, folder?: { path: string; files: string[]; ledger?: string; /** 1.1: what the owner's granted folder is (label, read/write) */ note?: string }, ledger?: string, decisions: string[] = [], /** 2.1: playbook and lessons from earlier goals (retro/learned.ts), capped at ~2 KB */ learned?: string, /** save relay: this agent runs off-machine on a folder task, so it hands files back in its reply */ relay = false) => `You are one agent in a room of AI agents. The orchestrator assigned you ONE task under a written work contract.
Do your task and nothing else.

# Work contract (v${contract?.version ?? 1})
Objective: ${contract?.objective ?? goal}
What the whole goal must deliver:
${reqList(contract?.requirements, task.covers)}
Constraints:
${list(contract?.constraints)}
Off limits for everyone:
${list(contract?.outOfScope)}
${ownerNotes.length ? `Owner amendments (highest priority):\n${list(ownerNotes)}\n` : ""}${decisions.length ? `Decisions already made (follow them; don't make a conflicting choice):\n${list(decisions)}\n` : ""}
# Your task: ${task.title}
${task.description}
Hand back: ${task.output ?? "your finished work, in your reply"}
Scope: ${task.scope ?? "Only what this task describes."}
Not yours (other tasks or off limits):
${list(task.outOfScope)}
Acceptance criteria:
${(task.criteria ?? []).map((c) => `${c.id}: ${c.text}${c.check ? ` (checked automatically by running: ${c.check})` : ""}`).join("\n")}
${folder ? `\n# Shared folder\nYou are working in the goal's shared folder (your current directory): ${folder.path}\nFiles there now:\n${folder.files.length ? folder.files.slice(0, 80).map((f) => `- ${f}`).join("\n") : "- (empty)"}\nSave your deliverables there.${folder.note ? ` ${folder.note.trim()}` : ""}${folder.ledger ? " This is your own isolated copy of the goal's folder: other tasks' work reaches it only once accepted, and yours joins the shared folder when it is accepted. If you are told your work conflicts with another task's, keep both changes." : ""}${task.files?.length ? ` You may create or change only: ${task.files.join(", ")}. Read anything else, but don't edit it.` : ""}\n${folder.ledger ? `The orchestrator's progress record is ${folder.ledger}` : "LEDGER.md there is the orchestrator's progress record"}: read it any time, never edit it.\n` : relay ? `\n# Handing files back\nThis task works on a task folder, but you run on another machine and have no folder here. ${RELAY_RULE}${task.files?.length ? ` The files this task should hand back: ${task.files.join(", ")}.` : ""}\n` : ""}${deps.length ? `\n# Inputs from earlier tasks\n${deps.map((d) => `## ${d.title}${d.output ? ` (handed back: ${d.output})` : ""}\n${(d.result ?? "").slice(0, 4000)}${(d.result ?? "").length > 4000 ? "\n(cut here; the full work is in its files)" : ""}`).join("\n\n")}\n` : ""}
Shared memory:
${mem(shared)}
Your private notes:
${mem(priv)}
${learned ? `\n${learned}\n` : ""}${task.history?.length ? `\n# Earlier attempts at this task (don't repeat what failed)\n${task.history.slice(-6).map((h) => `- ${h.outcome.toUpperCase()} (${h.agentId}): ${h.note.slice(0, 300)}`).join("\n")}\n` : ""}${feedback ? `\n# Sent back\nYour previous attempt was returned. Fix exactly this: ${feedback}\n${task.result ? `What you handed back last time (start from it; don't throw good work away):\n"""\n${task.result.slice(0, 2500)}\n"""\n` : ""}` : ""}
# Rules
- Stay inside your scope. If the right answer needs work outside it, say so in REASON; don't do it.
- ${folder ? WRITE_RULE : relay ? "Hand every deliverable file back as a === FILE: <relative path> ... === END FILE block (see \"Handing files back\" above); the hub saves them into the task folder. Use relative paths only." : "You have no task folder on your machine: hand your work back as text in your reply, and don't write files."} If a step needs somewhere else, report STATUS: blocked and say which.
- ${TAG_RULES(agents, self).replace(/\n/g, " ")}
- The owner may steer while you work. Call get_updates between major steps and before you
  finish; anything it returns overrides earlier instructions.
- If you can't finish without input, stop and use STATUS: blocked or needs_input. Don't guess.
- Verify your own work before reporting: open the files you wrote, run the checks listed above.
  Mark a criterion PASS only if your work shows it. Don't claim done if any criterion fails.
- Before any sensitive action (sending email, posting to Slack, changing CRM records, deleting
  files) call request_approval and only proceed if approved. To suggest shared memory, add a
  line starting with "MEMORY:".
${ledger ? `\n# Where the whole goal stands right now\n${ledger.replace(/^# .*\n/, "").replace(/^## /gm, "### ").trim()}\n` : ""}
# Right now
Your one job: ${task.title}. Hand back: ${task.output ?? "your finished work"}.
Done when every criterion above passes. Nothing outside your scope.

Reply with your finished work, then:
${REPORT_FORMAT}`;

export const judgePrompt = (task: Task, contract: Contract | undefined, ownerNotes: string[], changed: string[] = [], files = "", previousFeedback?: string) => `[[JUDGE]]
You review one agent's work against a written contract. Be strict and fair; do not favour any provider's style.
You have no stake in this work and didn't see it being made: judge only what's in front of you.

Objective: ${contract?.objective ?? "(single task)"}
Task: ${task.title}
${task.description}
It should hand back: ${task.output ?? "its finished work"}
Scope: ${task.scope ?? "as described"}
Not this task's job:
${list(task.outOfScope)}
Criteria:
${(task.criteria ?? []).map((c) => {
  const run = task.checks?.find((r) => r.criterionId === c.id);
  return `${c.id}: ${c.text}${run ? ` [already verified by running \`${run.command}\`: ${run.ok ? "PASS" : "FAIL"}]` : ""}`;
}).join("\n")}
${ownerNotes.length ? `Owner amendments: ${ownerNotes.join("; ")}\n` : ""}${previousFeedback ? `Last review sent it back for: ${previousFeedback}\nCheck that this was actually fixed.\n` : ""}Files the agent changed in the shared folder: ${changed.length ? changed.join(", ") : "none"}
Agent's self-report: ${task.report ? `STATUS ${task.report.status}; ${Object.entries(task.report.criteria).map(([k, v]) => `${k} ${v.verdict}`).join(", ") || "no criteria"}; out of scope: ${task.report.outOfScope}` : "none"}

Submitted reply:
"""
${stripPersona(task.result ?? "").slice(0, 10000)}
"""
${files ? `\nThe deliverable files as they are now (judge these; the reply can overstate them):\n"""\n${stripPersona(files)}\n"""\n` : ""}
Check each criterion yourself; don't trust the self-report. Done is a property of the files, not of
the message. The work must reflect every owner amendment. Check for drift: did the agent do other
tasks' work, wander from the objective, or pad with things nobody asked for?
Use UNSURE only when the evidence can't be in the work you were shown; then say in "evidence"
exactly what would settle it. Otherwise decide PASS or FAIL.
Reply with JSON only:
{"criteria":{"AC1":{"verdict":"PASS|FAIL|UNSURE","evidence":"short"}},
 "on_task":true,"drift":"empty, or what drifted",
 "score":0.0-1.0,"verdict":"accept"|"revise"|"reassign",
 "feedback":"for each failing criterion: what's wrong and the specific fix",
 "failure_category":"spec|misalignment|verification|other (only when not accepting)"}
"accept" only if every criterion is PASS and on_task is true. "revise" when it's fixable,
"reassign" when this agent seems unable to do it.
failure_category: "spec" if the task itself was unclear or contradictory, "misalignment" if the agent
drifted or clashed with other agents' work or the decisions, "verification" if it claimed done without
checking (its self-report says PASS where the work fails), else "other".`;

export const replanPrompt = (task: Task, contract: Contract | undefined, agents: AgentConfig[]) => `[[REPLAN]]
A task under a work contract failed twice. Don't retry the same approach: change it.

Objective: ${contract?.objective ?? ""}
Task: ${task.title}
${task.description}
Criteria:
${(task.criteria ?? []).map((c) => `${c.id}: ${c.text}`).join("\n")}
Attempts so far:
${(task.history ?? []).map((h) => `- ${h.outcome.toUpperCase()} by ${h.agentId}: ${h.note}`).join("\n") || "- (none)"}
Agents: ${agents.map((a) => handle(a)).join(", ")}

Rewrite the task with a different approach. Keep the same objective; you may narrow scope,
clarify the description, or move it to a different owner. Don't weaken a criterion just to pass it.
Reply with JSON only:
{"owner":"<agent id>","description":"...","scope":"...","criteria":["..."],"approach":"short label for the new approach"}`;

export const tagPrompt = (from: string, question: string, conversation: string, shared: MemoryEntry[], priv: MemoryEntry[], agents: AgentConfig[], self: string, hopsLeft: number) => `${from} tagged you in a shared room of AI agents and needs something from you.

Their message:
"""
${question}
"""

Recent conversation:
${conversation || "(none)"}
Shared memory:
${mem(shared)}
Your private notes:
${mem(priv)}

Answer what they asked, briefly and concretely. Don't take over their task or start new work.
${hopsLeft > 0 ? `If you truly need a third agent, you may tag them (${roster(agents, self)}).` : "Don't tag anyone else; this thread has gone back and forth enough. If it's unresolved, say what the owner needs to decide."}`;

export const summaryPrompt = (goal: string, contract: Contract | undefined, tasks: Task[], gate: GateReport) => `[[SUMMARY]]
Write the final report to the owner. Lead with the outcome, then the key results.
${gate.passed && !contract?.requirements?.some((r) => r.status === "unmet") ? "Every acceptance check passed." : "NOT everything passed. Say plainly what is unfinished; don't call it done."}
If any check couldn't be verified, say which, so the owner can look at it.
Plain prose, short.

Goal: ${goal}
Objective: ${contract?.objective ?? goal}
Requirements:
${contract?.requirements?.map((r) => `- ${r.id} ${r.text}: ${r.status === "met" ? "met" : r.status === "unmet" ? `NOT MET${r.evidence ? ` (${r.evidence})` : ""}` : "not separately verified"}`).join("\n") ?? "- (none listed)"}
Checks:
${gateText(gate)}
${tasks.map((t) => `## ${t.title} (${t.status}, by ${t.assignee})\n${(t.result ?? "").slice(0, 3000)}`).join("\n\n")}`;

export const memoryPrompt = (proposal: string, existing: MemoryEntry[], hint: { source?: string; expiresInDays?: number; today?: string } = {}) => `[[MEMORY]]
You keep the room's shared memory. Decide what to do with an agent's proposed entry.
Keep memory short, factual, durable and non-duplicated. Every entry expires, so stale facts drop out on their own.
Today is ${hint.today ?? new Date().toISOString().slice(0, 10)}.

Existing shared memory:
${existing.map((m) => `- [${m.id}] ${m.text} (from ${m.source?.kind ?? "agent"}${m.source?.kind === "goal" ? ` ${m.source.id}` : ""}; expires ${m.expiresAt ? new Date(m.expiresAt).toISOString().slice(0, 10) : "unknown"})`).join("\n") || "- (none)"}

PROPOSAL:
${proposal}
${hint.source ? `\nThe proposer got this from: ${hint.source}.` : ""}${hint.expiresInDays ? `\nThe proposer thinks it stays true for about ${hint.expiresInDays} days.` : ""}

Classify the entry: "fact" (about the world or the work; default 90 days), "preference" (how the owner likes things done; default 365 days) or
"status" (what is happening right now, "currently ...", "this week ..."; default 14 days). Set expiresInDays only when you know better than the default
(a meeting on a given date is true until then). If the proposal says the opposite of, or a different value for, an existing entry, set "contradicts" to that entry's id.
Do not merge a contradiction into the old entry; the owner will be asked.

Reply with JSON only:
{"decision":"accept"|"reject"|"merge","text":"final wording","mergeWith":"existing id if merge","kind":"fact"|"preference"|"status","expiresInDays":number or null,"contradicts":"existing id or null"}`;

/** Whole-goal check after every task passed: does the finished work actually meet the requirements? */
export const verifyPrompt = (goal: string, contract: Contract | undefined, tasks: Task[], files: string, agents: AgentConfig[], round: number) => `[[VERIFY]]
Every task in this goal passed its own review. Your job is different: check the finished work as a whole
against the requirements, the way the owner will when they open it. Tasks can each pass and still leave
gaps between them, contradict each other, or miss a requirement nobody owned.

Goal: ${goal}
Objective: ${contract?.objective ?? goal}
Requirements:
${contract?.requirements?.map((r) => `${r.id}: ${r.text}`).join("\n") ?? "(none listed)"}
Constraints:
${list(contract?.constraints)}
Decisions everyone was told to follow:
${list(contract?.decisions)}

What each task handed back:
${tasks.filter((t) => t.status === "done").map((t) => `## ${t.title} (covers ${t.covers?.join(", ") || "—"}; ${t.output ?? "reply"})\n${(t.result ?? "").slice(0, 1500)}`).join("\n\n")}
${files ? `\nThe deliverable files:\n"""\n${files}\n"""\n` : ""}
Mark each requirement PASS only if the files (or replies, where no file was asked for) show it. For each
gap, write one task that closes it: self-contained, small, with its own output and criteria, owned by one
of: ${agents.map((a) => a.id).join(", ")}. ${WRITE_RULE_PLAN} ${round > 0 ? "This is a re-check after fixes: only list gaps that are still real." : ""}
Reply with JSON only:
{"requirements":{"G1":{"verdict":"PASS|FAIL","evidence":"short"}},
 "complete":true|false,
 "gaps":[{"covers":["G2"],"owner":"<agent id>","title":"...","description":"...","output":"...","files":["..."],"criteria":["..."],"taskType":"writing"}]}`;

/** A task failed for good, or the goal stopped moving: find another way to the remaining requirements. */
export const recoverPrompt = (goal: string, contract: Contract | undefined, ledger: string, failed: Task[], agents: AgentConfig[], why: string) => `[[RECOVER]]
Work on this goal is stuck. Don't give up on the objective and don't repeat what already failed.
Why you're being asked: ${why}

Objective: ${contract?.objective ?? goal}

Progress ledger:
${ledger}

${failed.map((t) => `## Stuck: ${t.title} (covers ${t.covers?.join(", ") || "—"})
${t.description}
Attempts:
${(t.history ?? []).map((h) => `- ${h.outcome.toUpperCase()} by ${h.agentId}: ${h.note.slice(0, 300)}`).join("\n") || "- (none)"}`).join("\n\n")}

Agents: ${agents.map((a) => a.id).join(", ")}

${WRITE_RULE_PLAN}

Choose one:
- "retry": write replacement tasks that reach the same requirements a different way (smaller steps,
  different agent, different inputs). Finished tasks stay finished; build on their files.
- "ask_owner": only if the work truly can't continue without a decision or information from the owner.
  Ask one specific question.
Reply with JSON only:
{"action":"retry"|"ask_owner","question":"only for ask_owner","approach":"short label",
 "tasks":[${PLAN_TASK_SCHEMA}]}
Keys in "dependsOn" refer only to the new tasks you list.`;

export const steerPrompt = (message: string, objective: string, inFlight: { id: string; title: string; agent: string; status: string }[], tagged?: string) => `[[STEER]]
The owner sent a message while agents are working. Decide how to treat it.

Objective of the current work: ${objective}
Work in flight:
${inFlight.map((t) => `- ${t.id}: "${t.title}" (${t.agent}, ${t.status})`).join("\n") || "- (none)"}
${tagged ? `The owner tagged: ${tagged}\n` : ""}
Owner's message:
"""
${message}
"""

Kinds:
- aside: a question or chat that doesn't change the work (status checks, side questions).
- amend: adds or adjusts a detail that the current work can absorb without starting over.
- redirect: what's being done right now is wrong given this message; restart the affected tasks with it.
- replan: the goal itself changes direction (different deliverable or approach); replan the remaining work.
- stop: the owner wants the work stopped.
When unsure between amend and redirect, pick amend.
Reply with JSON only: {"kind":"aside|amend|redirect|replan|stop","tasks":["ids affected; empty means all in flight"],"why":"short"}`;

/** The plan as the owner sees it before approving. Not a model prompt. */
export const planCard = (contract: Contract, tasks: Task[], agents: AgentConfig[], profileFor: (t: Task) => string) => [
  `Here's the plan before anyone starts.`,
  ``,
  `**Goal:** ${contract.objective}`,
  ...(contract.constraints.length ? [`**Limits:** ${contract.constraints.join("; ")}`] : []),
  ...(contract.outOfScope.length ? [`**Not doing:** ${contract.outOfScope.join("; ")}`] : []),
  ...(contract.requirements?.length ? [``, `**Done means:**`, ...contract.requirements.map((r) => `- ${r.text}`)] : []),
  ...(contract.decisions?.length ? [`**Decided up front:** ${contract.decisions.join("; ")}`] : []),
  ``,
  ...tasks.map((t, i) => {
    const a = agents.find((x) => x.id === t.owner);
    const checks = t.criteria ?? [];
    return `${i + 1}. **${t.title}** — ${a?.name ?? "best available"} (${profileFor(t)})${t.output ? `, hands back ${t.output}` : ""}${t.dependsOn.length ? `, after ${t.dependsOn.map((d) => tasks.findIndex((x) => x.id === d) + 1).join(", ")}` : ""}\n` +
      checks.map((c) => `   - ${c.text}${c.check ? `  \`${c.check}\`` : ""}`).join("\n") +
      (t.files?.length ? `\n   - Files: ${t.files.join(", ")}` : "");
  }),
  ``,
  tasks.some((t) => t.criteria?.some((c) => c.check)) ? "Approving also lets the commands shown above run in this goal's folder." : "",
  `Approve to start, or tell me what to change. Anything missing from "Done means" is worth catching now.`,
].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
