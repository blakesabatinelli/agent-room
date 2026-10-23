import type { AgentConfig } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { ControlFolder } from "../control/folder.js";
import { appendPersona, personaBlock } from "./block.js";
import { personaOf } from "./persona.js";

/** Adapters whose run reads a native context file in the task's worktree (CLAUDE.md, AGENTS.md); the persona rides in that file. */
const NATIVE_CONTEXT = new Set(["claude-code", "codex"]);

/**
 * 3.2: the persona block for one prompt, or undefined.
 *  - "task": the context file (1.9) carries the persona when there is a control folder and the adapter reads it. Otherwise
 *    (no control folder, or an adapter with no native file such as MCP, command and API agents) it is a marked block in the prompt.
 *  - "chat": direct replies and tag replies run with no context file, so the block is always in the prompt.
 * Only prompts that produce text the owner will read use this. Never judging, planning, retro or memory prompts.
 */
export function personaPromptBlock(store: Store, control: ControlFolder | undefined, agent: AgentConfig, surface: "task" | "chat"): string | undefined {
  if (surface === "task" && control && NATIVE_CONTEXT.has(agent.adapter) && control.snapshot().agents[agent.id]?.soul) return undefined;
  const p = personaOf(store, control, agent);
  return p ? personaBlock(p) : undefined;
}

/** `prompt` with the agent's persona at the end, after the contract and the rules, so "the rules above always win" is true. */
export function withPersona(prompt: string, store: Store, control: ControlFolder | undefined, agent: AgentConfig, surface: "task" | "chat"): string {
  return appendPersona(prompt, personaPromptBlock(store, control, agent, surface));
}
