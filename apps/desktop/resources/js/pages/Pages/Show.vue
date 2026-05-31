<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import { ref, onMounted, onBeforeUnmount } from 'vue';
import PageEditor from '@/components/PageEditor.vue';
import AppLayout from '@/layouts/AppLayout.vue';
import type { BreadcrumbItem } from '@/types';
import type { Node, NodeLink } from '@/types/node';

const props = defineProps<{
    page: Node;
    backlinks: NodeLink[];
}>();

const breadcrumbs: BreadcrumbItem[] = [
    { title: 'Pages', href: '/pages' },
    { title: props.page.content || '[untitled]', href: `/pages/${props.page.id}` },
];

const isEditingTitle = ref(false);
const titleContent = ref(props.page.content);
const titleRef = ref<HTMLInputElement>();

// Debounce timer for syncing
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let lastNodes: Node[] = props.page.children ?? [];
let hasPendingSync = false;

function startEditingTitle(cursorPos?: number) {
    isEditingTitle.value = true;
    setTimeout(() => {
        if (titleRef.value) {
            titleRef.value.focus();
            if (cursorPos !== undefined) {
                titleRef.value.setSelectionRange(cursorPos, cursorPos);
            }
        }
    }, 0);
}

function finishEditingTitle() {
    isEditingTitle.value = false;
    if (titleContent.value !== props.page.content) {
        syncUpdate(props.page.id, { content: titleContent.value });
    }
}

function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        finishEditingTitle();
        // Focus the editor
        const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
        editorEl?.focus();
    }
}

// --- Sync layer ---

function syncUpdate(id: string, data: Record<string, unknown>) {
    fetch(`/api/nodes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
    });
}

let titleSyncTimer: ReturnType<typeof setTimeout> | null = null;

function syncTitleDebounced() {
    if (titleSyncTimer) clearTimeout(titleSyncTimer);
    titleSyncTimer = setTimeout(() => {
        syncUpdate(props.page.id, { content: titleContent.value });
        titleSyncTimer = null;
    }, 300);
}

function doSync(nodes: Node[]) {
    hasPendingSync = false;
    fetch(`/api/nodes/${props.page.id}/sync`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            content: titleContent.value,
            children: nodes,
        }),
    });
}

function syncFullTree(nodes: Node[]) {
    lastNodes = nodes;
    hasPendingSync = true;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        doSync(nodes);
    }, 300);
}

function flushSync() {
    if (titleSyncTimer) {
        clearTimeout(titleSyncTimer);
        titleSyncTimer = null;
        syncUpdate(props.page.id, { content: titleContent.value });
    }
    if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
    }
    if (hasPendingSync) {
        doSync(lastNodes);
    }
}

function handleNodesUpdate(nodes: Node[]) {
    syncFullTree(nodes);
}

function handleBeforeUnload() {
    flushSync();
}

onMounted(() => {
    window.addEventListener('beforeunload', handleBeforeUnload);
    startEditingTitle();
});

onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    flushSync();
});
</script>

<template>
    <Head :title="page.content || '[untitled]'" />

    <AppLayout :breadcrumbs="breadcrumbs">
        <div class="mx-auto w-full max-w-2xl p-6">
            <div class="mb-6">
                <input
                    v-if="isEditingTitle"
                    ref="titleRef"
                    v-model="titleContent"
                    class="bg-transparent w-full border-none text-3xl font-bold outline-none"
                    @blur="finishEditingTitle"
                    @input="syncTitleDebounced"
                    @keydown="handleTitleKeydown"
                />
                <h1
                    v-else
                    class="cursor-text text-3xl font-bold"
                    @click="startEditingTitle"
                >
                    {{ titleContent || '[untitled]' }}
                </h1>

                <p
                    v-if="page.url"
                    class="text-muted-foreground mt-1 text-sm"
                >
                    <a
                        :href="page.url"
                        target="_blank"
                        class="hover:underline"
                    >{{ page.url }}</a>
                </p>
            </div>

            <div class="mb-4">
                <PageEditor
                    :nodes="page.children ?? []"
                    @update="handleNodesUpdate"
                />
            </div>

            <div
                v-if="backlinks.length > 0"
                class="border-border mt-8 border-t pt-6"
            >
                <h2 class="text-muted-foreground mb-3 text-xs font-semibold uppercase tracking-wider">
                    Backlinks
                </h2>
                <div class="flex flex-col gap-2">
                    <Link
                        v-for="link in backlinks"
                        :key="link.id"
                        :href="`/pages/${link.source_node?.parent_id ?? link.source_node_id}`"
                        class="hover:bg-accent rounded-lg px-3 py-2 text-sm transition-colors"
                    >
                        <span class="text-primary font-medium">
                            {{ link.display_name || link.source_node?.content }}
                        </span>
                    </Link>
                </div>
            </div>
        </div>
    </AppLayout>
</template>
