<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import {
    Cloud,
    FileText,
    HardDrive,
    Palette,
    TriangleAlert,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import AppLayout from '@/layouts/AppLayout.vue';
import { bindingLabel } from '@/stores/keyBindings';
import { saveWorkspaceStoragePreference } from '@/stores/preferences';
import { workspaceState } from '@/stores/workspaces';
import { LOCAL_OPS_AVAILABLE_EVENT, opsAffectPageIndex } from '@/sync/localOps';
import type { LocalOpsAvailableEvent } from '@/sync/localOps';
import { createMaxWaitScheduler } from '@/sync/maxWaitScheduler';
import type { BreadcrumbItem } from '@/types';
import type { Node } from '@/types/node';
import { openThemeSelector, THEME_SELECTED_EVENT } from '@/ui/themeSelector';
import {
    openWorkspaceSync,
    WORKSPACE_SYNC_ENABLED_EVENT,
} from '@/ui/workspaceSync';

const props = defineProps<{
    pages: Node[];
    themeSetupRequired: boolean;
    storageSetupRequired: boolean;
    workspaceCloudStatus: 'local' | 'available' | 'syncing' | 'ready' | 'error';
    missingPage?: boolean;
    databaseRecovered?: boolean;
}>();

const themeSetupRequired = ref(props.themeSetupRequired);
const storageSetupRequired = ref(props.storageSetupRequired);
const storageSaving = ref(false);
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
    window.addEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleLocalOpsAvailable);
    window.addEventListener(THEME_SELECTED_EVENT, handleThemeSelected);
    window.addEventListener(
        WORKSPACE_SYNC_ENABLED_EVENT,
        handleWorkspaceSyncEnabled,
    );
});

onBeforeUnmount(() => {
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
});

function modifiedDate(page: Node): string {
    const millis = Number.parseInt(page.modified_hlc.slice(0, 15), 10);
    const date = Number.isFinite(millis)
        ? new Date(millis)
        : new Date(page.updated_at);

    return date.toLocaleDateString();
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
                class="flex w-full cursor-pointer items-center gap-4 rounded-lg border border-border p-5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
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
                    class="flex cursor-pointer items-center gap-3 border-b p-5 text-left transition-colors hover:bg-accent hover:text-accent-foreground sm:border-r sm:border-b-0"
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
                    class="flex cursor-pointer items-center gap-3 p-5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
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

                <div v-else class="flex flex-col gap-1">
                    <Link
                        v-for="page in pages"
                        :key="page.id"
                        :href="`/pages/${page.id}`"
                        class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent"
                    >
                        <FileText
                            class="h-4 w-4 shrink-0 text-muted-foreground"
                        />
                        <span class="flex-1 truncate">
                            {{ page.content || '[untitled]' }}
                        </span>
                        <span class="text-xs text-muted-foreground">
                            {{ modifiedDate(page) }}
                        </span>
                    </Link>
                </div>
            </template>
        </div>
    </AppLayout>
</template>
