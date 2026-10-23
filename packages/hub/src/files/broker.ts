import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Approval, FolderGrant, FolderGrantUpdate, WriteProposal, WriteProposalFile } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { Approvals } from "../orchestrator/approvals.js";
import { id, now } from "../util.js";
import { tooLargeToDiff, unifiedDiff } from "./diff.js";
import {
  GrantRefused, MAX_REL_PATH, PathDenied, assertPlainPath, inspectGrantRoot, isInside, resolveInGrant, touchesGit, type GrantRootOptions,
} from "./paths.js";
import { NOT_TEXT, isBinaryOrInvalid, isWellFormedText, withoutPartialTail } from "./text.js";
import type { RoomGate } from "../rooms/rules.js"; // 4.3

const GRANTS_KEY = "folder_grants";
const PROPOSALS_KEY = "write_proposals";
const MAX_PROPOSALS = 500;
const MAX_PENDING = 50;
/** One agent cannot fill the owner's approval queue: it gets this many waiting writes, the whole hub gets MAX_PENDING. */
const MAX_PENDING_PER_AGENT = 20;
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_EXISTING_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
const APPROVAL_DETAIL_MAX = 8000;
const DIFF_STORE_MAX = 100_000;
/** A task's whole write-back is one approval, so its diff may be longer than one file's. */
const TASK_DIFF_MAX = 1_000_000;
const MAX_TASK_FILES = 200;
/** Settled proposals beyond the newest this many keep their metadata but not their diff, so the store stays small. */
const KEEP_DIFFS = 100;
const GENERIC_PATH = "that path is not allowed for writing here";
const NOT_APPLIED = "not applied";
/** What resolveInGrant says when the answer depends on the disk (links), as opposed to how the path is spelled. */
const STATE_DENIAL = /resolves outside|cannot be resolved|cannot be accessed/;

export type Denied = { ok: false; reason: string };
export interface ListEntry { name: string; type: "file" | "dir" | "symlink" | "other"; size?: number }
export type ListResult = { ok: true; grantId: string; entries: ListEntry[]; truncated: boolean } | Denied;
export type ReadResult =
  | { ok: true; grantId: string; binary: false; content: string; bytes: number; truncated: boolean }
  | { ok: true; grantId: string; binary: true; note: string; bytes: number }
  | Denied;
export type ProposeResult = { ok: true; proposal: WriteProposal } | Denied;
/** One file of a task's accepted work. `content` null = the task deleted it. */
export interface TaskChange { relPath: string; content: Buffer | null }
export type TaskProposeResult = { ok: true; proposal: WriteProposal; skipped: { relPath: string; reason: string }[] } | { ok: true; proposal?: undefined; none: true; skipped: { relPath: string; reason: string }[] } | Denied;

export interface BrokerOptions {
  /** Test seam: the home folder (default: the real one) and the system folders the grant check protects. */
  home?: string;
  systemRoots?: string[];
  /** Paths that may not be granted besides the usual ones, with the words shown to the owner (the control folder's version history). */
  extraProtected?: () => { path: string; because: string }[];
  /** 4.3: what a room's ROOM.md limits (the folder grants its goals and file tools may use, and whether the filesystem tool is off there). */
  rooms?: RoomGate;
}

/** What the hub holds in memory for a pending proposal: the exact bytes the owner is approving, and what they replace. */
interface PendingItem { relPath: string; content: Buffer | null; old: Buffer | null }

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
// Long enough for any path an agent may send (MAX_REL_PATH), so audited paths are never cut.
const short = (s: string, n = MAX_REL_PATH) => (s.length > n ? s.slice(0, n) + "..." : s);
const q = (s: string) => JSON.stringify(short(s));

/**
 * The only code that touches the owner's files on behalf of agents. Every call is checked against
 * the agent's filesystem tool switch and the folder grants, and every outcome is audited.
 * Reads are immediate. Writes become proposals; the file changes only after the owner approves.
 */
export class FileBroker {
  /** New file contents waiting for approval. Never persisted, so a restart cannot apply a stale write. */
  private pendingContent = new Map<string, PendingItem[]>();

  constructor(private store: Store, private approvals: Approvals, private opts: BrokerOptions = {}) {
    this.expireStale();
  }

  // ---------- grants (owner-managed)

  listGrants(): FolderGrant[] { return this.store.getKV<FolderGrant[]>(GRANTS_KEY, []); }
  grant(grantId: string): FolderGrant | undefined { return this.listGrants().find((g) => g.id === grantId); }

  private rootOptions(): GrantRootOptions {
    const dbFile = this.store.db.name;
    const dataDir = dbFile && dbFile !== ":memory:" ? dirname(resolve(dbFile)) : undefined;
    return { dataDir, home: this.opts.home, systemRoots: this.opts.systemRoots, extraProtected: this.opts.extraProtected?.() };
  }

  /** What would happen if this folder were granted: fine, needs the owner's override, or never. Nothing is stored or audited. */
  checkFolder(path: string): { ok: true; root: string; protected: boolean; because?: string } | { ok: false; error: string; canForce: boolean } {
    try {
      const r = inspectGrantRoot(path, this.rootOptions());
      return { ok: true, root: r.root, protected: !!r.because, because: r.because };
    } catch (e) {
      if (e instanceof PathDenied) return { ok: false, error: e.message, canForce: e instanceof GrantRefused ? e.canForce : false };
      throw e;
    }
  }

