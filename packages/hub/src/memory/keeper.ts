import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, Approval, MemoryEntry, MemoryExportInfo, MemoryKind, MemoryProposal, MemoryQuestion, MemorySource, ServerEvent } from "@agent-room/shared";
import { contradicts } from "../control/facts.js";
import type { ControlFolder } from "../control/folder.js";
import type { Store } from "../db/store.js";
import { memoryPrompt } from "../orchestrator/prompts.js";
import type { Approvals } from "../orchestrator/approvals.js";
import { id } from "../util.js";
import { MemoryExporter, type ExportEnv, type ExportResult } from "./export.js";
import { bodyHash, buildMemoryFile, normText, oneLine, parseSourceLabel, sameSource, sha } from "./format.js";
import { DAY_MS, PRUNE_AFTER_DAYS, dateOf, describeSource, endOfDate, ensureProvenance, expiryFrom, isExpired, isLive, isMemoryKind, shortDate, ttlSetting, validDays } from "./model.js";
import { parseFacts } from "../control/facts.js";
import { isStandingRoom } from "../rooms/standing.js"; // 4.3

/**
 * 2.5: the keeper. Only the orchestrator writes shared memory; this is the code it does that with.
 *  - every fact has a source and an expiry; a fact that is asserted again is renewed, not duplicated
 *  - a proposal that contradicts a live fact never replaces it: the owner gets one question with three answers
 *  - rooms/<slug>/MEMORY.md and agents/<id>/MEMORY.md follow the database, and the owner's edits in them come back
 *  - the unexpired shared memory is compiled into each opted-in agent's own context file (export.ts)
 * orchestrator.ts only forwards to the methods here.
 */

export interface ProposeOptions {
  /** The goal the agent was working on. Becomes the fact's source. */
  goalId?: string;
  /** The task the agent was working on (its goal is used when `goalId` isn't given). */
  taskId?: string;
  /** How long the agent thinks this stays true. The keeper decides. */
  expiresInDays?: number;
  /** Where the agent says it learned this (free text; a goal id is recognised). */
  sourceHint?: string;
  kind?: MemoryKind;
}

interface Verdict { decision?: "accept" | "reject" | "merge"; text?: string; mergeWith?: string; kind?: string; expiresInDays?: number | null; contradicts?: string | null }

export interface KeeperDeps {
  store: Store;
  approvals: Approvals;
  control: () => ControlFolder | undefined;
  /** Ask the orchestrator's quick model for JSON. null when it couldn't answer. */
  ask: <T>(prompt: string) => Promise<T | null>;
  /** The hub's data folder (the first-time backups of agent files go under it). */
  dataDir: string;
}
export interface KeeperOptions {
  /** Wait after a change before the files and the export are updated. */
  debounceMs?: number;
  now?: () => number;
  /** Where agent context files live (home folder and the variables that move them). Tests give a fake home. */
  exportEnv?: ExportEnv;
  backupDir?: string;
  log?: (m: string) => void;
}

