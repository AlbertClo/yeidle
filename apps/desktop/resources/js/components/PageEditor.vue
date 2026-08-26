<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import { Extension } from '@tiptap/core';
import Blockquote from '@tiptap/extension-blockquote';
import Bold from '@tiptap/extension-bold';
import BulletList from '@tiptap/extension-bullet-list';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Document from '@tiptap/extension-document';
import Gapcursor from '@tiptap/extension-gapcursor';
import HardBreak from '@tiptap/extension-hard-break';
import Heading from '@tiptap/extension-heading';
import Highlight from '@tiptap/extension-highlight';
import History from '@tiptap/extension-history';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import Italic from '@tiptap/extension-italic';
import ListItem from '@tiptap/extension-list-item';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Strike from '@tiptap/extension-strike';
import Text from '@tiptap/extension-text';
import { Fragment } from '@tiptap/pm/model';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import { generateNKeysBetween } from 'fractional-indexing';
import {
    Download,
    ExternalLink,
    FolderOpen,
    Pencil,
    RotateCcw,
    Trash2,
} from 'lucide-vue-next';
import { GapCursor } from 'prosemirror-gapcursor';
import { uuidv7 } from 'uuidv7';
import { ref, computed, nextTick } from 'vue';
import { onBeforeUnmount } from 'vue';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BlockEmbed } from '@/extensions/blockembed';
import { BlockReference } from '@/extensions/blockreference';
import { FileNode } from '@/extensions/filenode';
import { SlashCommand } from '@/extensions/slashcommand';
import { WebLink } from '@/extensions/weblink';
import { wikiLinkSuggestion } from '@/extensions/wikilink';
import { eventMatchesCommand } from '@/stores/keyBindings';

function openExternal(url: string) {
    fetch('/api/open-external', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ url }),
    });
}
import type { Node } from '@/types/node';

const positionMap = new Map<string, string>();
const childOrderMap = new Map<string | null, string[]>();

function initPositionMap(nodes: Node[], parentId: string | null) {
    const childIds: string[] = [];

    for (const n of nodes) {
        positionMap.set(n.id, n.position);
        childIds.push(n.id);

        if (n.children) {
            initPositionMap(n.children, n.id);
        }
    }

    childOrderMap.set(parentId, childIds);
}

const props = defineProps<{
    nodes: Node[];
    pageId: string;
    // Sync-triggered remounts pass false so the rebuilt editor doesn't
    // steal focus
    autoFocus?: boolean;
}>();

initPositionMap(props.nodes, props.pageId);

const emit = defineEmits<{
    update: [nodes: Node[]];
    focusTitle: [];
    focusBacklinks: [];
}>();

function focusStart() {
    const e = editor.value;

    if (!e) {
        return;
    }

    const doc = e.state.doc;
    let firstItemPos = -1;
    let firstItemNode: any = null;
    doc.descendants((node, pos) => {
        if (firstItemPos >= 0) {
            return false;
        }

        if (node.type.name === 'listItem') {
            firstItemPos = pos;
            firstItemNode = node;

            return false;
        }
    });

    if (
        firstItemNode?.firstChild?.type.name === 'fileNode' ||
        firstItemNode?.firstChild?.type.name === 'blockEmbed'
    ) {
        const gapPos = firstItemPos + 1;
        e.view.focus();
        e.view.dispatch(
            e.state.tr
                .setSelection(new GapCursor(doc.resolve(gapPos)))
                .scrollIntoView(),
        );

        return;
    }

    e.commands.focus('start');
}

// --- Remote sync support (sync design §7) ---

function findListItem(blockId: string): { pos: number; node: PmNode } | null {
    const e = editor.value;

    if (!e) {
        return null;
    }

    let found: { pos: number; node: PmNode } | null = null;
    e.state.doc.descendants((node, pos) => {
        if (found) {
            return false;
        }

        if (node.type.name === 'listItem' && node.attrs.blockId === blockId) {
            found = { pos, node };

            return false;
        }
    });

    return found;
}

/** blockId of the list item containing the current selection, if any. */
function selectionBlockId(): string | null {
    const e = editor.value;

    if (!e || !e.isFocused) {
        return null;
    }

    const $from = e.state.selection.$from;

    for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);

        if (node.type.name === 'listItem') {
            return (node.attrs.blockId as string) ?? null;
        }
    }

    return null;
}

/**
 * Targeted update of one list item's content blocks and checkbox state from
 * remote node data — a surgical transaction that preserves cursor, IME
 * state, and undo history everywhere else. Returns false when it can't
 * apply safely (item missing, selection inside it, schema mismatch); the
 * caller falls back to a structural refresh or deferral.
 */
function applyRemoteContent(nodeData: Node): boolean {
    const e = editor.value;

    if (!e) {
        return false;
    }

    const found = findListItem(nodeData.id);

    if (!found) {
        return false;
    }

    const { pos, node } = found;
    const { from, to } = e.state.selection;

    // Never rewrite under the user's cursor — defer to the caller
    if (e.isFocused && from >= pos && to <= pos + node.nodeSize) {
        return false;
    }

    try {
        const itemJson = nodeToListItem({ ...nodeData, children: [] });
        const blocks = (itemJson.content as Record<string, unknown>[]).filter(
            (b) => b.type !== 'bulletList',
        );
        const newNodes = blocks.map((b) => e.state.schema.nodeFromJSON(b));

        // Content blocks are the contiguous non-bulletList children at the
        // start of the item
        let contentSize = 0;
        node.forEach((child) => {
            if (child.type.name !== 'bulletList') {
                contentSize += child.nodeSize;
            }
        });

        const tr = e.state.tr.replaceWith(
            pos + 1,
            pos + 1 + contentSize,
            newNodes,
        );

        const checked = nodeData.is_checked ?? null;

        if (node.attrs.checked !== checked) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
        }

        tr.setMeta('remoteSync', true);
        tr.setMeta('addToHistory', false);
        e.view.dispatch(tr);

        return true;
    } catch (err) {
        console.warn('sync: targeted remote update failed', err);

        return false;
    }
}

/** Restore focus to a block after a structural refresh remount. */
function focusBlock(blockId: string) {
    const e = editor.value;

    if (!e) {
        return;
    }

    const found = findListItem(blockId);

    if (!found) {
        return;
    }

    e.view.focus();
    e.view.dispatch(
        e.state.tr
            .setSelection(
                TextSelection.near(e.state.doc.resolve(found.pos + 1), 1),
            )
            .scrollIntoView(),
    );
}

defineExpose({ focusStart, applyRemoteContent, selectionBlockId, focusBlock });

// Custom document schema: doc must contain a bulletList
const CustomDocument = Document.extend({
    content: 'bulletList',
});

// Extend ListItem to carry our block ID, with auto-assignment via appendTransaction
const CustomListItem = ListItem.extend({
    content: 'block+',
    addAttributes() {
        return {
            blockId: {
                default: null,
                rendered: false,
                parseHTML: (element: HTMLElement) =>
                    element.getAttribute('data-block-id'),
                renderHTML: (attributes: Record<string, unknown>) => {
                    if (!attributes.blockId) {
                        return {};
                    }

                    return { 'data-block-id': attributes.blockId };
                },
            },
            checked: {
                default: null,
                parseHTML: (element: HTMLElement) => {
                    const val = element.getAttribute('data-checked');

                    if (val === 'true') {
                        return true;
                    }

                    if (val === 'false') {
                        return false;
                    }

                    return null;
                },
                renderHTML: (attributes: Record<string, unknown>) => {
                    if (attributes.checked === null) {
                        return {};
                    }

                    return {
                        'data-checked': String(attributes.checked),
                        class: attributes.checked
                            ? 'is-checked'
                            : 'is-unchecked',
                    };
                },
            },
        };
    },
    addProseMirrorPlugins() {
        return [
            new Plugin({
                appendTransaction: (_transactions, _oldState, newState) => {
                    const seen = new Set<string>();
                    const tr = newState.tr;
                    let modified = false;
                    newState.doc.descendants((node, pos) => {
                        if (node.type.name === 'listItem') {
                            const id = node.attrs.blockId;

                            if (!id || seen.has(id)) {
                                tr.setNodeMarkup(pos, undefined, {
                                    ...node.attrs,
                                    blockId: uuidv7(),
                                });
                                modified = true;
                            } else {
                                seen.add(id);
                            }
                        }
                    });

                    if (modified) {
                        tr.setMeta('blockIdAssignment', true);

                        return tr;
                    }

                    return null;
                },
            }),
        ];
    },
});

function isInCodeBlock(editor: {
    state: { selection: { $head: { parent: { type: { name: string } } } } };
}) {
    return editor.state.selection.$head.parent.type.name === 'codeBlock';
}

function isListItemEmpty(node: {
    childCount: number;
    child: (i: number) => {
        type: { name: string };
        content: { size: number };
        isTextblock: boolean;
    };
}) {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);

        if (child.type.name !== 'bulletList') {
            if (child.content.size > 0 || !child.isTextblock) {
                return false;
            }
        }
    }

    return true;
}

