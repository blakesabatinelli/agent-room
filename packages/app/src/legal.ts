// 4.7 Where the app sends people for the licence terms, the privacy notice and each provider's own terms.
//
// LICENCE: the owner has not chosen yet (docs/legal/licence-options.md). Until the final texts are published at an address, leave the two
// urls undefined: the About section then says "draft, awaiting legal review" and links nothing, instead of pointing at an unreviewed page.
// When the owner publishes the final EULA and privacy notice, set the two urls below, set `final` to true, and the About section links them.
export const LEGAL: { final: boolean; eulaUrl?: string; privacyUrl?: string; docsUrl?: string } = {
  final: false,
  eulaUrl: undefined,
  privacyUrl: undefined,
  docsUrl: undefined,
};

/**
 * D5, the terms position, as the onboarding states it. Each agent's own CLI signs itself in; the Room never sees or stores credentials.
 * Links were read on 2026-10-23 (see docs/user/agents.md for what each page says). They are the providers' pages, not ours.
 */
export const PROVIDER_TERMS = {
  anthropic: {
    name: "Anthropic (Claude Code)",
    links: [
      { label: "Claude Code: legal and compliance", url: "https://code.claude.com/docs/en/legal-and-compliance" },
      { label: "Consumer Terms (Free, Pro, Max)", url: "https://www.anthropic.com/legal/consumer-terms" },
      { label: "Commercial Terms (Team, Enterprise, API)", url: "https://www.anthropic.com/legal/commercial-terms" },
      { label: "Usage Policy", url: "https://www.anthropic.com/legal/aup" },
      { label: "Claude Code authentication", url: "https://code.claude.com/docs/en/authentication" },
    ],
  },
  openai: {
    name: "OpenAI (Codex)",
    links: [
      { label: "OpenAI terms and policies", url: "https://openai.com/policies" },
      { label: "Codex: sign in with ChatGPT or an API key", url: "https://learn.chatgpt.com/docs/auth" },
      { label: "OpenAI API keys", url: "https://platform.openai.com/api-keys" },
    ],
  },
} as const;
