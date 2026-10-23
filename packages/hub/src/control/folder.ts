import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ControlCommit, ControlNotice, ControlStatus, ServerEvent } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { buildTaskContext, type TaskContextInput } from "./context.js";
import { scrubPersona } from "../persona/block.js"; // 3.2
import { ControlGit } from "./git.js";
import { analyzeFolder, checkFile, walk, type Analysis, type FileResult } from "./lint.js";
import { editFrontMatter, seqNode } from "./parse.js";
import { agentLevel } from "./permissions.js";
import { SENSITIVE, classify, todayString, type FileMeta, type Level } from "./schema.js";
import { buildSnapshot, effectivePermissions, emptySnapshot, type ControlSnapshot } from "./snapshot.js";
import {
  agentFromFiles, agentsMd, desiredLevel, managedRule, normalizeAgent, patchPolicy, patchRoom, patchSoul, patchTools,
  policyMd, roomMd, roomSlug, soulMd, storeClass, toolNames, toolsMd, topicFromBody, userMd,
} from "./storemap.js";

/** `$AGENT_ROOM_HOME`, or `~/Agent Room` (CONTROL.md section 1; D3). */
export const defaultControlRoot = () => process.env.AGENT_ROOM_HOME || join(homedir(), "Agent Room");

export interface ControlOptions {
  /** Wait after the last file event before reading the folder. */
  debounceMs?: number;
  /** The git binary; defaults to $AGENT_ROOM_GIT or `git`. */
  gitBin?: string;
  /** Name written to USER.md the first time. Defaults to $AGENT_ROOM_OWNER. */
  ownerName?: string;
  /** Watch the folder with fs.watch. Off in tests that drive changes by hand. */
  watch?: boolean;
  /** Today as YYYY-MM-DD (for expiry checks). */
  today?: () => string;
  log?: (message: string) => void;
}

const sha = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");
const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * The control folder: Markdown files that steer the hub (CONTROL.md). This class keeps them and the Store in
 * step in both directions, commits every change to git, and holds the last good copy of any file that
 * fails validation.
 */
export class ControlFolder {
  readonly root: string;
  readonly git: ControlGit;
  private opts: Required<Pick<ControlOptions, "debounceMs" | "watch">> & ControlOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private good = new Map<string, FileResult>();
  private seen = new Map<string, string>();
  private snap: ControlSnapshot = emptySnapshot();
  private notices: ControlNotice[] = [];
  private lintResult: { blocks: ControlNotice[]; flags: ControlNotice[] } = { blocks: [], flags: [] };
  private lastLoad: Date | null = null;
  private applying = false;
  private gitOn = false;
  private started = false;
  private roomSlugs = new Map<string, string>();
  /** Store changes whose file write is still queued. The Store is newer than the files for these, so a load must not overwrite them. */
  private pending = new Map<string, number>();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private dayTimer?: NodeJS.Timeout;
  private loadedDay = "";

  constructor(root: string | undefined, private store: Store, opts: ControlOptions = {}) {
    this.root = resolve(root ?? defaultControlRoot());
    this.opts = { debounceMs: 300, watch: true, ...opts };
    this.git = new ControlGit(this.root, opts.gitBin);
  }

  private today() { return this.opts.today?.() ?? todayString(); }
  private log(m: string) { (this.opts.log ?? ((x: string) => console.warn(`[control] ${x}`)))(m); }

  /** Run jobs one at a time so file writes, commits and loads never interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }
  /** Resolves when every queued job is done. */
  async idle(): Promise<void> {
    let q: Promise<unknown>;
    do { q = this.queue; await q; } while (q !== this.queue);
  }

  // ---------------------------------------------------------------- start up

