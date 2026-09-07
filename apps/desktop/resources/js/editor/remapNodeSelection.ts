import type { Node } from '@tiptap/pm/model';
import { NodeSelection, Selection } from '@tiptap/pm/state';

/** Keep both ends of a selection on the same nodes when lazy content is filled in. */
export function remapNodeSelection(
    selection: Selection,
    doc: Node,
): Selection | null {
    const json = selection.toJSON();

    for (const key of ['anchor', 'head', 'from']) {
        if (typeof json[key] !== 'number') {
            continue;
        }

        const oldPosition = json[key] as number;
        const $position = selection.$from.doc.resolve(
            selection instanceof NodeSelection &&
                selection.node.type.name === 'listItem'
                ? oldPosition + 1
                : oldPosition,
        );
        let depth = $position.depth;

        while (depth > 0 && $position.node(depth).type.name !== 'listItem') {
            depth--;
        }

        if (depth === 0) {
            return null;
        }

        const id = $position.node(depth).attrs.blockId;

        if (!id) {
            return null;
        }

        const offset = oldPosition - $position.before(depth);
        let mapped: number | null = null;
        doc.descendants((node, pos) => {
            if (mapped !== null) {
                return false;
            }

            if (node.type.name === 'listItem' && node.attrs.blockId === id) {
                mapped = pos + Math.min(offset, node.nodeSize - 1);

                return false;
            }
        });

        if (mapped === null) {
            return null;
        }

        json[key] = mapped;
    }

    return Selection.fromJSON(doc, json);
}
