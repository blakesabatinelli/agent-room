/**
 * A demo hub for the "simple by default" browser check (home.e2e.mjs): a couple of rooms, one running goal with a "Done means" list
 * and live tasks, a pending approval, and agents with deliberately different usage (plenty, getting low, almost out, unlimited).
 *   pnpm --filter @agent-room/hub exec tsx test/e2e/home-demo.ts            (prints one JSON line: port, token, roomId)
 */
import type { Approval, Goal, Subscription, Task } from "@agent-room/shared";
import { buildServer } from "../../src/api/server.js";
import { quotaFor } from "../../src/quota/index.js";
import { setup } from "../helpers.js";

const ctx = setup();
const { store, room } = ctx;
store.saveRoom({ ...room, name: "board-update", topic: "The October board deck" });
const other = store.createRoom("ops-review", { topic: "Weekly operating review" });
const now = Date.now();
const min = 60_000;

// Personas so the rooms feel real.
const persona = (role: string, body: string) => ({ persona: { role, tone: "Plain and brief", body } });
const roles: Record<string, ReturnType<typeof persona>> = {
  claude: persona("Lead writer", "Turns the quarter's numbers into a story the board can read in two minutes."),
  codex: persona("Data builder", "Builds the tables and checks they add up."),
  hermes: persona("Fact checker", "Traces every figure back to its source."),
};
for (const a of store.listAgents()) if (roles[a.id]) store.saveAgent({ ...a, settings: { ...a.settings, ...roles[a.id] } });

// A running goal with a Done-means list.
const goal: Goal = {
  id: "g_demo", roomId: room.id, text: "Prepare the October board update", status: "running", approvedAt: now - 40 * min, createdAt: now - 45 * min,
  state: { decisions: [], nextAction: "Judge the revenue figures, then finish the narrative" },
  contract: {
    objective: "Prepare the October board update", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: now, amendments: [],
    requirements: [
      { id: "G1", text: "Revenue and forecast slide", status: "met" },
      { id: "G2", text: "Venue network metrics vs last quarter", status: "met" },
      { id: "G3", text: "Headcount and DSO callouts", status: "open" },
      { id: "G4", text: "One-page narrative", status: "unmet" },
    ],
  },
} as Goal;
store.saveGoal(goal);

// A second room's goal, waiting on the owner.
store.saveGoal({ id: "g_ops", roomId: other.id, text: "Pull this week's operating numbers", status: "running", approvedAt: now - 10 * min, createdAt: now - 12 * min,
  state: { decisions: [], nextAction: "Chart the week-over-week change" }, contract: { objective: "Pull this week's operating numbers", constraints: [], deliverables: [], outOfScope: [], version: 1, lockedAt: now, amendments: [], requirements: [{ id: "O1", text: "Revenue, supply and delivery, week over week", status: "open" }] } } as Goal);

const task = (o: Partial<Task> & { id: string; title: string; status: Task["status"] }): Task => ({
  roomId: room.id, goalId: goal.id, description: "", taskType: "writing", acceptance: "", dependsOn: [], attempts: 1, createdAt: now, updatedAt: now, ...o,
} as Task);
[
  task({ id: "t_outline", title: "Outline the board narrative", status: "done", assignee: "claude", judgment: { score: 0.92, verdict: "accept", feedback: "", judgeAgentId: "hermes" } }),
  task({ id: "t_run", title: "Draft the board narrative", status: "running", assignee: "claude", claimedAt: now - 7 * min }),
  task({ id: "t_rev", title: "Check the revenue figures", status: "review", assignee: "hermes", taskType: "analysis", claimedAt: now - 12 * min }),
].forEach((t) => store.saveTask(t));

// A pending approval, so the live strip and Approvals show something.
const pending: Approval = { id: "apr_demo", agentId: "codex", roomId: room.id, tool: "drive", action: "Save tables to the board folder", detail: "Board folder, 5 files", status: "pending", createdAt: now - 2 * min };
store.saveApproval(pending);

// Usage: give each agent a visibly different status. Claude plenty, Codex getting low, with Hermes unlimited (local).
const q = quotaFor(store);
q.saveSubscriptions(q.subscriptions().map((s): Subscription => {
  if (s.id === "claude") return { ...s, plan: "Max 5x", windows: { fiveHour: { limitRuns: 100 }, weekly: { limitRuns: 1000 } } };
  if (s.id === "codex") return { ...s, plan: "Pro", windows: { fiveHour: { limitRuns: 100 }, weekly: { limitRuns: 400 } } };
  return s;
}));
const use = (subId: string, agentId: string, n: number) => { for (let i = 0; i < n; i++) q.ledger.record({ agentId, subscriptionId: subId, at: now - (n - i) * min, tokensIn: 100, tokensOut: 50, runs: 1, rateLimited: false, source: "task" }); };
use("claude", "claude", 18);   // ~82% left: plenty
use("codex", "codex", 72);     // ~28% left: getting low

const app = await buildServer({ ...ctx, ownerName: "Blake" });
await app.listen({ host: "127.0.0.1", port: 0 });
const port = (app.server.address() as { port: number }).port;
const code = (app as unknown as { pairingCode: () => string }).pairingCode();
const paired = await fetch(`http://127.0.0.1:${port}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Home check" }) });
const { token } = (await paired.json()) as { token: string };
console.log(JSON.stringify({ port, token, roomId: room.id }));
// Keep the process alive until the parent kills it.
setInterval(() => {}, 1 << 30);
