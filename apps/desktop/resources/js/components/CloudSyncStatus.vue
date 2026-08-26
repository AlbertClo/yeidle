<script setup lang="ts">
import { CircleAlert, Cloud, CloudOff, RefreshCw } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    cloudSyncStatus as status,
    cloudSyncStatusUnavailable as statusUnavailable,
    loadCloudSyncStatus as loadStatus,
} from '@/stores/cloudSyncStatus';
import { loadKeyBindings } from '@/stores/keyBindings';
import { realtimeHealth, refreshRealtimeSync } from '@/sync/realtime';

interface CloudWorkspace {
    id: string;
    name: string;
}

const connecting = ref(false);
const connectError = ref<string | null>(null);
const cloudUrl = ref('http://localhost:8200');
const cloudToken = ref('');
const cloudWorkspaces = ref<CloudWorkspace[] | null>(null);
const selectedCloudWorkspace = ref('');
const newCloudWorkspaceName = ref('');
let statusTimer: ReturnType<typeof setInterval> | null = null;

const realtimeAppearance = computed(() => {
    switch (realtimeHealth.state) {
        case 'connected':
            return {
                label: 'Live',
                topLabel: 'Synced',
                detail: 'Realtime delivery is connected.',
                color: 'text-emerald-600 dark:text-emerald-400',
                icon: Cloud,
            };
        case 'connecting':
            return {
                label: 'Connecting…',
                topLabel: 'Connecting',
                detail: 'Remote changes will resume when realtime connects.',
                color: 'text-amber-600 dark:text-amber-400',
                icon: RefreshCw,
            };
        case 'error':
        case 'failed':
            return {
                label: 'Error',
                topLabel: 'Sync error',
                detail: 'Remote changes cannot sync until realtime reconnects.',
                color: 'text-destructive',
                icon: CircleAlert,
            };
        case 'unavailable':
        case 'disconnected':
            return {
                label: 'Offline',
                topLabel: 'Realtime offline',
                detail: 'Remote changes will sync after realtime reconnects.',
                color: 'text-amber-600 dark:text-amber-400',
                icon: CloudOff,
            };
        default:
            return {
                label: 'Disabled',
                topLabel: 'Realtime disabled',
                detail: 'Realtime delivery is not configured.',
                color: 'text-muted-foreground',
                icon: CloudOff,
            };
    }
});

const triggerOnline = computed(
    () =>
        !statusUnavailable.value &&
        status.value?.configured === true &&
        status.value.health === 'healthy' &&
        realtimeHealth.state === 'connected',
);

const triggerLabel = computed(() =>
    triggerOnline.value ? 'Online' : 'Offline',
);

const appearance = computed(() => {
    if (statusUnavailable.value) {
        return {
            label: 'Status unavailable',
            detail: 'Could not read cloud sync status.',
            icon: CircleAlert,
            color: 'text-destructive',
        };
    }

    if (status.value === null) {
        return {
            label: 'Checking sync',
            detail: 'Reading cloud sync status…',
            icon: RefreshCw,
            color: 'text-muted-foreground',
        };
    }

    if (status.value.health === 'error') {
        return {
            label: 'Sync error',
            detail: 'The last cloud sync attempt failed.',
            icon: CircleAlert,
            color: 'text-destructive',
        };
    }

    if (status.value.health === 'seeding') {
        return {
            label: 'Preparing cloud',
            detail: 'Uploading the existing local database…',
            icon: RefreshCw,
            color: 'text-amber-600 dark:text-amber-400',
        };
    }

    if (status.value.health === 'unconfigured') {
        return {
            label: 'Not connected',
            detail: 'Cloud sync is not configured.',
            icon: CloudOff,
            color: 'text-muted-foreground',
        };
    }

    if (status.value.health === 'never_synced') {
        return {
            label: 'Not synced yet',
            detail: 'Waiting for the first successful cloud sync.',
            icon: Cloud,
            color: 'text-amber-600 dark:text-amber-400',
        };
    }

    if (status.value.pending_blob_uploads > 0) {
        return {
            label: `${status.value.pending_blob_uploads} media pending`,
            detail: 'Local attachments are waiting to reach cloud storage.',
            icon: Cloud,
            color: 'text-amber-600 dark:text-amber-400',
        };
    }

    if (status.value.outbox > 0) {
        return {
            label: `${status.value.outbox} pending`,
            detail: 'Local changes are waiting to reach the cloud.',
            icon: Cloud,
            color: 'text-amber-600 dark:text-amber-400',
        };
    }

    if (status.value.configured && realtimeHealth.state !== 'connected') {
        return {
            label: realtimeAppearance.value.topLabel,
            detail: realtimeAppearance.value.detail,
            icon: realtimeAppearance.value.icon,
            color: realtimeAppearance.value.color,
        };
    }

    return {
        label: 'Synced',
        detail: 'Cloud sync is healthy.',
        icon: Cloud,
        color: 'text-emerald-600 dark:text-emerald-400',
    };
});

