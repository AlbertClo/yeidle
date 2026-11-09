<script setup lang="ts">
import AppLogoIcon from '@/components/AppLogoIcon.vue';

withDefaults(
    defineProps<{
        name?: string;
        showName?: boolean;
    }>(),
    {
        name: 'Yeidle',
        showName: true,
    },
);
</script>

<template>
    <div
        class="flex aspect-square size-7 items-center justify-center rounded-xs bg-sidebar-primary text-sidebar-primary-foreground"
    >
        <AppLogoIcon class="size-4 fill-current text-white dark:text-black" />
    </div>
    <div v-if="showName" class="ml-1 grid flex-1 text-left text-sm">
        <span class="truncate leading-none font-semibold">{{ name }}</span>
    </div>
</template>
