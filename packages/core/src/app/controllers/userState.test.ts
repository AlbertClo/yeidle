import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Meta } from '../../db/meta';
import { createPage, deletePage, setBlocks } from '../../documents/testing';
import { findPage } from '../pages';
import { dailyNotePageId } from '../services/dailyNotes';
import { THEMES } from '../services/preferences';
import {
    collapsedMap,
    LOCAL_USER_DOCUMENT_ID,
    pinsList,
    preferencesMap,
} from '../services/userDocument';
import { call, Router, testContext } from '../testing';

import { registerUserStateRoutes } from './userState';

let ctx: ReturnType<typeof testContext>;
let router: Router;

beforeEach(() => {
    ctx = testContext();
    router = new Router();
    registerUserStateRoutes(router, ctx);
});

afterEach(() => ctx.cleanup());

function page(id: string, title: string): string {
    return createPage(ctx.documents(), title, { id });
}

/** Signs in as a cloud user (the workspace's paired user), or out with null. */
function setCloudUser(cloudUserId: string | null): void {
    new Meta(ctx.db()).set('cloud_user_id', cloudUserId);
}

function userDocument(id = LOCAL_USER_DOCUMENT_ID) {
    return ctx.documents().read(id);
}

function pinned(id = LOCAL_USER_DOCUMENT_ID): string[] {
    return pinsList(userDocument(id)).toArray() as string[];
}

function unsyncedUpdates(documentId: string): number {
    return ctx
        .db()
        .get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM document_updates WHERE document_id = ? AND cloud_seq IS NULL',
            [documentId],
        )!.n;
}

const ids = (response: { json: { items: { id: string }[] } }) =>
    response.json.items.map((item) => item.id);

