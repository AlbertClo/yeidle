<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import { FileText, History, List } from 'lucide-vue-next';
import { computed, nextTick, onMounted, ref } from 'vue';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import AppLayout from '@/layouts/AppLayout.vue';
import {
    clearNavigationHistory,
    flushNavigationHistory,
    navigateToHistoryLocation,
} from '@/navigation/historyNavigation';
import { navigationHistoryRows } from '@/navigation/historyPresentation';
import type { BreadcrumbItem } from '@/types';

type HistoryLocation = {
    id: string;
    parent_id: string | null;
    url: string;
    page_id: string | null;
    block_id: string | null;
    cursor_offset: number | null;
    scroll_top: number;
    visited_at: string;
    last_visited_at: string;
    page_title: string | null;
    node_text: string | null;
};

type HistoryPayload = {
    locations: HistoryLocation[];
    current_id: string | null;
};

const breadcrumbs: BreadcrumbItem[] = [
    { title: 'All Pages', href: '/pages' },
    { title: 'Navigation History', href: '/navigation-history' },
];
const history = ref<HistoryPayload>({ locations: [], current_id: null });
const loading = ref(true);
const error = ref<string | null>(null);
const historyListRef = ref<HTMLElement>();
const selectedLocationId = ref<string | null>(null);
const showClearConfirmation = ref(false);
const clearing = ref(false);

const rows = computed(() =>
    navigationHistoryRows(history.value.locations, history.value.current_id),
);

function locationTitle(location: HistoryLocation): string {
    if (location.page_title?.trim()) {
        return location.page_title;
    }

    if (location.url === '/pages') {
        return 'All Pages';
    }

    if (location.url === '/navigation-history') {
        return 'Navigation History';
    }

    return location.url;
}

function visitedAt(location: HistoryLocation): string {
    return new Date(location.last_visited_at).toLocaleString();
}

