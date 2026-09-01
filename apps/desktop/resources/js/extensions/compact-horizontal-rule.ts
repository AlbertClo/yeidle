import { InputRule } from '@tiptap/core';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import { Fragment } from '@tiptap/pm/model';
import type { Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';

interface SplitBlock {
    before: PmNode | null;
    after: PmNode | null;
}

function recreateWithChildren(node: PmNode, children: PmNode[]): PmNode | null {
    if (children.length === 0) {
        return null;
    }

    return node.type.create(
        node.attrs,
        Fragment.fromArray(children),
        node.marks,
    );
}

function splitBlock(
    node: PmNode,
    path: number[],
    beforeEnd: number,
    afterStart: number,
): SplitBlock {
    if (path.length === 0) {
        const before = node.content.cut(0, beforeEnd);
        const after = node.content.cut(afterStart, node.content.size);

        return {
            before:
                before.size > 0
                    ? node.type.create(node.attrs, before, node.marks)
                    : null,
            after:
                after.size > 0
                    ? node.type.create(node.attrs, after, node.marks)
                    : null,
        };
    }

    const childIndex = path[0];
    const childSplit = splitBlock(
        node.child(childIndex),
        path.slice(1),
        beforeEnd,
        afterStart,
    );
    const beforeChildren: PmNode[] = [];
    const afterChildren: PmNode[] = [];

    for (let index = 0; index < childIndex; index++) {
        beforeChildren.push(node.child(index));
    }

    if (childSplit.before) {
        beforeChildren.push(childSplit.before);
    }

    if (childSplit.after) {
        afterChildren.push(childSplit.after);
    }

    for (let index = childIndex + 1; index < node.childCount; index++) {
        afterChildren.push(node.child(index));
    }

    return {
        before: recreateWithChildren(node, beforeChildren),
        after: recreateWithChildren(node, afterChildren),
    };
}

/**
 * Keep a horizontal rule inside its current Yeidle node. A marker on a line
 * within a multiline node becomes another content block alongside the text
 * before and after it, without creating additional sibling nodes.
 */
export const CompactHorizontalRule = HorizontalRule.extend({
    addInputRules() {
        return [
            new InputRule({
                find: (text) => {
                    const match = /(?:^|\n)(---|—-|___\s|\*\*\*\s)$/.exec(text);

                    if (!match) {
                        return null;
                    }

                    const marker = match[1];

                    return {
                        index: text.length - marker.length,
                        text: marker,
                    };
                },
                handler: ({ state, range }) => {
                    const { $from } = state.selection;
                    let listItemDepth = -1;

                    for (let depth = $from.depth; depth >= 0; depth--) {
                        if ($from.node(depth).type.name === 'listItem') {
                            listItemDepth = depth;
                            break;
                        }
                    }

                    if (listItemDepth < 0) {
                        return null;
                    }

                    const textBlock = $from.parent;
                    const textBlockStart = $from.start($from.depth);
                    const markerFrom = range.from - textBlockStart;
                    const markerTo = range.to - textBlockStart;
                    const nodeBefore = textBlock.childBefore(markerFrom);
                    const nodeAfter = textBlock.childAfter(markerTo);
                    const hardBreakBefore =
                        nodeBefore.node?.type.name === 'hardBreak' &&
                        nodeBefore.offset + nodeBefore.node.nodeSize ===
                            markerFrom;
                    const hardBreakAfter =
                        nodeAfter.node?.type.name === 'hardBreak' &&
                        nodeAfter.offset === markerTo;

                    if (markerTo < textBlock.content.size && !hardBreakAfter) {
                        return null;
                    }

                    const listItem = $from.node(listItemDepth);
                    const itemPosition = $from.before(listItemDepth);
                    const directChildIndex = $from.index(listItemDepth);
                    const path: number[] = [];

                    for (
                        let depth = listItemDepth + 1;
                        depth < $from.depth;
                        depth++
                    ) {
                        path.push($from.index(depth));
                    }

                    const split = splitBlock(
                        listItem.child(directChildIndex),
                        path,
                        hardBreakBefore ? nodeBefore.offset : markerFrom,
                        hardBreakAfter
                            ? markerTo + (nodeAfter.node?.nodeSize ?? 0)
                            : markerTo,
                    );
                    const nestedList =
                        listItem.lastChild?.type.name === 'bulletList'
                            ? listItem.lastChild
                            : null;
                    const contentEnd = nestedList
                        ? listItem.childCount - 1
                        : listItem.childCount;
                    const beforeBlocks: PmNode[] = [];
                    const afterBlocks: PmNode[] = [];

                    for (let index = 0; index < directChildIndex; index++) {
                        beforeBlocks.push(listItem.child(index));
                    }

                    if (split.before) {
                        beforeBlocks.push(split.before);
                    }

                    if (split.after) {
                        afterBlocks.push(split.after);
                    }

                    for (
                        let index = directChildIndex + 1;
                        index < contentEnd;
                        index++
                    ) {
                        afterBlocks.push(listItem.child(index));
                    }

                    const dividerPosition =
                        itemPosition +
                        1 +
                        beforeBlocks.reduce(
                            (size, block) => size + block.nodeSize,
                            0,
                        );
                    const contentBlocks = [
                        ...beforeBlocks,
                        this.type.create(),
                        ...afterBlocks,
                        ...(nestedList ? [nestedList] : []),
                    ];
                    const replacement = listItem.type.create(
                        listItem.attrs,
                        contentBlocks,
                        listItem.marks,
                    );

                    state.tr
                        .replaceWith(
                            itemPosition,
                            itemPosition + listItem.nodeSize,
                            replacement,
                        )
                        .setSelection(
                            NodeSelection.create(state.tr.doc, dividerPosition),
                        )
                        .scrollIntoView();
                },
            }),
        ];
    },
});
