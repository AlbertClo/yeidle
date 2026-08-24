import { ref } from 'vue';

export type SyncHealth =
    | 'unconfigured'
    | 'seeding'
    | 'never_synced'
    | 'healthy'
    | 'error';

export interface CloudStatus {
    configured: boolean;
    health: SyncHealth;
    cloud_url: string | null;
    cloud_workspace_id: string | null;
    cloud_seed_pending: boolean;
    last_server_seq: number;
    local_log_seq: number;
    outbox: number;
    pending_blob_uploads: number;
    last_sync_attempt_at: string | null;
    last_sync_success_at: string | null;
    last_sync_error: string | null;
}

export const cloudSyncStatus = ref<CloudStatus | null>(null);
export const cloudSyncStatusUnavailable = ref(false);

let statusRequest: Promise<void> | null = null;

export function loadCloudSyncStatus(): Promise<void> {
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
            cloudSyncStatus.value = data;
            cloudSyncStatusUnavailable.value = false;
        })
        .catch(() => {
            cloudSyncStatusUnavailable.value = true;
        })
        .finally(() => {
            statusRequest = null;
        });

    return statusRequest;
}
