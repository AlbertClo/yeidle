import { invalidateInactiveCachedPages } from '../stores/pageCache';

/**
 * "These documents changed": every committed change, local or remote,
 * announced to the views that show it. A document is a page (named by the
 * page id), the media list, or a user's personal state (`user:…`: pins,
 * preferences, collapsed blocks).
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

/** Whether a user document (pins, preferences, collapsed blocks) may have changed. */
export function userDocumentChanged(changed: string[] | null): boolean {
    return changed === null || changed.some(isUserDocument);
}

export function isUserDocument(documentId: string): boolean {
    return documentId.startsWith('user:');
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