  /**
   * Throws PathDenied (GrantRefused for a protected folder) if the folder may not be granted. Stores the realpath.
   * A protected folder (credentials, settings, system, hub data) is granted only with `force` and a written reason, and that is audited.
   */
  addGrant(input: { path: string; label?: string; roomId?: string; agentId: string; read: boolean; write: boolean; force?: boolean; reason?: string }, actor = "owner"): FolderGrant {
    if (!input.read && !input.write) throw new PathDenied("a grant needs read or write access");
    if (!input.agentId) throw new PathDenied("a grant needs an agent id (or *)");
    const { root, because } = inspectGrantRoot(input.path, this.rootOptions());
    let override: FolderGrant["override"];
    if (because) {
      if (!input.force) throw new GrantRefused(`${because}, so it cannot be granted without an explicit override`, true, because);
      const reason = (input.reason ?? "").trim();
      if (reason.length < 8) throw new GrantRefused("an override needs a reason: say in a sentence why this folder should be shared", true, because);
      override = { reason: reason.slice(0, 300), at: now(), because };
    }
    const g: FolderGrant = {
      id: id("grant"), path: root, label: input.label, roomId: input.roomId || undefined,
      agentId: input.agentId, read: input.read, write: input.write, createdAt: now(), ...(override ? { override } : {}),
    };
    this.store.setKV(GRANTS_KEY, [...this.listGrants(), g]);
    this.store.audit(actor, "grant.added", `${g.id} ${q(g.path)} agent=${g.agentId} room=${g.roomId ?? "*"} read=${g.read} write=${g.write}`);
    if (override) this.store.audit(actor, "grant.override", `${g.id} ${q(g.path)} protected: ${override.because}; reason: ${JSON.stringify(override.reason)}`);
    return g;
  }

  /** Change who a grant covers, what it allows, or its label. Never its path. Anything that waits on a write the grant no longer allows is cancelled. */
  updateGrant(grantId: string, patch: FolderGrantUpdate, actor = "owner"): FolderGrant | undefined {
    const all = this.listGrants();
    const cur = all.find((g) => g.id === grantId);
    if (!cur) return undefined;
    const next: FolderGrant = { ...cur };
    if (patch.label !== undefined) next.label = patch.label || undefined;
    if (patch.roomId !== undefined) next.roomId = patch.roomId || undefined;
    if (patch.agentId !== undefined) { if (!patch.agentId) throw new PathDenied("a grant needs an agent id (or *)"); next.agentId = patch.agentId; }
    if (patch.read !== undefined) next.read = patch.read;
    if (patch.write !== undefined) next.write = patch.write;
    if (!next.read && !next.write) throw new PathDenied("a grant needs read or write access");
    const changes: string[] = [];
    for (const k of ["label", "roomId", "agentId", "read", "write"] as const) if (next[k] !== cur[k]) changes.push(`${k}: ${JSON.stringify(cur[k] ?? null)} -> ${JSON.stringify(next[k] ?? null)}`);
    this.store.setKV(GRANTS_KEY, all.map((g) => (g.id === grantId ? next : g)));
    this.store.audit(actor, "grant.changed", `${grantId} ${q(next.path)} ${changes.join("; ") || "no change"}`);
    if (cur.write && !next.write) this.cancelPending(grantId, "the folder grant no longer allows writing");
    // Narrowing to another agent or room: a write that waits for an agent or room the grant no longer covers is settled now.
    else for (const p of this.pending().filter((x) => x.grantId === grantId && !this.covers(next, x.agentId, x.roomId))) {
      this.settle(p.id, "rejected", "the folder grant no longer covers this agent here", "system");
      if (p.approvalId) this.approvals.decide(p.approvalId, "expired", "system");
    }
    return next;
  }

  removeGrant(grantId: string, actor = "owner"): FolderGrant | undefined {
    const all = this.listGrants();
    const g = all.find((x) => x.id === grantId);
    if (g) {
      this.store.setKV(GRANTS_KEY, all.filter((x) => x.id !== grantId));
      this.store.audit(actor, "grant.removed", `${g.id} ${q(g.path)} agent=${g.agentId}`);
      this.cancelPending(grantId, "the folder grant was removed");
    }
    return g;
  }

  /** Writes waiting on a grant that just lost its write access are settled now, not left for the owner to approve into a refusal. */
  private cancelPending(grantId: string, why: string) {
    for (const p of this.pending().filter((x) => x.grantId === grantId)) {
      this.settle(p.id, "rejected", why, "system");
      if (p.approvalId) this.approvals.decide(p.approvalId, "expired", "system");
    }
  }

  /** Does this grant cover this agent in this room? (the same test grantsFor applies) */
  private covers(g: FolderGrant, agentId: string, roomId?: string): boolean {
    if (roomId && !this.roomAllows(g.id, roomId)) return false; // 4.3
    return (g.agentId === "*" || g.agentId === agentId) && (g.roomId === undefined || g.roomId === roomId);
  }

  /** 4.3: ROOM.md `folders` names the only grants a room's goals and file tools may use. No list, no limit. */
  roomAllows(grantId: string, roomId: string): boolean {
    const only = this.opts.rooms?.folders(roomId);
    return !only || only.includes(grantId);
  }

