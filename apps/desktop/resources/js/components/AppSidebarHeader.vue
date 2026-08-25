<script setup lang="ts">
import Breadcrumbs from '@/components/Breadcrumbs.vue';
import CloudSyncStatus from '@/components/CloudSyncStatus.vue';
import PageSearch from '@/components/PageSearch.vue';
import { SidebarTrigger } from '@/components/ui/sidebar';
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
</script>

<template>
    <header
        class="window-drag-region sticky top-0 z-40 flex h-16 shrink-0 items-center gap-2 border-b border-sidebar-border/70 bg-background px-6 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 md:px-4"
    >
        <div class="window-no-drag flex items-center gap-2">
            <SidebarTrigger class="-ml-1" />
            <template v-if="breadcrumbs && breadcrumbs.length > 0">
                <Breadcrumbs :breadcrumbs="breadcrumbs" />
            </template>
        </div>
        <div class="window-no-drag ml-auto">
            <PageSearch :current-page-id="currentPageId" />
        </div>
        <div class="window-no-drag">
            <CloudSyncStatus />
        </div>
    </header>
</template>
