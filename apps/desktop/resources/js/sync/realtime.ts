import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { reactive, readonly } from 'vue';

import { handleCommittedOps, recoverRealtimeSync } from './realtimeOps';
import type { CommittedOpsEvent } from './realtimeOps';

interface RealtimeConfig {
    enabled: boolean;
    workspace_id?: string;
    app_key?: string;
    host?: string;
    port?: number;
    scheme?: 'http' | 'https';
}

export type RealtimeConnectionState =
    | 'disabled'
    | 'connecting'
    | 'connected'
    | 'unavailable'
    | 'failed'
    | 'disconnected'
    | 'error';

export interface RealtimeHealth {
    state: RealtimeConnectionState;
    error: string | null;
}

const mutableRealtimeHealth = reactive<RealtimeHealth>({
    state: 'disabled',
    error: null,
});

export const realtimeHealth = readonly(mutableRealtimeHealth);

let echo: Echo<'reverb'> | null = null;
let activeConfig = '';
let configRequest: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function setRealtimeHealth(
    state: RealtimeConnectionState,
    error: string | null = null,
): void {
    mutableRealtimeHealth.state = state;
    mutableRealtimeHealth.error = error;
}

function stopRealtimeSync(
    state: RealtimeConnectionState = 'disabled',
    error: string | null = null,
): void {
    echo?.disconnect();
    echo = null;
    activeConfig = '';
    setRealtimeHealth(state, error);
}

function clearConfigRetry(): void {
    if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
}

function scheduleConfigRetry(error: string): void {
    setRealtimeHealth('error', error);

    if (retryTimer !== null) {
        return;
    }

    retryTimer = setTimeout(() => {
        retryTimer = null;
        void refreshRealtimeSync();
    }, 15000);
}

function isUsableConfig(
    config: RealtimeConfig,
): config is Required<RealtimeConfig> {
    return (
        config.enabled === true &&
        typeof config.workspace_id === 'string' &&
        config.workspace_id.length > 0 &&
        typeof config.app_key === 'string' &&
        config.app_key.length > 0 &&
        typeof config.host === 'string' &&
        config.host.length > 0 &&
        typeof config.port === 'number' &&
        (config.scheme === 'http' || config.scheme === 'https')
    );
}

function connectionErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }

    if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>;
        const message = record.message;

        if (typeof message === 'string' && message) {
            return message;
        }

        const nestedError = record.error;

        if (typeof nestedError === 'object' && nestedError !== null) {
            const nested = nestedError as Record<string, unknown>;
            const data = nested.data;

            if (typeof data === 'object' && data !== null) {
                const detail = (data as Record<string, unknown>).message;

                if (typeof detail === 'string' && detail) {
                    return detail;
                }
            }
        }
    }

    return 'Realtime connection failed.';
}

function updateConnectionState(state: string): void {
    switch (state) {
        case 'initialized':
        case 'connecting':
        case 'connected':
            // The private channel still has to authenticate before realtime
            // delivery is genuinely available.
            setRealtimeHealth('connecting');
            break;
        case 'unavailable':
            setRealtimeHealth('unavailable');
            break;
        case 'failed':
            setRealtimeHealth('failed', 'WebSockets are not available.');
            break;
        case 'disconnected':
            setRealtimeHealth('disconnected');
            break;
    }
}

async function configureRealtimeSync(): Promise<void> {
    try {
        const response = await fetch('/api/cloud/realtime-config', {
            headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
            scheduleConfigRetry(
                `Could not load realtime configuration (${response.status}).`,
            );

            return;
        }

        const config = (await response.json()) as RealtimeConfig;

        if (!config.enabled) {
            stopRealtimeSync();
            clearConfigRetry();

            return;
        }

        if (!isUsableConfig(config)) {
            scheduleConfigRetry('The realtime configuration is incomplete.');

            return;
        }

        clearConfigRetry();

        const signature = JSON.stringify(config);

        if (echo !== null && signature === activeConfig) {
            return;
        }

        stopRealtimeSync('connecting');
        activeConfig = signature;
        echo = new Echo<'reverb'>({
            broadcaster: 'reverb',
            key: config.app_key,
            wsHost: config.host,
            wsPort: config.port,
            wssPort: config.port,
            forceTLS: config.scheme === 'https',
            enabledTransports: ['ws', 'wss'],
            authEndpoint: '/api/cloud/broadcasting-auth',
            Pusher,
        });

        const connection = echo.connector.pusher.connection;
        connection.bind('state_change', ({ current }: { current: string }) => {
            updateConnectionState(current);
        });
        connection.bind('connected', () => {
            void recoverRealtimeSync();
        });
        connection.bind('error', (error: unknown) => {
            setRealtimeHealth('error', connectionErrorMessage(error));
        });

        echo.private(`workspaces.${config.workspace_id}.sync`)
            .listen('.ops.committed', (event: CommittedOpsEvent) => {
                void handleCommittedOps(event);
            })
            .subscribed(() => {
                setRealtimeHealth('connected');
            })
            .error((error: Record<string, unknown>) => {
                const status = error.status;
                const suffix = typeof status === 'number' ? ` (${status})` : '';
                const message = `Realtime channel authorization failed${suffix}.`;
                stopRealtimeSync('error', message);
                scheduleConfigRetry(message);
            });
    } catch (error) {
        const message = connectionErrorMessage(error);
        stopRealtimeSync('error', message);
        scheduleConfigRetry(message);
    }
}

export function refreshRealtimeSync(): Promise<void> {
    if (configRequest === null) {
        configRequest = configureRealtimeSync().finally(() => {
            configRequest = null;
        });
    }

    return configRequest;
}

export function initializeRealtimeSync(): void {
    void refreshRealtimeSync();
}
