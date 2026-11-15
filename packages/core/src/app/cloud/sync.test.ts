import { afterEach, describe, expect, it } from 'vitest';

import { Meta } from '../../db/meta';
import { createPage, outline, setBlocks } from '../../documents/testing';
import { updatePageMeta } from '../../loro/pageMeta';
import { uuidv7 } from '../../support/ids';
import type { AppContext } from '../context';
import { LOCAL_USER_DOCUMENT_ID, pinsList } from '../services/userDocument';
import { testContext } from '../testing';

import { CLOUD, fakeRelay, WORKSPACE } from './fakeCloud';
import { CloudError } from './http';
import { CloudSync } from './sync';
import type { CloudCredentials } from './sync';

const contexts: ReturnType<typeof testContext>[] = [];

function device() {
    const ctx = testContext();
    contexts.push(ctx);

    return ctx;
}

afterEach(() => {
    while (contexts.length > 0) {
        contexts.pop()!.cleanup();
    }
});

function page(ctx: AppContext, title: string, blocks: string[] = []): string {
    return createPage(ctx.documents(), title, {
        blocks: blocks.map((text) => ({ text })),
    });
}

/** The read model's pages and blocks, comparable across devices. */
function snapshot(ctx: AppContext) {
    return {
        pages: ctx.db().all('SELECT id, title FROM pages ORDER BY id'),
        blocks: ctx
            .db()
            .all('SELECT id, page_id, text FROM blocks ORDER BY id'),
    };
}

const signedIn: CloudCredentials = { url: CLOUD, token: 'token' };

const syncOf = (
    ctx: AppContext,
    relay: ReturnType<typeof fakeRelay>,
    credentials: CloudCredentials | null = signedIn,
) => new CloudSync(ctx.db(), ctx.documents(), relay.fetch, () => credentials);

const outboxCount = (ctx: AppContext) =>
    ctx
        .db()
        .get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM document_updates WHERE cloud_seq IS NULL',
        )!.n;

