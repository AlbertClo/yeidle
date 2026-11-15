import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    MAX_NAVIGATION_LOCATIONS,
    NavigationHistoryStore,
} from '../services/navigationHistory';
import { call, Router, testContext } from '../testing';

import {
    navigationHistoryPageProps,
    registerNavigationHistoryRoutes,
} from './navigationHistory';

let ctx: ReturnType<typeof testContext>;
let router: Router;
let profileKey: string;
let history: NavigationHistoryStore;

beforeEach(() => {
    ctx = testContext();
    router = new Router();
    profileKey = 'local';
    history = new NavigationHistoryStore(ctx, () => profileKey);
    registerNavigationHistoryRoutes(router, ctx, history);
});

afterEach(() => ctx.cleanup());

const PAGE_ID = '00000000-0000-7000-8000-000000000010';
const BLOCK_ID = '00000000-0000-7000-8000-000000000011';

function location(
    id: string,
    parentId: string | null = null,
): Record<string, unknown> {
    return {
        id,
        parent_id: parentId,
        url: `/pages/${PAGE_ID}`,
        page_id: PAGE_ID,
        block_id: BLOCK_ID,
        cursor_offset: 12,
        selection_type: 'node',
        scroll_top: 480,
        visited_at: '2026-08-30T03:00:00+02:00',
        last_visited_at: '2026-08-30T03:00:00+02:00',
    };
}

const count = (table: string) =>
    ctx.db().get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)!
        .count;

