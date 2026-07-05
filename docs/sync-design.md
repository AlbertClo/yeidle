The design doc is written: docs/sync-design.md (repo root, since it spans the desktop app and the future
apps/web). What it covers:

- The two-layer model — transport (an append-only op log) separated from merging (granularity-appropriate
  strategies per data type), with a table mapping each kind of data to its merge strategy: field-level LWW for the
  node tree, fractional indexing for order (done), Yjs for rich text later, cell-level LWW for spreadsheets,
  immutable content-addressed blobs for media (done).
- Identity and ordering — op_id (idempotency + echo suppression), client_id, server_seq for delivery order, and
  HLC timestamps for conflict resolution. The key design decision: LWW by hybrid logical clock rather than
  Figma-style arrival order, because an offline-first app must not let a week-old op that arrives late clobber this
  week's edits.
- Op schema — node.set (field diffs, so a concurrent move and edit of the same node merge), node.delete,
  media.create, with field_clocks bookkeeping per node row and payload versioning from day one.
- The sync protocol — push/pull with cursor, snapshot bootstrap for new devices, and the Phase-0 trick: two local
  windows use the shared SQLite ops table as the transport, exercising the exact same apply path the cloud will use.
- The genuinely hard part, applying remote ops to a live TipTap editor — targeted transactions by blockId, never a
  rebuild, dirty-node deferral, and history exclusion.
- Cloud server shape (Laravel apps/web, Reverb, projections, Sanctum token), media as cache over blobs/{sha256},
  the Yjs upgrade path scoped to text only, and why spreadsheets need nothing beyond what Phases 0–1 build.
- A 5-phase plan with exit criteria, alternatives considered (all-in Yjs, off-the-shelf engines, arrival-order
  LWW, OT), and open questions (delete-vs-edit semantics, tombstone retention).

Worth reading with a critical eye before we build anything: the two decisions I'd most want your sign-off on are
HLC-based LWW (adds a clock implementation, buys correct offline merges) and field-diffs replacing full payloads
in ops (reverses part of the batch-endpoint simplification, buys cross-field merging). Happy to adjust either, or
start on Phase 0 when you're ready.

---


# Sync & Collaboration Design

Status: draft, 2026-07-05
Branch: `explore/syncing`

This document describes how Yeidle moves from a single-instance local app to
multi-device cloud sync and real-time collaboration, and how spreadsheets fit
into that architecture later.

## 1. Goals

- **Multi-device sync**: edits made on any device converge on all devices.
- **Offline-first**: every device is fully usable offline; changes sync when
  connectivity returns. The local SQLite database remains the source the app
  reads from — the cloud is a relay and backup, never a required dependency.
- **Multi-instance safety**: two windows/instances on one machine converge
  live (today they silently clobber each other at node granularity).
- **Real-time collaboration**: Google Sheets-like liveness — remote changes
  appear within ~a second, concurrent edits merge instead of losing data.
- **Spreadsheets later**: a future spreadsheet node type must fit the same
  sync model without a redesign.
- **Media**: blobs sync by content hash; the local media directory becomes a
  cache over cloud storage.

Non-goals (for now): peer-to-peer sync, end-to-end encryption, per-page
permissions, operational-transform servers.

## 2. Current state (what we build on)

The local sync pipeline, as of `explore/tiptap` merged to main:

- TipTap editor emits the full node tree; `Show.vue` diffs it against a
  `lastNodeMap` snapshot and produces **upserts** (full node payloads,
  pre-order: parents before children) and **deletes** (top-most subtree
  roots only).
- One transactional request per debounce: `POST /api/nodes/batch` applies
  upserts then deletes, all-or-nothing. Upserts are idempotent (create,
  update, or restore a trashed row). Snapshots commit client-side only on
  success; failures retry with backoff.
- **Fractional-indexing positions** (`fractional-indexing` strings): moving
  a node changes only that node's position. Concurrent reorders of the same
  sibling list merge without renumbering.
- **Content-addressed media**: blobs stored as `media/{sha256}`, metadata in
  the `media` table, many rows may share one blob.

