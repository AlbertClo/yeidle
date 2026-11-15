import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    createPage,
    deletePage,
    inline,
    mention,
    setBlocks,
} from '../../documents/testing';
import { uuidv7 } from '../../support/ids';
import { NavigationHistoryStore } from '../services/navigationHistory';
import { call, Router, testContext } from '../testing';

import { registerPageRoutes } from './pages';

let ctx: ReturnType<typeof testContext>;
let router: Router;

beforeEach(() => {
    ctx = testContext();
    router = new Router();
    registerPageRoutes(router, ctx);
});

afterEach(() => ctx.cleanup());

function page(title: string, options: Parameters<typeof createPage>[2] = {}) {
    return createPage(ctx.documents(), title, options);
}

function setUpdated(id: string, ms: number): void {
    ctx.db().run('UPDATE pages SET updated_at = ? WHERE id = ?', [ms, id]);
}

function count(table: string): number {
    return ctx.db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
}

describe('pages', () => {
    it('lists pages most recently changed first with a deterministic id tie-breaker', async () => {
        const oldest = page('Oldest', {
            id: '00000000-0000-7000-8000-000000000001',
        });
        const tieLow = page('Tie low', {
            id: '00000000-0000-7000-8000-000000000002',
        });
        const tieHigh = page('Tie high', {
            id: '00000000-0000-7000-8000-000000000003',
        });
        const newest = page('Newest', {
            id: '00000000-0000-7000-8000-000000000004',
        });
        setUpdated(oldest, 100);
        setUpdated(tieLow, 200);
        setUpdated(tieHigh, 200);
        setUpdated(newest, 300);

        const response = await call(router, 'GET', '/api/pages');

        expect(response.status).toBe(200);
        expect(response.json.map((p: { id: string }) => p.id)).toEqual([
            newest,
            tieHigh,
            tieLow,
            oldest,
        ]);
        expect(response.json[0]).toEqual({
            id: newest,
            title: 'Newest',
            kind: 'page',
            daily_date: null,
            created_at: expect.any(Number),
            updated_at: 300,
        });
    });

    it('lists daily notes with their date', async () => {
        const daily = page('November 9th, 2026', {
            meta: { page_type: 'daily_note', daily_note_date: '2026-11-09' },
        });

        const response = await call(router, 'GET', `/api/pages/${daily}`);

        expect(response.json).toMatchObject({
            kind: 'daily',
            daily_date: '2026-11-09',
        });
    });

    it('takes created_at from the page document as unix ms', async () => {
        const id = page('Dated', {
            meta: { created_at: '2026-01-02T03:04:05.000Z' },
        });

        expect(
            (await call(router, 'GET', `/api/pages/${id}`)).json.created_at,
        ).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    });

    it('leaves deleted pages out', async () => {
        const kept = page('Kept');
        const deleted = page('Deleted', { blocks: [{ text: 'gone' }] });
        deletePage(ctx.documents(), deleted);

        const response = await call(router, 'GET', '/api/pages');

        expect(response.json.map((p: { id: string }) => p.id)).toEqual([kept]);
        expect(count('blocks')).toBe(0);
    });

    it('returns a page by id and 404s for missing, deleted and block ids', async () => {
        const id = page('Shown');
        const deleted = page('Deleted');
        deletePage(ctx.documents(), deleted);
        const [block] = setBlocks(ctx.documents(), id, [{ text: 'A block' }]);

        const shown = await call(router, 'GET', `/api/pages/${id}`);
        expect(shown.status).toBe(200);
        expect(shown.json).toMatchObject({ id, title: 'Shown', kind: 'page' });

        for (const missing of [uuidv7(), deleted, block]) {
            expect(
                (await call(router, 'GET', `/api/pages/${missing}`)).status,
            ).toBe(404);
            expect(
                (await call(router, 'GET', `/api/pages/${missing}/backlinks`))
                    .status,
            ).toBe(404);
        }
    });

    it('creates a page by title', async () => {
        const response = await call(router, 'POST', '/api/pages', {
            title: 'My New Page',
        });

        expect(response.status).toBe(201);
        expect(response.json).toMatchObject({
            title: 'My New Page',
            kind: 'page',
            daily_date: null,
        });
        expect(
            ctx.db().all('SELECT document_id FROM document_updates'),
        ).toEqual([{ document_id: response.json.id }]);
        expect(
            (await call(router, 'GET', '/api/pages')).json.map(
                (p: { id: string }) => p.id,
            ),
        ).toEqual([response.json.id]);
    });

    it('returns the existing page for a duplicate title without writing', async () => {
        const first = await call(router, 'POST', '/api/pages', {
            title: 'Unique Title',
        });
        const second = await call(router, 'POST', '/api/pages', {
            title: 'unique title',
        });

        expect(second.status).toBe(200);
        expect(second.json).toEqual(first.json);
        expect(count('document_updates')).toBe(1);
    });

    it('validates the title when creating a page', async () => {
        for (const body of [{}, { title: '' }, { title: 42 }]) {
            const response = await call(router, 'POST', '/api/pages', body);
            expect(response.status).toBe(422);
            expect(Object.keys(response.json.errors)).toEqual(['title']);
        }

        expect(count('pages')).toBe(0);
    });

    it('checks for duplicate titles case-insensitively', async () => {
        const id = page('Project Notes');

        expect(
            (
                await call(
                    router,
                    'GET',
                    '/api/pages/title-exists?title=project%20notes',
                )
            ).json,
        ).toEqual({
            exists: true,
        });
        expect(
            (
                await call(
                    router,
                    'GET',
                    `/api/pages/title-exists?title=Project%20Notes&except=${id}`,
                )
            ).json,
        ).toEqual({ exists: false });
        expect(
            (await call(router, 'GET', '/api/pages/title-exists?title=Other'))
                .json,
        ).toEqual({
            exists: false,
        });
        expect(
            (await call(router, 'GET', '/api/pages/title-exists')).status,
        ).toBe(422);
    });

    it('lists each page linking to a page once, with its first linking block', async () => {
        const target = page('Target page');
        const source = page('Source page');
        const [first, second] = setBlocks(ctx.documents(), source, [
            {
                text: 'Parent block',
                content: inline(mention(target, 'Target page')),
                children: [
                    {
                        text: 'Nested link',
                        content: inline('see ', mention(target, 'Target page')),
                    },
                ],
            },
        ]);
        const untitled = uuidv7();
        // Blocks that arrive before their page's fields: listed untitled
        setBlocks(ctx.documents(), untitled, [
            { content: inline(mention(target, 'Target page')) },
        ]);
        setUpdated(source, 200);
        setUpdated(untitled, 100);

        const response = await call(
            router,
            'GET',
            `/api/pages/${target}/backlinks`,
        );

        expect(response.status).toBe(200);
        expect(response.json).toEqual([
            {
                id: [first, second].sort()[0],
                page_id: source,
                page_title: 'Source page',
            },
            {
                id: expect.any(String),
                page_id: untitled,
                page_title: '[untitled]',
            },
        ]);
    });

    it('drops backlinks when the linking page is deleted', async () => {
        const target = page('Target');
        const source = page('Source', {
            blocks: [{ content: inline(mention(target, 'Target')) }],
        });
        deletePage(ctx.documents(), source);

        expect(
            (await call(router, 'GET', `/api/pages/${target}/backlinks`)).json,
        ).toEqual([]);
        expect(count('links')).toBe(0);
    });
});

