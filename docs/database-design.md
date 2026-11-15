# Database design (proposal)

Status: proposal for review. Nothing here is implemented yet. Backwards
compatibility is out of scope: existing workspaces are discarded and data comes
back in through the Roam import.

## Why redesign

The current workspace database started as the NativePHP app's Laravel schema
and had the Loro tables added on top. What that left behind:

- **One `nodes` table for everything.** Pages, blocks and the hidden system
  roots (pins, preferences, collapsed state) share it. Pages are rows with
  `parent_id IS NULL`, so most queries carry `LIVE_PAGES_SQL` to exclude the
  system roots.
- **Soft deletes in a cache.** Every query filters `deleted_at IS NULL`, and
  `isReachable()` walks parents to hide blocks under deleted ancestors. But
  `nodes` is a projection of the Loro documents, and history lives in Loro, so
  deleted rows serve no purpose.
- **Operation-log leftovers.** `field_clocks`, `purged`, `modified_at` (once an
  HLC), `page_visits` (superseded by navigation history), `sync_state`'s
  `cloud_seed_pending`, and the Laravel-shaped `created_at`/`updated_at`
  strings on every row.
- **Recursive walks for things a column could answer.** Backlinks walk the
  parent chain with a recursive CTE to find each block's page title, and
  `DocumentService` walks parents to find a block's document, although the page
  (= document) of every block is known when it is projected.
- **System data shaped like notes.** Pins, preferences and collapsed blocks
  are trees of hidden nodes under per-user roots, so a theme is a node whose
  content is `"dark"`. That was the only way to sync them in the op-log design.
  With Loro, they can be maps and lists in a document of their own.
- **Device state mixed into synced data.** `media.cloud_uploaded_at` is this
  device's upload progress, stored on rows that are a projection of shared data.
  The cloud token sits in every workspace database (`sync_state.cloud_token`)
  as well as the account file.

## Principles

1. **Loro documents are the only source of truth** for anything that syncs.
2. **The read model is a cache.** It's shaped for the queries the app runs,
   holds only live data, and can always be rebuilt from the documents.
3. **No migrations before launch.** Until there's data worth keeping, the
   schema has one version: a workspace database with a different version is
   set aside and a fresh one created, and data comes back through the Roam
   import. After launch, schema changes will need migrations. Because the read
   model can be rebuilt from the documents, only the storage and device-state
   tables will need real migrations; a read-model change can bump its version
   and re-project instead. The schema version stays in `PRAGMA user_version`
   so migrations can start from it.
4. **Device state is kept apart** from both, and never synced.
5. **One table per kind of thing**, with the columns its queries need.

## Layout

### Documents (synced)

| Document | Id | Contents |
| --- | --- | --- |
| Page | the page id | Page fields (title, kind, daily date, deleted flag) and the movable block tree with rich text per block. Unchanged from today. |
| Media | `media` | File metadata, keyed by id. Unchanged. |
| User | `user:<user id>` (`user:local` before sign-in) | **New.** `preferences` (LoroMap: theme, font family, font size, workspace storage), `pins` (LoroMovableList of page ids), `collapsed` (LoroMap block id → true). Replaces the three hidden node trees. |

Each user in a shared workspace has their own user document, so pins and
collapsed state stay personal, as they are today. On sign-in, `user:local`
is merged into the signed-in user's document, replacing today's "adopt the
local root" step.

User documents are small, so the app reads them straight from the in-memory
Loro document. They get no read-model tables. The cloud relay needs no change:
it stores opaque updates per document id, and a `user:…` document is just
another id.

### Per-workspace SQLite

One file per workspace, as today, with three groups of tables.

#### Storage: the documents

```sql
CREATE TABLE documents (
    id            TEXT PRIMARY KEY,
    snapshot      BLOB,            -- compacted state, NULL until the first compaction
    snapshot_seq  INTEGER NOT NULL DEFAULT 0  -- updates up to this seq are in the snapshot
);

CREATE TABLE document_updates (
    seq           INTEGER PRIMARY KEY,           -- local order
    document_id   TEXT NOT NULL REFERENCES documents(id),
    update_id     TEXT NOT NULL UNIQUE,          -- idempotency across devices
    origin        TEXT NOT NULL,                 -- window or device that made it
    bytes         BLOB NOT NULL,
    cloud_seq     INTEGER,                       -- NULL = not pushed yet
    created_at    INTEGER NOT NULL               -- unix ms
);
CREATE INDEX document_updates_document ON document_updates (document_id, seq);
CREATE INDEX document_updates_outbox ON document_updates (seq) WHERE cloud_seq IS NULL;
```

These are the only tables whose loss means data loss; everything else can be
rebuilt from them.