function handleRangeDeleteAcrossListItems(editor: {
    state: any;
    view: any;
}): boolean {
    const { from, to } = editor.state.selection;
    const $from = editor.state.doc.resolve(from);
    const $to = editor.state.doc.resolve(to);

    let fromItemDepth = -1;

    for (let d = $from.depth; d >= 0; d--) {
        if ($from.node(d).type.name === 'listItem') {
            fromItemDepth = d;
            break;
        }
    }

    let toItemDepth = -1;

    for (let d = $to.depth; d >= 0; d--) {
        if ($to.node(d).type.name === 'listItem') {
            toItemDepth = d;
            break;
        }
    }

    if (fromItemDepth < 0 || toItemDepth < 0) {
        return false;
    }

    if ($from.before(fromItemDepth) === $to.before(toItemDepth)) {
        return false;
    }

    const keepBlockId = $from.node(fromItemDepth).attrs.blockId;

    // Track nodes that currently have content — if they become empty after
    // the delete, they're artifacts that need cleanup
    const hadContent = new Set<string>();
    editor.state.doc.descendants((node: any) => {
        if (
            node.type.name === 'listItem' &&
            node.attrs.blockId &&
            !isListItemEmpty(node)
        ) {
            hadContent.add(node.attrs.blockId);
        }
    });

    const tr = editor.state.tr;
    tr.deleteSelection();

    // Remove newly-emptied listItems (artifacts of the range delete).
    // Process one at a time and re-scan, since each removal shifts positions.
    for (;;) {
        let emptyPos = -1;
        let emptyNode: any = null;
        tr.doc.descendants((node: any, pos: number) => {
            if (emptyNode) {
                return false;
            }

            if (
                node.type.name === 'listItem' &&
                hadContent.has(node.attrs.blockId) &&
                isListItemEmpty(node)
            ) {
                emptyPos = pos;
                emptyNode = node;

                return false;
            }
        });

        if (!emptyNode) {
            break;
        }

        const nestedList =
            emptyNode.lastChild?.type.name === 'bulletList'
                ? emptyNode.lastChild
                : null;

        if (nestedList) {
            tr.replaceWith(
                emptyPos,
                emptyPos + emptyNode.nodeSize,
                nestedList.content,
            );
        } else {
            const $p = tr.doc.resolve(emptyPos);

            if (
                $p.parent.type.name === 'bulletList' &&
                $p.parent.childCount === 1
            ) {
                tr.delete($p.before($p.depth), $p.after($p.depth));
            } else {
                tr.delete(emptyPos, emptyPos + emptyNode.nodeSize);
            }
        }
    }

    // Restore blockId on the merged listItem
    const cursorPos = tr.mapping.map(from);
    const $cursor = tr.doc.resolve(cursorPos);

    for (let d = $cursor.depth; d >= 0; d--) {
        if ($cursor.node(d).type.name === 'listItem') {
            const itemPos = $cursor.before(d);
            const item = $cursor.node(d);

            if (item.attrs.blockId !== keepBlockId) {
                tr.setNodeMarkup(itemPos, undefined, {
                    ...item.attrs,
                    blockId: keepBlockId,
                });
            }

            break;
        }
    }

    tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)));
    editor.view.dispatch(tr);

    return true;
}

// Highlight active line and selected lines
const ActiveLineHighlight = Extension.create({
    name: 'activeLineHighlight',
    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('activeLineHighlight'),
                props: {
                    decorations: (state) => {
                        const { from, to } = state.selection;
                        const decorations: Decoration[] = [];

                        if (from === to) {
                            // Cursor — find the deepest listItem containing it
                            const $pos = state.doc.resolve(from);

                            for (let d = $pos.depth; d >= 0; d--) {
                                if ($pos.node(d).type.name === 'listItem') {
                                    const pos = $pos.before(d);
                                    decorations.push(
                                        Decoration.node(
                                            pos,
                                            pos + $pos.node(d).nodeSize,
                                            { class: 'active-line' },
                                        ),
                                    );
                                    break;
                                }
                            }
                        } else {
                            // Selection — highlight only listItems whose direct text content overlaps
                            state.doc.descendants((node, pos) => {
                                if (node.type.name === 'listItem') {
                                    // Get the range of the first child (the text block, not nested lists)
                                    const firstChild = node.firstChild;

                                    if (firstChild) {
                                        const textStart = pos + 1;
                                        const textEnd =
                                            textStart + firstChild.nodeSize;

                                        if (from < textEnd && to > textStart) {
                                            decorations.push(
                                                Decoration.node(
                                                    pos,
                                                    pos + node.nodeSize,
                                                    { class: 'selected-line' },
                                                ),
                                            );
                                        }
                                    }
                                }
                            });
                        }

                        return DecorationSet.create(state.doc, decorations);
                    },
                },
            }),
        ];
    },
});

// Override Enter to always split list items (never lift/exit the list)
const AlwaysSplitListItem = Extension.create({
    name: 'alwaysSplitListItem',
    addKeyboardShortcuts() {
        return {
            Tab: ({ editor }) => {
                if (isInCodeBlock(editor)) {
                    return false;
                }

                editor.commands.sinkListItem('listItem');

                return true;
            },
            'Shift-Tab': ({ editor }) => {
                if (isInCodeBlock(editor)) {
                    return false;
                }

                editor.commands.liftListItem('listItem');

                return true;
            },
            Backspace: ({ editor }) => {
                if (isInCodeBlock(editor)) {
                    return false;
                }

                if (!editor.state.selection.empty) {
                    return handleRangeDeleteAcrossListItems(editor);
                }

                const { $head } = editor.state.selection;

                if ($head.parentOffset === 0) {
                    // If in a non-paragraph textblock (heading, etc.), convert to paragraph first
                    if ($head.parent.type.name !== 'paragraph') {
                        const pos = $head.before($head.depth);
                        const tr = editor.state.tr.setNodeMarkup(
                            pos,
                            editor.schema.nodes.paragraph,
                        );
                        editor.view.dispatch(tr);

                        return true;
                    }

                    // Find the current list item
                    for (let d = $head.depth; d >= 0; d--) {
                        if ($head.node(d).type.name === 'listItem') {
                            const indexInParent = $head.index(d - 1);

                            // First item in the top-level list — nothing to merge with
                            if (
                                indexInParent === 0 &&
                                $head.node(d - 1) ===
                                    editor.state.doc.firstChild
                            ) {
                                break;
                            }

                            const currentItemStart = $head.start(d) - 1;
                            const currentItemEnd = $head.end(d) + 1;
                            const currentContent = $head.parent.content;

                            // Find the end of the previous visible text block
                            let targetEnd = currentItemStart;
                            editor.state.doc.nodesBetween(
                                0,
                                currentItemStart,
                                (node, pos) => {
                                    if (node.isTextblock) {
                                        targetEnd = pos + node.nodeSize - 1;
                                    }
                                },
                            );

                            if (targetEnd === currentItemStart) {
                                break;
                            }

                            const currentItem = $head.node(d);
                            const nestedList =
                                currentItem.lastChild?.type.name ===
                                'bulletList'
                                    ? currentItem.lastChild
                                    : null;

                            let tr = editor.state.tr;

                            // Insert current block's content at end of target text block
                            if (currentContent.size > 0) {
                                tr = tr.insert(targetEnd, currentContent);
                            }

                            const offset = currentContent.size;

                            // If the current item has children, merge them into the parent's children
                            if (nestedList) {
                                // If this is the first child in a nested list (indexInParent === 0),
                                // insert children's items at the start of the parent's nested list
                                // (before any siblings). Otherwise insert at end of target listItem.
                                if (indexInParent === 0) {
                                    // Insert child items at the position of the current item
                                    // (which is at currentItemStart), so they appear before siblings
                                    tr = tr.insert(
                                        currentItemStart + offset,
                                        nestedList.content,
                                    );
                                } else {
                                    // Find the target listItem that contains targetEnd
                                    let targetListItemEnd = 0;
                                    const $target =
                                        editor.state.doc.resolve(targetEnd);

                                    for (
                                        let td = $target.depth;
                                        td >= 0;
                                        td--
                                    ) {
                                        if (
                                            $target.node(td).type.name ===
                                            'listItem'
                                        ) {
                                            targetListItemEnd = $target.end(td);
                                            break;
                                        }
                                    }

                                    tr = tr.insert(
                                        targetListItemEnd + offset,
                                        nestedList,
                                    );
                                }
                            }

                            const nestedOffset = nestedList
                                ? indexInParent === 0
                                    ? nestedList.content.size
                                    : nestedList.nodeSize
                                : 0;

                            // Determine delete range
                            let delFrom =
                                currentItemStart + offset + nestedOffset;
                            let delTo = currentItemEnd + offset + nestedOffset;
                            const parentList = $head.node(d - 1);

                            if (
                                parentList.type.name === 'bulletList' &&
                                parentList.childCount === 1
                            ) {
                                delFrom =
                                    $head.start(d - 1) -
                                    1 +
                                    offset +
                                    nestedOffset;
                                delTo =
                                    $head.end(d - 1) +
                                    1 +
                                    offset +
                                    nestedOffset;
                            }

                            tr = tr.delete(delFrom, delTo);
                            // Place cursor at join point
                            tr = tr.setSelection(
                                TextSelection.near(tr.doc.resolve(targetEnd)),
                            );
                            editor.view.dispatch(tr);

                            return true;
                        }
                    }
                }

                return false;
            },
            Delete: ({ editor }) => {
                if (isInCodeBlock(editor)) {
                    return false;
                }

                if (!editor.state.selection.empty) {
                    return handleRangeDeleteAcrossListItems(editor);
                }

                const { $head } = editor.state.selection;

                if ($head.parentOffset === $head.parent.content.size) {
                    for (let d = $head.depth; d >= 0; d--) {
                        if ($head.node(d).type.name === 'listItem') {
                            const listItem = $head.node(d);
                            const parent = $head.node(d - 1);
                            const indexInParent = $head.index(d - 1);

                            // Check if the next thing is a nested bulletList (child nodes)
                            // The listItem's content is: [paragraph, ...otherBlocks, bulletList?]
                            const lastChild = listItem.lastChild;

                            if (
                                lastChild?.type.name === 'bulletList' &&
                                $head.parent.type.name !== 'bulletList'
                            ) {
                                // Merge first child's text into current text block
                                const firstChildItem = lastChild.firstChild;

                                if (firstChildItem) {
                                    const firstChildParagraph =
                                        firstChildItem.firstChild;
                                    const childContent =
                                        firstChildParagraph?.content;
                                    const cursorPos = $head.pos;

                                    // Check if the first child has its own nested list (grandchildren)
                                    const firstChildNestedList =
                                        firstChildItem.lastChild?.type.name ===
                                        'bulletList'
                                            ? firstChildItem.lastChild
                                            : null;

                                    // Find the first child listItem's position
                                    const listItemStart = $head.start(d) - 1;
                                    let nestedListPos = 0;
                                    let childItemPos = 0;
                                    editor.state.doc.nodesBetween(
                                        listItemStart,
                                        listItemStart + listItem.nodeSize,
                                        (node, pos) => {
                                            if (node === lastChild) {
                                                nestedListPos = pos;
                                            }

                                            if (node === firstChildItem) {
                                                childItemPos = pos;
                                            }
                                        },
                                    );

                                    let tr = editor.state.tr;

                                    // Insert child's content at cursor
                                    if (childContent && childContent.size > 0) {
                                        tr = tr.insert(cursorPos, childContent);
                                    }

                                    let offset = childContent?.size ?? 0;

                                    // If the first child had grandchildren, insert them into the parent's nested list
                                    if (firstChildNestedList) {
                                        // Insert grandchildren's items into the parent's nested list, before the remaining siblings
                                        const grandchildrenInsertPos =
                                            nestedListPos + offset + 1; // inside the bulletList, at the start
                                        tr = tr.insert(
                                            grandchildrenInsertPos,
                                            firstChildNestedList.content,
                                        );
                                        offset +=
                                            firstChildNestedList.content.size;
                                    }

                                    // Delete the child listItem (or the whole bulletList if it's the only child)
                                    if (
                                        lastChild.childCount === 1 &&
                                        !firstChildNestedList
                                    ) {
                                        tr = tr.delete(
                                            nestedListPos + offset,
                                            nestedListPos +
                                                offset +
                                                lastChild.nodeSize,
                                        );
                                    } else {
                                        tr = tr.delete(
                                            childItemPos + offset,
                                            childItemPos +
                                                offset +
                                                firstChildItem.nodeSize,
                                        );
                                    }

                                    tr = tr.setSelection(
                                        TextSelection.near(
                                            tr.doc.resolve(cursorPos),
                                        ),
                                    );
                                    editor.view.dispatch(tr);

                                    return true;
                                }
                            }

                            if (indexInParent < parent.childCount - 1) {
                                const endOfItem = $head.end(d) + 1;
                                let tr = editor.state.tr.join(endOfItem);
                                // After joining list items, join the text blocks inside
                                const $joinPos = tr.doc.resolve(endOfItem - 1);

                                if (
                                    $joinPos.nodeBefore?.isTextblock &&
                                    $joinPos.nodeAfter?.isTextblock
                                ) {
                                    tr = tr.join(endOfItem - 1);
                                }

                                editor.view.dispatch(tr);

                                return true;
                            }

                            break;
                        }
                    }
                }

                return false;
            },
            Enter: ({ editor }) => {
                if (isInCodeBlock(editor)) {
                    return editor.commands.command(({ tr, dispatch }) => {
                        if (dispatch) {
                            tr.insertText('\n');
                        }

                        return true;
                    });
                }

                const { $head: $enterHead } = editor.state.selection;
                const isEmptyBlock = $enterHead.parent.content.size === 0;

                let isLastBlockInItem = false;

                if (isEmptyBlock) {
                    for (let d = $enterHead.depth; d >= 0; d--) {
                        if ($enterHead.node(d).type.name === 'listItem') {
                            isLastBlockInItem =
                                $enterHead.indexAfter(d) ===
                                $enterHead.node(d).childCount;
                            break;
                        }
                    }
                }

                if (
                    !(isEmptyBlock && isLastBlockInItem) &&
                    editor.commands.splitListItem('listItem')
                ) {
                    editor.view.dispatch(editor.state.tr.scrollIntoView());

                    return true;
                }

                // Empty node or splitListItem failed — manually insert a new list item after current
                const { $head } = editor.state.selection;
                const listItemType = editor.schema.nodes.listItem;
                const paragraphType = editor.schema.nodes.paragraph;

                // Find the end of the current list item
                for (let d = $head.depth; d >= 0; d--) {
                    if ($head.node(d).type === listItemType) {
                        const endPos = $head.end(d) + 1;
                        const newItem = listItemType.create(null, [
                            paragraphType.create(),
                        ]);
                        const tr = editor.state.tr.insert(endPos, newItem);
                        tr.setSelection(
                            TextSelection.near(tr.doc.resolve(endPos + 1)),
                        );
                        tr.scrollIntoView();
                        editor.view.dispatch(tr);

                        return true;
                    }
                }

                return false;
            },
        };
    },
});

