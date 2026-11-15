import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
    addMedia as addMediaRow,
    MEDIA_DOCUMENT_ID,
} from '../../loro/projection';
import { uuidv7 } from '../../support/ids';
import { registerMediaRoutes } from '../controllers/media';
import { call, Router, testContext } from '../testing';

import { fakeRelay, signInDevice, WORKSPACE } from './fakeCloud';
import { cloudFor } from './index';

const devices: ReturnType<typeof testContext>[] = [];

afterEach(() => {
    while (devices.length > 0) {
        devices.pop()!.cleanup();
    }
});

/** A device whose cloud traffic goes to the fake relay. */
function device(relay: ReturnType<typeof fakeRelay>) {
    const ctx = testContext();
    ctx.host.cloudFetch = relay.fetch;
    signInDevice(ctx);
    devices.push(ctx);

    return ctx;
}

const mediaPath = (ctx: ReturnType<typeof testContext>, hash: string) =>
    ctx.host.files.join(ctx.workspace().storagePath, 'media', hash);

/** Stores a file the way a finished upload does: blob on disk + media document entry. */
function addMedia(ctx: ReturnType<typeof testContext>, content: string) {
    const bytes = new TextEncoder().encode(content);
    const hash = createHash('sha256').update(bytes).digest('hex');
    ctx.host.files.mkdir(
        ctx.host.files.join(ctx.workspace().storagePath, 'media'),
    );
    ctx.host.files.writeFile(mediaPath(ctx, hash), bytes);
    const id = uuidv7();
    ctx.documents().edit(MEDIA_DOCUMENT_ID, (doc) =>
        addMediaRow(doc, {
            id,
            hash,
            original_name: `${content}.txt`,
            mime_type: 'text/plain',
            size: bytes.length,
            created_at: null,
        }),
    );

    return { id, hash, bytes };
}

async function pair(ctx: ReturnType<typeof testContext>) {
    await cloudFor(ctx).sync().connect(WORKSPACE);
}

describe('CloudBlobs', () => {
    it('uploads local files once and counts what is pending', async () => {
        const relay = fakeRelay();
        const a = device(relay);
        const first = addMedia(a, 'first');
        addMedia(a, 'first'); // same content: one blob, two rows
        await pair(a);
        const blobs = cloudFor(a).blobs();

        expect(blobs.pendingUploadCount()).toBe(1);
        expect(await blobs.uploadPending()).toBe(1);
        expect(relay.blobs.get(first.hash)).toEqual(first.bytes);
        expect(blobs.pendingUploadCount()).toBe(0);
        expect(a.db().all('SELECT hash FROM uploaded_blobs')).toEqual([
            { hash: first.hash },
        ]);
        expect(await blobs.uploadPending()).toBe(0);
    });

    it('skips the upload when the cloud already has the file', async () => {
        const relay = fakeRelay();
        const a = device(relay);
        const media = addMedia(a, 'shared');
        relay.blobs.set(media.hash, media.bytes);
        await pair(a);

        await cloudFor(a).blobs().uploadPending();

        expect(cloudFor(a).blobs().pendingUploadCount()).toBe(0);
        expect(a.db().all('SELECT hash FROM uploaded_blobs')).toEqual([
            { hash: media.hash },
        ]);
    });

    it('keeps upload progress out of the synced media rows', async () => {
        const relay = fakeRelay();
        const a = device(relay);
        const media = addMedia(a, 'progress');
        await pair(a);
        await cloudFor(a).blobs().uploadPending();

        // Rebuilding the read model from the documents keeps it
        a.documents().rebuildReadModel();

        expect(cloudFor(a).blobs().pendingUploadCount()).toBe(0);
        expect(
            a.db().get('SELECT hash FROM media WHERE id = ?', [media.id]),
        ).toEqual({ hash: media.hash });
    });

    it('downloads files another device uploaded, in the background', async () => {
        const relay = fakeRelay();
        const a = device(relay);
        const media = addMedia(a, 'photo');
        await pair(a);
        await cloudFor(a).blobs().run();

        const b = device(relay);
        await pair(b);

        expect(b.host.files.isFile(mediaPath(b, media.hash))).toBe(false);
        await cloudFor(b).blobs().run();
        expect(b.host.files.readFile(mediaPath(b, media.hash))).toEqual(
            media.bytes,
        );
        // Downloaded means the cloud has it: nothing to upload back
        expect(cloudFor(b).blobs().pendingUploadCount()).toBe(0);
    });

    it('downloads a missing file when it is shown', async () => {
        const relay = fakeRelay();
        const a = device(relay);
        const media = addMedia(a, 'diagram');
        await pair(a);
        await cloudFor(a).blobs().uploadPending();

        const b = device(relay);
        await pair(b);
        const router = new Router();
        registerMediaRoutes(router, b);

        const response = await call(router, 'GET', `/api/media/${media.id}`);

        expect(response.status).toBe(200);
        expect(b.host.files.readFile(mediaPath(b, media.hash))).toEqual(
            media.bytes,
        );
    });

    it('reports a file that has not been uploaded yet as unavailable', async () => {
        const relay = fakeRelay();
        const a = device(relay);
        const media = addMedia(a, 'still uploading');
        await pair(a); // notes synced, file not uploaded

        const b = device(relay);
        await pair(b);
        const router = new Router();
        registerMediaRoutes(router, b);

        expect(await cloudFor(b).blobs().downloadMissing()).toBe(0);
        expect(
            (await call(router, 'GET', `/api/media/${media.id}`)).status,
        ).toBe(503);
    });

    it('rejects a download whose content does not match its hash', async () => {
        const relay = fakeRelay();
        const a = device(relay);
        const media = addMedia(a, 'genuine');
        await pair(a);
        await cloudFor(a).blobs().uploadPending();
        relay.tampered.set(media.hash, new TextEncoder().encode('forged'));

        const b = device(relay);
        await pair(b);

        await expect(
            cloudFor(b).blobs().ensureLocal(media.hash),
        ).rejects.toThrow('failed verification');
        expect(b.host.files.isFile(mediaPath(b, media.hash))).toBe(false);
    });
});
