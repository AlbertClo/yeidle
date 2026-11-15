# Clean up as you go

## An adapter for the old design goes when the old design does

When the desktop app moved from an operation log to Loro documents, change
notifications became lists of document ids. To keep the listeners written for operations
working, the ids were dressed up as fake operations, and every listener unpacked them
again. The adapter outlived the design it bridged: readers had to learn the old
operation format to follow code that has nothing to do with operations, and checks
written against real operations quietly stopped matching.

```ts
// Instead of
/**
 * Change notifications for documents arrive in the op shape older listeners
 * understand: one entry per changed document, `{ payload: { id, page_id } }`.
 */
export function documentChangesAsOps(documentIds: string[]): CommittedOp[] {
    return documentIds.map((id) => ({ payload: { id, page_id: id } }));
}

window.Native?.subscribeDocumentChanges?.((documentIds) =>
    notifyLocalOpsAvailable(documentChangesAsOps(documentIds)),
);

// Use
window.Native?.subscribeDocumentChanges?.((documentIds) =>
    notifyDocumentsChanged(documentIds),
);

// and listeners ask about documents directly
if (anyChanged(changedDocuments(event), session.id)) {
    void pullRemote();
}
```
