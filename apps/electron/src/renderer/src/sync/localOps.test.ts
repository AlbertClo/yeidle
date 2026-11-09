import { describe, expect, it } from 'vitest';

import { opsAffectPageIndex } from './localOps';

describe('opsAffectPageIndex', () => {
    it('treats an unknown durable pull as page-affecting', () => {
        expect(opsAffectPageIndex(null)).toBe(true);
    });

    it('detects operations targeting a page root', () => {
        expect(
            opsAffectPageIndex([
                {
                    type: 'node.set',
                    payload: { id: 'page-1', page_id: 'page-1' },
                },
            ]),
        ).toBe(true);
    });

    it('ignores child-node and media operations', () => {
        expect(
            opsAffectPageIndex([
                {
                    type: 'node.set',
                    payload: { id: 'child-1', page_id: 'page-1' },
                },
                {
                    type: 'media.create',
                    payload: { id: 'media-1' },
                },
            ]),
        ).toBe(false);
    });
});
