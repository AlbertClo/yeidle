import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../support/ids';
import { SystemNodes } from '../nodes';
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

function node(
    content: string,
    parentId: string | null = null,
    options: { id?: string; position?: string; tiptap_content?: unknown } = {},
): string {
    const id = options.id ?? uuidv7();
    ctx.documents().applyChanges([
        {
            type: 'node.set',
            payload: {
                id,
                page_id: parentId ?? id,
                fields: {
                    parent_id: parentId,
                    position: options.position ?? 'a0',
                    content,
                    tiptap_content: options.tiptap_content ?? null,
                },
            },
        },
    ]);

    return id;
}

function setModified(id: string, hlc: string): void {
    ctx.db().run('UPDATE nodes SET modified_hlc = ? WHERE id = ?', [hlc, id]);
}

function count(table: string): number {
    return ctx.db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
}

describe('pages', () => {
    it('orders pages by modified_hlc with a deterministic id tie-breaker', async () => {
        const oldest = node('Oldest', null, { id: '00000000-0000-7000-8000-000000000001' });
        const tieLow = node('Tie low', null, { id: '00000000-0000-7000-8000-000000000002' });
        const tieHigh = node('Tie high', null, { id: '00000000-0000-7000-8000-000000000003' });
        const newest = node('Newest', null, { id: '00000000-0000-7000-8000-000000000004' });
        setModified(oldest, '000000000000100-0000-a');
        setModified(tieLow, '000000000000200-0000-a');
        setModified(tieHigh, '000000000000200-0000-a');
        setModified(newest, '000000000000300-0000-a');

        const response = await call(router, 'GET', '/api/pages');

        expect(response.status).toBe(200);
        expect(response.json.map((page: { id: string }) => page.id)).toEqual([
            newest,
            tieHigh,
            tieLow,
            oldest,
        ]);
        expect(response.json[0]).toMatchObject({ content: 'Newest', parent_id: null });
    });

    it('excludes deleted pages and system roots', async () => {
        const page = node('Kept');
        const deleted = node('Deleted');
        ctx.documents().applyChanges([{ type: 'node.delete', payload: { id: deleted, page_id: deleted } }]);
        node('Pins', null, { id: SystemNodes.PINS_ROOT_ID });

        const response = await call(router, 'GET', '/api/pages');

        expect(response.json.map((p: { id: string }) => p.id)).toEqual([page]);
    });

    it('orders siblings by position with a deterministic id tie-breaker', async () => {
        const page = node('Page', null, { id: '00000000-0000-7000-8000-000000000010' });
        const high = '00000000-0000-7000-8000-000000000013';
        const low = '00000000-0000-7000-8000-000000000012';
        ctx.documents().applyChanges(
            [high, low].map((id) => ({
                type: 'node.set' as const,
                payload: { id, page_id: page, fields: { parent_id: page, position: 'a0', content: id } },
            })),
        );

        const response = await call(router, 'GET', `/api/pages/${page}`);

        expect(response.status).toBe(200);
        expect(response.json.children.map((c: { id: string }) => c.id)).toEqual([low, high]);
    });

    it('404s for missing, deleted and system pages', async () => {
        const deleted = node('Deleted');
        ctx.documents().applyChanges([{ type: 'node.delete', payload: { id: deleted, page_id: deleted } }]);
        node('Pins', null, { id: SystemNodes.PINS_ROOT_ID });

        expect((await call(router, 'GET', '/api/pages/00000000-0000-7000-8000-000000000404')).status).toBe(404);
        expect((await call(router, 'GET', `/api/pages/${deleted}`)).status).toBe(404);
        expect((await call(router, 'GET', `/api/pages/${SystemNodes.PINS_ROOT_ID}`)).status).toBe(404);
        expect((await call(router, 'GET', `/api/pages/${SystemNodes.PINS_ROOT_ID}/backlinks`)).status).toBe(404);
    });

    it('checks for duplicate titles case-insensitively', async () => {
        const page = node('Project Notes');

        expect((await call(router, 'GET', '/api/pages/title-exists?title=project%20notes')).json).toEqual({
            exists: true,
        });
        expect(
            (await call(router, 'GET', `/api/pages/title-exists?title=Project%20Notes&except=${page}`)).json,
        ).toEqual({ exists: false });
        expect((await call(router, 'GET', '/api/pages/title-exists?title=Other')).json).toEqual({
            exists: false,
        });
        expect((await call(router, 'GET', '/api/pages/title-exists')).status).toBe(422);
    });

    it('lists the pages linking to a page', async () => {
        const target = node('Target page');
        const sourcePage = node('Source page');
        const sourceParent = node('Parent block', sourcePage);
        const sourceBlock = node('Linked block', sourceParent, {
            tiptap_content: {
                type: 'paragraph',
                content: [{ type: 'mention', attrs: { id: target, label: 'Target page' } }],
            },
        });
        const link = ctx
            .db()
            .get<{ id: string }>('SELECT id FROM node_links WHERE source_node_id = ?', [sourceBlock])!;

        const response = await call(router, 'GET', `/api/pages/${target}/backlinks`);

        expect(response.status).toBe(200);
        expect(response.json).toEqual([{ id: link.id, page_id: sourcePage, page_title: 'Source page' }]);
    });
});