function nodePreview(location: HistoryLocation): string | null {
    const text = location.node_text?.replace(/\s+/g, ' ').trim();

    if (!text) {
        return null;
    }

    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

async function openLocation(location: HistoryLocation): Promise<void> {
    if (isOpenLocation(location)) {
        return;
    }

    await navigateToHistoryLocation(location.id);
}

async function focusHistoryRow(index: number): Promise<void> {
    if (rows.value.length === 0) {
        return;
    }

    const boundedIndex = Math.max(0, Math.min(index, rows.value.length - 1));
    selectedLocationId.value = rows.value[boundedIndex].id;
    await nextTick();
    historyListRef.value
        ?.querySelectorAll<HTMLButtonElement>('[data-history-row]')
        [boundedIndex]?.focus();
}

function moveHistoryFocus(locationId: string, offset: number): void {
    const index = rows.value.findIndex(
        (location) => location.id === locationId,
    );

    if (index !== -1) {
        void focusHistoryRow(index + offset);
    }
}

function isOpenLocation(location: HistoryLocation): boolean {
    if (
        location.id !== history.value.current_id ||
        typeof window === 'undefined'
    ) {
        return false;
    }

    return (
        `${window.location.pathname}${window.location.search}` === location.url
    );
}

async function clearHistory(): Promise<void> {
    clearing.value = true;
    error.value = null;

    try {
        await clearNavigationHistory();
        history.value = { locations: [], current_id: null };
        selectedLocationId.value = null;
        showClearConfirmation.value = false;
    } catch (reason) {
        error.value =
            reason instanceof Error
                ? reason.message
                : 'Could not clear navigation history.';
    } finally {
        clearing.value = false;
    }
}

async function loadHistory(): Promise<void> {
    loading.value = true;
    error.value = null;

    try {
        await flushNavigationHistory();
        const response = await fetch('/api/navigation-history', {
            headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
            throw new Error('Could not load navigation history.');
        }

        history.value = (await response.json()) as HistoryPayload;
    } catch (reason) {
        error.value =
            reason instanceof Error
                ? reason.message
                : 'Could not load navigation history.';
    } finally {
        loading.value = false;
    }

    if (!error.value && rows.value.length > 0) {
        await focusHistoryRow(0);
    }
}

onMounted(() => void loadHistory());
</script>

<template>
    <Head title="Navigation History" />

    <AppLayout :breadcrumbs="breadcrumbs">
        <div class="mx-auto w-full max-w-4xl p-6">
            <div class="mb-6 flex items-start justify-between gap-4">
                <div>
                    <h1 class="text-3xl font-bold">Navigation History</h1>
                    <p class="mt-2 text-sm text-muted-foreground">
                        Locations reachable with Back and Forward in this
                        workspace.
                    </p>
                </div>
                <Button
                    v-if="history.locations.length > 0"
                    variant="outline"
                    @click="showClearConfirmation = true"
                >
                    Clear history
                </Button>
            </div>

            <div
                v-if="loading"
                class="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground"
            >
                Loading history…
            </div>
            <div
                v-else-if="error"
                class="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
                {{ error }}
            </div>
            <div
                v-else-if="rows.length === 0"
                class="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground"
            >
                No navigation history yet.
            </div>
            <div
                v-else
                ref="historyListRef"
                class="overflow-hidden rounded-md border"
            >
                <button
                    v-for="(location, index) in rows"
                    :key="location.id"
                    type="button"
                    data-history-row
                    class="flex w-full cursor-pointer items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-accent disabled:cursor-default"
                    :class="{
                        'bg-accent': location.id === selectedLocationId,
                        'bg-accent/60':
                            location.id === history.current_id &&
                            location.id !== selectedLocationId,
                    }"
                    :disabled="isOpenLocation(location)"
                    :tabindex="
                        location.id === selectedLocationId ||
                        (selectedLocationId === null && index === 0)
                            ? 0
                            : -1
                    "
                    @focus="selectedLocationId = location.id"
                    @click="openLocation(location)"
                    @keydown.down.prevent="moveHistoryFocus(location.id, 1)"
                    @keydown.up.prevent="moveHistoryFocus(location.id, -1)"
                    @keydown.home.prevent="focusHistoryRow(0)"
                    @keydown.end.prevent="focusHistoryRow(rows.length - 1)"
                >
                    <span
                        class="flex min-w-0 flex-1 items-center gap-3"
                        :style="{ paddingLeft: `${location.depth * 1.5}rem` }"
                    >
                        <History
                            v-if="location.url === '/navigation-history'"
                            class="h-4 w-4 shrink-0 text-muted-foreground"
                        />
                        <List
                            v-else-if="location.url === '/pages'"
                            class="h-4 w-4 shrink-0 text-muted-foreground"
                        />
                        <FileText
                            v-else
                            class="h-4 w-4 shrink-0 text-muted-foreground"
                        />
                        <span class="min-w-0">
                            <span class="flex items-center gap-2">
                                <span class="truncate font-medium">
                                    {{ locationTitle(location) }}
                                </span>
                                <span
                                    v-if="location.id === history.current_id"
                                    class="rounded bg-secondary px-1.5 py-0.5 text-[0.65rem] font-medium text-secondary-foreground"
                                >
                                    Current
                                </span>
                            </span>
                            <span
                                v-if="nodePreview(location)"
                                class="block truncate text-xs text-muted-foreground"
                                :title="location.node_text ?? undefined"
                            >
                                {{ nodePreview(location) }}
                            </span>
                        </span>
                    </span>
                    <span
                        class="shrink-0 text-xs text-muted-foreground tabular-nums"
                    >
                        {{ visitedAt(location) }}
                    </span>
                </button>
            </div>
        </div>
    </AppLayout>

    <Dialog v-model:open="showClearConfirmation">
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Clear navigation history?</DialogTitle>
                <DialogDescription>
                    This removes all Back and Forward locations saved for this
                    workspace. This cannot be undone.
                </DialogDescription>
            </DialogHeader>
            <DialogFooter>
                <Button
                    variant="outline"
                    :disabled="clearing"
                    @click="showClearConfirmation = false"
                >
                    Cancel
                </Button>
                <Button
                    variant="destructive"
                    :disabled="clearing"
                    @click="clearHistory"
                >
                    {{ clearing ? 'Clearing…' : 'Clear history' }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
