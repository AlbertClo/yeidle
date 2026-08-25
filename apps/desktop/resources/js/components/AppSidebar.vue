<script setup lang="ts">
import { FileText, LayoutGrid } from 'lucide-vue-next';
import NavMain from '@/components/NavMain.vue';
import { Sidebar, SidebarContent } from '@/components/ui/sidebar';
import { dashboard } from '@/routes';
import type { NavItem } from '@/types';

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
    </Sidebar>
    <slot />
</template>
