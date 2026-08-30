import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestCloudExchangeMock } = vi.hoisted(() => ({
    requestCloudExchangeMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/sync/cloud', () => ({
    requestCloudExchange: requestCloudExchangeMock,
}));

import {
    collapseNode,
    collapsedNodeIds,
    collapsedNodesRootId,
    expandNodes,
    initializeCollapsedNodes,
    opsAffectCollapsedNodes,
} from './collapsedNodes';

describe('collapsed node store', () => {
    beforeEach(() => {
        initializeCollapsedNodes('user-root', []);
        requestCloudExchangeMock.mockClear();
        vi.restoreAllMocks();
    });

    it('optimistically collapses a node and clears descendant folds', async () => {
        initializeCollapsedNodes('user-root', ['child']);
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    root_id: 'user-root',
                    node_ids: ['parent'],
                }),
                { status: 200 },
            ),
        );

        const persistence = collapseNode('parent', ['parent', 'child']);

        expect([...collapsedNodeIds.value]).toEqual(['parent']);
        await persistence;
        expect(fetchMock).toHaveBeenCalledWith('/api/collapsed-nodes', {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                node_ids: ['parent'],
                collapsed: true,
            }),
        });
        expect(requestCloudExchangeMock).toHaveBeenCalledOnce();
    });

    it('expands multiple ancestors and their complete subtrees at once', async () => {
        initializeCollapsedNodes('user-root', [
            'grandparent',
            'parent',
            'unrelated',
        ]);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    root_id: 'user-root',
                    node_ids: ['unrelated'],
                }),
                { status: 200 },
            ),
        );

        const persistence = expandNodes(
            ['grandparent', 'parent'],
            ['grandparent', 'parent', 'target'],
        );

        expect([...collapsedNodeIds.value]).toEqual(['unrelated']);
        await persistence;
        expect([...collapsedNodeIds.value]).toEqual(['unrelated']);
    });

    it('detects operations for the active personal collapse root', () => {
        collapsedNodesRootId.value = 'user-root';

        expect(
            opsAffectCollapsedNodes([
                { payload: { id: 'entry', page_id: 'user-root' } },
            ]),
        ).toBe(true);
        expect(
            opsAffectCollapsedNodes([
                { payload: { id: 'entry', page_id: 'another-root' } },
            ]),
        ).toBe(false);
    });
});
