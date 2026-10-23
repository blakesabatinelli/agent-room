import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { useRoom } from "../state/store";
import { Screen, Section, Toggle } from "../components/ui";
import { space } from "../theme";

export function PermissionsScreen() {
  const { agents, hub } = useRoom(useShallow((s) => ({ agents: s.agents, hub: s.hub })));
  const [tools, setTools] = useState<{ id: string; label: string; sensitive: boolean }[]>([]);
  useEffect(() => { hub?.tools().then(setTools).catch(() => {}); }, [hub]);
  return (
    <Screen title="Permissions">
      <ScrollView contentContainerStyle={{ padding: space(4) }}>
        {agents.map((a) => (
          <Section key={a.id} title={a.name}>
            {tools.map((tool) => {
              const on = !!a.tools[tool.id];
              const auto = !!a.autoApprove?.[tool.id];
              return (
                <React.Fragment key={tool.id}>
                  <Toggle label={tool.label} accent={a.color}
                    hint={tool.sensitive ? (auto ? "Runs without asking" : "Asks you before each use") : undefined}
                    value={on} onChange={(v) => hub?.setTools(a.id, { [tool.id]: v })} />
                  {tool.id === "shell" && on ? (
                    <Toggle label="    Run shell commands without asking" accent={a.color}
                      hint={a.adapter === "codex"
                        ? "Codex already runs commands inside its sandbox without asking. This covers anything it asks the room about."
                        : "Commands run right away. Each one is still logged in Activity and the audit log."}
                      value={auto} onChange={(v) => hub?.setAutoApprove(a.id, { shell: v })} />
                  ) : null}
                </React.Fragment>
              );
            })}
          </Section>
        ))}
      </ScrollView>
    </Screen>
  );
}
