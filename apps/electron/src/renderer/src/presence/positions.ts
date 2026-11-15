import type { Node as PmNode } from '@tiptap/pm/model';

/**
 * Editor positions <-> positions in a block's Loro text.
 *
 * A block is a listItem (attrs.blockId). Its own content is every child
 * except the nested bulletList (child blocks are separate Loro tree nodes).
 * In the Loro text (see core's loro/richText.ts) each textblock child is its
 * characters (an inline atom such as a mention counts 1) followed by one
 * block-end character, and any other child (a file node) is one character.
 * ProseMirror counts a textblock's content the same way, so within a
 * textblock the offsets agree; only the boundaries between children differ.
 */

export type BlockPosition = { blockId: string; index: number };

const isContent = (node: PmNode) => node.type.name !== 'bulletList';

/** The block and Loro index of an editor position, or null outside any block. */
export function toBlockPosition(
    doc: PmNode,
    pos: number,
): BlockPosition | null {
    if (pos < 0 || pos > doc.content.size) {
        return null;
    }

    const $pos = doc.resolve(pos);
    let depth = $pos.depth;

    while (depth > 0 && $pos.node(depth).type.name !== 'listItem') {
        depth--;
    }

    if (depth === 0) {
        return null;
    }

    const item = $pos.node(depth);
    const blockId = item.attrs.blockId as string | null;

    if (!blockId) {
        return null;
    }

    let childStart = $pos.start(depth);
    let index = 0;

    for (let i = 0; i < item.childCount; i++) {
        const child = item.child(i);
        const childEnd = childStart + child.nodeSize;

        if (!isContent(child)) {
            break;
        }

        if (pos <= childStart) {
            return { blockId, index };
        }

        if (pos < childEnd) {
            return child.isTextblock
                ? {
                      blockId,
                      index:
                          index +
                          Math.min(pos - childStart - 1, child.content.size),
                  }
                : { blockId, index };
        }

        index += child.isTextblock ? child.content.size + 1 : 1;
        childStart = childEnd;
    }

    // After the block's own content (e.g. before its child list)
    return { blockId, index: Math.max(0, index - 1) };
}

/** The editor position of a block's Loro index, or null if the block isn't shown. */
export function fromBlockPosition(
    doc: PmNode,
    position: BlockPosition,
): number | null {
    let found: { pos: number; node: PmNode } | null = null;

    doc.descendants((node, pos) => {
        if (found) {
            return false;
        }

        if (
            node.type.name === 'listItem' &&
            node.attrs.blockId === position.blockId
        ) {
            found = { pos, node };

            return false;
        }

        return true;
    });

    if (!found) {
        return null;
    }

    const { pos, node: item } = found as { pos: number; node: PmNode };
    let childStart = pos + 1;
    let remaining = Math.max(0, position.index);
    let lastText: number | null = null;

    for (let i = 0; i < item.childCount; i++) {
        const child = item.child(i);

        if (!isContent(child)) {
            break;
        }

        if (child.isTextblock) {
            if (remaining <= child.content.size) {
                return childStart + 1 + remaining;
            }

            remaining -= child.content.size + 1;
            lastText = childStart + 1 + child.content.size;
        } else {
            if (remaining === 0) {
                return childStart;
            }

            remaining -= 1;
        }

        childStart += child.nodeSize;
    }

    // Past the end (the other side has more text than arrived here yet)
    return lastText ?? pos + 1;
}
