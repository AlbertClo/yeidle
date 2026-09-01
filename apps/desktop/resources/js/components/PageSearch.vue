<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import { Clock, FileText, Plus, Search } from 'lucide-vue-next';
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import { bindingLabel, eventMatchesCommand } from '@/stores/keyBindings';
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
let initialData: { recentPages: Node[]; results: Node[] } | null = null;
let initialDataRequest: Promise<{
    recentPages: Node[];
    results: Node[];
}> | null = null;
let openRequestId = 0;
let searchRequestId = 0;
let searchAbortController: AbortController | null = null;

function uniqueResults(data: Node[]): Node[] {
    const pageMap = new Map<string, Node>();

    for (const node of data) {
        if (!node.parent_id || !pageMap.has(node.id)) {
            pageMap.set(node.id, node);
        }
    }

    return [...pageMap.values()];
}

async function fetchNodes(url: string, signal?: AbortSignal): Promise<Node[]> {
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal,
    });

    if (!response.ok) {
        throw new Error(
            `Page search request failed (HTTP ${response.status}).`,
        );
    }

    return response.json() as Promise<Node[]>;
}

function preloadInitialData(): Promise<{
    recentPages: Node[];
    results: Node[];
}> {
    if (initialData) {
        return Promise.resolve(initialData);
    }

    if (initialDataRequest) {
        return initialDataRequest;
    }

    initialDataRequest = Promise.all([
        fetchNodes('/api/recent-pages'),
        fetchNodes('/api/pages'),
    ])
        .then(([recent, pages]) => {
            initialData = {
                recentPages: recent,
                results: uniqueResults(pages).slice(0, 60),
            };

            return initialData;
        })
        .finally(() => {
            initialDataRequest = null;
        });

    return initialDataRequest;
}

function autoHighlightFirst() {
    nextTick(() => {
        const input = document.querySelector(
            '[data-slot="command-input"]',
        ) as HTMLElement;

        if (input) {
            input.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'ArrowDown',
                    bubbles: true,
                }),
            );
            input.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
            );
        }
    });
}

const exactPageMatch = computed(() =>
    results.value.some(
        (r) =>
            !r.parent_id &&
            r.content.toLowerCase() === searchQuery.value.toLowerCase(),
    ),
);

function doSearch(val: string) {
    searchQuery.value = val;

    if (val === lastSearch) {
        return;
    }

    lastSearch = val;
    searchAbortController?.abort();

    if (val.length === 0 && initialData) {
        results.value = initialData.results;
        autoHighlightFirst();

        return;
    }

    const requestId = ++searchRequestId;
    const controller = new AbortController();
    searchAbortController = controller;

    fetchNodes(`/api/search?q=${encodeURIComponent(val)}`, controller.signal)
        .then((data) => {
            if (requestId !== searchRequestId || val !== searchQuery.value) {
                return;
            }

            const query = val.toLowerCase();
            const sorted = uniqueResults(data).sort((a, b) => {
                const aExact =
                    !a.parent_id && a.content.toLowerCase() === query ? -1 : 0;
                const bExact =
                    !b.parent_id && b.content.toLowerCase() === query ? -1 : 0;

                return aExact - bExact;
            });
            results.value = sorted.slice(0, 60);
            autoHighlightFirst();
        })
        .catch((error: unknown) => {
            if (
                !(error instanceof DOMException && error.name === 'AbortError')
            ) {
                console.error(error);
            }
        });
}

function createPage() {
    const title = searchQuery.value;
    isOpen.value = false;
    searchQuery.value = '';
    results.value = [];
    fetch('/api/nodes', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ content: title }),
    })
        .then((res) => res.json())
        .then((node) => {
            router.visit(`/pages/${node.id}`);
        });
}

function navigate(node: Node) {
    const pageId = node.page_id ?? node.parent_id ?? node.id;
    const blockQuery = node.parent_id
        ? `?block=${encodeURIComponent(node.id)}`
        : '';
    isOpen.value = false;
    lastSearch = '';
    results.value = [];
    router.visit(`/pages/${pageId}${blockQuery}`);
}

async function openSearch() {
    const requestId = ++openRequestId;
    const data = await preloadInitialData().catch(() => ({
        recentPages: [],
        results: [],
    }));

    if (requestId !== openRequestId) {
        return;
    }

    lastSearch = '';
    searchQuery.value = '';
    recentPages.value = data.recentPages.filter(
        (page) => page.id !== props.currentPageId,
    );
    results.value = data.results;
    isOpen.value = true;
    autoHighlightFirst();
}

function handleGlobalKeydown(e: KeyboardEvent) {
    if (eventMatchesCommand(e, 'find-page')) {
        e.preventDefault();
        openSearch();
    }
}

onMounted(() => {
    window.addEventListener(OPEN_PAGE_SEARCH_EVENT, openSearch);
    document.addEventListener('keydown', handleGlobalKeydown);
    void preloadInitialData().catch(() => undefined);
});

onBeforeUnmount(() => {
    openRequestId += 1;
    searchAbortController?.abort();
    window.removeEventListener(OPEN_PAGE_SEARCH_EVENT, openSearch);
    document.removeEventListener('keydown', handleGlobalKeydown);
});
</script>

<template>
    <button
        class="ml-auto flex h-8 w-64 items-center gap-2 rounded-md bg-sidebar-accent/50 px-3 text-sm text-muted-foreground"
        @click="openSearch"
    >
        <Search class="h-4 w-4 shrink-0" />
        <span class="min-w-0 flex-1 truncate text-left whitespace-nowrap"
            >Find or Create Page</span
        >
        <kbd
            class="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground"
            >{{ bindingLabel('find-page') }}</kbd
        >
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
                    <span
                        >Create page: <strong>{{ searchQuery }}</strong></span
                    >
                </CommandItem>
            </CommandGroup>
            <CommandGroup
                v-if="searchQuery.length === 0 && recentPages.length > 0"
                heading="Recent"
            >
                <CommandItem
                    v-for="page in recentPages"
                    :key="`recent-${page.id}`"
                    :value="`recent: ${page.content || '[untitled]'}`"
                    @select="navigate(page)"
                >
                    <Clock class="mr-2 h-4 w-4 shrink-0" />
                    <span class="truncate">{{
                        page.content || '[untitled]'
                    }}</span>
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
                    <FileText
                        v-if="!result.parent_id"
                        class="mr-2 h-4 w-4 shrink-0"
                    />
                    <div
                        v-else
                        class="mr-2 flex h-4 w-4 shrink-0 items-center justify-center"
                    >
                        <div
                            class="h-1.5 w-1.5 rounded-full bg-foreground/50"
                        />
                    </div>
                    <span class="truncate">{{
                        result.content || '[untitled]'
                    }}</span>
                </CommandItem>
            </CommandGroup>
        </CommandList>
    </CommandDialog>
</template>
