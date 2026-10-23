import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { DocFrontMatter, DocStatus, LibraryDoc } from "@agent-room/shared";
import type { Store } from "../db/store.js";
import { id, now, token } from "../util.js";
import { DOC_STATUSES, emitFrontMatter, readDocument, splitFrontMatter, validateFrontMatter } from "./frontmatter.js";

/** Where documents live unless the owner points the Library at another folder (e.g. one synced by Drive). */
export const defaultLibraryRoot = () => process.env.AGENT_ROOM_LIBRARY ?? join(process.env.AGENT_ROOM_HOME || join(homedir(), "Agent Room"), "Library");

const MAX_SLUG = 60;
const GOAL_DIR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_ITEMS = 100;
const MAX_ITEM_LEN = 500;

/** Lowercase `[a-z0-9-]`, no leading, trailing or doubled dashes, at most `max` chars. Falls back to `fallback`, never empty. */
export function slugify(s: string, max = MAX_SLUG, fallback = "untitled"): string {
  const slug = s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, max).replace(/-+$/, "");
  return slug || fallback;
}

const localDate = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
function cleanList(a: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of a ?? []) {
    const v = oneLine(String(raw)).slice(0, MAX_ITEM_LEN);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}
const union = (a: string[], b: string[]) => cleanList([...a, ...b]);

export interface SaveDocumentInput {
  title: string;
  body: string;
  roomId: string;
  goalId?: string;
  status?: DocStatus;
  author: string;
  sources?: string[];
  tags?: string[];
}

/**
 * The Library: Markdown files with YAML front matter under one root folder, indexed in SQLite.
 * The files are the source of truth; the index is rebuilt-able and only speeds up lookups.
 */
export class Library {
  readonly root: string;
  constructor(private store: Store, root: string) { this.root = resolve(root); }

  save(input: SaveDocumentInput): { doc: LibraryDoc; created: boolean } {
    const title = oneLine(input.title ?? "");
    if (title.length < 1 || title.length > 200) throw new Error("Title must be 1-200 characters.");
    const author = oneLine(input.author ?? "").slice(0, MAX_ITEM_LEN);
    if (!author) throw new Error("A document needs an author.");
    if (input.status !== undefined && !DOC_STATUSES.includes(input.status)) throw new Error(`Status must be one of ${DOC_STATUSES.join(", ")}.`);
    if (input.goalId !== undefined && !GOAL_DIR.test(input.goalId)) throw new Error("Invalid goal id.");
    const room = this.store.getRoom(input.roomId);
    if (!room) throw new Error("Room not found.");
    const body = splitFrontMatter(input.body ?? "").body.trim();
    if (!body) throw new Error("The document body is empty.");

    const slug = slugify(title);
    const roomSlug = slugify(room.name, MAX_SLUG, "room");
    const goalDir = input.goalId ?? "general";
    const dir = this.inside(join(this.root, roomSlug, goalDir));

    // Same room, goal and slug is an update, even when it was first saved on an earlier day.
    const name = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${slug}\\.md$`);
    const today = localDate(now());
    let existing: LibraryDoc | undefined = this.store.listDocuments({ roomId: room.id })
      .filter((d) => d.goalId === input.goalId && dirname(d.path) === dir && name.test(basename(d.path)))
      .sort((a, b) => a.frontMatter.created.localeCompare(b.frontMatter.created))[0];
    const path = this.inside(existing?.path ?? join(dir, `${today}-${slug}.md`));
    if (!existing) {
      const other = this.store.findDocumentByPath(path);
      if (other && other.roomId !== room.id) throw new Error("Another room already uses this folder.");
      existing = other;
    }

    // A file the index has never seen (index lost, or the owner dropped it in): adopt its identity.
    let prior: DocFrontMatter | undefined = existing?.frontMatter;
    if (!prior && existsSync(path)) prior = readDocument(readFileSync(path, "utf8"))?.frontMatter;

    const tags = input.tags ? cleanList(input.tags) : prior?.tags ?? []; // given tags replace; omitted tags are kept
    const fm: DocFrontMatter = {
      id: prior?.id ?? id("doc"),
      title,
      room: roomSlug,
      ...(input.goalId ? { goal: input.goalId } : {}),
      status: input.status ?? prior?.status ?? "draft",
      authors: union(prior?.authors ?? [], [author]),
      created: prior?.created ?? today,
      updated: today,
      sources: union(prior?.sources ?? [], cleanList(input.sources)),
      ...(tags.length ? { tags } : {}),
    };
    const problems = validateFrontMatter(fm);
    if (problems.length) throw new Error(`Invalid front matter: ${problems.join("; ")}.`);

    const text = `${emitFrontMatter(fm)}\n${body}\n`;
    mkdirSync(join(dir, "assets"), { recursive: true });
    const tmp = `${path}.${token().slice(0, 8)}.tmp`;
    try { writeFileSync(tmp, text, "utf8"); renameSync(tmp, path); }
    catch (e) { rmSync(tmp, { force: true }); throw e; }

    const doc: LibraryDoc = {
      id: fm.id, path, relPath: relative(this.root, path).split(sep).join("/"),
      roomId: room.id, ...(input.goalId ? { goalId: input.goalId } : {}),
      frontMatter: fm, bytes: Buffer.byteLength(text), indexedAt: now(),
    };
    this.store.saveDocument(doc);
    this.store.audit(author, "document.saved", doc.relPath);
    return { doc, created: !prior };
  }

  list(filter: { roomId?: string; goalId?: string } = {}): LibraryDoc[] {
    return this.store.listDocuments(filter).sort((a, b) => a.relPath.localeCompare(b.relPath));
  }
  get(docId: string) { return this.store.getDocument(docId); }

  /**
   * 4.4: the hub marks a document (the other side of a merged fork: "superseded"). Only the status line of the file changes, the file stays where it is.
   * Returns the document, or undefined when it is gone or its file can't be read.
   */
  setStatus(docId: string, status: DocStatus, actor = "hub"): LibraryDoc | undefined {
    const doc = this.store.getDocument(docId);
    if (!doc || !DOC_STATUSES.includes(status)) return undefined;
    let text: string;
    try { text = readFileSync(this.inside(doc.path), "utf8"); } catch { return undefined; }
    const read = readDocument(text);
    if (!read) return undefined;
    if (read.frontMatter.status === status) return doc;
    const fm: DocFrontMatter = { ...read.frontMatter, status, updated: localDate(now()) };
    const out = `${emitFrontMatter(fm)}\n${read.body.replace(/^\n+/, "").trimEnd()}\n`;
    const path = this.inside(doc.path);
    const tmp = `${path}.${token().slice(0, 8)}.tmp`;
    try { writeFileSync(tmp, out, "utf8"); renameSync(tmp, path); } catch { rmSync(tmp, { force: true }); return undefined; }
    const next: LibraryDoc = { ...doc, frontMatter: fm, bytes: Buffer.byteLength(out), indexedAt: now() };
    this.store.saveDocument(next);
    this.store.audit(actor, "document.status", `${doc.relPath}: ${status}`);
    return next;
  }

  /** Refuse any path that does not resolve strictly inside the Library root. */
  private inside(p: string): string {
    const abs = resolve(p);
    if (!abs.startsWith(this.root + sep)) throw new Error("Path escapes the Library.");
    return abs;
  }
}
