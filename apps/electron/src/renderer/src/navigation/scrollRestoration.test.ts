import { describe, expect, it } from 'vitest';
import { savedMainScrollTop } from './scrollRestoration';

describe('savedMainScrollTop', () => {
    it('returns the first Inertia scroll region position', () => {
        expect(
            savedMainScrollTop({
                scrollRegions: [{ top: 640, left: 0 }],
            }),
        ).toBe(640);
    });

    it('returns zero when no usable position was saved', () => {
        expect(savedMainScrollTop(null)).toBe(0);
        expect(savedMainScrollTop({})).toBe(0);
        expect(savedMainScrollTop({ scrollRegions: [] })).toBe(0);
        expect(savedMainScrollTop({ scrollRegions: [{ top: -1 }] })).toBe(0);
        expect(savedMainScrollTop({ scrollRegions: [{ top: '640' }] })).toBe(0);
    });
});
