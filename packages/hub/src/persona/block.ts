import { PERSONA_BEGIN, PERSONA_END } from "../control/context.js";
import { stripPersona } from "../jury/neutralize.js";

/**
 * 3.2: the persona as it goes into a prompt. Everything sits between the persona markers (so 2.2 can strip it before
 * judging), and the block says it is voice only: it can change how the agent writes, never what the task, its scope or
 * the rules say.
 */

export { PERSONA_BEGIN, PERSONA_END };
/** The precedence line, word for word. The prompt's block puts it after the task, so "above" is true there. */
export const VOICE_ONLY = "Voice only. The task, scope and rules above always win.";
/** The body of a persona is cut to this many characters in a prompt (the file may be longer). */
export const PERSONA_PROMPT_CAP = 1500;

export interface PersonaText { name: string; role: string; tone: string; body?: string }

/** Marker-looking text inside a persona would end the block early and let the rest through to a judge. */
const MARKER = /<!--\s*agent-room:[^>]*-->/gi;
export const hasMarker = (s: string) => /<!--\s*agent-room:/i.test(s);
const clean = (s: string) => s.replace(MARKER, "").replace(/\r\n?/g, "\n");

/** Cut at a line end when there is one near the cap, so a sentence isn't left hanging. */
function capped(body: string, cap: number): string {
  if (body.length <= cap) return body;
  const cut = body.slice(0, cap);
  const nl = cut.lastIndexOf("\n");
  return `${(nl > cap * 0.6 ? cut.slice(0, nl) : cut).trimEnd()}\n(The rest of this persona was cut to keep the prompt short.)`;
}

/** The block for a prompt. */
export function personaBlock(p: PersonaText, cap = PERSONA_PROMPT_CAP): string {
  const body = capped(clean(p.body ?? "").trim(), cap);
  return [
    PERSONA_BEGIN,
    `Your voice (${clean(p.name).replace(/\s+/g, " ").trim()}). ${VOICE_ONLY}`,
    "Never bend a fact, a number, a check, a file or a limit to suit the voice, and keep any STATUS block exactly as asked.",
    `Role: ${clean(p.role).replace(/\s+/g, " ").trim()}. Tone: ${clean(p.tone).replace(/\s+/g, " ").trim()}.`,
    ...(body ? ["", body] : []),
    PERSONA_END,
  ].join("\n");
}

/** Append a persona block to a prompt. With no block the prompt is returned untouched. */
export const appendPersona = (prompt: string, block: string | undefined): string => (block ? `${prompt.replace(/\s+$/, "")}\n\n${block}\n` : prompt);

/**
 * Remove every persona block, and stray markers, from text that must never carry persona: what judges read, and the
 * résumé. (2.2's `stripPersona`, named for what 3.2 uses it for.)
 */
export const scrubPersona = stripPersona;
/** True when the text still carries a persona marker or the precedence line. */
export const carriesPersona = (text: string): boolean => text.includes(PERSONA_BEGIN) || text.includes(PERSONA_END) || text.includes(VOICE_ONLY);
