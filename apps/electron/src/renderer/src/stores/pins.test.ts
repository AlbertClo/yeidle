import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@/types/node';

import { persistPinOrder, pinnedItems, pinsChanged } from './pins';

vi.mock('../sync/cloud', () => ({
    requestCloudExchange: vi.fn().mockResolvedValue(true),
}));

const pinnedItem: Page = {
    id: '00000000-0000-7000-8000-000000000001',
    title: 'Saved page',
    kind: 'page',
    daily_date: null,
    created_at: 0,
    updated_at: 0,
};

describe('pins store', () => {
    beforeEach(() => {
        pinnedItems.value = [pinnedItem];
        vi.restoreAllMocks();
    });

    it('persists the selected pin order', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('{}', { status: 200 }));

        await persistPinOrder([pinnedItem.id]);

        expect(fetchMock).toHaveBeenCalledWith('/api/pins/order', {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ page_ids: [pinnedItem.id] }),
        });
    });

    it('refreshes for the user document or a pinned page', () => {
        expect(pinsChanged(['user:local'])).toBe(true);
        expect(pinsChanged([pinnedItem.id])).toBe(true);
        expect(pinsChanged(null)).toBe(true);
        expect(pinsChanged(['another-page', 'media'])).toBe(false);
    });
});
