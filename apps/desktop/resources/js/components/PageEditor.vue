<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { uuidv7 } from 'uuidv7';
import { Extension } from '@tiptap/core';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import Document from '@tiptap/extension-document';
import Text from '@tiptap/extension-text';
import Paragraph from '@tiptap/extension-paragraph';
import BulletList from '@tiptap/extension-bullet-list';
import ListItem from '@tiptap/extension-list-item';
import History from '@tiptap/extension-history';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Strike from '@tiptap/extension-strike';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Heading from '@tiptap/extension-heading';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import Blockquote from '@tiptap/extension-blockquote';
import Mention from '@tiptap/extension-mention';
import { Plugin } from '@tiptap/pm/state';
import { NodeSelection } from '@tiptap/pm/state';
import { ref, nextTick } from 'vue';
import { ExternalLink, Pencil } from 'lucide-vue-next';
import { wikiLinkSuggestion } from '@/extensions/wikilink';
import type { Node } from '@/types/node';

const props = defineProps<{
    nodes: Node[];
}>();

const emit = defineEmits<{
    update: [nodes: Node[]];
    focusTitle: [];
}>();

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
                parseHTML: (element: HTMLElement) => element.getAttribute('data-block-id'),
                renderHTML: (attributes: Record<string, unknown>) => {
                    if (!attributes.blockId) return {};
                    return { 'data-block-id': attributes.blockId };
                },
            },
        };
    },
    addProseMirrorPlugins() {
        return [
            new Plugin({
                appendTransaction: (_transactions, _oldState, newState) => {
                    const seen = new Set<string>();
                    let tr = newState.tr;
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

function isInCodeBlock(editor: { state: { selection: { $head: { parent: { type: { name: string } } } } } }) {
    return editor.state.selection.$head.parent.type.name === 'codeBlock';
}

// Override Enter to always split list items (never lift/exit the list)
const AlwaysSplitListItem = Extension.create({
    name: 'alwaysSplitListItem',
    addKeyboardShortcuts() {
        return {
            Tab: ({ editor }) => {
                if (isInCodeBlock(editor)) return false;
                editor.commands.sinkListItem('listItem');
                return true;
            },
            'Shift-Tab': ({ editor }) => {
                if (isInCodeBlock(editor)) return false;
                editor.commands.liftListItem('listItem');
                return true;
            },
            Backspace: ({ editor }) => {
                if (isInCodeBlock(editor)) return false;
                if (!editor.state.selection.empty) return false;
                const { $head } = editor.state.selection;
                if ($head.parentOffset === 0) {
                    // If in a non-paragraph textblock (heading, etc.), convert to paragraph first
                    if ($head.parent.type.name !== 'paragraph') {
                        const pos = $head.before($head.depth);
                        const tr = editor.state.tr.setNodeMarkup(pos, editor.schema.nodes.paragraph);
                        editor.view.dispatch(tr);
                        return true;
                    }
                    // Find the current list item
                    for (let d = $head.depth; d >= 0; d--) {
                        if ($head.node(d).type.name === 'listItem') {
                            const indexInParent = $head.index(d - 1);
                            if (indexInParent === 0) break;

                            const currentItemStart = $head.start(d) - 1;
                            const currentItemEnd = $head.end(d) + 1;
                            const currentContent = $head.parent.content;

                            // Find the end of the previous visible text block
                            // by resolving the position just before our list item
                            const $before = editor.state.doc.resolve(currentItemStart);
                            // Search backwards for the nearest text block end
                            let targetEnd = currentItemStart;
                            editor.state.doc.nodesBetween(0, currentItemStart, (node, pos) => {
                                if (node.isTextblock) {
                                    targetEnd = pos + node.nodeSize - 1; // end of text inside the block
                                }
                            });

                            if (targetEnd === currentItemStart) break;

                            let tr = editor.state.tr;
                            // Insert current block's content at end of target text block
                            if (currentContent.size > 0) {
                                tr = tr.insert(targetEnd, currentContent);
                            }
                            // Delete the current list item (positions shifted by inserted content)
                            const offset = currentContent.size;
                            tr = tr.delete(currentItemStart + offset, currentItemEnd + offset);
                            // Place cursor at join point
                            tr = tr.setSelection(
                                editor.state.selection.constructor.near(tr.doc.resolve(targetEnd)),
                            );
                            editor.view.dispatch(tr);
                            return true;
                        }
                    }
                }
                return false;
            },
            Delete: ({ editor }) => {
                if (isInCodeBlock(editor)) return false;
                if (!editor.state.selection.empty) return false;
                const { $head } = editor.state.selection;
                if ($head.parentOffset === $head.parent.content.size) {
                    for (let d = $head.depth; d >= 0; d--) {
                        if ($head.node(d).type.name === 'listItem') {
                            const parent = $head.node(d - 1);
                            const indexInParent = $head.index(d - 1);
                            if (indexInParent < parent.childCount - 1) {
                                const endOfItem = $head.end(d) + 1;
                                let tr = editor.state.tr.join(endOfItem);
                                // After joining list items, join the text blocks inside
                                const $joinPos = tr.doc.resolve(endOfItem - 1);
                                if ($joinPos.nodeBefore?.isTextblock && $joinPos.nodeAfter?.isTextblock) {
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
                // Check if current block is empty — splitListItem would lift/outdent it
                const { $head: $enterHead } = editor.state.selection;
                const isEmptyBlock = $enterHead.parent.content.size === 0;

                if (!isEmptyBlock && editor.commands.splitListItem('listItem')) {
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
                        const newItem = listItemType.create(null, [paragraphType.create()]);
                        const tr = editor.state.tr.insert(endPos, newItem);
                        tr.setSelection(
                            editor.state.selection.constructor.near(tr.doc.resolve(endPos + 1)),
                        );
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
                content: nodes.length > 0
                    ? nodes.map(nodeToListItem)
                    : [{ type: 'listItem', attrs: { blockId: uuidv7() }, content: [{ type: 'paragraph' }] }],
            },
        ],
    };
}

function sanitizeTiptapContent(node: Record<string, unknown>): Record<string, unknown> {
    if (node.content && Array.isArray(node.content)) {
        node.content = (node.content as Record<string, unknown>[]).filter((child) => {
            // Remove text nodes with null/undefined text
            if (child.type === 'text' && !child.text) return false;
            return true;
        }).map(sanitizeTiptapContent);
    }
    return node;
}

function nodeToListItem(node: Node): Record<string, unknown> {
    // Use stored TipTap JSON if available, otherwise fall back to plain text paragraph
    const blockContent: Record<string, unknown> = node.tiptap_content
        ? sanitizeTiptapContent({ ...node.tiptap_content })
        : {
            type: 'paragraph',
            content: node.content
                ? [{ type: 'text', text: node.content }]
                : undefined,
        };

    const content: Record<string, unknown>[] = [blockContent];

    if (node.children && node.children.length > 0) {
        content.push({
            type: 'bulletList',
            content: node.children.map(nodeToListItem),
        });
    }

    return {
        type: 'listItem',
        attrs: { blockId: node.id },
        content,
    };
}

// Convert TipTap JSON back to our Node tree
function tiptapToNodes(doc: Record<string, unknown>, parentId: string | null): Node[] {
    const bulletList = (doc.content as Record<string, unknown>[])?.[0];
    if (!bulletList || bulletList.type !== 'bulletList') return [];
    return listToNodes(bulletList, parentId);
}

function listToNodes(bulletList: Record<string, unknown>, parentId: string | null): Node[] {
    const items = (bulletList.content as Record<string, unknown>[]) ?? [];
    return items.map((item, index) => listItemToNode(item, parentId, index));
}

function listItemToNode(item: Record<string, unknown>, parentId: string | null, position: number): Node {
    const attrs = (item.attrs as Record<string, unknown>) ?? {};
    const content = (item.content as Record<string, unknown>[]) ?? [];

    // Extract text from the first text-containing block (paragraph, heading, codeBlock, blockquote)
    const textBlock = content.find((c) => c.type !== 'bulletList');
    let textContent = '';
    if (textBlock) {
        const extractText = (node: Record<string, unknown>): string => {
            if (node.text) return node.text as string;
            // Include mention labels in searchable text
            if (node.type === 'mention') {
                const attrs = node.attrs as Record<string, unknown>;
                return `[[${attrs?.label ?? attrs?.id ?? ''}]]`;
            }
            const children = (node.content as Record<string, unknown>[]) ?? [];
            return children.map(extractText).join('');
        };
        textContent = extractText(textBlock);
    }

    const nestedList = content.find((c) => c.type === 'bulletList');
    const blockId = attrs.blockId as string;
    const children = nestedList ? listToNodes(nestedList, blockId) : [];

    return {
        id: blockId,
        parent_id: parentId,
        position,
        content: textContent,
        tiptap_content: textBlock ? sanitizeTiptapContent(JSON.parse(JSON.stringify(textBlock))) : null,
        url: null,
        is_checked: null,
        created_at: '',
        updated_at: '',
        children,
    };
}

let userHasInteracted = false;

// Mention popover state
const mentionPopover = ref<{
    visible: boolean;
    top: number;
    left: number;
    pageId: string;
    label: string;
    pos: number;
}>({ visible: false, top: 0, left: 0, pageId: '', label: '', pos: 0 });

function showMentionPopover(view: { coordsAtPos: (pos: number) => { top: number; left: number; bottom: number }; state: { selection: { from: number; node: { attrs: Record<string, unknown> } } } }) {
    const sel = view.state.selection;
    const coords = view.coordsAtPos(sel.from);
    const editorEl = document.querySelector('.ProseMirror')?.getBoundingClientRect();
    if (!editorEl) return;
    mentionPopover.value = {
        visible: true,
        top: coords.bottom - editorEl.top + 4,
        left: coords.left - editorEl.left,
        pageId: sel.node.attrs.id as string,
        label: sel.node.attrs.label as string,
        pos: sel.from,
    };
}

function hideMentionPopover() {
    mentionPopover.value.visible = false;
}

function followLink() {
    hideMentionPopover();
    window.location.href = `/pages/${mentionPopover.value.pageId}`;
}

function updateLink() {
    hideMentionPopover();
    // Delete the current mention and trigger the [[ suggestion at that position
    const pos = mentionPopover.value.pos;
    const editorInstance = editor.value;
    if (!editorInstance) return;
    const node = editorInstance.state.doc.nodeAt(pos);
    if (!node) return;
    editorInstance
        .chain()
        .focus()
        .deleteRange({ from: pos, to: pos + node.nodeSize })
        .insertContent('[[')
        .run();
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
        Mention.configure({
            HTMLAttributes: { class: 'wiki-link' },
            suggestion: wikiLinkSuggestion(),
            renderText: ({ node }) => `[[${node.attrs.label ?? node.attrs.id}]]`,
            renderHTML: ({ node, HTMLAttributes }) => [
                'span',
                { ...HTMLAttributes, 'data-page-id': node.attrs.id },
                `[[${node.attrs.label ?? node.attrs.id}]]`,
            ],
        }),
    ],
    editorProps: {
        attributes: {
            class: 'outline-none',
        },
        handleKeyDown: (view, event) => {
            // Enter on selected mention shows popover
            if (event.key === 'Enter' && view.state.selection instanceof NodeSelection && view.state.selection.node.type.name === 'mention') {
                event.preventDefault();
                showMentionPopover(view);
                return true;
            }
            // Escape closes mention popover
            if (event.key === 'Escape' && mentionPopover.value.visible) {
                hideMentionPopover();
                return true;
            }
            // Select mention nodes with arrow keys
            if (event.key === 'ArrowRight') {
                const { $head } = view.state.selection;
                const nodeAfter = $head.nodeAfter;
                if (nodeAfter?.type.name === 'mention') {
                    const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, $head.pos));
                    view.dispatch(tr);
                    return true;
                }
                // If a mention is already selected, move cursor past it
                if (view.state.selection instanceof NodeSelection && view.state.selection.node.type.name === 'mention') {
                    const pos = view.state.selection.to;
                    const tr = view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos)));
                    view.dispatch(tr);
                    return true;
                }
            }
            if (event.key === 'ArrowLeft') {
                // If a mention is already selected, move cursor before it
                if (view.state.selection instanceof NodeSelection && view.state.selection.node.type.name === 'mention') {
                    const pos = view.state.selection.from;
                    const tr = view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos), -1));
                    view.dispatch(tr);
                    return true;
                }
                const { $head } = view.state.selection;
                const nodeBefore = $head.nodeBefore;
                if (nodeBefore?.type.name === 'mention') {
                    const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, $head.pos - nodeBefore.nodeSize));
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
                                    const listItemType = view.state.schema.nodes.listItem;
                                    const paragraphType = view.state.schema.nodes.paragraph;
                                    const endPos = $head.end(d) + 1;
                                    const newItem = listItemType.create(null, [paragraphType.create()]);
                                    const tr = view.state.tr.insert(endPos, newItem);
                                    tr.setSelection(
                                        view.state.selection.constructor.near(tr.doc.resolve(endPos + 1)),
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
            if (event.key === 'ArrowUp') {
                const { $head } = view.state.selection;
                // Only jump to title from char 0 of the first top-level list item
                if ($head.parentOffset === 0) {
                    for (let d = $head.depth; d >= 0; d--) {
                        if ($head.node(d).type.name === 'listItem') {
                            if ($head.index(d - 1) === 0 && d === 2) {
                                emit('focusTitle');
                                return true;
                            }
                            break;
                        }
                    }
                }
            }
            return false;
        },
    },
    onFocus: () => {
        userHasInteracted = true;
    },
    onTransaction: ({ transaction, editor }) => {
        if (!transaction.docChanged) return;
        if (!userHasInteracted) return;
        if (transaction.getMeta('blockIdAssignment')) return;
        const json = editor.getJSON();
        const nodes = tiptapToNodes(json, null);
        emit('update', nodes);
    },
});

function handleEditorClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const link = target.closest('[data-page-id]') as HTMLElement;
    if (link) {
        const pageId = link.getAttribute('data-page-id');
        if (pageId) {
            e.preventDefault();
            window.location.href = `/pages/${pageId}`;
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
            v-if="mentionPopover.visible"
            class="bg-popover border-border absolute z-50 overflow-hidden rounded-md border shadow-md"
            :style="{ top: `${mentionPopover.top}px`, left: `${mentionPopover.left}px` }"
        >
            <button
                class="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
                @mousedown.prevent="followLink"
            >
                <ExternalLink class="h-4 w-4" />
                Follow link
            </button>
            <button
                class="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
                @mousedown.prevent="updateLink"
            >
                <Pencil class="h-4 w-4" />
                Update link
            </button>
        </div>
    </div>
</template>

<style>
.page-editor-list {
    list-style: disc;
    padding-left: 1.5em;
}

.page-editor-list .page-editor-list {
    margin-top: 0.25em;
}

.page-editor-list li {
    margin-bottom: 0.125em;
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
    color: var(--primary);
    cursor: pointer;
    font-weight: 500;
    border-radius: 3px;
    padding: 1px 2px;
}

.wiki-link.ProseMirror-selectednode,
[data-page-id].ProseMirror-selectednode {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
    background: rgba(128, 128, 128, 0.1);
}

.wiki-link:hover {
    text-decoration-color: var(--primary);
}
</style>