// Convert our Node tree to TipTap JSON
function nodesToTiptap(nodes: Node[]): Record<string, unknown> {
    return {
        type: 'doc',
        content: [
            {
                type: 'bulletList',
                content:
                    nodes.length > 0
                        ? nodes.map(nodeToListItem)
                        : [
                              {
                                  type: 'listItem',
                                  attrs: { blockId: uuidv7() },
                                  content: [{ type: 'paragraph' }],
                              },
                          ],
            },
        ],
    };
}

function sanitizeTiptapContent(
    node: Record<string, unknown>,
): Record<string, unknown> {
    if (node.content && Array.isArray(node.content)) {
        node.content = (node.content as Record<string, unknown>[])
            .filter((child) => {
                // Remove text nodes with null/undefined text
                if (child.type === 'text' && !child.text) {
                    return false;
                }

                return true;
            })
            .map(sanitizeTiptapContent);
    }

    return node;
}

function nodeToListItem(node: Node): Record<string, unknown> {
    // Use stored TipTap JSON if available, otherwise fall back to plain text paragraph
    let contentBlocks: Record<string, unknown>[];

    if (node.tiptap_content) {
        if (Array.isArray(node.tiptap_content)) {
            contentBlocks = node.tiptap_content.map(
                (b: Record<string, unknown>) =>
                    sanitizeTiptapContent(JSON.parse(JSON.stringify(b))),
            );
        } else {
            contentBlocks = [
                sanitizeTiptapContent(
                    JSON.parse(JSON.stringify(node.tiptap_content)),
                ),
            ];
        }
    } else {
        contentBlocks = [
            {
                type: 'paragraph',
                content: node.content
                    ? [{ type: 'text', text: node.content }]
                    : undefined,
            },
        ];
    }

    const content: Record<string, unknown>[] = [...contentBlocks];

    if (node.children && node.children.length > 0) {
        content.push({
            type: 'bulletList',
            content: node.children.map(nodeToListItem),
        });
    }

    return {
        type: 'listItem',
        attrs: { blockId: node.id, checked: node.is_checked ?? null },
        content,
    };
}

// Convert TipTap JSON back to our Node tree
function tiptapToNodes(
    doc: Record<string, unknown>,
    parentId: string | null,
): Node[] {
    const bulletList = (doc.content as Record<string, unknown>[])?.[0];

    if (!bulletList || bulletList.type !== 'bulletList') {
        return [];
    }

    return listToNodes(bulletList, parentId);
}

function assignPositions(
    items: Record<string, unknown>[],
    parentId: string | null,
): string[] {
    const blockIds = items.map(
        (item) =>
            ((item.attrs as Record<string, unknown>)?.blockId as string) ?? '',
    );
    const oldOrder = childOrderMap.get(parentId) ?? [];

    const orderChanged =
        blockIds.length !== oldOrder.length ||
        blockIds.some((id, i) => id !== oldOrder[i]);

    if (!orderChanged) {
        return blockIds.map((id) => positionMap.get(id) ?? 'a0');
    }

    const positions = generateNKeysBetween(null, null, blockIds.length);
    blockIds.forEach((id, i) => {
        if (id) {
            positionMap.set(id, positions[i]);
        }
    });
    childOrderMap.set(parentId, blockIds);

    return positions;
}

function listToNodes(
    bulletList: Record<string, unknown>,
    parentId: string | null,
): Node[] {
    const items = (bulletList.content as Record<string, unknown>[]) ?? [];
    const positions = assignPositions(items, parentId);

    return items.map((item, index) =>
        listItemToNode(item, parentId, positions[index]),
    );
}

function listItemToNode(
    item: Record<string, unknown>,
    parentId: string | null,
    position: string,
): Node {
    const attrs = (item.attrs as Record<string, unknown>) ?? {};
    const content = (item.content as Record<string, unknown>[]) ?? [];

    // Extract all content blocks (everything except nested bulletList)
    const contentBlocks = content.filter((c) => c.type !== 'bulletList');
    let textContent = '';
    const extractText = (node: Record<string, unknown>): string => {
        if (node.text) {
            return node.text as string;
        }

        if (node.type === 'mention') {
            const a = node.attrs as Record<string, unknown>;

            return `[[${a?.label ?? a?.id ?? ''}]]`;
        }

        if (node.type === 'blockReference') {
            const a = node.attrs as Record<string, unknown>;

            return `((${a?.fallback ?? a?.targetUid ?? ''}))`;
        }

        if (node.type === 'blockEmbed') {
            const a = node.attrs as Record<string, unknown>;

            return `{{embed: ((${a?.fallback ?? a?.targetUid ?? ''}))}}`;
        }

        if (node.type === 'fileNode') {
            const a = node.attrs as Record<string, unknown>;

            return `[${a?.originalName ?? 'File'}]`;
        }

        const children = (node.content as Record<string, unknown>[]) ?? [];

        return children.map(extractText).join('');
    };
    textContent = contentBlocks.map(extractText).join(' ');

    const nestedList = content.find((c) => c.type === 'bulletList');
    const blockId = attrs.blockId as string;
    const children = nestedList ? listToNodes(nestedList, blockId) : [];

    // Store tiptap_content: single block as object, multiple as array
    let tiptapContent:
        | Record<string, unknown>
        | Record<string, unknown>[]
        | null = null;

    if (contentBlocks.length === 1) {
        tiptapContent = sanitizeTiptapContent(
            JSON.parse(JSON.stringify(contentBlocks[0])),
        );
    } else if (contentBlocks.length > 1) {
        tiptapContent = contentBlocks.map((b) =>
            sanitizeTiptapContent(JSON.parse(JSON.stringify(b))),
        );
    }

    return {
        id: blockId,
        parent_id: parentId,
        position,
        content: textContent,
        tiptap_content: tiptapContent,
        is_checked: typeof attrs.checked === 'boolean' ? attrs.checked : null,
        modified_hlc: '',
        created_at: '',
        updated_at: '',
        children,
    };
}