  /**
   * Create the layout and git repository, generate any control file that doesn't exist yet from the Store
   * (never overwriting one that does), commit, and load everything.
   */
  init(): Promise<void> {
    return this.enqueue(async () => {
      for (const d of ["agents", "rooms", "goals", "playbooks", "Library"]) mkdirSync(join(this.root, d), { recursive: true });
      this.git.ensureIgnore();
      this.gitOn = await this.git.isAvailable();
      const fresh = this.gitOn ? await this.git.init() : false;
      // Edits made while the hub was off belong to the owner.
      if (this.gitOn) {
        for (const p of await this.git.pending()) {
          if (p === ".gitignore" || "ignored" in classify(p)) continue;
          await this.git.commit([p], `Edit ${p} (made while Agent Room was closed)`, "owner");
        }
      }
      const created = this.generateMissing();
      if (this.gitOn && (created.length || fresh)) {
        await this.git.commit([...created, ".gitignore"], fresh ? "Create the control folder from the current settings" : `Add missing control files: ${created.join(", ")}`, "hub");
      }
      this.seen = this.hashAll();
      await this.loadNow({ initial: true });
    });
  }

  /** Begin watching the folder and the Store. Call after init(). */
  start() {
    if (this.started) return;
    this.started = true;
    this.store.on("event", this.onStoreEvent);
    if (this.opts.watch) {
      try {
        this.watcher = watch(this.root, { recursive: true }, (_evt, filename) => {
          if (!filename) return;
          const rel = String(filename).split(sep).join("/");
          if (rel === ".git" || rel.startsWith(".git/") || "ignored" in classify(rel)) return;
          this.schedule();
        });
        this.watcher.on("error", (e) => this.log(`watcher stopped: ${(e as Error).message}`));
      } catch (e) { this.log(`can't watch ${this.root}: ${(e as Error).message}`); }
    }
    this.dayTimer = setInterval(() => {
      if (this.loadedDay && this.loadedDay !== this.today()) void this.enqueue(() => this.loadNow({ emit: true })).catch((e) => this.log(String(e)));
    }, 10 * 60_000);
    this.dayTimer.unref();
  }

  async close() {
    this.started = false;
    this.store.off("event", this.onStoreEvent);
    this.watcher?.close(); this.watcher = undefined;
    clearTimeout(this.timer); clearInterval(this.dayTimer);
    await this.idle();
  }

  // ---------------------------------------------------------------- reading

  snapshot(): ControlSnapshot { return this.snap; }

  /** Effective permission of each tool for an agent in a room (strictest layer wins). */
  effectivePermissions(agentId: string, roomSlugOrUndefined?: string): Record<string, Level> {
    const a = this.store.getAgent(agentId);
    const fallback = a ? Object.fromEntries(toolNames(a).map((t) => [t, desiredLevel(a, t)])) : undefined;
    return effectivePermissions(this.snap, agentId, roomSlugOrUndefined, { today: this.today(), fallback });
  }

  /** The folder name of a room in the control folder (same slug the Library uses). */
  slugFor(roomId: string): string | undefined {
    const r = this.store.getRoom(roomId);
    return r && !r.dmAgentId ? roomSlug(r) : undefined;
  }

  /** Who ROOM.md says is in the room. Undefined when the room has no ROOM.md (everyone). */
  rosterFor(roomId: string): string[] | undefined {
    const slug = this.slugFor(roomId);
    return slug ? this.snap.rooms[slug]?.room?.fm.roster : undefined;
  }

  /** Build the context for one task from the layers that apply. See context.ts. */
  contextFor(input: Omit<TaskContextInput, "control">): string {
    return buildTaskContext({ ...input, control: this.snap });
  }

  status(): ControlStatus {
    return { root: this.root, git: this.gitOn, lastLoad: this.lastLoad?.toISOString() ?? null, notices: this.notices, lint: this.lintResult };
  }

  /** Lint what is on disk right now. */
  lint() {
    const a = analyzeFolder(this.root, { today: this.today() });
    return { blocks: a.blocks, flags: a.flags };
  }

  history(path?: string): Promise<ControlCommit[]> {
    if (path !== undefined) {
      const p = path.replace(/\\/g, "/");
      if (!p || p.startsWith("/") || p.startsWith("-") || p.split("/").includes("..") || p.includes("\0")) return Promise.reject(new Error("That path isn't inside the control folder."));
      return this.git.history(p);
    }
    return this.git.history();
  }