describe('blocks route', () => {
    it('returns a block with its page and nested children', async () => {
        const id = page('Reference root');
        const [target, child, grandchild] = setBlocks(ctx.documents(), id, [
            {
                text: 'Referenced block',
                children: [
                    {
                        text: 'Nested block',
                        children: [{ text: 'Deeper' }],
                    },
                ],
            },
            { text: 'Sibling' },
        ]);

        const response = await call(router, 'GET', `/api/blocks/${target}`);

        expect(response.status).toBe(200);
        expect(response.json).toEqual({
            id: target,
            page_id: id,
            text: 'Referenced block',
            children: [
                {
                    id: child,
                    text: 'Nested block',
                    children: [
                        { id: grandchild, text: 'Deeper', children: [] },
                    ],
                },
            ],
        });
    });

    it('stands a page in with its title and top-level blocks', async () => {
        const id = page('Embedded page');
        const [first, nested, second] = setBlocks(ctx.documents(), id, [
            { text: 'First', children: [{ text: 'Nested' }] },
            { text: 'Second' },
        ]);

        const response = await call(router, 'GET', `/api/blocks/${id}`);

        expect(response.status).toBe(200);
        expect(response.json).toEqual({
            id,
            page_id: id,
            text: 'Embedded page',
            children: [
                {
                    id: first,
                    text: 'First',
                    children: [{ id: nested, text: 'Nested', children: [] }],
                },
                { id: second, text: 'Second', children: [] },
            ],
        });
    });

    it('404s for unknown ids, deleted pages and blocks of deleted pages', async () => {
        const id = page('Page');
        const [block] = setBlocks(ctx.documents(), id, [{ text: 'Block' }]);

        expect(
            (await call(router, 'GET', `/api/blocks/${uuidv7()}`)).status,
        ).toBe(404);

        deletePage(ctx.documents(), id);
        expect((await call(router, 'GET', `/api/blocks/${id}`)).status).toBe(
            404,
        );
        expect((await call(router, 'GET', `/api/blocks/${block}`)).status).toBe(
            404,
        );
    });
});