These choices were made with this document in mind: the batch payload is one
server-assigned sequence number away from being an operation log, fractional
indexing is the ordering strategy that survives concurrency, and hash-keyed
blobs sync trivially.

## 3. The two-layer model

"Sync" hides two different problems with different solutions:

1. **State synchronization** — transporting changes between instances and
   converging after offline periods. Solved with an **append-only operation
   log** plus idempotent, commutative-enough application.
2. **Concurrent-edit merging** — what happens when two clients change the
   *same thing* simultaneously. The answer depends on granularity:

| Data | Granularity | Merge strategy |
|---|---|---|
| Node tree (create/delete/move/check) | per field | Last-writer-wins per field, HLC-ordered |
| Sibling order | per node | Fractional indexing (already done) |
| Rich text within a node | per character | LWW per node initially; Yjs CRDT in Phase 3 |
| Spreadsheet cells (future) | per cell | LWW per cell |
| Media blobs | whole blob | Immutable, content-addressed — no conflicts |

The guiding precedent is Figma's multiplayer architecture: property-level
LWW plus fractional indexing covers structured data without CRDTs. CRDTs
(Yjs) are reserved for the one place LWW visibly loses work: two cursors
typing in the same text block. Google Sheets' feel comes from cell-level
granularity + liveness, not from character merging — which is why
spreadsheets are the *easy* case here.

## 4. Identity and ordering

- **`client_id`**: UUIDv7, **one per independent HLC generator** — that is
  the invariant, not "per installation": no two clocks may share a
  client_id, or HLC tie-breaking breaks. Concretely: each desktop *window
  session* mints an ephemeral client_id at open (so monotonicity only has
  to hold within a session — no cross-restart clock persistence needed);
  the extension holds a persistent one (its outbox survives restarts, so
  its clock persists too); and each *server* (local Laravel, cloud later)
  has its own, because servers originate writes of their own —
  `LinkParser`'s auto-created wikilink pages mint ops like everyone else.
  Used for HLC tie-breaking and diagnostics.
- **Every writer writes ops.** Frontends mint complete ops (op_id, HLC,
  payload) and push them; the local server accepts op pushes exactly like
  the cloud server will — same contract, applied through the single
  op-apply function. The desktop frontend is just the first client of the
  protocol the extension and cloud sync will use. HLC *generation* is
  implemented twice (a small shared JS lib for frontends/extension, and
  PHP for server-originated writes); HLCs are lexicographically comparable
  strings so *comparison* is plain string ordering everywhere, and both
  implementations are pinned by a shared test-vector file.
- **`op_id`**: UUIDv7 per operation. Global idempotency key — the server and
  clients ignore ops they have already applied or generated. This, not
  client_id, is the echo-suppression mechanism (and each window trivially
  knows its own ops, having minted them).
- **`server_seq`**: monotonic integer assigned by the cloud server when it
  accepts an op. Defines the canonical log order and the client sync cursor.
  Locally (Phase 0, no cloud), a SQLite AUTOINCREMENT column plays this role.
- **`hlc`**: a Hybrid Logical Clock timestamp (`wall-clock ms · counter ·
  client_id`, lexicographically comparable). Attached to every op at creation
  time.

**Why both `server_seq` and `hlc`?** Server order determines *delivery*, but
not *who wins*. A device offline for a week pushes old ops late; with
arrival-order LWW those stale ops would clobber this week's edits. LWW
comparisons therefore use the **HLC**: an op only overwrites a field if its
HLC is greater than the HLC that last wrote that field. HLCs bound
clock-skew problems (they never run backwards, and receive-events ratchet
the clock forward), and ties break deterministically by client_id.

## 5. Operation schema

Ops are small JSON records. One table stores them everywhere (local desktop
DB and cloud DB):

```
ops
  op_id       uuid primary key
  local_seq   integer autoincrement        -- local arrival order
  server_seq  integer nullable, indexed    -- null = not yet accepted by cloud (outbox)
  client_id   uuid
  hlc         string, indexed
  type        string
  payload     json
  created_at  datetime
```

`sync_state` (single row, local only): `client_id`, `last_server_seq`.

Op types, initial set:

