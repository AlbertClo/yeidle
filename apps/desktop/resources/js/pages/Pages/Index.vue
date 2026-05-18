<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import { FileText, Plus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import AppLayout from '@/layouts/AppLayout.vue';
import type { BreadcrumbItem } from '@/types';
import type { Node } from '@/types/node';

defineProps<{
    pages: Node[];
}>();

const breadcrumbs: BreadcrumbItem[] = [
    { title: 'Pages', href: '/pages' },
];

function createPage() {
    fetch('/api/nodes', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ content: 'Untitled' }),
    })
        .then((res) => res.json())
        .then((node) => {
            router.visit(`/pages/${node.id}`);
        });
}
</script>

<template>
    <Head title="Pages" />

    <AppLayout :breadcrumbs="breadcrumbs">
        <div class="mx-auto w-full max-w-2xl p-6">
            <div class="mb-6 flex items-center justify-between">
                <h1 class="text-2xl font-bold">Pages</h1>
                <Button size="sm" @click="createPage">
                    <Plus class="mr-1 h-4 w-4" />
                    New Page
                </Button>
            </div>

            <div
                v-if="pages.length === 0"
                class="text-muted-foreground py-12 text-center"
            >
                <FileText class="mx-auto mb-3 h-12 w-12 opacity-50" />
                <p>No pages yet. Create your first page.</p>
            </div>

            <div v-else class="flex flex-col gap-1">
                <Link
                    v-for="page in pages"
                    :key="page.id"
                    :href="`/pages/${page.id}`"
                    class="hover:bg-accent flex items-center gap-3 rounded-lg px-3 py-2 transition-colors"
                >
                    <FileText class="text-muted-foreground h-4 w-4 shrink-0" />
                    <span class="flex-1 truncate">
                        {{ page.content || 'Untitled' }}
                    </span>
                    <span class="text-muted-foreground text-xs">
                        {{
                            new Date(page.updated_at).toLocaleDateString()
                        }}
                    </span>
                </Link>
            </div>
        </div>
    </AppLayout>
</template>
