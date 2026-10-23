import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Approval, FolderGrant, WriteProposal } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import type { Approvals } from "../orchestrator/approvals.js";
import { id, now } from "../util.js";
import { tooLargeToDiff, unifiedDiff } from "./diff.js";
import { MAX_REL_PATH, PathDenied, assertPlainPath, isInside, resolveInGrant, validateGrantRoot } from "./paths.js";

const GRANTS_KEY = "folder_grants";
const PROPOSALS_KEY = "write_proposals";
const MAX_PROPOSALS = 500;
const MAX_PENDING = 50;
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_EXISTING_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
const APPROVAL_DETAIL_MAX = 8000;
const DIFF_STORE_MAX = 100_000;
const BINARY_SNIFF = 8192;

export type Denied = { ok: false; reason: string };
export interface ListEntry { name: string; type: "file" | "dir" | "symlink" | "other"; size?: number }
export type ListResult = { ok: true; grantId: string; entries: ListEntry[]; truncated: boolean } | Denied;
export type ReadResult =
  | { ok: true; grantId: string; binary: false; content: string; bytes: number; truncated: boolean }
  | { ok: true; grantId: string; binary: true; note: string; bytes: number }
  | Denied;
export type ProposeResult = { ok: true; proposal: WriteProposal } | Denied;

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
  private pendingContent = new Map<string, Buffer>();

  constructor(private store: Store, private approvals: Approvals) {
    this.expireStale();
  }

  // ---------- grants (owner-managed)

  listGrants(): FolderGrant[] { return this.store.getKV<FolderGrant[]>(GRANTS_KEY, []); }

  /** Throws PathDenied if the folder may not be granted. Stores the realpath. */
  addGrant(input: { path: string; label?: string; roomId?: string; agentId: string; read: boolean; write: boolean }): FolderGrant {
    const dbFile = this.store.db.name;
    const dataDir = dbFile && dbFile !== ":memory:" ? dirname(resolve(dbFile)) : undefined;
    if (!input.read && !input.write) throw new PathDenied("a grant needs read or write access");
    if (!input.agentId) throw new PathDenied("a grant needs an agent id (or *)");
    const g: FolderGrant = {
      id: id("grant"), path: validateGrantRoot(input.path, { dataDir }), label: input.label, roomId: input.roomId || undefined,
      agentId: input.agentId, read: input.read, write: input.write, createdAt: now(),
    };
    this.store.setKV(GRANTS_KEY, [...this.listGrants(), g]);
    return g;
  }

  removeGrant(grantId: string): FolderGrant | undefined {
    const all = this.listGrants();
    const g = all.find((x) => x.id === grantId);
    if (g) this.store.setKV(GRANTS_KEY, all.filter((x) => x.id !== grantId));
    return g;
  }

  /** Grants this agent may see from this room. Room grants narrow: no room, no room-scoped grant. */
  grantsFor(agentId: string, roomId?: string): FolderGrant[] {
    return this.listGrants().filter((g) => (g.agentId === "*" || g.agentId === agentId) && (g.roomId === undefined || g.roomId === roomId));
  }

  // ---------- agent operations

  list(agentId: string, roomId: string | undefined, relDir: string, grantId?: string): ListResult {
    const rel = relDir === "" ? "." : relDir;
    const auth = this.authorize(agentId, roomId, "list", rel, grantId);
    if (!auth.ok) return auth;
    try {
      const dir = resolveInGrant(auth.grant.path, rel);
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
      const got = this.readFile(file, maxBytes);
      if (got.kind !== "file") return this.deny(agentId, "read", relPath, got.kind === "missing" ? "no such file" : "not a regular file");
      if (got.sniffBinary) {
        this.store.audit(agentId, "file.read", `${auth.grant.id} ${q(relPath)} binary, not returned (${got.size} bytes)`);
        return { ok: true, grantId: auth.grant.id, binary: true, bytes: got.size, note: `Binary file (${got.size} bytes); content not returned.` };
      }
      this.store.audit(agentId, "file.read", `${auth.grant.id} ${q(relPath)} ${got.buf.length}/${got.size} bytes${got.size > got.buf.length ? " (truncated)" : ""}`);
      return { ok: true, grantId: auth.grant.id, binary: false, content: got.buf.toString("utf8"), bytes: got.size, truncated: got.size > got.buf.length };
    } catch (e) { return this.deny(agentId, "read", relPath, this.why(e)); }
  }

  /** Save a pending proposal and ask the owner. Returns at once; the file changes only after approval. */
  proposeWrite(agentId: string, roomId: string | undefined, relPath: string, content: string, grantId?: string): ProposeResult {
    const auth = this.authorize(agentId, roomId, "write", relPath, grantId);
    if (!auth.ok) return auth;
    const grant = auth.grant;
    try {
      const buf = Buffer.from(content, "utf8");
      if (buf.length > MAX_WRITE_BYTES) return this.deny(agentId, "write", relPath, `content larger than ${MAX_WRITE_BYTES} bytes`);
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(relPath)) return this.deny(agentId, "write", relPath, "control characters in a path are not allowed");
      if (relPath.endsWith("/") || relPath.endsWith("\\")) return this.deny(agentId, "write", relPath, "a file path cannot end with a slash");
      assertPlainPath(relPath);
      if (content.includes("\0")) return this.deny(agentId, "write", relPath, "binary content (NUL byte) cannot be written");
      if (this.pending().length >= MAX_PENDING) return this.deny(agentId, "write", relPath, "too many writes are already waiting for the owner");
      const target = resolveInGrant(grant.path, relPath);
      const guard = this.writeGuard(grant.path, relPath, target);
      if (guard) return this.deny(agentId, "write", relPath, guard);
      // What the owner sees and approves is the real location, not the spelling (symlinked folders) the agent chose.
      const shown = relative(realpathSync.native(grant.path), target);
      assertPlainPath(shown);

      let oldText: string | null = null, baseSha: string | null = null;
      const cur = this.readFile(target, MAX_EXISTING_BYTES, true);
      if (cur.kind === "missing") { /* new file */ }
      else if (cur.kind === "notfile") return this.deny(agentId, "write", relPath, "target exists and is not a regular file");
      else {
        if (cur.size > MAX_EXISTING_BYTES) return this.deny(agentId, "write", relPath, "existing file is too large to diff");
        if (cur.sniffBinary || !Buffer.from(cur.buf.toString("utf8"), "utf8").equals(cur.buf)) return this.deny(agentId, "write", relPath, "existing file is binary or not UTF-8");
        oldText = cur.buf.toString("utf8"); baseSha = sha256(cur.buf);
      }
      const newSha = sha256(buf);
      if (baseSha === newSha) return this.deny(agentId, "write", relPath, "content is identical to the existing file; nothing to write");

      const pid = id("wp");
      // The owner must be able to read everything that will be written. unifiedDiff only returns a one-line
      // summary past MAX_DIFF_LINES, and a summary is not a diff: refuse, never let it stand in for one.
      if (tooLargeToDiff(oldText, content)) return this.deny(agentId, "write", relPath, "the change is too large for the owner to review as a diff (over 5,000 lines on one side); propose smaller edits or split the file");
      const diff = unifiedDiff(shown, oldText, content);
      // Oversized diffs are refused rather than cut, for the same reason.
      if (diff.length > DIFF_STORE_MAX) return this.deny(agentId, "write", relPath, `the change is too large for the owner to review (diff over ${DIFF_STORE_MAX} characters); propose smaller edits`);
      const p: WriteProposal = {
        id: pid, grantId: grant.id, agentId, roomId, relPath: shown, baseSha256: baseSha, newSha256: newSha,
        diff, bytes: buf.length, status: "pending", createdAt: now(),
      };
      this.pendingContent.set(pid, buf);
      this.saveProposal(p);
      this.store.audit(agentId, "file.write.proposed", `${pid} ${grant.id} ${q(shown)} ${baseSha ? "edit" : "new file"} ${buf.length} bytes sha256=${newSha.slice(0, 12)}`);

      // Straight to the owner: never through requestApproval, so "run without asking" cannot skip this.
      const header = `Write proposal ${pid}: ${baseSha ? "edit" : "new file"} ${shown} in ${grant.label ?? basename(grant.path)} (${buf.length} bytes)\n${shown !== relPath ? `(the agent asked for ${q(relPath)}, a different spelling of the same file)\n` : ""}`;
      let detail = header + diff;
      if (detail.length > APPROVAL_DETAIL_MAX) {
        const warn = `!! DIFF TRUNCATED: showing the first part of ${detail.length} characters. Approving writes the WHOLE change. Full diff: GET /write-proposals (${pid}).\n`;
        detail = warn + detail.slice(0, APPROVAL_DETAIL_MAX - warn.length - 20) + "\n... (truncated)";
      }
      const decision = this.approvals.request({ agentId, roomId, tool: "filesystem", action: `write ${shown}`, detail });
      const apr = this.store.listApprovals("pending").filter((a) => a.agentId === agentId && a.tool === "filesystem" && a.detail.includes(`Write proposal ${pid}:`))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (apr) { p.approvalId = apr.id; this.saveProposal(p); }
      void decision.then((a) => this.finish(pid, a)).catch((e) => this.settle(pid, "expired", `approval failed: ${this.why(e)}`));
      return { ok: true, proposal: p };
    } catch (e) { return this.deny(agentId, "write", relPath, this.why(e)); }
  }

  // ---------- proposals

  proposals(): WriteProposal[] { return this.store.getKV<WriteProposal[]>(PROPOSALS_KEY, []); }
  proposal(pid: string): WriteProposal | undefined { return this.proposals().find((p) => p.id === pid); }

  /**
   * What the proposing agent may see: only its own proposals (same answer as "unknown" otherwise),
   * and no diff of existing content unless its grant allows reading.
   */
  proposalFor(agentId: string, pid: string): WriteProposal | undefined {
    const p = this.proposal(pid);
    if (!p || p.agentId !== agentId) return undefined;
    const g = this.listGrants().find((x) => x.id === p.grantId);
    return g?.read ? p : { ...p, diff: "(diff withheld: this grant is write-only)" };
  }

  // ---------- internals

  private pending() { return this.proposals().filter((p) => p.status === "pending"); }

  private saveProposal(p: WriteProposal) {
    const all = this.proposals().filter((x) => x.id !== p.id);
    all.push(p);
    // Keep the newest 500; pending ones are never trimmed.
    let excess = all.length - MAX_PROPOSALS;
    const kept = all.filter((x) => (excess > 0 && x.status !== "pending" ? (excess--, false) : true));
    this.store.setKV(PROPOSALS_KEY, kept);
  }

  private settle(pid: string, status: WriteProposal["status"], reason?: string, actor?: string) {
    const p = this.proposal(pid);
    if (!p || p.status !== "pending") return;
    p.status = status; p.decidedAt = now(); if (reason) p.reason = reason;
    this.pendingContent.delete(pid);
    this.saveProposal(p);
    if (status === "conflict") this.store.audit(p.agentId, "file.write.conflict", `${pid} ${p.grantId} ${q(p.relPath)}: ${reason}`);
    else if (status !== "applied") this.store.audit(actor ?? "owner", "file.write.rejected", `${pid} ${p.grantId} ${q(p.relPath)} (${status})${reason ? `: ${reason}` : ""}`);
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
    const buf = this.pendingContent.get(pid);
    if (!buf) return this.settle(pid, "expired", "content no longer available", "system");

    // Everything is checked again: the grant, the tool switch, the path and the file itself may have changed while waiting.
    const grant = this.listGrants().find((g) => g.id === p.grantId);
    const agent = this.store.getAgent(p.agentId);
    const fail = (why: string) => {
      this.store.audit(p.agentId, "file.denied", `write ${q(p.relPath)}: ${why} (at apply time)`);
      this.settle(pid, "rejected", why, "system");
    };
    if (!grant || !grant.write) return fail("the folder grant was removed or is no longer writable");
    if (!agent || agent.tools.filesystem !== true) return fail("the filesystem tool was switched off");
    try {
      if (sha256(buf) !== p.newSha256) return fail("content changed in memory");
      const target = resolveInGrant(grant.path, p.relPath);
      const guard = this.writeGuard(grant.path, p.relPath, target);
      if (guard) return fail(guard);
      const cur = this.readFile(target, MAX_EXISTING_BYTES, true);
      const curSha = cur.kind === "missing" ? null : cur.kind === "file" && cur.size <= MAX_EXISTING_BYTES ? sha256(cur.buf) : "unreadable";
      if (curSha !== p.baseSha256) return this.settle(pid, "conflict", "the file changed after the write was proposed; nothing was written");
      this.atomicWrite(grant.path, target, buf, cur.kind === "file" ? cur.mode : undefined);
      p.status = "applied"; p.decidedAt = now(); this.pendingContent.delete(pid);
      this.saveProposal(p);
      this.store.audit(p.agentId, "file.write.applied", `${pid} ${grant.id} ${q(p.relPath)} ${buf.length} bytes sha256=${p.newSha256.slice(0, 12)} (approved by owner)`);
    } catch (e) { fail(`write failed: ${this.why(e)}`); }
  }

  /**
   * Reasons a target may not be written, beyond staying inside the folder. null = fine.
   * `target` is the resolved real path, so the .git check runs on where the write would really land:
   * a symlinked folder that points at .git is caught as well as a plain `.git/...` spelling.
   */
  private writeGuard(grantRoot: string, relPath: string, target: string): string | null {
    const root = realpathSync.native(grantRoot);
    if (target === root) return "cannot write the folder itself";
    const inGit = (rel: string) => rel.split(/[\\/]/).some((part) => part.toLowerCase() === ".git");
    if (inGit(relative(root, target)) || inGit(relative(root, resolve(root, relPath)))) return "writes inside .git are not allowed";
    try { if (lstatSync(resolve(root, relPath)).isSymbolicLink()) return "target is a symlink; writes to symlinks are not allowed"; } catch { /* does not exist yet */ }
    return null;
  }

  /** Read a regular file without following a final symlink. `whole` reads everything up to maxBytes, else a prefix. */
  private readFile(path: string, maxBytes: number, whole = false):
    | { kind: "missing" } | { kind: "notfile" }
    | { kind: "file"; buf: Buffer; size: number; mode: number; sniffBinary: boolean } {
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
      const want = whole ? Math.min(st.size, maxBytes + 1) : Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) { const n = readSync(fd, buf, got, want - got, got); if (n === 0) break; got += n; }
      const data = buf.subarray(0, got);
      return { kind: "file", buf: data, size: st.size, mode: st.mode & 0o777, sniffBinary: data.subarray(0, BINARY_SNIFF).includes(0) };
    } finally { closeSync(fd); }
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

  private deny(agentId: string, op: string, rel: string, reason: string): Denied {
    this.store.audit(agentId, "file.denied", `${op} ${q(rel)}: ${reason}`);
    return { ok: false, reason };
  }

  /** Error text that is safe to give an agent (no system paths or errno detail). */
  private why(e: unknown): string {
    if (e instanceof PathDenied) return e.message;
    const code = (e as NodeJS.ErrnoException)?.code;
    return code ? `file system error (${code})` : "unexpected error";
  }
}
