import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../db/database';
import { openNodeDatabase } from '../db/nodeSqlite';
import { createSchema } from '../db/schema';
import { mergeBlocks } from '../loro/mergeBlocks';
import { applyBlocks, createDoc, readBlocks } from '../loro/pageDoc';
import { addMedia, MEDIA_DOCUMENT_ID } from '../loro/projection';
import { uuidv7 } from '../support/ids';

import { DocumentService } from './service';
import {
    createPage,
    deletePage,
    inline,
    mention,
    paragraph,
    setBlocks,
} from './testing';

let db: Database;
let documents: DocumentService;

beforeEach(() => {
    db = openNodeDatabase(':memory:');
    createSchema(db);
    documents = new DocumentService(db);
});

afterEach(() => db.close());

const page = (id: string) => db.get('SELECT * FROM pages WHERE id = ?', [id]);
const block = (id: string) =>
    db.get('SELECT id, page_id, text FROM blocks WHERE id = ?', [id]);
const links = () =>
    db.all(
        'SELECT source_block_id, target_id FROM links ORDER BY source_block_id, target_id',
    );
const searchFor = (text: string) =>
    db
        .all<{ id: string }>(
            `SELECT blocks.id FROM block_search
             INNER JOIN blocks ON blocks.search_id = block_search.rowid
             WHERE block_search MATCH ?`,
            [`"${text}"`],
        )
        .map((row) => row.id);

/** Every read-model row, for comparing an incremental projection with a rebuild. */
function readModel() {
    return {
        pages: db.all(
            'SELECT id, title, kind, daily_date, created_at FROM pages ORDER BY id',
        ),
        blocks: db.all('SELECT id, page_id, text FROM blocks ORDER BY id'),
        links: links(),
        media: db.all('SELECT * FROM media ORDER BY id'),
        search: db.all(
            `SELECT blocks.id FROM block_search
             INNER JOIN blocks ON blocks.search_id = block_search.rowid
             WHERE block_search MATCH '"ell"' ORDER BY blocks.id`,
        ),
    };
}

/** An editor window: its own copy of the document, edited and exported. */
function editorWindow(pageId: string) {
    const doc = createDoc();
    const stored = documents.store.load(pageId);
    doc.importBatch([
        ...(stored.snapshot ? [stored.snapshot] : []),
        ...stored.updates,
    ]);
    const base = doc.oplogVersion();

    return {
        doc,
        addBlock(id: string, text: string) {
            const blocks = readBlocks(doc, pageId);
            blocks.push({
                id,
                parent_id: pageId,
                position: '',
                content: text,
                tiptap_content: paragraph(text),
                is_checked: null,
            });
            applyBlocks(doc, blocks);
            doc.commit();
        },
        push(origin: string) {
            return documents.applyUpdates(pageId, [
                {
                    update_id: uuidv7(),
                    origin,
                    bytes: doc.export({ mode: 'update', from: base }),
                },
            ]);
        },
    };
}