describe('pins', () => {
    it('pins and unpins a page in the user document', async () => {
        const id = page('00000000-0000-7000-8000-000000000001', 'Saved page');

        const empty = await call(router, 'GET', '/api/pins');
        expect(empty.status).toBe(200);
        expect(empty.json).toEqual({ items: [] });

        const pinnedResponse = await call(
            router,
            'PUT',
            `/api/pages/${id}/pin`,
        );
        expect(pinnedResponse.status).toBe(200);
        expect(pinnedResponse.json).toEqual({
            pinned: true,
            item: findPage(ctx.db(), id),
        });
        expect(pinned()).toEqual([id]);
        expect(unsyncedUpdates(LOCAL_USER_DOCUMENT_ID)).toBeGreaterThan(0);

        const listing = await call(router, 'GET', '/api/pins');
        expect(listing.json.items).toEqual([findPage(ctx.db(), id)]);
        expect(listing.json.items[0].title).toBe('Saved page');

        const unpinned = await call(router, 'DELETE', `/api/pages/${id}/pin`);
        expect(unpinned.status).toBe(200);
        expect(unpinned.json).toEqual({ pinned: false });

        expect((await call(router, 'GET', '/api/pins')).json.items).toEqual([]);
        expect(pinned()).toEqual([]);
    });

    it('pinning twice keeps a single entry', async () => {
        const id = page('00000000-0000-7000-8000-000000000006', 'Page');

        await call(router, 'PUT', `/api/pages/${id}/pin`);
        await call(router, 'PUT', `/api/pages/${id}/pin`);

        expect(pinned()).toEqual([id]);
    });

    it('unpinning a page that is not pinned succeeds without writing', async () => {
        const id = page('00000000-0000-7000-8000-000000000007', 'Page');
        const before = unsyncedUpdates(LOCAL_USER_DOCUMENT_ID);

        const response = await call(router, 'DELETE', `/api/pages/${id}/pin`);

        expect(response.status).toBe(200);
        expect(response.json).toEqual({ pinned: false });
        expect(unsyncedUpdates(LOCAL_USER_DOCUMENT_ID)).toBe(before);
    });

    it('only pins pages', async () => {
        const id = page('00000000-0000-7000-8000-000000000004', 'Page');
        const [block] = setBlocks(ctx.documents(), id, [{ text: 'Child' }]);

        expect(
            (await call(router, 'PUT', `/api/pages/${block}/pin`)).status,
        ).toBe(404);
        expect(
            (await call(router, 'PUT', '/api/pages/missing/pin')).status,
        ).toBe(404);
        expect(pinned()).toEqual([]);
    });

    it('leaves deleted pages out of the listing', async () => {
        const kept = page('00000000-0000-7000-8000-000000000008', 'Kept');
        const gone = page('00000000-0000-7000-8000-000000000009', 'Gone');
        await call(router, 'PUT', `/api/pages/${gone}/pin`);
        await call(router, 'PUT', `/api/pages/${kept}/pin`);

        deletePage(ctx.documents(), gone);

        expect(ids(await call(router, 'GET', '/api/pins'))).toEqual([kept]);
        expect(
            (
                await call(router, 'PUT', '/api/pins/order', {
                    page_ids: [kept],
                })
            ).status,
        ).toBe(200);
    });

    it('reorders pins', async () => {
        const first = page('00000000-0000-7000-8000-000000000010', 'First');
        const second = page('00000000-0000-7000-8000-000000000011', 'Second');
        const third = page('00000000-0000-7000-8000-000000000012', 'Third');

        for (const id of [first, second, third]) {
            expect(
                (await call(router, 'PUT', `/api/pages/${id}/pin`)).status,
            ).toBe(200);
        }

        const reordered = await call(router, 'PUT', '/api/pins/order', {
            page_ids: [third, first, second],
        });
        expect(reordered.status).toBe(200);
        expect(reordered.json).toEqual({ reordered: true });

        expect(ids(await call(router, 'GET', '/api/pins'))).toEqual([
            third,
            first,
            second,
        ]);
        expect(pinned()).toEqual([third, first, second]);
    });

    it('rejects a stale or invalid pin order', async () => {
        const id = page('00000000-0000-7000-8000-000000000020', 'Page');
        const other = page('00000000-0000-7000-8000-000000000021', 'Other');
        await call(router, 'PUT', `/api/pages/${id}/pin`);

        for (const pageIds of [[], [other], [id, other]]) {
            const stale = await call(router, 'PUT', '/api/pins/order', {
                page_ids: pageIds,
            });
            expect(stale.status).toBe(422);
            expect(stale.json.errors.page_ids).toEqual([
                'The pinned list changed. Reload it and try again.',
            ]);
        }

        const missing = await call(router, 'PUT', '/api/pins/order', {});
        expect(missing.status).toBe(422);
        expect(missing.json.errors.page_ids).toBeDefined();

        const notArray = await call(router, 'PUT', '/api/pins/order', {
            page_ids: id,
        });
        expect(notArray.status).toBe(422);
        expect(notArray.json.errors.page_ids).toBeDefined();

        const duplicate = await call(router, 'PUT', '/api/pins/order', {
            page_ids: [id, id],
        });
        expect(duplicate.status).toBe(422);
        expect(duplicate.json.errors['page_ids.0']).toBeDefined();

        const notUuid = await call(router, 'PUT', '/api/pins/order', {
            page_ids: ['nope'],
        });
        expect(notUuid.status).toBe(422);
        expect(notUuid.json.errors['page_ids.0']).toBeDefined();

        expect(pinned()).toEqual([id]);
    });

    it('shows each cloud user only their own pins', async () => {
        const first = page('00000000-0000-7000-8000-000000000002', 'First');
        const second = page('00000000-0000-7000-8000-000000000003', 'Second');

        setCloudUser('user-a');
        expect(
            (await call(router, 'PUT', `/api/pages/${first}/pin`)).status,
        ).toBe(200);

        setCloudUser('user-b');
        expect((await call(router, 'GET', '/api/pins')).json.items).toEqual([]);
        expect(
            (await call(router, 'PUT', `/api/pages/${second}/pin`)).status,
        ).toBe(200);
        expect(ids(await call(router, 'GET', '/api/pins'))).toEqual([second]);

        setCloudUser('user-a');
        expect(ids(await call(router, 'GET', '/api/pins'))).toEqual([first]);

        expect(pinned('user:user-a')).toEqual([first]);
        expect(pinned('user:user-b')).toEqual([second]);
        expect(ctx.documents().store.exists(LOCAL_USER_DOCUMENT_ID)).toBe(
            false,
        );
    });
});