  /** Undo a commit with a new commit, then load the result. */
  revert(commit: string): Promise<{ commit: string; files: string[] }> {
    return this.enqueue(async () => {
      const r = await this.git.revert(commit, "owner");
      this.seen = this.hashAll();
      await this.loadNow({ emit: true, changed: r.files });
      return r;
    });
  }

  /** Re-read the folder now (also what the watcher does after its debounce). */
  load(): Promise<void> { return this.enqueue(() => this.loadNow({ emit: true })); }

  // ---------------------------------------------------------------- 1.3 discovery

  /**
   * 1.3: write what an agent's platform can reach into its TOOLS.md `platform` block (and the `discovered` date).
   * Only that block changes: the owner's `room_allows` and `runtime` and the notes stay. One commit by the hub, and only
   * when the lists changed. A TOOLS.md that has a problem is left alone (the owner is told by the linter, not twice).
   */
  setPlatform(agentId: string, platform: { connectors: string[]; data_sources: string[]; skills: string[]; tools: string[] }): Promise<"written" | "unchanged" | "skipped"> {
    return this.enqueue(async () => {
      if (!AGENT_ID.test(agentId)) return "skipped";
      const rel = `agents/${agentId}/TOOLS.md`;
      if (!this.exists(rel)) {
        if (!this.store.getAgent(agentId)) return "skipped";
        this.bump(`agent:${agentId}`, 1);
        await this.syncAgent(agentId); // writes SOUL.md, TOOLS.md and the policy lines for an agent that is new to the folder
        if (!this.exists(rel)) return "skipped";
      }
      const f = checkFile(rel, { kind: "tools", agent: agentId }, this.read(rel));
      if (f.blocks.length) return "skipped";
      const today = this.today();
      const next = editFrontMatter(f.text, (doc) => {
        let changed = false;
        for (const [k, v] of Object.entries(platform)) {
          const cur = (doc.getIn(["platform", k]) as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? [];
          if (JSON.stringify(cur) !== JSON.stringify(v)) { doc.setIn(["platform", k], seqNode(doc, v)); changed = true; }
        }
        if (changed) { doc.set("discovered", today); doc.set("updated", today); doc.set("updated_by", "hub"); }
      });
      if (next === f.text) return "unchanged";
      this.write(rel, next);
      await this.commit([rel], `Discovery: what ${agentId} can reach`, "hub");
      await this.loadNow({ emit: true, changed: [rel] });
      return "written";
    });
  }

  // ---------------------------------------------------------------- 2.1 retros

  /**
   * 2.1: change control files the orchestrator owns (LESSONS.md, playbooks) as ONE commit. `build` runs inside the
   * queue and sees the files as they are now (so an owner's edit made a moment ago is never overwritten); it returns the
   * files to write and, optionally, `done`, which runs once they are on disk (the retro saves its database rows there).
   * Returns the paths written. Nothing is written or committed when `build` returns no files.
   */
  update(
    build: (read: (rel: string) => string | undefined) => { files: { rel: string; text: string }[]; done?: () => void } | Promise<{ files: { rel: string; text: string }[]; done?: () => void }>,
    message: string, writer = "orchestrator",
  ): Promise<string[]> {
    return this.enqueue(async () => {
      const plan = await build((rel) => (this.exists(rel) ? this.read(rel) : undefined));
      const rels = plan.files.map((f) => f.rel);
      for (const rel of rels) {
        // An owner's edit that the watcher hasn't committed yet is theirs: commit it first so the history says who wrote what.
        if (this.exists(rel) && this.seen.get(rel) !== sha(this.read(rel))) {
          this.seen.set(rel, sha(this.read(rel)));
          await this.commit([rel], `Edit ${rel} in an editor`, "owner");
        }
      }
      for (const f of plan.files) this.write(f.rel, f.text);
      plan.done?.();
      if (!rels.length) return [];
      await this.commit(rels, message, writer);
      await this.loadNow({ emit: true, changed: rels });
      return rels;
    });
  }

  // ---------------------------------------------------------------- files

  private abs(rel: string) {
    const p = resolve(this.root, rel);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error(`refusing to write outside the control folder: ${rel}`);
    return p;
  }
  private exists(rel: string) { return existsSync(this.abs(rel)); }
  private read(rel: string) { return readFileSync(this.abs(rel), "utf8"); }
  /** Write through a hidden temp file so an editor never sees half a file. Records the hash so the watcher ignores our own write. */
  private write(rel: string, text: string) {
    if (/(^|\/)RESUME\.md$/.test(rel)) text = scrubPersona(text); // 3.2: personas present, résumés prove: no persona text in a résumé
    const p = this.abs(rel);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = join(dirname(p), `.${rel.split("/").pop()}.tmp-${process.pid}`);
    writeFileSync(tmp, text);
    renameSync(tmp, p);
    this.seen.set(rel, sha(text));
  }

  private hashAll(): Map<string, string> {
    const m = new Map<string, string>();
    for (const rel of walk(this.root)) {
      if ("ignored" in classify(rel)) continue;
      try { if (statSync(this.abs(rel)).isFile()) m.set(rel, sha(readFileSync(this.abs(rel)))); } catch { /* vanished */ }
    }
    return m;
  }

  private async commit(paths: string[], message: string, writer: string) {
    if (!this.gitOn || !paths.length) return;
    try { await this.git.commit(paths, message, writer); } catch (e) { this.log(`commit failed (${message}): ${(e as Error).message}`); }
  }

  /** Create every control file the Store implies and the folder lacks. Returns the paths created. */
  private generateMissing(): string[] {
    const made: string[] = [];
    const put = (rel: string, text: () => string) => { if (!this.exists(rel)) { this.write(rel, text()); made.push(rel); } };
    const agents = this.store.listAgents().filter((a) => AGENT_ID.test(a.id));
    const owner = this.opts.ownerName ?? process.env.AGENT_ROOM_OWNER ?? "Owner";
    put("AGENTS.md", () => agentsMd());
    put("USER.md", () => userMd(owner, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"));
    put("POLICY.md", () => policyMd(agents));
    for (const a of agents) {
      put(`agents/${a.id}/SOUL.md`, () => soulMd(a));
      put(`agents/${a.id}/TOOLS.md`, () => toolsMd(a));
    }
    const taken = new Set<string>();
    for (const r of this.store.listRooms()) {
      if (r.dmAgentId) continue;
      const slug = roomSlug(r);
      this.roomSlugs.set(r.id, slug);
      if (taken.has(slug)) continue;
      taken.add(slug);
      put(`rooms/${slug}/ROOM.md`, () => roomMd(r, agents.map((a) => a.id)));
    }
    return made;
  }

  // ---------------------------------------------------------------- loading (file -> app)

  private async loadNow(o: { initial?: boolean; emit?: boolean; changed?: string[]; analysis?: Analysis } = {}) {
    const analysis = o.analysis ?? analyzeFolder(this.root, { today: this.today() });
    for (const [rel, r] of analysis.files) if (r.fm) this.good.set(rel, r);
    for (const rel of [...this.good.keys()]) if (!analysis.files.has(rel)) this.good.delete(rel);

    const notices: ControlNotice[] = [];
    for (const r of analysis.files.values()) {
      if (!r.blocks.length) continue;
      const b = r.blocks[0];
      notices.push({ ...b, message: `${b.message}. ${this.good.has(r.rel) ? "Keeping the last good version." : "This file isn't loaded."}` });
    }
    notices.push(...analysis.flags);

    this.snap = buildSnapshot(this.good.values());
    this.applyToStore(o.initial ? undefined : (o.changed ?? []));

    const before = JSON.stringify(this.notices);
    this.notices = notices;
    this.lintResult = { blocks: analysis.blocks, flags: analysis.flags };
    this.lastLoad = new Date(); this.loadedDay = this.today();
    if (o.emit || before !== JSON.stringify(notices)) {
      if (!o.initial) this.emitControl(o.changed ?? [], notices);
    }
    // 2.5: tell the memory keeper what was just loaded (undefined: everything, at start up).
    for (const fn of this.loadListeners) { try { fn(o.initial ? undefined : (o.changed ?? [])); } catch (e) { this.log(`load listener failed: ${(e as Error).message}`); } }
  }

  // ---------------------------------------------------------------- 2.5 memory files

  private loadListeners = new Set<(changed: string[] | undefined) => void>();
  /** 2.5: be told after every load which files changed (`undefined` after start up, `[]` after a reload that may not have changed any). */
  onLoad(fn: (changed: string[] | undefined) => void): () => void { this.loadListeners.add(fn); return () => { this.loadListeners.delete(fn); }; }

  /**
   * 2.5: change one control file on behalf of the module that owns its content (memory). `build` gets the file's text, or
   * undefined when there is none, and returns the new text, or undefined for no change. A file the linter blocks is left
   * alone (the owner is told by the linter). One commit by `writer`, then the new file is loaded like any other change.
   */
  writeManaged(rel: string, build: (current: string | undefined) => string | undefined, message: string, writer: string): Promise<"written" | "unchanged" | "skipped"> {
    return this.enqueue(async () => {
      const c = classify(rel);
      if (!("meta" in c)) return "skipped";
      const cur = this.exists(rel) ? this.read(rel) : undefined;
      if (cur !== undefined && checkFile(rel, c.meta, cur).blocks.length) return "skipped";
      const next = build(cur);
      if (next === undefined || next === cur) return "unchanged";
      this.write(rel, next);
      await this.commit([rel], message, writer);
      await this.loadNow({ emit: true, changed: [rel] });
      return "written";
    });
  }

  private emitControl(changed: string[], notices: ControlNotice[]) {
    this.store.emit("event", { type: "control", at: Date.now(), changed, notices } satisfies ServerEvent);
  }

  /**
   * Bring the Store in line with the loaded files. A file for an agent or room the Store doesn't have creates it,
   * but only when that file just changed (so an agent the owner deleted in the app doesn't come back at the next load).
   */
  private applyToStore(changed: string[] | undefined) {
    const touched = (prefix: string) => !!changed?.some((c) => c.startsWith(prefix));
    this.applying = true;
    try {
      for (const [id, docs] of Object.entries(this.snap.agents)) {
        const cur = this.store.getAgent(id);
        if (this.pending.has(`agent:${id}`)) continue; // an app change to this agent is about to be written to its files
        if (!cur && !touched(`agents/${id}/`)) continue;
        const next = agentFromFiles(cur, id, docs.soul?.fm, docs.tools?.fm, this.snap.policy?.fm, this.today());
        if (!next) continue;
        if (!cur || normalizeAgent(cur) !== normalizeAgent(next)) {
          this.store.saveAgent(next);
          this.store.audit("hub", cur ? "control.agent.updated" : "control.agent.created", `${id} from the control files`);
        }
      }
      const rooms = this.store.listRooms().filter((r) => !r.dmAgentId);
      for (const [slug, docs] of Object.entries(this.snap.rooms)) {
        if (!docs.room) continue;
        const cur = rooms.find((r) => roomSlug(r) === slug);
        if (cur && this.pending.has(`room:${cur.id}`)) continue;
        const topic = topicFromBody(docs.room.body);
        if (!cur) {
          if (!touched(`rooms/${slug}/`)) continue;
          const made = this.store.createRoom(slug, { topic: topic || undefined });
          this.roomSlugs.set(made.id, slug);
          this.store.audit("hub", "control.room.created", slug);
        } else if ((cur.topic ?? "") !== topic) {
          this.store.saveRoom({ ...cur, topic: topic || undefined });
          this.store.audit("hub", "control.room.updated", slug);
        }
      }
    } finally { this.applying = false; }
  }

  // ---------------------------------------------------------------- watching (file -> app, with commit)

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.enqueue(() => this.onDiskChange()).catch((e) => this.log(`reload failed: ${(e as Error).message}`)); }, this.opts.debounceMs);
    this.timer.unref?.();
  }

