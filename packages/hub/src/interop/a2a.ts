// 4.6 The Room as an A2A server: the Agent Card, and the minimal JSON-RPC methods behind it.
//
// Sources (read 2026-10-23):
//  - A2A specification, v1.0.0 (latest):   https://a2a-protocol.org/latest/specification/
//  - Normative definition (v1.0.0 tag):    https://raw.githubusercontent.com/a2aproject/A2A/v1.0.0/specification/a2a.proto
//    (vendored in test/fixtures/a2a-v1.0.0.proto, which the tests validate the card against)
//  - Card path: /.well-known/agent-card.json (section 8.2). JSON is camelCase (5.5), enums are ProtoJSON names such as
//    TASK_STATE_COMPLETED (5.5, 6.1), a Part is {"text": ...} with no "kind" field, a SecurityScheme is wrapped under its type key.
//  - JSON-RPC binding (section 9): methods SendMessage, GetTask, CancelTask (plus ListTasks, SendStreamingMessage, SubscribeToTask,
//    push-notification and extended-card methods, which this server answers with the matching A2A error). Errors -32001..-32099.
//
// v1.0 renamed the JSON-RPC methods and changed the JSON shapes. Most deployed clients still speak 0.3 (message/send, tasks/get,
// tasks/cancel; Part has "kind": "text"; states are "completed"; role is "user"), so the same endpoint answers both: the method
// name picks the dialect, and the reply is in the dialect the caller used. The card lists both versions under supportedInterfaces and
// also carries 0.3's top-level url / protocolVersion / preferredTransport so a 0.3 client can find the endpoint.
//
// Not supported, and the card says so: streaming, push notifications, the extended card, replying into a finished task.
import { readFileSync } from "node:fs";
import type { McpTokenInfo } from "@agent-room/shared";
import type { Goal } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { ROOM_COMMANDS } from "../commands/index.js";
import { splitFrontMatter } from "../library/frontmatter.js";
import { stripControl } from "../remote/guard.js";
import { id as newId, now } from "../util.js";

// ---------------------------------------------------------------- errors

export const RPC = {
  parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603,
  taskNotFound: -32001, taskNotCancelable: -32002, pushNotSupported: -32003, unsupportedOperation: -32004,
  contentTypeNotSupported: -32005, extendedCardNotConfigured: -32007, versionNotSupported: -32009,
} as const;

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) { super(message); }
}

// ---------------------------------------------------------------- the card

/** The version in the VERSION file at the repo root ("2026-10-23.1 (notes)" gives "2026-10-23.1"); the bundled hub keeps a copy next to hub.mjs. */
export function readVersion(): string {
  for (const rel of ["../../../../VERSION", "../../VERSION", "../VERSION", "./VERSION"]) {
    try {
      const v = readFileSync(new URL(rel, import.meta.url), "utf8").trim().split(/\s+/)[0];
      if (v) return v;
    } catch { /* try the next place */ }
  }
  return "0.1.0";
}

/** Room commands an outside agent may send as the message text. The others (fork, redirect, replan) stay with the owner. */
export const A2A_COMMANDS = ["pause", "resume", "stop", "digest"] as const;

