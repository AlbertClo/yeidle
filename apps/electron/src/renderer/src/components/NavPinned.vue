<script setup lang="ts">
import { Link } from '@inertiajs/vue3';
import { FileText } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import {
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useCurrentUrl } from '@/composables/useCurrentUrl';
import { bindingLabel } from '@/stores/keyBindings';
import {
    loadPins,
    pinsChanged,
    persistPinOrder,
    pinnedItems,
} from '@/stores/pins';
import {
    changedDocuments,
    DOCUMENTS_CHANGED_EVENT,
} from '@/sync/documentChanges';
import { PINNED_ITEM_COMMANDS } from '@/types/keyBindings';

const { isCurrentUrl } = useCurrentUrl();
const draggedNodeId = ref<string | null>(null);
let dragSnapshot: string[] = [];
let dropped = false;

function startDrag(nodeId: string, event: DragEvent): void {
    draggedNodeId.value = nodeId;
    dragSnapshot = pinnedItems.value.map((item) => item.id);
    dropped = false;

    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', nodeId);
    }
}

function moveDraggedItem(overNodeId: string, event: DragEvent): void {
    event.preventDefault();

    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
    }

    const draggedId = draggedNodeId.value;

    if (!draggedId || draggedId === overNodeId) {
        return;
    }

    const from = pinnedItems.value.findIndex((item) => item.id === draggedId);
    const to = pinnedItems.value.findIndex((item) => item.id === overNodeId);

    if (from === -1 || to === -1) {
        return;
    }

    const reordered = [...pinnedItems.value];
    const [draggedPage] = reordered.splice(from, 1);
    reordered.splice(to, 0, draggedPage);
    pinnedItems.value = reordered;
}

async function dropPin(event: DragEvent): Promise<void> {
    event.preventDefault();
    dropped = true;
    draggedNodeId.value = null;

    try {
        await persistPinOrder(pinnedItems.value.map((item) => item.id));
    } catch {
        toast.error('Could not reorder pinned items.');
    }
}

function finishDrag(): void {
    if (!dropped) {
        const pagesById = new Map(
            pinnedItems.value.map((item) => [item.id, item]),
        );
        pinnedItems.value = dragSnapshot
            .map((id) => pagesById.get(id))
            .filter((page) => page !== undefined);
    }

    draggedNodeId.value = null;
    dragSnapshot = [];
    dropped = false;
}

function handleDocumentsChanged(event: Event): void {
    if (pinsChanged(changedDocuments(event))) {
        void loadPins(true);
    }
}

function pinnedShortcutLabel(index: number): string | null {
    const command = PINNED_ITEM_COMMANDS[index];

    return command ? bindingLabel(command) : null;
}

onMounted(() => {
    void loadPins(true);
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, handleDocumentsChanged);
});

onBeforeUnmount(() => {
    window.removeEventListener(DOCUMENTS_CHANGED_EVENT, handleDocumentsChanged);
});
</script>

<template>
    <SidebarGroup class="mt-4 px-2 py-0">
        <SidebarGroupLabel>Pinned</SidebarGroupLabel>
        <SidebarMenu>
            <SidebarMenuItem
                v-if="pinnedItems.length === 0"
                class="px-2 py-1 text-xs leading-relaxed text-muted-foreground group-data-[collapsible=icon]:hidden"
            >
                Press <kbd>{{ bindingLabel('toggle-pin') }}</kbd> on a page to
                pin it.
            </SidebarMenuItem>
            <SidebarMenuItem
                v-for="(item, index) in pinnedItems"
                :key="item.id"
                draggable="true"
                class="cursor-grab active:cursor-grabbing"
                :class="{ 'opacity-50': draggedNodeId === item.id }"
                @dragstart="startDrag(item.id, $event)"
                @dragover="moveDraggedItem(item.id, $event)"
                @drop.stop="dropPin"
                @dragend="finishDrag"
            >
                <SidebarMenuButton
                    as-child
                    :is-active="isCurrentUrl(`/pages/${item.id}`)"
                    :tooltip="item.title || '[untitled]'"
                    :class="index < 10 ? 'pr-16' : undefined"
                >
                    <Link :href="`/pages/${item.id}`">
                        <FileText />
                        <span>{{ item.title || '[untitled]' }}</span>
                    </Link>
                </SidebarMenuButton>
                <SidebarMenuBadge
                    v-if="pinnedShortcutLabel(index)"
                    class="font-normal text-muted-foreground"
                >
                    <kbd>{{ pinnedShortcutLabel(index) }}</kbd>
                </SidebarMenuBadge>
            </SidebarMenuItem>
        </SidebarMenu>
    </SidebarGroup>
</template>