  /** Validate, commit (one commit per changed file, by the owner) and load whatever changed on disk. */
  private async onDiskChange() {
    const now = this.hashAll();
    const changed = [...new Set([...now.keys(), ...this.seen.keys()])].filter((p) => now.get(p) !== this.seen.get(p)).sort();
    if (!changed.length) return;
    const analysis = analyzeFolder(this.root, { today: this.today() });
    for (const rel of changed) {
      const op = !this.seen.has(rel) ? "Add" : !now.has(rel) ? "Delete" : "Edit";
      const problem = analysis.files.get(rel)?.blocks[0];
      await this.commit([rel], `${op} ${rel} in an editor${problem ? ` (not loaded: ${problem.message})` : ""}`, "owner");
    }
    this.seen = now;
    this.store.audit("owner", "control.edited", changed.slice(0, 20).join(", "));
    await this.loadNow({ emit: true, changed, analysis });
  }

  // ---------------------------------------------------------------- Store -> files

  private onStoreEvent = (e: ServerEvent) => {
    if (this.applying || !this.started) return;
    if (e.type === "agent") { const id = e.agent.id; this.bump(`agent:${id}`, 1); void this.enqueue(() => this.syncAgent(id)).catch((err) => this.log(`couldn't write ${id}: ${(err as Error).message}`)); }
    if (e.type === "room" && !e.room.dmAgentId) { const id = e.room.id; this.bump(`room:${id}`, 1); void this.enqueue(() => this.syncRoom(id)).catch((err) => this.log(`couldn't write room: ${(err as Error).message}`)); }
  };

