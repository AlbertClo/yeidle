<script setup lang="ts">
import AppContent from '@/components/AppContent.vue';
import AppShell from '@/components/AppShell.vue';
import AppSidebar from '@/components/AppSidebar.vue';
import AppSidebarHeader from '@/components/AppSidebarHeader.vue';
import CloudSyncStatus from '@/components/CloudSyncStatus.vue';
import type { BreadcrumbItem } from '@/types';

type Props = {
    breadcrumbs?: BreadcrumbItem[];
    currentPageId?: string;
};

withDefaults(defineProps<Props>(), {
    breadcrumbs: () => [],
});
</script>

<template>
    <AppShell variant="sidebar">
        <AppSidebarHeader
            :breadcrumbs="breadcrumbs"
            :current-page-id="currentPageId"
        />
        <AppSidebar :current-page-id="currentPageId" />
        <AppContent
            variant="sidebar"
            class="min-h-0 overflow-hidden md:peer-data-[variant=inset]:m-0 md:peer-data-[variant=inset]:rounded-none md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0"
        >
            <div
                scroll-region
                data-main-scroll
                class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
            >
                <div data-main-scroll-content class="min-h-full">
                    <slot />
                </div>
            </div>
        </AppContent>
        <div class="window-no-drag fixed right-1 bottom-1 z-40">
            <CloudSyncStatus />
        </div>
    </AppShell>
</template>
