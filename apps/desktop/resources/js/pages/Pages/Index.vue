<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import { FileText } from 'lucide-vue-next';
import AppLayout from '@/layouts/AppLayout.vue';
import type { BreadcrumbItem } from '@/types';
import type { Node } from '@/types/node';

defineProps<{
    pages: Node[];
}>();

const breadcrumbs: BreadcrumbItem[] = [{ title: 'Pages', href: '/pages' }];

function modifiedDate(page: Node): string {
    const millis = Number.parseInt(page.modified_hlc.slice(0, 15), 10);
    const date = Number.isFinite(millis)
        ? new Date(millis)
        : new Date(page.updated_at);

    return date.toLocaleDateString();
}
</script>

<template>
    <Head title="Pages" />

    <AppLayout :breadcrumbs="breadcrumbs">
        <div class="mx-auto w-full max-w-2xl p-6">
            <div class="mb-6">
                <h1 class="text-2xl font-bold">Pages</h1>
            </div>

            <div
                v-if="pages.length === 0"
                class="py-12 text-center text-muted-foreground"
            >
                <FileText class="mx-auto mb-3 h-12 w-12 opacity-50" />
                <p>No pages yet. Use the search bar (Alt+E) to create one.</p>
            </div>

            <div v-else class="flex flex-col gap-1">
                <Link
                    v-for="page in pages"
                    :key="page.id"
                    :href="`/pages/${page.id}`"
                    class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent"
                >
                    <FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span class="flex-1 truncate">
                        {{ page.content || '[untitled]' }}
                    </span>
                    <span class="text-xs text-muted-foreground">
                        {{ modifiedDate(page) }}
                    </span>
                </Link>
            </div>
        </div>
    </AppLayout>
</template>