let userHasInteracted = false;
let lastArrowDirection = 0; // -1 for up, 1 for down, 0 for none

// Media menu popover
const mediaMenu = ref<{
    visible: boolean;
    top: number;
    left: number;
    mediaId: string;
    src: string;
    originalName: string;
    selectedIndex: number;
}>({
    visible: false,
    top: 0,
    left: 0,
    mediaId: '',
    src: '',
    originalName: '',
    selectedIndex: 0,
});
const mediaMenuRef = ref<HTMLElement>();

function showMediaMenu(btn: HTMLElement, mediaId: string) {
    const rect = btn.getBoundingClientRect();
    const editorEl = document
        .querySelector('.ProseMirror')
        ?.closest('.relative')
        ?.getBoundingClientRect();

    if (!editorEl) {
        return;
    }

    const fileNode = btn.closest('.file-node') as HTMLElement;
    const src =
        fileNode?.querySelector('img')?.src ||
        fileNode?.querySelector('video')?.src ||
        '';
    const originalName = fileNode?.getAttribute('data-original-name') || 'file';
    mediaMenu.value = {
        visible: true,
        top: rect.bottom - editorEl.top + 4,
        left: rect.left - editorEl.left,
        mediaId,
        src,
        originalName,
        selectedIndex: 0,
    };
    nextTick(() => mediaMenuRef.value?.focus());
}

function hideMediaMenu() {
    mediaMenu.value.visible = false;
    editor.value?.commands.focus();
}

function mediaDownload() {
    const { src, originalName } = mediaMenu.value;
    const a = document.createElement('a');
    a.href = src;
    a.download = originalName;
    a.click();
    hideMediaMenu();
}

function mediaOpen() {
    fetch(`/api/media/${mediaMenu.value.mediaId}/open`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    hideMediaMenu();
}

function mediaOpenFolder() {
    fetch(`/api/media/${mediaMenu.value.mediaId}/open-folder`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    hideMediaMenu();
}

function mediaDelete() {
    if (!editor.value) {
        return;
    }

    // Find and delete the fileNode from the editor
    const { state } = editor.value;
    let nodePos: number | null = null;
    state.doc.descendants((node, pos) => {
        if (
            node.type.name === 'fileNode' &&
            node.attrs.mediaId === mediaMenu.value.mediaId
        ) {
            nodePos = pos;

            return false;
        }
    });

    if (nodePos !== null) {
        editor.value
            .chain()
            .focus()
            .deleteRange({ from: nodePos, to: nodePos + 1 })
            .run();
    }

    hideMediaMenu();
}

const mediaMenuActions = [
    mediaDownload,
    mediaOpen,
    mediaOpenFolder,
    mediaDelete,
];

function handleMediaMenuKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        mediaMenu.value.selectedIndex = Math.min(
            mediaMenu.value.selectedIndex + 1,
            mediaMenuActions.length - 1,
        );
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        mediaMenu.value.selectedIndex = Math.max(
            mediaMenu.value.selectedIndex - 1,
            0,
        );
    } else if (e.key === 'Enter') {
        e.preventDefault();
        mediaMenuActions[mediaMenu.value.selectedIndex]();
    } else if (e.key === 'Escape') {
        hideMediaMenu();
    }
}

// Link popover state (shared for wikilinks and web links)
const linkPopover = ref<{
    visible: boolean;
    top: number;
    left: number;
    type: 'mention' | 'webLink';
    pageId: string;
    label: string;
    href: string;
    pos: number;
    selectedIndex: number;
}>({
    visible: false,
    top: 0,
    left: 0,
    type: 'mention',
    pageId: '',
    label: '',
    href: '',
    pos: 0,
    selectedIndex: 0,
});
const popoverRef = ref<HTMLElement>();

function showLinkPopover(view: any) {
    const sel = view.state.selection;
    const node = sel.node;
    const coords = view.coordsAtPos(sel.from);
    const editorEl = document
        .querySelector('.ProseMirror')
        ?.getBoundingClientRect();

    if (!editorEl) {
        return;
    }

    linkPopover.value = {
        visible: true,
        top: coords.bottom - editorEl.top + 4,
        left: coords.left - editorEl.left,
        type: node.type.name as 'mention' | 'webLink',
        pageId: node.attrs.id ?? '',
        label: node.attrs.label ?? '',
        href: node.attrs.href ?? '',
        pos: sel.from,
        selectedIndex: 0,
    };
    nextTick(() => {
        popoverRef.value?.focus();
    });
}

function hideLinkPopover() {
    linkPopover.value.visible = false;
}

function followLink() {
    const { type, pageId, href } = linkPopover.value;
    hideLinkPopover();

    if (type === 'mention' && pageId) {
        router.visit(`/pages/${pageId}`);
    } else if (type === 'webLink' && href) {
        openExternal(href);
    }
}

function handlePopoverKeydown(e: KeyboardEvent) {
    const actions =
        linkPopover.value.type === 'mention'
            ? [followLink, updateLink]
            : [followLink, updateWebLink];

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        linkPopover.value.selectedIndex = Math.min(
            linkPopover.value.selectedIndex + 1,
            actions.length - 1,
        );
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        linkPopover.value.selectedIndex = Math.max(
            linkPopover.value.selectedIndex - 1,
            0,
        );
    } else if (e.key === 'Enter') {
        e.preventDefault();
        actions[linkPopover.value.selectedIndex]();
    } else if (e.key === 'q' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        followLink();
    } else if (e.key === 'Escape') {
        hideLinkPopover();
        editor.value?.commands.focus();
    }
}

// Update link modal state
const updateLinkModal = ref({
    visible: false,
    pageQuery: '',
    label: '',
    selectedPageId: '',
    selectedPageTitle: '',
    pos: 0,
    searchResults: [] as { id: string; content: string }[],
    searchSelectedIndex: 0,
});

function updateLink() {
    const pageId = linkPopover.value.pageId;
    const label = linkPopover.value.label;
    const pos = linkPopover.value.pos;
    hideLinkPopover();

    updateLinkModal.value = {
        visible: true,
        pageQuery: '',
        label: label,
        selectedPageId: pageId,
        selectedPageTitle: label,
        pos: pos,
        searchResults: [],
        searchSelectedIndex: 0,
    };

    // Load initial page title
    fetch(`/api/pages/${pageId}`, { headers: { Accept: 'application/json' } })
        .then((res) => res.json())
        .then((page) => {
            updateLinkModal.value.pageQuery = page.content || '';
            updateLinkModal.value.selectedPageTitle = page.content || '';
        });
}

function searchPagesForUpdate(query: string) {
    updateLinkModal.value.pageQuery = query;
    updateLinkModal.value.selectedPageId = '';
    updateLinkModal.value.searchSelectedIndex = 0;

    if (query.length === 0) {
        updateLinkModal.value.searchResults = [];

        return;
    }

    fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        headers: { Accept: 'application/json' },
    })
        .then((res) => res.json())
        .then((data) => {
            updateLinkModal.value.searchResults = data
                .filter((n: { parent_id: string | null }) => !n.parent_id)
                .slice(0, 10);
        });
}

function handlePageInputKeydown(e: KeyboardEvent) {
    const results = updateLinkModal.value.searchResults;

    if (e.key === 'ArrowDown' && results.length > 0) {
        e.preventDefault();
        updateLinkModal.value.searchSelectedIndex = Math.min(
            updateLinkModal.value.searchSelectedIndex + 1,
            results.length - 1,
        );
    } else if (e.key === 'ArrowUp' && results.length > 0) {
        e.preventDefault();
        updateLinkModal.value.searchSelectedIndex = Math.max(
            updateLinkModal.value.searchSelectedIndex - 1,
            0,
        );
    } else if (e.key === 'Enter') {
        e.preventDefault();

        if (results.length > 0) {
            selectPageForUpdate(
                results[updateLinkModal.value.searchSelectedIndex],
            );
        } else if (updateLinkModal.value.selectedPageId) {
            saveUpdatedLink();
        }
    }
}

function handleLabelInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
        e.preventDefault();

        if (updateLinkModal.value.selectedPageId) {
            saveUpdatedLink();
        }
    }
}

function selectPageForUpdate(page: { id: string; content: string }) {
    updateLinkModal.value.selectedPageId = page.id;
    updateLinkModal.value.selectedPageTitle = page.content;
    updateLinkModal.value.pageQuery = page.content;
    updateLinkModal.value.searchResults = [];
}

