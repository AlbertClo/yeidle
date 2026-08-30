<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import {
    Cloud,
    FileText,
    HardDrive,
    Palette,
    TriangleAlert,
} from 'lucide-vue-next';
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
} from 'vue';
import { toast } from 'vue-sonner';
import { openDailyNote as openTodayDailyNote } from '@/dailyNotes';
import AppLayout from '@/layouts/AppLayout.vue';
import {
    isHistoryNavigation,
    preparePageIndexNavigation,
    recalledPageIndexSelection,
    rememberPageIndexSelection,
    restoreNavigationScrollPosition,
} from '@/navigation/historyNavigation';
import { hasSavedMainScrollPosition } from '@/navigation/scrollRestoration';
import { bindingLabel } from '@/stores/keyBindings';
import { saveWorkspaceStoragePreference } from '@/stores/preferences';
import { workspaceState } from '@/stores/workspaces';
import { LOCAL_OPS_AVAILABLE_EVENT, opsAffectPageIndex } from '@/sync/localOps';
import type { LocalOpsAvailableEvent } from '@/sync/localOps';
import { createMaxWaitScheduler } from '@/sync/maxWaitScheduler';
import type { BreadcrumbItem } from '@/types';
import type { PageListItem } from '@/types/node';
import { hasOpenModal } from '@/ui/modal';
import { openThemeSelector, THEME_SELECTED_EVENT } from '@/ui/themeSelector';
import {
    openWorkspaceSync,
    WORKSPACE_SYNC_ENABLED_EVENT,
} from '@/ui/workspaceSync';

const props = defineProps<{
    pages: PageListItem[];
    themeSetupRequired: boolean;
    storageSetupRequired: boolean;
    workspaceCloudStatus: 'local' | 'available' | 'syncing' | 'ready' | 'error';
    missingPage?: boolean;
    databaseRecovered?: boolean;
    openDailyNote?: boolean;
}>();

const INITIAL_PAGE_COUNT = 40;
const restoringPageIndexPosition =
    isHistoryNavigation() || hasSavedMainScrollPosition();
const restoredPageId = isHistoryNavigation()
    ? recalledPageIndexSelection()
    : null;
const restoredPageIndex = restoredPageId
    ? props.pages.findIndex((page) => page.id === restoredPageId)
    : -1;
const restoringSelectedPageLayout = ref(restoredPageIndex >= 0);
const renderedPageCount = ref(
    restoredPageIndex >= 0
        ? Math.max(INITIAL_PAGE_COUNT, restoredPageIndex + 1)
        : restoringPageIndexPosition
          ? props.pages.length
          : Math.min(INITIAL_PAGE_COUNT, props.pages.length),
);
const renderedPages = computed(() =>
    props.pages.slice(0, renderedPageCount.value),
);
const pageListRef = ref<HTMLElement>();
let rovingPageElement: HTMLAnchorElement | null = null;
let pageHydrationFrame: number | null = null;
let pageHydrationPaintFrame: number | null = null;

function schedulePageHydration(): void {
    if (
        renderedPageCount.value >= props.pages.length ||
        restoringSelectedPageLayout.value ||
        pageHydrationFrame !== null ||
        pageHydrationPaintFrame !== null
    ) {
        return;
    }

    pageHydrationFrame = requestAnimationFrame(() => {
        pageHydrationPaintFrame = requestAnimationFrame(() => {
            pageHydrationFrame = null;
            pageHydrationPaintFrame = null;
            renderedPageCount.value = props.pages.length;
        });
    });
}

function pageRow(element: Element | null): HTMLAnchorElement | null {
    return element?.matches('[data-page-row]')
        ? (element as HTMLAnchorElement)
        : null;
}

function adoptPageFocus(element: HTMLAnchorElement): void {
    if (rovingPageElement !== element) {
        rovingPageElement?.setAttribute('tabindex', '-1');
        rovingPageElement = element;
    }

    element.setAttribute('tabindex', '0');
}

function focusPageElement(element: HTMLAnchorElement): void {
    adoptPageFocus(element);
    element.focus();
}

