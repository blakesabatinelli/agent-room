/** 3.2 Personas: see PLAN.md item 3.2, PRODUCT.md 6.7 and CONTROL.md (SOUL.md). */
export { PERSONA_TEMPLATES, templateById, matchTemplate } from "./templates/index.js";
export { personaBlock, appendPersona, scrubPersona, carriesPersona, hasMarker, VOICE_ONLY, PERSONA_BEGIN, PERSONA_END, PERSONA_PROMPT_CAP } from "./block.js";
export { readPersona, writePersona, personaOf, soulText, isStarterPersona, STARTER_TONE, type WriteResult } from "./persona.js";
export { personaPromptBlock, withPersona } from "./prompt.js";
