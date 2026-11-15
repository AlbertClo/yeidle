import { Editor } from '@tiptap/core';
import BulletList from '@tiptap/extension-bullet-list';
import Document from '@tiptap/extension-document';
import ListItem from '@tiptap/extension-list-item';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';
import { FileNode } from './filenode';
import { insertMediaAsSiblingNodes } from './mediaInsertion';
import type { UploadedMedia } from './mediaInsertion';

const TestDocument = Document.extend({ content: 'bulletList' });
const TestListItem = ListItem.extend({
    content: 'block+',
    addAttributes() {
        return {
            blockId: { default: null },
            checked: { default: null },
        };
    },
});

const media = (id: string): UploadedMedia => ({
    id,
    original_name: `${id}.png`,
    mime_type: 'image/png',
    size: 10,
});

let editor: Editor | null = null;

afterEach(() => {
    editor?.destroy();
    editor = null;
});

function createEditor(text?: string): Editor {
    editor = new Editor({
        extensions: [
            TestDocument,
            BulletList,
            TestListItem,
            Paragraph,
            Text,
            FileNode,
        ],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'bulletList',
                    content: [
                        {
                            type: 'listItem',
                            attrs: { blockId: 'anchor', checked: null },
                            content: [
                                {
                                    type: 'paragraph',
                                    content: text
                                        ? [{ type: 'text', text }]
                                        : undefined,
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    });

    return editor;
}

function listItems(instance: Editor): Record<string, any>[] {
    return instance.getJSON().content?.[0].content ?? [];
}

describe('insertMediaAsSiblingNodes', () => {
    it('uses the empty anchor for the first file and adds ordered siblings', () => {
        const instance = createEditor();

        expect(
            insertMediaAsSiblingNodes(instance, 'anchor', [
                media('one'),
                media('two'),
                media('three'),
            ]),
        ).toBe(true);

        const items = listItems(instance);

        expect(items).toHaveLength(3);
        expect(items.map((item) => item.content[0].attrs.mediaId)).toEqual([
            'one',
            'two',
            'three',
        ]);
        expect(items[0].attrs.blockId).toBe('anchor');
        expect(items[1].attrs.blockId).not.toBe(items[2].attrs.blockId);
    });

    it('preserves a non-empty anchor and inserts every file after it', () => {
        const instance = createEditor('Keep me');

        insertMediaAsSiblingNodes(instance, 'anchor', [
            media('one'),
            media('two'),
        ]);

        const items = listItems(instance);

        expect(items).toHaveLength(3);
        expect(items[0].content[0].content[0].text).toBe('Keep me');
        expect(
            items.slice(1).map((item) => item.content[0].attrs.mediaId),
        ).toEqual(['one', 'two']);
    });
});
