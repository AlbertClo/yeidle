import { mergeAttributes, Node } from '@tiptap/core';
import { VueNodeViewRenderer } from '@tiptap/vue-3';
import BlockEmbedView from '@/components/BlockEmbedView.vue';

export const BlockEmbed = Node.create({
    name: 'blockEmbed',
    group: 'block',
    atom: true,

    addAttributes() {
        return {
            targetId: { default: null },
            targetUid: { default: null },
            fallback: { default: '' },
        };
    },

    parseHTML() {
        return [{ tag: 'div[data-block-embed]' }];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            'div',
            mergeAttributes(HTMLAttributes, {
                'data-block-embed': '',
                'data-target-id': node.attrs.targetId,
                class: 'block-embed',
            }),
            node.attrs.fallback ||
                node.attrs.targetUid ||
                'Missing embedded block',
        ];
    },

    renderText({ node }) {
        return `{{embed: ((${node.attrs.fallback || node.attrs.targetUid || 'missing block'}))}}`;
    },

    addNodeView() {
        return VueNodeViewRenderer(BlockEmbedView);
    },
});
