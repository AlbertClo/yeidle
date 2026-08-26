<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import {
    FileText,
    Keyboard,
    Palette,
    PanelLeft,
    Pin,
    Search,
    Type,
} from 'lucide-vue-next';
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
import { useSidebar } from '@/components/ui/sidebar';
import { bindingLabel, eventMatchesCommand } from '@/stores/keyBindings';
import { isNodePinned, toggleNodePin } from '@/stores/pins';
import { OPEN_COMMAND_PALETTE_EVENT } from '@/ui/commandPalette';
import { openKeyBindings } from '@/ui/keyBindings';
import { openPageSearch } from '@/ui/pageSearch';
import { openThemeSelector } from '@/ui/themeSelector';
import { openTypographySelector } from '@/ui/typographySelector';

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
const { toggleSidebar } = useSidebar();
const commands = computed<PaletteCommand[]>(() => [
    {
        id: 'pages',
        label: 'Go to All Pages',
        icon: FileText,
        shortcut: bindingLabel('all-pages'),
        run: () => router.visit('/pages'),
    },
    {
        id: 'toggle-left-sidebar',
        label: 'Toggle Left Sidebar',
        icon: PanelLeft,
        shortcut: bindingLabel('toggle-left-sidebar'),
        run: toggleSidebar,
    },
    {
        id: 'find-page',
        label: 'Find or Create Page',
        icon: Search,
        shortcut: bindingLabel('find-page'),
        run: openPageSearch,
    },
    {
        id: 'key-bindings',
        label: 'Change Keyboard Shortcuts',
        icon: Keyboard,
        run: openKeyBindings,
    },
    {
        id: 'theme',
        label: 'Change Theme',
        icon: Palette,
        run: openThemeSelector,
    },
    {
        id: 'typography',
        label: 'Change Font and Size',
        icon: Type,
        run: openTypographySelector,
    },
    ...(props.currentPageId
        ? [
              {
                  id: 'pin-page',
                  label: isNodePinned(props.currentPageId)
                      ? 'Unpin Current Page'
                      : 'Pin Current Page',
                  icon: Pin,
                  shortcut: bindingLabel('toggle-pin'),
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
    if (props.currentPageId && eventMatchesCommand(event, 'toggle-pin')) {
        event.preventDefault();
        void toggleCurrentPagePin();

        return;
    }

    if (eventMatchesCommand(event, 'command-palette')) {
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