#### Read model: rebuilt from documents

```sql
CREATE TABLE pages (
    id          TEXT PRIMARY KEY,              -- = its document id
    title       TEXT NOT NULL COLLATE NOCASE,  -- case-insensitive lookups use the index
    kind        TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'daily')),
    daily_date  TEXT,                          -- YYYY-MM-DD for daily notes
    created_at  INTEGER NOT NULL,              -- unix ms
    updated_at  INTEGER NOT NULL               -- last change to the page or its blocks
);
CREATE INDEX pages_recent ON pages (updated_at DESC, id);
CREATE INDEX pages_title ON pages (title);

CREATE TABLE blocks (
    id       TEXT PRIMARY KEY,
    page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    text     TEXT NOT NULL                  -- plain text: search, backlinks, references, embeds
);
CREATE INDEX blocks_page ON blocks (page_id);

CREATE TABLE links (
    source_block_id  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_id        TEXT NOT NULL,         -- a page or a block
    PRIMARY KEY (source_block_id, target_id)
) WITHOUT ROWID;
CREATE INDEX links_target ON links (target_id);

-- Full-text index over blocks.text; the text itself is stored once, in blocks
CREATE VIRTUAL TABLE block_search USING fts5(
    text, content = 'blocks', content_rowid = 'rowid', tokenize = 'trigram'
);

CREATE TABLE media (
    id             TEXT PRIMARY KEY,
    hash           TEXT NOT NULL,           -- sha256: the file's name on disk and in the cloud
    original_name  TEXT NOT NULL,
    mime_type      TEXT NOT NULL,
    size           INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
);
CREATE INDEX media_hash ON media (hash);
```

Each table holds only what some query reads:

- **`blocks` has no structure.** Block order, nesting, checkboxes and rich
  text live in the Loro document, which is what the page view renders. Search,
  backlinks and references need only a block's text and its page.
- **No timestamps on blocks.** No list shows them; "newest first" in search
  orders by the page's `updated_at`.
- **Titles match case-insensitively through the index** (`COLLATE NOCASE`, which
  folds ASCII letters only, as the code does today), so there's no separate
  normalised column.
- **Search indexes `blocks.text` in place** (an external-content FTS table)
  instead of keeping a second copy. Page titles are matched on `pages` with
  `LIKE`, which is fast at a few thousand rows.

- **Hard deletes.** A deleted page or block is simply absent. No
  `deleted_at`, no reachability walks. Restoring goes through Loro history.
- **`page_id` on every block** replaces the recursive walks: backlinks join
  `links → blocks → pages`, and a block's document is `blocks.page_id`.
- **No system rows.** Pins, preferences and collapsed state leave this database
  (see the user document), so page queries need no exclusions.
- **The projector writes the search index** together with the rows, instead
  of triggers keeping it in step.
