import type { Node } from '@/types/node';

interface CachedPage {
    title: string;
    children: Node[];
}

const cache = new Map<string, CachedPage>();
const activePages = new Set<string>();

export function setCachedPage(pageId: string, title: string, children: Node[]) {
    cache.set(pageId, { title, children });
}

export function getCachedPage(pageId: string): CachedPage | undefined {
    return cache.get(pageId);
}

/** Drop a page whose content changed elsewhere (remote sync ops). */
export function invalidateCachedPage(pageId: string): void {
    cache.delete(pageId);
}

export function markCachedPageActive(pageId: string): void {
    activePages.add(pageId);
}

export function markCachedPageInactive(pageId: string): void {
    activePages.delete(pageId);
}

/**
 * Drop cached snapshots changed by remote operations while their editor is
 * closed. An active editor applies the same operations live and owns its
 * cache, so invalidating it here could discard newer local editor state.
 */
export function invalidateInactiveCachedPages(
    documentIds: string[] | null,
): void {
    for (const pageId of [...cache.keys()]) {
        if (
            !activePages.has(pageId) &&
            (documentIds === null || documentIds.includes(pageId))
        ) {
            cache.delete(pageId);
        }
    }
}