  /** Grants this agent may see from this room. Room grants narrow: no room, no room-scoped grant. */
  grantsFor(agentId: string, roomId?: string): FolderGrant[] {
    return this.listGrants().filter((g) => this.covers(g, agentId, roomId));
  }

  // ---------- agent operations

  list(agentId: string, roomId: string | undefined, relDir: string, grantId?: string): ListResult {
    const rel = relDir === "" ? "." : relDir;
    const auth = this.authorize(agentId, roomId, "list", rel, grantId);
    if (!auth.ok) return auth;
    try {
      const dir = resolveInGrant(auth.grant.path, rel);
      if (touchesGit(rel) || touchesGit(relative(realpathSync.native(auth.grant.path), dir))) return this.deny(agentId, "list", rel, "version-control internals (.git) are not available to agents");
      if (!lstatSync(dir).isDirectory()) return this.deny(agentId, "list", rel, "not a folder");
      const names = readdirSync(dir, { withFileTypes: true });
      const entries: ListEntry[] = names.slice(0, MAX_LIST_ENTRIES).map((d) => {
        const type = d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : d.isFile() ? "file" : "other";
        let size: number | undefined;
        if (type === "file") { try { size = lstatSync(join(dir, d.name)).size; } catch { /* vanished */ } }
        return { name: d.name, type, size } as ListEntry;
      }).sort((a, b) => a.name.localeCompare(b.name));
      this.store.audit(agentId, "file.list", `${auth.grant.id} ${q(rel)} (${entries.length} entries)`);
      return { ok: true, grantId: auth.grant.id, entries, truncated: names.length > MAX_LIST_ENTRIES };
    } catch (e) { return this.deny(agentId, "list", rel, this.why(e)); }
  }

  read(agentId: string, roomId: string | undefined, relPath: string, grantId?: string, maxBytes = 512_000): ReadResult {
    const auth = this.authorize(agentId, roomId, "read", relPath, grantId);
    if (!auth.ok) return auth;
    try {
      const file = resolveInGrant(auth.grant.path, relPath);
      if (touchesGit(relPath) || touchesGit(relative(realpathSync.native(auth.grant.path), file))) return this.deny(agentId, "read", relPath, "version-control internals (.git) are not available to agents");
      const got = this.readFile(file, maxBytes);
      if (got.kind !== "file") return this.deny(agentId, "read", relPath, got.kind === "missing" ? "no such file" : got.why === "hard link" ? "file has more than one hard link; not available to agents" : "not a regular file");
      // A read that stopped at the byte limit may end inside a character: judge the part we are returning, not the cut.
      const truncated = got.size > got.buf.length;
      const view = truncated ? withoutPartialTail(got.buf) : got.buf;
      if (isBinaryOrInvalid(view)) {
        this.store.audit(agentId, "file.read", `${auth.grant.id} ${q(relPath)} ${NOT_TEXT}, not returned (${got.size} bytes)`);
        return { ok: true, grantId: auth.grant.id, binary: true, bytes: got.size, note: `Not a text file (${NOT_TEXT}; ${got.size} bytes); content not returned.` };
      }
      this.store.audit(agentId, "file.read", `${auth.grant.id} ${q(relPath)} ${view.length}/${got.size} bytes${truncated ? " (truncated)" : ""}`);
      return { ok: true, grantId: auth.grant.id, binary: false, content: view.toString("utf8"), bytes: got.size, truncated };
    } catch (e) { return this.deny(agentId, "read", relPath, this.why(e)); }
  }

