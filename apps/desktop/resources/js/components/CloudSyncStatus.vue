<script setup lang="ts">
import {
    CircleAlert,
    Cloud,
    CloudOff,
    CloudUpload,
    RefreshCw,
    UserRound,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    cloudAccount,
    enableWorkspaceCloudSync,
    loadCloudAccount,
} from '@/stores/cloudAccount';
import {
    cloudSyncStatus as status,
    cloudSyncStatusUnavailable as statusUnavailable,
    loadCloudSyncStatus as loadStatus,
} from '@/stores/cloudSyncStatus';
import { workspaceState } from '@/stores/workspaces';
import { requestCloudExchange } from '@/sync/cloud';
import { realtimeHealth, refreshRealtimeSync } from '@/sync/realtime';
import { openCloudAccount } from '@/ui/cloudAccount';
import {
    notifyWorkspaceSyncEnabled,
    OPEN_WORKSPACE_SYNC_EVENT,
} from '@/ui/workspaceSync';

let statusTimer: ReturnType<typeof setInterval> | null = null;
const confirmSyncOpen = ref(false);
const syncing = ref(false);
const syncAfterSignIn = ref(false);
const syncError = ref<string | null>(null);

const activeWorkspace = computed(
    () =>
        workspaceState.value?.workspaces.find(
            (workspace) =>
                workspace.id === workspaceState.value?.active_workspace_id,
        ) ?? null,
);

const localWorkspace = computed(
    () => activeWorkspace.value?.cloud_status === 'local',
);

const online = computed(
    () =>
        cloudAccount.value?.signed_in === true &&
        !statusUnavailable.value &&
        status.value?.configured === true &&
        status.value.health === 'healthy' &&
        realtimeHealth.state === 'connected',
);

const appearance = computed(() => {
    if (localWorkspace.value) {
        return {
            label: 'Local workspace',
            detail: 'This workspace is stored only on this device.',
            icon: CloudOff,
            color: 'text-muted-foreground',
        };
    }

    if (!cloudAccount.value?.signed_in && activeWorkspace.value !== null) {
        return {
            label: 'Signed out',
            detail: 'Sign in again to resume cloud sync for this workspace.',
            icon: Cloud,
            color: 'text-muted-foreground',
        };
    }

    if (statusUnavailable.value) {
        return {
            label: 'Status unavailable',
            detail: 'Could not read this workspace’s sync status.',
            icon: CircleAlert,
            color: 'text-destructive',
        };
    }

    if (status.value === null) {
        return {
            label: 'Checking sync',
            detail: 'Reading this workspace’s sync status.',
            icon: RefreshCw,
            color: 'text-muted-foreground',
        };
    }

    if (status.value.health === 'error') {
        return {
            label: 'Sync error',
            detail:
                status.value.last_sync_error ??
                'Cloud sync is currently unavailable.',
            icon: CircleAlert,
            color: 'text-destructive',
        };
    }

    if (status.value.health === 'seeding') {
        return {
            label: 'Preparing cloud workspace',
            detail: 'Uploading the existing local workspace.',
            icon: RefreshCw,
            color: 'text-muted-foreground',
        };
    }

    if (!online.value) {
        return {
            label: 'Offline',
            detail: 'Changes will sync after the realtime connection returns.',
            icon: Cloud,
            color: 'text-muted-foreground',
        };
    }

    return {
        label: 'Synced',
        detail: 'Cloud sync is healthy.',
        icon: Cloud,
        color: 'text-[var(--link)]',
    };
});

function formatTimestamp(value: string | null | undefined): string {
    if (!value) {
        return 'Never';
    }

    const timestamp = new Date(value);

    return Number.isNaN(timestamp.getTime())
        ? value
        : timestamp.toLocaleString();
}

async function syncCurrentWorkspace(): Promise<void> {
    const workspaceId = workspaceState.value?.active_workspace_id;

    if (syncing.value || !workspaceId) {
        return;
    }

    syncing.value = true;
    syncError.value = null;

    try {
        await enableWorkspaceCloudSync(workspaceId);
        await Promise.all([refreshRealtimeSync(), loadStatus()]);
        await requestCloudExchange();
        notifyWorkspaceSyncEnabled(workspaceId);
        confirmSyncOpen.value = false;
        toast.success('Workspace sync enabled.');
    } catch (reason) {
        syncError.value =
            reason instanceof Error
                ? reason.message
                : 'Could not enable workspace sync.';
        toast.error(syncError.value);
    } finally {
        syncing.value = false;
    }
}

async function requestSyncConfirmation(): Promise<void> {
    if (syncing.value) {
        return;
    }

    const account = await loadCloudAccount().catch(() => null);

    if (!account?.signed_in) {
        syncAfterSignIn.value = true;
        openCloudAccount();

        return;
    }

    syncError.value = null;
    confirmSyncOpen.value = true;
}

function handleOpenSyncConfirmation(): void {
    void requestSyncConfirmation();
}

function focusOtherSyncAction(event: KeyboardEvent): void {
    const current = event.currentTarget;

    if (!(current instanceof HTMLButtonElement)) {
        return;
    }

    const actions = current.parentElement?.querySelectorAll<HTMLButtonElement>(
        ':scope > button:not(:disabled)',
    );

    Array.from(actions ?? [])
        .find((action) => action !== current)
        ?.focus();
}

