import { SystemNodes } from '@yeidle/core/app/nodes';
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
    collapsedNodesRootId,
    expandNodes,
    initializeCollapsedNodes,
    collapsedNodesChanged,
} from './collapsedNodes';

describe('collapsed node store', () => {
    beforeEach(() => {
        initializeCollapsedNodes('user-root', []);
        requestCloudExchangeMock.mockClear();
        vi.restoreAllMocks();
    });

    it('optimistically collapses a node and preserves descendant folds', async () => {
        initializeCollapsedNodes('user-root', ['child']);
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    root_id: 'user-root',
                    node_ids: ['child', 'parent'],
                }),
                { status: 200 },
            ),
        );

        const persistence = collapseNode('parent');

        expect([...collapsedNodeIds.value]).toEqual(['child', 'parent']);
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

    it('expands exactly the requested nodes in one batch', async () => {
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

        const persistence = expandNodes(['grandparent', 'parent']);

        expect([...collapsedNodeIds.value]).toEqual(['unrelated']);
        await persistence;
        expect([...collapsedNodeIds.value]).toEqual(['unrelated']);
    });

    it('collapses multiple nodes in one request', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    root_id: 'user-root',
                    node_ids: ['parent', 'child'],
                }),
                { status: 200 },
            ),
        );

        const persistence = collapseNodes(['parent', 'child']);

        expect([...collapsedNodeIds.value]).toEqual(['parent', 'child']);
        await persistence;
    });

    it('refreshes only for the collapsed-state document', () => {
        expect(
            collapsedNodesChanged([SystemNodes.COLLAPSED_NODES_ROOT_ID]),
        ).toBe(true);
        expect(collapsedNodesChanged(null)).toBe(true);
        expect(collapsedNodesChanged(['a-page'])).toBe(false);
    });
});
