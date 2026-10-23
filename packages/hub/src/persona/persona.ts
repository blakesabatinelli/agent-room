import type { AgentConfig, Persona, PersonaInput, PersonaView } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { ControlFolder } from "../control/folder.js";
import { checkFile } from "../control/lint.js";
import { emitFile } from "../control/parse.js";
import { SCHEMA_VERSION, todayString } from "../control/schema.js";
import { hasMarker } from "./block.js";
import { matchTemplate, templateById } from "./templates/index.js";

/**
 * 3.2: reading and writing an agent's persona. With a control folder the persona IS `agents/<id>/SOUL.md` (the file
 * wins, written as the owner and committed like any owner edit). Without one it lives in the agent's record. Name and
 * colour always end up on the agent record too, which is what the apps show everywhere.
 */

/** What 1.9 writes for an agent nobody has described yet. A persona like this adds nothing to a prompt. */
export const STARTER_TONE = "Plain, direct and brief";
const STARTER_BODY = "Describe this agent's voice here.";
export const isStarterPersona = (p: Pick<Persona, "tone" | "body">) => p.tone === STARTER_TONE && p.body.includes(STARTER_BODY);

const soulRel = (agentId: string) => `agents/${agentId}/SOUL.md`;
type Stored = { role?: string; tone?: string; body?: string };

/** The persona a prompt should carry, or undefined when the agent has none worth saying (or only the starter text). */
export function personaOf(store: Store, control: ControlFolder | undefined, agent: AgentConfig): Persona | undefined {
  const soul = control?.snapshot().agents[agent.id]?.soul;
  if (soul) {
    const p = { name: soul.fm.name, color: soul.fm.color, avatar: soul.fm.avatar, role: soul.fm.role, tone: soul.fm.tone, body: soul.body.trim() };
    return isStarterPersona(p) ? undefined : p;
  }
  const rec = agent.settings?.persona as Stored | undefined;
  if (rec && (rec.role || rec.tone || rec.body)) return { name: agent.name, color: agent.color, avatar: agent.avatar, role: rec.role ?? "", tone: rec.tone ?? "", body: (rec.body ?? "").trim() };
  return undefined;
}

/** GET /agents/:id/persona. Undefined when there is no such agent. */
export function readPersona(store: Store, control: ControlFolder | undefined, agentId: string): PersonaView | undefined {
  const agent = store.getAgent(agentId);
  if (!agent) return undefined;
  const soul = control?.snapshot().agents[agentId]?.soul;
  let p: Persona; let source: PersonaView["source"] = "agent"; let updated: string | undefined;
  if (soul) {
    p = { name: soul.fm.name, color: soul.fm.color, ...(soul.fm.avatar ? { avatar: soul.fm.avatar } : {}), role: soul.fm.role, tone: soul.fm.tone, body: soul.body };
    source = "control"; updated = soul.fm.updated;
  } else {
    const rec = (agent.settings?.persona ?? {}) as Stored;
    p = {
      name: agent.name, color: agent.color, ...(agent.avatar ? { avatar: agent.avatar } : {}),
      role: rec.role ?? (agent.canBeOrchestrator ? "Plans, routes and does the work" : "Does the work it is given"), tone: rec.tone ?? STARTER_TONE, body: rec.body ?? "",
    };
  }
  return { agentId, source, template: matchTemplate(p), ...(updated ? { updated } : {}), ...p };
}

/** The SOUL.md text for a persona (front matter in the control spec's dialect, then the body). */
export function soulText(p: Persona, today = todayString()): string {
  return emitFile({
    kind: "soul", schema: SCHEMA_VERSION, updated: today, updated_by: "owner",
    name: p.name, color: p.color, ...(p.avatar ? { avatar: p.avatar } : {}), role: p.role, tone: p.tone,
  }, p.body.trim() ? `${p.body.replace(/\s+$/, "")}\n` : "");
}

