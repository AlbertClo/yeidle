import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import type { AuthorizationRealtimeConfig } from '@/stores/cloudAccount';

type DeviceAuthorizationCallbacks = {
    approved: () => void;
    subscribed: () => void;
    error: (message: string) => void;
};

let echo: Echo<'reverb'> | null = null;

export function stopDeviceAuthorizationRealtime(): void {
    echo?.disconnect();
    echo = null;
}

export function startDeviceAuthorizationRealtime(
    authorizationId: string,
    config: AuthorizationRealtimeConfig,
    callbacks: DeviceAuthorizationCallbacks,
): void {
    stopDeviceAuthorizationRealtime();

    echo = new Echo<'reverb'>({
        broadcaster: 'reverb',
        key: config.app_key,
        wsHost: config.host,
        wsPort: config.port,
        wssPort: config.port,
        forceTLS: config.scheme === 'https',
        enabledTransports: ['ws', 'wss'],
        authEndpoint: '/api/account/broadcasting-auth',
        Pusher,
    });

    echo.connector.pusher.connection.bind('error', () => {
        callbacks.error('Could not connect to realtime sign in.');
    });

    echo.private(`device-authorizations.${authorizationId}`)
        .listen(
            '.authorization.approved',
            (event: { authorization_id?: unknown }) => {
                if (event.authorization_id === authorizationId) {
                    callbacks.approved();
                }
            },
        )
        .subscribed(callbacks.subscribed)
        .error(() => {
            callbacks.error('Could not authorize realtime sign in.');
        });
}