async function focusPageRow(index: number, reveal = true): Promise<void> {
    if (props.pages.length === 0) {
        return;
    }

    const boundedIndex = Math.max(0, Math.min(index, props.pages.length - 1));
    renderedPageCount.value = Math.max(
        renderedPageCount.value,
        boundedIndex + 1,
    );
    await nextTick();
    const element = pageRow(
        pageListRef.value?.children.item(boundedIndex) ?? null,
    );

    if (element) {
        adoptPageFocus(element);

        if (reveal) {
            element.focus();
        } else {
            element.focus({ preventScroll: true });
        }
    }
}

function restorePageRowFocus(index: number): void {
    void focusPageRow(index, false).then(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                void focusPageRow(index).then(() => {
                    requestAnimationFrame(() => {
                        restoringSelectedPageLayout.value = false;
                        schedulePageHydration();
                    });
                });
            });
        });
    });
}

function handlePageFocus(event: FocusEvent): void {
    const element = pageRow(event.currentTarget as Element);

    if (element) {
        adoptPageFocus(element);

        if (element.dataset.pageId) {
            rememberPageIndexSelection(element.dataset.pageId);
        }
    }
}

function movePageFocus(event: KeyboardEvent, offset: number): void {
    const current = pageRow(event.currentTarget as Element);

    if (!current) {
        return;
    }

    const adjacent = pageRow(
        offset < 0
            ? current.previousElementSibling
            : current.nextElementSibling,
    );

    if (adjacent) {
        focusPageElement(adjacent);

        return;
    }

    const currentIndex = Number(current.dataset.pageIndex);

    if (Number.isInteger(currentIndex)) {
        void focusPageRow(currentIndex + offset);
    }
}

function handleUnselectedPageListKeydown(event: KeyboardEvent): void {
    if (
        event.key !== 'ArrowDown' ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        setupRequired.value ||
        props.pages.length === 0 ||
        hasOpenModal() ||
        document.querySelector('[role="menu"]') !== null ||
        pageRow(document.activeElement) !== null
    ) {
        return;
    }

    const target = event.target;

    if (
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable)
    ) {
        return;
    }

    event.preventDefault();
    void focusPageRow(0);
}

const themeSetupRequired = ref(props.themeSetupRequired);
const storageSetupRequired = ref(props.storageSetupRequired);
const storageSaving = ref(false);
const openingDailyNote = ref(false);
const setupRequired = computed(
    () => themeSetupRequired.value || storageSetupRequired.value,
);
const activeWorkspace = computed(() =>
    workspaceState.value?.workspaces.find(
        (workspace) =>
            workspace.id === workspaceState.value?.active_workspace_id,
    ),
);
const localWorkspace = computed(
    () =>
        (activeWorkspace.value?.cloud_status ?? props.workspaceCloudStatus) ===
        'local',
);
const breadcrumbs = computed<BreadcrumbItem[]>(() => [
    {
        title: setupRequired.value ? 'Set up your workspace' : 'All Pages',
        href: '/pages',
    },
]);
const reloadScheduler = createMaxWaitScheduler(
    () => {
        router.reload({ only: ['pages'] });
    },
    100,
    500,
);

function handleLocalOpsAvailable(event: Event): void {
    const detail = (event as LocalOpsAvailableEvent).detail;

    if (opsAffectPageIndex(detail?.ops ?? null)) {
        reloadScheduler.schedule();
    }
}

function handleThemeSelected(): void {
    themeSetupRequired.value = false;
}

watch(
    () => [props.themeSetupRequired, props.storageSetupRequired] as const,
    ([themeRequired, storageRequired]) => {
        themeSetupRequired.value = themeRequired;
        storageSetupRequired.value = storageRequired;
    },
);

watch(
    () => props.pages,
    (pages) => {
        renderedPageCount.value = Math.min(
            renderedPageCount.value,
            pages.length,
        );

        if (
            rovingPageElement !== null &&
            !pages.some((page) => page.id === rovingPageElement?.dataset.pageId)
        ) {
            rovingPageElement = null;
            void focusPageRow(0);
        }

        schedulePageHydration();
    },
);

watch(setupRequired, (required) => {
    if (required) {
        return;
    }

    renderedPageCount.value = Math.min(INITIAL_PAGE_COUNT, props.pages.length);
    schedulePageHydration();
    void focusPageRow(0);
    openDefaultDailyNote();
});

