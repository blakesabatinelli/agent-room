import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { AgentConfig, AgentScore, McpConnection, MemoryExportInfo, ModelShift, VersionScoreRow } from "@agent-room/shared";
import type { SetupInfo } from "../api/client";
import { presence, useRoom } from "../state/store";
import { Avatar, Button, CodeBlock, Field, Pill, Screen, Toggle } from "../components/ui";
import { Profiles } from "../components/Profiles";
import { Discovery } from "../components/Discovery";
import { SignInPanel } from "../components/SignIn";
import { radius, space, type as t, usePalette } from "../theme";

const isMac = Platform.OS === ("macos" as string);
const PROVIDER: Record<string, string> = { "claude-code": "Claude Code · your Claude plan", codex: "Codex · your ChatGPT plan", mcp: "Joins over MCP", command: "Command on this Mac", "openai-api": "API", mock: "Practice agent" };
// Strong enough to carry white initials on a light background.
const COLORS = ["#D9822B", "#D6336C", "#1C7ED6", "#2F9E44", "#B08800", "#7048E8", "#5C6B7A"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const capLabel = (n?: number) => (n && n >= 1024 ? `${Number((n / 1024).toFixed(1))} KB` : `${n ?? 4096} bytes`);

export function AgentsScreen({ onBack }: { onBack?: () => void }) {
  const p = usePalette();
  const { agents, hub } = useRoom(useShallow((s) => ({ agents: s.agents, hub: s.hub })));
  const [scores, setScores] = useState<AgentScore[]>([]);
  const [setup, setSetup] = useState<SetupInfo>();
  const [adding, setAdding] = useState(false);
  const [versions, setVersions] = useState<VersionScoreRow[]>([]); // 2.4
  const [shifts, setShifts] = useState<ModelShift[]>([]); // 2.4, newest first

  useEffect(() => {
    if (!hub) return;
    hub.scores().then(setScores).catch(() => {});
    hub.versionScores().then(setVersions).catch(() => {});
    hub.modelShifts().then(setShifts).catch(() => {});
    hub.setup().then(setSetup).catch(() => {});
    void useRoom.getState().refreshStatus(true);
  }, [hub]);

  return (
    <Screen title="Agents & connections" subtitle="Sign agents in, connect MCP agents, and choose who's available"
      left={onBack ? <Button small kind="ghost" label="‹" onPress={onBack} /> : undefined}
      right={<>
        <Button small kind="plain" label="Check all" onPress={() => void useRoom.getState().refreshStatus(true)} />
        <Button small label={adding ? "Close" : "Add agent"} onPress={() => setAdding(!adding)} />
      </>}>
      <ScrollView contentContainerStyle={{ padding: space(5), gap: space(4), maxWidth: 860, width: "100%", alignSelf: "center" }}>
        {setup?.practiceMode ? (
          <View style={{ padding: space(3), borderRadius: radius.lg, backgroundColor: p.warnBg, flexDirection: "row", alignItems: "center", gap: space(3) }}>
            <Text style={[t.small, { color: p.ink, flex: 1 }]}>Practice agents are on, so every agent answers with canned replies. Turn this off to use your real agents.</Text>
            <Button small kind="plain" label="Use real agents" onPress={async () => { await hub?.saveSetup({ practiceMode: false }); setSetup(await hub?.setup()); void useRoom.getState().refreshStatus(true); }} />
          </View>
        ) : null}
        <Discovery />
        {adding ? <AddAgent existing={agents} onDone={() => setAdding(false)} /> : null}
        {agents.map((a) => <AgentCard key={a.id} a={a} scores={scores.filter((s) => s.agentId === a.id && s.runs > 0)}
          version={versions.filter((v) => v.agentId === a.id && v.current && v.modelVersion !== "unknown").sort((x, y) => y.lastSeen - x.lastSeen)[0]?.modelVersion}
          shift={shifts.find((x) => x.agentId === a.id && x.kind === "shift")?.text} />)}
      </ScrollView>
    </Screen>
  );
}

function AgentCard({ a, scores, version, shift }: { a: AgentConfig; scores: AgentScore[]; version?: string; shift?: string }) {
  const p = usePalette();
  const s = useRoom(useShallow((s) => ({ hub: s.hub, openDm: s.openDm, refreshStatus: s.refreshStatus, statuses: s.statuses, agents: s.agents, working: s.working })));
  const { hub } = s;
  const st = s.statuses[a.id];
  const pres = presence(s, a.id);
  const [open, setOpen] = useState(!st?.ready && a.enabled && (a.adapter === "mcp"));
  const [note, setNote] = useState<string>();
  const [log, setLog] = useState<string | null>();
  const [advanced, setAdvanced] = useState(false);
  // 2.5: which file this agent's memory export writes, and how big the block may be
  const [exp, setExp] = useState<MemoryExportInfo>();
  useEffect(() => { hub?.memoryExport().then((l) => setExp(l.find((x) => x.agentId === a.id))).catch(() => {}); }, [hub, a.id, a.settings.memoryExport]);
  useEffect(() => { if (st?.ready) setNote(undefined); }, [st?.ready]);

  const label = !a.enabled ? "Off" : st?.ready ? (pres === "busy" ? "Working" : "Connected")
    : st?.state === "not_installed" ? "Not installed" : st?.state === "signed_out" ? "Not signed in"
    : st?.state === "error" ? "Problem" : a.adapter === "mcp" ? "Waiting to connect" : "Checking…";
  const tone = !a.enabled ? p.faint : st?.ready ? p.ok : st?.state === "error" ? p.danger : p.warn;

  const showLog = async () => { try { setLog((await hub!.signInLog(a.id)).log ?? "No setup log yet."); } catch (e) { setLog((e as Error).message); } };
  const remove = async () => { if (note !== "confirm-remove") return setNote("confirm-remove"); await hub?.deleteAgent(a.id); };

  return (
    <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.xl, backgroundColor: p.surface, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(3), padding: space(4) }}>
        <Avatar name={a.name} color={a.color} size={40} presence={pres === "error" ? "off" : pres} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
            <Text style={[t.heading, { color: p.inkStrong, fontSize: 16 }]}>{a.name}</Text>
            <Pill text={label} color={tone} />
          </View>
          <Text style={[t.small, { color: p.muted }]} numberOfLines={1}>{PROVIDER[a.adapter] ?? a.adapter}{st?.detail ? ` · ${st.detail}` : ""}</Text>
        </View>
        {st?.ready && a.enabled ? <Button small kind="plain" label="Message" onPress={() => void s.openDm(a.id)} /> : null}
        <Button small kind={open ? "plain" : st?.ready || !a.enabled ? "plain" : "primary"} label={open ? "Done" : st?.ready ? "Manage" : "Connect"} onPress={() => setOpen(!open)} />
      </View>

      {open ? (
        <View style={{ borderTopWidth: 1, borderColor: p.line, padding: space(4), gap: space(4) }}>
          {a.adapter === "claude-code" || a.adapter === "codex" ? (
            <View style={{ gap: space(3) }}>
              <Text style={[t.body, { color: p.ink }]}>
                {a.adapter === "codex"
                  ? "Codex is OpenAI's agent CLI. It runs on your ChatGPT subscription; no API key needed."
                  : "Claude Code runs on your Claude subscription; no API key needed."}
              </Text>
              {isMac ? (
                <View style={{ gap: space(3) }}>
                  <SignInPanel agentId={a.id} adapter={a.adapter} ready={!!st?.ready} notInstalled={st?.state === "not_installed"} onChanged={() => void s.refreshStatus(true)} />
                  <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                  <Button kind="plain" label="Check again" onPress={() => void s.refreshStatus(true)} />
                  <Button kind="ghost" label="Show setup log" onPress={showLog} />
                  </View>
                </View>
              ) : <Text style={[t.small, { color: p.muted }]}>Sign agents in from the Mac app.</Text>}
              {note && note !== "confirm-remove" ? <Text style={[t.small, { color: p.muted }]}>{note}</Text> : null}
              {st && !st.ready && st.state === "error" ? <CodeBlock label="Last error" text={st.detail} /> : null}
              {log !== undefined ? <CodeBlock label="Setup log" text={log ?? ""} /> : null}
            </View>
          ) : null}

          {a.adapter === "mcp" ? <McpSetup a={a} /> : null}

          {a.adapter !== "mcp" ? <Profiles a={a} /> : null}

          <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, overflow: "hidden" }}>
            <Toggle label="Available in the room" accent={p.ok} value={a.enabled}
              hint="When off, it won't be picked for work or reviews." onChange={(v) => hub?.updateAgent(a.id, { enabled: v })} />
            {exp?.supported && exp.file ? (
              <Toggle label={`Share room memory with ${a.name} outside the room`} value={a.settings.memoryExport === true}
                hint={`Off by default. When on, it writes what the room knows into ${exp.file}, in one block between two marker lines, up to ${capLabel(exp.capBytes)}. The rest of that file is never touched, and your original is saved once first.${exp.note ? ` ${exp.note}` : ""}`}
                onChange={(v) => hub?.updateAgent(a.id, { settings: { ...a.settings, memoryExport: v } })} />
            ) : null}
            <View style={{ paddingHorizontal: space(4), paddingVertical: space(3) }}>
              <Text style={[t.small, { color: p.muted }]}>
                {scores.length ? `Track record: ${scores.map((x) => `${x.taskType} ${Math.round(x.quality * 100)} over ${x.runs}`).join(" · ")}`
                  : "No track record yet. The room will try it out and learn what it's good at."}
              </Text>
              {version ? <Text style={[t.small, { color: p.muted, marginTop: 2 }]}>{`Model version: ${version}`}</Text> : null}
              {shift ? <Text style={[t.small, { color: p.warn, marginTop: 2 }]}>{shift}</Text> : null}
            </View>
          </View>

          <Pressable onPress={() => setAdvanced(!advanced)}><Text style={[t.small, { color: p.link }]}>{advanced ? "Hide advanced" : "Advanced"}</Text></Pressable>
          {advanced ? (
            <View>
              {a.adapter === "command" ? (
                <>
                  <Field label="Command" defaultValue={String(a.settings.command ?? "")}
                    onEndEditing={(e) => hub?.updateAgent(a.id, { settings: { ...a.settings, command: e.nativeEvent.text } })} />
                  <Field label="Arguments" hint="{prompt} or {promptFile} is replaced with the work." defaultValue={((a.settings.args as string[]) ?? ["{prompt}"]).join(" ")}
                    onEndEditing={(e) => hub?.updateAgent(a.id, { settings: { ...a.settings, args: e.nativeEvent.text.split(" ").filter(Boolean) } })} />
                </>
              ) : a.adapter === "claude-code" || a.adapter === "codex" ? (
                <Field label="Default model" hint="Used when no profile is set. Leave blank for the CLI's default." defaultValue={String(a.settings.model ?? "")}
                  onEndEditing={(e) => hub?.updateAgent(a.id, { settings: { ...a.settings, model: e.nativeEvent.text || undefined } })} />
              ) : a.adapter === "mcp" ? (
                <Field label="Minutes to wait for a result" defaultValue={String(a.settings.timeoutMinutes ?? 30)} keyboardType="number-pad"
                  onEndEditing={(e) => hub?.updateAgent(a.id, { settings: { ...a.settings, timeoutMinutes: Math.max(1, Number(e.nativeEvent.text) || 30) } })} />
              ) : null}
              <Button kind="danger" small label={note === "confirm-remove" ? `Really remove ${a.name}?` : `Remove ${a.name}`} onPress={remove} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Step-by-step MCP hookup for Hermes, Muse or any agent that can use an MCP server. */
function McpSetup({ a }: { a: AgentConfig }) {
  const p = usePalette();
  const { hub, statuses } = useRoom(useShallow((s) => ({ hub: s.hub, statuses: s.statuses })));
  const [conn, setConn] = useState<McpConnection>();
  const [info, setInfo] = useState<{ exists: boolean; connected: boolean; lastSeen: number | null }>();
  const [tab, setTab] = useState(a.id === "hermes" ? "hermes" : "json");
  const [err, setErr] = useState<string>();

  const refresh = () => hub?.mcpInfo(a.id).then(setInfo).catch(() => {});
  useEffect(() => { void refresh(); const i = setInterval(() => { void refresh(); }, 3000); return () => clearInterval(i); }, [hub, a.id]);
  // Show the key the agent already has; a restart or reopening this screen never changes it.
  useEffect(() => {
    if (info?.exists && !conn && hub) hub.mcpConfig(a.id).then(setConn).catch(() => {});
  }, [info?.exists, hub, a.id]);
  const create = async () => { try { setErr(undefined); setConn(await hub!.mcpConnect(a.id)); } catch (e) { setErr((e as Error).message); } };
  const rotate = () => Alert.alert(
    `Make a new key for ${a.name}?`,
    `The current key stops working right away. ${a.name} will disconnect until you paste the new config into it.`,
    [{ text: "Cancel", style: "cancel" },
     { text: "Make a new key", style: "destructive", onPress: async () => {
       try { setErr(undefined); setConn(await hub!.mcpConnect(a.id, true)); } catch (e) { setErr((e as Error).message); } } }],
  );
  const revoke = async () => { await hub?.mcpRevoke(a.id); setConn(undefined); void refresh(); };
  const connected = info?.connected || statuses[a.id]?.ready;
  const snippet = conn?.snippets?.find((x) => x.id === tab) ?? conn?.snippets?.[0];

  const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
    <View style={{ flexDirection: "row", gap: space(3) }}>
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: p.raised, alignItems: "center", justifyContent: "center" }}>
        <Text style={[t.tiny, { color: p.inkStrong, fontWeight: "800" }]}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: space(2) }}>
        <Text style={[t.body, { color: p.inkStrong, fontWeight: "700" }]}>{title}</Text>
        {children}
      </View>
    </View>
  );

  return (
    <View style={{ gap: space(5) }}>
      <Text style={[t.body, { color: p.ink }]}>
        {a.name} joins the room as an MCP client: it connects to Agent Room, waits for work, and sends results back. Nothing to install on the Agent Room side.
      </Text>

      <Step n={1} title="Create a private connection">
        <Text style={[t.small, { color: p.muted }]}>
          {conn?.tokenHidden ? `${a.name} has a key, but a key is only shown when it is made. Make a new key to copy a working setup.`
            : info?.exists || conn ? `${a.name} has a key. Copy it now: it is hidden once the hub restarts, and then you make a new one.` : "This makes a key that only works for this agent."}
        </Text>
        <View style={{ flexDirection: "row", gap: space(2) }}>
          {info?.exists || conn
            ? <Button label="Make a new key" kind="plain" onPress={rotate} />
            : <Button label="Create connection" kind="primary" onPress={create} />}
          {info?.exists ? <Button kind="ghost" label="Disconnect" onPress={revoke} /> : null}
        </View>
        {err ? <Text style={[t.small, { color: p.danger }]}>{err}</Text> : null}
      </Step>

      {conn ? (
        <>
          <Step n={2} title={`Add Agent Room to ${a.name}`}>
            {conn.tokenHidden ? (
              <View style={{ gap: space(2), padding: space(3), borderRadius: radius.lg, borderWidth: 1, borderColor: p.warn, backgroundColor: p.sunken }}>
                <Text style={[t.small, { color: p.inkStrong, fontWeight: "700" }]}>Key hidden.</Text>
                <Text style={[t.small, { color: p.muted }]}>The text below has YOUR_KEY where the key goes. It won't connect until you put a key there. If {a.name} already has its key, nothing changes. If not, make a new key.</Text>
                <View style={{ flexDirection: "row" }}><Button small kind="primary" label="Make a new key" onPress={rotate} /></View>
              </View>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1.5) }}>
              {conn.snippets?.map((x) => (
                <Pressable key={x.id} onPress={() => setTab(x.id)}
                  style={{ paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: 99, borderWidth: 1, borderColor: tab === x.id ? p.accent : p.line, backgroundColor: tab === x.id ? p.tint : "transparent" }}>
                  <Text style={[t.tiny, { color: tab === x.id ? p.inkStrong : p.muted, fontWeight: "700" }]}>{x.label}</Text>
                </Pressable>
              ))}
            </View>
            {snippet ? <><Text style={[t.small, { color: p.muted }]}>{snippet.where}</Text><CodeBlock label={snippet.label} text={snippet.text} /></> : null}
          </Step>
          <Step n={3} title={`Start ${a.name} listening`}>
            <Text style={[t.small, { color: p.muted }]}>Paste this into {a.name} as a message (or its standing instructions). It keeps asking the room for work until you stop it.</Text>
            <CodeBlock label="Start message" text={conn.instructions} />
          </Step>
        </>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), padding: space(3), borderRadius: radius.lg, backgroundColor: connected ? p.okBg : p.sunken, borderWidth: 1, borderColor: connected ? p.ok : p.line }}>
        <Text style={{ color: connected ? p.ok : p.warn, fontSize: 14 }}>{connected ? "●" : "○"}</Text>
        <Text style={[t.small, { color: p.ink, flex: 1 }]}>
          {connected ? `${a.name} is connected and ready for work.`
            : info?.lastSeen ? `Last heard from ${a.name} ${new Date(info.lastSeen).toLocaleString()}. Waiting for it to check in…`
            : `Waiting for ${a.name} to connect… this updates on its own.`}
        </Text>
      </View>
    </View>
  );
}

