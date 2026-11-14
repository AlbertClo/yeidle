import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../support/ids';
import type { AppContext } from '../context';
import { testContext } from '../testing';

import { CloudError } from './http';
import type { CloudFetch } from './http';
import { CloudSync } from './sync';

const WORKSPACE = '00000000-0000-7000-8000-000000000001';
const CLOUD = 'http://cloud.test';

/** An in-memory stand-in for the Laravel relay (same request/response shapes). */
function fakeRelay() {
    const log: {
        server_seq: number;
        document_id: string;
        update_id: string;
        device_id: string;
        bytes: string;
    }[] = [];
    let offline = false;

    const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });

    const fetchImpl: CloudFetch = async (input, init) => {
        if (offline) {
            throw new TypeError('fetch failed');
        }

        const url = new URL(input);
        const base = `/api/workspaces/${WORKSPACE}/documents`;
        const latest = log.at(-1)?.server_seq ?? 0;

        if (url.pathname === `${base}/status`) {
            return respond(200, {
                workspace_id: WORKSPACE,
                user_id: '1',
                latest_seq: latest,
                realtime: { enabled: false },
            });
        }

        if (url.pathname === `${base}/updates` && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as {
                device_id: string;
                updates: {
                    update_id: string;
                    document_id: string;
                    bytes: string;
                }[];
            };
            const accepted = body.updates.map((update) => {
                let row = log.find((r) => r.update_id === update.update_id);

                if (!row) {
                    row = {
                        ...update,
                        device_id: body.device_id,
                        server_seq: (log.at(-1)?.server_seq ?? 0) + 1,
                    };
                    log.push(row);
                }

                return { update_id: row.update_id, server_seq: row.server_seq };
            });

            return respond(200, { accepted });
        }

        if (url.pathname === `${base}/updates`) {
            const since = Number(url.searchParams.get('since'));
            const exclude = url.searchParams.get('exclude_device');
            const limit = 3; // small pages exercise has_more
            const rows = log.filter(
                (row) => row.server_seq > since && row.device_id !== exclude,
            );
            const page = rows.slice(0, limit);
            const hasMore = rows.length > limit;

            return respond(200, {
                updates: page,
                cursor: hasMore
                    ? page.at(-1)!.server_seq
                    : Math.max(since, latest),
                latest_seq: latest,
                has_more: hasMore,
            });
        }

        return respond(404, { message: 'Not found' });
    };

    return {
        log,
        fetch: fetchImpl,
        setOffline(value: boolean) {
            offline = value;
        },
    };
}

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
});