describe('search route', () => {
    it('returns ranked nodes with their page id', async () => {
        const page = node('Page');
        const match = node('Deep searchable result', node('Parent', page));

        const response = await call(router, 'GET', '/api/search?q=searchable');

        expect(response.status).toBe(200);
        expect(response.json[0]).toMatchObject({ id: match, page_id: page, content: 'Deep searchable result' });
    });

    it('validates the query', async () => {
        expect((await call(router, 'GET', '/api/search')).status).toBe(422);
        expect((await call(router, 'GET', `/api/search?q=${'a'.repeat(201)}`)).status).toBe(422);
        expect((await call(router, 'GET', '/api/search?q=---')).json).toEqual([]);
    });
});

describe('recent pages and visits', () => {
    it('records visits and lists the most recently visited pages first', async () => {
        const first = node('First');
        const second = node('Second');

        expect((await call(router, 'POST', '/api/page-visits', { node_id: first })).status).toBe(201);
        await call(router, 'POST', '/api/page-visits', { node_id: second });
        ctx.db().run("UPDATE page_visits SET visited_at = '2026-01-01 00:00:00' WHERE node_id = ?", [first]);

        const response = await call(router, 'GET', '/api/recent-pages');

        expect(response.json.map((p: { id: string }) => p.id)).toEqual([second, first]);
        expect(count('page_visits')).toBe(2);
    });

    it('rejects visits to unknown nodes', async () => {
        const response = await call(router, 'POST', '/api/page-visits', { node_id: uuidv7() });

        expect(response.status).toBe(422);
        expect(response.json.errors.node_id).toEqual(['The selected node id is invalid.']);
    });
});

describe('open external', () => {
    it('opens valid URLs through the host', async () => {
        const response = await call(router, 'POST', '/api/open-external', { url: 'https://example.com/a?b=c' });

        expect(response.status).toBe(200);
        expect(ctx.openedUrls).toEqual(['https://example.com/a?b=c']);
    });

    it('rejects invalid URLs', async () => {
        expect((await call(router, 'POST', '/api/open-external', { url: 'not a url' })).status).toBe(422);
        expect((await call(router, 'POST', '/api/open-external', {})).status).toBe(422);
        expect(ctx.openedUrls).toEqual([]);
    });
});

