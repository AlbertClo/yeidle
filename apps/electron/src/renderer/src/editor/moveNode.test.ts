import { history, redo, undo } from '@tiptap/pm/history';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { moveNodeTransaction } from './moveNode';

const schema = new Schema({
    nodes: {
        doc: { content: 'bulletList' },
        bulletList: { content: 'listItem+' },
        listItem: {
            content: 'paragraph bulletList?',
            attrs: { blockId: { default: '' }, checked: { default: null } },
        },
        paragraph: { content: 'text*' },
        text: {},
    },
});
const item = (id: string, children: ReturnType<typeof schema.node>[] = []) =>
    schema.node('listItem', { blockId: id, checked: false }, [
        schema.node('paragraph', null, schema.text(`text-${id}`)),
        ...(children.length ? [schema.node('bulletList', null, children)] : []),
    ]);
function stateFor(id = 'b'): EditorState {
    const doc = schema.node(
        'doc',
        null,
        schema.node('bulletList', null, [
            item('a'),
            item('b', [item('child'), item('second-child')]),
            item('c'),
        ]),
    );
    const state = EditorState.create({ schema, doc, plugins: [history()] });

    return state.apply(
        state.tr.setSelection(
            TextSelection.create(doc, position(state, id) + 4),
        ),
    );
}
function position(state: EditorState, id: string): number {
    let result = -1;
    state.doc.descendants((node, pos) => {
        if (node.attrs.blockId === id) {
            result = pos;
        }
    });

    return result;
}
function order(state: EditorState): string[] {
    const ids: string[] = [];
    state.doc.firstChild!.forEach((node) => ids.push(node.attrs.blockId));

    return ids;
}

describe('moving outline nodes', () => {
    it('moves the whole subtree and preserves its IDs, checkbox and cursor offset', () => {
        const state = stateFor();
        const original = state.doc.nodeAt(position(state, 'b'))!.toJSON();
        const moved = state.apply(moveNodeTransaction(state, -1)!);
        expect(order(moved)).toEqual(['b', 'a', 'c']);
        expect(moved.doc.nodeAt(position(moved, 'b'))!.toJSON()).toEqual(
            original,
        );
        expect(moved.selection.head).toBe(position(moved, 'b') + 4);
    });
    it('moves downward past a sibling with children, keeping a text selection intact', () => {
        let state = stateFor('a');
        const start = position(state, 'a');
        state = state.apply(
            state.tr.setSelection(
                TextSelection.create(state.doc, start + 3, start + 6),
            ),
        );
        const moved = state.apply(moveNodeTransaction(state, 1)!);
        expect(order(moved)).toEqual(['b', 'a', 'c']);
        expect(moved.selection.anchor).toBe(position(moved, 'a') + 3);
        expect(moved.selection.head).toBe(position(moved, 'a') + 6);
    });
    it('moves nested siblings without changing their parent', () => {
        const moved = stateFor('second-child');
        const result = moved.apply(moveNodeTransaction(moved, -1)!);
        expect(order(result)).toEqual(['a', 'b', 'c']);
        const children = result.doc.nodeAt(position(result, 'b'))!.lastChild!;
        expect(children.firstChild!.attrs.blockId).toBe('second-child');
        expect(children.lastChild!.attrs.blockId).toBe('child');
    });
    it('stops at sibling boundaries and rejects a selection spanning separate nodes', () => {
        expect(moveNodeTransaction(stateFor('a'), -1)).toBeNull();
        expect(moveNodeTransaction(stateFor('c'), 1)).toBeNull();
        expect(moveNodeTransaction(stateFor('child'), -1)).toBeNull();
        let state = stateFor();
        state = state.apply(
            state.tr.setSelection(
                TextSelection.create(
                    state.doc,
                    position(state, 'a') + 2,
                    position(state, 'c') + 3,
                ),
            ),
        );
        expect(moveNodeTransaction(state, 1)).toBeNull();
    });
    it('preserves whole-node selections', () => {
        let state = stateFor();
        state = state.apply(
            state.tr.setSelection(
                NodeSelection.create(state.doc, position(state, 'b')),
            ),
        );
        const moved = state.apply(moveNodeTransaction(state, 1)!);
        expect(order(moved)).toEqual(['a', 'c', 'b']);
        expect(moved.selection).toBeInstanceOf(NodeSelection);
        expect((moved.selection as NodeSelection).node.attrs.blockId).toBe('b');
    });
    it('undoes and redoes a move with the subtree and cursor restored', () => {
        let state = stateFor();
        const original = state.doc.toJSON();
        const selection = state.selection.toJSON();
        state = state.apply(moveNodeTransaction(state, 1)!);
        const moved = state.doc.toJSON();
        expect(
            undo(state, (tr) => {
                state = state.apply(tr);
            }),
        ).toBe(true);
        expect(state.doc.toJSON()).toEqual(original);
        expect(state.selection.toJSON()).toEqual(selection);
        expect(
            redo(state, (tr) => {
                state = state.apply(tr);
            }),
        ).toBe(true);
        expect(state.doc.toJSON()).toEqual(moved);
    });
});
