import { ref } from 'vue';
import { requestCloudExchange } from '@/sync/cloud';

import { userDocumentChanged } from '@/sync/documentChanges';

export const collapsedNodeIds = ref<Set<string>>(new Set());

let loaded = false;
let loadRequest: Promise<void> | null = null;
let mutationVersion = 0;

interface CollapseStatePayload {
    block_ids: string[];
}

export function initializeCollapsedNodes(nodeIds: string[]): void {
    collapsedNodeIds.value = new Set(nodeIds);
    loaded = true;
}

export async function loadCollapsedNodes(force = false): Promise<void> {
    if (loadRequest !== null) {
        await loadRequest;

        if (force) {
            return loadCollapsedNodes(true);
        }

        return;
    }

    if (loaded && !force) {
        return;
    }

    loadRequest = fetch('/api/collapsed-blocks', {
        headers: { Accept: 'application/json' },
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error('Could not load collapsed nodes.');
            }

            const payload = (await response.json()) as CollapseStatePayload;
            initializeCollapsedNodes(payload.block_ids);
        })
        .finally(() => {
            loadRequest = null;
        });

    return loadRequest;
}

export function isNodeCollapsed(nodeId: string): boolean {
    return collapsedNodeIds.value.has(nodeId);
}

export async function collapseNodes(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) {
        return;
    }

    const next = new Set(collapsedNodeIds.value);

    for (const id of nodeIds) {
        next.add(id);
    }

    await persistCollapseState(nodeIds, true, next);
}

export async function collapseNode(nodeId: string): Promise<void> {
    await collapseNodes([nodeId]);
}

export async function expandNodes(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) {
        return;
    }

    const next = new Set(collapsedNodeIds.value);

    for (const id of nodeIds) {
        next.delete(id);
    }

    await persistCollapseState(nodeIds, false, next);
}

async function persistCollapseState(
    nodeIds: string[],
    collapsed: boolean,
    optimisticState: Set<string>,
): Promise<void> {
    const previous = collapsedNodeIds.value;
    const version = ++mutationVersion;
    collapsedNodeIds.value = optimisticState;

    try {
        const response = await fetch('/api/collapsed-blocks', {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ block_ids: nodeIds, collapsed }),
        });

        if (!response.ok) {
            throw new Error('Could not update collapsed nodes.');
        }

        const payload = (await response.json()) as CollapseStatePayload;

        if (version === mutationVersion) {
            initializeCollapsedNodes(payload.block_ids);
        }

        void requestCloudExchange();
    } catch (error) {
        if (version === mutationVersion) {
            collapsedNodeIds.value = previous;
        }

        throw error;
    }
}

/** Whether a change could affect this store: collapsed blocks live in the user document. */
export function collapsedNodesChanged(documentIds: string[] | null): boolean {
    return userDocumentChanged(documentIds);
}