function openDefaultDailyNote(): void {
    if (!props.openDailyNote || setupRequired.value || openingDailyNote.value) {
        return;
    }

    openingDailyNote.value = true;
    void openTodayDailyNote().catch(() => {
        openingDailyNote.value = false;
        toast.error('Could not open today’s daily note.');
    });
}

async function saveStorageChoice(storage: 'local' | 'cloud'): Promise<void> {
    if (storageSaving.value) {
        return;
    }

    storageSaving.value = true;

    try {
        await saveWorkspaceStoragePreference(storage);
        storageSetupRequired.value = false;
    } catch {
        toast.error('Could not save the workspace storage choice.');
    } finally {
        storageSaving.value = false;
    }
}

function chooseCloudStorage(): void {
    if (localWorkspace.value) {
        openWorkspaceSync();

        return;
    }

    void saveStorageChoice('cloud');
}

function handleWorkspaceSyncEnabled(event: Event): void {
    const workspaceId = (event as CustomEvent<{ workspaceId?: string }>).detail
        ?.workspaceId;

    if (workspaceId !== activeWorkspace.value?.id) {
        return;
    }

    void saveStorageChoice('cloud');
}

onMounted(() => {
    document.addEventListener('keydown', handleUnselectedPageListKeydown);
    window.addEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleLocalOpsAvailable);
    window.addEventListener(THEME_SELECTED_EVENT, handleThemeSelected);
    window.addEventListener(
        WORKSPACE_SYNC_ENABLED_EVENT,
        handleWorkspaceSyncEnabled,
    );
    schedulePageHydration();
    restoreNavigationScrollPosition();
    openDefaultDailyNote();

    if (!setupRequired.value) {
        if (restoredPageId) {
            if (restoredPageIndex >= 0) {
                restorePageRowFocus(restoredPageIndex);

                return;
            }
        }

        restoringSelectedPageLayout.value = false;
        void focusPageRow(0, false);
    }
});

onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleUnselectedPageListKeydown);
    window.removeEventListener(
        LOCAL_OPS_AVAILABLE_EVENT,
        handleLocalOpsAvailable,
    );
    window.removeEventListener(THEME_SELECTED_EVENT, handleThemeSelected);
    window.removeEventListener(
        WORKSPACE_SYNC_ENABLED_EVENT,
        handleWorkspaceSyncEnabled,
    );
    reloadScheduler.cancel();

    if (pageHydrationFrame !== null) {
        cancelAnimationFrame(pageHydrationFrame);
    }

    if (pageHydrationPaintFrame !== null) {
        cancelAnimationFrame(pageHydrationPaintFrame);
    }
});

function createdDate(page: PageListItem): string {
    if (page.page_type === 'daily_note' && page.daily_note_date) {
        const [year, month, day] = page.daily_note_date
            .split('-')
            .map((part) => Number.parseInt(part, 10));

        return new Date(year, month - 1, day).toLocaleDateString();
    }

    const timestamp = page.created_at.includes('T')
        ? page.created_at
        : `${page.created_at.replace(' ', 'T')}Z`;

    return new Date(timestamp).toLocaleDateString();
}
</script>