  /**
   * Save a pending proposal and ask the owner. Returns at once; the file changes only after approval.
   * On a write-only grant the agent learns nothing about the target: every refusal that depends on the file
   * (it exists, it is binary, it is identical, it is a symlink) is the same generic answer, and a write that
   * cannot be applied is still "created", with the real reason shown to the owner only.
   */
  proposeWrite(agentId: string, roomId: string | undefined, relPath: string, content: string, grantId?: string): ProposeResult {
    const auth = this.authorize(agentId, roomId, "write", relPath, grantId);
    if (!auth.ok) return auth;
    const grant = auth.grant;
    const writeOnly = !grant.read;
    try {
      const buf = Buffer.from(content, "utf8");
      if (buf.length > MAX_WRITE_BYTES) return this.deny(agentId, "write", relPath, `content larger than ${MAX_WRITE_BYTES} bytes`);
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(relPath)) return this.deny(agentId, "write", relPath, "control characters in a path are not allowed");
      if (relPath.endsWith("/") || relPath.endsWith("\\")) return this.deny(agentId, "write", relPath, "a file path cannot end with a slash");
      assertPlainPath(relPath);
      if (content.includes("\0")) return this.deny(agentId, "write", relPath, `${NOT_TEXT} content (NUL byte) cannot be written`);
      if (!isWellFormedText(content)) return this.deny(agentId, "write", relPath, `content is ${NOT_TEXT} (unpaired surrogate)`);
      const queued = this.pending();
      if (queued.length >= MAX_PENDING) return this.deny(agentId, "write", relPath, "too many writes are already waiting for the owner");
      if (queued.filter((x) => x.agentId === agentId).length >= MAX_PENDING_PER_AGENT) return this.deny(agentId, "write", relPath, `this agent already has ${MAX_PENDING_PER_AGENT} writes waiting for the owner; wait for a decision before proposing more`);
      let unappliable: string | undefined;
      let target: string, stateBlocked = false;
      try { target = resolveInGrant(grant.path, relPath); }
      catch (e) {
        // What a path resolves to depends on what is on the disk (a link out of the folder, a broken link). On a write-only grant that
        // must not be told to the agent: the proposal is taken like any other and the owner is shown why it cannot be applied.
        if (!(writeOnly && e instanceof PathDenied && STATE_DENIAL.test(e.message))) throw e;
        unappliable = e.message; stateBlocked = true;
        target = resolve(realpathSync.native(grant.path), relPath);
      }
      // Refusals that depend only on how the path is spelled are the same whatever is on the disk, so they may be told to the agent.
      const spelled = this.writeGuard(grant.path, relPath, target, true);
      if (spelled) return this.deny(agentId, "write", relPath, spelled, writeOnly ? GENERIC_PATH : spelled);
      const onDisk = stateBlocked ? null : this.writeGuard(grant.path, relPath, target);
      if (onDisk) {
        if (!writeOnly) return this.deny(agentId, "write", relPath, onDisk);
        unappliable ??= onDisk;
      }
      // What the owner sees and approves is the real location, not the spelling (symlinked folders) the agent chose.
      const shown = relative(realpathSync.native(grant.path), target);
      assertPlainPath(shown);

      let oldText: string | null = null, oldBuf: Buffer | null = null, baseSha: string | null = null;
      // A refusal for a reason that comes from the target file: a normal refusal, except on a write-only grant, where it must not be told.
      const targetProblem = (why: string): ProposeResult | undefined => {
        if (!writeOnly) return this.deny(agentId, "write", relPath, why);
        unappliable ??= why;
        return undefined;
      };
      // A path that resolved outside the folder is never opened, even to look.
      const cur = stateBlocked ? { kind: "missing" as const } : this.readFile(target, MAX_EXISTING_BYTES, true);
      if (cur.kind === "missing") { /* new file */ }
      else if (cur.kind === "notfile") { const r = targetProblem("target exists and is not a regular file"); if (r) return r; }
      else if (cur.size > MAX_EXISTING_BYTES) { const r = targetProblem("existing file is too large to diff"); if (r) return r; }
      else if (isBinaryOrInvalid(cur.buf)) { const r = targetProblem(`existing file is ${NOT_TEXT}`); if (r) return r; }
      else { oldText = cur.buf.toString("utf8"); oldBuf = cur.buf; baseSha = sha256(cur.buf); }
      const newSha = sha256(buf);
      if (baseSha === newSha) { const r = targetProblem("content is identical to the existing file; nothing to write"); if (r) return r; }

      // The owner must be able to read everything that will be written. unifiedDiff only returns a one-line
      // summary past MAX_DIFF_LINES, and a summary is not a diff: refuse, never let it stand in for one.
      if (!unappliable && tooLargeToDiff(oldText, content)) {
        const why = "the change is too large for the owner to review as a diff (over 5,000 lines on one side); propose smaller edits or split the file";
        if (!writeOnly) return this.deny(agentId, "write", relPath, why);
        unappliable = why;
      }
      const showNew = !unappliable || !tooLargeToDiff(null, content); // an unappliable write still shows the owner what was asked for
      let diff = unappliable ? (showNew ? unifiedDiff(shown, null, content) : "(the content is too large to show)\n") : unifiedDiff(shown, oldText, content);
      // Oversized diffs are refused rather than cut, for the same reason.
      if (diff.length > DIFF_STORE_MAX) {
        const why = `the change is too large for the owner to review (diff over ${DIFF_STORE_MAX} characters); propose smaller edits`;
        if (!writeOnly) return this.deny(agentId, "write", relPath, why);
        unappliable ??= why; diff = diff.slice(0, DIFF_STORE_MAX) + "\n... (shortened; this write cannot be applied)\n";
      }
      const pid = id("wp");
      const file: WriteProposalFile = { relPath: shown, op: baseSha ? "edit" : "create", baseSha256: baseSha, newSha256: newSha, bytes: buf.length };
      const p: WriteProposal = {
        id: pid, kind: "file", grantId: grant.id, agentId, roomId, relPath: shown, askedPath: relPath, baseSha256: baseSha, newSha256: newSha,
        diff, bytes: buf.length, files: [file], status: "pending", createdAt: now(), ...(unappliable ? { unappliable } : {}),
      };
      this.pendingContent.set(pid, [{ relPath: shown, content: buf, old: oldBuf }]);
      this.store.audit(agentId, "file.write.proposed", `${pid} ${grant.id} ${q(shown)} ${baseSha ? "edit" : "new file"} ${buf.length} bytes sha256=${newSha.slice(0, 12)}${unappliable ? " (cannot be applied)" : ""}`);

      const header = `Write proposal ${pid}: ${baseSha ? "edit" : "new file"} ${shown} in ${grant.label ?? basename(grant.path)} (${buf.length} bytes)\n${shown !== relPath ? `(the agent asked for ${q(relPath)}, a different spelling of the same file)\n` : ""}`
        + (unappliable ? `!! THIS WRITE CANNOT BE APPLIED: ${unappliable}. Approving it changes nothing.\n` : "");
      return this.register(p, header, diff);
    } catch (e) {
      return this.deny(agentId, "write", relPath, this.why(e), writeOnly ? GENERIC_PATH : undefined);
    }
  }

  /**
   * 1.1: everything one task changed in a goal on a granted folder, as ONE proposal with every file and the full diff.
   * The grant (chosen by the owner for the goal) is the authority, not the agent's own filesystem switch. Nothing is written until the owner approves.
   * Files that cannot be reviewed as text (binary, symlinks, too large) are listed in `skipped` and never written.
   */
  proposeTask(input: { grantId: string; agentId: string; roomId?: string; goalId: string; taskId: string; title: string; changes: TaskChange[]; /** files the caller already left out, and why */ skipped?: { relPath: string; reason: string }[] }): TaskProposeResult {
    const where = `task ${input.taskId}`;
    const grant = this.grant(input.grantId);
    if (!grant) return this.deny(input.agentId, "writeback", where, "the folder grant was removed");
    if (!grant.write) return this.deny(input.agentId, "writeback", where, `grant ${grant.id} does not allow writing`);
    const queued = this.pending();
    if (queued.length >= MAX_PENDING) return this.deny(input.agentId, "writeback", where, "too many writes are already waiting for the owner");
    if (queued.filter((x) => x.agentId === input.agentId).length >= MAX_PENDING_PER_AGENT) return this.deny(input.agentId, "writeback", where, `this agent already has ${MAX_PENDING_PER_AGENT} writes waiting for the owner`);
    const skipped: { relPath: string; reason: string }[] = [...(input.skipped ?? [])];
    const items: PendingItem[] = [], files: WriteProposalFile[] = [], diffs: string[] = [];
    const changes = [...input.changes].sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const ch of changes.slice(0, MAX_TASK_FILES)) {
      try {
        if (touchesGit(ch.relPath)) { skipped.push({ relPath: ch.relPath, reason: "writes inside .git are not allowed" }); continue; }
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(ch.relPath)) { skipped.push({ relPath: short(ch.relPath, 120), reason: "control characters in a path are not allowed" }); continue; }
        assertPlainPath(ch.relPath);
        const target = resolveInGrant(grant.path, ch.relPath);
        const guard = this.writeGuard(grant.path, ch.relPath, target);
        if (guard) { skipped.push({ relPath: ch.relPath, reason: guard }); continue; }
        const shown = relative(realpathSync.native(grant.path), target);
        assertPlainPath(shown);
        if (ch.content && ch.content.length > MAX_WRITE_BYTES) { skipped.push({ relPath: shown, reason: `larger than ${MAX_WRITE_BYTES} bytes` }); continue; }
        if (ch.content && isBinaryOrInvalid(ch.content)) { skipped.push({ relPath: shown, reason: `${NOT_TEXT}; not written back` }); continue; }
        const cur = this.readFile(target, MAX_EXISTING_BYTES, true);
        let oldText: string | null = null, oldBuf: Buffer | null = null, baseSha: string | null = null;
        if (cur.kind === "notfile") { skipped.push({ relPath: shown, reason: "target exists and is not a regular file" }); continue; }
        if (cur.kind === "file") {
          if (cur.size > MAX_EXISTING_BYTES || isBinaryOrInvalid(cur.buf)) { skipped.push({ relPath: shown, reason: `existing file is ${cur.size > MAX_EXISTING_BYTES ? "too large to diff" : NOT_TEXT}` }); continue; }
          oldText = cur.buf.toString("utf8"); oldBuf = cur.buf; baseSha = sha256(cur.buf);
        }
        const newText = ch.content ? ch.content.toString("utf8") : null;
        if (ch.content === null && cur.kind === "missing") continue; // deleted something that was never in the folder
        if (ch.content && baseSha === sha256(ch.content)) continue; // already the same
        if (tooLargeToDiff(oldText, newText)) { skipped.push({ relPath: shown, reason: "too large for the owner to review as a diff (over 5,000 lines)" }); continue; }
        const op: WriteProposalFile["op"] = ch.content === null ? "delete" : baseSha ? "edit" : "create";
        items.push({ relPath: shown, content: ch.content, old: oldBuf });
        files.push({ relPath: shown, op, baseSha256: baseSha, newSha256: ch.content ? sha256(ch.content) : null, bytes: ch.content?.length ?? 0 });
        diffs.push(unifiedDiff(shown, oldText, newText));
      } catch (e) { skipped.push({ relPath: short(ch.relPath, 120), reason: this.why(e) }); }
    }
    for (const c of changes.slice(MAX_TASK_FILES)) skipped.push({ relPath: short(c.relPath, 120), reason: `more than ${MAX_TASK_FILES} files in one task` });
    for (const s of skipped) this.store.audit(input.agentId, "file.denied", `writeback ${q(s.relPath)}: ${s.reason}`);
    if (!files.length) {
      this.store.audit(input.agentId, "file.writeback.none", `${input.taskId} ${grant.id}: nothing to write back${skipped.length ? ` (${skipped.length} skipped)` : ""}`);
      return { ok: true, none: true, skipped };
    }
    const diff = diffs.join("\n");
    if (diff.length > TASK_DIFF_MAX) return this.deny(input.agentId, "writeback", where, `the task's changes are too large to review as one diff (over ${TASK_DIFF_MAX} characters)`);
    const pid = id("wp");
    const total = files.reduce((n, f) => n + f.bytes, 0);
    const p: WriteProposal = {
      id: pid, kind: "task", grantId: grant.id, agentId: input.agentId, roomId: input.roomId, goalId: input.goalId, taskId: input.taskId, title: input.title,
      relPath: files.length === 1 ? files[0].relPath : `${files.length} files`, baseSha256: null,
      newSha256: sha256(Buffer.from(files.map((f) => `${f.relPath}\0${f.newSha256 ?? "deleted"}`).join("\n"))),
      diff, bytes: total, files, ...(skipped.length ? { skipped } : {}), status: "pending", createdAt: now(),
    };
    this.pendingContent.set(pid, items);
    for (const f of files) this.store.audit(input.agentId, "file.write.proposed", `${pid} ${grant.id} ${q(f.relPath)} ${f.op} ${f.bytes} bytes${f.newSha256 ? ` sha256=${f.newSha256.slice(0, 12)}` : ""} (task ${input.taskId})`);
    const list = files.map((f) => `  ${f.op} ${f.relPath}`).join("\n");
    const skip = skipped.length ? `\nNot included (cannot be written back):\n${skipped.map((s) => `  ${s.relPath}: ${s.reason}`).join("\n")}\n` : "";
    const header = `Write proposal ${pid}: task "${input.title}" changes ${files.length} file${files.length === 1 ? "" : "s"} in ${grant.label ?? basename(grant.path)} (${total} bytes)\n${list}\n${skip}`;
    const out = this.register(p, header, diff);
    return out.ok ? { ok: true, proposal: out.proposal, skipped } : out;
  }

  /** Save the proposal, ask the owner (never through requestApproval, so "run without asking" cannot skip this) and wire the decision. */
  private register(p: WriteProposal, header: string, diff: string): ProposeResult {
    this.saveProposal(p);
    let detail = header + diff;
    if (detail.length > APPROVAL_DETAIL_MAX) {
      const warn = `!! DIFF TRUNCATED: showing the first part of ${detail.length} characters. Approving writes the WHOLE change. Full diff: GET /write-proposals/${p.id}\n`;
      detail = warn + detail.slice(0, APPROVAL_DETAIL_MAX - warn.length - 20) + "\n... (truncated)";
    }
    const action = p.kind === "task" ? `write ${p.files!.length} file${p.files!.length === 1 ? "" : "s"} from "${short(p.title ?? "task", 60)}"` : `write ${p.relPath}`;
    // A task's whole accepted work waits up to 12 hours: the agent can't redo it, so it must not lapse with an ordinary 30 minute approval.
    const decision = this.approvals.request({ agentId: p.agentId, roomId: p.roomId, tool: "filesystem", action, detail, proposalId: p.id }, p.kind === "task" ? { ttlMs: 12 * 3600_000 } : {});
    const apr = this.store.listApprovals("pending").find((a) => a.proposalId === p.id);
    if (apr) { p.approvalId = apr.id; this.saveProposal(p); }
    void decision.then((a) => this.finish(p.id, a)).catch((e) => this.settle(p.id, "expired", `approval failed: ${this.why(e)}`));
    return { ok: true, proposal: p };
  }

  // ---------- proposals

  proposals(): WriteProposal[] { return this.store.getKV<WriteProposal[]>(PROPOSALS_KEY, []); }
  proposal(pid: string): WriteProposal | undefined { return this.proposals().find((p) => p.id === pid); }

  /**
   * What the proposing agent may see: only its own proposals (same answer as "unknown" otherwise).
   * On a write-only grant it sees nothing about the file: no diff, no hashes, no resolved path, and a refusal
   * for any reason (conflict, unappliable, owner said no) reads the same.
   */
  proposalFor(agentId: string, pid: string): WriteProposal | undefined {
    const p = this.proposal(pid);
    if (!p || p.agentId !== agentId) return undefined;
    const g = this.grant(p.grantId);
    if (g?.read) return p;
    const refused = p.status === "conflict" || p.status === "rejected";
    return {
      id: p.id, kind: p.kind, grantId: p.grantId, agentId: p.agentId, roomId: p.roomId, relPath: p.askedPath ?? p.relPath,
      baseSha256: null, newSha256: p.newSha256, diff: "(diff withheld: this grant is write-only)", bytes: p.bytes,
      status: refused ? "rejected" : p.status, reason: p.reason || refused ? NOT_APPLIED : undefined, createdAt: p.createdAt, decidedAt: p.decidedAt,
    };
  }

  // ---------- internals

  private pending() { return this.proposals().filter((p) => p.status === "pending"); }

  private saveProposal(p: WriteProposal) {
    const all = this.proposals().filter((x) => x.id !== p.id);
    all.push(p);
    // Keep the newest 500; pending ones are never trimmed.
    let excess = all.length - MAX_PROPOSALS;
    const kept = all.filter((x) => (excess > 0 && x.status !== "pending" ? (excess--, false) : true));
    // Old settled proposals keep their record but give up their diff.
    const settled = kept.filter((x) => x.status !== "pending").sort((a, b) => b.createdAt - a.createdAt);
    for (const x of settled.slice(KEEP_DIFFS)) if (!x.diffDropped) { x.diff = "(diff no longer stored: this proposal was settled long ago)"; x.diffDropped = true; }
    this.store.setKV(PROPOSALS_KEY, kept);
  }

  /** One audit entry per file, so a task's write-back shows every path. */
  private auditFiles(actor: string, action: string, p: WriteProposal, tail: string) {
    const paths = p.files?.length ? p.files.map((f) => f.relPath) : [p.relPath];
    for (const path of paths) this.store.audit(actor, action, `${p.id} ${p.grantId} ${q(path)}${tail}`);
  }

  private settle(pid: string, status: WriteProposal["status"], reason?: string, actor?: string) {
    const p = this.proposal(pid);
    if (!p || p.status !== "pending") return;
    p.status = status; p.decidedAt = now(); if (reason) p.reason = reason;
    this.pendingContent.delete(pid);
    this.saveProposal(p);
    if (status === "conflict") this.auditFiles(p.agentId, "file.write.conflict", p, `: ${reason}`);
    else if (status !== "applied") this.auditFiles(actor ?? "owner", "file.write.rejected", p, ` (${status})${reason ? `: ${reason}` : ""}`);
  }

  /** Hub restarted while writes were waiting: their content is gone, so they cannot be applied. */
  private expireStale() {
    for (const p of this.pending()) {
      this.settle(p.id, "expired", "hub restarted before the owner decided", "system");
      if (p.approvalId) this.approvals.decide(p.approvalId, "expired", "system");
    }
  }

  private finish(pid: string, a: Approval) {
    const p = this.proposal(pid);
    if (!p || p.status !== "pending") return;
    if (a.status === "rejected") return this.settle(pid, "rejected", "owner rejected", "owner");
    if (a.status !== "approved") return this.settle(pid, "expired", "no decision before the approval expired", "system");
    if (p.unappliable) return this.settle(pid, "rejected", `cannot be applied: ${p.unappliable}`, "system");
    const items = this.pendingContent.get(pid);
    if (!items) return this.settle(pid, "expired", "content no longer available", "system");

    // Everything is checked again: the grant, the tool switch, the path and the file itself may have changed while waiting.
    const grant = this.grant(p.grantId);
    const agent = this.store.getAgent(p.agentId);
    const fail = (why: string) => {
      this.auditFiles(p.agentId, "file.denied", p, `: ${why} (at apply time)`);
      this.settle(pid, "rejected", why, "system");
    };
    if (!grant || !grant.write) return fail("the folder grant was removed or is no longer writable");
    // Narrowing a grant to another agent or room must stop what the old audience proposed (grantsFor is what the agent could use right now).
    if (!this.grantsFor(p.agentId, p.roomId).some((g) => g.id === grant.id)) return fail("the folder grant no longer covers this agent here");
    // A write an agent proposed needs the agent's filesystem switch on; a task's write-back rests on the grant the owner picked for the goal.
    if (p.kind !== "task" && (!agent || agent.tools.filesystem !== true)) return fail("the filesystem tool was switched off");
    try {
      const files = p.files ?? [];
      if (files.length !== items.length) return fail("proposal does not match its content");
      // 1. Verify every file before changing any.
      const plan: { item: PendingItem; target: string; mode?: number }[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i], f = files[i];
        if ((item.content ? sha256(item.content) : null) !== f.newSha256) return fail("content changed in memory");
        const target = resolveInGrant(grant.path, item.relPath);
        const guard = this.writeGuard(grant.path, item.relPath, target);
        if (guard) return fail(guard);
        const cur = this.readFile(target, MAX_EXISTING_BYTES, true);
        const curSha = cur.kind === "missing" ? null : cur.kind === "file" && cur.size <= MAX_EXISTING_BYTES ? sha256(cur.buf) : "unreadable";
        if (curSha !== f.baseSha256) return this.settle(pid, "conflict", `the file changed after the write was proposed (${short(item.relPath, 200)}); nothing was written`);
        plan.push({ item, target, mode: cur.kind === "file" ? cur.mode : undefined });
      }
      // 2. Write them all. If one fails, put back the ones already done.
      const done: typeof plan = [];
      try {
        for (const step of plan) {
          if (step.item.content === null) this.removeFile(grant.path, step.target); else this.atomicWrite(grant.path, step.target, step.item.content, step.mode);
          done.push(step);
        }
      } catch (e) {
        for (const step of done.reverse()) {
          try { if (step.item.old === null) this.removeFile(grant.path, step.target); else this.atomicWrite(grant.path, step.target, step.item.old, step.mode); }
          catch { this.store.audit(p.agentId, "file.write.rollback_failed", `${pid} ${grant.id} ${q(step.item.relPath)}`); }
        }
        throw e;
      }
      p.status = "applied"; p.decidedAt = now(); this.pendingContent.delete(pid);
      this.saveProposal(p);
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        this.store.audit(p.agentId, "file.write.applied", `${pid} ${grant.id} ${q(f.relPath)} ${f.op} ${f.bytes} bytes${f.newSha256 ? ` sha256=${f.newSha256.slice(0, 12)}` : ""} (approved by owner)`);
      }
    } catch (e) { fail(`write failed: ${this.why(e)}`); }
  }

  /**
   * Reasons a target may not be written, beyond staying inside the folder. null = fine.
   * `target` is the resolved real path, so the .git check runs on where the write would really land:
   * a symlinked folder that points at .git is caught as well as a plain `.git/...` spelling.
   */
  /** `spellingOnly`: only the refusals that follow from how the path is written, which never depend on what is on the disk. */
  private writeGuard(grantRoot: string, relPath: string, target: string, spellingOnly = false): string | null {
    const root = realpathSync.native(grantRoot);
    if (spellingOnly) {
      if (resolve(root, relPath) === root) return "cannot write the folder itself";
      if (touchesGit(relative(root, resolve(root, relPath)))) return "writes inside .git are not allowed";
      return null;
    }
    if (target === root) return "cannot write the folder itself";
    if (touchesGit(relative(root, target)) || touchesGit(relative(root, resolve(root, relPath)))) return "writes inside .git are not allowed";
    try { if (lstatSync(resolve(root, relPath)).isSymbolicLink()) return "target is a symlink; writes to symlinks are not allowed"; } catch { /* does not exist yet */ }
    return null;
  }

  /** Read a regular file without following a final symlink. `whole` reads everything up to maxBytes, else a prefix. */
  private readFile(path: string, maxBytes: number, whole = false):
    | { kind: "missing" } | { kind: "notfile"; why?: "hard link" }
    | { kind: "file"; buf: Buffer; size: number; mode: number } {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { kind: "missing" };
      if (code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR" || code === "ENXIO") return { kind: "notfile" };
      throw e;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return { kind: "notfile" };
      // A file with more than one name may be a second name for something outside the folder (a hard link to ~/.ssh/id_rsa): never read or diffed.
      if (st.nlink > 1) return { kind: "notfile", why: "hard link" };
      const want = whole ? Math.min(st.size, maxBytes + 1) : Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) { const n = readSync(fd, buf, got, want - got, got); if (n === 0) break; got += n; }
      return { kind: "file", buf: buf.subarray(0, got), size: st.size, mode: st.mode & 0o777 };
    } finally { closeSync(fd); }
  }

  /** Remove a file the owner approved deleting. The path is the resolved real path, re-checked to be inside the folder; a symlink swapped in meanwhile is removed as a link, never followed. */
  private removeFile(grantRoot: string, target: string) {
    const root = realpathSync.native(grantRoot);
    if (!isInside(root, dirname(target)) || target === root) throw new PathDenied("path resolves outside the granted folder");
    unlinkSync(target);
  }

  /** Temp file in the same folder, then rename: readers see the old or the new file, never half. */
  private atomicWrite(grantRoot: string, target: string, buf: Buffer, mode?: number) {
    const root = realpathSync.native(grantRoot);
    const dir = dirname(target);
    if (!isInside(root, dir)) throw new PathDenied("path resolves outside the granted folder");
    mkdirSync(dir, { recursive: true });
    const realDir = realpathSync.native(dir);
    if (!isInside(root, realDir)) throw new PathDenied("path resolves outside the granted folder");
    const tmp = join(realDir, `.ar-${randomBytes(8).toString("hex")}.tmp`);
    try {
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode ?? 0o644);
      try { writeSync(fd, buf); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, join(realDir, basename(target)));
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* not created */ }
      throw e;
    }
  }

  /** Who may do what: the tool switch, then the grants visible from this room. */
  private authorize(agentId: string, roomId: string | undefined, op: "list" | "read" | "write", rel: string, grantId?: string):
    { ok: true; grant: FolderGrant } | Denied {
    const agent = this.store.getAgent(agentId);
    if (!agent || !agent.enabled) return this.deny(agentId, op, rel, "unknown or disabled agent");
    if (agent.tools.filesystem !== true) return this.deny(agentId, op, rel, "the filesystem tool is switched off for this agent");
    if (this.opts.rooms?.level(agentId, roomId, "filesystem") === "off") return this.deny(agentId, op, rel, "the filesystem tool is switched off for this agent in this room"); // 4.3
    const visible = this.grantsFor(agentId, roomId);
    if (visible.length === 0) return this.deny(agentId, op, rel, "no folder has been granted to this agent here");
    const can = (g: FolderGrant) => (op === "write" ? g.write : g.read);
    if (grantId) {
      const g = visible.find((x) => x.id === grantId);
      if (!g) return this.deny(agentId, op, rel, "unknown grantId");
      if (!can(g)) return this.deny(agentId, op, rel, `grant ${g.id} does not allow ${op === "write" ? "writing" : "reading"}`);
      return { ok: true, grant: g };
    }
    const usable = visible.filter(can);
    if (usable.length === 0) return this.deny(agentId, op, rel, `no grant allows ${op === "write" ? "writing" : "reading"}`);
    if (usable.length > 1) return this.deny(agentId, op, rel, `several folders are granted; pass grantId (one of: ${usable.map((g) => g.id).join(", ")})`);
    return { ok: true, grant: usable[0] };
  }

  /** The audit entry carries the real reason (the owner reads it); `shown` is what the agent is told. */
  private deny(agentId: string, op: string, rel: string, reason: string, shown = reason): Denied {
    this.store.audit(agentId, "file.denied", `${op} ${q(rel)}: ${reason}`);
    return { ok: false, reason: shown };
  }

  /** Error text that is safe to give an agent (no system paths or errno detail). */
  private why(e: unknown): string {
    if (e instanceof PathDenied) return e.message;
    const code = (e as NodeJS.ErrnoException)?.code;
    return code ? `file system error (${code})` : "unexpected error";
  }
}
