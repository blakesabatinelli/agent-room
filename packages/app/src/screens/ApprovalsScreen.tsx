import { useShallow } from "zustand/react/shallow";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Approval, WriteProposal } from "@agent-room/shared";
import { fetchProposalForApproval, isFileWriteApproval, opWords, parseChangeDiff } from "@agent-room/shared/src/diff";
import { useRoom } from "../state/store";
import { Button, Empty, Screen, Strip } from "../components/ui";
import { FileChangeReview } from "../components/DiffViewer";
import { TwoKeyApproval } from "../components/TwoKeyCard";
import { space, type as t, usePalette } from "../theme";

/** What the card says a proposal is: one file, or everything one task changed. */
const verb = (pr: WriteProposal) => (pr.kind === "task" ? "write" : pr.baseSha256 ? "change" : "create");
const what = (pr: WriteProposal) => (pr.kind === "task" ? `${pr.files?.length ?? 0} file${pr.files?.length === 1 ? "" : "s"} from "${pr.title ?? "a task"}"` : pr.relPath);

export function ApprovalsScreen() {
  const p = usePalette();
  const { approvals, agents, hub, setError } = useRoom(useShallow((s) => ({ approvals: s.approvals, agents: s.agents, hub: s.hub, setError: s.setError })));

  // The full change is one proposal, fetched by the approval's proposalId (GET /write-proposals/:id). A file approval is
  // never decided from its preview text. The list route has no diffs; it only backs the guarded fallbacks.
  const [proposals, setProposals] = useState<Record<string, WriteProposal>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState<string | undefined>();
  const tried = useRef(new Set<string>());

  const load = useCallback(async (a: Approval) => {
    if (!hub) return;
    setLoading((l) => ({ ...l, [a.id]: true }));
    setLoadError((l) => { const { [a.id]: _, ...rest } = l; return rest; });
    try {
      const found = await fetchProposalForApproval(a, { one: (id) => hub.writeProposal(id), list: () => hub.writeProposals() });
      if (found) setProposals((m) => ({ ...m, [a.id]: found }));
    } catch (e) { setLoadError((l) => ({ ...l, [a.id]: (e as Error).message })); }
    finally { setLoading((l) => ({ ...l, [a.id]: false })); }
  }, [hub]);

  useEffect(() => {
    for (const a of approvals) {
      if (a.twoKey || !isFileWriteApproval(a) || proposals[a.id] || tried.current.has(a.id)) continue;
      tried.current.add(a.id);
      void load(a);
    }
  }, [approvals, proposals, load]);

  const decide = async (a: Approval, decision: "approved" | "rejected") => {
    try { await hub?.decide(a.id, decision); setReviewing(undefined); }
    catch (e) { setError((e as Error).message); }
  };

  // 4.2: approve this one and allow the same kind of thing for a while, or for the rest of the goal
  const lease = async (a: Approval, how: { minutes: number } | { forGoal: true }) => {
    try { await hub?.leaseApproval(a.id, how); }
    catch (e) { setError((e as Error).message); }
  };

  const answer = async (a: Approval, choice: string) => {
    try { await hub?.answer(a.id, choice); }
    catch (e) { setError((e as Error).message); }
  };

  const open = reviewing ? approvals.find((a) => a.id === reviewing) : undefined;
  const openProposal = open ? proposals[open.id] : undefined;
  if (open && openProposal) {
    const agent = agents.find((x) => x.id === open.agentId);
    const who = agent?.name ?? open.agentId;
    return (
      <Screen title="Review change" subtitle={agent ? `${agent.name} is waiting` : undefined}>
        <FileChangeReview key={openProposal.id} path={openProposal.kind === "task" ? what(openProposal) : openProposal.relPath}
          subtitle={openProposal.kind === "task" ? `${who} finished "${openProposal.title ?? "a task"}" and wants to write its files to your folder.` : `${who} wants to ${verb(openProposal)} this file.`}
          diff={openProposal.diff} files={openProposal.files} skipped={openProposal.skipped} unappliable={openProposal.unappliable}
          onBack={() => setReviewing(undefined)}
          onApprove={() => { if (!openProposal.unappliable && !parseChangeDiff(openProposal.diff, openProposal.files).problem) void decide(open, "approved"); }}
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
          const file = !a.twoKey && isFileWriteApproval(a);
          const proposal = file ? proposals[a.id] : undefined;
          const parsed = proposal ? parseChangeDiff(proposal.diff, proposal.files) : undefined;
          const isLoading = !!loading[a.id], err = loadError[a.id];
          return (
            <View key={a.id} style={{ flexDirection: "row", gap: space(3), padding: space(4), borderRadius: 12, backgroundColor: p.surface, borderWidth: 1, borderColor: p.line }}>
              <Strip color={agent?.color ?? p.muted} />
              <View style={{ flex: 1, gap: space(2) }}>
                {a.twoKey ? (
                  // 4.1: two agents drafted the action on their own; the owner sees both and picks
                  <TwoKeyApproval approval={a} agentName={agent?.name ?? a.agentId} onAnswer={(choice) => answer(a, choice)} />
                ) : a.question ? (
                  // 2.5: a memory question has three answers, not approve or reject
                  <>
                    <Text style={[t.heading, { color: p.ink }]}>The room remembers two different things</Text>
                    <Text style={[t.body, { color: p.ink }]}>{a.action}</Text>
                    <Text selectable style={[t.small, { color: p.muted }]} numberOfLines={6}>{a.detail}</Text>
                    <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                      {a.question.choices.map((c, i) => <Button key={c.id} kind={i === 0 ? "primary" : "plain"} label={c.label} onPress={() => answer(a, c.id)} />)}
                    </View>
                  </>
                ) : file ? (
                  <>
                    <Text style={[t.heading, { color: p.ink }]}>{agent?.name ?? a.agentId} wants to {proposal ? verb(proposal) : "write"} {proposal ? what(proposal) : a.action.replace(/^write /, "")}</Text>
                    {parsed && proposal ? (
                      <>
                        <Text style={[t.small, { color: p.muted }]}>
                          <Text style={{ color: p.diffAddInk, fontWeight: "700" }}>+{parsed.added}</Text> <Text style={{ color: p.diffDelInk, fontWeight: "700" }}>-{parsed.removed}</Text>
                          {` in ${parsed.places} ${parsed.places === 1 ? "place" : "places"}.${proposal.unappliable ? "" : " Open the full change to approve it."}`}
                        </Text>
                        {proposal.kind === "task" && proposal.files?.length ? (
                          <View style={{ gap: 2 }}>
                            {proposal.files.map((f) => <Text key={f.relPath} selectable style={[t.small, { color: p.ink }]}>{opWords(f.op)}: {f.relPath}</Text>)}
                          </View>
                        ) : null}
                        {proposal.skipped?.length ? (
                          <View style={{ gap: 2 }}>
                            <Text style={[t.small, { color: p.warn, fontWeight: "700" }]}>{proposal.skipped.length} file{proposal.skipped.length === 1 ? "" : "s"} won't be written:</Text>
                            {proposal.skipped.map((x) => <Text key={x.relPath} selectable style={[t.small, { color: p.muted }]}>{x.relPath}: {x.reason}</Text>)}
                          </View>
                        ) : null}
                        {proposal.unappliable ? <Text style={[t.small, { color: p.danger }]}>Can't be applied: {proposal.unappliable}</Text> : null}
                      </>
                    ) : (
                      <Text style={[t.small, { color: err ? p.danger : p.muted }]}>
                        {isLoading || (!err && !tried.current.has(a.id)) ? "Loading the full change…" : err ? `Can't load the full change: ${err}` : "The full change isn't available, so it can't be approved here. You can reject it."}
                      </Text>
                    )}
                    {parsed?.problem ? <Text style={[t.small, { color: p.danger }]}>{parsed.problem}</Text> : null}
                    <View style={{ flexDirection: "row", gap: space(2) }}>
                      {proposal && !proposal.unappliable ? <Button label="Review change" onPress={() => setReviewing(a.id)} /> : null}
                      {!proposal && !isLoading ? <Button kind="plain" label="Try again" onPress={() => void load(a)} /> : null}
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
                    <View style={{ flexDirection: "row", gap: space(2) }}>
                      <Button small kind="ghost" label="Allow for 30 minutes" onPress={() => void lease(a, { minutes: 30 })} />
                      <Button small kind="ghost" label="Allow for this goal" onPress={() => void lease(a, { forGoal: true })} />
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
