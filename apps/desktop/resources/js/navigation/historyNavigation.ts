import { router } from '@inertiajs/vue3';
import { uuidv7 } from 'uuidv7';

export type EditorSelectionBookmark = {
    blockId: string;
    offset: number;
    selectionType: 'text' | 'node';
};

export type NavigationLocation = {
    id: string;
    parentId: string | null;
    url: string;
    pageId: string | null;
    blockId: string | null;
    cursorOffset: number | null;
    selectionType: 'text' | 'node' | null;
    scrollTop: number;
    visitedAt: string;
    lastVisitedAt: string;
};

type StoredNavigationLocation = {
    id: string;
    parent_id: string | null;
    url: string;
    page_id: string | null;
    block_id: string | null;
    cursor_offset: number | null;
    selection_type?: 'text' | 'node' | null;
    scroll_top: number;
    visited_at: string;
    last_visited_at: string;
    page_title?: string | null;
};

type NavigationHistoryPayload = {
    locations: StoredNavigationLocation[];
    current_id: string | null;
};

const locations = new Map<string, NavigationLocation>();
let currentId: string | null = null;
let initialized = false;
let loadPromise: Promise<void> | null = null;
let historyNavigation = false;
let restoringLocation: NavigationLocation | null = null;
let treeVisitInFlight = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistenceQueue = Promise.resolve();
let pendingSelectionDeparture: {
    url: string;
    selection: EditorSelectionBookmark;
} | null = null;

function currentUrl(): string {
    return canonicalNavigationUrl(window.location.href);
}

export function canonicalNavigationUrl(value: string | URL): string {
    const url =
        value instanceof URL
            ? new URL(value.toString())
            : new URL(value, 'http://yeidle.local');

    url.searchParams.delete('_windowId');

    const pathname = url.pathname === '/' ? '/pages' : url.pathname;

    return `${pathname}${url.search}`;
}

function normalizeUrl(value: string | URL): string {
    return canonicalNavigationUrl(value);
}

export function isTrackedNavigationUrl(url: string): boolean {
    return canonicalNavigationUrl(url).split('?')[0] !== '/navigation-history';
}

function currentScrollTop(): number {
    return (
        document.querySelector<HTMLElement>('[data-main-scroll]')?.scrollTop ??
        0
    );
}

function urlFields(
    url: string,
): Pick<NavigationLocation, 'pageId' | 'blockId'> {
    const parsed = new URL(url, window.location.origin);
    const match = parsed.pathname.match(
        /^\/pages\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    );

    return {
        pageId: match?.[1] ?? null,
        blockId: match ? parsed.searchParams.get('block') : null,
    };
}

function newLocation(url: string, parentId: string | null): NavigationLocation {
    const timestamp = new Date().toISOString();

    return {
        id: uuidv7(),
        parentId,
        url,
        ...urlFields(url),
        cursorOffset: null,
        selectionType: null,
        scrollTop: 0,
        visitedAt: timestamp,
        lastVisitedAt: timestamp,
    };
}

function applySelection(
    location: NavigationLocation,
    selection: EditorSelectionBookmark,
): void {
    location.blockId = selection.blockId;
    location.cursorOffset = selection.offset;
    location.selectionType = selection.selectionType;
}

function hasSelection(
    location: NavigationLocation,
    selection: EditorSelectionBookmark,
): boolean {
    return (
        location.blockId === selection.blockId &&
        location.cursorOffset === selection.offset &&
        location.selectionType === selection.selectionType
    );
}

function fromStored(location: StoredNavigationLocation): NavigationLocation {
    return {
        id: location.id,
        parentId: location.parent_id,
        url: location.url,
        pageId: location.page_id,
        blockId: location.block_id,
        cursorOffset: location.cursor_offset,
        selectionType: location.selection_type ?? null,
        scrollTop: location.scroll_top,
        visitedAt: location.visited_at,
        lastVisitedAt: location.last_visited_at,
    };
}

function toStored(location: NavigationLocation) {
    return {
        parent_id: location.parentId,
        url: location.url,
        page_id: location.pageId,
        block_id: location.blockId,
        cursor_offset: location.cursorOffset,
        selection_type: location.selectionType,
        scroll_top: Math.max(0, Math.round(location.scrollTop)),
        visited_at: location.visitedAt,
        last_visited_at: location.lastVisitedAt,
    };
}