<template>
    <Head :title="setupRequired ? 'Set up your workspace' : 'All Pages'" />

    <AppLayout :breadcrumbs="breadcrumbs">
        <div class="mx-auto w-full max-w-2xl p-6">
            <div class="mb-6">
                <h1 class="text-2xl font-bold">
                    {{ setupRequired ? 'Set up your workspace' : 'All Pages' }}
                </h1>
            </div>

            <div
                v-if="missingPage"
                class="mb-6 flex items-start gap-3 rounded-md border border-border bg-muted/50 p-4 text-sm"
                role="status"
            >
                <TriangleAlert
                    class="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div>
                    <p class="font-medium">That page is no longer available.</p>
                    <p class="mt-1 text-muted-foreground">
                        It may have been deleted or belonged to a different
                        workspace. You’re now viewing All Pages.
                    </p>
                </div>
            </div>

            <div
                v-else-if="databaseRecovered"
                class="mb-6 flex items-start gap-3 rounded-md border border-border bg-muted/50 p-4 text-sm"
                role="status"
            >
                <TriangleAlert
                    class="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div>
                    <p class="font-medium">
                        This workspace’s local database was missing.
                    </p>
                    <p class="mt-1 text-muted-foreground">
                        Yeidle created a new empty database so the workspace can
                        open. If it is synced with Yeidle Cloud, its data will
                        download again.
                    </p>
                </div>
            </div>

            <button
                v-if="themeSetupRequired"
                type="button"
                class="flex w-full cursor-pointer items-center gap-4 rounded-lg border border-border p-5 text-left hover:bg-accent hover:text-accent-foreground"
                @click="openThemeSelector"
            >
                <span
                    class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted"
                >
                    <Palette class="size-5" />
                </span>
                <span>
                    <span class="block font-medium">Select a theme</span>
                    <span class="mt-1 block text-sm text-muted-foreground">
                        Choose how Yeidle looks in this workspace.
                    </span>
                </span>
            </button>

            <div
                v-if="storageSetupRequired"
                class="mt-4 grid overflow-hidden rounded-lg border border-border sm:grid-cols-2"
            >
                <button
                    type="button"
                    class="flex cursor-pointer items-center gap-3 border-b p-5 text-left hover:bg-accent hover:text-accent-foreground sm:border-r sm:border-b-0"
                    :class="{
                        'bg-accent text-accent-foreground': !localWorkspace,
                    }"
                    :aria-pressed="!localWorkspace"
                    :disabled="storageSaving"
                    @click="chooseCloudStorage"
                >
                    <span
                        class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted"
                    >
                        <Cloud class="size-5" />
                    </span>
                    <span>
                        <span class="block font-medium">
                            Sync with Yeidle Cloud
                        </span>
                        <span class="mt-1 block text-sm text-muted-foreground">
                            Available on your devices
                        </span>
                    </span>
                </button>
                <button
                    type="button"
                    class="flex cursor-pointer items-center gap-3 p-5 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    :aria-pressed="localWorkspace"
                    :disabled="storageSaving || !localWorkspace"
                    @click="saveStorageChoice('local')"
                >
                    <span
                        class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted"
                    >
                        <HardDrive class="size-5" />
                    </span>
                    <span>
                        <span class="block font-medium">
                            Keep on this device
                        </span>
                        <span class="mt-1 block text-sm text-muted-foreground">
                            Stored locally only
                        </span>
                    </span>
                </button>
            </div>

            <template v-else>
                <div
                    v-if="pages.length === 0"
                    class="py-12 text-center text-muted-foreground"
                >
                    <FileText class="mx-auto mb-3 h-12 w-12 opacity-50" />
                    <p>
                        No pages yet. Use the search bar ({{
                            bindingLabel('find-page')
                        }}) to create one.
                    </p>
                </div>

                <div v-else ref="pageListRef" class="flex flex-col gap-1">
                    <Link
                        v-for="(page, index) in renderedPages"
                        :key="page.id"
                        :href="`/pages/${page.id}`"
                        data-page-row
                        :data-page-id="page.id"
                        :data-page-index="index"
                        :tabindex="index === 0 ? 0 : -1"
                        class="page-index-item flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent focus:bg-accent focus:outline-none"
                        :class="{
                            'page-index-item-restoring':
                                restoringSelectedPageLayout,
                        }"
                        @focus="handlePageFocus"
                        @click="preparePageIndexNavigation(page.id)"
                        @keydown.down.prevent="movePageFocus($event, 1)"
                        @keydown.up.prevent="movePageFocus($event, -1)"
                        @keydown.home.prevent="focusPageRow(0)"
                        @keydown.end.prevent="focusPageRow(pages.length - 1)"
                    >
                        <FileText
                            class="h-4 w-4 shrink-0 text-muted-foreground"
                        />
                        <span class="flex-1 truncate">
                            {{ page.content || '[untitled]' }}
                        </span>
                        <span class="text-xs text-muted-foreground">
                            {{ createdDate(page) }}
                        </span>
                    </Link>
                </div>
            </template>
        </div>
    </AppLayout>
</template>

<style scoped>
.page-index-item {
    content-visibility: auto;
    contain-intrinsic-block-size: auto 40px;
}

.page-index-item-restoring {
    content-visibility: visible;
}
</style>