function AddAgent({ existing, onDone }: { existing: AgentConfig[]; onDone: () => void }) {
  const p = usePalette();
  const hub = useRoom((s) => s.hub);
  const [kind, setKind] = useState<"mcp" | "command">("mcp");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [err, setErr] = useState<string>();
  const has = (id: string) => existing.some((a) => a.id === id);
  const presets = [
    { id: "hermes", name: "Hermes", color: "#E8912D", blurb: "Your Hermes agent, over MCP" },
    { id: "muse", name: "Muse", color: "#E01E5A", blurb: "Muse, over MCP" },
  ].filter((x) => !has(x.id));

  const add = async (id: string, nm: string, adapter: "mcp" | "command", color?: string) => {
    try {
      if (!id) return setErr("Give it a name.");
      if (has(id)) return setErr(`There's already an agent called ${nm}.`);
      await hub?.saveAgent({ id, name: nm, provider: id, adapter, enabled: true, color: color ?? COLORS[existing.length % COLORS.length],
        settings: adapter === "command" ? { command, args: ["{prompt}"] } : {},
        tools: { web: true, filesystem: true, shell: false, gmail: false, slack: false, drive: false, salesforce: false } });
      onDone();
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <View style={{ borderWidth: 1, borderColor: p.lineStrong, borderRadius: radius.xl, backgroundColor: p.surface, padding: space(5), gap: space(4) }}>
      <Text style={[t.heading, { color: p.inkStrong, fontSize: 16 }]}>Add an agent</Text>
      {presets.length ? (
        <View style={{ flexDirection: "row", gap: space(3), flexWrap: "wrap" }}>
          {presets.map((x) => (
            <Pressable key={x.id} onPress={() => add(x.id, x.name, "mcp", x.color)}
              style={{ flexDirection: "row", alignItems: "center", gap: space(3), padding: space(3), borderRadius: radius.lg, borderWidth: 1, borderColor: p.line, minWidth: 220 }}>
              <Avatar name={x.name} color={x.color} size={32} />
              <View><Text style={[t.body, { color: p.inkStrong, fontWeight: "700" }]}>{x.name}</Text><Text style={[t.tiny, { color: p.muted }]}>{x.blurb}</Text></View>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: space(2) }}>
        <Button small kind={kind === "mcp" ? "primary" : "plain"} label="Any MCP agent" onPress={() => setKind("mcp")} />
        <Button small kind={kind === "command" ? "primary" : "plain"} label="Command on this Mac" onPress={() => setKind("command")} />
      </View>
      <Field label="Name" value={name} onChangeText={setName} placeholder={kind === "mcp" ? "e.g. Alex" : "e.g. Opencode"} />
      {kind === "command" ? <Field label="Command" value={command} onChangeText={setCommand} autoCapitalize="none" placeholder="opencode" hint="Agent Room runs it with the work as the last argument." /> : null}
      {err ? <Text style={[t.small, { color: p.danger }]}>{err}</Text> : null}
      <View style={{ flexDirection: "row", gap: space(2) }}>
        <Button label="Add" onPress={() => add(slug(name), name.trim(), kind)} disabled={!name.trim() || (kind === "command" && !command.trim())} />
        <Button kind="ghost" label="Cancel" onPress={onDone} />
      </View>
    </View>
  );
}
