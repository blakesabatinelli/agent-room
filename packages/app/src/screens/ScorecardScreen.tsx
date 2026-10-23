import { useShallow } from "zustand/react/shallow";
import React from "react";
import { ScrollView } from "react-native";
import { useRoom } from "../state/store";
import { FirstPass } from "../components/FirstPass"; // 2.1
import { ReturnLedgerView, WeeklyScorecard } from "../components/Scorecard"; // 2.7
import { Screen, Section } from "../components/ui";
import { space } from "../theme";

/** 3.1: the scorecard and the return ledger on a screen of their own (they were sections at the top of Settings). */
export function ScorecardScreen() {
  const hub = useRoom(useShallow((s) => s.hub));
  return (
    <Screen title="Scorecard">
      <ScrollView contentContainerStyle={{ padding: space(4) }}>
        <Section title="First pass" hint="How often agents' work is accepted the first time it is reviewed. Retros after each goal feed what they learn into later tasks.">
          <FirstPass hub={hub} />
          <WeeklyScorecard hub={hub} />
        </Section>
        <Section title="Return ledger" hint="What each plan cost this month against the tasks you accepted from it.">
          <ReturnLedgerView hub={hub} />
        </Section>
      </ScrollView>
    </Screen>
  );
}