```
node.set     { id, page_id, fields: { parent_id?, position?, content?, tiptap_content?, is_checked? } }
node.delete  { id, page_id }               -- soft delete, cascades to descendants
media.create { id, hash, original_name, mime_type, size }
```

Notes:

- `node.set` covers create, update, and restore — it is the op-log form of
  today's idempotent upsert. **Fields go back to being diffs** (only what
  changed), unlike the current full-payload batch: field-level LWW requires
  knowing which fields an op actually touched. Creation is just a `node.set`
  whose fields happen to be complete.
- `node.delete` cascade vs. concurrent moves: a delete only cascades to
  children whose `parent_id` (after HLC merge) still points inside the
  deleted subtree. A child concurrently moved out survives — same semantics
  the batch endpoint has today, now made explicit.
- Deletion is a field write too: internally `deleted_at` participates in LWW
  so that a delete and a concurrent edit resolve deterministically.
  **Decided: an edit with a newer HLC revives a deleted node** — content
  written on any device is never silently discarded by an earlier delete,
  matching the restore-on-upsert behavior the batch endpoint already has.
  Reviving a node also revives its deleted ancestors (with their old
  content), so the revived node is reachable; without this, an edit that
  outlives a subtree delete would resurrect an invisible orphan.
- **Tombstones and forced hard deletes**: ordinary soft-deleted nodes are
  retained for **at least 180 days**, and compacted only once every known
  client's cursor has passed the delete. A user-initiated hard delete before
  then is a distinct op, `node.purge { id }`, with deliberately special
  semantics — it is **terminal and exempt from HLC comparison** (any later
  op referencing a purged id is dropped, not merged; the one exception to
  "edits are never discarded"). Purge scrubs content everywhere but keeps a
  permanent id-only tombstone (~bytes) so resurrection by offline devices is
  impossible; the server also redacts that node's prior op payloads in the
  log (seq numbers keep their places, snapshots are rebuilt) and clients
  scrub locally on receipt. Media blobs are only GC'd when their last
  reference is gone — content-addressed dedup means a blob may outlive any
  one purged node. Honest limit: a device that never syncs again keeps its
  local copy; purge reaches every device that ever reconnects.
- `page_id` is the id of the top-level page containing the node (a page's
  own ops carry their own id). The client knows it for free at
  op-generation time; deriving it later would require a tree walk per op.
  Uses: the remote-op apply path (§7) can tell whether an op affects the
  currently open page without walking the tree, and Phase 2 presence and
  page-scoped subscriptions key on it.
- Payloads carry a `v` version field from day one so formats can evolve.
- Phase 3 adds `text.update { page_id, yjs_update: base64 }` (see §10).
- Phase 4 adds `sheet.set_cells { id, cells: { "B7": {...}, ... } }` (see §11).

### Per-field LWW bookkeeping

Applying `node.set` requires the HLC that last wrote each field. Stored in a
`field_clocks` JSON column on `nodes` (map of field name → HLC). Apply rule,
per field in the op: if `op.hlc > field_clocks[field]`, write the value and
the clock; otherwise skip. Node rows never conflict as wholes — an offline
device's "moved the node" merges cleanly with another device's "edited the
text" because they touched different fields.

## 6. Sync protocol

### Push (client → cloud)

```
POST /api/sync/push   { client_id, ops: [...] }
→ { accepted: [{ op_id, server_seq }, ...] }
```

- Server validates, assigns `server_seq` in arrival order inside a
  transaction, appends to the workspace log, updates its projection (§8),
  and acks. Already-seen `op_id`s are acked without re-applying (idempotent
  retry).
- Client marks acked ops with their `server_seq` (removing them from the
  outbox) — mirroring today's success-gated snapshot pattern.

### Pull (cloud → client)

```
GET /api/sync/pull?since={last_server_seq}
→ { ops: [...], latest_seq }
```

- Returns ops with `server_seq > since`, in order. Client applies each via
  the LWW rules, skips ops whose `client_id` is its own (echo) or whose
  `op_id` it already has, then advances `last_server_seq`.
- Polling first (Phase 1); Laravel Reverb WebSocket push later (Phase 2) —
  the WebSocket only carries "new ops exist / here are the ops"; the pull
  endpoint remains the source of truth and the catch-up path after offline.