function enqueuePersistence(task: () => Promise<void>): void {
    persistenceQueue = persistenceQueue.then(task).catch(() => undefined);
}

function persistLocation(
    location: NavigationLocation,
    makeCurrent = false,
): void {
    const snapshot = { ...location };

    enqueuePersistence(async () => {
        await fetch(`/api/navigation-history/locations/${snapshot.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                ...toStored(snapshot),
                make_current: makeCurrent,
            }),
            keepalive: true,
        });
    });
}

function scheduleCurrentPersistence(): void {
    if (persistTimer !== null) {
        clearTimeout(persistTimer);
    }

    persistTimer = setTimeout(() => {
        persistTimer = null;
        const current = currentNavigationLocation();

        if (current) {
            persistLocation(current);
        }
    }, 250);
}

function updateCurrentPosition(scrollTop = currentScrollTop()): void {
    const current = currentNavigationLocation();

    if (!current || current.url !== currentUrl()) {
        return;
    }

    current.scrollTop = scrollTop;
    scheduleCurrentPersistence();
}

async function load(initialUrl: string): Promise<void> {
    const response = await fetch('/api/navigation-history', {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error('Could not load navigation history.');
    }

    const payload = (await response.json()) as NavigationHistoryPayload;
    locations.clear();

    for (const stored of payload.locations) {
        const location = fromStored(stored);
        locations.set(location.id, location);
    }

    currentId = payload.current_id;
    const current = currentNavigationLocation();

    if (
        isTrackedNavigationUrl(initialUrl) &&
        (!current || current.url !== initialUrl)
    ) {
        const location = newLocation(initialUrl, current?.id ?? null);
        locations.set(location.id, location);
        currentId = location.id;
        persistLocation(location, true);
    }
}

function ensureLoaded(initialUrl = currentUrl()): Promise<void> {
    loadPromise ??= load(initialUrl).catch(() => {
        locations.clear();
        currentId = null;

        if (isTrackedNavigationUrl(initialUrl)) {
            const location = newLocation(initialUrl, null);
            locations.set(location.id, location);
            currentId = location.id;
        }
    });

    return loadPromise;
}

async function recordNormalNavigation(
    sourceUrl: string,
    destinationUrl: string,
    sourceScrollTop: number,
): Promise<void> {
    await ensureLoaded(sourceUrl);

    const selectionDeparture =
        pendingSelectionDeparture?.url === sourceUrl
            ? pendingSelectionDeparture.selection
            : null;
    pendingSelectionDeparture = null;

    if (!isTrackedNavigationUrl(destinationUrl)) {
        updateCurrentPosition(sourceScrollTop);

        return;
    }

    let source = currentNavigationLocation();

    if (
        isTrackedNavigationUrl(sourceUrl) &&
        (!source || source.url !== sourceUrl)
    ) {
        source = newLocation(sourceUrl, source?.id ?? null);
        locations.set(source.id, source);
        currentId = source.id;
    }

    // Navigation from a selected editor node or list row records the exact
    // departure. This preserves both where the page was entered and the
    // location from which the user left it.
    if (selectionDeparture && isTrackedNavigationUrl(sourceUrl)) {
        if (
            source &&
            source.url === sourceUrl &&
            hasSelection(source, selectionDeparture)
        ) {
            source.scrollTop = sourceScrollTop;
            applySelection(source, selectionDeparture);
            persistLocation(source);
        } else {
            const departure = newLocation(sourceUrl, source?.id ?? null);
            departure.scrollTop = sourceScrollTop;
            applySelection(departure, selectionDeparture);
            locations.set(departure.id, departure);
            source = departure;
            currentId = departure.id;
            persistLocation(departure);
        }
    }

    if (source && source.url === sourceUrl) {
        source.scrollTop = sourceScrollTop;

        if (!selectionDeparture) {
            persistLocation(source);
        }
    }

    const destination = newLocation(destinationUrl, source?.id ?? null);
    locations.set(destination.id, destination);
    currentId = destination.id;
    persistLocation(destination, true);
}

function handlePopState(): void {
    void ensureLoaded().then(() => {
        const destinationUrl = currentUrl();

        if (!isTrackedNavigationUrl(destinationUrl)) {
            return;
        }

        const current = currentNavigationLocation();
        const parent = navigationParent(locations, current);
        const forward = preferredForwardLocation(locations, current);
        const target =
            [parent, forward].find(
                (location) => location?.url === destinationUrl,
            ) ?? mostRecentlyVisitedUrl(locations, destinationUrl);

        if (!target) {
            return;
        }

        target.lastVisitedAt = new Date().toISOString();
        currentId = target.id;
        restoringLocation = target;
        historyNavigation = true;
        persistLocation(target, true);
    });
}

function handleBeforeVisit(event: DocumentEventMap['inertia:before']): void {
    const visit = event.detail.visit;

    if (visit.method !== 'get' || visit.prefetch || visit.replace) {
        return;
    }

    const sourceUrl = currentUrl();
    const destinationUrl = normalizeUrl(visit.url);

    if (sourceUrl === destinationUrl) {
        pendingSelectionDeparture = null;

        return;
    }

    void recordNormalNavigation(sourceUrl, destinationUrl, currentScrollTop());
}

export function initializeHistoryNavigation(): void {
    if (initialized || typeof window === 'undefined') {
        return;
    }

    initialized = true;
    void ensureLoaded();

    window.addEventListener('popstate', handlePopState);
    document.addEventListener('inertia:before', handleBeforeVisit);
    const finishHistoryVisit = () => {
        window.setTimeout(() => {
            historyNavigation = false;
            restoringLocation = null;
            treeVisitInFlight = false;
        }, 0);
    };

    document.addEventListener('inertia:navigate', finishHistoryVisit);
    document.addEventListener(
        'scroll',
        (event) => {
            if (
                event.target instanceof HTMLElement &&
                event.target.matches('[data-main-scroll]')
            ) {
                updateCurrentPosition(event.target.scrollTop);
            }
        },
        true,
    );
}

export function currentNavigationLocation(): NavigationLocation | null {
    return currentId ? (locations.get(currentId) ?? null) : null;
}

export function navigationParent(
    tree: ReadonlyMap<string, NavigationLocation>,
    current: NavigationLocation | null,
): NavigationLocation | null {
    return current?.parentId ? (tree.get(current.parentId) ?? null) : null;
}

export function preferredForwardLocation(
    tree: ReadonlyMap<string, NavigationLocation>,
    current: NavigationLocation | null,
): NavigationLocation | null {
    if (!current) {
        return null;
    }

    return (
        [...tree.values()]
            .filter((location) => location.parentId === current.id)
            .sort((a, b) =>
                b.lastVisitedAt.localeCompare(a.lastVisitedAt),
            )[0] ?? null
    );
}

function mostRecentlyVisitedUrl(
    tree: ReadonlyMap<string, NavigationLocation>,
    url: string,
): NavigationLocation | null {
    return (
        [...tree.values()]
            .filter((location) => location.url === url)
            .sort((a, b) =>
                b.lastVisitedAt.localeCompare(a.lastVisitedAt),
            )[0] ?? null
    );
}

async function visitTreeLocation(
    target: NavigationLocation | null,
): Promise<boolean> {
    if (!target || treeVisitInFlight) {
        return false;
    }

    const current = currentNavigationLocation();

    if (current && current.url === currentUrl()) {
        current.scrollTop = currentScrollTop();
        persistLocation(current);
    }

    target.lastVisitedAt = new Date().toISOString();
    currentId = target.id;
    restoringLocation = target;
    historyNavigation = true;
    treeVisitInFlight = true;
    persistLocation(target, true);
    router.visit(target.url, {
        replace: true,
        onFinish: () => {
            window.setTimeout(() => {
                historyNavigation = false;
                restoringLocation = null;
                treeVisitInFlight = false;
            }, 0);
        },
    });

    return true;
}

export async function navigateBack(): Promise<boolean> {
    await ensureLoaded();

    return visitTreeLocation(
        navigationParent(locations, currentNavigationLocation()),
    );
}

export async function navigateForward(): Promise<boolean> {
    await ensureLoaded();

    return visitTreeLocation(
        preferredForwardLocation(locations, currentNavigationLocation()),
    );
}

export async function navigateToHistoryLocation(
    locationId: string,
): Promise<boolean> {
    await ensureLoaded();

    return visitTreeLocation(locations.get(locationId) ?? null);
}

export async function clearNavigationHistory(): Promise<void> {
    await ensureLoaded();
    await flushNavigationHistory();

    const response = await fetch('/api/navigation-history', {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error('Could not clear navigation history.');
    }

    locations.clear();
    currentId = null;
    restoringLocation = null;
    historyNavigation = false;
    treeVisitInFlight = false;
}

export function isHistoryNavigation(): boolean {
    return historyNavigation;
}

export function rememberEditorSelection(
    key: string,
    selection: EditorSelectionBookmark,
): void {
    rememberSelection(key, selection);
}

function rememberSelection(
    key: string,
    selection: EditorSelectionBookmark,
): void {
    const current = currentNavigationLocation();
    const url = canonicalNavigationUrl(key);

    if (!current || current.url !== url) {
        return;
    }

    applySelection(current, selection);
    scheduleCurrentPersistence();
}

/**
 * Freeze the exact editor location from which the next page navigation is
 * initiated. The normal selection stream may continue changing while a link
 * popover closes, so this departure is consumed atomically by the upcoming
 * Inertia visit instead of being inferred from whichever cursor update wins.
 */
export function prepareEditorNavigation(
    key: string,
    selection: EditorSelectionBookmark,
): void {
    prepareSelectionNavigation(key, selection);
}

function prepareSelectionNavigation(
    key: string,
    selection: EditorSelectionBookmark,
): void {
    pendingSelectionDeparture = {
        url: canonicalNavigationUrl(key),
        selection: { ...selection },
    };
}

function pageIndexSelection(pageId: string): EditorSelectionBookmark {
    return {
        blockId: pageId,
        offset: 0,
        selectionType: 'node',
    };
}

export function rememberPageIndexSelection(pageId: string): void {
    rememberSelection('/pages', pageIndexSelection(pageId));
}

export function preparePageIndexNavigation(pageId: string): void {
    prepareSelectionNavigation('/pages', pageIndexSelection(pageId));
}

export function recalledPageIndexSelection(): string | null {
    const location =
        restoringLocation?.url === canonicalNavigationUrl('/pages')
            ? restoringLocation
            : null;

    return location?.selectionType === 'node' ? location.blockId : null;
}

export function recalledEditorSelection(
    key: string,
): EditorSelectionBookmark | null {
    const url = canonicalNavigationUrl(key);
    const location = restoringLocation?.url === url ? restoringLocation : null;

    if (
        !location ||
        location.blockId === null ||
        location.cursorOffset === null
    ) {
        return null;
    }

    return {
        blockId: location.blockId,
        offset: location.cursorOffset,
        selectionType: location.selectionType ?? 'text',
    };
}

export function recalledNavigationScrollTop(): number | null {
    return restoringLocation?.scrollTop ?? null;
}

export function restoreNavigationScrollPosition(): void {
    const scrollTop = recalledNavigationScrollTop();

    if (scrollTop === null) {
        return;
    }

    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
            const scrollRegion =
                document.querySelector<HTMLElement>('[data-main-scroll]');

            if (scrollRegion) {
                scrollRegion.scrollTop = scrollTop;
            }
        });
    });
}

export async function flushNavigationHistory(): Promise<void> {
    if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }

    const current = currentNavigationLocation();

    if (current && current.url === currentUrl()) {
        current.scrollTop = currentScrollTop();
        persistLocation(current);
    }

    await persistenceQueue;
}

export async function reloadNavigationHistory(
    initialUrl = currentUrl(),
): Promise<void> {
    locations.clear();
    currentId = null;
    restoringLocation = null;
    historyNavigation = false;
    treeVisitInFlight = false;
    pendingSelectionDeparture = null;
    loadPromise = load(initialUrl);
    await loadPromise;
}