function saveUpdatedLink() {
    const { selectedPageId, label, pos } = updateLinkModal.value;

    if (!selectedPageId) {
        return;
    }

    const editorInstance = editor.value;

    if (!editorInstance) {
        return;
    }

    const node = editorInstance.state.doc.nodeAt(pos);

    if (!node) {
        return;
    }

    editorInstance
        .chain()
        .focus()
        .deleteRange({ from: pos, to: pos + node.nodeSize })
        .insertContent({
            type: 'mention',
            attrs: {
                id: selectedPageId,
                label: label || updateLinkModal.value.selectedPageTitle,
            },
        })
        .run();

    updateLinkModal.value.visible = false;
}

// Web link update modal
const updateWebLinkModal = ref({
    visible: false,
    href: '',
    label: '',
    pos: 0,
});

function updateWebLink() {
    const href = linkPopover.value.href;
    const label = linkPopover.value.label;
    const pos = linkPopover.value.pos;
    hideLinkPopover();
    updateWebLinkModal.value = { visible: true, href, label, pos };
}

const isValidUrl = computed(() => {
    try {
        const url = new URL(updateWebLinkModal.value.href);

        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
});

function saveUpdatedWebLink() {
    if (!isValidUrl.value) {
        return;
    }

    const { href, label, pos } = updateWebLinkModal.value;

    if (!href) {
        return;
    }

    const editorInstance = editor.value;

    if (!editorInstance) {
        return;
    }

    const node = editorInstance.state.doc.nodeAt(pos);

    if (!node) {
        return;
    }

    editorInstance
        .chain()
        .focus()
        .deleteRange({ from: pos, to: pos + node.nodeSize })
        .insertContent({
            type: 'webLink',
            attrs: { href, label: label || null },
        })
        .run();
    updateWebLinkModal.value.visible = false;
}

function handleWebLinkKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveUpdatedWebLink();
    }
}

function isAtomOnlyTextblock(node: PmNode): boolean {
    if (!node.isTextblock || node.childCount === 0) {
        return false;
    }

    for (let index = 0; index < node.childCount; index++) {
        const child = node.child(index);

        if (!child.isInline || !child.isAtom) {
            return false;
        }
    }

    return true;
}

function adjacentTextblock(
    doc: PmNode,
    currentPos: number,
    direction: -1 | 1,
): { node: PmNode; pos: number } | null {
    let adjacent: { node: PmNode; pos: number } | null = null;

    doc.descendants((node, pos) => {
        if (!node.isTextblock) {
            return true;
        }

        if (direction === -1 && pos < currentPos) {
            adjacent = { node, pos };
        } else if (direction === 1 && pos > currentPos && adjacent === null) {
            adjacent = { node, pos };
        }

        return false;
    });

    return adjacent;
}

function caretIsOnBoundaryLine(
    view: EditorView,
    cursorPos: number,
    boundaryPos: number,
): boolean {
    const cursor = view.coordsAtPos(cursorPos);
    const boundary = view.coordsAtPos(boundaryPos);

    return Math.abs(cursor.top - boundary.top) <= 2;
}

function moveAcrossAtomOnlyTextblock(
    view: EditorView,
    event: KeyboardEvent,
): boolean {
    if (
        (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        document.querySelector('.tippy-box') ||
        !(view.state.selection instanceof TextSelection) ||
        !view.state.selection.empty
    ) {
        return false;
    }

    const { $head } = view.state.selection;

    if (!$head.parent.isTextblock) {
        return false;
    }

    const direction = event.key === 'ArrowUp' ? -1 : 1;
    const currentPos = $head.before($head.depth);
    const adjacent = adjacentTextblock(view.state.doc, currentPos, direction);

    if (
        adjacent === null ||
        (!isAtomOnlyTextblock($head.parent) &&
            !isAtomOnlyTextblock(adjacent.node))
    ) {
        return false;
    }

    const boundaryPos =
        direction === -1 ? $head.start($head.depth) : $head.end($head.depth);

    if (
        !isAtomOnlyTextblock($head.parent) &&
        !caretIsOnBoundaryLine(view, $head.pos, boundaryPos)
    ) {
        return false;
    }

    const targetPos =
        adjacent.pos + 1 + (direction === -1 ? adjacent.node.content.size : 0);
    const transaction = view.state.tr
        .setSelection(TextSelection.create(view.state.doc, targetPos))
        .scrollIntoView();

    event.preventDefault();
    view.dispatch(transaction);

    return true;
}

function handleCheckboxMouseDown(view: EditorView, event: MouseEvent): boolean {
    if (event.button !== 0 || !(event.target instanceof Element)) {
        return false;
    }

    const listItem = event.target.closest<HTMLLIElement>(
        '.page-editor-list li[data-checked]',
    );

    if (!listItem || !view.dom.contains(listItem)) {
        return false;
    }

    const itemStyle = getComputedStyle(listItem);
    const checkboxStyle = getComputedStyle(listItem, '::before');
    const itemRect = listItem.getBoundingClientRect();
    const checkboxLeft =
        itemRect.left +
        Number.parseFloat(itemStyle.paddingLeft) +
        Number.parseFloat(checkboxStyle.marginLeft);
    const checkboxTop =
        itemRect.top +
        Number.parseFloat(itemStyle.paddingTop) +
        Number.parseFloat(checkboxStyle.marginTop);
    const checkboxWidth = Number.parseFloat(checkboxStyle.width);
    const checkboxHeight = Number.parseFloat(checkboxStyle.height);
    const hitSlop = 4;

    if (
        event.clientX < checkboxLeft - hitSlop ||
        event.clientX > checkboxLeft + checkboxWidth + hitSlop ||
        event.clientY < checkboxTop - hitSlop ||
        event.clientY > checkboxTop + checkboxHeight + hitSlop
    ) {
        return false;
    }

    const itemPos = view.posAtDOM(listItem, 0) - 1;
    const itemNode = view.state.doc.nodeAt(itemPos);

    if (
        itemNode?.type.name !== 'listItem' ||
        typeof itemNode.attrs.checked !== 'boolean'
    ) {
        return false;
    }

    event.preventDefault();
    userHasInteracted = true;
    view.focus();
    view.dispatch(
        view.state.tr.setNodeMarkup(itemPos, undefined, {
            ...itemNode.attrs,
            checked: !itemNode.attrs.checked,
        }),
    );

    return true;
}

function cycleChecklistState(view: EditorView): boolean {
    const { from, to } = view.state.selection;
    const listItems: { node: PmNode; pos: number }[] = [];

    if (from === to) {
        const $pos = view.state.doc.resolve(from);

        for (let depth = $pos.depth; depth >= 0; depth--) {
            if ($pos.node(depth).type.name === 'listItem') {
                listItems.push({
                    node: $pos.node(depth),
                    pos: $pos.before(depth),
                });
                break;
            }
        }
    } else {
        view.state.doc.descendants((node, pos) => {
            if (node.type.name !== 'listItem') {
                return;
            }

            const firstChild = node.firstChild;

            if (firstChild) {
                const textStart = pos + 1;
                const textEnd = textStart + firstChild.nodeSize;

                if (from < textEnd && to > textStart) {
                    listItems.push({ node, pos });
                }
            }
        });
    }

    if (listItems.length === 0) {
        return false;
    }

    const currentChecked = listItems[0].node.attrs.checked;
    const nextChecked =
        currentChecked === null
            ? false
            : currentChecked === false
              ? true
              : null;
    const transaction = view.state.tr;

    listItems.forEach(({ node, pos }) => {
        transaction.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            checked: nextChecked,
        });
    });
    view.dispatch(transaction);

    return true;
}

