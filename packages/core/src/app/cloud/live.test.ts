import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../support/ids';
import { registerCloudRoutes } from '../controllers/cloud';
import { registerWorkspaceRoutes } from '../controllers/workspaces';
import { call, Router, testContext } from '../testing';

import { cloudFor } from './index';

/**
 * Two devices syncing through a real Yeidle Cloud. Opt-in:
 *
 *   YEIDLE_LIVE_CLOUD_URL=http://localhost:8200 \
 *   YEIDLE_LIVE_CLOUD_TOKEN=<sail artisan token:issue you@example.com> \
 *   npx vitest run src/app/cloud/live.test.ts
 *
 * Creates a throwaway cloud workspace and deletes it at the end.
 */
const url = process.env.YEIDLE_LIVE_CLOUD_URL;
const token = process.env.YEIDLE_LIVE_CLOUD_TOKEN;

const devices: ReturnType<typeof testContext>[] = [];

afterEach(() => {
    while (devices.length > 0) {
        devices.pop()!.cleanup();
    }
});

async function signedInDevice(userId: string) {
    const ctx = testContext();
    devices.push(ctx);
    // The device flow needs a browser; write the session it would produce
    ctx.host.files.writeFile(
        ctx.host.files.join(ctx.host.dataDirectory, 'cloud-account.json'),
        JSON.stringify({
            version: 1,
            pending: null,
            account: {
                cloud_url: url,
                token,
                user: { id: userId },
                workspaces: [],
                preferences: { key_bindings: {} },
            },
        }),
    );
    const router = new Router();
    registerWorkspaceRoutes(router, ctx);
    registerCloudRoutes(router, ctx);

    return { ctx, router };
}

function setNode(
    ctx: ReturnType<typeof testContext>,
    id: string,
    pageId: string,
    fields: Record<string, unknown>,
) {
    ctx.documents().applyChanges([
        { type: 'node.set', payload: { id, page_id: pageId, fields } },
    ]);
}

const tree = (ctx: ReturnType<typeof testContext>) =>
    ctx
        .db()
        .all(
            'SELECT id, parent_id, position, content FROM nodes WHERE deleted_at IS NULL ORDER BY id',
        );

describe.skipIf(!url || !token)('live cloud sync', () => {
    it('pairs two devices and converges edits in both directions', async () => {
        const me = await (
            await fetch(`${url}/api/user`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                },
            })
        ).json();
        const userId = String(me.id);

        // Device A: a local workspace with notes, then enable cloud sync
        const a = await signedInDevice(userId);
        const workspace = a.ctx.workspaces.create(`Live sync ${Date.now()}`);
        a.ctx.workspaces.activate(workspace.id);
        const pageId = uuidv7();
        const blockId = uuidv7();
        setNode(a.ctx, pageId, pageId, {
            parent_id: null,
            position: 'a0',
            content: 'Live sync page',
        });
        setNode(a.ctx, blockId, pageId, {
            parent_id: pageId,
            position: 'a0',
            content: 'written on A',
        });

        try {
            expect(
                (
                    await call(
                        a.router,
                        'POST',
                        `/api/workspaces/${workspace.id}/sync`,
                    )
                ).status,
            ).toBe(200);
            const seeded = await call(
                a.router,
                'POST',
                '/api/account/sync-active-workspace',
            );
            expect(seeded.json).toMatchObject({
                synced: true,
                result: { seeded: true, ok: true },
            });

            // Device B: sees the workspace in its catalog, opens it empty
            const b = await signedInDevice(userId);
            await call(b.router, 'POST', '/api/account/refresh');
            expect(b.ctx.workspaces.find(workspace.id).cloud_status).toBe(
                'available',
            );
            b.ctx.workspaces.activate(workspace.id);
            const bootstrapped = await call(
                b.router,
                'POST',
                '/api/account/sync-active-workspace',
            );
            expect(bootstrapped.json).toMatchObject({
                synced: true,
                result: { bootstrapped: true, ok: true },
            });
            expect(tree(b.ctx)).toEqual(tree(a.ctx));

            // Concurrent edits on both devices
            setNode(a.ctx, blockId, pageId, { content: 'edited on A' });
            setNode(b.ctx, uuidv7(), pageId, {
                parent_id: pageId,
                position: 'a1',
                content: 'added on B',
            });

            await cloudFor(a.ctx).sync().exchange();
            await cloudFor(b.ctx).sync().exchange();
            await cloudFor(a.ctx).sync().exchange();

            expect(tree(a.ctx)).toEqual(tree(b.ctx));
            expect(tree(a.ctx).map((row) => row.content)).toEqual(
                expect.arrayContaining(['edited on A', 'added on B']),
            );
            expect(
                (await call(a.router, 'GET', '/api/cloud/status')).json,
            ).toMatchObject({ health: 'healthy', outbox: 0 });

            // A media file: notes carry its metadata, storage carries the bytes
            const bytes = new TextEncoder().encode(`live blob ${uuidv7()}`);
            const hash = createHash('sha256').update(bytes).digest('hex');
            const media = (ctx: ReturnType<typeof testContext>) =>
                ctx.host.files.join(ctx.workspace().storagePath, 'media');
            a.ctx.host.files.mkdir(media(a.ctx));
            a.ctx.host.files.writeFile(
                a.ctx.host.files.join(media(a.ctx), hash),
                bytes,
            );
            a.ctx.documents().applyChanges([
                {
                    type: 'media.create',
                    payload: {
                        id: uuidv7(),
                        hash,
                        original_name: 'live.txt',
                        mime_type: 'text/plain',
                        size: bytes.length,
                    },
                },
            ]);
            await cloudFor(a.ctx).sync().exchange();
            expect(await cloudFor(a.ctx).blobs().uploadPending()).toBe(1);

            await cloudFor(b.ctx).sync().exchange();
            expect(await cloudFor(b.ctx).blobs().downloadMissing()).toBe(1);
            expect(
                b.ctx.host.files.readFile(
                    b.ctx.host.files.join(media(b.ctx), hash),
                ),
            ).toEqual(bytes);
        } finally {
            await call(a.router, 'DELETE', `/api/workspaces/${workspace.id}`);
        }
    });
});
