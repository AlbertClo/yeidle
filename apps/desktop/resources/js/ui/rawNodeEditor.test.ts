import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPEN_RAW_NODE_EDITOR_EVENT, openRawNodeEditor } from './rawNodeEditor';

describe('raw node editor', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('notifies the mounted page editor to open', () => {
        const windowTarget = new EventTarget();
        let opened = false;

        windowTarget.addEventListener(OPEN_RAW_NODE_EDITOR_EVENT, () => {
            opened = true;
        });
        vi.stubGlobal('window', windowTarget);

        openRawNodeEditor();

        expect(opened).toBe(true);
    });
});