const editor = useEditor({
    content: nodesToTiptap(props.nodes),
    extensions: [
        CustomDocument,
        Text,
        Paragraph,
        BulletList.configure({
            HTMLAttributes: {
                class: 'page-editor-list',
            },
        }),
        CustomListItem,
        AlwaysSplitListItem,
        ActiveLineHighlight,
        History,
        Bold,
        Italic,
        Strike,
        Code,
        CodeBlock.configure({
            exitOnTripleEnter: false,
            exitOnArrowDown: false,
        }),
        Heading.configure({ levels: [1, 2, 3] }),
        HorizontalRule,
        Blockquote,
        Highlight,
        Gapcursor,
        // Convert NodeSelection on fileNodes from arrow keys to GapCursor,
        // and always scroll GapCursor into view
        Extension.create({
            name: 'fileNodeGapCursor',
            addProseMirrorPlugins() {
                return [
                    new Plugin({
                        appendTransaction: (_trs, oldState, newState) => {
                            // Scroll into view whenever selection becomes a GapCursor
                            const sel = newState.selection;
                            const isGapCursor =
                                sel.empty && !sel.$head.parent.isTextblock;

                            if (isGapCursor && !oldState.selection.eq(sel)) {
                                if (lastArrowDirection !== 0) {
                                    lastArrowDirection = 0;
                                }

                                return newState.tr.scrollIntoView();
                            }

                            if (lastArrowDirection === 0) {
                                return null;
                            }

                            const dir = lastArrowDirection;
                            lastArrowDirection = 0;

                            if (oldState.selection.eq(sel)) {
                                return null;
                            }

                            // Convert NodeSelection on fileNode to GapCursor
                            if (
                                sel instanceof NodeSelection &&
                                sel.node.type.name === 'fileNode'
                            ) {
                                const pos = dir === -1 ? sel.to : sel.from;
                                const tr = newState.tr.setSelection(
                                    new GapCursor(newState.doc.resolve(pos)),
                                );
                                tr.scrollIntoView();

                                return tr;
                            }

                            // When navigating to a new listItem, create GapCursor
                            // if the boundary content is a fileNode
                            if (sel instanceof TextSelection) {
                                let curDepth = -1;

                                for (let d = sel.$head.depth; d >= 0; d--) {
                                    if (
                                        sel.$head.node(d).type.name ===
                                        'listItem'
                                    ) {
                                        curDepth = d;
                                        break;
                                    }
                                }

                                let oldDepth = -1;

                                for (
                                    let d = oldState.selection.$head.depth;
                                    d >= 0;
                                    d--
                                ) {
                                    if (
                                        oldState.selection.$head.node(d).type
                                            .name === 'listItem'
                                    ) {
                                        oldDepth = d;
                                        break;
                                    }
                                }

                                if (curDepth < 0 || oldDepth < 0) {
                                    return null;
                                }

                                if (
                                    sel.$head.before(curDepth) ===
                                    oldState.selection.$head.before(oldDepth)
                                ) {
                                    return null;
                                }

                                const listItem = sel.$head.node(curDepth);
                                const listItemStart = sel.$head.start(curDepth);

                                if (dir === 1) {
                                    if (
                                        listItem.firstChild?.type.name ===
                                        'fileNode'
                                    ) {
                                        const tr = newState.tr.setSelection(
                                            new GapCursor(
                                                newState.doc.resolve(
                                                    listItemStart,
                                                ),
                                            ),
                                        );
                                        tr.scrollIntoView();

                                        return tr;
                                    }
                                } else {
                                    let lastContentOffset = 0;

                                    for (
                                        let i = 0;
                                        i < listItem.childCount;
                                        i++
                                    ) {
                                        const child = listItem.child(i);

                                        if (child.type.name === 'bulletList') {
                                            break;
                                        }

                                        lastContentOffset += child.nodeSize;

                                        if (
                                            i === listItem.childCount - 1 ||
                                            listItem.child(i + 1).type.name ===
                                                'bulletList'
                                        ) {
                                            if (
                                                child.type.name === 'fileNode'
                                            ) {
                                                const tr =
                                                    newState.tr.setSelection(
                                                        new GapCursor(
                                                            newState.doc.resolve(
                                                                listItemStart +
                                                                    lastContentOffset,
                                                            ),
                                                        ),
                                                    );
                                                tr.scrollIntoView();

                                                return tr;
                                            }
                                        }
                                    }
                                }
                            }

                            return null;
                        },
                    }),
                ];
            },
        }),
        HardBreak.configure({
            keepMarks: false,
        }).extend({
            addKeyboardShortcuts() {
                return {
                    'Shift-Enter': () => this.editor.commands.setHardBreak(),
                };
            },
        }),
        Mention.configure({
            HTMLAttributes: { class: 'wiki-link' },
            suggestion: wikiLinkSuggestion(),
            renderText: ({ node }) =>
                `[[${node.attrs.label ?? node.attrs.id}]]`,
            renderHTML: ({ node }) => [
                'span',
                { class: 'wiki-link', 'data-page-id': node.attrs.id },
                ['span', { class: 'wiki-link-bracket' }, '[['],
                [
                    'span',
                    { class: 'wiki-link-label' },
                    node.attrs.label ?? node.attrs.id,
                ],
                ['span', { class: 'wiki-link-bracket' }, ']]'],
            ],
        }),
        WebLink,
        BlockReference,
        BlockEmbed,
        FileNode,
        SlashCommand,
    ],
    editorProps: {
        attributes: {
            class: 'outline-none',
        },
        handleDOMEvents: {
            mousedown: (view, event) => handleCheckboxMouseDown(view, event),
        },
        handleKeyDown: (view, event) => {
            if (eventMatchesCommand(event, 'toggle-checkbox')) {
                event.preventDefault();

                return cycleChecklistState(view);
            }

            if (moveAcrossAtomOnlyTextblock(view, event)) {
                return true;
            }

            // Enter at GapCursor: split listItem at the gap position
            if (
                event.key === 'Enter' &&
                view.state.selection.empty &&
                !view.state.selection.$head.parent.isTextblock
            ) {
                event.preventDefault();
                const pos = view.state.selection.head;
                const $pos = view.state.doc.resolve(pos);

                // Find the containing listItem
                for (let d = $pos.depth; d >= 0; d--) {
                    if ($pos.node(d).type.name === 'listItem') {
                        const listItem = $pos.node(d);
                        const listItemStart = $pos.start(d);
                        const listItemEnd = $pos.end(d);

                        // Content before and after the gap
                        const beforeContent = listItem.content.cut(
                            0,
                            pos - listItemStart,
                        );
                        const afterContent = listItem.content.cut(
                            pos - listItemStart,
                        );

                        if (afterContent.size === 0) {
                            // Gap is at the end — just insert a new empty node after
                            const newItem =
                                view.state.schema.nodes.listItem.create(null, [
                                    view.state.schema.nodes.paragraph.create(),
                                ]);
                            const insertPos = listItemEnd + 1;
                            const tr = view.state.tr.insert(insertPos, newItem);
                            tr.setSelection(
                                TextSelection.create(tr.doc, insertPos + 2),
                            );
                            tr.scrollIntoView();
                            view.dispatch(tr);
                        } else {
                            // Split: replace current listItem with before, insert new listItem with after
                            const paragraphType =
                                view.state.schema.nodes.paragraph;
                            const firstAfter = afterContent.firstChild;
                            const needsParagraph =
                                firstAfter && !firstAfter.isTextblock;
                            const newContent = needsParagraph
                                ? Fragment.from(paragraphType.create()).append(
                                      afterContent,
                                  )
                                : afterContent;
                            const newItem =
                                view.state.schema.nodes.listItem.create(
                                    { ...listItem.attrs, blockId: null },
                                    newContent,
                                );
                            let tr = view.state.tr;
                            // Replace current listItem content with just the before part
                            tr = tr.replaceWith(
                                listItemStart,
                                listItemEnd,
                                beforeContent,
                            );
                            // Insert new listItem after the current one
                            const insertPos = tr.mapping.map(listItemEnd + 1);
                            tr = tr.insert(insertPos, newItem);
                            // Place cursor in the new listItem's first paragraph
                            tr.setSelection(
                                TextSelection.create(tr.doc, insertPos + 2),
                            );
                            tr.scrollIntoView();
                            view.dispatch(tr);
                        }

                        return true;
                    }
                }
            }

            // Down/Right at GapCursor: select node after gap
            if (
                (event.key === 'ArrowDown' || event.key === 'ArrowRight') &&
                view.state.selection instanceof GapCursor
            ) {
                const $gap = view.state.selection.$head;
                const targetNode = $gap.nodeAfter;

                if (targetNode && !targetNode.isTextblock) {
                    const tr = view.state.tr.setSelection(
                        NodeSelection.create(view.state.doc, $gap.pos),
                    );
                    tr.scrollIntoView();
                    view.dispatch(tr);

                    return true;
                }
            }

            // Up/Left at GapCursor: select node before gap
            if (
                (event.key === 'ArrowUp' || event.key === 'ArrowLeft') &&
                view.state.selection instanceof GapCursor
            ) {
                const $gap = view.state.selection.$head;
                const targetNode = $gap.nodeBefore;

                if (targetNode && !targetNode.isTextblock) {
                    const tr = view.state.tr.setSelection(
                        NodeSelection.create(
                            view.state.doc,
                            $gap.pos - targetNode.nodeSize,
                        ),
                    );
                    tr.scrollIntoView();
                    view.dispatch(tr);

                    return true;
                }
            }

            // Ctrl+Q on selected link (mention or web link) follows it
            if (
                event.key === 'q' &&
                (event.ctrlKey || event.metaKey) &&
                view.state.selection instanceof NodeSelection
            ) {
                const node = view.state.selection.node;

                if (node.type.name === 'mention' && node.attrs.id) {
                    event.preventDefault();
                    router.visit(`/pages/${node.attrs.id}`);

                    return true;
                }

                if (node.type.name === 'webLink' && node.attrs.href) {
                    event.preventDefault();
                    openExternal(node.attrs.href);

                    return true;
                }
            }

            // Enter on selected link shows popover
            if (
                event.key === 'Enter' &&
                view.state.selection instanceof NodeSelection &&
                ['mention', 'webLink'].includes(
                    view.state.selection.node.type.name,
                )
            ) {
                event.preventDefault();
                showLinkPopover(view);

                return true;
            }

            // Enter on selected file node shows media menu
            if (
                event.key === 'Enter' &&
                view.state.selection instanceof NodeSelection &&
                view.state.selection.node.type.name === 'fileNode'
            ) {
                event.preventDefault();
                const dom = view.nodeDOM(
                    view.state.selection.from,
                ) as HTMLElement;
                const btn = dom?.querySelector(
                    '.file-node-menu-btn',
                ) as HTMLElement;

                if (btn) {
                    const mediaId = btn.getAttribute('data-media-menu')!;
                    showMediaMenu(btn, mediaId);
                }

                return true;
            }

            // Escape closes link popover or media menu
            if (event.key === 'Escape' && mediaMenu.value.visible) {
                hideMediaMenu();

                return true;
            }

            if (event.key === 'Escape' && linkPopover.value.visible) {
                hideLinkPopover();

                return true;
            }

            // Select atom inline nodes (mentions, web links) with arrow keys
            const atomTypes = ['mention', 'webLink', 'blockReference'];

            if (event.key === 'ArrowRight') {
                const { $head } = view.state.selection;
                const nodeAfter = $head.nodeAfter;

                if (nodeAfter && atomTypes.includes(nodeAfter.type.name)) {
                    const tr = view.state.tr.setSelection(
                        NodeSelection.create(view.state.doc, $head.pos),
                    );
                    view.dispatch(tr);

                    return true;
                }

                if (
                    view.state.selection instanceof NodeSelection &&
                    atomTypes.includes(view.state.selection.node.type.name)
                ) {
                    const pos = view.state.selection.to;
                    const tr = view.state.tr.setSelection(
                        TextSelection.near(view.state.doc.resolve(pos)),
                    );
                    view.dispatch(tr);

                    return true;
                }
            }

            if (event.key === 'ArrowLeft') {
                if (
                    view.state.selection instanceof NodeSelection &&
                    atomTypes.includes(view.state.selection.node.type.name)
                ) {
                    const pos = view.state.selection.from;
                    const tr = view.state.tr.setSelection(
                        TextSelection.near(view.state.doc.resolve(pos), -1),
                    );
                    view.dispatch(tr);

                    return true;
                }

                const { $head } = view.state.selection;
                const nodeBefore = $head.nodeBefore;

                if (nodeBefore && atomTypes.includes(nodeBefore.type.name)) {
                    const tr = view.state.tr.setSelection(
                        NodeSelection.create(
                            view.state.doc,
                            $head.pos - nodeBefore.nodeSize,
                        ),
                    );
                    view.dispatch(tr);

                    return true;
                }
            }

            if (event.key === 'ArrowDown') {
                const { $head } = view.state.selection;

                // If in a code block at the end of the last list item, create a new item below
                if ($head.parent.type.name === 'codeBlock') {
                    // Check if cursor is at the end of the code block
                    if ($head.parentOffset === $head.parent.content.size) {
                        // Find the list item containing this code block
                        for (let d = $head.depth; d >= 0; d--) {
                            if ($head.node(d).type.name === 'listItem') {
                                const parent = $head.node(d - 1);
                                const indexInParent = $head.index(d - 1);

                                // If this is the last list item, create a new one
                                if (indexInParent === parent.childCount - 1) {
                                    const listItemType =
                                        view.state.schema.nodes.listItem;
                                    const paragraphType =
                                        view.state.schema.nodes.paragraph;
                                    const endPos = $head.end(d) + 1;
                                    const newItem = listItemType.create(null, [
                                        paragraphType.create(),
                                    ]);
                                    const tr = view.state.tr.insert(
                                        endPos,
                                        newItem,
                                    );
                                    tr.setSelection(
                                        TextSelection.near(
                                            tr.doc.resolve(endPos + 1),
                                        ),
                                    );
                                    view.dispatch(tr);

                                    return true;
                                }

                                break;
                            }
                        }
                    }
                }
            }

            // ArrowDown from selected block node (file, etc.) at end of last list item — create new node
            if (
                event.key === 'ArrowDown' &&
                view.state.selection instanceof NodeSelection
            ) {
                const sel = view.state.selection;
                // Check if there's any content after the selected node
                let hasContentAfter = false;
                view.state.doc.nodesBetween(
                    sel.to,
                    view.state.doc.content.size,
                    (node) => {
                        if (node.isTextblock || node.isAtom) {
                            hasContentAfter = true;
                        }
                    },
                );

                if (hasContentAfter) {
                    // Let ProseMirror handle navigation to next block
                    return false;
                }

                const $pos = view.state.doc.resolve(sel.from);

                for (let d = $pos.depth; d >= 0; d--) {
                    if ($pos.node(d).type.name === 'listItem') {
                        const parent = $pos.node(d - 1);
                        const indexInParent = $pos.index(d - 1);

                        if (indexInParent === parent.childCount - 1) {
                            const listItemType =
                                view.state.schema.nodes.listItem;
                            const paragraphType =
                                view.state.schema.nodes.paragraph;
                            const endPos = $pos.end(d) + 1;
                            const newItem = listItemType.create(null, [
                                paragraphType.create(),
                            ]);
                            const tr = view.state.tr.insert(endPos, newItem);
                            tr.setSelection(
                                TextSelection.near(tr.doc.resolve(endPos + 1)),
                            );
                            view.dispatch(tr);

                            return true;
                        }

                        break;
                    }
                }
            }

            // ArrowDown from end of last block focuses backlinks (skip if shift held or suggestion popup open)
            if (
                event.key === 'ArrowDown' &&
                !event.shiftKey &&
                !document.querySelector('.tippy-box')
            ) {
                const { $head } = view.state.selection;

                // Check if at the end of the last block in the doc
                if ($head.parentOffset === $head.parent.content.size) {
                    let isLastBlock = true;
                    // Check there are no more blocks (text or atom) after this position
                    view.state.doc.nodesBetween(
                        $head.pos,
                        view.state.doc.content.size,
                        (node) => {
                            if (
                                node !== $head.parent &&
                                (node.isTextblock || node.isAtom)
                            ) {
                                isLastBlock = false;
                            }
                        },
                    );

                    if (isLastBlock) {
                        emit('focusBacklinks');

                        return true;
                    }
                }
            }

            if (event.key === 'ArrowUp' && !event.shiftKey) {
                const sel = view.state.selection;
                const { $head } = sel;

                // Check if we're in the first top-level list item
                const isFirstListItem = (() => {
                    for (let d = $head.depth; d >= 0; d--) {
                        if ($head.node(d).type.name === 'listItem') {
                            return $head.index(d - 1) === 0 && d === 2;
                        }
                    }

                    return false;
                })();

                if (isFirstListItem) {
                    // Text cursor at position 0
                    if (
                        $head.parentOffset === 0 &&
                        !(sel instanceof NodeSelection)
                    ) {
                        emit('focusTitle');

                        return true;
                    }

                    // NodeSelection on the first block node in the first list item
                    if (sel instanceof NodeSelection) {
                        const $sel = view.state.doc.resolve(sel.from);

                        // Check nothing comes before this node in its parent
                        if ($sel.index($sel.depth) === 0) {
                            emit('focusTitle');

                            return true;
                        }
                    }
                }
            }

            // Track arrow direction for fileNode selection conversion
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                lastArrowDirection = event.key === 'ArrowUp' ? -1 : 1;
            }

            return false;
        },
    },
    onCreate: ({ editor }) => {
        // Focus the start of the first node on page load
        if (props.autoFocus !== false) {
            editor.commands.focus('start');
        }
    },
    onFocus: () => {
        userHasInteracted = true;
    },
    onTransaction: ({ transaction, editor }) => {
        if (!transaction.docChanged) {
            return;
        }

        if (!userHasInteracted) {
            return;
        }

        if (transaction.getMeta('blockIdAssignment')) {
            return;
        }

        // Remote ops applied into the editor must not re-enter the local
        // diff pipeline
        if (transaction.getMeta('remoteSync')) {
            return;
        }

        const json = editor.getJSON();
        const nodes = tiptapToNodes(json, props.pageId);
        emit('update', nodes);
    },
});

