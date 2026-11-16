<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import {
    Cloud,
    CloudUpload,
    CalendarDays,
    CodeXml,
    FileText,
    History,
    Keyboard,
    Palette,
    PanelLeft,
    Pin,
    Search,
    Type,
    ArrowUp,
    ArrowDown,
    AppWindow,
} from 'lucide-vue-next';
import type { LucideIcon } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
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
import { openDailyNote } from '@/dailyNotes';
import { cloudAccount } from '@/stores/cloudAccount';
import {
    bindingLabel,
    eventMatchesCommand,
    keyboardShortcutsAvailable,
} from '@/stores/keyBindings';
import { isNodePinned, toggleNodePin } from '@/stores/pins';
import { workspaceState } from '@/stores/workspaces';
import { openCloudAccount } from '@/ui/cloudAccount';
import { OPEN_COMMAND_PALETTE_EVENT } from '@/ui/commandPalette';
import { openKeyBindings } from '@/ui/keyBindings';
import { runNodeCommand } from '@/ui/nodeCommands';
import { openPageSearch } from '@/ui/pageSearch';
import { openRawNodeEditor } from '@/ui/rawNodeEditor';
import { openThemeSelector } from '@/ui/themeSelector';
import { openTypographySelector } from '@/ui/typographySelector';
import { openWorkspaceSync } from '@/ui/workspaceSync';

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
const activeWorkspace = computed(
    () =>
        workspaceState.value?.workspaces.find(
            (workspace) =>
                workspace.id === workspaceState.value?.active_workspace_id,
        ) ?? null,
);
const commands = computed<PaletteCommand[]>(() => [
    {
        id: 'pages',
        label: 'Go to All Pages',
        icon: FileText,
        shortcut: bindingLabel('all-pages'),
        run: () => router.visit('/pages'),
    },
    {
        id: 'daily-notes',
        label: "Open Today's Daily Note",
        icon: CalendarDays,
        shortcut: bindingLabel('daily-notes'),
        run: openTodaysDailyNote,
    },
    {
        id: 'navigation-history',
        label: 'Navigation History',
        icon: History,
        shortcut: bindingLabel('navigation-history'),
        run: () => router.visit('/navigation-history'),
    },
    {
        id: 'new-window',
        label: 'Open New Window',
        icon: AppWindow,
        shortcut: bindingLabel('new-window'),
        run: openNewWindow,
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
        id: 'account',
        label: cloudAccount.value?.signed_in ? 'Yeidle Account' : 'Sign in',
        icon: Cloud,
        run: openCloudAccount,
    },
    ...(activeWorkspace.value?.cloud_status === 'local'
        ? [
              {
                  id: 'sync-workspace',
                  label: 'Sync This Workspace',
                  icon: CloudUpload,
                  run: openWorkspaceSync,
              },
          ]
        : []),
    // Phones have no keyboard shortcuts
    ...(keyboardShortcutsAvailable
        ? [
              {
                  id: 'key-bindings',
                  label: 'Change Keyboard Shortcuts',
                  icon: Keyboard,
                  run: openKeyBindings,
              },
          ]
        : []),
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
                  id: 'move-node-up',
                  label: 'Move Current Node Up',
                  icon: ArrowUp,
                  shortcut: bindingLabel('move-node-up'),
                  run: () => runNodeCommand('move-node-up'),
              },
              {
                  id: 'move-node-down',
                  label: 'Move Current Node Down',
                  icon: ArrowDown,
                  shortcut: bindingLabel('move-node-down'),
                  run: () => runNodeCommand('move-node-down'),
              },
              {
                  id: 'edit-node-raw',
                  label: 'Toggle Raw Markdown for Current Node',
                  icon: CodeXml,
                  shortcut: bindingLabel('edit-node-raw'),
                  run: openRawNodeEditor,
              },
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
    void nextTick(() => command.run());
}

async function openTodaysDailyNote(): Promise<void> {
    try {
        await openDailyNote();
    } catch {
        toast.error('Could not open today’s daily note.');
    }
}

function openNewWindow(): void {
    window.Native?.windowControls?.newWindow();
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

    if (eventMatchesCommand(event, 'new-window')) {
        event.preventDefault();
        openNewWindow();

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