  private bump(key: string, by: number) {
    const n = (this.pending.get(key) ?? 0) + by;
    if (n > 0) this.pending.set(key, n); else this.pending.delete(key);
  }

  private problemNotice(file: string, line: number | undefined, message: string) {
    this.notices = [...this.notices.filter((n) => !(n.file === file && n.message === message)), { level: "block", file, line, message }];
    this.emitControl([], this.notices);
  }

  /** Write an agent's current settings to its files, as one commit by the owner. */
  private async syncAgent(id: string) {
    this.bump(`agent:${id}`, -1);
    const a = this.store.getAgent(id);
    if (!a || !AGENT_ID.test(id)) return;
    const today = this.today();
    const soulRel = `agents/${id}/SOUL.md`, toolsRel = `agents/${id}/TOOLS.md`, polRel = "POLICY.md";
    const created: string[] = [];
    const ensure = (rel: string, text: () => string) => { if (!this.exists(rel)) { this.write(rel, text()); created.push(rel); } };
    ensure(soulRel, () => soulMd(a, "owner", today));
    ensure(toolsRel, () => toolsMd(a, "owner", today));
    ensure(polRel, () => policyMd(this.store.listAgents().filter((x) => AGENT_ID.test(x.id)), "owner", today));

    const metas: Record<string, FileMeta> = { [soulRel]: { kind: "soul", agent: id }, [toolsRel]: { kind: "tools", agent: id }, [polRel]: { kind: "policy" } };
    const files = Object.fromEntries(Object.keys(metas).map((rel) => [rel, checkFile(rel, metas[rel], this.read(rel))]));
    const broken = Object.values(files).find((f) => f.blocks.length);
    if (broken) {
      await this.commit(created, `Add ${a.name} (from the app)`, "owner");
      this.problemNotice(broken.rel, broken.blocks[0].line, `Your change to ${a.name} wasn't saved to this file because the file has a problem: ${broken.blocks[0].message}. Fix the file, then try again.`);
      return;
    }
    const soul = files[soulRel], tools = files[toolsRel], policy = files[polRel];
    const view = agentFromFiles(a, id, soul.fm as never, tools.fm as never, policy.fm as never, today);
    const parts: string[] = [];
    const touched: string[] = [];
    if (!view || normalizeAgent(view) !== normalizeAgent(a)) {
      const levels: Record<string, Level> = {};
      const ops: { id: string; rule: Record<string, unknown> | null }[] = [];
      for (const tool of toolNames(a, tools.fm as never)) {
        const want = desiredLevel(a, tool);
        const cur = agentLevel(policy.fm as never, tools.fm as never, id, tool, today);
        const m = managedRule(policy.fm as never, a, tool, want, today);
        ops.push({ id: m.id, rule: m.rule });
        if (storeClass(cur, tool) !== storeClass(want, tool)) {
          levels[tool] = want;
          parts.push(`${tool} ${want === "off" ? "off" : want === "ask" ? "asks first" : SENSITIVE_LABEL(tool)}`);
        }
      }
      if (view && view.name !== a.name) parts.push(`renamed to ${a.name}`);
      if (view && view.color.toLowerCase() !== a.color.toLowerCase()) parts.push("new colour");
      if (view && (view.adapter !== a.adapter || view.provider !== a.provider || view.enabled !== a.enabled)) parts.push(a.enabled === view.enabled ? "runtime changed" : a.enabled ? "turned on" : "turned off");
      if (view && (view.settings.model ?? "") !== (a.settings.model ?? "")) parts.push(`model ${a.settings.model || "default"}`);
      if (view && (view.settings.binary ?? "") !== (a.settings.binary ?? "")) parts.push("program path changed");
      if (view && stable(view.profiles ?? []) !== stable(a.profiles ?? [])) parts.push("profiles changed");
      const next: Record<string, string> = {
        [toolsRel]: patchTools(tools.text, a, levels, "owner", today),
        [soulRel]: patchSoul(soul.text, a, "owner", today),
        [polRel]: patchPolicy(policy.text, ops, "owner", today),
      };
      for (const [rel, text] of Object.entries(next)) if (text !== files[rel].text) { this.write(rel, text); touched.push(rel); }
    }
    if (touched.length || created.length) {
      const what = parts.length ? parts.join(", ") : touched.length ? "settings" : "";
      await this.commit([...new Set([...created, ...touched])], created.length && !touched.length ? `Add ${a.name} (from the app)` : `Change ${a.name}: ${what} (from the app)`, "owner");
    }
    // The files may grant less than the app asked for (the platform or POLICY.md can be stricter). Settle on what they say.
    await this.loadNow({});
  }

