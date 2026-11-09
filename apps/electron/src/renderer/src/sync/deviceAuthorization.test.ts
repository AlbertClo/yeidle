import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    echoes: [] as Array<Record<string, any>>,
}));

vi.mock('laravel-echo', () => {
    class FakeConnection {
        handlers = new Map<string, Array<() => void>>();

        bind(event: string, callback: () => void): void {
            const handlers = this.handlers.get(event) ?? [];
            handlers.push(callback);
            this.handlers.set(event, handlers);
        }

        emit(event: string): void {
            for (const handler of this.handlers.get(event) ?? []) {
                handler();
            }
        }
    }

    class FakeChannel {
        listener: ((event: { authorization_id?: unknown }) => void) | null =
            null;
        subscribedCallback: (() => void) | null = null;
        errorCallback: (() => void) | null = null;

        listen(
            _event: string,
            callback: (event: { authorization_id?: unknown }) => void,
        ): this {
            this.listener = callback;

            return this;
        }

        subscribed(callback: () => void): this {
            this.subscribedCallback = callback;

            return this;
        }

        error(callback: () => void): this {
            this.errorCallback = callback;

            return this;
        }
    }

    return {
        default: class FakeEcho {
            connection = new FakeConnection();
            channel = new FakeChannel();
            privateChannel = '';
            disconnected = false;
            connector = { pusher: { connection: this.connection } };

            constructor(public options: Record<string, unknown>) {
                mocks.echoes.push(this);
            }

            private(name: string): FakeChannel {
                this.privateChannel = name;

                return this.channel;
            }

            disconnect(): void {
                this.disconnected = true;
            }
        },
    };
});

vi.mock('pusher-js', () => ({ default: class FakePusher {} }));

beforeEach(() => {
    mocks.echoes.length = 0;
});

afterEach(async () => {
    const { stopDeviceAuthorizationRealtime } =
        await import('./deviceAuthorization');
    stopDeviceAuthorizationRealtime();
    vi.resetModules();
});

describe('device authorization realtime', () => {
    it('uses a private channel and handles subscription recovery and approval', async () => {
        const approved = vi.fn();
        const subscribed = vi.fn();
        const error = vi.fn();
        const {
            startDeviceAuthorizationRealtime,
            stopDeviceAuthorizationRealtime,
        } = await import('./deviceAuthorization');

        startDeviceAuthorizationRealtime(
            'authorization-1',
            {
                enabled: true,
                app_key: 'public-key',
                host: 'ws.yeidle.test',
                port: 443,
                scheme: 'https',
            },
            { approved, subscribed, error },
        );

        expect(mocks.echoes).toHaveLength(1);
        const echo = mocks.echoes[0];
        expect(echo.options).toMatchObject({
            key: 'public-key',
            wsHost: 'ws.yeidle.test',
            forceTLS: true,
            authEndpoint: '/api/account/broadcasting-auth',
        });
        expect(echo.privateChannel).toBe(
            'device-authorizations.authorization-1',
        );

        echo.channel.subscribedCallback?.();
        expect(subscribed).toHaveBeenCalledOnce();

        echo.channel.listener?.({ authorization_id: 'someone-else' });
        expect(approved).not.toHaveBeenCalled();
        echo.channel.listener?.({ authorization_id: 'authorization-1' });
        expect(approved).toHaveBeenCalledOnce();

        echo.connection.emit('error');
        expect(error).toHaveBeenCalledWith(
            'Could not connect to realtime sign in.',
        );

        stopDeviceAuthorizationRealtime();
        expect(echo.disconnected).toBe(true);
    });
});
