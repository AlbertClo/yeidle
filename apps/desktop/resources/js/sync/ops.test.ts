import { afterEach, describe, expect, it, vi } from 'vitest';

const { requestCloudExchangeMock } = vi.hoisted(() => ({
    requestCloudExchangeMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('./cloud', () => ({
    requestCloudExchange: requestCloudExchangeMock,
}));

import type { Op } from './ops';
import { pushOps } from './ops';

const op: Op = {
    op_id: 'op-1',
    client_id: 'client-1',
    hlc: '001',
    type: 'node.set',
    payload: { v: 1, id: 'node-1', page_id: 'page-1', fields: {} },
};

afterEach(() => {
    vi.unstubAllGlobals();
    requestCloudExchangeMock.mockClear();
});

describe('pushOps', () => {
    it('requests a cloud exchange after the local push succeeds', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

        await expect(pushOps([op])).resolves.toBe(true);
        expect(requestCloudExchangeMock).toHaveBeenCalledOnce();
    });

    it('does not request a cloud exchange after a rejected local push', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

        await expect(pushOps([op])).resolves.toBe(false);
        expect(requestCloudExchangeMock).not.toHaveBeenCalled();
    });
});
