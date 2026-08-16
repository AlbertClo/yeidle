import { afterEach, describe, expect, it, vi } from 'vitest';

const { requestCloudExchangeMock } = vi.hoisted(() => ({
    requestCloudExchangeMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('./cloud', () => ({
    requestCloudExchange: requestCloudExchangeMock,
}));

import { handleCommittedOps, LOCAL_OPS_AVAILABLE_EVENT } from './realtimeOps';
import type { CommittedOpsEvent } from './realtimeOps';

const event: CommittedOpsEvent = {
    workspace_id: 'workspace-1',
    origin_client_id: 'installation-a',
    previous_seq: 4,
    latest_seq: 7,
    ops: [],
};

afterEach(() => {
    vi.unstubAllGlobals();
    requestCloudExchangeMock.mockClear();
});

describe('handleCommittedOps', () => {
    it('wakes open views after direct local ingestion', async () => {
        const localWindow = new EventTarget();
        const listener = vi.fn();
        localWindow.addEventListener(LOCAL_OPS_AVAILABLE_EVENT, listener);
        vi.stubGlobal('window', localWindow);
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: () =>
                    Promise.resolve({
                        applied: 1,
                        needs_pull: false,
                        ignored: false,
                    }),
            }),
        );

        await handleCommittedOps(event);

        expect(listener).toHaveBeenCalledOnce();
        expect(requestCloudExchangeMock).not.toHaveBeenCalled();
    });

    it('uses the durable exchange when the local cursor has a gap', async () => {
        const localWindow = new EventTarget();
        const listener = vi.fn();
        localWindow.addEventListener(LOCAL_OPS_AVAILABLE_EVENT, listener);
        vi.stubGlobal('window', localWindow);
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: () =>
                    Promise.resolve({
                        applied: 0,
                        needs_pull: true,
                        ignored: false,
                    }),
            }),
        );

        await handleCommittedOps(event);

        expect(requestCloudExchangeMock).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledOnce();
    });
});
