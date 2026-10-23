import { createHash } from "node:crypto";
import type { McpTokenInfo } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { id, now, token } from "../util.js";

/**
 * Keys for MCP apps that live outside the hub (Hermes, Muse, claude.ai and ChatGPT connectors).
 *
 * Only a SHA-256 of each key is stored, so a copy of the database (a backup, a sync folder) cannot be used to
 * call the hub. The key itself exists once: in the response that creates or rotates it. A key may expire and may be
 * pinned to one room, which is what lets room-scoped folder grants reach an MCP app. Keys never appear in the audit log.
 *
 * The hub keeps the plaintext of a key it just made in memory, so the Connect screen can show it again until the hub
 * restarts; after that only a rotation produces a key anyone can see.
 */
const KEY = "mcp_tokens_v2";
const LEGACY_KEY = "mcp_tokens"; // plaintext key -> { agentId, name }, used before 1.1
const TOUCH_EVERY_MS = 60_000;

export interface TokenRecord { id: string; hash: string; agentId: string; name: string; roomId?: string; createdAt: number; expiresAt?: number; lastUsedAt?: number }

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const info = (r: TokenRecord, at = now()): McpTokenInfo => ({
  id: r.id, agentId: r.agentId, name: r.name, roomId: r.roomId, createdAt: r.createdAt, expiresAt: r.expiresAt, lastUsedAt: r.lastUsedAt,
  expired: !!r.expiresAt && r.expiresAt <= at,
});

export class McpTokens {
  /** Keys made since this hub started, by record id. Never stored. */
  private shown = new Map<string, string>();
  private touched = new Map<string, number>();

  constructor(private store: Store) { this.migrate(); }

  private all(): TokenRecord[] { return this.store.getKV<TokenRecord[]>(KEY, []); }
  private save(rows: TokenRecord[]) { this.store.setKV(KEY, rows); }

  /** Replace keys stored in the clear by their hashes. Existing keys keep working. */
  private migrate() {
    const legacy = this.store.getKV<Record<string, { agentId: string; name: string }>>(LEGACY_KEY, {});
    const entries = Object.entries(legacy);
    if (!entries.length) return;
    const rows = this.all();
    for (const [t, v] of entries) {
      const hash = hashToken(t);
      if (!rows.some((r) => r.hash === hash)) rows.push({ id: id("mtk"), hash, agentId: v.agentId, name: v.name, createdAt: now() });
    }
    this.save(rows);
    try { this.store.db.pragma("secure_delete = ON"); } catch { /* best effort */ }
    this.store.setKV(LEGACY_KEY, {});
    // The plaintext may still sit in free pages and in the write-ahead log: rebuild the file once, then empty the log.
    try { this.store.db.exec("VACUUM"); } catch { /* best effort */ }
    try { this.store.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    this.store.audit("hub", "mcp.token.migrated", `${entries.length} key(s) now stored as hashes`);
  }

  list(): McpTokenInfo[] { const at = now(); return this.all().map((r) => info(r, at)); }
  get(tokenId: string): McpTokenInfo | undefined { const r = this.all().find((x) => x.id === tokenId); return r ? info(r) : undefined; }
  forAgent(agentId: string): McpTokenInfo[] { return this.list().filter((t) => t.agentId === agentId); }

  /** The key for a record, only while the hub that made it is still running. */
  plaintext(tokenId: string): string | undefined { return this.shown.get(tokenId); }

  create(o: { agentId: string; name: string; roomId?: string; expiresAt?: number }, actor = "owner"): { token: string; info: McpTokenInfo } {
    const t = token();
    const r: TokenRecord = { id: id("mtk"), hash: hashToken(t), agentId: o.agentId, name: o.name, roomId: o.roomId || undefined, createdAt: now(), expiresAt: o.expiresAt };
    this.save([...this.all(), r]);
    this.shown.set(r.id, t);
    this.store.audit(actor, "mcp.token.created", this.describe(r));
    return { token: t, info: info(r) };
  }

  /** A new key for the same record (same agent, room and expiry unless given). The old key stops working at once. */
  rotate(tokenId: string, o: { expiresAt?: number | null } = {}, actor = "owner"): { token: string; info: McpTokenInfo } | undefined {
    const rows = this.all();
    const r = rows.find((x) => x.id === tokenId);
    if (!r) return undefined;
    const t = token();
    r.hash = hashToken(t); r.createdAt = now(); r.lastUsedAt = undefined;
    if (o.expiresAt !== undefined) r.expiresAt = o.expiresAt ?? undefined;
    this.save(rows);
    this.shown.set(r.id, t); this.touched.delete(r.id);
    this.store.audit(actor, "mcp.token.rotated", this.describe(r));
    return { token: t, info: info(r) };
  }

  revoke(tokenId: string, actor = "owner"): boolean {
    const rows = this.all();
    const r = rows.find((x) => x.id === tokenId);
    if (!r) return false;
    this.save(rows.filter((x) => x.id !== tokenId));
    this.shown.delete(tokenId); this.touched.delete(tokenId);
    this.store.audit(actor, "mcp.token.revoked", this.describe(r));
    return true;
  }

  revokeAgent(agentId: string, actor = "owner"): number {
    const mine = this.all().filter((r) => r.agentId === agentId);
    for (const r of mine) this.revoke(r.id, actor);
    return mine.length;
  }

  /** The record a presented key belongs to, with whether it has expired. Looks the key up by its hash. */
  lookup(presented: string): { record: McpTokenInfo; expired: boolean } | undefined {
    if (!presented || presented.length > 512) return undefined;
    const hash = hashToken(presented);
    const r = this.all().find((x) => x.hash === hash);
    if (!r) return undefined;
    const i = info(r);
    return { record: i, expired: i.expired };
  }

  /** Remember when a key was last used, at most once a minute so reading never turns into a write storm. */
  touch(tokenId: string) {
    const at = now();
    if ((this.touched.get(tokenId) ?? 0) + TOUCH_EVERY_MS > at) return;
    this.touched.set(tokenId, at);
    const rows = this.all();
    const r = rows.find((x) => x.id === tokenId);
    if (r) { r.lastUsedAt = at; this.save(rows); }
  }

  private describe(r: TokenRecord) {
    return `${r.id} agent=${r.agentId} name=${JSON.stringify(r.name.slice(0, 80))} room=${r.roomId ?? "*"} expires=${r.expiresAt ? new Date(r.expiresAt).toISOString() : "never"}`;
  }
}