describe('document service', () => {
    it('creates a page that owns its document', () => {
        const id = createPage(documents, 'Inbox');

        expect(page(id)).toMatchObject({ title: 'Inbox', kind: 'page' });
        expect(documents.store.latestSeq(id)).toBeGreaterThan(0);
    });

    it('stores and projects an editor update', () => {
        const pageId = createPage(documents, 'Inbox');
        const window = editorWindow(pageId);
        const blockId = uuidv7();
        window.addBlock(blockId, 'hello');
        window.push('window-1');

        expect(block(blockId)).toEqual({
            id: blockId,
            page_id: pageId,
            text: 'hello',
        });
        expect(searchFor('hello')).toEqual([blockId]);
    });

    it('merges concurrent edits from two windows', () => {
        const pageId = createPage(documents, 'Inbox');
        const a = editorWindow(pageId);
        const b = editorWindow(pageId);
        a.addBlock(uuidv7(), 'from a');
        b.addBlock(uuidv7(), 'from b');
        a.push('window-a');
        b.push('window-b');

        expect(
            db
                .all<{ text: string }>(
                    'SELECT text FROM blocks WHERE page_id = ? ORDER BY text',
                    [pageId],
                )
                .map((row) => row.text),
        ).toEqual(['from a', 'from b']);
    });

    it('ignores an update it has already stored', () => {
        const pageId = createPage(documents, 'Inbox');
        const window = editorWindow(pageId);
        window.addBlock(uuidv7(), 'once');
        const update = {
            update_id: uuidv7(),
            origin: 'window-1',
            bytes: window.doc.export({ mode: 'update' }),
        };

        const first = documents.applyUpdates(pageId, [update]);
        const second = documents.applyUpdates(pageId, [update]);

        expect(second).toBe(first);
    });

    it('keeps blocks, links and the search index in step with the document', () => {
        const pageId = createPage(documents, 'Inbox');
        const targetId = createPage(documents, 'Target');
        const [blockId] = setBlocks(documents, pageId, [
            { content: inline('see ', mention(targetId, 'Target')) },
        ]);

        expect(block(blockId)).toMatchObject({ text: 'see [[Target]]' });
        expect(links()).toEqual([
            { source_block_id: blockId, target_id: targetId },
        ]);

        // Retargeting a link that keeps its label changes the link only
        const otherId = createPage(documents, 'Other');
        setBlocks(documents, pageId, [
            {
                id: blockId,
                content: inline('see ', mention(otherId, 'Target')),
            },
        ]);
        expect(links()).toEqual([
            { source_block_id: blockId, target_id: otherId },
        ]);

        setBlocks(documents, pageId, [{ text: 'something else' }]);
        expect(block(blockId)).toBeUndefined();
        expect(links()).toEqual([]);
        expect(searchFor('Target')).toEqual([]);
    });

    it('links a block to a later block on the same page', () => {
        const pageId = createPage(documents, 'Notes');
        const target = uuidv7();
        const [referrer] = setBlocks(documents, pageId, [
            {
                content: inline('see ', {
                    type: 'blockReference',
                    attrs: { targetId: target },
                }),
            },
            { id: target, text: 'Learn' },
        ]);

        expect(block(target)).toMatchObject({ page_id: pageId, text: 'Learn' });
        expect(links()).toEqual([
            { source_block_id: referrer, target_id: target },
        ]);
    });

    it('removes a deleted page with its blocks, links and search entries', () => {
        const targetId = createPage(documents, 'Target');
        const pageId = createPage(documents, 'Inbox', {
            blocks: [
                { text: 'hello', children: [{ text: 'nested hello' }] },
                { content: inline(mention(targetId, 'Target')) },
            ],
        });

        deletePage(documents, pageId);

        expect(page(pageId)).toBeUndefined();
        expect(db.all('SELECT * FROM blocks')).toEqual([]);
        expect(links()).toEqual([]);
        expect(searchFor('hello')).toEqual([]);
    });

    it('lists a page whose blocks arrived before its title', () => {
        const pageId = uuidv7();
        setBlocks(documents, pageId, [{ text: 'early' }]);

        expect(page(pageId)).toMatchObject({ title: '', kind: 'page' });
    });

    it('projects daily notes and media', () => {
        const id = createPage(documents, 'November 15, 2026', {
            meta: { page_type: 'daily_note', daily_note_date: '2026-11-15' },
        });
        documents.edit(MEDIA_DOCUMENT_ID, (doc) =>
            addMedia(doc, {
                id: 'media-1',
                hash: 'a'.repeat(64),
                original_name: 'photo.png',
                mime_type: 'image/png',
                size: 3,
                created_at: '2026-11-15T10:00:00.000Z',
            }),
        );

        expect(page(id)).toMatchObject({
            kind: 'daily',
            daily_date: '2026-11-15',
            created_at: Date.parse('2026-11-15T00:00:00Z'),
        });
        expect(db.get('SELECT * FROM media')).toEqual({
            id: 'media-1',
            hash: 'a'.repeat(64),
            original_name: 'photo.png',
            mime_type: 'image/png',
            size: 3,
            created_at: Date.parse('2026-11-15T10:00:00.000Z'),
        });
    });

    it('moves a block that another page still lists', () => {
        const first = createPage(documents, 'First');
        const second = createPage(documents, 'Second');
        const [moved] = setBlocks(documents, first, [{ text: 'moving' }]);

        // The block shows up on the second page before the first loses it
        setBlocks(documents, second, [{ id: moved, text: 'moving' }]);
        expect(block(moved)).toMatchObject({ page_id: second });

        setBlocks(documents, first, []);
        expect(block(moved)).toMatchObject({ page_id: second });
    });

    it('merges imported blocks into a page, keeping the others', () => {
        const pageId = createPage(documents, 'Notes', {
            blocks: [{ text: 'mine' }],
        });
        const parent = uuidv7();
        const child = uuidv7();

        documents.edit(pageId, (doc) =>
            mergeBlocks(doc, pageId, [
                // A child before its parent
                {
                    id: child,
                    parent_id: parent,
                    position: 'a0',
                    tiptap_content: paragraph('child'),
                    is_checked: true,
                },
                {
                    id: parent,
                    parent_id: pageId,
                    position: 'a1',
                    tiptap_content: paragraph('parent'),
                    is_checked: null,
                },
            ]),
        );

        const blocks = readBlocks(documents.read(pageId), pageId);
        expect(blocks.map((b) => b.content).sort()).toEqual(['mine', 'parent']);
        expect(blocks.find((b) => b.id === parent)!.children).toMatchObject([
            { id: child, content: 'child', is_checked: true },
        ]);
    });

    it('rebuilds the same read model from the stored documents', () => {
        const targetId = createPage(documents, 'Target', {
            blocks: [{ text: 'well then' }],
        });
        const pageId = createPage(documents, 'Inbox', {
            blocks: [
                {
                    content: inline('hello ', mention(targetId, 'Target')),
                    children: [{ text: 'yellow', checked: false }],
                },
            ],
        });
        createPage(documents, 'November 15, 2026', {
            meta: { page_type: 'daily_note', daily_note_date: '2026-11-15' },
        });
        deletePage(documents, createPage(documents, 'Gone'));
        setBlocks(documents, pageId, [{ text: 'shell' }]);
        documents.edit(MEDIA_DOCUMENT_ID, (doc) =>
            addMedia(doc, {
                id: 'media-1',
                hash: 'b'.repeat(64),
                original_name: 'a.pdf',
                mime_type: 'application/pdf',
                size: 10,
                created_at: '2026-11-15T10:00:00.000Z',
            }),
        );
        const projected = readModel();

        documents.rebuildReadModel();

        expect(readModel()).toEqual(projected);
        expect(projected.search.length).toBeGreaterThan(0);
    });

    it('notifies listeners with the documents that changed', () => {
        const seen: string[][] = [];
        documents.onChange((ids) => seen.push(ids));
        const id = createPage(documents, 'Inbox');

        expect(seen).toEqual([[id]]);
    });
});
