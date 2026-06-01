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
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { NodeSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ref, nextTick } from 'vue';
import { router } from '@inertiajs/vue3';
import { ExternalLink, Pencil, RotateCcw } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { wikiLinkSuggestion } from '@/extensions/wikilink';
import { WebLink } from '@/extensions/weblink';

function openExternal(url: string) {
    fetch('/api/open-external', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url }),
    });
}
import type { Node } from '@/types/node';

const props = defineProps<{
    nodes: Node[];
}>();

const emit = defineEmits<{
    update: [nodes: Node[]];
    focusTitle: [];
    focusBacklinks: [];
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
            checked: {
                default: null,
                parseHTML: (element: HTMLElement) => {
                    const val = element.getAttribute('data-checked');
                    if (val === 'true') return true;
                    if (val === 'false') return false;
                    return null;
                },
                renderHTML: (attributes: Record<string, unknown>) => {
                    if (attributes.checked === null) return {};
                    return {
                        'data-checked': String(attributes.checked),
                        class: attributes.checked ? 'is-checked' : 'is-unchecked',
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
                                        Decoration.node(pos, pos + $pos.node(d).nodeSize, { class: 'active-line' }),
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
                                        const textEnd = textStart + firstChild.nodeSize;
                                        if (from < textEnd && to > textStart) {
                                            decorations.push(
                                                Decoration.node(pos, pos + node.nodeSize, { class: 'selected-line' }),
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
            'Mod-Enter': ({ editor }) => {
                const { from, to } = editor.state.selection;
                const listItems: { node: any; pos: number }[] = [];

                if (from === to) {
                    // Single cursor — find deepest listItem only
                    const $pos = editor.state.doc.resolve(from);
                    for (let d = $pos.depth; d >= 0; d--) {
                        if ($pos.node(d).type.name === 'listItem') {
                            listItems.push({ node: $pos.node(d), pos: $pos.before(d) });
                            break;
                        }
                    }
                } else {
                    // Selection — only items whose direct text content overlaps
                    editor.state.doc.descendants((node, pos) => {
                        if (node.type.name === 'listItem') {
                            const firstChild = node.firstChild;
                            if (firstChild) {
                                const textStart = pos + 1;
                                const textEnd = textStart + firstChild.nodeSize;
                                if (from < textEnd && to > textStart) {
                                    listItems.push({ node, pos });
                                }
                            }
                        }
                    });
                }

                if (listItems.length === 0) return false;

                // Determine next state based on the first item
                const currentChecked = listItems[0].node.attrs.checked;
                let nextChecked: boolean | null;
                if (currentChecked === null) nextChecked = false;
                else if (currentChecked === false) nextChecked = true;
                else nextChecked = null;

                // Apply to all items in selection
                const tr = editor.state.tr;
                listItems.forEach(({ node, pos }) => {
                    tr.setNodeMarkup(pos, undefined, {
                        ...node.attrs,
                        checked: nextChecked,
                    });
                });
                editor.view.dispatch(tr);
                return true;
            },
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
        attrs: { blockId: node.id, checked: node.is_checked ?? null },
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
        is_checked: attrs.checked ?? null,
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
    selectedIndex: number;
}>({ visible: false, top: 0, left: 0, pageId: '', label: '', pos: 0, selectedIndex: 0 });
const popoverRef = ref<HTMLElement>();

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
        selectedIndex: 0,
    };
    nextTick(() => {
        popoverRef.value?.focus();
    });
}

function hideMentionPopover() {
    mentionPopover.value.visible = false;
}

function followLink() {
    hideMentionPopover();
    router.visit(`/pages/${mentionPopover.value.pageId}`);
}

const popoverActions = [followLink, updateLink];

function handlePopoverKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionPopover.value.selectedIndex = Math.min(mentionPopover.value.selectedIndex + 1, popoverActions.length - 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionPopover.value.selectedIndex = Math.max(mentionPopover.value.selectedIndex - 1, 0);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        popoverActions[mentionPopover.value.selectedIndex]();
    } else if (e.key === 'q' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        followLink();
    } else if (e.key === 'Escape') {
        hideMentionPopover();
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
    const pageId = mentionPopover.value.pageId;
    const label = mentionPopover.value.label;
    const pos = mentionPopover.value.pos;
    hideMentionPopover();

    updateLinkModal.value = {
        visible: true,
        pageQuery: '',
        label: label,
        selectedPageId: pageId,
        selectedPageTitle: label,
        pos: pos,
        searchResults: [],
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
        updateLinkModal.value.searchSelectedIndex = Math.min(updateLinkModal.value.searchSelectedIndex + 1, results.length - 1);
    } else if (e.key === 'ArrowUp' && results.length > 0) {
        e.preventDefault();
        updateLinkModal.value.searchSelectedIndex = Math.max(updateLinkModal.value.searchSelectedIndex - 1, 0);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results.length > 0) {
            selectPageForUpdate(results[updateLinkModal.value.searchSelectedIndex]);
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
    if (!selectedPageId) return;

    const editorInstance = editor.value;
    if (!editorInstance) return;

    const node = editorInstance.state.doc.nodeAt(pos);
    if (!node) return;

    editorInstance
        .chain()
        .focus()
        .deleteRange({ from: pos, to: pos + node.nodeSize })
        .insertContent({
            type: 'mention',
            attrs: { id: selectedPageId, label: label || updateLinkModal.value.selectedPageTitle },
        })
        .run();

    updateLinkModal.value.visible = false;
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
        Mention.configure({
            HTMLAttributes: { class: 'wiki-link' },
            suggestion: wikiLinkSuggestion(),
            renderText: ({ node }) => `[[${node.attrs.label ?? node.attrs.id}]]`,
            renderHTML: ({ node, HTMLAttributes }) => [
                'span',
                { ...HTMLAttributes, 'data-page-id': node.attrs.id },
                ['span', { class: 'wiki-link-bracket' }, '[['],
                ['span', { class: 'wiki-link-label' }, node.attrs.label ?? node.attrs.id],
                ['span', { class: 'wiki-link-bracket' }, ']]'],
            ],
        }),
        WebLink,
    ],
    editorProps: {
        attributes: {
            class: 'outline-none',
        },
        handleKeyDown: (view, event) => {
            // Ctrl+Q on selected link (mention or web link) follows it
            if (event.key === 'q' && (event.ctrlKey || event.metaKey) && view.state.selection instanceof NodeSelection) {
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
            // Enter on selected mention shows popover
            if (event.key === 'Enter' && view.state.selection instanceof NodeSelection && view.state.selection.node.type.name === 'mention') {
                event.preventDefault();
                showMentionPopover(view);
                return true;
            }
            // Enter on selected web link opens it
            if (event.key === 'Enter' && view.state.selection instanceof NodeSelection && view.state.selection.node.type.name === 'webLink') {
                event.preventDefault();
                openExternal(view.state.selection.node.attrs.href);
                return true;
            }
            // Escape closes mention popover
            if (event.key === 'Escape' && mentionPopover.value.visible) {
                hideMentionPopover();
                return true;
            }
            // Select atom inline nodes (mentions, web links) with arrow keys
            const atomTypes = ['mention', 'webLink'];
            if (event.key === 'ArrowRight') {
                const { $head } = view.state.selection;
                const nodeAfter = $head.nodeAfter;
                if (nodeAfter && atomTypes.includes(nodeAfter.type.name)) {
                    const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, $head.pos));
                    view.dispatch(tr);
                    return true;
                }
                if (view.state.selection instanceof NodeSelection && atomTypes.includes(view.state.selection.node.type.name)) {
                    const pos = view.state.selection.to;
                    const tr = view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos)));
                    view.dispatch(tr);
                    return true;
                }
            }
            if (event.key === 'ArrowLeft') {
                if (view.state.selection instanceof NodeSelection && atomTypes.includes(view.state.selection.node.type.name)) {
                    const pos = view.state.selection.from;
                    const tr = view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos), -1));
                    view.dispatch(tr);
                    return true;
                }
                const { $head } = view.state.selection;
                const nodeBefore = $head.nodeBefore;
                if (nodeBefore && atomTypes.includes(nodeBefore.type.name)) {
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
            // ArrowDown from end of last block focuses backlinks (skip if shift held or suggestion popup open)
            if (event.key === 'ArrowDown' && !event.shiftKey && !document.querySelector('.tippy-box')) {
                const { $head } = view.state.selection;
                // Check if at the end of the last textblock in the doc
                if ($head.parentOffset === $head.parent.content.size) {
                    let isLastBlock = true;
                    // Check there are no more textblocks after this position
                    view.state.doc.nodesBetween($head.pos, view.state.doc.content.size, (node) => {
                        if (node.isTextblock && node !== $head.parent) {
                            isLastBlock = false;
                        }
                    });
                    if (isLastBlock) {
                        emit('focusBacklinks');
                        return true;
                    }
                }
            }
            if (event.key === 'ArrowUp' && !event.shiftKey) {
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
    onCreate: ({ editor }) => {
        // Focus the start of the first node on page load
        editor.commands.focus('start');
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
            v-if="mentionPopover.visible"
            ref="popoverRef"
            tabindex="-1"
            class="bg-popover border-border absolute z-50 overflow-hidden rounded-md border shadow-md outline-none"
            :style="{ top: `${mentionPopover.top}px`, left: `${mentionPopover.left}px` }"
            @keydown="handlePopoverKeydown"
            @blur="hideMentionPopover"
        >
            <button
                class="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
                :class="mentionPopover.selectedIndex === 0 ? 'bg-accent' : 'hover:bg-accent'"
                @mousedown.prevent="followLink"
                @mouseenter="mentionPopover.selectedIndex = 0"
            >
                <ExternalLink class="h-4 w-4" />
                <span class="flex-1">Follow link</span>
                <kbd class="text-muted-foreground ml-4 text-xs">Ctrl+Q</kbd>
            </button>
            <button
                class="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
                :class="mentionPopover.selectedIndex === 1 ? 'bg-accent' : 'hover:bg-accent'"
                @mousedown.prevent="updateLink"
                @mouseenter="mentionPopover.selectedIndex = 1"
            >
                <Pencil class="h-4 w-4" />
                Update link
            </button>
        </div>
    </div>

    <Dialog v-model:open="updateLinkModal.visible">
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Update link</DialogTitle>
                <DialogDescription>Change the target page or display label.</DialogDescription>
            </DialogHeader>
            <div class="flex flex-col gap-4 py-2">
                <div class="flex flex-col gap-2">
                    <Label>Page</Label>
                    <div class="relative">
                        <Input
                            :model-value="updateLinkModal.pageQuery"
                            placeholder="Search for a page..."
                            @update:model-value="searchPagesForUpdate"
                            @keydown="handlePageInputKeydown"
                        />
                        <div
                            v-if="updateLinkModal.searchResults.length > 0"
                            class="bg-popover border-border absolute top-full z-50 mt-1 w-full overflow-hidden rounded-md border shadow-md"
                        >
                            <button
                                v-for="(page, index) in updateLinkModal.searchResults"
                                :key="page.id"
                                class="w-full px-3 py-2 text-left text-sm transition-colors"
                                :class="index === updateLinkModal.searchSelectedIndex ? 'bg-accent' : 'hover:bg-accent'"
                                @mousedown.prevent="selectPageForUpdate(page)"
                                @mouseenter="updateLinkModal.searchSelectedIndex = index"
                            >
                                {{ page.content || '[untitled]' }}
                            </button>
                        </div>
                    </div>
                </div>
                <div class="flex flex-col gap-2">
                    <Label>Display label</Label>
                    <div class="relative">
                        <Input v-model="updateLinkModal.label" placeholder="Link text (optional)" class="pr-9" @keydown="handleLabelInputKeydown" />
                        <button
                            class="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors"
                            title="Reset to page title"
                            @click="updateLinkModal.label = updateLinkModal.selectedPageTitle"
                            @keydown.enter.prevent="updateLinkModal.label = updateLinkModal.selectedPageTitle"
                        >
                            <RotateCcw class="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>
            <DialogFooter>
                <Button variant="outline" @click="updateLinkModal.visible = false">Cancel</Button>
                <Button :disabled="!updateLinkModal.selectedPageId" @click="saveUpdatedLink">Save</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
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
    border-radius: 3px;
    padding: 1px 4px;
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
}

.page-editor-list li[data-checked="true"]::before {
    background: var(--link);
    border-color: var(--link);
    content: '✓';
    font-size: 11px;
    font-weight: 900;
    line-height: 14px;
    text-align: center;
    color: var(--background);
}

.page-editor-list li[data-checked="true"] > p,
.page-editor-list li[data-checked="true"] > h1,
.page-editor-list li[data-checked="true"] > h2,
.page-editor-list li[data-checked="true"] > h3 {
    opacity: 0.5;
}
</style>
