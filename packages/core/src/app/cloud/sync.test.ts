import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../support/ids';
import type { AppContext } from '../context';
import { testContext } from '../testing';

import { CLOUD, fakeRelay, WORKSPACE } from './fakeCloud';
import { CloudError } from './http';
import { CloudSync } from './sync';

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

function setNode(
    ctx: AppContext,
    id: string,
    pageId: string,
    fields: Record<string, unknown>,
): void {
    ctx.documents().applyChanges([
        { type: 'node.set', payload: { id, page_id: pageId, fields } },
    ]);
}

function page(ctx: AppContext, title: string): string {
    const id = uuidv7();
    setNode(ctx, id, id, { parent_id: null, position: 'a0', content: title });

    return id;
}

/** The projected live tree, comparable across devices. */
function snapshot(ctx: AppContext) {
    return ctx.db().all(
        `SELECT id, parent_id, position, content FROM nodes
             WHERE deleted_at IS NULL ORDER BY id`,
    );
}

const syncOf = (ctx: AppContext, relay: ReturnType<typeof fakeRelay>) =>
    new CloudSync(ctx.db(), ctx.documents(), relay.fetch);

describe('CloudSync', () => {
    it('seeds an empty cloud workspace and bootstraps an empty device from it', async () => {
        const relay = fakeRelay();
        const a = device();
        const pageId = page(a, 'Inbox');

        for (let i = 0; i < 5; i++) {
            setNode(a, uuidv7(), pageId, {
                parent_id: pageId,
                position: `a${i}`,
                content: `Block ${i}`,
            });
        }

        const seeded = await syncOf(a, relay).connect(
            `${CLOUD}/`,
            'token',
            WORKSPACE,
        );

        expect(seeded).toMatchObject({
            seeded: true,
            bootstrapped: false,
            ok: true,
        });
        expect(relay.log.length).toBeGreaterThan(0);
        expect(
            a
                .db()
                .get(
                    'SELECT COUNT(*) AS n FROM document_updates WHERE cloud_seq IS NULL',
                ),
        ).toEqual({ n: 0 });

        const b = device();
        const bootstrapped = await syncOf(b, relay).connect(
            CLOUD,
            'token',
            WORKSPACE,
        );

        expect(bootstrapped).toMatchObject({
            seeded: false,
            bootstrapped: true,
            ok: true,
        });
        expect(snapshot(b)).toEqual(snapshot(a));
        expect(snapshot(b)).toHaveLength(6);
    });

    it('converges concurrent edits made on two paired devices', async () => {
        const relay = fakeRelay();
        const a = device();
        const pageId = page(a, 'Shared');
        const blockId = uuidv7();
        setNode(a, blockId, pageId, {
            parent_id: pageId,
            position: 'a0',
            content: 'first',
        });
        const syncA = syncOf(a, relay);
        await syncA.connect(CLOUD, 'token', WORKSPACE);

        const b = device();
        const syncB = syncOf(b, relay);
        await syncB.connect(CLOUD, 'token', WORKSPACE);

        // Offline on both sides at once
        setNode(a, blockId, pageId, { content: 'edited on A' });
        setNode(b, uuidv7(), pageId, {
            parent_id: pageId,
            position: 'a1',
            content: 'added on B',
        });
        const otherPage = page(b, 'Only on B');

        await syncA.exchange();
        await syncB.exchange();
        await syncA.exchange();

        expect(snapshot(a)).toEqual(snapshot(b));
        expect(snapshot(a).map((row) => row.content)).toEqual(
            expect.arrayContaining(['edited on A', 'added on B', 'Only on B']),
        );
        expect(snapshot(a).some((row) => row.id === otherPage)).toBe(true);
    });

    it('pushes nothing back that it pulled, and pulls nothing it pushed', async () => {
        const relay = fakeRelay();
        const a = device();
        page(a, 'One');
        await syncOf(a, relay).connect(CLOUD, 'token', WORKSPACE);
        const b = device();
        const syncB = syncOf(b, relay);
        await syncB.connect(CLOUD, 'token', WORKSPACE);
        const before = relay.log.length;

        const again = await syncB.exchange();

        expect(again).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
        expect(relay.log.length).toBe(before);
    });

    it('refuses to pair when both sides already have notes', async () => {
        const relay = fakeRelay();
        const a = device();
        page(a, 'From A');
        await syncOf(a, relay).connect(CLOUD, 'token', WORKSPACE);

        const c = device();
        page(c, 'From C');

        await expect(
            syncOf(c, relay).connect(CLOUD, 'token', WORKSPACE),
        ).rejects.toThrow(CloudError);
        expect(syncOf(c, relay).configured()).toBe(false);
    });

    it('keeps the outbox while offline and records the error', async () => {
        const relay = fakeRelay();
        const a = device();
        const pageId = page(a, 'Offline');
        const sync = syncOf(a, relay);
        await sync.connect(CLOUD, 'token', WORKSPACE);

        relay.setOffline(true);
        setNode(a, pageId, pageId, { content: 'renamed offline' });
        const failed = await sync.exchange();

        expect(failed.ok).toBe(false);
        expect(sync.status()).toMatchObject({ health: 'error', outbox: 1 });

        relay.setOffline(false);
        const recovered = await sync.exchange();

        expect(recovered).toMatchObject({ ok: true, pushed: 1 });
        expect(sync.status()).toMatchObject({ health: 'healthy', outbox: 0 });
    });

    it("signs only this workspace's sync and page presence channels", async () => {
        const relay = fakeRelay();
        const a = device();
        const sync = syncOf(a, relay);
        await sync.connect(CLOUD, 'token', WORKSPACE);

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
