import { invalidateInactiveCachedPages } from '../stores/pageCache';

/**
 * "These documents changed": every committed change, local or remote,
 * announced to the views that show it. A document is a top-level page, or one
 * of the hidden system roots (pins, preferences, collapsed state).
 *
 * `documentIds` is null when anything may have changed (after a cloud pull,
 * which doesn't say what it brought).
 */

export const DOCUMENTS_CHANGED_EVENT = 'yeidle:documents-changed';

export type DocumentsChangedDetail = { documentIds: string[] | null };

export type DocumentsChangedEvent = CustomEvent<DocumentsChangedDetail>;

export function notifyDocumentsChanged(documentIds: string[] | null): void {
    invalidateInactiveCachedPages(documentIds);

    window.dispatchEvent(
        new CustomEvent<DocumentsChangedDetail>(DOCUMENTS_CHANGED_EVENT, {
            detail: { documentIds },
        }),
    );
}

/** The documents an event covers, or null for "anything may have changed". */
export function changedDocuments(event: Event): string[] | null {
    return (event as DocumentsChangedEvent).detail?.documentIds ?? null;
}

/** Whether any of `documentIds` may have changed. */
export function anyChanged(
    changed: string[] | null,
    ...documentIds: (string | null | undefined)[]
): boolean {
    return (
        changed === null ||
        documentIds.some((id) => typeof id === 'string' && changed.includes(id))
    );
}
