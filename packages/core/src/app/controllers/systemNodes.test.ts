import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LIVE_PAGES_SQL, SystemNodes } from '../nodes';
import type { NodeRow } from '../nodes';
import { THEMES } from '../services/preferences';
import { call, Router, testContext } from '../testing';

import { registerSystemNodeRoutes } from './systemNodes';

let ctx: ReturnType<typeof testContext>;
let router: Router;

beforeEach(() => {
    ctx = testContext();
    router = new Router();
    registerSystemNodeRoutes(router, ctx);
});

afterEach(() => ctx.cleanup());

function node(id: string, parentId: string | null, content: string): string {
    ctx.documents().applyChanges([
        {
            type: 'node.set',
            payload: {
                id,
                page_id: parentId ?? id,
                fields: { parent_id: parentId, position: 'a0', content },
            },
        },
    ]);

    return id;
}

function rows(where: string, params: unknown[] = []): NodeRow[] {
    return ctx.db().all<NodeRow>(`SELECT * FROM nodes WHERE ${where}`, params);
}

function setSyncState(clientId: string, cloudUserId: string | null): void {
    ctx.db().run('DELETE FROM sync_state');
    ctx.db().run(
        'INSERT INTO sync_state (client_id, last_server_seq, cloud_user_id) VALUES (?, 0, ?)',
        [clientId, cloudUserId],
    );
}

function setCloudUser(cloudUserId: string | null): void {
    ctx.db().run('UPDATE sync_state SET cloud_user_id = ?', [cloudUserId]);
}

function unsyncedUpdates(): number {
    return ctx
        .db()
        .get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM document_updates WHERE cloud_seq IS NULL',
        )!.n;
}

