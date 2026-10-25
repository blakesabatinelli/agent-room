/**
 * A demo hub for the office page's browser check (office.e2e.mjs): practice (mock) agents with personas, one running goal with a
 * "Done means" list and six planned tasks (two accepted, one being written with two helpers, one in review, one held by a pending
 * approval, one next), recent lines from each agent, an idle agent and an offline one.
 *   pnpm --filter @agent-room/hub exec tsx test/e2e/office-demo.ts            (prints one JSON line: port, token, room)
 * OFFICE_TIER=small starts it as an 8 GB machine. Lines on stdin change the state live (the page's effects come from these):
 *   {"op":"approval","agentId":"hermes"}   a new pending approval
 *   {"op":"decide","id":"<approval id>"}   approve it
 *   {"op":"status","taskId":"t_run","status":"review"}
 *   {"op":"say","agentId":"claude","text":"..."}   a line from an agent
 */
import { createInterface } from "node:readline";
import type { Approval, AgentConfig, Goal, Task } from "@agent-room/shared";
import { buildServer } from "../../src/api/server.js";
import { HW, setup } from "../helpers.js";

const ctx = setup({ hardware: process.env.OFFICE_TIER === "small" ? HW.small : HW.large });
const { store, room, approvals } = ctx;
store.saveRoom({ ...room, name: "board-update" });
const now = Date.now();
const min = 60_000;

const persona = (role: string, body: string) => ({ persona: { role, tone: "Plain and brief", body } });
const roles: Record<string, ReturnType<typeof persona>> = {
  claude: persona("Lead writer", "Turns the quarter's numbers into a story the board can read in two minutes."),
  codex: persona("Data builder", "Builds the tables and checks they add up."),
  hermes: persona("Fact checker", "Traces every figure back to its source."),
};
for (const a of store.listAgents()) if (roles[a.id]) store.saveAgent({ ...a, settings: { ...a.settings, ...roles[a.id] } });
const extra: AgentConfig[] = [
  { id: "muse", name: "Muse", provider: "muse", adapter: "mock", enabled: true, color: "#E01E5A", settings: persona("Designer", "Makes the deck look like one piece."), tools: {}, avatar: "M" },
  { id: "atlas", name: "Atlas", provider: "atlas", adapter: "mock", enabled: false, color: "#3B7DD8", settings: {}, tools: {} },
];
extra.forEach((a) => store.saveAgent(a));

const goal: Goal = {
  id: "g_demo", roomId: room.id, text: "Prepare the October board update", status: "running", approvedAt: now - 40 * min, createdAt: now - 45 * min,
  state: { decisions: [], nextAction: "Judge the revenue figures, then finish the narrative" },
  contract: {
    objective: "Prepare the October board update", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: now, amendments: [],
    requirements: [
      { id: "G1", text: "Revenue and forecast slide with this quarter's numbers", status: "met" },
      { id: "G2", text: "Venue network metrics, compared with last quarter", status: "met" },
      { id: "G3", text: "Headcount and DSO callouts", status: "open" },
      { id: "G4", text: "Open Exchange performance summary", status: "open" },
      { id: "G5", text: "One-page narrative a board member can read in two minutes", status: "unmet" },
      { id: "G6", text: "Every figure traceable to a source", status: "open" },
    ],
  },
};
store.saveGoal(goal);

