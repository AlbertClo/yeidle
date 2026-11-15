# Yeidle on Loro: architecture

Status: desktop implemented in `apps/electron` + `packages/core` (phases 1–3
below), and cloud sync with media files and live cursors (phase 4); history
and mobile not started. Supersedes the earlier op-log engine and the unmerged
`feat/crdt-sync-history` branch (Yjs).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Sync model | One CRDT (Loro) for all content | One merge model for outlines, future spreadsheets, and long-form documents, instead of last-write-wins plus a separate text CRDT |
| Local logic | A shared TypeScript core | Loro, the editor, and the read model all run in JavaScript, so desktop and mobile share one implementation |
| Desktop shell | Electron | The same Chromium everywhere, which matters for a ProseMirror-heavy app; NativePHP is removed |
| Mobile shell | Capacitor | The most mature WebView shell on mobile, with the largest plugin ecosystem (SQLite in particular) |
| Cloud | Laravel (`apps/web`) | Accounts, passkeys, device sign-in, and workspace membership already work there; the cloud stores and relays Loro updates without reading them |

Tauri 2 was considered. It's production ready on desktop and usable on
mobile, but it uses WebKitGTK on Linux, and its mobile support is younger
than Capacitor's. Because the core lives in the web layer, the app shell can
still be swapped later.

## Overview

```
┌──────────────── Electron (desktop) ────────────────┐  ┌──── Capacitor (iOS/Android) ────┐
│ Renderer (per window)        Main process          │  │ WebView                         │
│  Vue + TipTap editor   IPC   Core (TypeScript)     │  │  Vue + TipTap editor            │
│  live LoroDoc per page ───►  ├ document store      │  │  Core (same TypeScript)         │
│                              ├ read model (SQLite) │  │   └ SQLite via plugin           │
│                              ├ queries             │  └───────────────┬─────────────────┘
│                              └ sync client ─────────────────┐         │
└─────────────────────────────────────────────────────┘        │         │
                                                               ▼         ▼
                                   ┌───────────── Laravel cloud (apps/web) ─────────────┐
                                   │ accounts · passkeys · device sign-in · workspaces  │
                                   │ document_updates (opaque) · snapshots · blobs (R2) │
                                   │ Reverb: updates.committed · presence (cursors)     │
                                   └────────────────────────────────────────────────────┘
```

## Documents

Every page gets its own Loro document, with the page's id as the document
id. Media metadata lives in one `media` document, and each user's personal
state (preferences, pins, collapsed blocks) in a `user:<id>` document. See
[database-design.md](database-design.md) for the documents and the SQLite
tables around them.

A page document contains:

- **`page` map:** `title`, `page_type`, `daily_note_date`, `created_at`, and
  `deleted`. Each field is last-writer-wins.
- **`blocks` tree:** a Loro movable tree whose roots are the page's
  top-level blocks. Each tree node's data map holds:
  - `id`: the block UUID, which block references and links use.
  - `text`: a Loro rich text with the block's content (see below).
  - `checked`: absent, `false`, or `true`.
  - `created_at`.

Tree order is authoritative; the read model stores no block structure.

### Block content encoding

TipTap content becomes one rich text per block. The encoding follows Quill's
delta format, so concurrent typing merges character by character:

- **Textblocks** (paragraph, heading, code block): their characters, then a
  `U+2029` terminator carrying a `block` mark of `{type, attrs}`.
- **Inline atoms** (mention, web link, hard break, block reference): one
  `U+FFFC` character carrying an `inline` mark of `{type, attrs}`.
- **Text marks:** `m_<type>` with the mark's attrs, or `true`. Loro style keys
  can't contain `:`.
- **Blocks without inline content** (file node, horizontal rule, block embed,
  blockquote): stored whole in the `block` mark of a bare terminator. They
  merge last-writer-wins.

Implemented and tested in `resources/js/loro/richText.ts`.

### How concurrent edits resolve

| Situation | Result |
| --- | --- |
| Two devices type in the same block | Both edits kept, merged by character |
| Formatting applied while someone types | Both kept |
| Concurrent moves or indents of the same block | One placement wins; the block appears exactly once |
| Moves that would form a cycle | Loro resolves deterministically |
| Block deleted while another device edits it | **Delete wins.** The edit survives only in history (see History) |
| Same block id created on two devices | The duplicate gets a new id on the next write; both are kept |
| Page title or a checkbox set concurrently | Last writer wins |
| Daily notes | Deterministic page ids, so both devices write into the same document |
| Moving a block to another page | Copy plus delete across two documents, written in one local transaction |

