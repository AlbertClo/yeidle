import { ref } from 'vue';
import { requestCloudExchange } from '@/sync/cloud';
import type { CommittedOp } from '@/sync/localOps';

export const collapsedNodeIds = ref<Set<string>>(new Set());
export const collapsedNodesRootId = ref<string | null>(null);

let loaded = false;
let loadRequest: Promise<void> | null = null;
let mutationVersion = 0;

interface CollapseStatePayload {
    root_id: string;
    node_ids: string[];
}

export function initializeCollapsedNodes(
    rootId: string,
    nodeIds: string[],
): void {
    collapsedNodesRootId.value = rootId;
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

    loadRequest = fetch('/api/collapsed-nodes', {
        headers: { Accept: 'application/json' },
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error('Could not load collapsed nodes.');
            }

            const payload = (await response.json()) as CollapseStatePayload;
            initializeCollapsedNodes(payload.root_id, payload.node_ids);
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
        const response = await fetch('/api/collapsed-nodes', {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ node_ids: nodeIds, collapsed }),
        });

        if (!response.ok) {
            throw new Error('Could not update collapsed nodes.');
        }

        const payload = (await response.json()) as CollapseStatePayload;

        if (version === mutationVersion) {
            initializeCollapsedNodes(payload.root_id, payload.node_ids);
        }

        void requestCloudExchange();
    } catch (error) {
        if (version === mutationVersion) {
            collapsedNodeIds.value = previous;
        }

        throw error;
    }
}

export function opsAffectCollapsedNodes(ops: CommittedOp[] | null): boolean {
    if (ops === null || collapsedNodesRootId.value === null) {
        return true;
    }

    return ops.some((op) => {
        const payload = op.payload;

        if (typeof payload !== 'object' || payload === null) {
            return false;
        }

        const fields = payload as Record<string, unknown>;

        return (
            fields.id === collapsedNodesRootId.value ||
            fields.page_id === collapsedNodesRootId.value
        );
    });
}
