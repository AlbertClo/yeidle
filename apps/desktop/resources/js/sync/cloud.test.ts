import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('requestCloudExchange', () => {
    it('posts an exchange request', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        const { requestCloudExchange } = await import('./cloud');

        await expect(requestCloudExchange()).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledWith('/api/sync/cloud-exchange', {
            method: 'POST',
            headers: { Accept: 'application/json' },
        });
    });

    it('coalesces concurrent requests into one follow-up exchange', async () => {
        let finishFirst!: (response: { ok: boolean }) => void;
        const firstResponse = new Promise<{ ok: boolean }>((resolve) => {
            finishFirst = resolve;
        });
        const fetchMock = vi
            .fn()
            .mockReturnValueOnce(firstResponse)
            .mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        const { requestCloudExchange } = await import('./cloud');

        const first = requestCloudExchange();
        const second = requestCloudExchange();
        const third = requestCloudExchange();

        expect(fetchMock).toHaveBeenCalledTimes(1);

        finishFirst({ ok: true });

        await expect(Promise.all([first, second, third])).resolves.toEqual([
            true,
            true,
            true,
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('contains transport failures for the heartbeat to retry later', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const { requestCloudExchange } = await import('./cloud');

        await expect(requestCloudExchange()).resolves.toBe(false);
    });
});
