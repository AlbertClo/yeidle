import { describe, expect, it } from 'vitest';
import {
    canonicalNavigationUrl,
    isTrackedNavigationUrl,
    navigationParent,
    preferredForwardLocation,
} from './historyNavigation';
import type { NavigationLocation } from './historyNavigation';

function location(
    id: string,
    parentId: string | null,
    lastVisitedAt: string,
): NavigationLocation {
    return {
        id,
        parentId,
        url: `/pages/${id}`,
        pageId: null,
        blockId: null,
        cursorOffset: null,
        selectionType: null,
        scrollTop: 0,
        visitedAt: lastVisitedAt,
        lastVisitedAt,
    };
}

describe('navigation tree', () => {
    it('normalizes the NativePHP window URL to All Pages', () => {
        expect(canonicalNavigationUrl('/?_windowId=main')).toBe('/pages');
        expect(
            canonicalNavigationUrl('/pages/example?_windowId=main&block=one'),
        ).toBe('/pages/example?block=one');
    });

    it('does not record the navigation history page', () => {
        expect(isTrackedNavigationUrl('/navigation-history')).toBe(false);
        expect(isTrackedNavigationUrl('/navigation-history?from=command')).toBe(
            false,
        );
        expect(isTrackedNavigationUrl('/pages')).toBe(true);
    });

    it('navigates back to the current location parent', () => {
        const root = location('root', null, '2026-08-30T01:00:00Z');
        const child = location('child', root.id, '2026-08-30T02:00:00Z');
        const tree = new Map([
            [root.id, root],
            [child.id, child],
        ]);

        expect(navigationParent(tree, child)).toBe(root);
        expect(navigationParent(tree, root)).toBeNull();
    });

    it('keeps branches and forwards to the most recently visited child', () => {
        const root = location('root', null, '2026-08-30T01:00:00Z');
        const olderBranch = location('older', root.id, '2026-08-30T02:00:00Z');
        const recentBranch = location(
            'recent',
            root.id,
            '2026-08-30T03:00:00Z',
        );
        const tree = new Map([
            [root.id, root],
            [olderBranch.id, olderBranch],
            [recentBranch.id, recentBranch],
        ]);

        expect(preferredForwardLocation(tree, root)).toBe(recentBranch);
    });
});
