import { closeHistory } from '@tiptap/pm/history';
import { Fragment } from '@tiptap/pm/model';
import { NodeSelection, Selection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';

/** Move the current node and its entire subtree past one sibling. */
export function moveNodeTransaction(
    state: EditorState,
    direction: -1 | 1,
): Transaction | null {
    const selection = state.selection;
    const $position =
        selection instanceof NodeSelection &&
        selection.node.type.name === 'listItem'
            ? state.doc.resolve(selection.from + 1)
            : selection.$from;

    for (let depth = $position.depth; depth > 0; depth--) {
        const node = $position.node(depth);

        if (node.type.name !== 'listItem') {
            continue;
        }

        const start = $position.before(depth);

        if (selection.to > start + node.nodeSize) {
            return null;
        }

        const parent = $position.node(depth - 1);
        const index = $position.index(depth - 1);
        const siblingIndex = index + direction;

        if (
            parent.type.name !== 'bulletList' ||
            siblingIndex < 0 ||
            siblingIndex >= parent.childCount
        ) {
            return null;
        }

        const sibling = parent.child(siblingIndex);
        const from = direction === -1 ? start - sibling.nodeSize : start;
        const to =
            direction === -1
                ? start + node.nodeSize
                : start + node.nodeSize + sibling.nodeSize;
        const blocks = direction === -1 ? [node, sibling] : [sibling, node];
        const transaction = closeHistory(state.tr).replaceWith(
            from,
            to,
            Fragment.fromArray(blocks),
        );
        const offset = direction * sibling.nodeSize;
        const bookmark = selection.toJSON();

        for (const key of ['anchor', 'head', 'from']) {
            if (typeof bookmark[key] === 'number') {
                bookmark[key] += offset;
            }
        }

        transaction.setSelection(Selection.fromJSON(transaction.doc, bookmark));
        transaction.setMeta('nodeMove', true);

        return transaction.scrollIntoView();
    }

    return null;
}
