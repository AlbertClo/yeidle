<script setup lang="ts">
/** One block and its children, as nested list items. */
import RichContent from './RichContent';

export type BlockTree = {
    id: string;
    text: string;
    /** Rich text (TipTap JSON). */
    content: object | unknown[] | null;
    children: BlockTree[];
};

defineOptions({ name: 'BlockItem' });
defineProps<{ block: BlockTree }>();
</script>

<template>
    <li>
        <RichContent :content="block.content" :fallback="block.text" />
        <ul v-if="block.children.length > 0">
            <BlockItem
                v-for="child in block.children"
                :key="child.id"
                :block="child"
            />
        </ul>
    </li>
</template>
