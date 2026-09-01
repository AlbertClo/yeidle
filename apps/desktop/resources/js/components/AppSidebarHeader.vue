<script setup lang="ts">
import { computed } from 'vue';
import Breadcrumbs from '@/components/Breadcrumbs.vue';
import PageSearch from '@/components/PageSearch.vue';
import {
    SidebarMenu,
    SidebarTrigger,
    useSidebar,
} from '@/components/ui/sidebar';
import WindowControls from '@/components/WindowControls.vue';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher.vue';
import type { BreadcrumbItem } from '@/types';

withDefaults(
    defineProps<{
        breadcrumbs?: BreadcrumbItem[];
        currentPageId?: string;
    }>(),
    {
        breadcrumbs: () => [],
    },
);

const { state: sidebarState } = useSidebar();
const workspaceSectionStyle = computed(() => ({
    width:
        sidebarState.value === 'collapsed'
            ? 'var(--sidebar-width-icon)'
            : 'var(--sidebar-width)',
}));
</script>

<template>
    <header
        class="window-drag-region fixed inset-x-0 top-0 z-50 flex h-12 items-center border-b border-sidebar-border/70 bg-sidebar"
    >
        <div
            class="flex h-full shrink-0 items-center"
            :style="workspaceSectionStyle"
        >
            <SidebarMenu class="window-no-drag h-full [&>li]:h-full">
                <WorkspaceSwitcher placement="header" />
            </SidebarMenu>
        </div>

        <div
            class="flex h-full min-w-0 flex-1 items-center gap-2 bg-background pl-4"
        >
            <div class="window-no-drag flex min-w-0 items-center gap-2">
                <SidebarTrigger class="-ml-1" />
                <template v-if="breadcrumbs && breadcrumbs.length > 0">
                    <Breadcrumbs :breadcrumbs="breadcrumbs" />
                </template>
            </div>
            <div class="window-no-drag ml-auto shrink-0">
                <PageSearch :current-page-id="currentPageId" />
            </div>
            <WindowControls />
        </div>
    </header>
</template>