describe('collapsed blocks', () => {
    const PAGE = '00000000-0000-7000-8000-000000000001';
    const PARENT = '00000000-0000-7000-8000-000000000002';
    const CHILD = '00000000-0000-7000-8000-000000000003';

    beforeEach(() => {
        createPage(ctx.documents(), 'Page', {
            id: PAGE,
            blocks: [
                {
                    id: PARENT,
                    text: 'Parent',
                    children: [{ id: CHILD, text: 'Child' }],
                },
            ],
        });
    });

    const update = (blockIds: unknown, collapsed: unknown) =>
        call(router, 'PUT', '/api/collapsed-blocks', {
            block_ids: blockIds,
            collapsed,
        });

    it('stores collapse state in the user document', async () => {
        const empty = await call(router, 'GET', '/api/collapsed-blocks');
        expect(empty.status).toBe(200);
        expect(empty.json).toEqual({ block_ids: [] });

        const collapsed = await update([PARENT], true);
        expect(collapsed.status).toBe(200);
        expect(collapsed.json).toEqual({ block_ids: [PARENT] });

        expect(collapsedMap(userDocument()).toJSON()).toEqual({
            [PARENT]: true,
        });
        expect(unsyncedUpdates(LOCAL_USER_DOCUMENT_ID)).toBeGreaterThan(0);
        expect(
            (await call(router, 'GET', '/api/collapsed-blocks')).json.block_ids,
        ).toEqual([PARENT]);
    });

    it('expanding a block preserves descendant state', async () => {
        expect((await update([PARENT], true)).status).toBe(200);
        expect((await update([CHILD], true)).status).toBe(200);

        const expanded = await update([PARENT], false);
        expect(expanded.status).toBe(200);
        expect(expanded.json.block_ids).toEqual([CHILD]);
        expect(collapsedMap(userDocument()).keys()).toEqual([CHILD]);
    });

    it('collapsing a parent preserves descendant folds', async () => {
        await update([CHILD], true);
        const response = await update([PARENT], true);

        expect(response.json.block_ids).toEqual([PARENT, CHILD].sort());
    });

    it('collapses and expands several blocks in one request', async () => {
        const collapsed = await update([PARENT, CHILD], true);
        expect(collapsed.json.block_ids).toEqual([PARENT, CHILD].sort());

        const expanded = await update([PARENT, CHILD], '0');
        expect(expanded.status).toBe(200);
        expect(expanded.json.block_ids).toEqual([]);
    });

    it('shows each cloud user only their own collapsed blocks', async () => {
        setCloudUser('user-a');
        expect((await update([PARENT], true)).status).toBe(200);

        setCloudUser('user-b');
        expect(
            (await call(router, 'GET', '/api/collapsed-blocks')).json.block_ids,
        ).toEqual([]);
        expect((await update([CHILD], true)).status).toBe(200);

        setCloudUser('user-a');
        expect(
            (await call(router, 'GET', '/api/collapsed-blocks')).json.block_ids,
        ).toEqual([PARENT]);
    });

    it('validates the request', async () => {
        const missing = await call(router, 'PUT', '/api/collapsed-blocks', {
            collapsed: true,
        });
        expect(missing.status).toBe(422);
        expect(missing.json.errors.block_ids).toBeDefined();

        expect((await update([], true)).status).toBe(422);
        expect(
            (await update(PARENT, true)).json.errors.block_ids,
        ).toBeDefined();

        const notUuid = await update(['nope'], true);
        expect(notUuid.status).toBe(422);
        expect(notUuid.json.errors['block_ids.0']).toBeDefined();

        const duplicate = await update([PARENT, PARENT], true);
        expect(duplicate.status).toBe(422);
        expect(duplicate.json.errors['block_ids.0']).toBeDefined();

        const noFlag = await call(router, 'PUT', '/api/collapsed-blocks', {
            block_ids: [PARENT],
        });
        expect(noFlag.status).toBe(422);
        expect(noFlag.json.errors.collapsed).toBeDefined();

        const badFlag = await update([PARENT], 'yes');
        expect(badFlag.status).toBe(422);
        expect(badFlag.json.errors.collapsed).toBeDefined();

        expect(collapsedMap(userDocument()).keys()).toEqual([]);
    });
});

