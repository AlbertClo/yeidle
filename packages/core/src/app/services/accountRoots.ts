import type { Database } from '../../db/database';
import type { NodeChange } from '../../loro/nodeOps';
import { uuid5, uuidv7 } from '../../support/ids';

/**
 * Shared plumbing for the personal system subtrees (pins, collapsed nodes,
 * preferences):
 *
 *   hidden workspace root -> hidden account root -> entries
 *
 * The account root is UUIDv5-derived from 'local:<client_id>' until a cloud
 * user is known, then from 'cloud:<cloud_user_id>'. Every replica stores all
 * users' roots but presents only the current user's.
 */

export type SyncIdentity = { client_id: string; cloud_user_id: string | null };

/** The installation's sync identity (sync_state is a single-row table). */
export function syncIdentity(db: Database): SyncIdentity {
    let state = db.get<SyncIdentity>(
        'SELECT client_id, cloud_user_id FROM sync_state ORDER BY id LIMIT 1',
    );

    if (state === undefined) {
        const clientId = uuidv7();
        db.run(
            'INSERT INTO sync_state (client_id, last_server_seq) VALUES (?, 0)',
            [clientId],
        );
        state = { client_id: clientId, cloud_user_id: null };
    }

    // Pairing a workspace with the cloud records cloud_user_id (CloudSync.connect)
    return state;
}

/**
 * Resolves the active account root under a system root, adopting the local
 * root's entries once a cloud user is known.
 */
export function activeAccountRoot(
    db: Database,
    systemRootId: string,
    adopt: (localRootId: string, cloudRootId: string) => void,
): string {
    const state = syncIdentity(db);
    const localRootId = userRootId(systemRootId, `local:${state.client_id}`);

    if (typeof state.cloud_user_id !== 'string' || state.cloud_user_id === '') {
        return localRootId;
    }

    const cloudRootId = userRootId(
        systemRootId,
        `cloud:${state.cloud_user_id}`,
    );

    if (localRootId !== cloudRootId) {
        adopt(localRootId, cloudRootId);
    }

    return cloudRootId;
}

export function userRootId(systemRootId: string, identity: string): string {
    return uuid5(systemRootId, identity);
}

export function entryId(rootId: string, name: string): string {
    return uuid5(rootId, name);
}

export function setChange(
    id: string,
    pageId: string,
    fields: Record<string, unknown>,
): NodeChange {
    return { type: 'node.set', payload: { id, page_id: pageId, fields } };
}

export function deleteChange(id: string, pageId: string): NodeChange {
    return { type: 'node.delete', payload: { id, page_id: pageId } };
}

/** Ensures the hidden system root and the account root exist (and are live). */
export function containerChanges(
    systemRootId: string,
    userRootId: string,
): NodeChange[] {
    return [
        setChange(systemRootId, systemRootId, {
            parent_id: null,
            position: 'a0',
            content: '',
            tiptap_content: null,
            is_checked: null,
        }),
        setChange(userRootId, systemRootId, {
            parent_id: systemRootId,
            position: 'a0',
            content: '',
            tiptap_content: null,
            is_checked: null,
        }),
    ];
}

/** Fields for a new entry under an account root. */
export function entryFields(
    rootId: string,
    position: string,
    content: string,
): Record<string, unknown> {
    return {
        parent_id: rootId,
        position,
        content,
        tiptap_content: null,
        is_checked: null,
    };
}
