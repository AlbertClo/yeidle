import { mergeAttributes, Node } from '@tiptap/core';
import { VueNodeViewRenderer } from '@tiptap/vue-3';
import BlockReferenceView from '@/components/BlockReferenceView.vue';

export const BlockReference = Node.create({
    name: 'blockReference',
    group: 'inline',
    inline: true,
    atom: true,

    addAttributes() {
        return {
            targetId: { default: null },
            targetUid: { default: null },
            fallback: { default: '' },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-block-reference]' }];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            'span',
            mergeAttributes(HTMLAttributes, {
                'data-block-reference': '',
                'data-target-id': node.attrs.targetId,
                class: 'block-reference',
            }),
            `((${node.attrs.fallback || node.attrs.targetUid || 'missing block'}))`,
        ];
    },

    renderText({ node }) {
        return `((${node.attrs.fallback || node.attrs.targetUid || 'missing block'}))`;
    },

    addNodeView() {
        return VueNodeViewRenderer(BlockReferenceView);
    },
});