### Snapshot bootstrap

A new device must not replay the whole log. The server keeps a materialized
projection (§8), so bootstrap is: download projection snapshot at
`server_seq = N`, set cursor to N, then pull normally. This also enables log
compaction later (drop ops below the oldest snapshot any client needs).

### Local transport (two instances, one machine)

Phase 0 needs no cloud: both instances share the local SQLite, so the `ops`
table itself is the transport. Each instance tails the table (poll
`local_seq > cursor` every ~1s, or a filesystem/NativePHP broadcast to
nudge) and applies every op whose `op_id` it didn't generate itself. This
phase exercises the exact code path (apply-remote-op → SQLite + live
editor) that cloud sync will use.

## 7. Applying remote ops to a live editor

The hard client-side problem. Local mutations keep today's pipeline
(editor → diff → ops → apply locally → outbox). Remote ops:

1. Apply to SQLite (LWW rules).
2. If the affected page is not open: update the in-memory page cache if
   present, done.
3. If the page is open: apply a **targeted TipTap transaction** — locate the
   list item by `blockId` and update only what changed (set attrs, replace
   the node's content fragment, or move the item for position/parent
   changes). Never rebuild the whole document: that destroys cursor, IME
   state, and undo history.
4. **Dirty-node rule**: if the node currently contains the user's selection
   or has unflushed local edits (present in the sync-pending diff), defer
   the remote update for that node until the local edit flushes; the HLC
   then resolves the winner. Everything else applies immediately. This is
   the honest cost of LWW-on-text — visible only when both sides edit the
   same block within the same flush window, and eliminated entirely by
   Phase 3.
5. Remote ops must not re-enter the diff pipeline: applying them updates
   `lastNodeMap` snapshots too (they are already persisted), reusing the
   existing `blockIdAssignment`-style transaction-meta guard so
   `onTransaction` ignores them.

Undo: local-only. TipTap's history already tracks local transactions;
remote transactions are marked `addToHistory: false`.

## 8. Cloud server

A new Laravel app (`apps/web`), which will eventually also serve the web
client. For sync it provides:

- `workspaces` (single personal workspace initially; the schema carries
  `workspace_id` from day one so sharing is additive later).
- `ops` log table per workspace (`server_seq` = per-workspace monotonic).
- **Projection tables** (`nodes`, `media`) maintained transactionally as ops
  are accepted — the same apply logic the desktop uses, shared as a package
  or duplicated deliberately. Used for snapshot bootstrap, and later for the
  web client and server-side search.
- Auth: personal access token in the desktop app's settings (Sanctum).
  Multi-user/sharing is out of scope until the collaboration phase.
- Realtime: Laravel Reverb broadcasting `workspace.{id}.ops` events
  (Phase 2).
- Blob storage: S3-compatible, keyed `blobs/{sha256}` (§9).

Postgres in production (concurrent writers, real durability); the op-log
design is engine-agnostic.

## 9. Media sync

Blobs are immutable and content-addressed, so this layer is conflict-free:

- **Upload**: after a local upload completes, the client asks
  `HEAD /api/blobs/{hash}`; on 404 it uploads (chunked, same pattern as the
  local upload). The `media.create` op flows through the normal log —
  metadata syncs like any other data; the blob body travels out-of-band.
- **Download / cache-miss**: `MediaController::show`/`open` check the local
  `media/{hash}` file; on miss, fetch `GET /api/blobs/{hash}` from the
  cloud, write it locally (verify the hash on write), then serve. The local
  media directory is now exactly the cache the roadmap wants.
- **GC**: local blobs unreferenced by any `media` row can be evicted;
  cloud-side GC needs tombstone-aware reference counting — deferred.

## 10. Phase 3 — real text collaboration (Yjs)

When simultaneous same-block typing matters (true collaboration, or heavy
two-device use), upgrade the text layer only:

- One **Y.Doc per page**, containing the page's TipTap document (the
  current editor already treats a page as one TipTap doc of nested list
  items — the mapping is direct). Editor binding via
  `@tiptap/extension-collaboration` / `y-prosemirror`.
