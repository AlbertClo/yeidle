import Echo from 'laravel-echo';
import Pusher from 'pusher-js';

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

let echo: Echo<'reverb'> | null = null;
let activeConfig = '';
let configRequest: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function stopRealtimeSync(): void {
    echo?.disconnect();
    echo = null;
    activeConfig = '';
}

function scheduleConfigRetry(): void {
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

async function configureRealtimeSync(): Promise<void> {
    try {
        const response = await fetch('/api/cloud/realtime-config', {
            headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
            scheduleConfigRetry();

            return;
        }

        const config = (await response.json()) as RealtimeConfig;

        if (!config.enabled) {
            stopRealtimeSync();

            return;
        }

        if (!isUsableConfig(config)) {
            scheduleConfigRetry();

            return;
        }

        const signature = JSON.stringify(config);

        if (echo !== null && signature === activeConfig) {
            return;
        }

        stopRealtimeSync();
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

        echo.private(`workspaces.${config.workspace_id}.sync`).listen(
            '.ops.committed',
            (event: CommittedOpsEvent) => {
                void handleCommittedOps(event);
            },
        );

        echo.connector.pusher.connection.bind('connected', () => {
            void recoverRealtimeSync();
        });
    } catch {
        scheduleConfigRetry();
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
