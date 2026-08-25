<script setup lang="ts">
import { FileText, LayoutGrid } from 'lucide-vue-next';
import { ref } from 'vue';
import NavMain from '@/components/NavMain.vue';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
} from '@/components/ui/sidebar';
import YeidleWordmark from '@/components/YeidleWordmark.vue';
import { dashboard } from '@/routes';
import type { NavItem } from '@/types';

const aboutOpen = ref(false);

const mainNavItems: NavItem[] = [
    {
        title: 'Dashboard',
        href: dashboard(),
        icon: LayoutGrid,
    },
    {
        title: 'Pages',
        href: '/pages',
        icon: FileText,
    },
];
</script>

<template>
    <Sidebar
        collapsible="icon"
        variant="inset"
        class="!top-12 !bottom-0 !h-auto"
    >
        <SidebarContent>
            <NavMain :items="mainNavItems" />
        </SidebarContent>
        <SidebarFooter class="group-data-[collapsible=icon]:hidden">
            <button
                type="button"
                aria-label="About Yeidle"
                class="block w-fit cursor-pointer text-sidebar-foreground opacity-20 transition-[color,opacity] duration-300 hover:text-white hover:opacity-100 focus-visible:text-white focus-visible:opacity-100 focus-visible:outline-none"
                @click="aboutOpen = true"
            >
                <YeidleWordmark class="h-auto w-18" />
            </button>
        </SidebarFooter>
    </Sidebar>

    <Dialog v-model:open="aboutOpen">
        <DialogContent class="sm:max-w-sm">
            <DialogHeader class="items-center text-center">
                <YeidleWordmark class="mb-4 h-auto w-28 text-foreground" />
                <DialogTitle>About Yeidle</DialogTitle>
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