- Yjs updates are commutative and idempotent — they don't need LWW, only
  delivery. They ride the same op log as `text.update` ops (opaque base64
  payloads); per-page Yjs snapshots stored server-side to bound replay,
  exactly parallel to §6's snapshot bootstrap.
- `content` (plain text) and `tiptap_content` become **derived projections**
  written on flush — backlinks (`LinkParser`), search, and the HTTP API
  keep working unchanged. This is the central lesson from `explore/crdt`:
  Yjs as the merge engine for text, *not* as the database.
- Tree-level ops (`node.set` for parent/position/checked, `node.delete`)
  stay in the LWW system. Yjs tree-moves are famously awkward; fractional
  indexing + field LWW is already correct and much simpler. The Y.Doc owns
  only what's *inside* each node's text.

This phase is deliberately last: it changes the editor's data flow, and
everything before it (log, transport, projections, presence) is
prerequisite infrastructure for it anyway.

## 11. Spreadsheets

A future `sheet` node type — a node whose content is a cell grid instead of
rich text:

- Storage: `sheet.set_cells` ops, cell-level granularity
  (`{ "B7": { raw: "=SUM(B1:B6)", ... } }`), merged per cell by HLC LWW —
  the Google Sheets model. Formula *evaluation* stays client-side and
  derived (never synced); only raw cell contents are data.
- Projection: a `sheet_cells` table (or JSON blob per sheet initially)
  parallel to `tiptap_content`.
- Rendering: a dedicated node view in the editor, or a page-level view —
  UI decision for later; the sync layer is ready either way.
- Concurrent edits to the *same cell* = last writer wins, which matches
  user expectations from Sheets. Presence (cell cursors, Phase 2's
  infrastructure) covers the rest of the collaborative feel.

No CRDTs needed. The op log + per-item LWW built in Phases 0–1 serves this
without modification — which is the strongest argument for that
architecture over an all-CRDT design.

## 12. Phased plan

Each phase ships something usable on its own.

**Phase 0 — local op log + multi-window convergence** *(desktop only)*
- **Convergence test harness first**: property tests asserting that any op
  set, applied in any delivery order, yields an identical projection —
  including delete-vs-edit revival, ancestor revival, and purge
  terminality. Injectable clock for HLC tests; shared HLC test-vector file
  pinning the JS and PHP implementations to each other. This harness is an
  exit gate for the phase.
- `ops` + `sync_state` tables; HLC implementations (JS + PHP, §4);
  `field_clocks` on nodes.
- **Genesis**: a migration stamps existing rows' `field_clocks` with an
  epoch HLC (any real edit wins over it); the log starts empty — current
  data simply *is* the snapshot at seq 0, no synthetic history. Phase 1's
  first upload is then a snapshot upload, not an op replay.
- Batch endpoint refactored into the op push contract: frontends mint and
  push complete ops; the server applies ops + projection in one
  transaction through the single op-apply function.
- Client diff emits field-level ops instead of full payloads. Outbox ops
  not yet pushed may be coalesced (superseded field writes squashed) —
  optional log hygiene, design leaves room for it.
- Derived data is rebuilt by apply, never synced: `node_links` (LinkParser
  runs inside apply), the in-memory page cache (invalidated by apply).
  `page_visits` stays local-only, outside the log entirely.
- Apply handles ops referencing missing parents deliberately (drop, per
  the purge rule — the FK would otherwise reject them mid-transaction).
- Windows receive others' ops from the shared server (SSE or polling —
  verify early whether "two instances" means two windows of one PHP server
  or two processes; this decides the transport) and merge into the live
  editor (§7).
- Exit criterion: harness green, and two windows typing on the same page
  converge with no lost edits outside the same-block flush window.

**Phase 1 — cloud relay (polling)**
- `apps/web` Laravel app: workspaces, push/pull endpoints, projections,
  snapshot bootstrap, token auth.
- Desktop: outbox push, cursor pull (poll ~5s), offline queueing.
- Media blob upload/download by hash; local cache-miss path.
- Exit criterion: two machines converge; fresh install bootstraps from
  snapshot; a week offline merges sanely (HLC wins over arrival order).

