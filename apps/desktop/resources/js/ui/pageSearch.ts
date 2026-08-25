export const OPEN_PAGE_SEARCH_EVENT = 'yeidle:open-page-search';

export function openPageSearch(): void {
    window.dispatchEvent(new Event(OPEN_PAGE_SEARCH_EVENT));
}