function handleEditorClick(e: MouseEvent) {
    const target = e.target as HTMLElement;

    // Click on media menu button
    const menuBtn = target.closest('[data-media-menu]') as HTMLElement;

    if (menuBtn) {
        e.preventDefault();
        e.stopPropagation();
        const mediaId = menuBtn.getAttribute('data-media-menu')!;
        showMediaMenu(menuBtn, mediaId);

        return;
    }

    // Click on file node (non-image, non-video) opens in OS
    const fileNode = target.closest('.file-node-file') as HTMLElement;

    if (fileNode) {
        const mediaId = fileNode.getAttribute('data-media-id');

        if (mediaId) {
            e.preventDefault();
            fetch(`/api/media/${mediaId}/open`, {
                method: 'POST',
                headers: { Accept: 'application/json' },
            });
        }

        return;
    }

    const pageLink = target.closest('[data-page-id]') as HTMLElement;

    if (pageLink) {
        const pageId = pageLink.getAttribute('data-page-id');

        if (pageId) {
            e.preventDefault();
            router.visit(`/pages/${pageId}`);
        }

        return;
    }

    const webLink = target.closest('[data-web-link]') as HTMLElement;

    if (webLink) {
        const href = webLink.getAttribute('href');

        if (href) {
            e.preventDefault();
            openExternal(href);
        }
    }
}

onBeforeUnmount(() => {
    editor.value?.destroy();
});
</script>

