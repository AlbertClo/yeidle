<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import { List, SquareTerminal } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AppCommandPalette from '@/components/AppCommandPalette.vue';
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
import type { NavItem } from '@/types';
import { openCommandPalette } from '@/ui/commandPalette';

const aboutOpen = ref(false);

defineProps<{
    currentPageId?: string;
}>();

const mainNavItems: NavItem[] = [
    {
        title: 'All Pages',
        href: '/pages',
        icon: List,
        shortcut: 'Alt+1',
    },
];

function handleNavigationShortcut(event: KeyboardEvent): void {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
    }

    const path = event.key === '1' ? '/pages' : null;

    if (path === null) {
        return;
    }

    event.preventDefault();
    router.visit(path);
}

onMounted(() => {
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
                        <kbd>Ctrl+K</kbd>
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
    <ThemeSelectorDialog />

    <Dialog v-model:open="aboutOpen">
        <DialogContent class="sm:max-w-sm">
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