describe('pins', () => {
    it('pins and unpins a page through synced nodes', async () => {
        const page = node(
            '00000000-0000-7000-8000-000000000001',
            null,
            'Saved page',
        );

        const empty = await call(router, 'GET', '/api/pins');
        expect(empty.status).toBe(200);
        expect(empty.json.items).toEqual([]);
        const rootId = empty.json.root_id;

        const pinned = await call(router, 'PUT', `/api/nodes/${page}/pin`);
        expect(pinned.status).toBe(200);
        expect(pinned.json.pinned).toBe(true);
        expect(pinned.json.item.id).toBe(page);

        expect(
            rows('id = ? AND parent_id IS NULL', [SystemNodes.PINS_ROOT_ID]),
        ).toHaveLength(1);
        expect(
            rows('id = ? AND parent_id = ?', [
                rootId,
                SystemNodes.PINS_ROOT_ID,
            ]),
        ).toHaveLength(1);
        expect(
            rows("parent_id = ? AND content = ? AND position = 'a0'", [
                rootId,
                page,
            ]),
        ).toHaveLength(1);
        expect(unsyncedUpdates()).toBeGreaterThan(0);

        const listing = await call(router, 'GET', '/api/pins');
        expect(listing.json.items[0].id).toBe(page);
        expect(listing.json.items[0].content).toBe('Saved page');

        const unpinned = await call(router, 'DELETE', `/api/nodes/${page}/pin`);
        expect(unpinned.status).toBe(200);
        expect(unpinned.json).toEqual({ pinned: false });

        expect((await call(router, 'GET', '/api/pins')).json.items).toEqual([]);
        const [entry] = rows('parent_id = ? AND content = ?', [rootId, page]);
        expect(entry.deleted_at).not.toBeNull();
    });

    it('pinning twice keeps a single entry', async () => {
        const page = node('00000000-0000-7000-8000-000000000006', null, 'Page');

        await call(router, 'PUT', `/api/nodes/${page}/pin`);
        await call(router, 'PUT', `/api/nodes/${page}/pin`);

        const rootId = (await call(router, 'GET', '/api/pins')).json.root_id;
        expect(
            rows('parent_id = ? AND deleted_at IS NULL', [rootId]),
        ).toHaveLength(1);
    });

    it('shows each cloud user only their own pin root', async () => {
        const first = node(
            '00000000-0000-7000-8000-000000000002',
            null,
            'First user page',
        );
        const second = node(
            '00000000-0000-7000-8000-000000000003',
            null,
            'Second user page',
        );
        setSyncState('00000000-0000-7000-8000-000000000099', 'user-a');

        const firstRoot = (await call(router, 'GET', '/api/pins')).json.root_id;
        expect(
            (await call(router, 'PUT', `/api/nodes/${first}/pin`)).status,
        ).toBe(200);

        setCloudUser('user-b');
        const secondListing = await call(router, 'GET', '/api/pins');
        const secondRoot = secondListing.json.root_id;
        expect(secondListing.json.items).toEqual([]);
        expect(secondRoot).not.toBe(firstRoot);

        expect(
            (await call(router, 'PUT', `/api/nodes/${second}/pin`)).status,
        ).toBe(200);
        expect((await call(router, 'GET', '/api/pins')).json.items[0].id).toBe(
            second,
        );

        setCloudUser('user-a');
        const back = await call(router, 'GET', '/api/pins');
        expect(back.json.root_id).toBe(firstRoot);
        expect(back.json.items.map((item: { id: string }) => item.id)).toEqual([
            first,
        ]);

        expect(rows('id = ?', [firstRoot])).toHaveLength(1);
        expect(rows('id = ?', [secondRoot])).toHaveLength(1);
    });

    it('adopts local pins once a cloud user is known', async () => {
        const page = node('00000000-0000-7000-8000-000000000007', null, 'Page');
        setSyncState('00000000-0000-7000-8000-000000000098', null);

        await call(router, 'PUT', `/api/nodes/${page}/pin`);
        const localRoot = (await call(router, 'GET', '/api/pins')).json.root_id;

        setCloudUser('user-a');
        const cloud = await call(router, 'GET', '/api/pins');
        expect(cloud.json.root_id).not.toBe(localRoot);
        expect(cloud.json.items.map((item: { id: string }) => item.id)).toEqual(
            [page],
        );
        expect(rows('id = ?', [localRoot])[0].deleted_at).not.toBeNull();
    });

    it('only pins top-level user pages', async () => {
        const page = node('00000000-0000-7000-8000-000000000004', null, 'Page');
        const child = node(
            '00000000-0000-7000-8000-000000000005',
            page,
            'Child',
        );

        expect(
            (await call(router, 'PUT', `/api/nodes/${child}/pin`)).status,
        ).toBe(404);

        await call(router, 'GET', '/api/pins');
        expect(
            (
                await call(
                    router,
                    'PUT',
                    `/api/nodes/${SystemNodes.PINS_ROOT_ID}/pin`,
                )
            ).status,
        ).toBe(404);

        // Once the system root exists it is still refused
        await call(router, 'PUT', `/api/nodes/${page}/pin`);
        expect(
            (
                await call(
                    router,
                    'PUT',
                    `/api/nodes/${SystemNodes.PINS_ROOT_ID}/pin`,
                )
            ).status,
        ).toBe(404);
        expect(
            (await call(router, 'PUT', '/api/nodes/missing/pin')).status,
        ).toBe(404);
    });

    it('reorders pins', async () => {
        const first = node(
            '00000000-0000-7000-8000-000000000010',
            null,
            'First',
        );
        const second = node(
            '00000000-0000-7000-8000-000000000011',
            null,
            'Second',
        );
        const third = node(
            '00000000-0000-7000-8000-000000000012',
            null,
            'Third',
        );

        for (const page of [first, second, third]) {
            expect(
                (await call(router, 'PUT', `/api/nodes/${page}/pin`)).status,
            ).toBe(200);
        }

        const rootId = (await call(router, 'GET', '/api/pins')).json.root_id;
        const reordered = await call(router, 'PUT', '/api/pins/order', {
            node_ids: [third, first, second],
        });
        expect(reordered.status).toBe(200);
        expect(reordered.json).toEqual({ reordered: true });

        const listing = await call(router, 'GET', '/api/pins');
        expect(
            listing.json.items.map((item: { id: string }) => item.id),
        ).toEqual([third, first, second]);

        const entries = ctx
            .db()
            .all<NodeRow>(
                'SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position',
                [rootId],
            );
        expect(entries.map((entry) => entry.content)).toEqual([
            third,
            first,
            second,
        ]);
    });

    it('rejects a stale or invalid pin order', async () => {
        const page = node('00000000-0000-7000-8000-000000000020', null, 'Page');
        await call(router, 'PUT', `/api/nodes/${page}/pin`);

        const stale = await call(router, 'PUT', '/api/pins/order', {
            node_ids: [],
        });
        expect(stale.status).toBe(422);
        expect(stale.json.errors.node_ids).toBeDefined();

        const missing = await call(router, 'PUT', '/api/pins/order', {});
        expect(missing.status).toBe(422);
        expect(missing.json.errors.node_ids).toBeDefined();

        const duplicate = await call(router, 'PUT', '/api/pins/order', {
            node_ids: [page, page],
        });
        expect(duplicate.status).toBe(422);
        expect(duplicate.json.errors['node_ids.0']).toBeDefined();

        const notUuid = await call(router, 'PUT', '/api/pins/order', {
            node_ids: ['nope'],
        });
        expect(notUuid.status).toBe(422);
        expect(notUuid.json.errors['node_ids.0']).toBeDefined();
    });

    it('keeps the pin system root out of the page list', async () => {
        const page = node(
            '00000000-0000-7000-8000-000000000030',
            null,
            'Saved page',
        );
        await call(router, 'PUT', `/api/nodes/${page}/pin`);

        const pages = rows(LIVE_PAGES_SQL).map((row) => row.id);
        expect(pages).toContain(page);
        expect(pages).not.toContain(SystemNodes.PINS_ROOT_ID);
    });
});