watch(
    () => cloudAccount.value?.signed_in,
    (signedIn) => {
        if (!signedIn || !syncAfterSignIn.value) {
            return;
        }

        syncAfterSignIn.value = false;
        syncError.value = null;
        confirmSyncOpen.value = true;
    },
);

onMounted(() => {
    window.addEventListener(
        OPEN_WORKSPACE_SYNC_EVENT,
        handleOpenSyncConfirmation,
    );
    void loadCloudAccount().catch(() => undefined);
    void loadStatus();
    statusTimer = setInterval(() => void loadStatus(), 5000);
});

onBeforeUnmount(() => {
    window.removeEventListener(
        OPEN_WORKSPACE_SYNC_EVENT,
        handleOpenSyncConfirmation,
    );

    if (statusTimer !== null) {
        clearInterval(statusTimer);
    }
});
</script>

<template>
    <div class="size-9 shrink-0">
        <DropdownMenu>
            <DropdownMenuTrigger as-child>
                <Button
                    variant="ghost"
                    size="icon"
                    :aria-label="`Cloud sync: ${appearance.label}`"
                    :title="appearance.label"
                >
                    <component
                        :is="localWorkspace ? CloudOff : Cloud"
                        class="size-4"
                        :class="
                            online
                                ? 'text-[var(--link)]'
                                : 'text-muted-foreground'
                        "
                    />
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" class="w-80">
                <DropdownMenuLabel class="flex items-start gap-3 py-2">
                    <component
                        :is="appearance.icon"
                        class="mt-0.5 size-4 shrink-0"
                        :class="appearance.color"
                    />
                    <span class="min-w-0">
                        <span class="block font-medium">{{
                            appearance.label
                        }}</span>
                        <span
                            class="block text-xs font-normal text-muted-foreground"
                        >
                            {{ appearance.detail }}
                        </span>
                    </span>
                </DropdownMenuLabel>

                <DropdownMenuSeparator
                    v-if="!localWorkspace && status?.configured"
                />

                <div
                    v-if="!localWorkspace && status?.configured"
                    class="space-y-2 px-2 py-2 text-xs"
                >
                    <div v-if="status.cloud_url" class="flex gap-3">
                        <span class="shrink-0 text-muted-foreground"
                            >Cloud</span
                        >
                        <span
                            class="ml-auto truncate text-right"
                            :title="status.cloud_url"
                        >
                            {{ status.cloud_url }}
                        </span>
                    </div>
                    <div class="flex gap-3">
                        <span class="text-muted-foreground"
                            >Pending changes</span
                        >
                        <span class="ml-auto">{{ status.outbox }}</span>
                    </div>
                    <div class="flex gap-3">
                        <span class="text-muted-foreground">Pending media</span>
                        <span class="ml-auto">{{
                            status.pending_blob_uploads
                        }}</span>
                    </div>
                    <div class="flex gap-3">
                        <span class="text-muted-foreground">Last success</span>
                        <span class="ml-auto text-right">
                            {{ formatTimestamp(status.last_sync_success_at) }}
                        </span>
                    </div>
                    <div
                        v-if="status.last_sync_error"
                        class="rounded-md bg-destructive/10 p-2 leading-relaxed text-destructive"
                    >
                        {{ status.last_sync_error }}
                    </div>
                </div>

                <DropdownMenuSeparator v-if="localWorkspace" />
                <DropdownMenuItem
                    v-if="localWorkspace"
                    @select="requestSyncConfirmation"
                >
                    <CloudUpload />
                    Sync this workspace
                </DropdownMenuItem>

                <DropdownMenuSeparator
                    v-if="activeWorkspace && !localWorkspace"
                />
                <DropdownMenuItem
                    v-if="activeWorkspace && !localWorkspace"
                    @select="openCloudAccount"
                >
                    <UserRound />
                    {{
                        cloudAccount?.signed_in
                            ? (cloudAccount.user?.name ?? 'Yeidle account')
                            : 'Sign in'
                    }}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>

        <Dialog v-model:open="confirmSyncOpen">
            <DialogContent class="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        Sync {{ activeWorkspace?.name ?? 'this workspace' }}?
                    </DialogTitle>
                    <DialogDescription>
                        This workspace will be permanently associated with the
                        signed-in Yeidle Cloud account
                        <span class="font-medium text-foreground">
                            {{ cloudAccount?.user?.email }}</span
                        >. This cannot be changed later.
                    </DialogDescription>
                </DialogHeader>

                <p
                    v-if="syncError"
                    class="text-sm text-destructive"
                    role="alert"
                >
                    {{ syncError }}
                </p>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        :disabled="syncing"
                        @click="confirmSyncOpen = false"
                        @keydown.left.prevent="focusOtherSyncAction"
                        @keydown.right.prevent="focusOtherSyncAction"
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        :disabled="syncing"
                        @click="syncCurrentWorkspace"
                        @keydown.left.prevent="focusOtherSyncAction"
                        @keydown.right.prevent="focusOtherSyncAction"
                    >
                        <RefreshCw v-if="syncing" class="animate-spin" />
                        {{ syncing ? 'Syncing…' : 'Sync workspace' }}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </div>
</template>