interface SyncState { hash: string; ids: string[] }
export const ROOM_MEMORY_CAP = 16 * 1024;
export const AGENT_MEMORY_CAP = 8 * 1024;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/i;
const clip = (t: string, n = 120) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export class MemoryKeeper {
  readonly exporter: MemoryExporter;
  private dirty = new Set<string>();
  private exportDirty = false;
  private timer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();
  private attached?: ControlFolder;
  private detach?: () => void;
  private stops: (() => void)[] = [];

  constructor(private d: KeeperDeps, private o: KeeperOptions = {}) {
    this.exporter = new MemoryExporter(d.store, {
      env: o.exportEnv ?? { home: homedir(), vars: process.env },
      backupDir: o.backupDir ?? join(d.dataDir, "memory-export"),
      roomsOf: (agentId) => this.roomsOf(agentId),
      now: () => this.now(),
    });
    this.migrate();
    d.store.on("memory", this.onMemory);
    d.store.on("event", this.onEvent);
    this.stops.push(() => d.store.off("memory", this.onMemory), () => d.store.off("event", this.onEvent), d.approvals.onDecided(this.onDecided));
  }

  private now() { return this.o.now?.() ?? Date.now(); }
  private log(m: string) { (this.o.log ?? ((x: string) => console.warn(`[memory] ${x}`)))(m); }
  private ttl() { return ttlSetting(this.d.store.getSettings()); }
  private agentName = (agentId: string) => this.d.store.getAgent(agentId)?.name ?? agentId;

  // ---------------------------------------------------------------- start, stop

  /** Bring the files and the export in line with the database. Call once the control folder is up. */
  async init() {
    this.control();
    this.markAllDirty();
    await this.flush();
  }
  /** Check for expired and old facts every hour (and when the day changes, via the control folder). */
  startTimer(everyMs = 60 * 60_000) {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => { try { this.sweep(); } catch (e) { this.log(`sweep failed: ${(e as Error).message}`); } }, everyMs);
    this.sweepTimer.unref();
  }
  close() {
    clearTimeout(this.timer); clearInterval(this.sweepTimer); this.sweepTimer = undefined;
    this.detach?.(); this.detach = undefined; this.attached = undefined;
    for (const s of this.stops.splice(0)) s();
  }

  // ---------------------------------------------------------------- the model (AC1)

  /** Give every row from before 2.5 a source (`agent`, since nobody recorded one) and an expiry 90 days out (the fact default). Returns how many. */
  migrate(): number {
    let n = 0;
    const at = this.now(); const ttl = this.ttl();
    for (const e of this.d.store.allMemory()) {
      if (e.source && typeof e.expiresAt === "number") continue;
      this.d.store.saveMemory(ensureProvenance(e, { at, ttl }));
      n++;
    }
    if (n) this.d.store.audit("hub", "memory.migrated", `${n} memory row${n === 1 ? "" : "s"} given a source and an expiry`);
    return n;
  }

  /** Drop facts that expired more than 30 days ago, and refresh the files and the export so expired facts leave them. Returns how many were removed. */
  sweep(at = this.now()): number {
    let pruned = 0;
    for (const e of this.d.store.allMemory()) {
      if (typeof e.expiresAt === "number" && e.expiresAt + PRUNE_AFTER_DAYS * DAY_MS < at) { this.d.store.deleteMemory(e.id); pruned++; }
    }
    if (pruned) this.d.store.audit("hub", "memory.pruned", `${pruned} fact${pruned === 1 ? "" : "s"} expired more than ${PRUNE_AFTER_DAYS} days ago`);
    this.markAllDirty();
    return pruned;
  }

  // ---------------------------------------------------------------- proposing

  /** An agent suggests a shared fact. Returns the proposal as it stands: accepted, merged, rejected, asked (contradiction) or pending (the keeper couldn't answer; the owner decides). */
  async propose(agentId: string, roomId: string | undefined, text: string, confidence = 0.6, o: ProposeOptions = {}): Promise<MemoryProposal> {
    const t = oneLine(text).slice(0, 2000);
    const at = this.now();
    const p: MemoryProposal = { id: id("prop"), roomId, text: t, sourceAgentId: agentId, confidence, status: "pending", createdAt: at, source: this.sourceFor(agentId, o), expiresInDays: validDays(o.expiresInDays), memKind: o.kind };
    const store = this.d.store;
    store.saveProposal(p);

    const all = this.sharedRows(roomId);
    // The same thing said again is new evidence for the old fact, not a second fact.
    const same = all.find((e) => normText(e.text) === normText(t));
    if (same) { this.renew(same, { source: p.source!, confidence, days: p.expiresInDays }); return this.settle(p, "merged", "orchestrator"); }

    const live = all.filter((e) => isLive(e, at));
    const d = await this.d.ask<Verdict>(memoryPrompt(t, live, { source: describeSource(p.source!, this.agentName), expiresInDays: p.expiresInDays, today: dateOf(at) }));
    if (!d) return p; // stays pending for the owner to decide in the Memory screen
    if (d.decision === "reject") return this.settle(p, "rejected", "orchestrator");
    const finalText = oneLine(d.text?.trim() || t);
    const target = d.decision === "merge" ? live.find((e) => e.id === d.mergeWith) : undefined;
    const kind: MemoryKind = isMemoryKind(d.kind) ? d.kind : o.kind ?? "fact";
    const days = validDays(d.expiresInDays) ?? p.expiresInDays ?? this.ttl()[kind];
    return this.commit(p, finalText, { target, kind, days, confidence, named: d.contradicts ?? undefined, decidedBy: "orchestrator" });
  }

  /** The owner decides a proposal the keeper couldn't (Keep or Discard in the Memory screen). */
  decide(proposalId: string, accept: boolean, text?: string) {
    const p = this.d.store.getProposal(proposalId);
    if (!p || p.status === "asked") return; // an open question has its own answer card
    if (!accept) { this.settle(p, "rejected", "owner"); this.d.store.audit("owner", "memory.reject", p.text.slice(0, 200)); return; }
    const kind = p.memKind ?? "fact";
    const finalText = oneLine(text ?? p.text);
    this.commit({ ...p, text: finalText }, finalText, { kind, days: p.expiresInDays ?? this.ttl()[kind], confidence: 1, decidedBy: "owner" });
    this.d.store.audit("owner", "memory.accept", finalText.slice(0, 200));
  }

  /** Store a fact or ask about it. Every route into shared memory ends here, so the contradiction check can't be skipped. */
  private commit(p: MemoryProposal, text: string, o: { target?: MemoryEntry; kind: MemoryKind; days: number; confidence: number; named?: string; decidedBy: "orchestrator" | "owner" }): MemoryProposal {
    const store = this.d.store; const at = this.now();
    const all = this.sharedRows(p.roomId);
    const live = all.filter((e) => isLive(e, at));
    const named = o.named ? live.find((e) => e.id === o.named && e.id !== o.target?.id) : undefined;
    const clash = named ?? live.find((e) => e.id !== o.target?.id && contradicts(e.text, text));
    if (clash) return this.askOwner(p, text, o.kind, o.days, clash);

    const source = p.source ?? { kind: "agent" as const, agentId: p.sourceAgentId, at };
    const same = all.find((e) => e.id !== o.target?.id && normText(e.text) === normText(text));
    const into = o.target ?? same;
    if (into) {
      this.renew(into, { text, source, confidence: o.confidence, days: o.days, kind: o.kind });
      return this.settle(p, "merged", o.decidedBy);
    }
    const entry: MemoryEntry = {
      id: id("mem"), scope: "shared", roomId: p.roomId, text, sourceAgentId: p.sourceAgentId, confidence: o.confidence, createdAt: at,
      source, expiresAt: expiryFrom(at, o.days), memKind: o.kind,
    };
    store.saveMemory(entry);
    store.audit("orchestrator", "memory.write", text.slice(0, 200));
    return this.settle(p, "accepted", o.decidedBy);
  }

  /** The same fact asserted again from new evidence: its expiry moves out (never in) and its source becomes the new evidence. */
  private renew(e: MemoryEntry, n: { text?: string; source: MemorySource; confidence: number; days?: number; kind?: MemoryKind }): MemoryEntry {
    const at = this.now();
    const kind = n.kind ?? e.memKind ?? "fact";
    const until = expiryFrom(at, n.days ?? this.ttl()[kind]);
    const next = this.d.store.saveMemory({ ...e, text: n.text ?? e.text, source: n.source, confidence: Math.max(e.confidence, n.confidence), expiresAt: isExpired(e, at) ? until : Math.max(e.expiresAt, until), memKind: kind });
    this.d.store.audit("orchestrator", "memory.renew", `${next.text.slice(0, 160)} (until ${dateOf(next.expiresAt)})`);
    return next;
  }

  private settle(p: MemoryProposal, status: MemoryProposal["status"], by: "orchestrator" | "owner"): MemoryProposal {
    const next = { ...p, status, decidedBy: by };
    this.d.store.saveProposal(next);
    return next;
  }

  private sharedRows(roomId?: string) { return this.d.store.allMemory().filter((e) => e.scope === "shared" && (!e.roomId || e.roomId === roomId)); }

  private sourceFor(agentId: string, o: ProposeOptions): MemorySource {
    const at = this.now(); const hint = o.sourceHint?.trim();
    let goalId = o.goalId;
    if (!goalId && o.taskId) goalId = this.d.store.getTask(o.taskId)?.goalId;
    if (hint && this.d.store.getGoal(hint)) goalId = hint;
    if (goalId) return { kind: "goal", id: goalId, agentId, at };
    return { kind: "agent", agentId, ...(hint ? { id: hint.slice(0, 200) } : {}), at };
  }

  // ---------------------------------------------------------------- the owner's own edits

  /** The owner rewrites a fact in the app. The owner is now its source and it is renewed. */
  ownerEdit(memId: string, text: string): MemoryEntry | undefined {
    const e = this.d.store.getMemory(memId); if (!e) return undefined;
    const at = this.now();
    const next = this.d.store.saveMemory({ ...e, text: oneLine(text), confidence: 1, source: { kind: "owner", at }, expiresAt: this.extended(e, at) });
    this.d.store.audit("owner", "memory.edit", next.text.slice(0, 200));
    return next;
  }
  /** The owner says a fact is still true. */
  ownerRenew(memId: string): MemoryEntry | undefined {
    const e = this.d.store.getMemory(memId); if (!e) return undefined;
    const at = this.now();
    const next = this.d.store.saveMemory({ ...e, source: { kind: "owner", at }, expiresAt: this.extended(e, at) });
    this.d.store.audit("owner", "memory.renew", `${next.text.slice(0, 160)} (until ${dateOf(next.expiresAt)})`);
    return next;
  }
  private extended(e: MemoryEntry, at: number) {
    const until = expiryFrom(at, this.ttl()[e.memKind ?? "fact"]);
    return isExpired(e, at) ? until : Math.max(e.expiresAt, until);
  }

  // ---------------------------------------------------------------- contradictions (AC2)

  /** One question for the owner, in Approvals on the Mac and the phone. Never a second one for the same pair. */
  private askOwner(p: MemoryProposal, newText: string, kind: MemoryKind, days: number, old: MemoryEntry): MemoryProposal {
    const store = this.d.store; const at = this.now();
    const open = store.listApprovals("pending").find((a) => {
      if (a.question?.kind !== "memory" || a.question.oldId !== old.id) return false;
      const other = store.getProposal(a.question.proposalId);
      return !!other && normText(other.text) === normText(newText);
    });
    if (open) {
      store.audit("orchestrator", "memory.question.duplicate", `already asking about: ${clip(newText)}`);
      return this.settle({ ...p, text: newText }, "rejected", "orchestrator");
    }
    const q: MemoryQuestion = {
      kind: "memory", oldId: old.id, proposalId: p.id,
      choices: [{ id: "keep_old", label: "Keep the old one" }, { id: "take_new", label: "Use the new one" }, { id: "drop_both", label: "Both are wrong" }],
    };
    const a: Approval = {
      id: id("apr"), agentId: p.sourceAgentId, roomId: p.roomId, tool: "memory",
      action: `Memory: '${clip(newText)}' contradicts '${clip(old.text)}' (from ${describeSource(old.source, this.agentName)}, ${shortDate(old.source.at)}). Which is right?`,
      detail: `Stored: ${old.text}\nNew: ${newText}`,
      status: "pending", createdAt: at, question: q,
    };
    store.saveProposal({ ...p, text: newText, status: "asked", questionId: a.id, memKind: kind, expiresInDays: days });
    store.saveApproval(a);
    store.audit("orchestrator", "memory.question", `${clip(newText)} vs ${clip(old.text)}`);
    return store.getProposal(p.id)!;
  }

  private onDecided = (a: Approval) => {
    const q = a.question; if (!q || q.kind !== "memory") return;
    const choice = a.choice ?? (a.status === "rejected" ? "keep_old" : undefined);
    if (!choice || !q.choices.some((c) => c.id === choice)) return;
    this.resolve(q, choice as MemoryQuestion["choices"][number]["id"]);
  };

  /** Apply the owner's answer to both rows (the stored fact and the proposed one). The files follow through the store's change events. */
  private resolve(q: MemoryQuestion, choice: MemoryQuestion["choices"][number]["id"]) {
    const store = this.d.store; const at = this.now();
    const old = store.getMemory(q.oldId);
    const p = store.getProposal(q.proposalId);
    if (choice === "keep_old") {
      if (old) store.saveMemory({ ...old, expiresAt: this.extended(old, at) }); // the owner just confirmed it
      if (p) this.settle(p, "rejected", "owner");
    } else if (choice === "take_new") {
      if (p) {
        const kind = p.memKind ?? "fact";
        store.saveMemory({
          id: id("mem"), scope: "shared", roomId: p.roomId, text: p.text, sourceAgentId: p.sourceAgentId, confidence: 1, createdAt: at,
          source: p.source ?? { kind: "agent", agentId: p.sourceAgentId, at }, expiresAt: expiryFrom(at, p.expiresInDays ?? this.ttl()[kind]), memKind: kind, supersedes: old?.id,
        });
        this.settle(p, "accepted", "owner");
      }
      if (old) store.saveMemory({ ...old, expiresAt: at - 1 });
    } else {
      if (old) store.saveMemory({ ...old, expiresAt: at - 1 });
      if (p) this.settle(p, "rejected", "owner");
    }
    store.audit("owner", "memory.question.resolved", `${choice}: ${clip(p?.text ?? "")} vs ${clip(old?.text ?? "")}`);
  }

  // ---------------------------------------------------------------- files (rooms/<slug>/MEMORY.md, agents/<id>/MEMORY.md)

  private control(): ControlFolder | undefined {
    const c = this.d.control();
    if (c && c !== this.attached) { this.detach?.(); this.attached = c; this.detach = c.onLoad(this.onLoad); }
    return c;
  }

  private keyOf(e: MemoryEntry): string | undefined {
    if (e.scope === "private") return e.ownerAgentId && AGENT_ID.test(e.ownerAgentId) ? `agent:${e.ownerAgentId}` : undefined;
    if (!e.roomId) return undefined; // global memory has no file of its own (database only)
    const slug = this.d.control()?.slugFor(e.roomId);
    return slug ? `room:${slug}` : undefined;
  }
  private markAllDirty() {
    const c = this.control();
    if (c) {
      const snap = c.snapshot();
      for (const slug of Object.keys(snap.rooms)) if (snap.rooms[slug].memory) this.dirty.add(`room:${slug}`);
      for (const a of Object.keys(snap.agents)) if (snap.agents[a].memory) this.dirty.add(`agent:${a}`);
      for (const e of this.d.store.allMemory()) { const k = this.keyOf(e); if (k) this.dirty.add(k); }
    }
    this.exportDirty = true;
    this.schedule();
  }

  private onMemory = (ev: { entry: MemoryEntry }) => {
    const k = this.keyOf(ev.entry);
    if (k) this.dirty.add(k);
    if (ev.entry.scope === "shared") this.exportDirty = true;
    this.schedule();
  };
  private onEvent = (e: ServerEvent) => {
    if (e.type === "agent" || e.type === "room") { this.exportDirty = true; this.schedule(); }
  };
  private onLoad = (changed: string[] | undefined) => {
    if (!changed || !changed.length) { this.markAllDirty(); return; }
    for (const rel of changed) {
      const r = /^rooms\/([^/]+)\/MEMORY\.md$/.exec(rel), a = /^agents\/([^/]+)\/MEMORY\.md$/.exec(rel);
      if (r) this.dirty.add(`room:${r[1]}`);
      if (a) this.dirty.add(`agent:${a[1]}`);
      if (/^rooms\/[^/]+\/ROOM\.md$/.test(rel)) this.exportDirty = true; // a roster changed
    }
    this.schedule();
  };

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch((e) => this.log(String(e))); }, this.o.debounceMs ?? 250);
    this.timer.unref?.();
  }

  /** Do the pending file and export work now. */
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const run = this.chain.then(async () => {
      const keys = [...this.dirty]; this.dirty.clear();
      const doExport = this.exportDirty; this.exportDirty = false;
      for (const k of keys) { try { await this.syncKey(k); } catch (e) { this.log(`${k}: ${(e as Error).message}`); } }
      if (doExport) { try { this.exporter.syncAll(this.d.store.listAgents()); } catch (e) { this.log(`export: ${(e as Error).message}`); } }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
  /** Wait until every change so far has reached the files and the export (for tests and shutdown). */
  async idle() {
    for (let i = 0; i < 50; i++) {
      if (this.timer || this.dirty.size || this.exportDirty) await this.flush();
      await this.chain;
      await this.d.control()?.idle();
      if (!this.timer && !this.dirty.size && !this.exportDirty) return;
    }
  }

  private syncState(): Record<string, SyncState> { return this.d.store.getKV("memory.sync", {}); }
  private setState(key: string, s: SyncState) { const all = this.syncState(); all[key] = s; this.d.store.setKV("memory.sync", all); }

  private roomFor(c: ControlFolder, slug: string) { return this.d.store.listRooms().find((r) => !r.dmAgentId && c.slugFor(r.id) === slug); }
  private rowsFor(c: ControlFolder, key: string): MemoryEntry[] {
    const [type, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    // 4.3: what an agent noted in a standing room stays in that room; it isn't copied into the agent's own MEMORY.md, which every room's context carries.
    if (type === "agent") return this.d.store.allMemory().filter((e) => e.scope === "private" && e.ownerAgentId === name && !(e.roomId && isStandingRoom(this.d.store, c, e.roomId)));
    const room = this.roomFor(c, name);
    return room ? this.d.store.allMemory().filter((e) => e.scope === "shared" && e.roomId === room.id) : [];
  }

  private async syncKey(key: string) {
    const c = this.control(); if (!c) return;
    const type = key.slice(0, key.indexOf(":")), name = key.slice(key.indexOf(":") + 1);
    if (type === "room" && !this.roomFor(c, name)) return;
    const rel = type === "room" ? `rooms/${name}/MEMORY.md` : `agents/${name}/MEMORY.md`;
    this.importFile(c, key);
    const at = this.now();
    const entries = this.rowsFor(c, key).filter((e) => isLive(e, at)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    await c.writeManaged(rel, (cur) => {
      // The owner saved a change we haven't loaded yet: leave the file alone, the load brings us back here.
      if (cur !== undefined && this.syncState()[key]?.hash !== bodyHash(cur)) return undefined;
      const built = buildMemoryFile(cur, entries, { kind: type === "room" ? "room-memory" : "agent-memory", updatedBy: "orchestrator", today: dateOf(at), capBytes: type === "room" ? ROOM_MEMORY_CAP : AGENT_MEMORY_CAP });
      if (built.text === undefined) return undefined;
      this.setState(key, { hash: bodyHash(built.text), ids: built.ids });
      if (built.dropped.length) this.d.store.audit("orchestrator", "memory.file.capped", `${rel}: left ${built.dropped.length} fact${built.dropped.length === 1 ? "" : "s"} out to stay under the size cap`);
      return built.text;
    }, `Memory: update ${rel}`, "orchestrator");
  }

  /** The owner edited a MEMORY.md: what they changed, added or removed becomes the database's. */
  private importFile(c: ControlFolder, key: string) {
    const type = key.slice(0, key.indexOf(":")), name = key.slice(key.indexOf(":") + 1);
    const snap = c.snapshot();
    const doc = type === "room" ? snap.rooms[name]?.memory : snap.agents[name]?.memory;
    if (!doc) return;
    const h = sha(doc.body);
    const prev = this.syncState()[key];
    if (prev && prev.hash === h) return;

    const room = type === "room" ? this.roomFor(c, name) : undefined;
    if (type === "room" && !room) return;
    const store = this.d.store; const at = this.now(); const today = dateOf(at); const ttl = this.ttl();
    const rows = this.rowsFor(c, key);
    const byText = new Map<string, MemoryEntry[]>();
    for (const r of rows) { const k = normText(r.text); byText.set(k, [...(byText.get(k) ?? []), r]); }
    const inFile = new Set<string>(); const seen = new Set<string>();
    for (const f of parseFacts(doc.body, doc.bodyLine)) {
      const k = normText(f.text);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const match = byText.get(k);
      if (match) {
        for (const r of match) inFile.add(r.id);
        const row = match.find((r) => isLive(r, at)) ?? match[0];
        const patch: Partial<MemoryEntry> = {};
        if (f.expires && dateOf(row.expiresAt) !== f.expires) patch.expiresAt = endOfDate(f.expires);
        if (f.source !== undefined && !sameSource(row.source, f.source)) patch.source = { ...parseSourceLabel(f.source), at: row.source.at };
        if (Object.keys(patch).length) { store.saveMemory({ ...row, ...patch }); store.audit("owner", "memory.file.edit", `${clip(row.text)}${patch.expiresAt ? ` (expires ${f.expires})` : ""}${patch.source ? ` (source ${f.source})` : ""}`); }
      } else {
        if (f.expires && f.expires < today) continue; // already expired when typed
        const src = { ...parseSourceLabel(f.source), at };
        const row = store.saveMemory({
          id: id("mem"), scope: type === "room" ? "shared" : "private", roomId: room?.id, ownerAgentId: type === "agent" ? name : undefined,
          text: f.text, sourceAgentId: src.kind === "agent" ? src.agentId ?? "owner" : "owner", confidence: 1, createdAt: at, source: src,
          expiresAt: f.expires ? endOfDate(f.expires) : expiryFrom(at, ttl.fact), memKind: "fact",
        });
        inFile.add(row.id);
        store.audit("owner", "memory.file.add", clip(row.text));
      }
    }
    // Facts that were in the file when we last wrote it and aren't now: the owner took them out.
    for (const rid of prev?.ids ?? []) {
      if (inFile.has(rid)) continue;
      const row = store.getMemory(rid);
      if (row) { store.deleteMemory(rid); store.audit("owner", "memory.file.remove", clip(row.text)); }
    }
    this.setState(key, { hash: h, ids: [...inFile] });
  }

  // ---------------------------------------------------------------- export (AC3)

  /** Rooms an agent is in: its direct-message room, and every room whose ROOM.md roster names it (a room with no roster includes everyone). */
  private roomsOf(agentId: string): Set<string> {
    const c = this.d.control(); const out = new Set<string>();
    for (const r of this.d.store.listRooms()) {
      if (r.dmAgentId) { if (r.dmAgentId === agentId) out.add(r.id); continue; }
      if (isStandingRoom(this.d.store, c, r.id)) continue; // 4.3: a standing room's facts are not exported into the agent's own context files
      const roster = c?.rosterFor(r.id);
      if (!roster || !roster.length || roster.includes(agentId)) out.add(r.id);
    }
    return out;
  }

  exportInfo(agents: AgentConfig[] = this.d.store.listAgents()): MemoryExportInfo[] { return agents.map((a) => this.exporter.info(a)); }
  /** Export now for one agent (or all). */
  exportNow(agentId?: string): ExportResult[] {
    const agents = this.d.store.listAgents().filter((a) => !agentId || a.id === agentId);
    return agents.map((a) => this.exporter.sync(a));
  }
}
