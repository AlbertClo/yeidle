<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { FileText, Plus } from 'lucide-vue-next';

export type SuggestionItem = {
    id: string;
    content: string;
    isCreate?: boolean;
};

const props = defineProps<{
    items: SuggestionItem[];
    command: (item: SuggestionItem) => void;
}>();

const selectedIndex = ref(0);

watch(() => props.items, () => {
    selectedIndex.value = 0;
});

function scrollToSelected() {
    nextTick(() => {
        const el = document.querySelector('.wiki-suggestion-item[data-selected="true"]') as HTMLElement;
        el?.scrollIntoView({ block: 'nearest' });
    });
}

function onKeyDown(event: KeyboardEvent): boolean {
    if (event.key === 'ArrowUp') {
        selectedIndex.value = (selectedIndex.value - 1 + props.items.length) % props.items.length;
        scrollToSelected();
        return true;
    }
    if (event.key === 'ArrowDown') {
        selectedIndex.value = (selectedIndex.value + 1) % props.items.length;
        scrollToSelected();
        return true;
    }
    if (event.key === 'Enter') {
        const item = props.items[selectedIndex.value];
        if (item) {
            props.command(item);
        }
        return true;
    }
    return false;
}

defineExpose({ onKeyDown });
</script>

<template>
    <div
        v-if="items.length > 0"
        class="bg-popover border-border z-50 overflow-hidden rounded-md border shadow-md"
    >
        <div class="max-h-[200px] overflow-y-auto p-1">
            <button
                v-for="(item, index) in items"
                :key="item.id"
                class="wiki-suggestion-item flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors"
                :class="index === selectedIndex ? 'bg-accent text-accent-foreground' : ''"
                :data-selected="index === selectedIndex"
                @click="command(item)"
                @mouseenter="selectedIndex = index"
            >
                <Plus v-if="item.isCreate" class="h-4 w-4 shrink-0" />
                <FileText v-else class="h-4 w-4 shrink-0" />
                <span class="truncate">{{ item.isCreate ? `Create: ${item.content}` : item.content }}</span>
            </button>
        </div>
    </div>
</template>
