import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyBlocks, createDoc, readBlocks } from '../../loro/pageDoc';
import { fromBase64, toBase64 } from '../../support/base64';
import { uuidv7 } from '../../support/ids';
import { call, Router, testContext } from '../testing';

import { registerDocumentRoutes } from './documents';

let ctx: ReturnType<typeof testContext>;
let router: Router;

beforeEach(() => {
    ctx = testContext();
    router = new Router();
    registerDocumentRoutes(router, ctx);
});

afterEach(() => ctx.cleanup());

function createPage(title: string): string {
    const id = uuidv7();
    ctx.documents().applyChanges([
        { type: 'node.set', payload: { id, page_id: id, fields: { content: title } } },
    ]);

    return id;
}

describe('document routes', () => {
    it('loads a document, accepts an editor update, and serves it to other windows', async () => {
        const pageId = createPage('Inbox');
        const loaded = await call(router, 'GET', `/api/documents/${pageId}`);
        expect(loaded.status).toBe(200);

        const doc = createDoc();
        doc.importBatch([
            ...(loaded.json.snapshot ? [fromBase64(loaded.json.snapshot)] : []),
            ...loaded.json.updates.map(fromBase64),
        ]);
        const before = doc.oplogVersion();
        const blockId = uuidv7();
        applyBlocks(doc, [
            ...readBlocks(doc, pageId),
            {
                id: blockId,
                parent_id: pageId,
                position: '',
                content: 'typed',
                tiptap_content: { type: 'paragraph', content: [{ type: 'text', text: 'typed' }] },
                is_checked: null,
            },
        ]);
        doc.commit();

        const pushed = await call(router, 'POST', `/api/documents/${pageId}/updates`, {
            updates: [
                {
                    update_id: uuidv7(),
                    client_id: 'window-1',
                    bytes: toBase64(doc.export({ mode: 'update', from: before })),
                },
            ],
        });
        expect(pushed.status).toBe(200);
        expect(
            ctx.db().get<{ content: string }>('SELECT content FROM nodes WHERE id = ?', [blockId]),
        ).toEqual({ content: 'typed' });

        const since = await call(router, 'GET', `/api/documents/${pageId}/updates?since=${loaded.json.seq}`);
        expect(since.json.updates).toHaveLength(1);

        const changes = await call(router, 'GET', `/api/documents/changes?since=${loaded.json.seq}`);
        expect(changes.json.documents).toEqual([{ id: pageId, seq: pushed.json.seq }]);
    });

    it('rejects malformed updates', async () => {
        const response = await call(router, 'POST', `/api/documents/${uuidv7()}/updates`, {
            updates: [{ update_id: 'nope', client_id: 'x', bytes: '' }],
        });

        expect(response.status).toBe(422);
    });
});

describe('workspaces', () => {
    it('creates a Personal workspace on first use and switches between workspaces', () => {
        expect(ctx.workspaces.all().map((w) => w.name)).toEqual(['Personal']);
        const personal = ctx.workspace().id;
        createPage('Only in Personal');

        const other = ctx.workspaces.create('Research');
        ctx.workspaces.activate(other.id);
        expect(ctx.workspace().id).toBe(other.id);
        expect(ctx.db().get('SELECT 1 FROM nodes')).toBeUndefined();

        ctx.workspaces.activate(personal);
        expect(ctx.db().get('SELECT 1 FROM nodes')).toBeDefined();
    });
});
