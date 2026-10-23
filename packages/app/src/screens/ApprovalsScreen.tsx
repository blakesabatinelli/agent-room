import { useShallow } from "zustand/react/shallow";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Approval, WriteProposal } from "@agent-room/shared";
import { findProposalForApproval, isFileWriteApproval, parseUnifiedDiff } from "@agent-room/shared/src/diff";
import { useRoom } from "../state/store";
import { Button, Empty, Screen, Strip } from "../components/ui";
import { FileChangeReview } from "../components/DiffViewer";
import { space, type as t, usePalette } from "../theme";

export function ApprovalsScreen() {
  const p = usePalette();
  const { approvals, agents, hub, setError } = useRoom(useShallow((s) => ({ approvals: s.approvals, agents: s.agents, hub: s.hub, setError: s.setError })));

  // The full diffs live on the hub's write proposals. A file approval is never decided from its preview text.
  const [proposals, setProposals] = useState<WriteProposal[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reviewing, setReviewing] = useState<string | undefined>();
  const tried = useRef(new Set<string>());

  const load = useCallback(async () => {
    if (!hub) return;
    setLoading(true); setLoadError("");
    try { setProposals(await hub.writeProposals()); }
    catch (e) { setLoadError((e as Error).message); }
    finally { setLoading(false); }
  }, [hub]);

  const proposalFor = (a: Approval) => (proposals ? findProposalForApproval(a, proposals) : undefined);
  useEffect(() => {
    const missing = approvals.filter((a) => isFileWriteApproval(a) && !(proposals && findProposalForApproval(a, proposals)) && !tried.current.has(a.id));
    if (!missing.length || loading) return;
    for (const a of missing) tried.current.add(a.id);
    void load();
  }, [approvals, proposals, loading, load]);

  const decide = async (a: Approval, decision: "approved" | "rejected") => {
    try { await hub?.decide(a.id, decision); setReviewing(undefined); }
    catch (e) { setError((e as Error).message); }
  };

  const open = reviewing ? approvals.find((a) => a.id === reviewing) : undefined;
  const openProposal = open ? proposalFor(open) : undefined;
  if (open && openProposal) {
    const agent = agents.find((x) => x.id === open.agentId);
    return (
      <Screen title="Review change" subtitle={agent ? `${agent.name} is waiting` : undefined}>
        <FileChangeReview key={openProposal.id} path={openProposal.relPath}
          subtitle={`${agent?.name ?? open.agentId} wants to ${openProposal.baseSha256 ? "change" : "create"} this file.`}
          diff={openProposal.diff}
          onBack={() => setReviewing(undefined)}
          onApprove={() => { if (!parseUnifiedDiff(openProposal.diff).problem) void decide(open, "approved"); }}
          onReject={() => void decide(open, "rejected")} />
      </Screen>
    );
  }

  return (
    <Screen title="Approvals">
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(3) }}>
        {!approvals.length ? <Empty text="Nothing to approve. Agents ask here before sending email, posting to Slack, changing CRM records, running shell commands or changing your files." /> : null}
        {approvals.map((a) => {
          const agent = agents.find((x) => x.id === a.agentId);
          const file = isFileWriteApproval(a);
          const proposal = file ? proposalFor(a) : undefined;
          const parsed = proposal ? parseUnifiedDiff(proposal.diff) : undefined;
          return (
            <View key={a.id} style={{ flexDirection: "row", gap: space(3), padding: space(4), borderRadius: 12, backgroundColor: p.surface, borderWidth: 1, borderColor: p.line }}>
              <Strip color={agent?.color ?? p.muted} />
              <View style={{ flex: 1, gap: space(2) }}>
                {file ? (
                  <>
                    <Text style={[t.heading, { color: p.ink }]}>{agent?.name ?? a.agentId} wants to {proposal ? (proposal.baseSha256 ? "change" : "create") : "write"} {proposal?.relPath ?? a.action.replace(/^write /, "")}</Text>
                    {parsed ? (
                      <Text style={[t.small, { color: p.muted }]}>
                        <Text style={{ color: p.diffAddInk, fontWeight: "700" }}>+{parsed.added}</Text> <Text style={{ color: p.diffDelInk, fontWeight: "700" }}>-{parsed.removed}</Text>
                        {` in ${parsed.hunks.length} ${parsed.hunks.length === 1 ? "place" : "places"}. Open the full change to approve it.`}
                      </Text>
                    ) : (
                      <Text style={[t.small, { color: loadError ? p.danger : p.muted }]}>
                        {loading || (!proposals && !loadError) ? "Loading the full change…" : loadError ? `Can't load the full change: ${loadError}` : "The full change isn't available, so it can't be approved here. You can reject it."}
                      </Text>
                    )}
                    {parsed?.problem ? <Text style={[t.small, { color: p.danger }]}>{parsed.problem}</Text> : null}
                    <View style={{ flexDirection: "row", gap: space(2) }}>
                      {proposal ? <Button label="Review change" onPress={() => setReviewing(a.id)} /> : null}
                      {!proposal && !loading ? <Button kind="plain" label="Try again" onPress={() => { tried.current.clear(); void load(); }} /> : null}
                      <Button kind="plain" label="Reject" onPress={() => void decide(a, "rejected")} />
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={[t.heading, { color: p.ink }]}>{agent?.name ?? a.agentId} wants to use {a.tool}</Text>
                    <Text style={[t.body, { color: p.ink }]}>{a.action}</Text>
                    <Text selectable style={[t.small, { color: p.muted }]} numberOfLines={8}>{a.detail}</Text>
                    <View style={{ flexDirection: "row", gap: space(2) }}>
                      <Button label="Approve" onPress={() => hub?.decide(a.id, "approved")} />
                      <Button kind="plain" label="Reject" onPress={() => hub?.decide(a.id, "rejected")} />
                    </View>
                  </>
                )}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </Screen>
  );
}
