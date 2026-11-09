<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/vue-3';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import EmbeddedBlockTree from '@/components/EmbeddedBlockTree.vue';
import { LOCAL_NODES_CHANGED_EVENT } from '@/sync/nodeChanges';
import type { LocalNodesChangedEvent } from '@/sync/nodeChanges';
import { LOCAL_OPS_AVAILABLE_EVENT } from '@/sync/realtimeOps';
import type { Node } from '@/types/node';

type EmbedTarget = {
    id: string;
    content: string;
    page_id: string;
    children: Node[];
};

const props = defineProps<NodeViewProps>();
const target = ref<EmbedTarget | null>(null);
const loading = ref(false);
const targetId = computed(() => props.node.attrs.targetId as string | null);
const fallback = computed(
    () =>
        (props.node.attrs.fallback as string) ||
        (props.node.attrs.targetUid as string) ||
        'Missing embedded block',
);

async function loadTarget() {
    if (!targetId.value || loading.value) {
        return;
    }

    loading.value = true;

    try {
        const response = await fetch(`/api/nodes/${targetId.value}/reference`, {
            headers: { Accept: 'application/json' },
        });

        if (response.ok) {
            target.value = await response.json();
        }
    } catch {
        // The imported fallback remains readable while the local API is unavailable.
    } finally {
        loading.value = false;
    }
}

function openTarget() {
    if (target.value) {
        router.visit(
            `/pages/${target.value.page_id}?block=${encodeURIComponent(target.value.id)}`,
        );
    }
}

function handleNodeChanges(event: Event) {
    const ids = (event as LocalNodesChangedEvent).detail.ids;

    if (targetId.value && ids.length > 0) {
        void loadTarget();
    }
}

function handleCommittedOps(event: Event) {
    const ops = (
        event as CustomEvent<{ ops: Record<string, unknown>[] | null }>
    ).detail.ops;

    if (
        ops === null ||
        ops.some((op) => {
            const payload = op.payload as Record<string, unknown> | undefined;

            return (
                payload?.id === targetId.value ||
                (target.value && payload?.page_id === target.value.page_id)
            );
        })
    ) {
        void loadTarget();
    }
}

watch(targetId, () => {
    target.value = null;
    void loadTarget();
});

onMounted(() => {
    void loadTarget();
    window.addEventListener(LOCAL_NODES_CHANGED_EVENT, handleNodeChanges);
    window.addEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleCommittedOps);
});

onBeforeUnmount(() => {
    window.removeEventListener(LOCAL_NODES_CHANGED_EVENT, handleNodeChanges);
    window.removeEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleCommittedOps);
});
</script>

<template>
    <NodeViewWrapper
        class="block-embed"
        data-block-embed
        :data-target-id="targetId"
        contenteditable="false"
    >
        <button
            type="button"
            class="block-embed-source"
            @mousedown.prevent="openTarget"
        >
            {{ target?.content || fallback }}
        </button>
        <EmbeddedBlockTree
            v-if="target?.children?.length"
            :nodes="target.children"
        />
        <span v-else-if="loading" class="block-embed-status"
            >Loading embed…</span
        >
    </NodeViewWrapper>
</template>

<style scoped>
.block-embed {
    margin: 0.35rem 0;
    padding: 0.6rem 0.75rem;
    border-left: 2px solid
        color-mix(in oklab, var(--primary) 55%, var(--border));
    border-radius: 0.25rem;
    background: color-mix(in oklab, var(--muted) 45%, transparent);
}

.block-embed-source {
    cursor: pointer;
    font-weight: 500;
    text-align: left;
}

.block-embed-source:hover {
    color: var(--primary);
    text-decoration: underline;
    text-underline-offset: 2px;
}

.block-embed-status {
    display: block;
    margin-top: 0.25rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
}
</style>
