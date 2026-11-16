<script setup lang="ts">
/** One block and its children, as nested list items. */

export type BlockTree = { id: string; text: string; children: BlockTree[] };

defineOptions({ name: 'BlockItem' });
defineProps<{ block: BlockTree }>();
</script>

<template>
    <li>
        <span>{{ block.text }}</span>
        <ul v-if="block.children.length > 0">
            <BlockItem
                v-for="child in block.children"
                :key="child.id"
                :block="child"
            />
        </ul>
    </li>
</template>
