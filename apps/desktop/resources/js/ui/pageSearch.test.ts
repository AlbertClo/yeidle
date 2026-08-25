import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPEN_PAGE_SEARCH_EVENT, openPageSearch } from './pageSearch';

describe('page search', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('notifies the mounted page search to open', () => {
        const windowTarget = new EventTarget();
        let opened = false;

        windowTarget.addEventListener(OPEN_PAGE_SEARCH_EVENT, () => {
            opened = true;
        });
        vi.stubGlobal('window', windowTarget);

        openPageSearch();

        expect(opened).toBe(true);
    });
});
