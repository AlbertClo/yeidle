import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPage } from '../../documents/testing';
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

describe('document routes', () => {
    it('loads a document, accepts an editor update, and serves it to other windows', async () => {
        const pageId = createPage(ctx.documents(), 'Inbox');
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
                tiptap_content: {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'typed' }],
                },
                is_checked: null,
            },
        ]);
        doc.commit();

        const pushed = await call(
            router,
            'POST',
            `/api/documents/${pageId}/updates`,
            {
                updates: [
                    {
                        update_id: uuidv7(),
                        origin: 'window-1',
                        bytes: toBase64(
                            doc.export({ mode: 'update', from: before }),
                        ),
                    },
                ],
            },
        );
        expect(pushed.status).toBe(200);
        expect(
            ctx
                .db()
                .get('SELECT page_id, text FROM blocks WHERE id = ?', [
                    blockId,
                ]),
        ).toEqual({ page_id: pageId, text: 'typed' });

        const since = await call(
            router,
            'GET',
            `/api/documents/${pageId}/updates?since=${loaded.json.seq}`,
        );
        expect(since.json.updates).toHaveLength(1);
        expect(since.json.updates[0].origin).toBe('window-1');

        const changes = await call(
            router,
            'GET',
            `/api/documents/changes?since=${loaded.json.seq}`,
        );
        expect(changes.json.documents).toEqual([
            { id: pageId, seq: pushed.json.seq },
        ]);
    });

    it('rejects malformed updates', async () => {
        const response = await call(
            router,
            'POST',
            `/api/documents/${uuidv7()}/updates`,
            {
                updates: [{ update_id: 'nope', origin: 'x', bytes: '' }],
            },
        );

        expect(response.status).toBe(422);
    });

    it('requires each update to name its origin', async () => {
        const response = await call(
            router,
            'POST',
            `/api/documents/${uuidv7()}/updates`,
            {
                updates: [
                    {
                        update_id: uuidv7(),
                        client_id: 'window-1',
                        bytes: toBase64(new Uint8Array([1])),
                    },
                ],
            },
        );

        expect(response.status).toBe(422);
        expect(response.json.errors).toHaveProperty('updates.0');
    });
});

describe('workspaces', () => {
    it('creates a Personal workspace on first use and switches between workspaces', () => {
        expect(ctx.workspaces.all().map((w) => w.name)).toEqual(['Personal']);
        const personal = ctx.workspace().id;
        createPage(ctx.documents(), 'Only in Personal');

        const other = ctx.workspaces.create('Research');
        ctx.workspaces.activate(other.id);
        expect(ctx.workspace().id).toBe(other.id);
        expect(ctx.db().get('SELECT 1 FROM pages')).toBeUndefined();

        ctx.workspaces.activate(personal);
        expect(ctx.db().get('SELECT title FROM pages')).toEqual({
            title: 'Only in Personal',
        });
    });
});
