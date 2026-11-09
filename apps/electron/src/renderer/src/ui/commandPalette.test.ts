import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    OPEN_COMMAND_PALETTE_EVENT,
    openCommandPalette,
} from './commandPalette';

describe('command palette', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('notifies the mounted palette to open', () => {
        const windowTarget = new EventTarget();
        let opened = false;

        windowTarget.addEventListener(OPEN_COMMAND_PALETTE_EVENT, () => {
            opened = true;
        });
        vi.stubGlobal('window', windowTarget);

        openCommandPalette();

        expect(opened).toBe(true);
    });
});
