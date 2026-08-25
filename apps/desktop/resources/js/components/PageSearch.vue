<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { router } from '@inertiajs/vue3';
import { Clock, FileText, Plus, Search } from 'lucide-vue-next';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import type { Node } from '@/types/node';
import { OPEN_PAGE_SEARCH_EVENT } from '@/ui/pageSearch';

const props = defineProps<{
    currentPageId?: string;
}>();

const isOpen = ref(false);
const results = ref<Node[]>([]);
const recentPages = ref<Node[]>([]);
const searchQuery = ref('');
let lastSearch: string | null = null;

watch(isOpen, (open) => {
    if (open) {
        lastSearch = null;
        Promise.all([
            fetchRecentPages(),
            fetchInitialResults(),
        ]).then(() => {
            autoHighlightFirst();
        });
    }
});

function fetchRecentPages() {
    return fetch('/api/recent-pages', { headers: { Accept: 'application/json' } })
        .then((res) => res.json())
        .then((data) => {
            recentPages.value = data.filter((p: Node) => p.id !== props.currentPageId);
        });
}

function fetchInitialResults() {
    lastSearch = '';
    searchQuery.value = '';
    return fetch('/api/pages', { headers: { Accept: 'application/json' } })
        .then((res) => res.json())
        .then((data) => {
            const pageMap = new Map<string, Node>();
            for (const node of data) {
                if (!node.parent_id) {
                    pageMap.set(node.id, node);
                } else if (!pageMap.has(node.id)) {
                    pageMap.set(node.id, node);
                }
            }
            results.value = [...pageMap.values()].slice(0, 60);
        });
}

function autoHighlightFirst() {
    nextTick(() => {
        const input = document.querySelector('[data-slot="command-input"]') as HTMLElement;
        if (input) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        }
    });
}

const exactPageMatch = computed(() =>
    results.value.some(r => !r.parent_id && r.content.toLowerCase() === searchQuery.value.toLowerCase()),
);

function doSearch(val: string) {
    searchQuery.value = val;
    if (val === lastSearch) return;
    lastSearch = val;
    const url = val.length > 0
        ? `/api/search?q=${encodeURIComponent(val)}`
        : '/api/pages';
    fetch(url, {
        headers: { Accept: 'application/json' },
    })
        .then((res) => res.json())
        .then((data) => {
            const pageMap = new Map<string, Node>();
            for (const node of data) {
                if (!node.parent_id) {
                    pageMap.set(node.id, node);
                } else {
                    if (!pageMap.has(node.id)) {
                        pageMap.set(node.id, node);
                    }
                }
            }
            const sorted = [...pageMap.values()].sort((a, b) => {
                const q = lastSearch?.toLowerCase() ?? '';
                const aExact = !a.parent_id && a.content.toLowerCase() === q ? -1 : 0;
                const bExact = !b.parent_id && b.content.toLowerCase() === q ? -1 : 0;
                return aExact - bExact;
            });
            results.value = sorted.slice(0, 60);
            autoHighlightFirst();
        });
}

function createPage() {
    const title = searchQuery.value;
    isOpen.value = false;
    searchQuery.value = '';
    results.value = [];
    fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ content: title }),
    })
        .then((res) => res.json())
        .then((node) => {
            router.visit(`/pages/${node.id}`);
        });
}

function navigate(node: Node) {
    const pageId = node.parent_id ?? node.id;
    isOpen.value = false;
    lastSearch = '';
    results.value = [];
    router.visit(`/pages/${pageId}`);
}

function openSearch() {
    isOpen.value = true;
}

function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.altKey && e.key === 'e') {
        e.preventDefault();
        openSearch();
    }
}

onMounted(() => {
    window.addEventListener(OPEN_PAGE_SEARCH_EVENT, openSearch);
    document.addEventListener('keydown', handleGlobalKeydown);
});

onBeforeUnmount(() => {
    window.removeEventListener(OPEN_PAGE_SEARCH_EVENT, openSearch);
    document.removeEventListener('keydown', handleGlobalKeydown);
});
</script>

<template>
    <button
        class="bg-sidebar-accent/50 text-muted-foreground ml-auto flex h-8 w-64 items-center gap-2 rounded-md px-3 text-sm"
        @click="openSearch"
    >
        <Search class="h-4 w-4" />
        <span>Find or Create Page</span>
        <kbd class="bg-muted text-muted-foreground ml-auto rounded px-1.5 py-0.5 text-xs">Alt+E</kbd>
    </button>

    <CommandDialog
        v-model:open="isOpen"
        title="Search Pages"
        description="Search for pages and blocks"
    >
        <CommandInput placeholder="Find or Create Page" @search="doSearch" />
        <CommandList>
            <CommandGroup v-if="searchQuery.length > 0 && !exactPageMatch">
                <CommandItem
                    :value="`create: ${searchQuery}`"
                    @select="createPage"
                >
                    <Plus class="mr-2 h-4 w-4 shrink-0" />
                    <span>Create page: <strong>{{ searchQuery }}</strong></span>
                </CommandItem>
            </CommandGroup>
            <CommandGroup v-if="searchQuery.length === 0 && recentPages.length > 0" heading="Recent">
                <CommandItem
                    v-for="page in recentPages"
                    :key="`recent-${page.id}`"
                    :value="`recent: ${page.content || '[untitled]'}`"
                    @select="navigate(page)"
                >
                    <Clock class="mr-2 h-4 w-4 shrink-0" />
                    <span class="truncate">{{ page.content || '[untitled]' }}</span>
                </CommandItem>
            </CommandGroup>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup v-if="results.length > 0" heading="Results">
                <CommandItem
                    v-for="result in results"
                    :key="result.id"
                    :value="result.content || '[untitled]'"
                    @select="navigate(result)"
                >
                    <FileText v-if="!result.parent_id" class="mr-2 h-4 w-4 shrink-0" />
                    <div v-else class="mr-2 flex h-4 w-4 shrink-0 items-center justify-center">
                        <div class="bg-foreground/50 h-1.5 w-1.5 rounded-full" />
                    </div>
                    <span class="truncate">{{ result.content || '[untitled]' }}</span>
                </CommandItem>
            </CommandGroup>
        </CommandList>
    </CommandDialog>
</template>
