import type { ResolvedPos } from '@tiptap/pm/model';
import { findSuggestionMatch } from '@tiptap/suggestion';
import { describe, expect, it } from 'vitest';
import { WIKI_LINK_ALLOW_SPACES } from './wikilinkMatch';

describe('wiki link suggestions', () => {
    it('keeps matching page names after spaces', () => {
        const text = '[[Current Priority';
        const match = findSuggestionMatch({
            char: '[[',
            allowSpaces: WIKI_LINK_ALLOW_SPACES,
            allowToIncludeChar: false,
            allowedPrefixes: [' '],
            startOfLine: false,
            $position: {
                pos: text.length,
                nodeBefore: { isText: true, text },
            } as unknown as ResolvedPos,
        });

        expect(match?.query).toBe('Current Priority');
    });
});
