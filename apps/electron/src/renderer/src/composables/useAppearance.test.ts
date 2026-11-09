import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSystemTheme } from './useAppearance';

describe('system theme detection', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        [true, 'dark'],
        [false, 'light'],
    ] as const)('uses the system dark mode value %s', (matches, expected) => {
        vi.stubGlobal('window', {
            matchMedia: vi.fn().mockReturnValue({ matches }),
        });

        expect(getSystemTheme()).toBe(expected);
    });
});