describe('collapsed nodes', () => {
    const PAGE = '00000000-0000-7000-8000-000000000001';
    const PARENT = '00000000-0000-7000-8000-000000000002';
    const CHILD = '00000000-0000-7000-8000-000000000003';

    function tree(): void {
        node(PAGE, null, 'Page');
        node(PARENT, PAGE, 'Parent');
        node(CHILD, PARENT, 'Child');
    }

    const update = (nodeIds: string[], collapsed: boolean) =>
        call(router, 'PUT', '/api/collapsed-nodes', {
            node_ids: nodeIds,
            collapsed,
        });

    it('stores collapse state as personal synced nodes', async () => {
        tree();

        const empty = await call(router, 'GET', '/api/collapsed-nodes');
        expect(empty.status).toBe(200);
        expect(empty.json.node_ids).toEqual([]);
        const rootId = empty.json.root_id;

        const collapsed = await update([PARENT], true);
        expect(collapsed.status).toBe(200);
        expect(collapsed.json.node_ids).toEqual([PARENT]);

        expect(
            rows('id = ? AND parent_id IS NULL', [
                SystemNodes.COLLAPSED_NODES_ROOT_ID,
            ]),
        ).toHaveLength(1);
        expect(
            rows('id = ? AND parent_id = ?', [
                rootId,
                SystemNodes.COLLAPSED_NODES_ROOT_ID,
            ]),
        ).toHaveLength(1);
        expect(
            rows('parent_id = ? AND content = ?', [rootId, PARENT]),
        ).toHaveLength(1);
        expect(unsyncedUpdates()).toBeGreaterThan(0);
    });

    it('expanding a node preserves descendant state', async () => {
        tree();

        expect((await update([PARENT], true)).status).toBe(200);
        expect((await update([CHILD], true)).status).toBe(200);
        const expanded = await update([PARENT], false);
        expect(expanded.status).toBe(200);
        expect(expanded.json.node_ids).toEqual([CHILD]);

        const rootId = (await call(router, 'GET', '/api/collapsed-nodes')).json
            .root_id;
        const [entry] = rows('parent_id = ? AND content = ?', [rootId, CHILD]);
        expect(entry.deleted_at).toBeNull();
    });

    it('collapsing a parent preserves descendant folds', async () => {
        tree();

        await update([CHILD], true);
        const response = await update([PARENT], true);

        expect([...response.json.node_ids].sort()).toEqual(
            [PARENT, CHILD].sort(),
        );
    });

    it('collapses and expands several nodes in one request', async () => {
        tree();

        const collapsed = await update([PARENT, CHILD], true);
        expect([...collapsed.json.node_ids].sort()).toEqual(
            [PARENT, CHILD].sort(),
        );

        const expanded = await update([PARENT, CHILD], false);
        expect(expanded.status).toBe(200);
        expect(expanded.json.node_ids).toEqual([]);
    });

    it('shows each cloud user only their own collapsed nodes', async () => {
        tree();
        setSyncState('00000000-0000-7000-8000-000000000099', 'user-a');

        const firstRoot = (await call(router, 'GET', '/api/collapsed-nodes'))
            .json.root_id;
        expect((await update([PARENT], true)).status).toBe(200);

        setCloudUser('user-b');
        const second = await call(router, 'GET', '/api/collapsed-nodes');
        expect(second.json.root_id).not.toBe(firstRoot);
        expect(second.json.node_ids).toEqual([]);

        expect((await update([CHILD], true)).status).toBe(200);

        setCloudUser('user-a');
        expect(
            (await call(router, 'GET', '/api/collapsed-nodes')).json.node_ids,
        ).toEqual([PARENT]);
    });

    it('refuses pages, system nodes, and unknown nodes', async () => {
        tree();

        expect((await update([PAGE], true)).status).toBe(404);
        expect((await update([PARENT, PAGE], true)).status).toBe(404);
        expect(
            (await update(['00000000-0000-7000-8000-0000000000ff'], true))
                .status,
        ).toBe(404);
        expect((await update([PARENT], true)).status).toBe(200);

        const pages = rows(LIVE_PAGES_SQL).map((row) => row.id);
        expect(pages).not.toContain(SystemNodes.COLLAPSED_NODES_ROOT_ID);
    });

    it('validates the request', async () => {
        expect(
            (
                await call(router, 'PUT', '/api/collapsed-nodes', {
                    collapsed: true,
                })
            ).json.errors.node_ids,
        ).toBeDefined();
        expect(
            (
                await call(router, 'PUT', '/api/collapsed-nodes', {
                    node_ids: [],
                    collapsed: true,
                })
            ).status,
        ).toBe(422);
        const noFlag = await call(router, 'PUT', '/api/collapsed-nodes', {
            node_ids: [PARENT],
        });
        expect(noFlag.status).toBe(422);
        expect(noFlag.json.errors.collapsed).toBeDefined();
    });
});

