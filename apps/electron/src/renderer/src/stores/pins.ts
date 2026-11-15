import { ref } from 'vue';
import { requestCloudExchange } from '../sync/cloud';

import { anyChanged, userDocumentChanged } from '@/sync/documentChanges';
import type { Page } from '../types/node';

export const pinnedItems = ref<Page[]>([]);

let loaded = false;
let loadRequest: Promise<void> | null = null;

export async function loadPins(force = false): Promise<void> {
    if (loadRequest !== null) {
        await loadRequest;

        if (force) {
            return loadPins(true);
        }

        return;
    }

    if (loaded && !force) {
        return;
    }

    loadRequest = fetch('/api/pins', {
        headers: { Accept: 'application/json' },
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error('Could not load pins.');
            }

            const payload = (await response.json()) as { items: Page[] };

            pinnedItems.value = payload.items;
            loaded = true;
        })
        .finally(() => {
            loadRequest = null;
        });

    return loadRequest;
}

export function isNodePinned(nodeId: string): boolean {
    return pinnedItems.value.some((item) => item.id === nodeId);
}

export function rememberPinState(item: Page, pinned: boolean): void {
    const index = pinnedItems.value.findIndex(
        (pinnedItem) => pinnedItem.id === item.id,
    );

    if (pinned && index === -1) {
        pinnedItems.value.push(item);
    } else if (!pinned && index !== -1) {
        pinnedItems.value.splice(index, 1);
    }
}

export function updatePinnedItemTitle(nodeId: string, title: string): void {
    const item = pinnedItems.value.find(
        (pinnedItem) => pinnedItem.id === nodeId,
    );

    if (item) {
        item.title = title;
    }
}

export async function setNodePinned(
    nodeId: string,
    pinned: boolean,
): Promise<void> {
    const response = await fetch(`/api/pages/${nodeId}/pin`, {
        method: pinned ? 'PUT' : 'DELETE',
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error('Could not update the pin.');
    }

    const payload = (await response.json()) as {
        pinned: boolean;
        item?: Page;
    };

    if (pinned && payload.item) {
        rememberPinState(payload.item, true);
    } else if (!pinned) {
        const item = pinnedItems.value.find(
            (pinnedItem) => pinnedItem.id === nodeId,
        );

        if (item) {
            rememberPinState(item, false);
        }
    }

    void requestCloudExchange();
}

export async function toggleNodePin(nodeId: string): Promise<void> {
    await loadPins();
    await setNodePinned(nodeId, !isNodePinned(nodeId));
}

export async function persistPinOrder(nodeIds: string[]): Promise<void> {
    const response = await fetch('/api/pins/order', {
        method: 'PUT',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ page_ids: nodeIds }),
    });

    if (!response.ok) {
        await loadPins(true).catch(() => undefined);

        throw new Error('Could not reorder pins.');
    }

    void requestCloudExchange();
}

/** Whether a change could affect this store: pins live in the user document. */
export function pinsChanged(documentIds: string[] | null): boolean {
    return (
        userDocumentChanged(documentIds) ||
        // A pinned page's title is shown in the sidebar
        anyChanged(documentIds, ...pinnedItems.value.map((item) => item.id))
    );
}
