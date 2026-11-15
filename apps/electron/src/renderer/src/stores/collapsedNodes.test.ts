import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestCloudExchangeMock } = vi.hoisted(() => ({
    requestCloudExchangeMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/sync/cloud', () => ({
    requestCloudExchange: requestCloudExchangeMock,
}));

import {
    collapseNode,
    collapseNodes,
    collapsedNodeIds,
    expandNodes,
    initializeCollapsedNodes,
    collapsedNodesChanged,
} from './collapsedNodes';

describe('collapsed node store', () => {
    beforeEach(() => {
        initializeCollapsedNodes([]);
        requestCloudExchangeMock.mockClear();
        vi.restoreAllMocks();
    });

    it('optimistically collapses a node and preserves descendant folds', async () => {
        initializeCollapsedNodes(['child']);
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    block_ids: ['child', 'parent'],
                }),
                { status: 200 },
            ),
        );

        const persistence = collapseNode('parent');

        expect([...collapsedNodeIds.value]).toEqual(['child', 'parent']);
        await persistence;
        expect(fetchMock).toHaveBeenCalledWith('/api/collapsed-blocks', {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                block_ids: ['parent'],
                collapsed: true,
            }),
        });
        expect(requestCloudExchangeMock).toHaveBeenCalledOnce();
    });

    it('expands exactly the requested nodes in one batch', async () => {
        initializeCollapsedNodes([
            'grandparent',
            'parent',
            'unrelated',
        ]);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    block_ids: ['unrelated'],
                }),
                { status: 200 },
            ),
        );

        const persistence = expandNodes(['grandparent', 'parent']);

        expect([...collapsedNodeIds.value]).toEqual(['unrelated']);
        await persistence;
        expect([...collapsedNodeIds.value]).toEqual(['unrelated']);
    });

    it('collapses multiple nodes in one request', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    block_ids: ['parent', 'child'],
                }),
                { status: 200 },
            ),
        );

        const persistence = collapseNodes(['parent', 'child']);

        expect([...collapsedNodeIds.value]).toEqual(['parent', 'child']);
        await persistence;
    });

    it('refreshes only for the user document', () => {
        expect(collapsedNodesChanged(['user:local'])).toBe(true);
        expect(collapsedNodesChanged(null)).toBe(true);
        expect(collapsedNodesChanged(['a-page'])).toBe(false);
    });
});