export function a2aSkills() {
  const commands = ROOM_COMMANDS.filter((c) => (A2A_COMMANDS as readonly string[]).includes(c.name)).map((c) => ({
    id: `command-${c.name}`,
    name: `/${c.name}`,
    description: `${c.description} Send "/${c.name}" as the whole message.`,
    tags: ["room-command", c.name],
    examples: [`/${c.name}`],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
  }));
  return [
    {
      id: "run-goal",
      name: "Run a goal",
      description: "Give the Room a goal in plain language. Its orchestrator writes a plan, assigns the work to the best of the owner's agents, has it reviewed, and "
        + "returns a summary plus the documents the agents saved. Large plans wait for the owner's approval before any work starts.",
      tags: ["goal", "orchestration", "multi-agent", "research", "code"],
      examples: ["Summarize this week's support tickets into a one page brief", "Add input validation to the signup form and open a branch with the change"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain", "text/markdown"],
    },
    ...commands,
  ];
}

export interface CardOptions {
  version: string;
  /** Absolute URL of POST /a2a as the caller should reach it. */
  endpointUrl: string;
}

export function buildAgentCard(o: CardOptions) {
  const iface = (protocolVersion: string) => ({ url: o.endpointUrl, protocolBinding: "JSONRPC", protocolVersion });
  return {
    name: "Agent Room",
    description: "A shared room where one owner's AI agents (Claude Code, Codex, Gemini CLI, Hermes and others) plan, work, review and merge each other's work. "
      + "Send it a goal and it answers with a summary and the documents its agents saved. Every call needs a key the owner made for you.",
    version: o.version,
    // A2A 1.0: the first interface is preferred.
    supportedInterfaces: [iface("1.0"), iface("0.3")],
    // A2A 0.3: how a pre-1.0 client finds the endpoint.
    protocolVersion: "0.3.0",
    url: o.endpointUrl,
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      agentRoomKey: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          description: "A key the owner made in Agent Room for this caller (Agent Room, Remote access, Outside agents). Send it as Authorization: Bearer <key>.",
        },
      },
    },
    securityRequirements: [{ schemes: { agentRoomKey: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "text/markdown"],
    skills: a2aSkills(),
  };
}

// ---------------------------------------------------------------- tasks

export type A2aState = "submitted" | "working" | "completed" | "failed" | "canceled";
const TERMINAL: ReadonlySet<A2aState> = new Set(["completed", "failed", "canceled"]);

export interface NeutralTask {
  id: string;
  contextId: string;
  state: A2aState;
  /** What to tell the caller about the state. */
  text?: string;
  artifacts: { id: string; name: string; description?: string; text: string }[];
  at: number;
}

export type Dialect = "v1" | "v0.3";

const V1_STATE: Record<A2aState, string> = {
  submitted: "TASK_STATE_SUBMITTED", working: "TASK_STATE_WORKING", completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED", canceled: "TASK_STATE_CANCELED",
};

/** A Task as the caller's dialect spells it. */
export function renderTask(t: NeutralTask, d: Dialect) {
  const iso = new Date(t.at).toISOString();
  if (d === "v1") {
    return {
      id: t.id, contextId: t.contextId,
      status: {
        state: V1_STATE[t.state],
        ...(t.text ? { message: { messageId: `${t.id}-status`, contextId: t.contextId, taskId: t.id, role: "ROLE_AGENT", parts: [{ text: t.text }] } } : {}),
        timestamp: iso,
      },
      ...(t.artifacts.length ? { artifacts: t.artifacts.map((a) => ({ artifactId: a.id, name: a.name, ...(a.description ? { description: a.description } : {}), parts: [{ text: a.text, mediaType: "text/markdown" }] })) } : {}),
    };
  }
  return {
    kind: "task", id: t.id, contextId: t.contextId,
    status: {
      state: t.state,
      ...(t.text ? { message: { kind: "message", messageId: `${t.id}-status`, contextId: t.contextId, taskId: t.id, role: "agent", parts: [{ kind: "text", text: t.text }] } } : {}),
      timestamp: iso,
    },
    ...(t.artifacts.length ? { artifacts: t.artifacts.map((a) => ({ artifactId: a.id, name: a.name, ...(a.description ? { description: a.description } : {}), parts: [{ kind: "text", text: a.text }] })) } : {}),
  };
}

/** A reply that is a Message and not a Task (a room command has no goal to follow). */
export function renderMessage(text: string, d: Dialect, contextId?: string) {
  const messageId = newId("msg");
  return d === "v1"
    ? { messageId, ...(contextId ? { contextId } : {}), role: "ROLE_AGENT", parts: [{ text }] }
    : { kind: "message", messageId, ...(contextId ? { contextId } : {}), role: "agent", parts: [{ kind: "text", text }] };
}

/** SendMessage wraps its result as {task} or {message}; 0.3's message/send returns the Task or Message itself. */
export const sendResult = (d: Dialect, kind: "task" | "message", body: object) => (d === "v1" ? { [kind]: body } : body);

