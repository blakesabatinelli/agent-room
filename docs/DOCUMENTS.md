# Document standard

Every document an agent produces for the owner is a Markdown file with YAML front matter, stored in the **Library**, a plain folder on the owner's Mac. The folder is the source of truth. The hub keeps a SQLite index of it for lookups. Google Drive is only a location choice: point the Library at a folder synced by Google Drive for Desktop and no other code path is needed.

## Format

```markdown
---
id: doc_3f9a1c20b4d85e17
title: "Q4: competitive read"
room: competitive
goal: goal_a1b2c3d4e5f60718
status: draft
authors: [claude, codex]
created: 2026-10-23
updated: 2026-10-24
sources: [https://example.com/taiv, notes.md]
tags: [taiv]
---

# Body in Markdown
```

Strings are bare when plain, and JSON double-quoted when they contain `:`, `#`, quotes, commas, brackets, or look like a number or boolean. Lists are inline: `[a, b]`.

| Field | Type | Rule |
|---|---|---|
| `id` | string | `doc_` plus 16 hex characters. Assigned once, never changes. |
| `title` | string | 1-200 characters, one line. |
| `room` | string | The room's slug (its folder name). |
| `goal` | string, optional | The goal id. Absent for documents saved outside a goal. |
| `status` | `draft` \| `review` \| `final` | Defaults to `draft`. |
| `authors` | string[] | Agent ids, oldest first. At least one. |
| `created` | `YYYY-MM-DD` | Set on first save, never changes. |
| `updated` | `YYYY-MM-DD` | Set on every save. |
| `sources` | string[] | URLs, file paths or document ids the document draws on. May be empty. |
| `tags` | string[], optional | Free labels. |

## Layout and naming

```
<Library>/<room-slug>/<goal-id or "general">/YYYY-MM-DD-<title-slug>.md
<Library>/<room-slug>/<goal-id or "general">/assets/
```

- The Library root is `$AGENT_ROOM_LIBRARY`, else `~/Agent Room/Library`.
- Slugs are lowercase `[a-z0-9-]`, at most 60 characters, never empty (`untitled` is the fallback). A title like `../../etc/passwd` becomes `etc-passwd`.
- The date in the file name is the day the document was first saved. The goal folder is the goal id, which may also contain `_`.
- The `assets/` folder beside the documents holds images and attachments the Markdown links to. The hub creates it.
- Every final path is checked to resolve inside the Library root. Anything else is refused.

## Update rules

Saving a document with the same room, goal and title slug **updates** it instead of creating another file:

- `id` and `created` are kept, `updated` is set to today.
- `authors` and `sources` are unioned with the existing values, without duplicates.
- `status` changes only when the caller gives one. `tags` are replaced when given and kept when omitted.
- The body is replaced. The file keeps its original name even when the update happens on a later day.
- Any front matter the caller puts at the top of the body is discarded. The hub owns the front matter.
- Writes are atomic: a temporary file in the same folder, then a rename.

## How agents save documents

Agents never write documents to arbitrary paths. They call the hub's MCP tool:

```
save_document { title, body, status?, sources?, tags?, goalId? }
  -> {"id": "doc_...", "path": "/abs/path.md", "relPath": "room/goal/2026-10-23-title.md", "created": true}
list_documents { roomId?, goalId? }
  -> one line per document: relPath | title | status
```

The room comes from the agent's grant and the goal from its current task (an explicit `goalId` overrides it). The author is always the calling agent. Each save is recorded in the audit log as `document.saved`.

The owner's apps read the index with `GET /documents?roomId=&goalId=` (device auth), which returns the indexed `LibraryDoc` records.

## Code

- Types: `DocFrontMatter`, `DocStatus`, `LibraryDoc` in `packages/shared/src/index.ts`.
- Front matter emit, parse, split and validate: `packages/hub/src/library/frontmatter.ts`.
- Library and layout: `packages/hub/src/library/library.ts`. Index: `documents` table in `packages/hub/src/db/store.ts`.
- Tests: `packages/hub/test/library.test.ts`.