function formatTimestamp(value: string | null | undefined): string {
    if (!value) {
        return 'Never';
    }

    const timestamp = new Date(value);

    if (Number.isNaN(timestamp.getTime())) {
        return value;
    }

    return timestamp.toLocaleString();
}

async function connectCloud(): Promise<void> {
    if (
        connecting.value ||
        !cloudUrl.value.trim() ||
        !cloudToken.value ||
        cloudWorkspaces.value === null ||
        !selectedCloudWorkspace.value ||
        (selectedCloudWorkspace.value === '__new__' &&
            !newCloudWorkspaceName.value.trim())
    ) {
        return;
    }

    connecting.value = true;
    connectError.value = null;

    try {
        const response = await fetch('/api/cloud/connect', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                url: cloudUrl.value.trim(),
                token: cloudToken.value,
                workspace_id:
                    selectedCloudWorkspace.value === '__new__'
                        ? null
                        : selectedCloudWorkspace.value,
                new_workspace_name:
                    selectedCloudWorkspace.value === '__new__'
                        ? newCloudWorkspaceName.value.trim()
                        : null,
            }),
        });
        const result = (await response.json().catch(() => null)) as {
            message?: string;
            error?: string | null;
        } | null;

        if (!response.ok) {
            throw new Error(
                result?.message || `Connection failed (${response.status}).`,
            );
        }

        cloudToken.value = '';

        if (result?.error) {
            connectError.value = result.error;
        }

        await refreshRealtimeSync();
        await loadKeyBindings(true);
    } catch (error) {
        connectError.value =
            error instanceof Error
                ? error.message
                : 'Could not connect to the cloud.';
    } finally {
        connecting.value = false;
        await loadStatus();
    }
}

async function loadCloudWorkspaces(): Promise<void> {
    if (connecting.value || !cloudUrl.value.trim() || !cloudToken.value) {
        return;
    }

    connecting.value = true;
    connectError.value = null;

    try {
        const [cloudResponse, localResponse] = await Promise.all([
            fetch('/api/cloud/workspaces', {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    url: cloudUrl.value.trim(),
                    token: cloudToken.value,
                }),
            }),
            fetch('/api/workspaces', {
                headers: { Accept: 'application/json' },
            }),
        ]);
        const cloudPayload = (await cloudResponse.json().catch(() => null)) as {
            workspaces?: CloudWorkspace[];
            message?: string;
        } | null;

        if (!cloudResponse.ok || !Array.isArray(cloudPayload?.workspaces)) {
            throw new Error(
                cloudPayload?.message ?? 'Could not load cloud workspaces.',
            );
        }

        cloudWorkspaces.value = cloudPayload.workspaces;
        selectedCloudWorkspace.value = '';

        if (localResponse.ok) {
            const localState = (await localResponse.json()) as {
                active_workspace_id: string;
                workspaces: CloudWorkspace[];
            };
            newCloudWorkspaceName.value =
                localState.workspaces.find(
                    (workspace) =>
                        workspace.id === localState.active_workspace_id,
                )?.name ?? '';
        }
    } catch (error) {
        connectError.value =
            error instanceof Error
                ? error.message
                : 'Could not load cloud workspaces.';
    } finally {
        connecting.value = false;
    }
}

watch([cloudUrl, cloudToken], () => {
    cloudWorkspaces.value = null;
    selectedCloudWorkspace.value = '';
});

onMounted(() => {
    loadStatus();
    statusTimer = setInterval(loadStatus, 5000);
});

