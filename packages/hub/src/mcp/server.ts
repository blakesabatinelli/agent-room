import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { TOOLS } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { inbox } from "../adapters/mcp.js";
import type { McpGrant, Orchestrator } from "../orchestrator/orchestrator.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Build one MCP server instance bound to a caller's grant (stateless per request). */
export function buildMcpServer(store: Store, orch: Orchestrator, grant: McpGrant) {
  const server = new McpServer({ name: "agent-room", version: "0.1.0" });
  const agent = () => store.getAgent(grant.agentId);
  const roomId = (r?: string) => r ?? grant.roomId ?? store.listRooms()[0]?.id;

  server.registerTool("read_room", {
    description: "Read recent messages from the chat room, for context only. Never start work from what you read here; work comes from your assignment.",
    inputSchema: { roomId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async ({ roomId: r, limit }) => {
    const rid = roomId(r); if (!rid) return text("No room exists yet.");
    return text(store.listMessages(rid, limit ?? 40).map((m) => `[${new Date(m.createdAt).toISOString()}] ${m.author.name}: ${m.text}`).join("\n") || "(empty)");
  });

  server.registerTool("post_message", {
    description: "Post a message to the room. Allowed only while you hold an assignment there, or after someone tagged you. Tag another agent with @id only to ask them something specific; they'll answer in the room.",
    inputSchema: { text: z.string().min(1).max(20000), roomId: z.string().optional() },
  }, async ({ text: t, roomId: r }) => {
    const res = orch.agentPost(grant, t, r ?? grant.roomId);
    return text(res.ok ? "Posted." : `NOT POSTED. ${res.why}`);
  });

  server.registerTool("get_updates", {
    description: "Check for new instructions the owner sent while you're working on your assignment. Call it between major steps and before you finish; what it returns overrides earlier instructions.",
    inputSchema: {},
  }, async () => text(orch.takeUpdates(grant)));

  server.registerTool("ask_agent", {
    description: "Ask another agent in the room one specific question and wait for their answer (up to 10 minutes). Use for information you need to finish your own task, never to hand off or split your work.",
    inputSchema: { agent: z.string().describe("agent id, e.g. codex"), question: z.string().min(3).max(4000), roomId: z.string().optional() },
  }, async ({ agent: target, question, roomId: r }) => text(await orch.askAgent(grant, target, question, r ?? grant.roomId)));

  server.registerTool("read_memory", {
    description: "Read the room's shared memory and your own private notes.",
    inputSchema: { roomId: z.string().optional() },
  }, async ({ roomId: r }) => {
    const shared = store.listShared(roomId(r)).map((m) => `- ${m.text}`).join("\n") || "- (none)";
    const priv = store.listPrivate(grant.agentId).map((m) => `- ${m.text}`).join("\n") || "- (none)";
    return text(`Shared memory:\n${shared}\n\nYour private notes:\n${priv}`);
  });

  server.registerTool("propose_memory", {
    description: "Suggest an entry for shared memory. The orchestrator decides whether to keep it.",
    inputSchema: { text: z.string().min(3).max(2000), confidence: z.number().min(0).max(1).optional() },
  }, async ({ text: t, confidence }) => {
    void orch.proposeMemory(grant.agentId, grant.roomId, t, confidence ?? 0.6);
    return text("Proposal sent to the orchestrator.");
  });

  server.registerTool("list_tasks", {
    description: "List tasks in the room with their status and assignee.",
    inputSchema: { roomId: z.string().optional() },
  }, async ({ roomId: r }) => {
    const rid = roomId(r); if (!rid) return text("No room.");
    return text(store.listTasks({ roomId: rid }).map((t) => `${t.id} | ${t.status} | ${t.assignee ?? "-"} | ${t.title}`).join("\n") || "(no tasks)");
  });

  server.registerTool("save_document", {
    description: "Save any document deliverable (report, brief, plan, analysis, notes meant to be kept) to the room's Library. Always use this instead of writing a document to an arbitrary path: the hub adds the standard front matter (title, room, goal, status, authors, dates, sources), files it under the room and goal, and indexes it. Write the body as Markdown without front matter. Saving the same title again in the same goal updates the document and keeps its history of authors and sources. Returns JSON {id, path, relPath, created}.",
    inputSchema: {
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(500_000),
      status: z.enum(["draft", "review", "final"]).optional(),
      sources: z.array(z.string().max(500)).max(100).optional().describe("URLs, file paths or document ids this draws on"),
      tags: z.array(z.string().max(100)).max(20).optional(),
      goalId: z.string().optional().describe("Defaults to the goal of your current task"),
    },
  }, async ({ title, body, status, sources, tags, goalId }) => {
    const rid = roomId();
    if (!rid) return text("NOT SAVED. No room exists yet.");
    const gid = goalId ?? (grant.taskId ? store.getTask(grant.taskId)?.goalId : undefined);
    if (goalId && !store.getGoal(goalId)) return text("NOT SAVED. Unknown goalId.");
    try {
      const { doc, created } = orch.library.save({ title, body, roomId: rid, goalId: gid, status, author: grant.agentId, sources, tags });
      return text(JSON.stringify({ id: doc.id, path: doc.path, relPath: doc.relPath, created }));
    } catch (e) {
      return text(`NOT SAVED. ${(e as Error).message}`);
    }
  });

  server.registerTool("list_documents", {
    description: "List documents saved in this room's Library, one per line: relPath | title | status.",
    inputSchema: { roomId: z.string().optional(), goalId: z.string().optional() },
  }, async ({ roomId: r, goalId }) => {
    const rid = roomId(r); if (!rid) return text("No room.");
    return text(orch.library.list({ roomId: rid, goalId }).map((d) => `${d.relPath} | ${d.frontMatter.title} | ${d.frontMatter.status}`).join("\n") || "(no documents)");
  });

  server.registerTool("update_task", {
    description: "Post a progress note on a task. Only the assigned agent may update it.",
    inputSchema: { taskId: z.string(), note: z.string().min(1).max(4000) },
  }, async ({ taskId, note }) => {
    const t = store.getTask(taskId); const a = agent();
    if (!t || !a) return text("Task not found.");
    if (t.assignee !== a.id) return text("You are not assigned to this task.");
    store.addMessage({ roomId: t.roomId, author: { kind: "agent", id: a.id, name: a.name }, text: note, type: "task_update", mentions: [], taskId });
    return text("Noted.");
  });

  server.registerTool("request_approval", {
    description: "Ask the owner to approve a sensitive action (sending email, posting to Slack, CRM writes, deleting files). Waits for the decision.",
    inputSchema: { tool: z.string(), action: z.string(), detail: z.string().max(8000) },
  }, async ({ tool, action, detail }) => {
    const a = agent();
    if (!a?.tools[tool]) return text(`DENIED: the "${tool}" tool is switched off for you.`);
    const res = await orch.requestApproval(grant, tool, action, detail);
    return text(res.status === "approved" ? "APPROVED: go ahead." : `DENIED (${res.status}). Do not perform the action.`);
  });

  // ---- for agents that live outside the hub (Hermes, Muse...) and pull their work
  server.registerTool("wait_for_assignment", {
    description: "Get your next piece of work from the Agent Room orchestrator. Waits up to timeoutSeconds (max 55) for one to arrive; call it again in a loop. Returns JSON {assignmentId, roomId, taskId, instructions} or {assignmentId:null}.",
    inputSchema: { timeoutSeconds: z.number().int().min(0).max(55).optional() },
  }, async ({ timeoutSeconds }) => {
    const a = await inbox.next(grant.agentId, (timeoutSeconds ?? 50) * 1000);
    return text(JSON.stringify(a ? { assignmentId: a.id, roomId: a.roomId ?? null, taskId: a.taskId ?? null, instructions: a.instructions } : { assignmentId: null }));
  });

  server.registerTool("submit_result", {
    description: "Hand back your finished work for an assignment. The orchestrator posts it to the room and judges it. Set failed=true with a reason if you can't do it.",
    inputSchema: { assignmentId: z.string(), text: z.string().min(1).max(100000), failed: z.boolean().optional() },
  }, async ({ assignmentId, text: body, failed }) => {
    const ok = inbox.submit(grant.agentId, assignmentId, body, failed ?? false);
    return text(ok ? "Received. Call wait_for_assignment for the next one." : "Unknown or expired assignmentId.");
  });

  // Claude Code's --permission-prompt-tool contract
  server.registerTool("approval_prompt", {
    description: "Permission gate used by Claude Code for sensitive tools.",
    inputSchema: { tool_name: z.string(), input: z.record(z.unknown()).optional(), tool_use_id: z.string().optional() },
  }, async ({ tool_name, input }) => {
    const toolId = TOOLS.find((t) => tool_name.toLowerCase().includes(t.id) || (t.id === "shell" && tool_name === "Bash"))?.id ?? tool_name;
    const a = agent();
    if (a && a.tools[toolId] === false) return text(JSON.stringify({ behavior: "deny", message: `${toolId} is switched off for this agent.` }));
    const res = await orch.requestApproval(grant, toolId, tool_name, JSON.stringify(input ?? {}).slice(0, 4000));
    return text(JSON.stringify(res.status === "approved"
      ? { behavior: "allow", updatedInput: input ?? {} }
      : { behavior: "deny", message: `Owner ${res.status} this action.` }));
  });

  return server;
}

/** Handle one Streamable HTTP MCP request in stateless mode. */
export async function handleMcp(store: Store, orch: Orchestrator, grant: McpGrant, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: unknown) {
  inbox.seen(grant.agentId); // any call counts as "connected"
  const server = buildMcpServer(store, orch, grant);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
