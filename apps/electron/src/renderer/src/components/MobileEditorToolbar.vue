<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core';
import {
    ArrowDown,
    ArrowUp,
    IndentDecrease,
    IndentIncrease,
    Redo2,
    SquareCheck,
    Undo2,
} from 'lucide-vue-next';
import type { LucideIcon } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { runNodeCommand } from '@/ui/nodeCommands';
import type { NodeCommand } from '@/ui/nodeCommands';

/**
 * Touch controls for the page editor on phones, which have no Tab key or
 * shortcuts: shown above the keyboard while a block is being edited.
 */

const isPhone = useMediaQuery('(max-width: 768px)');
const editing = ref(false);

const actions: { command: NodeCommand; label: string; icon: LucideIcon }[] = [
    { command: 'outdent', label: 'Outdent', icon: IndentDecrease },
    { command: 'indent', label: 'Indent', icon: IndentIncrease },
    { command: 'move-node-up', label: 'Move up', icon: ArrowUp },
    { command: 'move-node-down', label: 'Move down', icon: ArrowDown },
    { command: 'toggle-checkbox', label: 'Checkbox', icon: SquareCheck },
    { command: 'undo', label: 'Undo', icon: Undo2 },
    { command: 'redo', label: 'Redo', icon: Redo2 },
];

const inEditor = (target: EventTarget | null) =>
    target instanceof Element && target.closest('.ProseMirror') !== null;

function handleFocusIn(event: FocusEvent): void {
    editing.value = inEditor(event.target);
}

function handleFocusOut(event: FocusEvent): void {
    // Focus moving within the editor (or to a toolbar button) keeps it open
    editing.value = inEditor(event.relatedTarget);
}

onMounted(() => {
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
});

onBeforeUnmount(() => {
    document.removeEventListener('focusin', handleFocusIn);
    document.removeEventListener('focusout', handleFocusOut);
});
</script>

<template>
    <div
        v-if="isPhone && editing"
        class="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)]"
        role="toolbar"
        aria-label="Editing"
    >
        <button
            v-for="action in actions"
            :key="action.command"
            type="button"
            class="flex h-11 flex-1 items-center justify-center text-foreground/80 active:bg-accent"
            :aria-label="action.label"
            :title="action.label"
            @pointerdown.prevent
            @click="runNodeCommand(action.command)"
        >
            <component :is="action.icon" class="size-5" />
        </button>
    </div>
</template>