/** The text parts of a Message, in both spellings: 1.0 {"text": "..."} and 0.3 {"kind": "text", "text": "..."}. */
export function messageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  const out: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const part = p as { text?: unknown; kind?: unknown };
    if (typeof part.text === "string" && (part.kind === undefined || part.kind === "text")) out.push(part.text);
  }
  const text = out.join("\n").trim();
  return text || undefined;
}

// ---------------------------------------------------------------- the service

/** Which goals came in over A2A, and through which key. A key sees only its own. Kept in the Store so a restart doesn't lose them. */
interface Entry { keyId: string; roomId: string; at: number; canceled?: boolean }
const KV_TASKS = "a2a_tasks";
const MAX_TASKS = 500;
const MAX_TEXT = 20_000;
const MAX_ARTIFACT_CHARS = 50_000;
const ACTIVE: Goal["status"][] = ["planning", "awaiting_approval", "running", "paused"];

export interface A2aOptions {
  /** How long a blocking SendMessage waits for the goal to finish or need the owner before it answers "working". */
  waitMs?: number;
}

export class A2aService {
  private waitMs: number;
  constructor(private store: Store, private orch: Orchestrator, opts: A2aOptions = {}) {
    this.waitMs = opts.waitMs ?? Number(process.env.AGENT_ROOM_A2A_WAIT_MS ?? 25_000);
  }

