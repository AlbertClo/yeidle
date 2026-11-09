import { describe, expect, it } from 'vitest';

import { adjacentDate, localDateString } from './dailyNotes';

describe('daily note dates', () => {
    it('formats dates using the device calendar rather than UTC', () => {
        expect(localDateString(new Date(2026, 7, 30, 23, 30))).toBe(
            '2026-08-30',
        );
    });

    it('moves across month and year boundaries', () => {
        expect(adjacentDate('2026-03-01', -1)).toBe('2026-02-28');
        expect(adjacentDate('2026-12-31', 1)).toBe('2027-01-01');
    });
});
