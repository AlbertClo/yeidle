<script setup lang="ts">
import type { Node } from '@/types/node';

defineOptions({ name: 'EmbeddedBlockTree' });

defineProps<{
    nodes: Node[];
}>();
</script>

<template>
    <ul v-if="nodes.length > 0" class="embedded-block-tree">
        <li v-for="node in nodes" :key="node.id">
            <span>{{ node.content }}</span>
            <EmbeddedBlockTree
                v-if="node.children?.length"
                :nodes="node.children"
            />
        </li>
    </ul>
</template>

<style scoped>
.embedded-block-tree {
    margin: 0.25rem 0 0 1.25rem;
    list-style: disc;
}

.embedded-block-tree .embedded-block-tree {
    padding-left: 0.75rem;
    border-left: 1px solid color-mix(in oklab, var(--border) 65%, transparent);
}
</style>
