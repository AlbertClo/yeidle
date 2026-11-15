import { Schema } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { remapNodeSelection } from './remapNodeSelection';

const schema = new Schema({
    nodes: {
        doc: { content: 'bulletList' },
        bulletList: { content: 'listItem+' },
        listItem: {
            content: 'paragraph',
            attrs: { blockId: { default: null } },
        },
        paragraph: { content: 'text*' },
        text: {},
    },
});
const item = (id: string) =>
    schema.node(
        'listItem',
        { blockId: id },
        schema.node('paragraph', null, schema.text(id.repeat(4))),
    );
const doc = (ids: string[]) =>
    schema.node('doc', null, schema.node('bulletList', null, ids.map(item)));

describe('selection across progressive hydration', () => {
    it('preserves a backwards text range after earlier rows are inserted', () => {
        const before = doc(['b']);
        const after = doc(['a', 'b', 'c']);
        const selection = TextSelection.create(before, 6, 3);
        const mapped = remapNodeSelection(selection, after)!;
        expect(mapped.anchor).toBe(6 + item('a').nodeSize);
        expect(mapped.head).toBe(3 + item('a').nodeSize);
    });
    it('preserves each endpoint when missing rows are inserted between selected nodes', () => {
        const before = doc(['a', 'c']);
        const after = doc(['a', 'b', 'c']);
        const selection = TextSelection.create(
            before,
            3,
            item('a').nodeSize + 4,
        );
        const mapped = remapNodeSelection(selection, after)!;
        expect(mapped.anchor).toBe(3);
        expect(mapped.head).toBe(selection.head + item('b').nodeSize);
    });
    it('preserves whole-node selection and handles removed nodes', () => {
        const before = doc(['b']);
        const selection = NodeSelection.create(before, 1);
        const mapped = remapNodeSelection(selection, doc(['a', 'b']))!;
        expect(mapped).toBeInstanceOf(NodeSelection);
        expect((mapped as NodeSelection).node.attrs.blockId).toBe('b');
        expect(remapNodeSelection(selection, doc(['a']))).toBeNull();
    });
});
