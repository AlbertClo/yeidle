<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/vue-3';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { LOCAL_NODES_CHANGED_EVENT } from '@/sync/nodeChanges';
import type { LocalNodesChangedEvent } from '@/sync/nodeChanges';
import {
    anyChanged,
    changedDocuments,
    DOCUMENTS_CHANGED_EVENT,
} from '@/sync/documentChanges';

type ReferenceTarget = {
    id: string;
    content: string;
    page_id: string;
};

const props = defineProps<NodeViewProps>();
const target = ref<ReferenceTarget | null>(null);
const loading = ref(false);

const targetId = computed(() => props.node.attrs.targetId as string | null);
const label = computed(
    () =>
        target.value?.content ||
        (props.node.attrs.fallback as string) ||
        (props.node.attrs.targetUid as string) ||
        'Missing block',
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

    if (targetId.value && ids.includes(targetId.value)) {
        void loadTarget();
    }
}

// The target block lives in its page's document (or is the page itself)
function handleDocumentsChanged(event: Event) {
    if (
        anyChanged(
            changedDocuments(event),
            targetId.value,
            target.value?.page_id,
        )
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
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, handleDocumentsChanged);
});

onBeforeUnmount(() => {
    window.removeEventListener(LOCAL_NODES_CHANGED_EVENT, handleNodeChanges);
    window.removeEventListener(DOCUMENTS_CHANGED_EVENT, handleDocumentsChanged);
});
</script>

<template>
    <NodeViewWrapper
        as="span"
        class="block-reference"
        data-block-reference
        :data-target-id="targetId"
        contenteditable="false"
    >
        <button
            type="button"
            :title="`Open referenced block: ${label}`"
            @mousedown.prevent="openTarget"
        >
            <span class="block-reference-bracket">((</span>{{ label
            }}<span class="block-reference-bracket">))</span>
        </button>
    </NodeViewWrapper>
</template>

<style scoped>
.block-reference button {
    cursor: pointer;
    color: color-mix(in oklab, var(--primary) 82%, white);
    text-decoration: underline;
    text-decoration-color: color-mix(in oklab, currentColor 35%, transparent);
    text-underline-offset: 2px;
}

.block-reference button:hover {
    text-decoration-color: currentColor;
}

.block-reference-bracket {
    opacity: 0.45;
}
</style>
