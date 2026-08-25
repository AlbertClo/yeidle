<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import { FileText, Palette, Pin, Search } from 'lucide-vue-next';
import type { LucideIcon } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandShortcut,
} from '@/components/ui/command';
import { isNodePinned, toggleNodePin } from '@/stores/pins';
import { OPEN_COMMAND_PALETTE_EVENT } from '@/ui/commandPalette';
import { openPageSearch } from '@/ui/pageSearch';
import { openThemeSelector } from '@/ui/themeSelector';

const props = defineProps<{
    currentPageId?: string;
}>();

type PaletteCommand = {
    id: string;
    label: string;
    icon: LucideIcon;
    shortcut?: string;
    run: () => void | Promise<void>;
};

const isOpen = ref(false);
const query = ref('');
const commands = computed<PaletteCommand[]>(() => [
    {
        id: 'pages',
        label: 'Go to All Pages',
        icon: FileText,
        shortcut: 'Alt+1',
        run: () => router.visit('/pages'),
    },
    {
        id: 'find-page',
        label: 'Find or Create Page',
        icon: Search,
        shortcut: 'Alt+E',
        run: openPageSearch,
    },
    {
        id: 'theme',
        label: 'Change Theme',
        icon: Palette,
        run: openThemeSelector,
    },
    ...(props.currentPageId
        ? [
              {
                  id: 'pin-page',
                  label: isNodePinned(props.currentPageId)
                      ? 'Unpin Current Page'
                      : 'Pin Current Page',
                  icon: Pin,
                  shortcut: 'Alt+P',
                  run: toggleCurrentPagePin,
              },
          ]
        : []),
]);
const filteredCommands = computed(() => {
    const normalizedQuery = query.value.trim().toLowerCase();

    if (normalizedQuery === '') {
        return commands.value;
    }

    return commands.value.filter((command) =>
        command.label.toLowerCase().includes(normalizedQuery),
    );
});

function openPalette(): void {
    query.value = '';
    isOpen.value = true;
}

function execute(command: PaletteCommand): void {
    isOpen.value = false;
    void command.run();
}

async function toggleCurrentPagePin(): Promise<void> {
    if (!props.currentPageId) {
        return;
    }

    try {
        await toggleNodePin(props.currentPageId);
    } catch {
        toast.error('Could not update the pinned page.');
    }
}

function handleGlobalKeydown(event: KeyboardEvent): void {
    if (
        props.currentPageId &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'p'
    ) {
        event.preventDefault();
        void toggleCurrentPagePin();

        return;
    }

    if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
    ) {
        event.preventDefault();
        openPalette();
    }
}

onMounted(() => {
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
    document.addEventListener('keydown', handleGlobalKeydown);
});

onBeforeUnmount(() => {
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
    document.removeEventListener('keydown', handleGlobalKeydown);
});
</script>

<template>
    <CommandDialog
        v-model:open="isOpen"
        title="Command Palette"
        description="Search for an app command"
    >
        <CommandInput placeholder="Type a command…" @search="query = $event" />
        <CommandList>
            <CommandEmpty>No commands found.</CommandEmpty>
            <CommandGroup v-if="filteredCommands.length > 0" heading="Commands">
                <CommandItem
                    v-for="command in filteredCommands"
                    :key="command.id"
                    :value="command.label"
                    @select="execute(command)"
                >
                    <component :is="command.icon" class="mr-2 h-4 w-4" />
                    <span>{{ command.label }}</span>
                    <CommandShortcut v-if="command.shortcut">
                        {{ command.shortcut }}
                    </CommandShortcut>
                </CommandItem>
            </CommandGroup>
        </CommandList>
    </CommandDialog>
</template>