- **Timestamps are integer milliseconds since the Unix epoch (UTC),** as
  JavaScript's `Date.now()` gives them, instead of three text formats
  (Laravel's database and JSON formats, and ISO). One unambiguous, sortable
  format with millisecond precision; `sqlTimestamp`, `jsonTimestamp` and
  `modifiedTimestamp` go. In a database browser, read them with
  `datetime(created_at / 1000, 'unixepoch')`. Calendar dates
  (`pages.daily_date`) stay `YYYY-MM-DD` text: they're days, not moments.

#### Device state: never synced

```sql
CREATE TABLE meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
) WITHOUT ROWID;
-- device_id, cloud_cursor, cloud_last_attempt_at,
-- cloud_last_success_at, cloud_last_error

CREATE TABLE uploaded_blobs (
    hash  TEXT PRIMARY KEY                  -- the cloud has this file
) WITHOUT ROWID;

CREATE TABLE navigation_locations (
    id              TEXT PRIMARY KEY,
    user_key        TEXT NOT NULL,          -- whose history (cloud:<id> or local)
    parent_id       TEXT,
    url             TEXT NOT NULL,
    page_id         TEXT,
    block_id        TEXT,
    cursor_offset   INTEGER,
    selection_type  TEXT,
    scroll_top      INTEGER NOT NULL DEFAULT 0,
    visited_at      INTEGER NOT NULL,
    last_visited_at INTEGER NOT NULL
);
CREATE INDEX navigation_tree ON navigation_locations (user_key, parent_id);
CREATE INDEX navigation_recent ON navigation_locations (user_key, last_visited_at);

CREATE TABLE navigation_current (
    user_key     TEXT PRIMARY KEY,
    location_id  TEXT
) WITHOUT ROWID;
```

- **`meta` replaces `sync_state`.** Pairing is a fact about the account and
  the workspace id, so the cloud URL and token stay in the account file only.
- **`uploaded_blobs` replaces `media.cloud_uploaded_at`.** Upload progress is
  this device's business, and keying it by hash matches how files dedupe.
- **Recent pages come from navigation history**, so `page_visits` goes.

### App-level files (unchanged)

`workspaces.json` (the workspace list), `settings.json` (key bindings per
user) and `cloud-account.json` (session) stay as JSON files in the data
folder. They're small, app-wide, and written rarely.

## How today's queries map

| Need | Today | Proposed |
| --- | --- | --- |
| All pages, most recent first | `nodes` + `LIVE_PAGES_SQL` + `deleted_at IS NULL` | `SELECT … FROM pages ORDER BY updated_at DESC, id` |
| Title exists / find by title | `LOWER(content) = ?` over pages | `WHERE title = ?` (indexed, case-insensitive) |
| Page tree | recursive CTE from the page, sent next to the Loro document and then unused | not needed: the view renders from the Loro document; the route sends the page's fields and the document |
| Backlinks with page titles | links + recursive ancestor walk | `links JOIN blocks JOIN pages` |
| Block reference / embed | `findNode` + `isReachable` + `isSystemNode` | `blocks WHERE id = ?` (present means live) |
| Search | FTS over `nodes.content` + `LIKE` fallbacks + parent walks for each match's page | FTS over `blocks.text` joined to `pages`; titles by `LIKE` on `pages` |
| Recent pages | `page_visits` | navigation history, newest first |
| Daily note for a date | `page_type`/`daily_note_date` scan | by id: daily-note ids are derived from the date |
| Pins, preferences, collapsed | hidden node trees + per-user roots | the user document |
| A block's document | parent walk in `DocumentService` | `blocks.page_id` |

## What goes away

- Tables: `nodes`, `node_links`, `page_visits`, `sync_state`,
  `navigation_history_states`, `node_search` and its triggers.
- Columns: `field_clocks`, `purged`, `modified_at`, `deleted_at`,
  `document_id` (now implied), `tiptap_content` (nothing reads rich text from
  the cache: the editor renders from the Loro document, and references and
  embeds show plain text), `is_checked` as `tinyint(1)`.
- Code: `LIVE_PAGES_SQL`, `isReachable`, `isSystemNode`, `SystemNodes`,
  `accountRoots.ts` (local/cloud root adoption becomes a document merge),
  `DocumentService.rootResolver`, the `node.set`/`node.delete` "op shape"
  used by the importer and the HTTP façade (callers write Loro directly or go
  through page/block functions), migration steps 1–3,
  `loadNodeTree` and the duplicate block tree the page route sends next to
  the Loro document (the view renders from the document and uses only the
  page's own fields), and `GET /api/pages/{id}`, which nothing calls.

## Rebuilding the read model

`rebuildReadModel(db)`: in one transaction, delete every read-model row, load
each document from `documents`/`document_updates`, and project it.

Before launch it isn't needed at startup. It exists as a test that the
projection is complete (project as edits happen, rebuild from scratch,
compare) and as a repair tool if the read model is ever suspected of
drifting. After launch it is how read-model changes ship: bump the version,
rebuild on first start.

## Implementation plan

1. The schema above, created in one step with its version in
   `PRAGMA user_version`. The old migration steps go; the small runner can
   stay for post-launch migrations. Until launch, opening a workspace
   database with a different version moves it aside (renamed with a `.old`
   suffix, never deleted) and creates a fresh one.
2. Projector writes `pages`, `blocks`, `links`, `search`, `media`, with hard
   deletes; `rebuildReadModel` and its round-trip test.
3. Rewrite the services against the new tables: page list, page tree,
   backlinks, references, search, daily notes, navigation history and recent
   pages.
4. The user document: preferences, pins and collapsed state, the sign-in
   merge, and their routes.
5. Device state: `meta` and `uploaded_blobs` in cloud sync and blob sync.
6. Remove the op shape: the Roam importer and `POST /api/nodes` write through
   page/block functions.
7. Clean up the HTTP layer that mirrored Laravel models (e.g. `serializeNode`
   output with Eloquent field names), once the renderer reads the new shapes.

Each step keeps the unit and end-to-end suites green; the end-to-end tests
describe behaviour, not tables, so they guard the whole change.

## Open questions

1. **One file or two per workspace.** Splitting storage (`documents.sqlite`)
   from the read model and device state (`cache.sqlite`) makes "delete the
   cache" a file delete, but costs cross-file consistency when writing a
   document and its projection together. This proposal keeps one file.
2. **Richer embeds.** Embeds show the target block's plain text, so
   formatting inside it is lost. If that matters, render embeds from the
   target page's Loro document (the renderer can already open one), not from
   a rich-text copy in the cache.
