<script setup lang="ts">
import { Copy, Minus, Square, X } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, ref } from 'vue';

const isMaximized = ref(false);
let maximizedSubscriptionId: number | null = null;

function controls() {
    return window.Native?.windowControls;
}

function minimize(): void {
    controls()?.minimize();
}

function toggleMaximize(): void {
    const windowControls = controls();

    if (windowControls) {
        isMaximized.value = windowControls.toggleMaximize();
    }
}

function close(): void {
    controls()?.close();
}

onMounted(() => {
    const windowControls = controls();

    if (!windowControls) {
        return;
    }

    isMaximized.value = windowControls.isMaximized();
    maximizedSubscriptionId = windowControls.subscribeMaximizedChange(
        (maximized) => {
            isMaximized.value = maximized;
        },
    );
});

onBeforeUnmount(() => {
    if (maximizedSubscriptionId === null) {
        return;
    }

    controls()?.unsubscribeMaximizedChange(maximizedSubscriptionId);
    maximizedSubscriptionId = null;
});
</script>

<template>
    <div
        class="window-no-drag flex shrink-0 self-stretch"
        role="group"
        aria-label="Window controls"
    >
        <button
            type="button"
            class="inline-flex h-full w-10 items-center justify-center text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
            aria-label="Minimize window"
            title="Minimize"
            @click="minimize"
        >
            <Minus class="size-4" :stroke-width="1.5" />
        </button>
        <button
            type="button"
            class="inline-flex h-full w-10 items-center justify-center text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
            :aria-label="isMaximized ? 'Restore window' : 'Maximize window'"
            :title="isMaximized ? 'Restore' : 'Maximize'"
            @click="toggleMaximize"
        >
            <Copy v-if="isMaximized" class="size-3.5" :stroke-width="1.5" />
            <Square v-else class="size-3.5" :stroke-width="1.5" />
        </button>
        <button
            type="button"
            class="inline-flex h-full w-10 items-center justify-center text-foreground/80 transition-colors hover:bg-red-600 hover:text-white focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
            aria-label="Close window"
            title="Close"
            @click="close"
        >
            <X class="size-4" :stroke-width="1.5" />
        </button>
    </div>
</template>
