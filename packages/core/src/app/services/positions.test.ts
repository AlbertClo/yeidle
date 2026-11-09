import { generateNKeysBetween } from 'fractional-indexing';
import { describe, expect, it } from 'vitest';

import { positionAt } from './positions';

describe('positionAt', () => {
    it('matches fractional-indexing for fresh sibling lists', () => {
        const keys = generateNKeysBetween(null, null, 4000);

        keys.forEach((key, index) => expect(positionAt(index)).toBe(key));
    });

    it('rejects negative indexes', () => {
        expect(() => positionAt(-1)).toThrow();
    });
});