  private entries(): Record<string, Entry> { return this.store.getKV<Record<string, Entry>>(KV_TASKS, {}); }
  private remember(goalId: string, e: Entry) {
    const all = { ...this.entries(), [goalId]: e };
    const keys = Object.keys(all).sort((a, b) => all[a].at - all[b].at);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TASKS))) delete all[k];
    this.store.setKV(KV_TASKS, all);
  }
  private update(goalId: string, f: (e: Entry) => void) {
    const all = this.entries(); const e = all[goalId]; if (!e) return;
    f(e); this.store.setKV(KV_TASKS, all);
  }

  /** The room a request is for: the key's own room when it has one, else the named room (id, or name with or without #), default "general". */
  private room(rec: McpTokenInfo, asked: unknown) {
    const rooms = this.store.listRooms().filter((r) => !r.dmAgentId);
    if (rec.roomId) {
      const r = this.store.getRoom(rec.roomId);
      if (!r) throw new RpcError(RPC.invalidParams, "The room this key is pinned to no longer exists.");
      return r;
    }
    const want = (typeof asked === "string" && asked.trim() ? asked.trim() : "general").replace(/^#/, "").toLowerCase();
    const r = rooms.find((x) => x.id === want || x.name.toLowerCase() === want) ?? (typeof asked === "string" && asked.trim() ? undefined : rooms[0]);
    if (!r) throw new RpcError(RPC.invalidParams, `There is no room called "${want}".`);
    return r;
  }

  /** The caller's view of one goal. */
  private view(goalId: string, e: Entry): NeutralTask | undefined {
    const g = this.store.getGoal(goalId);
    if (!g) return undefined;
    let state: A2aState, text: string | undefined;
    switch (g.status) {
      case "done": state = "completed"; text = g.summary; break;
      case "failed":
        state = e.canceled || /^(Stopped by|Plan cancelled)/i.test(g.summary ?? "") ? "canceled" : "failed";
        text = g.summary; break;
      case "superseded": state = "canceled"; text = "The owner changed direction and this plan was replaced."; break;
      case "planning": state = "submitted"; text = "The orchestrator is writing a plan."; break;
      case "awaiting_approval": state = "working"; text = "Waiting for the owner to approve the plan. Nothing more is needed from you."; break;
      case "paused": state = "working"; text = "Paused."; break;
      default: state = "working"; text = g.state?.nextAction || "Working on it.";
    }
    const artifacts: NeutralTask["artifacts"] = [];
    if (state === "completed" && g.summary) artifacts.push({ id: `${g.id}-summary`, name: "Summary", text: g.summary.slice(0, MAX_ARTIFACT_CHARS) });
    for (const d of this.orch.library.list({ goalId: g.id })) {
      let body = "";
      try { body = splitFrontMatter(readFileSync(d.path, "utf8")).body.trim(); } catch { continue; }
      if (body) artifacts.push({ id: d.id, name: d.frontMatter.title, description: d.relPath, text: body.slice(0, MAX_ARTIFACT_CHARS) });
    }
    return { id: g.id, contextId: e.roomId, state, text: text?.slice(0, MAX_ARTIFACT_CHARS), artifacts, at: now() };
  }

  /** The Task for an id this key started, or TaskNotFound (the same answer for "never existed" and "someone else's"). */
  private mine(rec: McpTokenInfo, params: unknown): { id: string; e: Entry } {
    const id = params && typeof params === "object" ? (params as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !id) throw new RpcError(RPC.invalidParams, "Send the task id as params.id.");
    const e = this.entries()[id];
    if (!e || e.keyId !== rec.id) throw new RpcError(RPC.taskNotFound, "No such task.");
    return { id, e };
  }

  private who(rec: McpTokenInfo) { return `key=${rec.id} (${stripControl(rec.name).slice(0, 60)})`; }

  /** SendMessage / message/send. */
  async send(rec: McpTokenInfo, params: unknown, d: Dialect): Promise<object> {
    const p = (params && typeof params === "object" ? params : {}) as { message?: Record<string, unknown>; configuration?: { returnImmediately?: boolean; blocking?: boolean }; metadata?: Record<string, unknown> };
    const text = messageText(p.message);
    if (!text) throw new RpcError(RPC.invalidParams, "Send message.parts with at least one text part.");
    if (text.length > MAX_TEXT) throw new RpcError(RPC.invalidParams, `The message is longer than ${MAX_TEXT} characters.`);
    if (p.message?.taskId) throw new RpcError(RPC.unsupportedOperation, "Replying into an existing task isn't supported. Send a new message instead.");
    const msgMeta = p.message?.metadata && typeof p.message.metadata === "object" ? (p.message.metadata as Record<string, unknown>) : undefined;
    const room = this.room(rec, p.metadata?.room ?? msgMeta?.room);

    const cmd = /^\/([a-z]+)\s*$/i.exec(text)?.[1]?.toLowerCase();
    if (cmd && (A2A_COMMANDS as readonly string[]).includes(cmd)) return sendResult(d, "message", renderMessage(this.command(rec, cmd, room.id, room.name), d, room.id));

    if (this.store.listGoals(room.id).some((g) => ACTIVE.includes(g.status)))
      throw new RpcError(RPC.invalidParams, `#${room.name} is busy with another goal. Try another room, or wait for it to finish.`);

    const goalText = text.replace(/^\/goal\s+/i, "");
    // The room sees who asked. The owner's own name is never used for an outside caller.
    this.store.addMessage({ roomId: room.id, author: { kind: "system", id: "system", name: "System" }, type: "system", mentions: [], text: `An outside agent (${stripControl(rec.name).slice(0, 60)}, over A2A) asked: ${goalText}` });
    this.store.audit("a2a", "a2a.goal.started", `${this.who(rec)} room=${room.name} text=${JSON.stringify(stripControl(goalText).slice(0, 120))}`);
    const before = new Set(this.store.listGoals(room.id).map((g) => g.id));
    // runGoal saves the goal before it first waits, so it is in the Store as soon as this returns. The run itself carries on in the background.
    void this.orch.runGoal(room.id, goalText).catch(() => undefined);
    const goal = this.store.listGoals(room.id).find((g) => !before.has(g.id));
    if (!goal) throw new RpcError(RPC.internal, "The goal didn't start.");
    const entry: Entry = { keyId: rec.id, roomId: room.id, at: now() };
    this.remember(goal.id, entry);
    this.orch.attention.notify("info", { title: "An outside agent started a goal", body: `${stripControl(rec.name).slice(0, 60)} over A2A: ${goalText}`, roomId: room.id, goalId: goal.id, key: `a2a:${goal.id}` });

    const immediate = d === "v1" ? p.configuration?.returnImmediately === true : p.configuration?.blocking === false;
    if (!immediate) await this.settle(goal.id);
    return sendResult(d, "task", renderTask(this.view(goal.id, entry)!, d));
  }

  /** Wait until the goal is finished, or needs the owner (a plan to approve), or the wait runs out. */
  private async settle(goalId: string) {
    const end = Date.now() + this.waitMs;
    for (;;) {
      const s = this.store.getGoal(goalId)?.status;
      if (!s || s === "done" || s === "failed" || s === "superseded" || s === "awaiting_approval") return;
      if (Date.now() >= end) return;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  private command(rec: McpTokenInfo, cmd: string, roomId: string, roomName: string): string {
    this.store.audit("a2a", "a2a.command", `${this.who(rec)} /${cmd} in ${roomName}`);
    switch (cmd) {
      case "pause": this.orch.setPaused(roomId, true); return `Paused #${roomName}. Running tasks finish; nothing new starts.`;
      case "resume": this.orch.setPaused(roomId, false); return `Resumed #${roomName}.`;
      case "stop": this.orch.stopRoom(roomId); return `Stopped all work in #${roomName}.`;
      default: this.orch.attention.digestNow(roomId); return `Posted the digest in #${roomName}. The owner reads it there.`;
    }
  }

  /** GetTask / tasks/get. */
  get(rec: McpTokenInfo, params: unknown, d: Dialect): object {
    const { id, e } = this.mine(rec, params);
    const t = this.view(id, e);
    if (!t) throw new RpcError(RPC.taskNotFound, "No such task.");
    return renderTask(t, d);
  }

  /** CancelTask / tasks/cancel. */
  cancel(rec: McpTokenInfo, params: unknown, d: Dialect): object {
    const { id, e } = this.mine(rec, params);
    const t = this.view(id, e);
    if (!t) throw new RpcError(RPC.taskNotFound, "No such task.");
    if (TERMINAL.has(t.state)) throw new RpcError(RPC.taskNotCancelable, `The task is already ${t.state}.`);
    this.update(id, (x) => { x.canceled = true; });
    this.orch.stopGoal(id, "Stopped by an outside request over A2A.");
    this.store.audit("a2a", "a2a.task.canceled", `${this.who(rec)} goal=${id}`);
    return renderTask(this.view(id, { ...e, canceled: true })!, d);
  }

  /** One JSON-RPC call by a key that already passed authentication. Returns the `result` or throws an RpcError. */
  async call(rec: McpTokenInfo, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "SendMessage": return this.send(rec, params, "v1");
      case "GetTask": return this.get(rec, params, "v1");
      case "CancelTask": return this.cancel(rec, params, "v1");
      case "message/send": return this.send(rec, params, "v0.3");
      case "tasks/get": return this.get(rec, params, "v0.3");
      case "tasks/cancel": return this.cancel(rec, params, "v0.3");
      case "SendStreamingMessage": case "SubscribeToTask": case "ListTasks": case "message/stream": case "tasks/resubscribe":
        throw new RpcError(RPC.unsupportedOperation, "Streaming and task listing aren't supported. Use SendMessage, GetTask and CancelTask.");
      case "CreateTaskPushNotificationConfig": case "GetTaskPushNotificationConfig": case "ListTaskPushNotificationConfigs": case "DeleteTaskPushNotificationConfig":
      case "tasks/pushNotificationConfig/set": case "tasks/pushNotificationConfig/get": case "tasks/pushNotificationConfig/list": case "tasks/pushNotificationConfig/delete":
        throw new RpcError(RPC.pushNotSupported, "Push notifications aren't supported. Poll GetTask.");
      case "GetExtendedAgentCard": case "agent/getAuthenticatedExtendedCard":
        throw new RpcError(RPC.extendedCardNotConfigured, "There is no extended agent card.");
      default: throw new RpcError(RPC.methodNotFound, "Method not found.");
    }
  }
}
