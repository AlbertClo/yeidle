import type { LoroDoc } from 'loro-crdt';

import type { Database } from '../db/database';
import { applyNodeChanges } from '../loro/nodeOps';
import type { NodeChange } from '../loro/nodeOps';
import { applyBlocks, createDoc } from '../loro/pageDoc';
import type { Block } from '../loro/pageDoc';
import { updatePageMeta } from '../loro/pageMeta';
import type { PageMeta } from '../loro/pageMeta';
import {
    addMedia,
    MEDIA_DOCUMENT_ID,
    projectDocument,
} from '../loro/projection';
import type { MediaRow } from '../loro/projection';
import { uuidv7 } from '../support/ids';

import { Projector } from './projector';
import { DocumentStore } from './store';

export { MEDIA_DOCUMENT_ID };

/** One PHP-style change: `node.set`/`node.delete`, or `media.create`. */
export type Change =
    | NodeChange
    | {
          type: 'media.create';
          payload: Omit<MediaRow, 'created_at'> & {
              created_at?: string | null;
          };
      };

export type DocumentAction = {
    document_id: string;
    changes?: NodeChange[];
    replace?: { page: Partial<PageMeta>; blocks: Block[] };
    media?: MediaRow[];
};

export type IncomingUpdate = {
    update_id: string;
    client_id: string;
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
                    update.client_id,
                    update.update_id,
                    update.cloud_seq ?? null,
                );
            }

            this.afterChange(documentId, doc);

            return [documentId];
        });

        return this.store.latestSeq(documentId);
    }

    /** Applies changes that originate in the app itself (not an editor). */
    apply(actions: DocumentAction[], message = '', clientId = 'app'): string[] {
        if (actions.length === 0) {
            return [];
        }

        const documentIds = [
            ...new Set(actions.map((action) => action.document_id)),
        ];

        return this.write(documentIds, () => {
            const changed: string[] = [];

            for (const documentId of documentIds) {
                const doc = this.doc(documentId);
                const before = doc.oplogVersion();

                for (const action of actions.filter(
                    (a) => a.document_id === documentId,
                )) {
                    if (action.replace) {
                        updatePageMeta(doc, action.replace.page);
                        applyBlocks(doc, action.replace.blocks);
                    }

                    if (action.changes) {
                        applyNodeChanges(doc, documentId, action.changes);
                    }

                    for (const media of action.media ?? []) {
                        addMedia(doc, media);
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
                    `${clientId}-${uuidv7()}`,
                );
                this.afterChange(documentId, doc);
                changed.push(documentId);
            }

            return changed;
        });
    }

    /**
     * Applies changes in the op shape (`type` + payload with `id`, `page_id`,
     * `fields`). They are grouped per document; a node's document is its
     * top-level ancestor, so page_id is only a hint.
     */
    applyChanges(changes: Change[], message = '', clientId = 'app'): string[] {
        const actions = new Map<string, DocumentAction>();
        const rootOf = this.rootResolver(changes);

        for (const change of changes) {
            if (change.type === 'media.create') {
                const action = actions.get(MEDIA_DOCUMENT_ID) ?? {
                    document_id: MEDIA_DOCUMENT_ID,
                    media: [],
                };
                action.media!.push({
                    ...change.payload,
                    created_at:
                        change.payload.created_at ?? new Date().toISOString(),
                });
                actions.set(MEDIA_DOCUMENT_ID, action);

                continue;
            }

            const documentId = rootOf(
                change.payload.id,
                change.payload.page_id ?? null,
            );
            const action = actions.get(documentId) ?? {
                document_id: documentId,
                changes: [],
            };
            action.changes!.push({
                ...change,
                payload: { ...change.payload, page_id: documentId },
            } as NodeChange);
            actions.set(documentId, action);
        }

        return this.apply([...actions.values()], message, clientId);
    }

    /** Re-projects documents from their stored state. */
    refresh(documentIds: string[]): void {
        this.write(documentIds, () => {
            for (const documentId of documentIds) {
                this.cache.delete(documentId);
                this.projector.write(
                    documentId,
                    projectDocument(this.doc(documentId), documentId),
                );
            }

            return documentIds;
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

    private rootResolver(
        changes: Change[],
    ): (id: string, hint: string | null) => string {
        const batchParents = new Map<string, unknown>();

        for (const change of changes) {
            if (
                change.type === 'node.set' &&
                'parent_id' in change.payload.fields
            ) {
                batchParents.set(
                    change.payload.id,
                    change.payload.fields.parent_id,
                );
            }
        }

        const cache = new Map<string, string>();

        return (id, hint) => {
            const cached = cache.get(id);

            if (cached) {
                return cached;
            }

            const seen = new Set<string>();
            let current = id;
            let result: string | null = null;

            while (result === null) {
                if (seen.has(current)) {
                    result = hint ?? id;
                    break;
                }

                seen.add(current);
                let parent: unknown;

                if (batchParents.has(current)) {
                    parent = batchParents.get(current);
                } else {
                    const row = this.db.get<{
                        parent_id: string | null;
                        document_id: string | null;
                    }>(
                        'SELECT parent_id, document_id FROM nodes WHERE id = ?',
                        [current],
                    );

                    if (row === undefined) {
                        result = current === id ? (hint ?? id) : current;
                        break;
                    }

                    if (row.document_id !== null) {
                        result = row.document_id;
                        break;
                    }

                    parent = row.parent_id;
                }

                if (typeof parent !== 'string') {
                    result = current;
                    break;
                }

                current = parent;
            }

            cache.set(id, result);

            return result;
        };
    }
}