describe('search route', () => {
    it('returns matching pages and blocks with their page id', async () => {
        const id = page('Searchable page');
        const [, match] = setBlocks(ctx.documents(), id, [
            {
                text: 'Parent',
                children: [{ text: 'Deep searchable result' }],
            },
        ]);

        const response = await call(router, 'GET', '/api/search?q=searchable');

        expect(response.status).toBe(200);
        expect(response.json).toEqual([
            {
                kind: 'page',
                id,
                page_id: id,
                text: 'Searchable page',
            },
            {
                kind: 'block',
                id: match,
                page_id: id,
                text: 'Deep searchable result',
            },
        ]);
    });

    it('leaves out blocks of deleted pages', async () => {
        const id = page('Doomed', { blocks: [{ text: 'findable words' }] });
        deletePage(ctx.documents(), id);

        expect(
            (await call(router, 'GET', '/api/search?q=findable')).json,
        ).toEqual([]);
    });

    it('validates the query', async () => {
        expect((await call(router, 'GET', '/api/search')).status).toBe(422);
        expect(
            (await call(router, 'GET', `/api/search?q=${'a'.repeat(201)}`))
                .status,
        ).toBe(422);
        expect((await call(router, 'GET', '/api/search?q=---')).json).toEqual(
            [],
        );
    });
});

describe('recent pages', () => {
    let next = 1;

    function visit(
        pageId: string | null,
        at: number,
        url = pageId ? `/pages/${pageId}` : '/pages',
    ) {
        new NavigationHistoryStore(ctx).save(
            `00000000-0000-7000-8000-${String(next++).padStart(12, '0')}`,
            {
                url,
                page_id: pageId,
                scroll_top: 0,
                visited_at: new Date(at).toISOString(),
                last_visited_at: new Date(at).toISOString(),
            },
            true,
        );
    }

    it('lists the most recently visited pages first, once each', async () => {
        const first = page('First');
        const second = page('Second');
        const unvisited = page('Unvisited');
        visit(first, 1000);
        visit(second, 2000);
        visit(null, 3000);
        visit(first, 4000);

        const response = await call(router, 'GET', '/api/recent-pages');

        expect(response.status).toBe(200);
        expect(response.json.map((p: { id: string }) => p.id)).toEqual([
            first,
            second,
        ]);
        expect(response.json[0]).toMatchObject({ title: 'First' });
        expect(response.json.map((p: { id: string }) => p.id)).not.toContain(
            unvisited,
        );
    });

    it('skips deleted pages and keeps at most ten', async () => {
        const pages = Array.from({ length: 12 }, (_, i) => page(`Page ${i}`));
        pages.forEach((id, i) => visit(id, 1000 + i));
        deletePage(ctx.documents(), pages[11]);

        const response = await call(router, 'GET', '/api/recent-pages');

        expect(response.json.map((p: { id: string }) => p.id)).toEqual(
            pages.slice(1, 11).reverse(),
        );
    });

    it('shows only the current user history', async () => {
        const local = page('Local');
        visit(local, 1000);
        ctx.db().run(
            "UPDATE navigation_locations SET user_key = 'cloud:someone-else'",
        );

        expect((await call(router, 'GET', '/api/recent-pages')).json).toEqual(
            [],
        );
    });
});

describe('open external', () => {
    it('opens valid URLs through the host', async () => {
        const response = await call(router, 'POST', '/api/open-external', {
            url: 'https://example.com/a?b=c',
        });

        expect(response.status).toBe(200);
        expect(ctx.openedUrls).toEqual(['https://example.com/a?b=c']);
    });

    it('rejects invalid URLs', async () => {
        expect(
            (
                await call(router, 'POST', '/api/open-external', {
                    url: 'not a url',
                })
            ).status,
        ).toBe(422);
        expect(
            (await call(router, 'POST', '/api/open-external', {})).status,
        ).toBe(422);
        expect(ctx.openedUrls).toEqual([]);
    });
});

describe('removed routes', () => {
    it('no longer serves page visits or the node façade', async () => {
        for (const [method, url] of [
            ['POST', '/api/page-visits'],
            ['POST', '/api/nodes'],
            ['GET', `/api/nodes/${uuidv7()}/reference`],
        ]) {
            expect((await call(router, method, url)).status).toBe(404);
        }
    });
});
