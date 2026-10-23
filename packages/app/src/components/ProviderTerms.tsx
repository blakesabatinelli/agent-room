import React from "react";
import { Linking, Text, View } from "react-native";
import { PROVIDER_TERMS } from "../legal";
import { Button } from "./ui";
import { space, type as t, usePalette } from "../theme";

/**
 * 4.7 / D5: how sign-in and provider terms work, in onboarding. Copy only: it changes no sign-in flow.
 * The position: each agent's own CLI signs itself in with the user's own plan or API key, and the Room never sees or stores credentials.
 */
export function ProviderTerms() {
  const p = usePalette();
  const para = (text: string, strong = false) => <Text style={[t.small, { color: strong ? p.ink : p.muted }, strong ? { fontWeight: "700" } : null]}>{text}</Text>;
  return (
    <View style={{ padding: space(4), gap: space(3) }}>
      {para("Each agent signs itself in.", true)}
      {para("Claude Code and Codex sign in through their own programs, with your own Claude or ChatGPT plan or your own API key. Agent Room never sees, stores or sends your password, token or key. The sign-in buttons above only start the agent's own sign-in and show you its link or code.")}
      {para("Using an API key instead.", true)}
      {para("A provider may prefer API keys for software like this, and a key is always allowed. Claude Code: sign in with a Claude Console account (Claude Code keeps the key itself), or set ANTHROPIC_API_KEY where the hub starts. Codex: choose the API key option when Codex asks how to sign in. Work is then billed to you by that provider, at API rates, and not against your plan.")}
      {para("The provider's terms apply to you.", true)}
      {para("Anthropic and OpenAI decide how plan sign-in may be used with other software, and their rules can change. Anthropic says plan limits assume ordinary, individual use. If a provider asks for API keys, switch that agent to a key. Read their pages:")}
      {Object.values(PROVIDER_TERMS).map((prov) => (
        <View key={prov.name} style={{ gap: space(1) }}>
          <Text style={[t.small, { color: p.ink, fontWeight: "700" }]}>{prov.name}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
            {prov.links.map((l) => <Button key={l.url} small kind="plain" label={l.label} onPress={() => { void Linking.openURL(l.url); }} />)}
          </View>
        </View>
      ))}
    </View>
  );
}