## The TypeScript core

The core is plain TypeScript and contains no DOM or Electron code. It uses
two adapters: `Database` (async SQLite) and `Transport` (HTTP to the cloud).

| Module | Responsibility | Status |
| --- | --- | --- |
| `loro/richText` | TipTap content ↔ Loro rich text, with minimal-diff edits | Done, tested |
| `loro/pageDoc` | Block tree ↔ Loro tree, with the fewest moves | Done, tested |
| `loro/pageMeta`, `loro/mergeBlocks` | Page fields; merging imported blocks into a page | Done |
| `loro/projection` | Document → rows for the read model | Done |
| `store` | Snapshot plus append-only update log per document; compaction | Port from `app/Documents/DocumentStore.php` |
| `readModel` | Writes the `pages`, `blocks`, `links`, `media`, and FTS5 `block_search` tables from rows | Done |
| `queries` | Page list, page tree, backlinks, references, search, recent pages | Port from `app/Services/*`, `app/Search/NodeSearch.php` |
| `workspace` | Pins, collapsed blocks, preferences, daily notes, page creation | Port from `app/Support/*`, `app/DailyNotes/*` |
| `sync` | Cloud push, pull, bootstrap, realtime, blob transfer | New; replaces `CloudSyncService.php` |
| `import/roam` | Roam JSON → page documents | Port from `app/Import/Roam/*` |

### Where the core runs (as built)

On desktop the core runs in Electron's main process as an app server behind
the `yeidle://` protocol. It answers the same JSON API and Inertia page
protocol the Laravel app served, so the Vue frontend moved over nearly
unchanged. SQLite is `node:sqlite` (FTS5 trigram included; no native
module). Windows edit live Loro documents and send updates over the API;
the main process stores them, re-projects the read model and broadcasts
which documents changed.

### Where the core runs (original plan)

- **Electron:** in the main process (or a utility process), using
  `better-sqlite3`. The core is the single writer for every window: a window
  sends Loro updates over IPC, and the core imports them, writes the read
  model, and notifies the other windows. This removes the stale-projection
  problem that a multi-writer setup has.
- **Capacitor:** in the WebView, calling SQLite through the plugin. There is
  one window, so the core and the editor share a process.

### Data flows

**Local edit**

1. The editor emits its block tree.
2. `applyBlocks` writes the minimal changes to the window's live `LoroDoc`.
3. The window exports the update and sends it to the core.
4. The core appends the update, refreshes the read model, and notifies the
   other windows.
5. The sync client pushes the update to the cloud.

**Remote change** (another window, or the cloud)

1. The core stores and projects the update.
2. It notifies the windows that have that document open.
3. Each window first applies its own pending editor changes to its doc, then
   imports the update.
4. The window applies the result to TipTap:
   - **Content-only changes:** a minimal ProseMirror replace, found with
     `findDiffStart` and `findDiffEnd`, so the cursor maps through it.
   - **Structural changes:** a remount that restores the selection bookmark.

   The editor and the document stay equal, so the next local diff can never
   undo a remote change.

**Page open:** the page route sends the page's fields and its document
(snapshot plus newer updates); the editor renders from the document.

## Cloud (Laravel)

This keeps `apps/web` and removes `OpApplier`, HLC, the `ops` table, and the
cloud's copies of `nodes`, `node_links`, and `media`.

### Tables (Postgres)

- **`document_updates`:**
  - Columns: `server_seq` (bigserial cursor), `workspace_id`, `document_id`,
    `update_id` (unique), `bytes` (bytea), `user_id`, `device_id`,
    `created_at`.
  - Append-only. It also serves as backup and history.
- **`document_snapshots`:** `workspace_id`, `document_id`, `bytes`,
  `covers_seq`, `uploaded_by`. Uploaded by clients.
- **Isolation:** every row is scoped to its workspace; the same document id
  (for example the `media` document) in two workspaces is two documents.

### API

All routes are `auth:sanctum` and require workspace membership.

