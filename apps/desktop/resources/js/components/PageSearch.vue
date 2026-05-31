<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { router } from '@inertiajs/vue3';
import { Search } from 'lucide-vue-next';
import type { Node } from '@/types/node';

const query = ref('');
const results = ref<Node[]>([]);
const isOpen = ref(false);
const inputRef = ref<HTMLInputElement>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(query, (val) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (val.length < 2) {
        results.value = [];
        isOpen.value = false;
        return;
    }
    debounceTimer = setTimeout(() => {
        fetch(`/api/search?q=${encodeURIComponent(val)}`, {
            headers: { Accept: 'application/json' },
        })
            .then((res) => res.json())
            .then((data) => {
                // Deduplicate: show pages, or for blocks show their parent page
                const pageMap = new Map<string, Node>();
                for (const node of data) {
                    if (!node.parent_id) {
                        pageMap.set(node.id, node);
                    } else {
                        // It's a block — we'd need the page ID, but for now show the block
                        if (!pageMap.has(node.id)) {
                            pageMap.set(node.id, node);
                        }
                    }
                }
                results.value = [...pageMap.values()].slice(0, 10);
                isOpen.value = results.value.length > 0;
            });
    }, 200);
});

function navigate(node: Node) {
    const pageId = node.parent_id ?? node.id;
    query.value = '';
    isOpen.value = false;
    router.visit(`/pages/${pageId}`);
}

function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
        query.value = '';
        isOpen.value = false;
        inputRef.value?.blur();
    }
}

function handleBlur() {
    setTimeout(() => {
        isOpen.value = false;
    }, 200);
}

function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.altKey && e.key === 'e') {
        e.preventDefault();
        inputRef.value?.focus();
        inputRef.value?.select();
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
    <div class="relative ml-auto w-64">
        <div class="relative">
            <Search class="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
            <input
                ref="inputRef"
                v-model="query"
                type="text"
                placeholder="Search pages..."
                class="bg-sidebar-accent/50 text-foreground placeholder:text-muted-foreground h-8 w-full rounded-md border-none pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-sidebar-border"
                @keydown="handleKeydown"
                @blur="handleBlur"
            />
        </div>
        <div
            v-if="isOpen"
            class="bg-popover border-border absolute top-full z-50 mt-1 w-full overflow-hidden rounded-md border shadow-md"
        >
            <button
                v-for="result in results"
                :key="result.id"
                class="hover:bg-accent w-full px-3 py-2 text-left text-sm transition-colors"
                @mousedown.prevent="navigate(result)"
            >
                <span class="truncate">{{ result.content || '[untitled]' }}</span>
                <span
                    v-if="result.parent_id"
                    class="text-muted-foreground ml-1 text-xs"
                >(block)</span>
            </button>
        </div>
    </div>
</template>
