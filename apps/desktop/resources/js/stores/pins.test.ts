import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@/types/node';
import { opsAffectPins, persistPinOrder, pinnedItems, pinRootId } from './pins';

vi.mock('../sync/cloud', () => ({
    requestCloudExchange: vi.fn().mockResolvedValue(true),
}));

const pinnedItem: Node = {
    id: '00000000-0000-7000-8000-000000000001',
    parent_id: null,
    position: 'a0',
    content: 'Saved page',
    tiptap_content: null,
    is_checked: null,
    modified_hlc: '',
    created_at: '',
    updated_at: '',
};

describe('pins store', () => {
    beforeEach(() => {
        pinnedItems.value = [pinnedItem];
        pinRootId.value = '00000000-0000-7000-8000-000000000099';
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
            body: JSON.stringify({ node_ids: [pinnedItem.id] }),
        });
    });

    it('refreshes only for this user root or a visible page', () => {
        expect(
            opsAffectPins([
                {
                    payload: {
                        id: 'entry',
                        page_id: pinRootId.value,
                    },
                },
            ]),
        ).toBe(true);
        expect(
            opsAffectPins([
                {
                    payload: {
                        id: pinnedItem.id,
                        page_id: pinnedItem.id,
                    },
                },
            ]),
        ).toBe(true);
        expect(
            opsAffectPins([
                {
                    payload: {
                        id: 'another-users-entry',
                        page_id: 'another-users-root',
                    },
                },
            ]),
        ).toBe(false);
    });
});
