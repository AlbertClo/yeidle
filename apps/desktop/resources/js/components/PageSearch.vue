<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { router } from '@inertiajs/vue3';
import { FileText, Search } from 'lucide-vue-next';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import type { Node } from '@/types/node';

const isOpen = ref(false);
const results = ref<Node[]>([]);
let lastSearch: string | null = null;

watch(isOpen, (open) => {
    if (open) {
        lastSearch = null;
        doSearch('');
    }
});

function doSearch(val: string) {
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
            results.value = [...pageMap.values()].slice(0, 60);
        });
}

function navigate(node: Node) {
    const pageId = node.parent_id ?? node.id;
    isOpen.value = false;
    lastSearch = '';
    results.value = [];
    router.visit(`/pages/${pageId}`);
}

function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.altKey && e.key === 'e') {
        e.preventDefault();
        isOpen.value = true;
    }
}

onMounted(() => {
    document.addEventListener('keydown', handleGlobalKeydown);
});

onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleGlobalKeydown);
});
</script>

<template>
    <button
        class="bg-sidebar-accent/50 text-muted-foreground ml-auto flex h-8 w-64 items-center gap-2 rounded-md px-3 text-sm"
        @click="isOpen = true"
    >
        <Search class="h-4 w-4" />
        <span>Search pages...</span>
        <kbd class="bg-muted text-muted-foreground ml-auto rounded px-1.5 py-0.5 text-xs">Alt+E</kbd>
    </button>

    <CommandDialog
        v-model:open="isOpen"
        title="Search Pages"
        description="Search for pages and blocks"
    >
        <CommandInput placeholder="Search pages..." @search="doSearch" />
        <CommandList>
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
