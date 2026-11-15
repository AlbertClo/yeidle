import type { LoroDoc } from 'loro-crdt';

import type { Database } from '../db/database';
import { createDoc } from '../loro/pageDoc';
import { MEDIA_DOCUMENT_ID, projectDocument } from '../loro/projection';
import { uuidv7 } from '../support/ids';

import { Projector } from './projector';
import { DocumentStore } from './store';

export { MEDIA_DOCUMENT_ID };

/** A change to one document, made by the app itself (not an editor). */
export type DocumentEdit = {
    document_id: string;
    /** Changes the document; the service commits. */
    edit: (doc: LoroDoc) => void;
};

export type IncomingUpdate = {
    update_id: string;
    origin: string;
    bytes: Uint8Array;
    cloud_seq?: number | null;
};

// Fold updates into the stored snapshot once this many accumulate
const SNAPSHOT_EVERY = 50;
// Large enough that a re-import of a big graph doesn't thrash
const CACHE_SIZE = 500;

/**
 * The single write path for workspace content. Every change becomes a Loro
 * update to one document; each write appends to the update log, refreshes
 * the read model, and occasionally compacts the snapshot — all in one
 * transaction. Documents stay cached in memory between writes.
 */
export class DocumentService {
    readonly store: DocumentStore;
    private projector: Projector;
    private cache = new Map<string, LoroDoc>();
    private listeners = new Set<(documentIds: string[]) => void>();

    constructor(private db: Database) {
        this.store = new DocumentStore(db);
        this.projector = new Projector(db);
    }

    /** Called after each committed write with the documents that changed. */
    onChange(listener: (documentIds: string[]) => void): () => void {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    }

    /** The current state of a document. Callers must not mutate it. */
    read(documentId: string): LoroDoc {
        return this.doc(documentId);
    }

    /**
     * Stores updates produced elsewhere (an editor window or the cloud) and
     * refreshes the read model. Known update ids are skipped.
     */
    applyUpdates(documentId: string, updates: IncomingUpdate[]): number {
        this.write([documentId], () => {
            const fresh = updates.filter(
                (update) => !this.store.hasUpdate(update.update_id),
            );

            if (fresh.length === 0) {
                return [];
            }

            this.store.ensure(documentId);
            const doc = this.doc(documentId);
            doc.importBatch(fresh.map((update) => update.bytes));

            for (const update of fresh) {
                this.store.append(
                    documentId,
                    update.bytes,
                    update.origin,
                    update.update_id,
                    update.cloud_seq ?? null,
                );
            }

            this.afterChange(documentId, doc);

            return [documentId];
        });

        return this.store.latestSeq(documentId);
    }

    /** Changes one document. Returns whether it changed. */
    edit(
        documentId: string,
        edit: (doc: LoroDoc) => void,
        message = '',
        origin = 'app',
    ): boolean {
        return (
            this.editMany([{ document_id: documentId, edit }], message, origin)
                .length > 0
        );
    }

    /** Changes several documents in one transaction. Returns those that changed. */
    editMany(edits: DocumentEdit[], message = '', origin = 'app'): string[] {
        if (edits.length === 0) {
            return [];
        }

        const documentIds = [...new Set(edits.map((e) => e.document_id))];

        return this.write(documentIds, () => {
            const changed: string[] = [];

            for (const documentId of documentIds) {
                const doc = this.doc(documentId);
                const before = doc.oplogVersion();

                for (const edit of edits) {
                    if (edit.document_id === documentId) {
                        edit.edit(doc);
                    }
                }

                if (message !== '') {
                    doc.setNextCommitMessage(message);
                }

                doc.commit();

                if (doc.oplogVersion().compare(before) === 0) {
                    continue;
                }

                this.store.ensure(documentId);
                this.store.append(
                    documentId,
                    doc.export({ mode: 'update', from: before }),
                    `${origin}-${uuidv7()}`,
                );
                this.afterChange(documentId, doc);
                changed.push(documentId);
            }

            return changed;
        });
    }

    /**
     * Rebuilds the whole read model from the stored documents: a repair
     * tool, and how read-model changes will ship after launch.
     */
    rebuildReadModel(): void {
        this.db.transaction(() => {
            this.projector.clear();

            for (const documentId of this.store.ids()) {
                this.cache.delete(documentId);
                this.projector.write(
                    documentId,
                    projectDocument(this.doc(documentId), documentId),
                );
            }
        });
    }

    private write(documentIds: string[], fn: () => string[]): string[] {
        let changed: string[];

        try {
            changed = this.db.transaction(fn);
        } catch (error) {
            // The cached documents may hold changes that were rolled back
            for (const id of documentIds) {
                this.cache.delete(id);
            }

            throw error;
        }

        if (changed.length > 0) {
            for (const listener of this.listeners) {
                listener(changed);
            }
        }

        return changed;
    }

    private afterChange(documentId: string, doc: LoroDoc): void {
        if (this.store.pendingUpdates(documentId) >= SNAPSHOT_EVERY) {
            this.store.saveSnapshot(
                documentId,
                doc.export({ mode: 'snapshot' }),
                this.store.latestSeq(documentId),
            );
        }

        this.projector.write(documentId, projectDocument(doc, documentId));
    }

    private doc(documentId: string): LoroDoc {
        let doc = this.cache.get(documentId);

        if (doc) {
            // Most recently used goes last
            this.cache.delete(documentId);
            this.cache.set(documentId, doc);

            return doc;
        }

        doc = createDoc();
        const stored = this.store.load(documentId);
        const blobs = [
            ...(stored.snapshot ? [stored.snapshot] : []),
            ...stored.updates,
        ];

        if (blobs.length > 0) {
            doc.importBatch(blobs);
        }

        this.cache.set(documentId, doc);

        if (this.cache.size > CACHE_SIZE) {
            this.cache.delete(this.cache.keys().next().value!);
        }

        return doc;
    }
}
