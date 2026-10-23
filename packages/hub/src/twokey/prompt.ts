import type { TwoKeyKind } from "@agent-room/shared";

/**
 * 4.1 What the second agent is told. It is given the work (objective, task, what done means, the conversation, and any inputs the caller
 * names) and asked to draft the action on its own. It is NEVER given the first agent's draft, nor the words the first agent used to ask:
 * only the kind of action and the connector's id go in. The prompt starts with [[TWOKEY]] so the mock adapter and the logs can tell it apart.
 */
export interface Brief {
  kind: TwoKeyKind;
  /** The connector or tool id (gmail, salesforce, shell...). Never the agent's own description of what it wants. */
  tool: string;
  objective?: string;
  requirements: string[];
  constraints: string[];
  task?: { title: string; description: string; criteria: string[]; parent?: string };
  /** Relevant inputs the caller names (a folder listing for deletes...). Never the first draft. */
  inputs?: string;
  conversation: string[];
}

const WHAT: Record<TwoKeyKind, string> = {
  email: "send an email",
  crm: "write to a CRM (create, update, upsert or delete a record)",
  delete: "delete something (files, records, messages)",
};
const SHAPE: Record<TwoKeyKind, string> = {
  email: `{"to": ["address"], "cc": ["address"], "subject": "text", "body": "text"}`,
  crm: `{"object": "Opportunity", "op": "create|update|upsert|delete", "id": "record id, when the record exists", "fields": {"FieldName": "value"}}`,
  delete: `{"targets": ["path or id of each thing to delete"]}`,
};

const section = (title: string, lines: string[]) => (lines.length ? `\n## ${title}\n${lines.join("\n")}\n` : "");

export function twoKeyPrompt(b: Brief): string {
  return `[[TWOKEY]]
You are the second of two independent keys for a sensitive action. Another agent from a different vendor has been asked to do the same thing; you have not seen its work and must not guess it. Each of you drafts the action alone, and it runs only if the two drafts match. Be exact: recipients, record ids, field values, dates, amounts and names must come from the material below, never from a guess.

The action: ${WHAT[b.kind]} (tool: ${b.tool}).
${section("Objective", b.objective ? [b.objective] : [])}${section("What done means", b.requirements.map((r) => `- ${r}`))}${section("Constraints", b.constraints.map((r) => `- ${r}`))}${b.task ? section("The task", [`${b.task.title}${b.task.parent ? ` (a helper for: ${b.task.parent})` : ""}`, b.task.description, ...b.task.criteria.map((c) => `- ${c}`)]) : ""}${section("Inputs", b.inputs ? [b.inputs] : [])}${section("The conversation, oldest first", b.conversation)}
Reply with ONE JSON object and nothing else, in this shape:
${SHAPE[b.kind]}
If the material does not call for this action, or you cannot draft it without guessing, reply {"action": "none", "reason": "one short sentence"} instead. Do not use tools. Do not ask questions.`;
}