describe('navigation history routes', () => {
    it('persists a local navigation tree', async () => {
        ctx.documents().applyChanges([
            {
                type: 'node.set',
                payload: {
                    id: PAGE_ID,
                    page_id: PAGE_ID,
                    fields: { content: 'Page title' },
                },
            },
            {
                type: 'node.set',
                payload: {
                    id: BLOCK_ID,
                    page_id: PAGE_ID,
                    fields: {
                        parent_id: PAGE_ID,
                        position: 'a0',
                        content: 'The selected node text',
                    },
                },
            },
        ]);
        const root = location('00000000-0000-7000-8000-000000000001');
        const child = location(
            '00000000-0000-7000-8000-000000000002',
            root.id as string,
        );

        expect(
            (
                await call(
                    router,
                    'PUT',
                    `/api/navigation-history/locations/${root.id}`,
                    { ...root, make_current: true },
                )
            ).status,
        ).toBe(200);
        const saved = await call(
            router,
            'PUT',
            `/api/navigation-history/locations/${child.id}`,
            {
                ...child,
                make_current: true,
            },
        );
        expect(saved.status).toBe(200);
        expect(saved.json).toMatchObject({
            parent_id: root.id,
            block_id: BLOCK_ID,
            cursor_offset: 12,
            selection_type: 'node',
            visited_at: '2026-08-30T01:00:00+00:00',
        });

        const listing = await call(router, 'GET', '/api/navigation-history');
        expect(listing.status).toBe(200);
        expect(listing.json.locations).toHaveLength(2);
        expect(listing.json.locations[0].id).toBe(root.id);
        expect(listing.json.locations[1]).toMatchObject({
            parent_id: root.id,
            scroll_top: 480,
            page_title: 'Page title',
            node_text: 'The selected node text',
        });
        expect(listing.json.current_id).toBe(child.id);

        const current = await call(
            router,
            'PUT',
            '/api/navigation-history/current',
            { id: root.id },
        );
        expect(current.status).toBe(200);
        expect(current.json).toEqual({ current_id: root.id });

        expect(count('navigation_locations')).toBe(2);
        expect(count('navigation_history_states')).toBe(1);
    });

    it('isolates histories by cloud user', async () => {
        profileKey = 'cloud:user-a';
        const saved = location('00000000-0000-7000-8000-000000000003');
        await call(
            router,
            'PUT',
            `/api/navigation-history/locations/${saved.id}`,
            { ...saved, make_current: true },
        );

        profileKey = 'cloud:user-b';
        expect(
            (await call(router, 'GET', '/api/navigation-history')).json,
        ).toEqual({
            locations: [],
            current_id: null,
        });

        profileKey = 'cloud:user-a';
        const listing = await call(router, 'GET', '/api/navigation-history');
        expect(listing.json.locations[0].id).toBe(saved.id);
        expect(listing.json.current_id).toBe(saved.id);
    });

    it('does not persist the navigation history page', async () => {
        const saved = location('00000000-0000-7000-8000-000000000004');

        const response = await call(
            router,
            'PUT',
            `/api/navigation-history/locations/${saved.id}`,
            {
                ...saved,
                url: '/navigation-history',
                page_id: null,
                block_id: null,
                cursor_offset: null,
                make_current: true,
            },
        );
        expect(response.status).toBe(204);

        expect(
            (await call(router, 'GET', '/api/navigation-history')).json,
        ).toEqual({
            locations: [],
            current_id: null,
        });
    });

    it('normalizes the NativePHP window url', async () => {
        const saved = location('00000000-0000-7000-8000-000000000005');

        expect(
            (
                await call(
                    router,
                    'PUT',
                    `/api/navigation-history/locations/${saved.id}`,
                    {
                        ...saved,
                        url: '/?_windowId=main',
                        page_id: null,
                        block_id: null,
                        cursor_offset: null,
                        selection_type: null,
                        make_current: true,
                    },
                )
            ).status,
        ).toBe(200);

        const listing = await call(router, 'GET', '/api/navigation-history');
        expect(listing.json.locations[0].url).toBe('/pages');
        expect(listing.json.current_id).toBe(saved.id);
    });

    it('clears navigation history', async () => {
        const saved = location('00000000-0000-7000-8000-000000000006');
        await call(
            router,
            'PUT',
            `/api/navigation-history/locations/${saved.id}`,
            { ...saved, make_current: true },
        );

        expect(
            (await call(router, 'DELETE', '/api/navigation-history')).status,
        ).toBe(204);

        expect(
            (await call(router, 'GET', '/api/navigation-history')).json,
        ).toEqual({
            locations: [],
            current_id: null,
        });
        expect(count('navigation_locations')).toBe(0);
        expect(count('navigation_history_states')).toBe(0);
    });

    it('validates input', async () => {
        const saved = location('00000000-0000-7000-8000-000000000007');
        const put = (body: Record<string, unknown>, id = saved.id) =>
            call(
                router,
                'PUT',
                `/api/navigation-history/locations/${id}`,
                body,
            );

        expect(
            (await put({ ...saved, url: 'pages' })).json.errors,
        ).toHaveProperty('url');
        expect(
            (await put({ ...saved, selection_type: 'word' })).json.errors,
        ).toHaveProperty('selection_type');
        expect(
            (await put({ ...saved, visited_at: 'not a date' })).json.errors,
        ).toHaveProperty('visited_at');
        expect(
            (await put({ ...saved, parent_id: 'nope' })).json.errors,
        ).toHaveProperty('parent_id');
        expect(
            (await put({ ...saved, scroll_top: undefined })).json.errors,
        ).toHaveProperty('scroll_top');
        expect((await put(saved, 'not-a-uuid')).status).toBe(404);

        const missingParent = await put({
            ...saved,
            parent_id: '00000000-0000-7000-8000-000000000099',
        });
        expect(missingParent.status).toBe(422);
        expect(missingParent.json.errors).toHaveProperty('parent_id');

        const missingCurrent = await call(
            router,
            'PUT',
            '/api/navigation-history/current',
            {
                id: '00000000-0000-7000-8000-000000000099',
            },
        );
        expect(missingCurrent.status).toBe(422);
        expect(missingCurrent.json.errors).toHaveProperty('id');
    });

    it('prunes the least recently visited leaves but keeps the current branch', () => {
        const id = (i: number) =>
            `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`;
        const at = (i: number) =>
            new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
        const base = { url: '/pages', scroll_top: 0 };

        // A chain 1..10 visited earliest, current at its tip; then many newer leaves under the root
        for (let i = 1; i <= 10; i++) {
            history.save(
                id(i),
                {
                    ...base,
                    parent_id: i === 1 ? null : id(i - 1),
                    visited_at: at(i),
                    last_visited_at: at(i),
                },
                i === 10,
            );
        }

        for (let i = 11; i <= MAX_NAVIGATION_LOCATIONS + 5; i++) {
            history.save(
                id(i),
                {
                    ...base,
                    parent_id: id(1),
                    visited_at: at(i),
                    last_visited_at: at(i),
                },
                false,
            );
        }

        const ids = new Set(history.get().locations.map((l) => l.id));
        expect(ids.size).toBe(MAX_NAVIGATION_LOCATIONS);
        for (let i = 1; i <= 10; i++) {
            expect(ids.has(id(i))).toBe(true);
        }
        for (let i = 11; i <= 15; i++) {
            expect(ids.has(id(i))).toBe(false);
        }
        expect(history.get().current_id).toBe(id(10));
    });
});

describe('navigation history page', () => {
    it('renders without props', () => {
        expect(navigationHistoryPageProps(ctx)).toEqual({});
    });
});
