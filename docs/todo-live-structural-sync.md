# TODO: Apply remote structural changes to the live editor

Status: deferred (low priority while concurrent cross-device structural edits
are rare)

Related design: [Sync & Collaboration Design, section 7](sync-design.md#7-applying-remote-ops-to-a-live-editor)

## Why this is deferred

Remote content and checkbox changes already use targeted TipTap transactions.
Remote structural changes—node insertion, deletion, reordering, or reparenting—
currently rebuild the editor instead. Rebuilding while the user is editing can
lose or move the selection, reset focus and undo history, disturb the viewport,
and interrupt IME composition. The desktop app therefore waits to apply a
structural change while the title or editor has an active selection.

That compromise is acceptable for now because making structural changes on one
device while actively editing the same page on another is expected to be rare.

## Current behaviour and known issue

The remote polling path is in
`apps/desktop/resources/js/pages/Pages/Show.vue::pollRemoteOps()`:

1. Pull operations after the current cloud cursor.
2. Apply them to a cloned Vue node tree with `applyOpsToTree()`.
3. If the result is structural and the editor has an active selection, return
   without applying the tree.
4. Otherwise replace `pageNodes` and increment `editorKey`, which remounts
   `PageEditor`.

Because the early return also leaves `pullCursor` unchanged, the same deferred
operations can be fetched and reconsidered every 1.5 seconds for as long as the
selection remains active. This is unnecessary repeated work and may contribute
to UI load during that specific situation.

If we retain deferral anywhere in the eventual solution (for example during IME
composition), deferred operations must be held locally and the fetched cursor
must advance. They should be retried from the local pending queue rather than
downloaded and processed again on every poll.

## Desired behaviour

- Apply remote insert, delete, reorder, and reparent operations without
  remounting `PageEditor`.
- Preserve focus, the exact text selection, the viewport, and local undo
  history when an unrelated part of the tree changes.
- When the selected block moves, move the user's selection with the block and
  retain its text offsets.
- When the selected block is deleted, place the cursor at a deterministic
  nearby surviving block.
- Do not emit new local operations for changes that came from remote sync.
- Do not add remote changes to local undo history.
- Defer only an operation that cannot safely be applied, such as one touching
  an active IME composition. Deferral must not cause the cloud operation to be
  pulled repeatedly.

## Recommended implementation

Add an `applyRemoteStructure()` API to
`apps/desktop/resources/js/components/PageEditor.vue`, alongside the existing
`applyRemoteContent()` API. It should apply structural changes through
ProseMirror transactions rather than by incrementing `editorKey`.

For each batch:

1. Capture the current selection. For a selection inside a list item, retain
   its `blockId`, anchor/head offsets within that block, selection direction,
   and whether the editor has focus. Preserve the current scroll position as a
   fallback; normally no explicit scrolling should be necessary.
2. Locate list items by `blockId` in the transaction's current document.
   Positions must be recalculated or mapped after every mutation in a batch;
   positions found before an insertion or removal become stale.
3. Insert, remove, reorder, or reparent list items with ProseMirror
   transactions. Preserve the entire nested subtree when moving an item.
4. Mark every transaction with `remoteSync: true` and
   `addToHistory: false`, matching `applyRemoteContent()`.
5. For edits outside the selected block, allow ProseMirror's transaction
   mapping to preserve the selection automatically. If the selected block
   itself moved, find it at its new position and restore the captured offsets.
   If it was deleted, choose the next sibling, previous sibling, or parent in
   that order.
6. Update `pageNodes`, the page cache, and `lastNodeMap` only after the editor
   transaction succeeds, so the Vue tree, TipTap document, and diff baseline
   remain consistent.
7. Remove the structural `editorKey` remount path once all structural operation
   types are covered. Keep a logged recovery/remount path only for unexpected
   schema or document corruption, not as normal sync behaviour.

The existing pure tree transformation in
`apps/desktop/resources/js/sync/tree.ts` can remain the source of the desired
Vue state. The new editor API can either consume the ordered operation batch or
a structural diff, but consuming the operations directly should make intent
(insert, delete, or move) clearer and avoid diffing the tree a second time.

## Edge cases to handle

- An insertion before or inside the selected block's ancestors.
- Reordering siblings, including several moves in one pulled batch.
- Moving a selected block or its ancestor to a different parent.
- Deleting the selected block, an ancestor of it, or the last block on a page.
- A move whose destination parent was inserted earlier in the same batch.
- An operation whose source or destination is no longer visible because of an
  earlier operation in the batch.
- Text selections spanning multiple blocks and non-text/node selections.
- Checkbox/list-item attributes and nested bullet-list boundaries.
- An active IME composition in the affected block.
- A local save or outbox operation becoming pending while remote changes are
  being applied.
- Failure halfway through a batch. Prefer one transaction or validate the
  complete transformation before dispatch so partial application is avoided.

## Tests and completion criteria

Add editor-level tests covering at least:

- Remote insertion, deletion, sibling reorder, and cross-parent move.
- An unrelated structural change preserves the focused block and exact cursor
  or range offsets.
- Moving the selected block preserves its selection and does not force the
  viewport to jump.
- Deleting the selected block chooses the documented fallback location.
- Nested subtrees move intact and multiple operations in one batch use correct
  mapped positions.
- Remote transactions neither enter the local diff/outbox pipeline nor appear
  in local undo history.
- Deferred IME work is queued once, the cloud cursor advances, and later polls
  do not reprocess the same operation.
- When application fails, Vue state, the editor document, cache, and
  `lastNodeMap` do not diverge.

The work is complete when structural changes from a second client appear while
the first client is actively editing, without remounting the editor or causing
an observable cursor, focus, viewport, undo, or repeated-polling regression.

## Expected size

Allow roughly 150–300 lines of implementation plus editor-focused tests. A
robust version is likely one to two focused days; IME and unusual selection
cases may extend that estimate. A smaller remount-and-refocus patch is not the
preferred solution because it cannot reliably preserve cursor, viewport, IME,
and undo state.