describe('preferences', () => {
    const EMPTY = {
        theme: null,
        font_family: null,
        font_size: null,
        workspace_storage: null,
    };

    it('stores the theme in the user document', async () => {
        const empty = await call(router, 'GET', '/api/preferences');
        expect(empty.status).toBe(200);
        expect(empty.json).toEqual(EMPTY);

        const saved = await call(router, 'PUT', '/api/preferences/theme', {
            theme: 'light',
        });
        expect(saved.status).toBe(200);
        expect(saved.json).toEqual({ ...EMPTY, theme: 'light' });

        expect(preferencesMap(userDocument()).get('theme')).toBe('light');
        expect(unsyncedUpdates(LOCAL_USER_DOCUMENT_ID)).toBeGreaterThan(0);
        expect((await call(router, 'GET', '/api/preferences')).json.theme).toBe(
            'light',
        );
    });

    it('stores typography in the user document', async () => {
        const saved = await call(router, 'PUT', '/api/preferences/typography', {
            font_family: 'source-serif-4',
            font_size: '18',
        });
        expect(saved.status).toBe(200);
        expect(saved.json).toEqual({
            ...EMPTY,
            font_family: 'source-serif-4',
            font_size: 18,
        });

        expect(preferencesMap(userDocument()).toJSON()).toEqual({
            font_family: 'source-serif-4',
            font_size: 18,
        });
    });

    it('stores the workspace storage choice', async () => {
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
        expect(preferencesMap(userDocument()).get('workspace_storage')).toBe(
            'local',
        );

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

    it('ignores values in the document that are not valid preferences', async () => {
        ctx.documents().edit(LOCAL_USER_DOCUMENT_ID, (doc) => {
            const map = preferencesMap(doc);
            map.set('theme', 'sepia');
            map.set('font_size', 99);
            map.set('font_family', 'monospace');
        });

        expect((await call(router, 'GET', '/api/preferences')).json).toEqual(
            EMPTY,
        );
    });

    it('scopes preferences to the active cloud user', async () => {
        setCloudUser('user-a');
        expect(
            (
                await call(router, 'PUT', '/api/preferences/theme', {
                    theme: 'light',
                })
            ).status,
        ).toBe(200);

        setCloudUser('user-b');
        expect(
            (await call(router, 'GET', '/api/preferences')).json.theme,
        ).toBeNull();
        expect(
            (
                await call(router, 'PUT', '/api/preferences/theme', {
                    theme: 'dark',
                })
            ).status,
        ).toBe(200);

        setCloudUser('user-a');
        expect((await call(router, 'GET', '/api/preferences')).json.theme).toBe(
            'light',
        );
        expect(preferencesMap(userDocument('user:user-b')).get('theme')).toBe(
            'dark',
        );
    });

    it('validates the theme', async () => {
        const invalid = await call(router, 'PUT', '/api/preferences/theme', {
            theme: 'sepia',
        });
        expect(invalid.status).toBe(422);
        expect(invalid.json.errors.theme).toBeDefined();
        expect(
            (await call(router, 'PUT', '/api/preferences/theme', {})).json
                .errors.theme,
        ).toBeDefined();
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

        for (const fontSize of [23, 11, 16.5, 'big', undefined]) {
            const size = await call(
                router,
                'PUT',
                '/api/preferences/typography',
                {
                    font_family: 'instrument-sans',
                    font_size: fontSize,
                },
            );
            expect(size.status).toBe(422);
            expect(size.json.errors.font_size).toBeDefined();
        }

        expect(preferencesMap(userDocument()).keys()).toEqual([]);
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

describe('signing in', () => {
    const OWN = '00000000-0000-7000-8000-000000000001';
    const SHARED = '00000000-0000-7000-8000-000000000002';
    const LOCAL = '00000000-0000-7000-8000-000000000003';
    const BLOCK = '00000000-0000-7000-8000-000000000004';

    it('merges what was saved before sign-in into the user document', async () => {
        page(OWN, 'Own');
        page(SHARED, 'Shared');
        page(LOCAL, 'Local');

        // The cloud user's own state, from an earlier session
        setCloudUser('user-a');
        await call(router, 'PUT', `/api/pages/${OWN}/pin`);
        await call(router, 'PUT', `/api/pages/${SHARED}/pin`);
        await call(router, 'PUT', '/api/preferences/theme', { theme: 'dark' });

        // Signed out: saved locally
        setCloudUser(null);
        await call(router, 'PUT', `/api/pages/${LOCAL}/pin`);
        await call(router, 'PUT', `/api/pages/${SHARED}/pin`);
        await call(router, 'PUT', '/api/preferences/theme', { theme: 'light' });
        await call(router, 'PUT', '/api/preferences/typography', {
            font_family: 'jetbrains-mono',
            font_size: 14,
        });
        await call(router, 'PUT', '/api/preferences/workspace-storage', {
            workspace_storage: 'local',
        });
        await call(router, 'PUT', '/api/collapsed-blocks', {
            block_ids: [BLOCK],
            collapsed: true,
        });

        setCloudUser('user-a');

        expect(ids(await call(router, 'GET', '/api/pins'))).toEqual([
            OWN,
            SHARED,
            LOCAL,
        ]);
        // The user's own choices win; the device's storage choice stays local
        expect((await call(router, 'GET', '/api/preferences')).json).toEqual({
            theme: 'dark',
            font_family: 'jetbrains-mono',
            font_size: 14,
            workspace_storage: null,
        });
        expect(
            (await call(router, 'GET', '/api/collapsed-blocks')).json.block_ids,
        ).toEqual([BLOCK]);

        // The local document is emptied, so signing out shows a clean slate
        expect(pinned()).toEqual([]);
        expect(collapsedMap(userDocument()).keys()).toEqual([]);
        expect(preferencesMap(userDocument()).toJSON()).toEqual({
            workspace_storage: 'local',
        });

        setCloudUser(null);
        expect((await call(router, 'GET', '/api/pins')).json.items).toEqual([]);
        expect((await call(router, 'GET', '/api/preferences')).json).toEqual({
            theme: null,
            font_family: null,
            font_size: null,
            workspace_storage: 'local',
        });
    });

    it('merges only once', async () => {
        page(LOCAL, 'Local');
        await call(router, 'PUT', `/api/pages/${LOCAL}/pin`);

        setCloudUser('user-a');
        expect(ids(await call(router, 'GET', '/api/pins'))).toEqual([LOCAL]);
        const writes = unsyncedUpdates('user:user-a');

        await call(router, 'GET', '/api/pins');
        await call(router, 'GET', '/api/preferences');

        expect(unsyncedUpdates('user:user-a')).toBe(writes);
        expect(pinned('user:user-a')).toEqual([LOCAL]);
    });

    it('does not merge a local document holding only device preferences', async () => {
        await call(router, 'PUT', '/api/preferences/workspace-storage', {
            workspace_storage: 'cloud',
        });

        setCloudUser('user-a');
        expect((await call(router, 'GET', '/api/preferences')).json).toEqual({
            theme: null,
            font_family: null,
            font_size: null,
            workspace_storage: null,
        });
        expect(ctx.documents().store.exists('user:user-a')).toBe(false);
    });
});

describe('daily notes route', () => {
    it('opens the daily note for the active workspace', async () => {
        const response = await call(router, 'POST', '/api/daily-notes', {
            date: '2026-08-30',
        });

        expect(response.status).toBe(200);
        expect(response.json).toEqual({
            id: dailyNotePageId(ctx.workspace().id, '2026-08-30'),
            date: '2026-08-30',
        });
        expect(findPage(ctx.db(), response.json.id)).toMatchObject({
            title: 'August 30, 2026',
            kind: 'daily',
            daily_date: '2026-08-30',
            created_at: Date.UTC(2026, 7, 30),
        });

        const writes = unsyncedUpdates(response.json.id);
        const again = await call(router, 'POST', '/api/daily-notes', {
            date: '2026-08-30',
        });
        expect(again.json.id).toBe(response.json.id);
        expect(unsyncedUpdates(response.json.id)).toBe(writes);
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
