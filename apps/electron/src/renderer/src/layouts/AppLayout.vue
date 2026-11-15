<script setup lang="ts">
import AppLayout from '@/layouts/app/AppSidebarLayout.vue';
import type { BreadcrumbItem } from '@/types';

type Props = {
    breadcrumbs?: BreadcrumbItem[];
    currentPageId?: string;
    currentPageType?: string | null;
};

withDefaults(defineProps<Props>(), {
    breadcrumbs: () => [],
});
</script>

<template>
    <AppLayout
        :breadcrumbs="breadcrumbs"
        :current-page-id="currentPageId"
        :current-page-type="currentPageType"
    >
        <slot />
    </AppLayout>
</template>
