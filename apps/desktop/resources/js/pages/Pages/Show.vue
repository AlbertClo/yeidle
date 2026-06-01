<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { toast } from 'vue-sonner';
import { EllipsisVertical, Trash2 } from 'lucide-vue-next';
import PageEditor from '@/components/PageEditor.vue';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import AppLayout from '@/layouts/AppLayout.vue';
import type { BreadcrumbItem } from '@/types';
import type { Node, NodeLink } from '@/types/node';
import { getCachedPage, setCachedPage } from '@/stores/pageCache';

const props = defineProps<{
    page: Node;
    backlinks: { id: string; page_id: string; page_title: string }[];
}>();

const isEditingTitle = ref(false);
const cached = getCachedPage(props.page.id);
const titleContent = ref(cached?.title ?? props.page.content);
const pageNodes = ref<Node[]>(cached?.children ?? props.page.children ?? []);
const editorKey = ref(0);

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
    { title: 'Pages', href: '/pages' },
    { title: titleContent.value || '[untitled]', href: `/pages/${props.page.id}` },
]);
const titleRef = ref<HTMLInputElement>();

// Debounce timer for syncing
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let lastNodes: Node[] = [];
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
const titleError = ref(false);

function syncTitleDebounced() {
    if (titleSyncTimer) clearTimeout(titleSyncTimer);
    titleSyncTimer = setTimeout(() => {
        fetch(`/api/nodes/${props.page.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ content: titleContent.value }),
        }).then((res) => {
            if (res.status === 409) {
                titleError.value = true;
                res.json().then((data) => {
                    toast.error(data.message);
                });
            } else {
                titleError.value = false;
                setCachedPage(props.page.id, titleContent.value, lastNodes);
            }
        });
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
    setCachedPage(props.page.id, titleContent.value, nodes);
    syncFullTree(nodes);
}

function focusFirstBacklink() {
    nextTick(() => {
        const firstLink = document.querySelector('.backlink-item') as HTMLElement;
        firstLink?.focus();
    });
}

function focusNextBacklink(e: Event) {
    const current = e.target as HTMLElement;
    const next = current.nextElementSibling as HTMLElement;
    if (next?.classList.contains('backlink-item')) {
        next.focus();
    }
}

function focusPrevBacklink(e: Event) {
    const current = e.target as HTMLElement;
    const prev = current.previousElementSibling as HTMLElement;
    if (prev?.classList.contains('backlink-item')) {
        prev.focus();
    } else {
        // First backlink — focus back to editor's last block
        const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
        editorEl?.focus();
    }
}

function handleBeforeUnload() {
    flushSync();
}

const showDeleteConfirm = ref(false);

function deletePage() {
    fetch(`/api/nodes/${props.page.id}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
    }).then(() => {
        showDeleteConfirm.value = false;
        toast.success(`Deleted "${titleContent.value || '[untitled]'}"`);
        router.visit('/pages');
    });
}

function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !isEditingTitle.value) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
        // Don't intercept if the editor already has focus
        if (target.closest('.ProseMirror')) return;
        e.preventDefault();
        const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
        editorEl?.focus();
    }
}

onMounted(() => {
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('keydown', handleGlobalKeydown);
    nextTick(() => {
        const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
        editorEl?.focus();
    });
});

onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    document.removeEventListener('keydown', handleGlobalKeydown);
    flushSync();
});
</script>

<template>
    <Head :title="page.content || '[untitled]'" />

    <AppLayout :breadcrumbs="breadcrumbs" :current-page-id="page.id">
        <div class="relative">
            <div class="absolute top-4 right-4">
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <Button variant="outline" size="icon" class="shrink-0">
                            <EllipsisVertical class="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem class="text-destructive" @click="showDeleteConfirm = true">
                            <Trash2 class="mr-2 h-4 w-4" />
                            Delete page
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        <div class="mx-auto w-full max-w-2xl p-6">
            <div class="mb-6">
                <input
                    v-if="isEditingTitle"
                    ref="titleRef"
                    v-model="titleContent"
                    class="bg-transparent w-full border-none text-3xl font-bold outline-none"
                    :class="{ 'text-red-500': titleError }"
                    @blur="finishEditingTitle"
                    @input="syncTitleDebounced"
                    @keydown="handleTitleKeydown"
                />
                <h1
                    v-else
                    class="cursor-text text-3xl font-bold"
                    :class="{ 'text-red-500': titleError }"
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
                    :key="editorKey"
                    :nodes="pageNodes"
                    @update="handleNodesUpdate"
                    @focus-title="startEditingTitle()"
                    @focus-backlinks="focusFirstBacklink"
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
                        :href="`/pages/${link.page_id}`"
                        class="backlink-item hover:bg-accent focus:bg-accent rounded-lg px-3 py-2 text-sm transition-colors outline-none"
                        @keydown.enter.prevent="router.visit(`/pages/${link.page_id}`)"
                        @keydown.space.prevent="router.visit(`/pages/${link.page_id}`)"
                        @keydown.q.ctrl.prevent="router.visit(`/pages/${link.page_id}`)"
                        @keydown.q.meta.prevent="router.visit(`/pages/${link.page_id}`)"
                        @keydown.down.prevent="focusNextBacklink($event)"
                        @keydown.up.prevent="focusPrevBacklink($event)"
                    >
                        <span class="text-primary font-medium">
                            {{ link.page_title }}
                        </span>
                    </Link>
                </div>
            </div>
        </div>
        </div>
    </AppLayout>

    <Dialog v-model:open="showDeleteConfirm">
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Delete page</DialogTitle>
                <DialogDescription>
                    Are you sure you want to delete "{{ titleContent || '[untitled]' }}"? This cannot be undone.
                </DialogDescription>
            </DialogHeader>
            <DialogFooter>
                <Button variant="outline" @click="showDeleteConfirm = false">Cancel</Button>
                <Button variant="destructive" @click="deletePage">Delete</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
