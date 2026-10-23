/**
 * A demo hub for the office page's browser check (office.e2e.mjs): practice agents, one running goal with a whiteboard,
 * a working agent with two helpers, one waiting for approval, one being judged, an idle one and an offline one.
 *   pnpm --filter @agent-room/hub exec tsx test/e2e/office-demo.ts            (prints one JSON line: port, token, room)
 * OFFICE_TIER=small starts it as an 8 GB machine. Lines on stdin change the state live:
 *   {"op":"approval","agentId":"hermes"}   a new pending approval
 *   {"op":"decide","id":"<approval id>"}   approve it
 *   {"op":"status","taskId":"t_run","status":"review"}
 */
import { createInterface } from "node:readline";
import type { Approval, AgentConfig, Goal, Task } from "@agent-room/shared";
import { buildServer } from "../../src/api/server.js";
import { HW, setup } from "../helpers.js";

const ctx = setup({ hardware: process.env.OFFICE_TIER === "small" ? HW.small : HW.large });
const { store, room, approvals } = ctx;
const now = Date.now();

const extra: AgentConfig[] = [
  { id: "muse", name: "Muse", provider: "muse", adapter: "mock", enabled: true, color: "#E01E5A", settings: {}, tools: {}, avatar: "M" },
  { id: "atlas", name: "Atlas", provider: "atlas", adapter: "mock", enabled: false, color: "#3B7DD8", settings: {}, tools: {} },
];
extra.forEach((a) => store.saveAgent(a));

const goal: Goal = {
  id: "g_demo", roomId: room.id, text: "Prepare the October board update", status: "running", approvedAt: now, createdAt: now,
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
  task({ id: "t_run", title: "Draft the board narrative", status: "running", assignee: "claude" }),
  task({ id: "t_rev", title: "Check the revenue figures", status: "review", assignee: "hermes" }),
  task({ id: "t_wait", title: "Send the deck to the board", status: "running", assignee: "codex" }),
  // 3.3 fields: subagents at claude's desk, one that only reads
  { ...task({ id: "t_sub1", title: "Scan last quarter's deck", status: "running", assignee: "hermes" }), parentTaskId: "t_run", kind: "subagent", depth: 1, spawnedBy: "claude", readOnly: true } as Task,
  { ...task({ id: "t_sub2", title: "Draft the appendix tables", status: "running", assignee: "codex" }), parentTaskId: "t_run", kind: "subagent", depth: 1, spawnedBy: "claude" } as Task,
];
tasks.forEach((t) => store.saveTask(t));

const pending: Approval = { id: "apr_demo", agentId: "codex", roomId: room.id, tool: "gmail", action: "Send the board deck", detail: "To the board list", status: "pending", createdAt: now };
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
    const m = JSON.parse(line) as { op: string; agentId?: string; id?: string; taskId?: string; status?: Task["status"] };
    if (m.op === "approval") void approvals.request({ agentId: m.agentId ?? "claude", roomId: room.id, tool: "drive", action: "Share a folder", detail: "demo" });
    else if (m.op === "decide" && m.id) approvals.decide(m.id, "approved");
    else if (m.op === "status" && m.taskId && m.status) { const t = store.getTask(m.taskId); if (t) { t.status = m.status; store.saveTask(t); } }
  } catch { /* ignore a malformed line */ }
}).on("close", () => { void app.close().then(() => process.exit(0)); });
