<script setup lang="ts">
import { CircleAlert, Cloud, CloudOff, RefreshCw } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { requestCloudExchange } from '@/sync/cloud';
import { realtimeHealth, refreshRealtimeSync } from '@/sync/realtime';

type SyncHealth =
    | 'unconfigured'
    | 'seeding'
    | 'never_synced'
    | 'healthy'
    | 'error';

interface CloudStatus {
    configured: boolean;
    health: SyncHealth;
    cloud_url: string | null;
    cloud_seed_pending: boolean;
    last_server_seq: number;
    outbox: number;
    last_sync_attempt_at: string | null;
    last_sync_success_at: string | null;
    last_sync_error: string | null;
}

const status = ref<CloudStatus | null>(null);
const statusUnavailable = ref(false);
const syncing = ref(false);
const connecting = ref(false);
const connectError = ref<string | null>(null);
const cloudUrl = ref('http://localhost:8200');
const cloudToken = ref('');
let statusTimer: ReturnType<typeof setInterval> | null = null;
let statusRequest: Promise<void> | null = null;

const realtimeAppearance = computed(() => {
    switch (realtimeHealth.state) {
        case 'connected':
            return {
                label: 'Live',
                topLabel: 'Synced',
                detail: 'Realtime delivery is connected.',
                color: 'text-emerald-600 dark:text-emerald-400',
                icon: Cloud,
                spinning: false,
            };
        case 'connecting':
            return {
                label: 'Connecting…',
                topLabel: 'Connecting',
                detail: 'Realtime is connecting; five-second polling remains active.',
                color: 'text-amber-600 dark:text-amber-400',
                icon: RefreshCw,
                spinning: true,
            };
        case 'error':
        case 'failed':
            return {
                label: 'Error · polling',
                topLabel: 'Polling',
                detail: 'Realtime delivery failed; changes still sync through polling.',
                color: 'text-amber-600 dark:text-amber-400',
                icon: CircleAlert,
                spinning: false,
            };
        case 'unavailable':
        case 'disconnected':
            return {
                label: 'Polling fallback',
                topLabel: 'Polling',
                detail: 'Realtime is unavailable; changes still sync every five seconds.',
                color: 'text-amber-600 dark:text-amber-400',
                icon: Cloud,
                spinning: false,
            };
        default:
            return {
                label: 'Polling only',
                topLabel: 'Polling',
                detail: 'Realtime is not configured; changes sync every five seconds.',
                color: 'text-muted-foreground',
                icon: Cloud,
                spinning: false,
            };
    }
});

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

function loadStatus(): Promise<void> {
    if (statusRequest !== null) {
        return statusRequest;
    }

    statusRequest = fetch('/api/cloud/status', {
        headers: { Accept: 'application/json' },
    })
        .then((response) => {
            if (!response.ok) {
                throw new Error(`Status request failed (${response.status})`);
            }

            return response.json() as Promise<CloudStatus>;
        })
        .then((data) => {
            status.value = data;
            statusUnavailable.value = false;
        })
        .catch(() => {
            statusUnavailable.value = true;
        })
        .finally(() => {
            statusRequest = null;
        });

    return statusRequest;
}

async function syncNow(): Promise<void> {
    if (syncing.value || !status.value?.configured) {
        return;
    }

    syncing.value = true;

    try {
        if (!(await requestCloudExchange())) {
            throw new Error('Sync request failed.');
        }
    } catch {
        statusUnavailable.value = true;
    } finally {
        syncing.value = false;

        if (statusRequest !== null) {
            await statusRequest;
        }

        await loadStatus();
    }
}

async function connectCloud(): Promise<void> {
    if (connecting.value || !cloudUrl.value.trim() || !cloudToken.value) {
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
    } catch (error) {
        connectError.value =
            error instanceof Error
                ? error.message
                : 'Could not connect to the cloud.';
    } finally {
        connecting.value = false;

        if (statusRequest !== null) {
            await statusRequest;
        }

        await loadStatus();
    }
}

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
    <DropdownMenu>
        <DropdownMenuTrigger as-child>
            <Button
                variant="ghost"
                size="sm"
                class="max-w-36 gap-2 px-2"
                :aria-label="`Cloud sync: ${appearance.label}`"
            >
                <component
                    :is="appearance.icon"
                    class="size-4"
                    :class="[
                        appearance.color,
                        {
                            'animate-spin':
                                syncing ||
                                connecting ||
                                status === null ||
                                status?.health === 'seeding' ||
                                (status?.configured &&
                                    realtimeAppearance.spinning),
                        },
                    ]"
                />
                <span class="hidden truncate xl:inline">{{
                    appearance.label
                }}</span>
                <span
                    v-if="status && status.outbox > 0"
                    class="min-w-5 rounded-full bg-muted px-1.5 text-center text-[10px] leading-5 text-muted-foreground"
                >
                    {{ status.outbox > 99 ? '99+' : status.outbox }}
                </span>
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
                <div
                    v-if="connectError"
                    class="rounded-md bg-destructive/10 p-2 text-xs leading-relaxed break-words text-destructive"
                    role="alert"
                >
                    {{ connectError }}
                </div>
                <Button
                    type="submit"
                    size="sm"
                    class="w-full"
                    :disabled="connecting || !cloudUrl.trim() || !cloudToken"
                >
                    <RefreshCw v-if="connecting" class="animate-spin" />
                    {{ connecting ? 'Connecting and seeding…' : 'Connect' }}
                </Button>
                <p class="text-xs leading-relaxed text-muted-foreground">
                    First connection uploads existing local data when the cloud
                    workspace is empty.
                </p>
            </form>

            <DropdownMenuSeparator v-if="status && !status.configured" />

            <div v-if="status" class="space-y-2 px-2 py-2 text-xs">
                <div v-if="status.cloud_url" class="flex gap-3">
                    <span class="shrink-0 text-muted-foreground">Cloud</span>
                    <span
                        class="ml-auto truncate text-right"
                        :title="status.cloud_url"
                    >
                        {{ status.cloud_url }}
                    </span>
                </div>
                <div class="flex gap-3">
                    <span class="text-muted-foreground">Pending changes</span>
                    <span class="ml-auto">{{ status.outbox }}</span>
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

            <template v-if="status?.configured">
                <DropdownMenuSeparator />
                <DropdownMenuItem :disabled="syncing" @click="syncNow">
                    <RefreshCw :class="{ 'animate-spin': syncing }" />
                    {{ syncing ? 'Syncing…' : 'Sync now' }}
                </DropdownMenuItem>
            </template>
        </DropdownMenuContent>
    </DropdownMenu>
</template>
