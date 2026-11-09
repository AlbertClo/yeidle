import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { call, request, Router, testContext } from '../testing';

import { registerMediaRoutes } from './media';

let ctx: ReturnType<typeof testContext>;
let router: Router;

beforeEach(() => {
    ctx = testContext();
    router = new Router();
    registerMediaRoutes(router, ctx);
});

afterEach(() => ctx.cleanup());

const sha256 = (text: string) =>
    createHash('sha256').update(text).digest('hex');

async function sendChunk(
    uploadId: string,
    index: number,
    contents: string | null,
) {
    const req = request('POST', '/api/media/chunk', {
        upload_id: uploadId,
        chunk_index: String(index),
    });

    if (contents !== null) {
        req.files.chunk = {
            name: `chunk_${index}`,
            type: 'application/octet-stream',
            bytes: new TextEncoder().encode(contents),
        };
    }

    const response = await router.handle(req);

    return {
        status: response.status,
        json: JSON.parse(response.body as string),
    };
}

async function upload(
    name: string,
    chunks: string[],
    mimeType = 'application/octet-stream',
) {
    const init = await call(router, 'POST', '/api/media/init', {
        filename: name,
        size: chunks.join('').length,
        mime_type: mimeType,
        total_chunks: chunks.length,
    });
    expect(init.status).toBe(201);

    for (const [i, chunk] of chunks.entries()) {
        expect((await sendChunk(init.json.upload_id, i, chunk)).json).toEqual({
            received: i + 1,
        });
    }

    return call(router, 'POST', '/api/media/complete', {
        upload_id: init.json.upload_id,
    });
}

describe('media routes', () => {
    it('assembles a chunked upload into a content-addressed blob and registers the media', async () => {
        const response = await upload('test.bin', ['abc', 'def']);

        expect(response.status).toBe(201);
        const hash = sha256('abcdef');
        expect(response.json).toMatchObject({
            filename: hash,
            original_name: 'test.bin',
            mime_type: 'application/octet-stream',
            size: 6,
        });
        expect(response.json.id).toMatch(/^[0-9a-f-]{36}$/);

        const storage = ctx.workspace().storagePath;
        expect(fs.readFileSync(path.join(storage, 'media', hash), 'utf8')).toBe(
            'abcdef',
        );
        expect(fs.readdirSync(path.join(storage, 'uploads'))).toEqual([]);
        expect(
            ctx
                .db()
                .get('SELECT filename, original_name FROM media WHERE id = ?', [
                    response.json.id,
                ]),
        ).toEqual({
            filename: hash,
            original_name: 'test.bin',
        });
    });

    it('deduplicates identical content into one blob', async () => {
        const first = await upload('a.txt', ['same']);
        const second = await upload('b.txt', ['same']);

        expect(first.json.id).not.toBe(second.json.id);
        expect(first.json.filename).toBe(second.json.filename);
        expect(
            fs.readdirSync(path.join(ctx.workspace().storagePath, 'media')),
        ).toEqual([sha256('same')]);
        expect(
            ctx
                .db()
                .get<{ count: number }>('SELECT COUNT(*) AS count FROM media')!
                .count,
        ).toBe(2);
    });

    it('validates uploads and rejects unknown upload ids', async () => {
        const init = await call(router, 'POST', '/api/media/init', {
            filename: 'x',
            mime_type: 'text/plain',
        });
        expect(init.status).toBe(422);
        expect(init.json.errors).toHaveProperty('size');

        const zero = await call(router, 'POST', '/api/media/init', {
            filename: 'x',
            size: 0,
            mime_type: 'text/plain',
            total_chunks: 1,
        });
        expect(zero.status).toBe(422);

        expect(
            (await sendChunk('00000000-0000-4000-8000-000000000000', 0, 'x'))
                .status,
        ).toBe(404);
        expect((await sendChunk('../escape', 0, 'x')).status).toBe(404);

        const missingFile = await sendChunk(
            '00000000-0000-4000-8000-000000000000',
            0,
            null,
        );
        expect(missingFile.status).toBe(422);
        expect(missingFile.json.errors).toHaveProperty('chunk');

        const complete = await call(router, 'POST', '/api/media/complete', {
            upload_id: '00000000-0000-4000-8000-000000000000',
        });
        expect(complete.status).toBe(404);
        expect(complete.json).toEqual({ message: 'Upload not found' });
    });

    it('serves a blob inline under its original name', async () => {
        const uploaded = await upload('photo.png', ['png-bytes'], 'image/png');

        const response = await router.handle(
            request('GET', `/api/media/${uploaded.json.id}`),
        );

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe('image/png');
        expect(response.headers['content-disposition']).toBe(
            'inline; filename="photo.png"',
        );
        expect(response.headers['cache-control']).toBe(
            'public, max-age=31536000',
        );
        expect(response.body).toEqual({
            file: path.join(
                ctx.workspace().storagePath,
                'media',
                sha256('png-bytes'),
            ),
        });
    });

    it('returns 404 for unknown media and 503 when the blob is missing locally', async () => {
        expect(
            (
                await call(
                    router,
                    'GET',
                    '/api/media/00000000-0000-7000-8000-000000000001',
                )
            ).status,
        ).toBe(404);

        const id = '00000000-0000-7000-8000-000000000002';
        ctx.documents().applyChanges([
            {
                type: 'media.create',
                payload: {
                    id,
                    hash: sha256('remote only'),
                    original_name: 'r.txt',
                    mime_type: 'text/plain',
                    size: 11,
                },
            },
        ]);

        const missing = await call(router, 'GET', `/api/media/${id}`);
        expect(missing.status).toBe(503);
        expect(missing.json.message).toBe(
            'Media is not currently available on this device.',
        );
    });

    it('opens a linked copy with the original filename and shows the blob in its folder', async () => {
        const uploaded = await upload(
            'report.pdf',
            ['%PDF'],
            'application/pdf',
        );
        const storage = ctx.workspace().storagePath;

        const opened = await call(
            router,
            'POST',
            `/api/media/${uploaded.json.id}/open`,
        );
        expect(opened.status).toBe(200);
        expect(opened.json).toBeNull();
        const target = path.join(
            storage,
            'media-open',
            `${uploaded.json.id}-report.pdf`,
        );
        expect(ctx.opened).toEqual([target]);
        expect(fs.readFileSync(target, 'utf8')).toBe('%PDF');

        const folder = await call(
            router,
            'POST',
            `/api/media/${uploaded.json.id}/open-folder`,
        );
        expect(folder.status).toBe(200);
        expect(ctx.shownInFolder).toEqual([
            path.join(storage, 'media', sha256('%PDF')),
        ]);
    });
});