| Endpoint | Purpose |
| --- | --- |
| `POST /workspaces/{ws}/documents/updates` | Push a batch. Idempotent per `update_id`; assigns `server_seq`; broadcasts |
| `GET /workspaces/{ws}/documents/updates?since=&exclude_device=` | Pull in pages, capped by count and bytes; returns the next `cursor` |
| `GET /workspaces/{ws}/documents/status` | Log position, user id, and public Reverb settings (pairing probe) |
| `GET /workspaces/{ws}/bootstrap` | Not built yet: latest snapshots, plus the updates after them |
| `POST /workspaces/{ws}/snapshots` | Not built yet: upload a compacted snapshot covering a `server_seq` |
| Blob endpoints | Unchanged: content-addressed, presigned R2/S3 URLs |

As built, update ids are unique per workspace (`(workspace_id, update_id)`),
so no cross-workspace document ownership table is needed. Bytes travel as
base64 in JSON and are stored as `bytea`.

### Realtime (Reverb)

- **`private-workspaces.{id}.sync`:** `updates.committed`, a hint carrying
  the new log position; clients pull after receiving it.
- **`presence-documents.{id}`:** live cursors and "who's here", sent as
  client whispers carrying Loro ephemeral-state bytes. Never stored.

### What the cloud does not do

It never decodes documents. Sync needs nothing more, and it keeps Loro out of
PHP. When a web view, server-side search, AI agents, or validated compaction
are needed, a **document reader** is added. Agents write through it as
ordinary Loro updates in the same log. It can be either:

- a small Node service using Loro WASM, or
- a Rust PHP extension wrapping the `loro` crate. This needs hosting that
  allows custom extensions.

## History

Loro documents carry their full history.

- **Page history:** `getAllChanges` lists changes with peer, timestamp, and
  commit message. Peers map to a device and user through a `peers` map in
  the `page` document, or a cloud lookup.
- **Preview:** `forkAt` or `checkout` at a version.
- **Restore:** `revertTo(frontiers)` creates a new change, which syncs and can
  itself be undone.
- **Deleted blocks and pages:** remain recoverable through restore.
- **Server log:** the cloud keeps every update, so history survives even if
  local documents are compacted with shallow snapshots.

## The NativePHP app

The NativePHP app and its operation-log sync are retired and deleted. Its
workspaces aren't carried forward; data comes in through the Roam import.

## Phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 0. Spike (1–2 days) | Electron + Vite + Vue + TipTap + Loro + `better-sqlite3`. A Capacitor shell with the same editor on the iOS and Android simulators | Typing, selection, IME, and paste feel right in iOS WebKit; FTS5 works in the Capacitor SQLite plugin |
| 1. Core | `store`, `readModel`, `queries`, `workspace`; vitest against in-memory SQLite | Parity tests with the current PHP feature tests |
| 2. Desktop | Electron shell, IPC, and routing (Inertia replaced with vue-router); `PageEditor` wired to live documents; multi-window | Daily-driver parity with the NativePHP app, locally |
| 3. Import | Roam importer port | The real Roam graph imports |
| 4. Cloud | `apps/web` relay rewrite; sync client; Reverb; blobs | Two desktops converge live; offline edits merge |
| 5. History | Page history panel: list, preview, restore | Recover a block deleted by a concurrent edit |
| 6. Mobile | Capacitor app on the core: SQLite, share sheet, foreground sync | Daily use on a phone |

**Switching off Roam** becomes possible after phase 3, using local-only
storage with a backup. Phase 4 follows.

## Risks and open questions

- **Editor on iOS WebKit:** contenteditable quirks around the custom
  keyboard handling, atom nodes, and IME. The spike exists to answer this
  first.
- **Capacitor SQLite and FTS5:** confirm that the community plugin is built
  with FTS5 (trigram tokenizer). Otherwise search needs another index on
  mobile.
- **`better-sqlite3` native rebuilds:** it must be rebuilt for each Electron
  version. `node:sqlite` is the fallback if that becomes painful.
- **Document growth:** history accumulates. Plan periodic shallow snapshots
  locally, with the cloud's update log as the long-term archive.
- **Delete wins over a concurrent edit:** acceptable with history. Revisit if
  it surprises users in practice.
- **Client-provided snapshots:** fine within a workspace's own members. The
  document reader can validate them later.
- **Duplicate page titles across devices:** stay an advisory warning, as
  today. A merge-pages tool could come later.
- **Laravel Cloud:** check that Reverb, Postgres, Redis, and object storage
  are available as managed services. A Rust extension would need a
  different host.