describe('preferences', () => {
    it('stores the theme in synced preference nodes', async () => {
        const empty = await call(router, 'GET', '/api/preferences');
        expect(empty.status).toBe(200);
        expect(empty.json.theme).toBeNull();
        const rootId = empty.json.root_id;

        const saved = await call(router, 'PUT', '/api/preferences/theme', {
            theme: 'light',
        });
        expect(saved.status).toBe(200);
        expect(saved.json.theme).toBe('light');

        expect(
            rows('id = ? AND parent_id IS NULL', [
                SystemNodes.PREFERENCES_ROOT_ID,
            ]),
        ).toHaveLength(1);
        expect(
            rows('id = ? AND parent_id = ?', [
                rootId,
                SystemNodes.PREFERENCES_ROOT_ID,
            ]),
        ).toHaveLength(1);
        expect(
            rows("parent_id = ? AND content = 'light'", [rootId]),
        ).toHaveLength(1);
        expect(unsyncedUpdates()).toBeGreaterThan(0);

        expect((await call(router, 'GET', '/api/preferences')).json.theme).toBe(
            'light',
        );
    });

    it('stores typography in synced preference nodes', async () => {
        const empty = await call(router, 'GET', '/api/preferences');
        expect(empty.json.font_family).toBeNull();
        expect(empty.json.font_size).toBeNull();
        const rootId = empty.json.root_id;

        const saved = await call(router, 'PUT', '/api/preferences/typography', {
            font_family: 'source-serif-4',
            font_size: 18,
        });
        expect(saved.status).toBe(200);
        expect(saved.json.font_family).toBe('source-serif-4');
        expect(saved.json.font_size).toBe(18);

        const entries = ctx
            .db()
            .all<NodeRow>(
                'SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position',
                [rootId],
            );
        expect(entries.map((entry) => entry.content)).toEqual([
            'source-serif-4',
            '18',
        ]);
    });

    it('stores the workspace storage choice', async () => {
        const empty = await call(router, 'GET', '/api/preferences');
        expect(empty.json.workspace_storage).toBeNull();
        const rootId = empty.json.root_id;

        const saved = await call(
            router,
            'PUT',
            '/api/preferences/workspace-storage',
            {
                workspace_storage: 'local',
            },
        );
        expect(saved.status).toBe(200);
        expect(saved.json.workspace_storage).toBe('local');
        expect(
            rows("parent_id = ? AND content = 'local'", [rootId]),
        ).toHaveLength(1);

        const invalid = await call(
            router,
            'PUT',
            '/api/preferences/workspace-storage',
            {
                workspace_storage: 'remote',
            },
        );
        expect(invalid.status).toBe(422);
        expect(invalid.json.errors.workspace_storage).toBeDefined();
    });

    it('scopes the theme to the active cloud user', async () => {
        setSyncState('00000000-0000-7000-8000-000000000099', 'user-a');

        expect(
            (
                await call(router, 'PUT', '/api/preferences/theme', {
                    theme: 'light',
                })
            ).status,
        ).toBe(200);
        const firstRoot = (await call(router, 'GET', '/api/preferences')).json
            .root_id;

        setCloudUser('user-b');
        const second = await call(router, 'GET', '/api/preferences');
        expect(second.json.theme).toBeNull();
        expect(second.json.root_id).not.toBe(firstRoot);

        expect(
            (
                await call(router, 'PUT', '/api/preferences/theme', {
                    theme: 'dark',
                })
            ).status,
        ).toBe(200);

        setCloudUser('user-a');
        const back = await call(router, 'GET', '/api/preferences');
        expect(back.json.root_id).toBe(firstRoot);
        expect(back.json.theme).toBe('light');
    });

    it('adopts local preferences when a cloud user is known', async () => {
        setSyncState('00000000-0000-7000-8000-000000000098', null);

        expect(
            (
                await call(router, 'PUT', '/api/preferences/theme', {
                    theme: 'light',
                })
            ).status,
        ).toBe(200);
        const localRoot = (await call(router, 'GET', '/api/preferences')).json
            .root_id;

        setCloudUser('user-a');
        const cloud = await call(router, 'GET', '/api/preferences');
        expect(cloud.json.theme).toBe('light');
        expect(cloud.json.root_id).not.toBe(localRoot);
        expect(rows('id = ?', [localRoot])[0].deleted_at).not.toBeNull();
    });

    it('creates a sync identity when there is none', async () => {
        expect(ctx.db().get('SELECT * FROM sync_state')).toBeUndefined();

        const first = (await call(router, 'GET', '/api/preferences')).json
            .root_id;
        const second = (await call(router, 'GET', '/api/preferences')).json
            .root_id;

        expect(first).toBe(second);
        expect(ctx.db().all('SELECT * FROM sync_state')).toHaveLength(1);
    });

    it('validates the theme and keeps the system root hidden', async () => {
        const invalid = await call(router, 'PUT', '/api/preferences/theme', {
            theme: 'sepia',
        });
        expect(invalid.status).toBe(422);
        expect(invalid.json.errors.theme).toBeDefined();

        expect(
            (
                await call(router, 'PUT', '/api/preferences/theme', {
                    theme: 'light',
                })
            ).status,
        ).toBe(200);
        expect(rows(LIVE_PAGES_SQL).map((row) => row.id)).not.toContain(
            SystemNodes.PREFERENCES_ROOT_ID,
        );
    });

    it('validates typography', async () => {
        const family = await call(
            router,
            'PUT',
            '/api/preferences/typography',
            {
                font_family: 'comic-sans',
                font_size: 16,
            },
        );
        expect(family.status).toBe(422);
        expect(family.json.errors.font_family).toBeDefined();

        const size = await call(router, 'PUT', '/api/preferences/typography', {
            font_family: 'instrument-sans',
            font_size: 23,
        });
        expect(size.status).toBe(422);
        expect(size.json.errors.font_size).toBeDefined();
    });

    it('accepts the bundled font families', async () => {
        for (const fontFamily of [
            'source-serif-4',
            'atkinson-hyperlegible',
            'jetbrains-mono',
        ]) {
            const response = await call(
                router,
                'PUT',
                '/api/preferences/typography',
                {
                    font_family: fontFamily,
                    font_size: 16,
                },
            );
            expect(response.status).toBe(200);
            expect(response.json.font_family).toBe(fontFamily);
        }
    });

    it('accepts and returns every named theme', async () => {
        for (const theme of THEMES) {
            const response = await call(
                router,
                'PUT',
                '/api/preferences/theme',
                { theme },
            );
            expect(response.status).toBe(200);
            expect(response.json.theme).toBe(theme);
        }
    });
});

describe('daily notes route', () => {
    it('opens the daily note for the active workspace', async () => {
        const response = await call(router, 'POST', '/api/daily-notes', {
            date: '2026-08-30',
        });

        expect(response.status).toBe(200);
        expect(response.json.date).toBe('2026-08-30');
        expect(rows('id = ?', [response.json.id])[0].content).toBe(
            'August 30, 2026',
        );
    });

    it('validates the date', async () => {
        for (const date of [
            undefined,
            '2026-02-30',
            '30-08-2026',
            '2026-8-3',
        ]) {
            const response = await call(
                router,
                'POST',
                '/api/daily-notes',
                date === undefined ? {} : { date },
            );
            expect(response.status).toBe(422);
            expect(response.json.errors.date).toBeDefined();
        }
    });
});