describe('CloudSync', () => {
    it('seeds an empty cloud workspace and bootstraps an empty device from it', async () => {
        const relay = fakeRelay();
        const a = device();
        const pageId = page(
            a,
            'Inbox',
            [0, 1, 2, 3, 4].map((i) => `Block ${i}`),
        );

        const seeded = await syncOf(a, relay).connect(WORKSPACE);

        expect(seeded).toMatchObject({
            seeded: true,
            bootstrapped: false,
            ok: true,
        });
        expect(relay.log.length).toBeGreaterThan(0);
        expect(outboxCount(a)).toBe(0);

        const meta = new Meta(a.db());
        expect(meta.get('cloud_workspace_id')).toBe(WORKSPACE);
        expect(meta.get('cloud_user_id')).toBe('1');
        expect(meta.number('cloud_cursor')).toBe(relay.log.at(-1)!.server_seq);
        // The token stays in the account file
        expect(
            a.db().all('SELECT key FROM meta WHERE value = ?', ['token']),
        ).toEqual([]);

        const b = device();
        const bootstrapped = await syncOf(b, relay).connect(WORKSPACE);

        expect(bootstrapped).toMatchObject({
            seeded: false,
            bootstrapped: true,
            ok: true,
        });
        expect(snapshot(b)).toEqual(snapshot(a));
        expect(snapshot(b).blocks).toHaveLength(5);
        expect(outline(b.documents(), pageId)).toEqual(
            outline(a.documents(), pageId),
        );
        // Pulled updates keep the device that made them as their origin
        expect(
            b
                .db()
                .all<{ origin: string }>(
                    'SELECT DISTINCT origin FROM document_updates',
                )
                .map((row) => row.origin),
        ).toEqual([new Meta(a.db()).deviceId()]);
    });

    it('converges concurrent edits made on two paired devices', async () => {
        const relay = fakeRelay();
        const a = device();
        const pageId = page(a, 'Shared', ['first']);
        const syncA = syncOf(a, relay);
        await syncA.connect(WORKSPACE);

        const b = device();
        const syncB = syncOf(b, relay);
        await syncB.connect(WORKSPACE);

        // Offline on both sides at once
        a.documents().edit(pageId, (doc) =>
            updatePageMeta(doc, { title: 'Renamed on A' }),
        );
        setBlocks(b.documents(), pageId, [
            { id: snapshot(b).blocks[0].id as string, text: 'first' },
            { text: 'added on B' },
        ]);
        const otherPage = page(b, 'Only on B');

        await syncA.exchange();
        await syncB.exchange();
        await syncA.exchange();

        expect(snapshot(a)).toEqual(snapshot(b));
        expect(snapshot(a).pages.map((row) => row.title)).toEqual(
            expect.arrayContaining(['Renamed on A', 'Only on B']),
        );
        expect(outline(a.documents(), pageId)).toEqual(['first', 'added on B']);
        expect(snapshot(a).pages.some((row) => row.id === otherPage)).toBe(
            true,
        );
    });

    it('pushes nothing back that it pulled, and pulls nothing it pushed', async () => {
        const relay = fakeRelay();
        const a = device();
        page(a, 'One');
        await syncOf(a, relay).connect(WORKSPACE);
        const b = device();
        const syncB = syncOf(b, relay);
        await syncB.connect(WORKSPACE);
        const before = relay.log.length;

        const again = await syncB.exchange();

        expect(again).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
        expect(relay.log.length).toBe(before);
    });

    it('refuses to pair when both sides already have notes', async () => {
        const relay = fakeRelay();
        const a = device();
        page(a, 'From A');
        await syncOf(a, relay).connect(WORKSPACE);

        const c = device();
        page(c, 'From C');

        await expect(syncOf(c, relay).connect(WORKSPACE)).rejects.toThrow(
            CloudError,
        );
        expect(syncOf(c, relay).configured()).toBe(false);
        expect(new Meta(c.db()).get('cloud_workspace_id')).toBeNull();
    });

    it('never pushes user:local, and does not count it as notes when pairing', async () => {
        const relay = fakeRelay();
        const a = device();
        page(a, 'From A');
        await syncOf(a, relay).connect(WORKSPACE);

        const b = device();
        b.documents().edit(LOCAL_USER_DOCUMENT_ID, (doc) =>
            pinsList(doc).push(uuidv7()),
        );
        const syncB = syncOf(b, relay);

        await expect(syncB.connect(WORKSPACE)).resolves.toMatchObject({
            bootstrapped: true,
            ok: true,
        });

        b.documents().edit(LOCAL_USER_DOCUMENT_ID, (doc) =>
            pinsList(doc).push(uuidv7()),
        );
        b.documents().edit('user:1', (doc) => pinsList(doc).push(uuidv7()));
        await syncB.exchange();

        expect(relay.log.map((row) => row.document_id)).not.toContain(
            LOCAL_USER_DOCUMENT_ID,
        );
        expect(relay.log.map((row) => row.document_id)).toContain('user:1');
        expect(syncB.status()).toMatchObject({ outbox: 0 });
    });

    it('needs a signed-in account to pair or sync', async () => {
        const relay = fakeRelay();
        const a = device();
        page(a, 'Signed out');

        await expect(syncOf(a, relay, null).connect(WORKSPACE)).rejects.toThrow(
            /Sign in/,
        );

        await syncOf(a, relay).connect(WORKSPACE);
        const signedOut = syncOf(a, relay, null);

        expect(signedOut.configured()).toBe(false);
        expect(signedOut.status()).toMatchObject({
            configured: false,
            health: 'unconfigured',
            workspace_id: WORKSPACE,
        });
        await expect(signedOut.exchange()).resolves.toMatchObject({
            configured: false,
            ok: false,
        });
    });

    it('keeps the outbox while offline and records the error', async () => {
        const relay = fakeRelay();
        const a = device();
        const pageId = page(a, 'Offline');
        const sync = syncOf(a, relay);
        await sync.connect(WORKSPACE);
        expect(sync.status()).toMatchObject({
            configured: true,
            health: 'healthy',
            cloud_url: CLOUD,
        });

        relay.setOffline(true);
        a.documents().edit(pageId, (doc) =>
            updatePageMeta(doc, { title: 'renamed offline' }),
        );
        const failed = await sync.exchange();

        expect(failed.ok).toBe(false);
        expect(sync.status()).toMatchObject({ health: 'error', outbox: 1 });
        expect(new Meta(a.db()).get('cloud_last_error')).toMatch(/Push failed/);

        relay.setOffline(false);
        const recovered = await sync.exchange();

        expect(recovered).toMatchObject({ ok: true, pushed: 1 });
        expect(sync.status()).toMatchObject({ health: 'healthy', outbox: 0 });
        expect(new Meta(a.db()).get('cloud_last_error')).toBeNull();
    });

    it("signs only this workspace's sync and page presence channels", async () => {
        const relay = fakeRelay();
        const a = device();
        const sync = syncOf(a, relay);
        await sync.connect(WORKSPACE);

        await expect(
            sync.authorizeRealtime(
                '1.2',
                `private-workspaces.${WORKSPACE}.sync`,
            ),
        ).resolves.toMatchObject({ auth: 'key:signature' });
        await expect(
            sync.authorizeRealtime(
                '1.2',
                `presence-workspaces.${WORKSPACE}.documents.${uuidv7()}`,
            ),
        ).resolves.toMatchObject({ auth: 'key:signature' });

        for (const channel of [
            `presence-workspaces.${uuidv7()}.documents.${uuidv7()}`,
            `private-workspaces.${uuidv7()}.sync`,
            `presence-workspaces.${WORKSPACE}.documents.x.y`,
        ]) {
            await expect(
                sync.authorizeRealtime('1.2', channel),
            ).rejects.toThrow(CloudError);
        }
    });
});
