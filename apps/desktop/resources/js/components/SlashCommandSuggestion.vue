<script setup lang="ts">
import { ref, watch } from 'vue';
import { Upload } from 'lucide-vue-next';

export type SlashCommandItem = {
    id: string;
    label: string;
    icon: any;
    action: string;
};

const props = defineProps<{
    items: SlashCommandItem[];
    command: (item: SlashCommandItem) => void;
}>();

const selectedIndex = ref(0);

watch(() => props.items, () => {
    selectedIndex.value = 0;
});

function onKeyDown(event: KeyboardEvent): boolean {
    if (event.key === 'ArrowUp') {
        selectedIndex.value = (selectedIndex.value - 1 + props.items.length) % props.items.length;
        return true;
    }
    if (event.key === 'ArrowDown') {
        selectedIndex.value = (selectedIndex.value + 1) % props.items.length;
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
                class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
                :class="index === selectedIndex ? 'bg-accent text-accent-foreground' : ''"
                @click="command(item)"
                @mouseenter="selectedIndex = index"
            >
                <component :is="item.icon" class="h-4 w-4 shrink-0" />
                <span>{{ item.label }}</span>
            </button>
        </div>
    </div>
</template>
