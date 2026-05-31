<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import Document from '@tiptap/extension-document';
import Text from '@tiptap/extension-text';
import Paragraph from '@tiptap/extension-paragraph';
import BulletList from '@tiptap/extension-bullet-list';
import ListItem from '@tiptap/extension-list-item';
import History from '@tiptap/extension-history';
import type { Node } from '@/types/node';

const props = defineProps<{
    nodes: Node[];
}>();

const emit = defineEmits<{
    update: [nodes: Node[]];
}>();

// Custom document schema: doc must contain a bulletList
const CustomDocument = Document.extend({
    content: 'bulletList',
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
                    : [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
            },
        ],
    };
}

function nodeToListItem(node: Node): Record<string, unknown> {
    const content: Record<string, unknown>[] = [
        {
            type: 'paragraph',
            content: node.content
                ? [{ type: 'text', text: node.content }]
                : undefined,
        },
    ];

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

    // First child is the paragraph with text
    const paragraph = content.find((c) => c.type === 'paragraph');
    const textContent = paragraph
        ? ((paragraph.content as { text: string }[]) ?? []).map((t) => t.text).join('')
        : '';

    // Second child (if any) is a nested bulletList
    const nestedList = content.find((c) => c.type === 'bulletList');
    const children = nestedList ? listToNodes(nestedList, (attrs.blockId as string) ?? '') : [];

    return {
        id: (attrs.blockId as string) || crypto.randomUUID(),
        parent_id: parentId,
        position,
        content: textContent,
        url: null,
        is_checked: null,
        created_at: '',
        updated_at: '',
        children,
    };
}

// Extend ListItem to carry our block ID
const CustomListItem = ListItem.extend({
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
});

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
        History,
    ],
    editorProps: {
        attributes: {
            class: 'outline-none',
        },
    },
    onUpdate: ({ editor }) => {
        const json = editor.getJSON();
        const nodes = tiptapToNodes(json, null);
        emit('update', nodes);
    },
});

// Assign IDs to new list items that don't have one
if (editor.value) {
    editor.value.on('transaction', ({ transaction }) => {
        if (!transaction.docChanged) return;
        const tr = editor.value!.state.tr;
        let needsUpdate = false;
        editor.value!.state.doc.descendants((node, pos) => {
            if (node.type.name === 'listItem' && !node.attrs.blockId) {
                tr.setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    blockId: crypto.randomUUID(),
                });
                needsUpdate = true;
            }
        });
        if (needsUpdate) {
            editor.value!.view.dispatch(tr);
        }
    });
}

onBeforeUnmount(() => {
    editor.value?.destroy();
});
</script>

<template>
    <EditorContent v-if="editor" :editor="editor" />
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
</style>
