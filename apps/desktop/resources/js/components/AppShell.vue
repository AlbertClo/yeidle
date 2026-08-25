<script setup lang="ts">
import { usePage } from '@inertiajs/vue3';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import 'vue-sonner/style.css';
import type { AppVariant } from '@/types';

type Props = {
    variant?: AppVariant;
};

withDefaults(defineProps<Props>(), {
    variant: 'sidebar',
});

const isOpen = usePage().props.sidebarOpen;
</script>

<template>
    <div v-if="variant === 'header'" class="flex min-h-screen w-full flex-col">
        <slot />
    </div>
    <SidebarProvider
        v-else
        :default-open="isOpen"
        class="relative h-svh min-h-0 overflow-hidden pt-12"
    >
        <slot />
    </SidebarProvider>
    <Toaster position="top-center" :rich-colors="true" />
</template>
