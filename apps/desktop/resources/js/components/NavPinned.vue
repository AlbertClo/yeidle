<script setup lang="ts">
import { Link } from '@inertiajs/vue3';
import { FileText, GripVertical } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import {
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useCurrentUrl } from '@/composables/useCurrentUrl';
import {
    loadPins,
    opsAffectPins,
    persistPinOrder,
    pinnedItems,
} from '@/stores/pins';
import { LOCAL_OPS_AVAILABLE_EVENT } from '@/sync/localOps';
import type { LocalOpsAvailableEvent } from '@/sync/localOps';

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

function handleLocalOps(event: Event): void {
    const detail = (event as LocalOpsAvailableEvent).detail;

    if (opsAffectPins(detail?.ops ?? null)) {
        void loadPins(true);
    }
}

onMounted(() => {
    void loadPins(true);
    window.addEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleLocalOps);
});

onBeforeUnmount(() => {
    window.removeEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleLocalOps);
});
</script>

<template>
    <SidebarGroup class="mt-4 px-2 py-0">
        <SidebarGroupLabel>Pinned</SidebarGroupLabel>
        <SidebarMenu>
            <SidebarMenuItem
                v-for="item in pinnedItems"
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
                    :tooltip="item.content || '[untitled]'"
                >
                    <Link :href="`/pages/${item.id}`">
                        <FileText />
                        <span>{{ item.content || '[untitled]' }}</span>
                    </Link>
                </SidebarMenuButton>
                <SidebarMenuAction as="span" show-on-hover aria-hidden="true">
                    <GripVertical />
                </SidebarMenuAction>
            </SidebarMenuItem>
        </SidebarMenu>
    </SidebarGroup>
</template>