  /** Write a room's name and topic to its ROOM.md. A renamed room moves its folder. */
  private async syncRoom(roomId: string) {
    this.bump(`room:${roomId}`, -1);
    const r = this.store.getRoom(roomId);
    if (!r || r.dmAgentId) return;
    const slug = roomSlug(r); const old = this.roomSlugs.get(roomId);
    const today = this.today();
    const rel = `rooms/${slug}/ROOM.md`;
    const moved: string[] = [];
    if (old && old !== slug && existsSync(this.abs(`rooms/${old}`)) && !existsSync(this.abs(`rooms/${slug}`))) {
      renameSync(this.abs(`rooms/${old}`), this.abs(`rooms/${slug}`));
      moved.push(`rooms/${old}`, `rooms/${slug}`);
      this.seen = this.hashAll();
    }
    this.roomSlugs.set(roomId, slug);
    if (!this.exists(rel)) {
      this.write(rel, roomMd(r, this.store.listAgents().map((a) => a.id), "owner", today));
      await this.commit([rel, ...moved], `Add room ${r.name} (from the app)`, "owner");
    } else {
      const f = checkFile(rel, { kind: "room", room: slug }, this.read(rel));
      if (f.blocks.length) {
        this.problemNotice(rel, f.blocks[0].line, `Your change to #${r.name} wasn't saved to this file because the file has a problem: ${f.blocks[0].message}. Fix the file, then try again.`);
        if (moved.length) await this.commit(moved, `Rename room to ${r.name} (from the app)`, "owner");
        return;
      }
      const next = patchRoom(f.text, r, "owner", today);
      if (next !== f.text) this.write(rel, next);
      if (next !== f.text || moved.length) await this.commit([rel, ...moved], moved.length ? `Rename room to ${r.name} (from the app)` : `Change the topic of #${r.name} (from the app)`, "owner");
    }
    await this.loadNow({});
  }
}

const stable = (v: unknown) => JSON.stringify(v);
const SENSITIVE_LABEL = (tool: string) => (SENSITIVE.has(tool) ? "runs without asking" : "on");
