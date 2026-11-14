import { Schema } from '@tiptap/pm/model';
import type { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { fromBlockPosition, toBlockPosition } from './positions';

// The editor's shape: doc > bulletList > listItem > (content blocks, bulletList?)
const s = new Schema({
    nodes: {
        doc: { content: 'bulletList' },
        bulletList: { content: 'listItem+', group: 'block' },
        listItem: {
            content: 'block+',
            attrs: { blockId: { default: null } },
        },
        paragraph: { group: 'block', content: 'inline*' },
        fileNode: { group: 'block', atom: true },
        text: { group: 'inline' },
        mention: { group: 'inline', inline: true, atom: true },
    },
});

const p = (...content: PmNode[]) => s.node('paragraph', null, content);
const t = (text: string) => s.text(text);
const item = (blockId: string, ...content: PmNode[]) =>
    s.node('listItem', { blockId }, content);
const list = (...items: PmNode[]) => s.node('bulletList', null, items);

/*
 * Block A: "ab" + mention + "c", then a file, then "de"; child block B "xy".
 * A's Loro text: a b @ c ⏎ [file] d e ⏎   (indices 0..8)
 */
const doc = s.node('doc', null, [
    list(
        item(
            'A',
            p(t('ab'), s.node('mention'), t('c')),
            s.node('fileNode'),
            p(t('de')),
            list(item('B', p(t('xy')))),
        ),
    ),
]);

/** Editor position of `offset` inside the paragraph that contains `text`. */
function posIn(text: string, offset: number): number {
    let found = -1;

    doc.descendants((node, pos) => {
        if (
            found === -1 &&
            node.type.name === 'paragraph' &&
            node.textContent.startsWith(text)
        ) {
            found = pos + 1 + offset;
        }
    });

    return found;
}

describe('presence positions', () => {
    it('maps text, atoms and later textblocks to Loro indices', () => {
        expect(toBlockPosition(doc, posIn('ab', 0))).toEqual({
            blockId: 'A',
            index: 0,
        });
        expect(toBlockPosition(doc, posIn('ab', 2))).toEqual({
            blockId: 'A',
            index: 2,
        });
        // After the mention
        expect(toBlockPosition(doc, posIn('ab', 3))).toEqual({
            blockId: 'A',
            index: 3,
        });
        expect(toBlockPosition(doc, posIn('ab', 4))).toEqual({
            blockId: 'A',
            index: 4,
        });
        // "de": after a⏎-ended paragraph (5) and the file (1)
        expect(toBlockPosition(doc, posIn('de', 0))).toEqual({
            blockId: 'A',
            index: 6,
        });
        expect(toBlockPosition(doc, posIn('de', 2))).toEqual({
            blockId: 'A',
            index: 8,
        });
    });

    it('uses the innermost block for nested items', () => {
        expect(toBlockPosition(doc, posIn('xy', 1))).toEqual({
            blockId: 'B',
            index: 1,
        });
    });

    it('round-trips every text position', () => {
        doc.descendants((node, pos) => {
            if (!node.isTextblock) {
                return true;
            }

            for (let offset = 0; offset <= node.content.size; offset++) {
                const editorPos = pos + 1 + offset;
                const block = toBlockPosition(doc, editorPos)!;

                expect(fromBlockPosition(doc, block)).toBe(editorPos);
            }

            return false;
        });
    });

    it('places an index on a file node before the node', () => {
        const filePos = posIn('ab', 4) + 1; // past the paragraph's closing token
        expect(fromBlockPosition(doc, { blockId: 'A', index: 5 })).toBe(
            filePos,
        );
    });

    it('clamps indices past the end and ignores unknown blocks', () => {
        expect(fromBlockPosition(doc, { blockId: 'A', index: 99 })).toBe(
            posIn('de', 2),
        );
        expect(
            fromBlockPosition(doc, { blockId: 'missing', index: 0 }),
        ).toBeNull();
    });
});
