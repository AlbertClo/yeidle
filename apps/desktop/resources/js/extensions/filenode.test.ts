import { afterEach, describe, expect, it, vi } from 'vitest';

const { requestCloudExchangeMock } = vi.hoisted(() => ({
    requestCloudExchangeMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('../sync/cloud', () => ({
    requestCloudExchange: requestCloudExchangeMock,
}));

import { uploadFile } from './filenode';

afterEach(() => {
    vi.unstubAllGlobals();
    requestCloudExchangeMock.mockClear();
});

describe('uploadFile', () => {
    it('wakes cloud delivery after the local upload completes', async () => {
        const media = {
            id: 'media-1',
            original_name: 'note.txt',
            mime_type: 'text/plain',
            size: 4,
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: vi.fn().mockResolvedValue({ upload_id: 'upload-1' }),
            })
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({
                ok: true,
                json: vi.fn().mockResolvedValue(media),
            });
        vi.stubGlobal('fetch', fetchMock);

        const file = new File(['note'], 'note.txt', { type: 'text/plain' });

        await expect(uploadFile(file)).resolves.toEqual(media);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(requestCloudExchangeMock).toHaveBeenCalledOnce();
    });

    it('does not wake cloud delivery when local completion fails', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: vi.fn().mockResolvedValue({ upload_id: 'upload-1' }),
            })
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: false });
        vi.stubGlobal('fetch', fetchMock);

        const file = new File(['note'], 'note.txt', { type: 'text/plain' });

        await expect(uploadFile(file)).resolves.toBeNull();
        expect(requestCloudExchangeMock).not.toHaveBeenCalled();
    });
});