onBeforeUnmount(() => {
    if (statusTimer !== null) {
        clearInterval(statusTimer);
        statusTimer = null;
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
                    :aria-label="`Cloud sync: ${triggerLabel}`"
                    :title="triggerLabel"
                >
                    <Cloud
                        class="size-4"
                        :class="
                            triggerOnline
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-muted-foreground'
                        "
                    />
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" class="w-80">
                <DropdownMenuLabel class="flex items-start gap-3 py-2">
                    <component
                        :is="appearance.icon"
                        class="mt-0.5 size-4"
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

                <DropdownMenuSeparator />

                <form
                    v-if="status && !status.configured"
                    class="space-y-3 px-2 py-2"
                    @submit.prevent="connectCloud"
                >
                    <div class="space-y-1.5">
                        <Label for="cloud-url">Cloud URL</Label>
                        <Input
                            id="cloud-url"
                            v-model="cloudUrl"
                            type="url"
                            inputmode="url"
                            autocapitalize="none"
                            autocomplete="url"
                            spellcheck="false"
                            placeholder="http://localhost:8200"
                            :disabled="connecting"
                        />
                    </div>
                    <div class="space-y-1.5">
                        <Label for="cloud-token">Sanctum token</Label>
                        <Input
                            id="cloud-token"
                            v-model="cloudToken"
                            type="password"
                            autocomplete="off"
                            placeholder="Paste token"
                            :disabled="connecting"
                        />
                    </div>
                    <div v-if="cloudWorkspaces !== null" class="space-y-1.5">
                        <Label for="cloud-workspace">Cloud workspace</Label>
                        <select
                            id="cloud-workspace"
                            v-model="selectedCloudWorkspace"
                            class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="connecting"
                        >
                            <option disabled value="">
                                Choose a workspace
                            </option>
                            <option
                                v-for="workspace in cloudWorkspaces"
                                :key="workspace.id"
                                :value="workspace.id"
                            >
                                {{ workspace.name }}
                            </option>
                            <option value="__new__">
                                Create a new workspace…
                            </option>
                        </select>
                    </div>
                    <div
                        v-if="selectedCloudWorkspace === '__new__'"
                        class="space-y-1.5"
                    >
                        <Label for="new-cloud-workspace-name"
                            >New workspace name</Label
                        >
                        <Input
                            id="new-cloud-workspace-name"
                            v-model="newCloudWorkspaceName"
                            maxlength="100"
                            placeholder="Albert Knowledge"
                            :disabled="connecting"
                        />
                    </div>
                    <div
                        v-if="connectError"
                        class="rounded-md bg-destructive/10 p-2 text-xs leading-relaxed break-words text-destructive"
                        role="alert"
                    >
                        {{ connectError }}
                    </div>
                    <Button
                        v-if="cloudWorkspaces === null"
                        type="button"
                        size="sm"
                        class="w-full"
                        :disabled="
                            connecting || !cloudUrl.trim() || !cloudToken
                        "
                        @click="loadCloudWorkspaces"
                    >
                        <RefreshCw v-if="connecting" class="animate-spin" />
                        {{ connecting ? 'Loading…' : 'Choose workspace' }}
                    </Button>
                    <Button
                        v-else
                        type="submit"
                        size="sm"
                        class="w-full"
                        :disabled="
                            connecting ||
                            !selectedCloudWorkspace ||
                            (selectedCloudWorkspace === '__new__' &&
                                !newCloudWorkspaceName.trim())
                        "
                    >
                        <RefreshCw v-if="connecting" class="animate-spin" />
                        {{ connecting ? 'Connecting and seeding…' : 'Connect' }}
                    </Button>
                    <p class="text-xs leading-relaxed text-muted-foreground">
                        First connection uploads existing local data when the
                        cloud workspace is empty.
                    </p>
                </form>

                <DropdownMenuSeparator v-if="status && !status.configured" />

                <div v-if="status" class="space-y-2 px-2 py-2 text-xs">
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
                        <span class="text-muted-foreground">Cloud cursor</span>
                        <span class="ml-auto tabular-nums">{{
                            status.last_server_seq
                        }}</span>
                    </div>
                    <div class="flex gap-3">
                        <span class="text-muted-foreground">Local log</span>
                        <span class="ml-auto tabular-nums">{{
                            status.local_log_seq
                        }}</span>
                    </div>
                    <div v-if="status.configured" class="flex gap-3">
                        <span class="text-muted-foreground">Realtime</span>
                        <span
                            class="ml-auto text-right"
                            :class="realtimeAppearance.color"
                        >
                            {{ realtimeAppearance.label }}
                        </span>
                    </div>
                    <div class="flex gap-3">
                        <span class="text-muted-foreground">Last success</span>
                        <span class="ml-auto text-right">
                            {{ formatTimestamp(status.last_sync_success_at) }}
                        </span>
                    </div>
                    <div v-if="status.health === 'error'" class="flex gap-3">
                        <span class="text-muted-foreground">Last attempt</span>
                        <span class="ml-auto text-right">
                            {{ formatTimestamp(status.last_sync_attempt_at) }}
                        </span>
                    </div>
                    <div
                        v-if="status.last_sync_error"
                        class="rounded-md bg-destructive/10 p-2 leading-relaxed text-destructive"
                    >
                        {{ status.last_sync_error }}
                    </div>
                    <div
                        v-if="status.configured && realtimeHealth.error"
                        class="rounded-md bg-amber-500/10 p-2 leading-relaxed text-amber-700 dark:text-amber-300"
                    >
                        {{ realtimeHealth.error }}
                    </div>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    </div>
</template>
