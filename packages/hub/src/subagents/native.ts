/**
 * 3.3 Native subagents: the ones an agent launches inside its own tool. The hub only watches the agent's event stream; it does not
 * route, judge or budget them.
 *
 * Claude Code (`claude -p --output-format stream-json --verbose`), per
 * https://code.claude.com/docs/en/agent-sdk/subagents ("Detect subagent invocation", read Oct 23, 2026) and
 * https://code.claude.com/docs/en/sub-agents:
 *  - a subagent launch is an assistant message with a `tool_use` content block whose `name` is "Agent" (Claude Code 2.1.63 and later) or "Task"
 *    (older, and still the name in the `system:init` tools list); `input.subagent_type` names the agent; `input.description` and `input.prompt`
 *    are the short title and the delegation prompt (the docs show `subagent_type`; the other two are read when present);
 *  - the matching `tool_result` content block (in a user message, `tool_use_id` = the tool_use `id`, `is_error` when it failed) ends it. A subagent
 *    that runs in the background answers at once with `status: "async_launched"`, and its report comes in a later turn: that result does NOT end it;
 *  - messages produced inside a subagent carry `parent_tool_use_id` (the launching tool_use id). They are not launches and are ignored here.
 *
 * Codex (`codex exec --json`): thread items of type `collab_tool_call` (codex-rs exec_events.rs) with `tool` "spawn_agent" | "send_input" | "wait" |
 * "close_agent", `receiver_thread_ids`, `prompt`, `agents_states` ({ threadId: { status } }) and `status`. NOT checked against a live Codex in this
 * repo (no Codex in the build environment): the parser reads these names when present, ignores anything else, and never throws.
 */

export interface NativeEvent {
  phase: "start" | "end";
  /** The tool_use id (Claude Code) or thread id (Codex). */
  id: string;
  description?: string;
  subagentType?: string;
  prompt?: string;
  ok?: boolean;
  /** The subagent's report, when the stream carries it (capped). */
  result?: string;
}

const str = (v: unknown, max = 4000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Text of a tool_result `content`: a string, or an array of { type: "text", text } blocks. */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return str(content);
  const parts = list(content).map((c) => str(rec(c)?.text, 4000)).filter(Boolean);
  return parts.length ? str(parts.join("\n")) : undefined;
}

/**
 * Follows one agent run's event stream and reports subagents starting and ending. One tracker per run. `finish()` ends whatever is still open
 * (a background subagent, or a stream that ended early) so nothing stays "running" after its parent's run is over.
 */
export class NativeTracker {
  private open = new Map<string, NativeEvent>();
  private seen = new Set<string>();
  constructor(private emit: (e: NativeEvent) => void) {}

  private start(e: NativeEvent) {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id); this.open.set(e.id, e); this.emit({ ...e, phase: "start" });
  }
  private end(id: string, o: { ok?: boolean; result?: string } = {}) {
    const was = this.open.get(id); if (!was) return;
    this.open.delete(id); this.emit({ ...was, phase: "end", ok: o.ok ?? true, ...(o.result ? { result: o.result } : {}) });
  }

  /** One parsed stream-json line from Claude Code. */
  claude(ev: unknown): void {
    try {
      const e = rec(ev); if (!e) return;
      if (e.parent_tool_use_id) return; // inside a subagent: its own tool calls are not launches
      const content = list(rec(e.message)?.content);
      if (e.type === "assistant") {
        for (const c of content) {
          const b = rec(c);
          if (b?.type !== "tool_use" || (b.name !== "Agent" && b.name !== "Task") || typeof b.id !== "string") continue;
          const input = rec(b.input) ?? {};
          this.start({ phase: "start", id: b.id, description: str(input.description, 200), subagentType: str(input.subagent_type, 80), prompt: str(input.prompt) });
        }
      } else if (e.type === "user") {
        for (const c of content) {
          const b = rec(c);
          if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string" || !this.open.has(b.tool_use_id)) continue;
          const text = resultText(b.content);
          const tr = rec(e.tool_use_result);
          if (tr?.status === "async_launched" || (text && /"?status"?\s*:\s*"?async_launched/.test(text))) continue; // launched in the background: the report comes later
          this.end(b.tool_use_id, { ok: b.is_error !== true, result: text });
        }
      }
    } catch { /* a line we don't understand is not an error */ }
  }

  /** One parsed `--json` event from Codex. */
  codex(ev: unknown): void {
    try {
      const e = rec(ev); const item = rec(e?.item) ?? rec(rec(e?.msg)?.item);
      if (!item) return;
      const type = String(item.type ?? ""), tool = String(item.tool ?? "");
      if (!/collab|subagent/i.test(type) && tool !== "spawn_agent") return;
      const receivers = list(item.receiver_thread_ids).filter((x): x is string => typeof x === "string");
      const failed = String(item.status ?? "") === "failed";
      if (tool === "spawn_agent" || /subagent/i.test(type)) {
        // The first event (in progress) has no thread yet: wait for the one that names it.
        const id = receivers[0] ?? (String(item.status ?? "") === "in_progress" ? undefined : str(item.id, 100));
        if (id) this.start({ phase: "start", id, description: str(str(item.prompt)?.split("\n")[0], 200), subagentType: "codex", prompt: str(item.prompt) });
        if (id && failed) this.end(id, { ok: false });
      }
      if (tool === "close_agent") for (const r of receivers) this.end(r);
      for (const [thread, st] of Object.entries(rec(item.agents_states) ?? {})) {
        const status = String(rec(st)?.status ?? st ?? "").toLowerCase();
        if (/^(completed|done|shutdown|closed)$/.test(status)) this.end(thread, { ok: true, result: str(rec(st)?.message) });
        else if (/^(errored|error|failed|not_found)$/.test(status)) this.end(thread, { ok: false, result: str(rec(st)?.message) });
      }
    } catch { /* ignore */ }
  }

  /** The run is over: close anything still open. */
  finish(ok = true) { for (const id of [...this.open.keys()]) this.end(id, { ok }); }
}