export type WriteResult = { ok: true; persona: PersonaView; changed: boolean } | { ok: false; error: string; line?: number };

const oneLine = (label: string, s: string) => (/[\r\n]/.test(s) ? `${label} has to fit on one line.` : undefined);

/**
 * PUT /agents/:id/persona. The new persona is checked the way the linter checks SOUL.md (so the message is the linter's),
 * then written: to the file as the owner, or to the agent's record. Nothing is saved when it is invalid.
 */
export async function writePersona(store: Store, control: ControlFolder | undefined, agentId: string, input: PersonaInput): Promise<WriteResult> {
  const cur = readPersona(store, control, agentId);
  const agent = store.getAgent(agentId);
  if (!cur || !agent) return { ok: false, error: "Agent not found." };
  const tpl = input.template !== undefined ? templateById(input.template) : undefined;
  if (input.template !== undefined && !tpl) return { ok: false, error: `There is no starter persona called "${input.template}".` };
  const next: Persona = {
    name: input.name ?? cur.name, color: input.color ?? cur.color, avatar: (input.avatar ?? cur.avatar ?? "").trim() || undefined,
    role: input.role ?? tpl?.role ?? cur.role, tone: input.tone ?? tpl?.tone ?? cur.tone, body: input.body ?? tpl?.body ?? cur.body,
  };
  const bad = oneLine("The name", next.name) ?? oneLine("The role", next.role) ?? oneLine("The tone", next.tone) ?? oneLine("The avatar", next.avatar ?? "");
  if (bad) return { ok: false, error: bad };
  if ([next.name, next.role, next.tone, next.avatar ?? "", next.body].some(hasMarker)) return { ok: false, error: "A persona can't contain Agent Room marker lines (<!-- agent-room: ... -->)." };

  const rel = soulRel(agentId);
  const text = soulText(next);
  const checked = checkFile(rel, { kind: "soul", agent: agentId }, text);
  if (checked.blocks.length) return { ok: false, error: checked.blocks[0].message, line: checked.blocks[0].line };

  const was = JSON.stringify([cur.name, cur.color, cur.avatar ?? "", cur.role, cur.tone, cur.body.trim()]);
  const now = JSON.stringify([next.name, next.color, next.avatar ?? "", next.role, next.tone, next.body.trim()]);
  let changed = was !== now;
  if (control) {
    // `updated` is a date: an unchanged persona isn't committed again just because the day changed. A file that is broken
    // on disk (the hub is showing the last good copy) is always rewritten, so saving repairs it.
    const strip = (s: string) => s.replace(/^updated(_by)?:.*$/gm, "");
    const wrote = await control.update((read) => {
      const existing = read(rel);
      return existing !== undefined && strip(existing) === strip(text) ? { files: [] } : { files: [{ rel, text }] };
    }, `Change ${next.name}'s persona (from the app)`, "owner");
    changed = wrote.length > 0;
  } else if (changed) {
    const record: Stored = { role: next.role, tone: next.tone, body: next.body };
    const { avatar: _drop, ...rest } = agent;
    store.saveAgent({ ...rest, name: next.name, color: next.color, ...(next.avatar ? { avatar: next.avatar } : {}), settings: { ...agent.settings, persona: record } });
  }
  if (changed) store.audit("owner", "persona.updated", `${agentId}: ${[
    cur.name !== next.name && "name", cur.color.toLowerCase() !== next.color.toLowerCase() && "colour", (cur.avatar ?? "") !== (next.avatar ?? "") && "avatar",
    cur.role !== next.role && "role", cur.tone !== next.tone && "tone", cur.body.trim() !== next.body.trim() && "bio",
  ].filter(Boolean).join(", ") || "saved"}${tpl ? ` (from the ${tpl.id} template)` : ""}`);
  const view = readPersona(store, control, agentId);
  return view ? { ok: true, persona: view, changed } : { ok: false, error: "Agent not found." };
}
