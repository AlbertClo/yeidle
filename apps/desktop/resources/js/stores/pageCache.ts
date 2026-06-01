import type { Node } from '@/types/node';

interface CachedPage {
    title: string;
    children: Node[];
}

const cache = new Map<string, CachedPage>();

export function setCachedPage(pageId: string, title: string, children: Node[]) {
    cache.set(pageId, { title, children });
}

export function getCachedPage(pageId: string): CachedPage | undefined {
    return cache.get(pageId);
}