describe('node façade', () => {
    it('creating a page writes its document', async () => {
        const response = await call(router, 'POST', '/api/nodes', { content: 'My New Page' });

        expect(response.status).toBe(201);
        const id = response.json.id;
        expect(response.json).toMatchObject({ content: 'My New Page', parent_id: null, children: [] });
        const row = ctx.db().get<{ content: string; document_id: string }>(
            'SELECT content, document_id FROM nodes WHERE id = ?',
            [id],
        )!;
        expect(row).toEqual({ content: 'My New Page', document_id: id });
        expect(ctx.db().all('SELECT document_id FROM document_updates')).toEqual([{ document_id: id }]);
    });

    it('returns the existing page for a duplicate title without writing', async () => {
        const first = await call(router, 'POST', '/api/nodes', { content: 'Unique Title' });
        const second = await call(router, 'POST', '/api/nodes', { content: 'unique title' });

        expect(second.status).toBe(200);
        expect(second.json.id).toBe(first.json.id);
        expect(count('document_updates')).toBe(1);
    });

    it('creates children in the root page document', async () => {
        const page = (await call(router, 'POST', '/api/nodes', { content: 'Parent Page' })).json.id;
        const child = await call(router, 'POST', '/api/nodes', {
            parent_id: page,
            content: 'child node',
            position: 'a0',
        });

        expect(child.status).toBe(201);
        expect(
            ctx.db().get<{ document_id: string }>('SELECT document_id FROM nodes WHERE id = ?', [child.json.id]),
        ).toEqual({ document_id: page });

        const parent = await call(router, 'POST', '/api/nodes', { content: 'parent page' });
        expect(parent.json.children.map((c: { id: string }) => c.id)).toEqual([child.json.id]);
    });

    it('treats a known id as an upsert', async () => {
        const id = uuidv7();

        expect((await call(router, 'POST', '/api/nodes', { id, content: 'v1' })).status).toBe(201);
        const again = await call(router, 'POST', '/api/nodes', { id, content: 'v2', parent_id: null });

        expect(again.status).toBe(200);
        expect(ctx.db().get('SELECT content FROM nodes WHERE id = ?', [id])).toEqual({ content: 'v2' });
    });

    it('validates input', async () => {
        const cases: [Record<string, unknown>, string][] = [
            [{ id: 'nope' }, 'id'],
            [{ parent_id: uuidv7() }, 'parent_id'],
            [{ is_checked: 'yes' }, 'is_checked'],
            [{ page_type: 'journal' }, 'page_type'],
            [{ daily_note_date: '2026-02-30' }, 'daily_note_date'],
            [{ content: 42 }, 'content'],
        ];

        for (const [body, field] of cases) {
            const response = await call(router, 'POST', '/api/nodes', body);
            expect(response.status).toBe(422);
            expect(Object.keys(response.json.errors)).toEqual([field]);
        }
    });

    it('creates daily notes with their page fields', async () => {
        const response = await call(router, 'POST', '/api/nodes', {
            content: 'November 9th, 2026',
            page_type: 'daily_note',
            daily_note_date: '2026-11-09',
        });

        expect(response.status).toBe(201);
        expect(response.json).toMatchObject({ page_type: 'daily_note', daily_note_date: '2026-11-09' });
    });

    it('returns the referenced subtree and its root page', async () => {
        const page = (await call(router, 'POST', '/api/nodes', { content: 'Reference root' })).json.id;
        const target = (await call(router, 'POST', '/api/nodes', { parent_id: page, content: 'Referenced block' }))
            .json.id;
        const child = (await call(router, 'POST', '/api/nodes', { parent_id: target, content: 'Nested block' })).json
            .id;

        const response = await call(router, 'GET', `/api/nodes/${target}/reference`);

        expect(response.status).toBe(200);
        expect(response.json).toMatchObject({ id: target, page_id: page, content: 'Referenced block' });
        expect(response.json.children[0]).toMatchObject({ id: child, children: [] });
    });

    it('404s references to missing, unreachable or system nodes', async () => {
        const page = node('Page');
        const block = node('Block', page);
        ctx.documents().applyChanges([{ type: 'node.delete', payload: { id: page, page_id: page } }]);
        node('Pins', null, { id: SystemNodes.PINS_ROOT_ID });

        expect((await call(router, 'GET', `/api/nodes/${uuidv7()}/reference`)).status).toBe(404);
        expect((await call(router, 'GET', `/api/nodes/${block}/reference`)).status).toBe(404);
        expect((await call(router, 'GET', `/api/nodes/${SystemNodes.PINS_ROOT_ID}/reference`)).status).toBe(404);
    });
});
