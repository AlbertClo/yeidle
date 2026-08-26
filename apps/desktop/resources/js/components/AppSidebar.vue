<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import { List, SquareTerminal } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppCommandPalette from '@/components/AppCommandPalette.vue';
import KeyBindingsDialog from '@/components/KeyBindingsDialog.vue';
import NavMain from '@/components/NavMain.vue';
import NavPinned from '@/components/NavPinned.vue';
import ThemeSelectorDialog from '@/components/ThemeSelectorDialog.vue';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
} from '@/components/ui/dialog';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import YeidleWordmark from '@/components/YeidleWordmark.vue';
import {
    bindingLabel,
    eventMatchesCommand,
    loadKeyBindings,
} from '@/stores/keyBindings';
import { loadPins, pinnedItems } from '@/stores/pins';
import type { NavItem } from '@/types';
import { PINNED_ITEM_COMMANDS } from '@/types/keyBindings';
import { openCommandPalette } from '@/ui/commandPalette';

const aboutOpen = ref(false);

defineProps<{
    currentPageId?: string;
}>();

const mainNavItems = computed<NavItem[]>(() => [
    {
        title: 'All Pages',
        href: '/pages',
        icon: List,
        shortcut: bindingLabel('all-pages'),
    },
]);

function handleNavigationShortcut(event: KeyboardEvent): void {
    if (eventMatchesCommand(event, 'all-pages')) {
        event.preventDefault();
        router.visit('/pages');

        return;
    }

    const pinnedIndex = PINNED_ITEM_COMMANDS.findIndex((command) =>
        eventMatchesCommand(event, command),
    );
    const pinnedItem = pinnedItems.value[pinnedIndex];

    if (pinnedIndex === -1 || !pinnedItem) {
        return;
    }

    event.preventDefault();
    router.visit(`/pages/${pinnedItem.id}`);
}

onMounted(() => {
    void loadKeyBindings().catch(() => undefined);
    void loadPins().catch(() => undefined);
    document.addEventListener('keydown', handleNavigationShortcut);
});

onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleNavigationShortcut);
});
</script>

<template>
    <Sidebar
        collapsible="icon"
        variant="inset"
        class="!top-12 !bottom-0 !h-auto"
    >
        <SidebarContent>
            <NavMain :items="mainNavItems">
                <SidebarMenuItem>
                    <SidebarMenuButton
                        tooltip="Command Palette"
                        class="cursor-pointer pr-16"
                        @click="openCommandPalette"
                    >
                        <SquareTerminal />
                        <span>Command Palette</span>
                    </SidebarMenuButton>
                    <SidebarMenuBadge class="font-normal text-muted-foreground">
                        <kbd>{{ bindingLabel('command-palette') }}</kbd>
                    </SidebarMenuBadge>
                </SidebarMenuItem>
            </NavMain>
            <NavPinned />
        </SidebarContent>
        <SidebarFooter class="group-data-[collapsible=icon]:hidden">
            <button
                type="button"
                aria-label="About Yeidle"
                class="block w-fit cursor-pointer text-sidebar-foreground opacity-20 transition-[color,opacity] duration-300 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
                @click="aboutOpen = true"
            >
                <YeidleWordmark class="h-auto w-18" />
            </button>
        </SidebarFooter>
    </Sidebar>

    <AppCommandPalette :current-page-id="currentPageId" />
    <KeyBindingsDialog />
    <ThemeSelectorDialog />

    <Dialog v-model:open="aboutOpen">
        <DialogContent
            class="sm:max-w-sm"
            @open-auto-focus="$event.preventDefault()"
        >
            <DialogHeader class="items-center text-center">
                <YeidleWordmark class="mb-4 h-auto w-28 text-foreground" />
                <DialogDescription class="text-center">
                    A local-first workspace for connected notes and knowledge.
                </DialogDescription>
            </DialogHeader>
            <p class="text-center text-xs text-muted-foreground">
                Version {{ $page.props.appVersion }}
            </p>
        </DialogContent>
    </Dialog>
    <slot />
</template>
