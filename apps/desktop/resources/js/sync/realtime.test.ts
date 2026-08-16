import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    echoes: [] as Array<Record<string, any>>,
    handleCommittedOps: vi.fn(),
    recoverRealtimeSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('laravel-echo', () => {
    class FakeConnection {
        handlers = new Map<string, Array<(payload?: any) => void>>();

        bind(event: string, callback: (payload?: any) => void): void {
            const handlers = this.handlers.get(event) ?? [];
            handlers.push(callback);
            this.handlers.set(event, handlers);
        }

        emit(event: string, payload?: any): void {
            for (const handler of this.handlers.get(event) ?? []) {
                handler(payload);
            }
        }
    }

    class FakeChannel {
        subscribedCallback: (() => void) | null = null;
        errorCallback: ((error: Record<string, unknown>) => void) | null = null;

        listen(): this {
            return this;
        }

        subscribed(callback: () => void): this {
            this.subscribedCallback = callback;

            return this;
        }

        error(callback: (error: Record<string, unknown>) => void): this {
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

vi.mock('./realtimeOps', () => ({
    handleCommittedOps: mocks.handleCommittedOps,
    recoverRealtimeSync: mocks.recoverRealtimeSync,
}));

const enabledConfig = {
    enabled: true,
    workspace_id: 'workspace-1',
    app_key: 'app-key',
    host: 'localhost',
    port: 8080,
    scheme: 'http',
};

beforeEach(() => {
    mocks.echoes.length = 0;
    mocks.handleCommittedOps.mockClear();
    mocks.recoverRealtimeSync.mockClear();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('realtime health', () => {
    it('becomes connected only after the private channel subscribes', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(enabledConfig),
            }),
        );
        const { realtimeHealth, refreshRealtimeSync } =
            await import('./realtime');

        await refreshRealtimeSync();

        expect(realtimeHealth.state).toBe('connecting');
        expect(mocks.echoes).toHaveLength(1);
        const echo = mocks.echoes[0];
        expect(echo.privateChannel).toBe('workspaces.workspace-1.sync');

        echo.connection.emit('connected');
        expect(mocks.recoverRealtimeSync).toHaveBeenCalledOnce();
        expect(realtimeHealth.state).toBe('connecting');

        echo.channel.subscribedCallback?.();
        expect(realtimeHealth.state).toBe('connected');
        expect(realtimeHealth.error).toBeNull();
    });

    it('reports polling fallback when the connection is unavailable', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(enabledConfig),
            }),
        );
        const { realtimeHealth, refreshRealtimeSync } =
            await import('./realtime');

        await refreshRealtimeSync();
        mocks.echoes[0].connection.emit('state_change', {
            previous: 'connecting',
            current: 'unavailable',
        });

        expect(realtimeHealth.state).toBe('unavailable');
        expect(realtimeHealth.error).toBeNull();
    });

    it('reports private-channel authorization errors', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(enabledConfig),
            }),
        );
        const { realtimeHealth, refreshRealtimeSync } =
            await import('./realtime');

        await refreshRealtimeSync();
        mocks.echoes[0].channel.errorCallback?.({ status: 403 });

        expect(realtimeHealth.state).toBe('error');
        expect(realtimeHealth.error).toBe(
            'Realtime channel authorization failed (403).',
        );
        expect(mocks.echoes[0].disconnected).toBe(true);

        await vi.advanceTimersByTimeAsync(15000);
        expect(mocks.echoes).toHaveLength(2);
        expect(realtimeHealth.state).toBe('connecting');
    });

    it('stays disabled when cloud realtime is not configured', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ enabled: false }),
            }),
        );
        const { realtimeHealth, refreshRealtimeSync } =
            await import('./realtime');

        await refreshRealtimeSync();

        expect(realtimeHealth.state).toBe('disabled');
        expect(mocks.echoes).toHaveLength(0);
    });
});
