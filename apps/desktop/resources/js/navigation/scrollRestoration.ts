type HistoryScrollState = {
    scrollRegions?: Array<{ top?: unknown } | null>;
};

export function savedMainScrollTop(state: unknown): number {
    if (state === null || typeof state !== 'object') {
        return 0;
    }

    const top = (state as HistoryScrollState).scrollRegions?.[0]?.top;

    return typeof top === 'number' && Number.isFinite(top) && top > 0 ? top : 0;
}

export function hasSavedMainScrollPosition(): boolean {
    return (
        typeof window !== 'undefined' &&
        savedMainScrollTop(window.history.state) > 0
    );
}