const task = (o: Partial<Task> & { id: string; title: string; status: Task["status"] }): Task => ({
  roomId: room.id, goalId: goal.id, description: "", taskType: "writing", acceptance: "", dependsOn: [], attempts: 1, createdAt: now, updatedAt: now, ...o,
} as Task);
const tasks: Task[] = [
  task({ id: "t_outline", title: "Outline the board narrative", status: "done", assignee: "claude", createdAt: now - 44 * min,
    judgment: { score: 0.92, verdict: "accept", feedback: "", judgeAgentId: "hermes" }, history: [{ at: now - 31 * min, agentId: "claude", outcome: "ok", note: "92/100" }] }),
  task({ id: "t_venue", title: "Pull venue network metrics", status: "done", assignee: "codex", taskType: "data", createdAt: now - 44 * min + 1,
    judgment: { score: 0.88, verdict: "accept", feedback: "", judgeAgentId: "claude" } }),
  task({ id: "t_run", title: "Draft the board narrative", status: "running", assignee: "claude", dependsOn: ["t_outline"], claimedAt: now - 7 * min, createdAt: now - 44 * min + 2 }),
  task({ id: "t_rev", title: "Check the revenue figures", status: "review", assignee: "hermes", taskType: "analysis", dependsOn: ["t_venue"], claimedAt: now - 12 * min, createdAt: now - 44 * min + 3,
    report: { status: "done", outOfScope: "", criteria: { C1: { verdict: "PASS", evidence: "" }, C2: { verdict: "PASS", evidence: "" }, C3: { verdict: "PASS", evidence: "" }, C4: { verdict: "UNSURE", evidence: "" } } } }),
  task({ id: "t_wait", title: "Build the appendix tables", status: "running", assignee: "codex", taskType: "data", dependsOn: ["t_venue"], claimedAt: now - 5 * min, createdAt: now - 44 * min + 4 }),
  task({ id: "t_next", title: "Design the cover and charts", status: "pending", owner: "muse", dependsOn: ["t_run"], createdAt: now - 44 * min + 5 }),
  // 3.3 fields: subagents at claude's desk, one that only reads
  { ...task({ id: "t_sub1", title: "Scan last quarter's deck", status: "running", assignee: "hermes" }), parentTaskId: "t_run", kind: "subagent", depth: 1, spawnedBy: "claude", readOnly: true } as Task,
  { ...task({ id: "t_sub2", title: "Draft the appendix tables", status: "running", assignee: "codex" }), parentTaskId: "t_run", kind: "subagent", depth: 1, spawnedBy: "claude" } as Task,
];
tasks.forEach((t) => store.saveTask(t));
// how long each agent usually takes (the inspector's time-based progress)
store.saveScore({ agentId: "claude", taskType: "writing", runs: 6, quality: 0.86, avgSeconds: 15 * 60, revisions: 1, failures: 0 });
store.saveScore({ agentId: "codex", taskType: "data", runs: 4, quality: 0.8, avgSeconds: 12 * 60, revisions: 0, failures: 0 });

const say = (agentId: string, text: string, taskId?: string) => {
  const a = store.getAgent(agentId)!;
  store.addMessage({ roomId: room.id, type: "agent", author: { kind: "agent", id: a.id, name: a.name }, text, mentions: [], ...(taskId ? { taskId } : {}) });
};
say("claude", "Outline done: five sections, two pages.", "t_outline");
say("codex", "Venue network: 4,812 active screens, up 6% on Q2.\nRegional split attached as a table.", "t_venue");
say("hermes", "Checking revenue against the ledger export.\nQ3 total matches. Forecast matches.\nOne regional figure has no source yet.", "t_rev");
say("claude", "Read last quarter's deck and the forecast model.\nOpening paragraph drafted.\nNow writing the revenue section.", "t_run");
say("codex", "Appendix: 3 of 5 tables built.\nNeed the shared folder to save them.", "t_wait");
say("muse", "Ready for the cover once the draft lands.");

const pending: Approval = { id: "apr_demo", agentId: "codex", roomId: room.id, tool: "drive", action: "Save tables to the board folder", detail: "Board folder, 5 files", status: "pending", createdAt: now - 2 * min };
store.saveApproval(pending);

const app = await buildServer({ ...ctx, ownerName: "Blake" });
await app.listen({ host: "127.0.0.1", port: 0 });
const port = (app.server.address() as { port: number }).port;
const code = (app as unknown as { pairingCode: () => string }).pairingCode();
const paired = await fetch(`http://127.0.0.1:${port}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Office check" }) });
const { token } = (await paired.json()) as { token: string };
console.log(JSON.stringify({ port, token, roomId: room.id, tier: process.env.OFFICE_TIER === "small" ? "small" : "large" }));

createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    const m = JSON.parse(line) as { op: string; agentId?: string; id?: string; taskId?: string; status?: Task["status"]; text?: string };
    if (m.op === "approval") void approvals.request({ agentId: m.agentId ?? "claude", roomId: room.id, tool: "drive", action: "Share a folder", detail: "demo" });
    else if (m.op === "decide" && m.id) approvals.decide(m.id, "approved");
    else if (m.op === "status" && m.taskId && m.status) {
      const t = store.getTask(m.taskId);
      if (t) { if (m.status === "running" || m.status === "assigned") { t.claimedAt = Date.now(); t.assignee ??= t.owner; } t.status = m.status; store.saveTask(t); }
    } else if (m.op === "say" && m.agentId && m.text) say(m.agentId, m.text);
  } catch { /* ignore a malformed line */ }
}).on("close", () => { void app.close().then(() => process.exit(0)); });