**Phase 2 — realtime**
- Reverb WebSockets: op broadcast (drop to ~instant latency), presence
  (who's online, which page, cursor position for text and later cells).
- Exit criterion: sub-second propagation; presence indicators.

**Phase 3 — Yjs text collaboration** (§10)

**Phase 4 — spreadsheets** (§11)

## 13. Alternatives considered

- **All-in Yjs (whole workspace as CRDT)** — tried on `explore/crdt`.
  Projections are needed anyway (search, backlinks, API, extension), tree
  moves in Yjs are awkward, and debugging opaque binary state is painful.
  Chosen instead: CRDT only where LWW loses data (text), structured LWW
  elsewhere.
- **Off-the-shelf sync engines** (PowerSync, ElectricSQL, Zero/Replicache,
  Liveblocks): real options, but they impose their own servers/data models,
  and the Laravel-native op log is small, fully owned, and shaped exactly
  to this app. Worth revisiting if the log grows painful.
- **Arrival-order LWW (Figma-style) instead of HLC**: simpler, but Figma is
  online-first; an offline-first note app must not let stale late-arriving
  ops overwrite newer state.
- **Server-side OT (Google Docs model)**: requires an authoritative
  always-online server and per-document session state; incompatible with
  offline-first.

## 14. Open questions

- **`field_clocks` growth**: JSON column is fine for ~6 fields; revisit if
  the schema widens.
- **Chrome extension**: a first-class *op producer* with API reads, no local
  replica. Writing pages/nodes needs only op generation — op_id (uuidv7),
  an HLC (~30 lines of JS), and fractional positions (already a JS
  library) — with an offline outbox in `chrome.storage`/IndexedDB;
  idempotent op_ids make retries safe. Reads (search, page load, rendering)
  go through the API — the popup is a short-lived surface where API latency
  is fine.
  **Decided: local-first with cloud fallback.** The extension probes the
  desktop's local API (connection-refused is instant when the app is
  closed) and prefers it; otherwise it uses the cloud. Affinity rule: one
  target per interaction, used for both the write and its reads, so
  read-your-own-writes always holds despite local/cloud eventual
  consistency (writes accepted by the desktop relay cloudward via its
  normal outbox; op_id idempotency makes even dual-path delivery harmless).
  Cost: the local and cloud APIs must share a small, versioned read
  contract (search, page show, recent pages). Sequencing bonus: the local
  path needs no cloud at all, so the extension can ship against Phase 0 and
  gain the cloud fallback with Phase 1.
  What we deliberately avoid: a full browser replica, because the cost is
  not storage (sqlite-wasm/OPFS or IndexedDB both work) but a second
  implementation of the LWW apply/merge logic in JS, which would need a
  shared golden-test suite to stay in lockstep with the PHP one. If a JS
  apply engine ever gets built, it should arrive via a local-first web
  client, with the extension inheriting it. Consequence: the op format is a
  public contract of the cloud API from Phase 1 (versioned payloads —
  already in §5).
  Related Phase 0 invariant: **projection tables are only ever written by
  the op-apply function** — editor batches, title saves, extension pushes,
  and server-side writes like `LinkParser`'s auto-created wikilink pages
  must all mint ops, or those writes never sync.
- **Multi-user sharing, permissions, and orgs**: detailed design deferred,
  but the granularity is **decided: permissions apply to a whole database**
  (user-facing term for what this doc calls a workspace) — sharing =
  membership, and users can create and connect to multiple databases. This
  deliberately rules out per-page ACLs, which would raise questions a
  backlinked graph can't answer cleanly (backlinks into pages the viewer
  can't see, wikilink auto-creation crossing permission boundaries, search
  leakage), and it means the sync model needs no filtered pull: members
  sync a database's whole log. Each database = its own op log, cursor, and
  membership; ownership by users now, orgs later (GitHub-style
  org → databases → members). From Phase 1 the cloud stamps accepted ops
  with the authenticated `user_id` (server-assigned, unforgeable; for
  audit and presence). Open sub-question for Phase 1: local layout —
  one SQLite file per database (Obsidian-vault-style isolation; current
  lean) vs. a `workspace_id` column through every table. Roles, invites,
  and public links are additive machinery and constrain nothing in
  Phases 0–2.
