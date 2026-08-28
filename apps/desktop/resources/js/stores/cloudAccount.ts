import { ref } from 'vue';
import { loadKeyBindings } from '@/stores/keyBindings';
import { loadWorkspaceState, workspaceState } from '@/stores/workspaces';
import type { Workspace } from '@/types/workspace';

export type CloudAccountWorkspace = {
    id: string;
    name: string;
    role: string;
    owned: boolean;
};

export type AuthorizationRealtimeConfig = {
    enabled: true;
    app_key: string;
    host: string;
    port: number;
    scheme: 'http' | 'https';
};

export type CloudAccountState = {
    signed_in: boolean;
    user: { id: string; name: string; email: string } | null;
    workspaces: CloudAccountWorkspace[];
    preferences: { key_bindings: Record<string, string | null> };
    authorization_pending: boolean;
    authorization_id: string | null;
    authorization_expires_at: string | null;
    authorization_realtime: AuthorizationRealtimeConfig | null;
    verification_url: string | null;
};

export type AuthorizationResponse = {
    status: 'pending' | 'approved' | 'expired';
    authorization_id?: string;
    verification_url?: string;
    expires_at?: string;
    realtime?: AuthorizationRealtimeConfig;
} & Partial<CloudAccountState>;

export const cloudAccount = ref<CloudAccountState | null>(null);

let accountRequest: Promise<CloudAccountState> | null = null;

async function json<T>(response: Response): Promise<T> {
    const payload = (await response.json().catch(() => null)) as
        | (T & { message?: string })
        | null;

    if (!response.ok || payload === null) {
        throw new Error(
            payload?.message ??
                `Cloud account request failed (${response.status}).`,
        );
    }

    return payload;
}

export async function loadCloudAccount(
    force = false,
): Promise<CloudAccountState> {
    if (accountRequest !== null) {
        return accountRequest;
    }

    if (cloudAccount.value !== null && !force) {
        return cloudAccount.value;
    }

    accountRequest = fetch('/api/account', {
        headers: { Accept: 'application/json' },
    })
        .then((response) => json<CloudAccountState>(response))
        .then((state) => {
            cloudAccount.value = state;

            return state;
        })
        .finally(() => {
            accountRequest = null;
        });

    return accountRequest;
}

export async function beginCloudSignIn(
    deviceName?: string,
): Promise<AuthorizationResponse> {
    const response = await fetch('/api/account/connect', {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ device_name: deviceName }),
    });
    const payload = await json<AuthorizationResponse>(response);
    await loadCloudAccount(true);

    return payload;
}

export async function cancelCloudSignIn(): Promise<void> {
    const response = await fetch('/api/account/connect', {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
    });

    await json<{ cancelled: boolean }>(response);
    await loadCloudAccount(true);
}

export async function completeCloudSignIn(): Promise<AuthorizationResponse> {
    const response = await fetch('/api/account/complete', {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    const payload = await json<AuthorizationResponse>(response);

    if (payload.status === 'approved') {
        cloudAccount.value = payload as CloudAccountState;
        await Promise.all([loadWorkspaceState(true), loadKeyBindings(true)]);
    } else if (payload.status === 'expired') {
        await loadCloudAccount(true);
    }

    return payload;
}

export async function refreshCloudAccount(): Promise<CloudAccountState> {
    const response = await fetch('/api/account/refresh', {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    const state = await json<CloudAccountState>(response);
    cloudAccount.value = state;
    await Promise.all([loadWorkspaceState(true), loadKeyBindings(true)]);

    return state;
}

export async function syncActiveCloudWorkspace(): Promise<void> {
    const response = await fetch('/api/account/sync-active-workspace', {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });

    await json<{ synced: boolean }>(response);
    await loadWorkspaceState(true);
}

export async function enableWorkspaceCloudSync(
    workspaceId: string,
): Promise<Workspace> {
    const active = workspaceState.value?.active_workspace_id === workspaceId;
    const response = await fetch(`/api/workspaces/${workspaceId}/sync`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    const payload = await json<{ workspace: Workspace }>(response);

    await Promise.all([loadCloudAccount(true), loadWorkspaceState(true)]);

    if (active) {
        await syncActiveCloudWorkspace();
    }

    return payload.workspace;
}

export async function signOutCloudAccount(): Promise<void> {
    const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
    });

    await json<{ signed_out: boolean }>(response);
    await loadCloudAccount(true);
}
