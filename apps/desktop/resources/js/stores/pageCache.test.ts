import { beforeEach, describe, expect, it } from 'vitest';

import type { Node } from '@/types/node';

import {
    getCachedPage,
    invalidateCachedPage,
    invalidateInactiveCachedPages,
    markCachedPageActive,
    markCachedPageInactive,
    setCachedPage,
} from './pageCache';

const children: Node[] = [];

beforeEach(() => {
    for (const pageId of ['page-1', 'page-2']) {
        markCachedPageInactive(pageId);
        invalidateCachedPage(pageId);
    }
});

describe('remote page cache invalidation', () => {
    it('invalidates a remotely changed page while its editor is closed', () => {
        setCachedPage('page-1', 'old title', children);

        invalidateInactiveCachedPages([
            {
                type: 'node.set',
                payload: { id: 'child-1', page_id: 'page-1' },
            },
        ]);

        expect(getCachedPage('page-1')).toBeUndefined();
    });

    it('preserves the active editor cache for live merging', () => {
        setCachedPage('page-1', 'local title', children);
        markCachedPageActive('page-1');

        invalidateInactiveCachedPages([
            {
                type: 'node.set',
                payload: { id: 'child-1', page_id: 'page-1' },
            },
        ]);

        expect(getCachedPage('page-1')?.title).toBe('local title');
    });

    it('invalidates every inactive page after an opaque durable pull', () => {
        setCachedPage('page-1', 'stale', children);
        setCachedPage('page-2', 'active', children);
        markCachedPageActive('page-2');

        invalidateInactiveCachedPages(null);

        expect(getCachedPage('page-1')).toBeUndefined();
        expect(getCachedPage('page-2')?.title).toBe('active');
    });
});