<template>
    <div @click="handleEditorClick" class="relative">
        <EditorContent v-if="editor" :editor="editor" />

        <div
            v-if="linkPopover.visible"
            ref="popoverRef"
            tabindex="-1"
            class="absolute z-50 overflow-hidden rounded-md border border-border bg-popover shadow-md outline-none"
            :style="{
                top: `${linkPopover.top}px`,
                left: `${linkPopover.left}px`,
            }"
            @keydown="handlePopoverKeydown"
            @blur="hideLinkPopover"
        >
            <button
                class="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
                :class="
                    linkPopover.selectedIndex === 0
                        ? 'bg-accent'
                        : 'hover:bg-accent'
                "
                @mousedown.prevent="followLink"
                @mouseenter="linkPopover.selectedIndex = 0"
            >
                <ExternalLink class="h-4 w-4" />
                <span class="flex-1">Follow link</span>
                <kbd class="ml-4 text-xs text-muted-foreground">Ctrl+Q</kbd>
            </button>
            <button
                class="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
                :class="
                    linkPopover.selectedIndex === 1
                        ? 'bg-accent'
                        : 'hover:bg-accent'
                "
                @mousedown.prevent="
                    linkPopover.type === 'mention'
                        ? updateLink()
                        : updateWebLink()
                "
                @mouseenter="linkPopover.selectedIndex = 1"
            >
                <Pencil class="h-4 w-4" />
                Update link
            </button>
        </div>

        <div
            v-if="mediaMenu.visible"
            ref="mediaMenuRef"
            tabindex="-1"
            class="absolute z-50 overflow-hidden rounded-md border border-border bg-popover whitespace-nowrap shadow-md outline-none"
            :style="{ top: `${mediaMenu.top}px`, left: `${mediaMenu.left}px` }"
            @keydown="handleMediaMenuKeydown"
            @blur="hideMediaMenu"
        >
            <button
                class="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
                :class="
                    mediaMenu.selectedIndex === 0
                        ? 'bg-accent'
                        : 'hover:bg-accent'
                "
                @mousedown.prevent="mediaDownload"
                @mouseenter="mediaMenu.selectedIndex = 0"
            >
                <Download class="h-4 w-4" />
                Download
            </button>
            <button
                class="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
                :class="
                    mediaMenu.selectedIndex === 1
                        ? 'bg-accent'
                        : 'hover:bg-accent'
                "
                @mousedown.prevent="mediaOpen"
                @mouseenter="mediaMenu.selectedIndex = 1"
            >
                <ExternalLink class="h-4 w-4" />
                Open
            </button>
            <button
                class="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
                :class="
                    mediaMenu.selectedIndex === 2
                        ? 'bg-accent'
                        : 'hover:bg-accent'
                "
                @mousedown.prevent="mediaOpenFolder"
                @mouseenter="mediaMenu.selectedIndex = 2"
            >
                <FolderOpen class="h-4 w-4" />
                Open folder
            </button>
            <button
                class="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive transition-colors"
                :class="
                    mediaMenu.selectedIndex === 3
                        ? 'bg-accent'
                        : 'hover:bg-accent'
                "
                @mousedown.prevent="mediaDelete"
                @mouseenter="mediaMenu.selectedIndex = 3"
            >
                <Trash2 class="h-4 w-4" />
                Delete
            </button>
        </div>
    </div>

    <Dialog v-model:open="updateLinkModal.visible">
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Update link</DialogTitle>
                <DialogDescription
                    >Change the target page or display label.</DialogDescription
                >
            </DialogHeader>
            <div class="flex flex-col gap-4 py-2">
                <div class="flex flex-col gap-2">
                    <Label>Page</Label>
                    <div class="relative">
                        <Input
                            :model-value="updateLinkModal.pageQuery"
                            placeholder="Search for a page..."
                            @update:model-value="
                                (value) => searchPagesForUpdate(String(value))
                            "
                            @keydown="handlePageInputKeydown"
                        />
                        <div
                            v-if="updateLinkModal.searchResults.length > 0"
                            class="absolute top-full z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md"
                        >
                            <button
                                v-for="(
                                    page, index
                                ) in updateLinkModal.searchResults"
                                :key="page.id"
                                class="w-full px-3 py-2 text-left text-sm transition-colors"
                                :class="
                                    index ===
                                    updateLinkModal.searchSelectedIndex
                                        ? 'bg-accent'
                                        : 'hover:bg-accent'
                                "
                                @mousedown.prevent="selectPageForUpdate(page)"
                                @mouseenter="
                                    updateLinkModal.searchSelectedIndex = index
                                "
                            >
                                {{ page.content || '[untitled]' }}
                            </button>
                        </div>
                    </div>
                </div>
                <div class="flex flex-col gap-2">
                    <Label>Display label</Label>
                    <div class="relative">
                        <Input
                            v-model="updateLinkModal.label"
                            placeholder="Link text (optional)"
                            class="pr-9"
                            @keydown="handleLabelInputKeydown"
                        />
                        <button
                            class="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                            title="Reset to page title"
                            @click="
                                updateLinkModal.label =
                                    updateLinkModal.selectedPageTitle
                            "
                            @keydown.enter.prevent="
                                updateLinkModal.label =
                                    updateLinkModal.selectedPageTitle
                            "
                        >
                            <RotateCcw class="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>
            <DialogFooter>
                <Button
                    variant="outline"
                    @click="updateLinkModal.visible = false"
                    >Cancel</Button
                >
                <Button
                    :disabled="!updateLinkModal.selectedPageId"
                    @click="saveUpdatedLink"
                    >Save</Button
                >
            </DialogFooter>
        </DialogContent>
    </Dialog>

    <Dialog v-model:open="updateWebLinkModal.visible">
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Update web link</DialogTitle>
                <DialogDescription
                    >Change the URL or display label.</DialogDescription
                >
            </DialogHeader>
            <div class="flex flex-col gap-4 py-2">
                <div class="flex flex-col gap-2">
                    <Label>URL</Label>
                    <Input
                        v-model="updateWebLinkModal.href"
                        placeholder="https://..."
                        @keydown="handleWebLinkKeydown"
                    />
                </div>
                <div class="flex flex-col gap-2">
                    <Label>Display label</Label>
                    <Input
                        v-model="updateWebLinkModal.label"
                        placeholder="Optional display text"
                        @keydown="handleWebLinkKeydown"
                    />
                </div>
            </div>
            <DialogFooter>
                <Button
                    variant="outline"
                    @click="updateWebLinkModal.visible = false"
                    >Cancel</Button
                >
                <Button :disabled="!isValidUrl" @click="saveUpdatedWebLink"
                    >Save</Button
                >
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>

<style>
.page-editor-list {
    list-style: none;
    padding-left: 1.5em;
}

.page-editor-list .page-editor-list {
    margin-top: 0.25em;
}

.page-editor-list li {
    position: relative;
    margin-bottom: 0.125em;
    border-radius: 3px;
    padding: 1px 4px;
}

.page-editor-list li::marker {
    content: none;
}

.page-editor-list li:not([data-checked])::before {
    content: '';
    position: absolute;
    left: -1em;
    top: 0.65em;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--muted-foreground);
}

.page-editor-list li.active-line > p,
.page-editor-list li.active-line > h1,
.page-editor-list li.active-line > h2,
.page-editor-list li.active-line > h3,
.page-editor-list li.active-line > pre,
.page-editor-list li.active-line > blockquote {
    background: rgba(128, 128, 128, 0.08);
    border-radius: 3px;
}

.page-editor-list li.selected-line > p,
.page-editor-list li.selected-line > h1,
.page-editor-list li.selected-line > h2,
.page-editor-list li.selected-line > h3,
.page-editor-list li.selected-line > pre,
.page-editor-list li.selected-line > blockquote {
    background: rgba(128, 128, 128, 0.15);
    border-radius: 3px;
}

.page-editor-list li p {
    margin: 0;
}

.ProseMirror {
    font-size: 0.875rem;
    line-height: 1.625;
}

.ProseMirror:focus {
    outline: none;
}

.ProseMirror h1 {
    font-size: 1.5em;
    font-weight: 700;
    margin: 0.5em 0 0.25em;
}

.ProseMirror h2 {
    font-size: 1.25em;
    font-weight: 600;
    margin: 0.5em 0 0.25em;
}

.ProseMirror h3 {
    font-size: 1.1em;
    font-weight: 600;
    margin: 0.5em 0 0.25em;
}

.ProseMirror hr {
    border: none;
    border-top: 1px solid rgba(128, 128, 128, 0.3);
    margin: 0.75em 0;
}

.ProseMirror blockquote {
    border-left: 3px solid rgba(128, 128, 128, 0.3);
    padding-left: 0.75em;
    color: rgba(128, 128, 128, 0.8);
}

.ProseMirror code {
    background: rgba(128, 128, 128, 0.15);
    border-radius: 3px;
    padding: 0.15em 0.3em;
    font-size: 0.9em;
    font-family: monospace;
}

.ProseMirror pre {
    background: rgba(128, 128, 128, 0.1);
    border-radius: 6px;
    padding: 0.75em 1em;
    margin: 0.5em 0;
    overflow-x: auto;
}

.ProseMirror pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 0.85em;
}

.wiki-link,
[data-page-id] {
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 2px;
}

.wiki-link-bracket {
    opacity: 0.4;
}

.wiki-link-label {
    color: var(--link);
    text-decoration: underline;
    text-underline-offset: 2px;
    font-weight: 500;
}

.wiki-link.ProseMirror-selectednode,
[data-page-id].ProseMirror-selectednode,
.web-link.ProseMirror-selectednode {
    outline: 2px solid var(--link);
    outline-offset: 1px;
    background: rgba(96, 165, 250, 0.1);
}

/* File node styles */
.file-node {
    margin: 0.5em 0;
    border-radius: 6px;
    overflow: hidden;
    position: relative;
}

.file-node-menu-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 16px;
    letter-spacing: 1px;
    opacity: 0;
    cursor: pointer;
    z-index: 1;
}

.file-node:hover .file-node-menu-btn {
    opacity: 1;
}

.file-node-menu-btn:hover {
    background: rgba(0, 0, 0, 0.8);
}

.file-node-image img {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
}

.file-node-video video {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
}

.file-node-file {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(128, 128, 128, 0.1);
    cursor: pointer;
}

.file-node-file:hover {
    background: rgba(128, 128, 128, 0.15);
}

.file-node-icon {
    font-size: 1.2em;
}

.file-node-name {
    font-weight: 500;
    font-size: 0.875rem;
}

.file-node-size {
    color: rgba(128, 128, 128, 0.7);
    font-size: 0.75rem;
}

.file-node.ProseMirror-selectednode {
    outline: 2px solid var(--link);
    outline-offset: 1px;
}

.web-link {
    color: var(--link);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 2px;
}

/* Checkbox styles for list items */
.page-editor-list li[data-checked]::before {
    content: '';
    float: left;
    width: 14px;
    height: 14px;
    margin-right: 6px;
    margin-top: 3px;
    border: 1.5px solid rgba(128, 128, 128, 0.5);
    border-radius: 3px;
    cursor: pointer;
}

.page-editor-list li[data-checked='true']::before {
    background: var(--link);
    border-color: var(--link);
    content: '✓';
    cursor: pointer !important;
    user-select: none;
    font-size: 11px;
    font-weight: 900;
    line-height: 14px;
    text-align: center;
    color: var(--background);
}

.page-editor-list li[data-checked='true'] > p,
.page-editor-list li[data-checked='true'] > h1,
.page-editor-list li[data-checked='true'] > h2,
.page-editor-list li[data-checked='true'] > h3 {
    opacity: 0.5;
}
</style>
