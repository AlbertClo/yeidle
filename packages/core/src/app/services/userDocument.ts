import type { LoroDoc, LoroMap, LoroMovableList } from 'loro-crdt';

import { cloudProfileKey } from '../cloud/profile';
import type { AppContext } from '../context';

/**
 * Personal state that syncs: one Loro document per user and workspace,
 * `user:<cloud user id>` (`user:local` before sign-in).
 *
 *   preferences  LoroMap          theme, font_family, font_size, workspace_storage
 *   pins         LoroMovableList  pinned page ids, in order
 *   collapsed    LoroMap          collapsed block id → true
 *
 * It's small, so it's read straight from the in-memory document; it has no
 * read-model tables. `user:local` never leaves the device: on sign-in its
 * contents are merged into the signed-in user's document.
 */

export const LOCAL_USER_DOCUMENT_ID = 'user:local';

/** Preferences that stay with the device when merging into a cloud user. */
const LOCAL_ONLY_PREFERENCES = new Set(['workspace_storage']);

export function userDocumentId(userKey: string): string {
    return userKey.startsWith('cloud:')
        ? `user:${userKey.slice('cloud:'.length)}`
        : LOCAL_USER_DOCUMENT_ID;
}

export function isUserDocument(documentId: string): boolean {
    return documentId.startsWith('user:');
}

export function preferencesMap(doc: LoroDoc): LoroMap {
    return doc.getMap('preferences');
}

export function pinsList(doc: LoroDoc): LoroMovableList {
    return doc.getMovableList('pins');
}

export function collapsedMap(doc: LoroDoc): LoroMap {
    return doc.getMap('collapsed');
}

export class UserDocument {
    constructor(private ctx: AppContext) {}

    /** The current user's document id, after merging in local state once signed in. */
    id(): string {
        const id = userDocumentId(cloudProfileKey(this.ctx));

        if (id !== LOCAL_USER_DOCUMENT_ID) {
            this.mergeLocalInto(id);
        }

        return id;
    }

    read(): LoroDoc {
        return this.ctx.documents().read(this.id());
    }

    edit(edit: (doc: LoroDoc) => void, message: string): boolean {
        return this.ctx.documents().edit(this.id(), edit, message);
    }

    /** Moves what was saved before sign-in into the signed-in user's document. */
    private mergeLocalInto(id: string): void {
        const documents = this.ctx.documents();

        if (!documents.store.exists(LOCAL_USER_DOCUMENT_ID)) {
            return;
        }

        const local = documents.read(LOCAL_USER_DOCUMENT_ID);
        const preferences = preferencesMap(local).toJSON() as Record<
            string,
            unknown
        >;
        const pins = pinsList(local).toArray() as string[];
        const collapsed = collapsedMap(local).keys();

        if (
            Object.keys(preferences).every((key) =>
                LOCAL_ONLY_PREFERENCES.has(key),
            ) &&
            pins.length === 0 &&
            collapsed.length === 0
        ) {
            return;
        }

        documents.editMany(
            [
                {
                    document_id: id,
                    edit: (doc) => {
                        const target = preferencesMap(doc);

                        // The signed-in user's own choices win
                        for (const [key, value] of Object.entries(
                            preferences,
                        )) {
                            if (
                                !LOCAL_ONLY_PREFERENCES.has(key) &&
                                target.get(key) === undefined
                            ) {
                                target.set(key, value as never);
                            }
                        }

                        const list = pinsList(doc);
                        const pinned = new Set(list.toArray() as string[]);

                        for (const pageId of pins) {
                            if (!pinned.has(pageId)) {
                                list.push(pageId);
                                pinned.add(pageId);
                            }
                        }

                        const map = collapsedMap(doc);

                        for (const blockId of collapsed) {
                            map.set(blockId, true);
                        }
                    },
                },
                {
                    document_id: LOCAL_USER_DOCUMENT_ID,
                    edit: (doc) => {
                        const map = preferencesMap(doc);

                        for (const key of map.keys()) {
                            if (!LOCAL_ONLY_PREFERENCES.has(key)) {
                                map.delete(key);
                            }
                        }

                        const list = pinsList(doc);

                        if (list.length > 0) {
                            list.delete(0, list.length);
                        }

                        const collapsedBlocks = collapsedMap(doc);

                        for (const key of collapsedBlocks.keys()) {
                            collapsedBlocks.delete(key);
                        }
                    },
                },
            ],
            'Merge personal state after sign-in',
        );
    }
}
