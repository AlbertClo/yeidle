import { describe, expect, it } from 'vitest';
import type { Node } from '@/types/node';
import {
    countNodes,
    takeNodePrefix,
    takeNodeWindow,
} from './progressiveNodes';

function node(id: string, children: Node[] = []): Node {
    return {
        id,
        parent_id: null,
        position: id,
        content: id,
        tiptap_content: null,
        is_checked: null,
        modified_hlc: '0',
        created_at: '',
        updated_at: '',
        children,
    };
}

describe('progressive editor nodes', () => {
    const tree = [
        node('one', [node('one-a'), node('one-b', [node('one-b-i')])]),
        node('two'),
    ];

    it('counts nested nodes', () => {
        expect(countNodes(tree)).toBe(5);
    });

    it('takes a depth-first prefix while retaining its hierarchy', () => {
        const prefix = takeNodePrefix(tree, 3);

        expect(prefix.map(({ id }) => id)).toEqual(['one']);
        expect(prefix[0].children?.map(({ id }) => id)).toEqual([
            'one-a',
            'one-b',
        ]);
        expect(prefix[0].children?.[1].children).toEqual([]);
        expect(countNodes(prefix)).toBe(3);
    });

    it('takes a window around a target while retaining its ancestors', () => {
        const window = takeNodeWindow(tree, 'one-b-i', 2);

        expect(window.map(({ id }) => id)).toEqual(['one']);
        expect(window[0].children?.map(({ id }) => id)).toEqual(['one-b']);
        expect(window[0].children?.[0].children?.map(({ id }) => id)).toEqual([
            'one-b-i',
        ]);
        expect(countNodes(window)).toBe(3);
    });

    it('falls back to a prefix when the target is not in the page', () => {
        expect(countNodes(takeNodeWindow(tree, 'missing', 2))).toBe(2);
    });
});
