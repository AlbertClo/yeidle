import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../db/database';
import { openNodeDatabase } from '../db/nodeSqlite';
import { migrate } from '../db/schema';
import { applyBlocks, createDoc, readBlocks } from '../loro/pageDoc';
import { uuidv7 } from '../support/ids';

import { legacyMigrationNeeded, runLegacyMigration } from './legacyMigration';
import { DocumentService } from './service';

let db: Database;
let documents: DocumentService;

beforeEach(() => {
    db = openNodeDatabase(':memory:');
    migrate(db);
    documents = new DocumentService(db);
});

afterEach(() => db.close());

type NodeRow = {
    id: string;
    parent_id: string | null;
    content: string;
    document_id: string | null;
    deleted_at: string | null;
    is_checked: number | null;
};

const node = (id: string) =>
    db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [id]);

function createPage(title: string): string {
    const id = uuidv7();
    documents.applyChanges([
        {
            type: 'node.set',
            payload: { id, page_id: id, fields: { content: title } },
        },
    ]);

    return id;
}

const paragraph = (text: string) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
});

function block(pageId: string, id: string, text: string, position = 'a0') {
    return {
        type: 'node.set' as const,
        payload: {
            id,
            page_id: pageId,
            fields: {
                parent_id: pageId,
                position,
                content: text,
                tiptap_content: paragraph(text),
            },
        },
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
        push(clientId: string) {
            return documents.applyUpdates(pageId, [
                {
                    update_id: uuidv7(),
                    client_id: clientId,
                    bytes: doc.export({ mode: 'update', from: base }),
                },
            ]);
        },
    };
}

describe('document service', () => {
    it('creates a page that owns its document', () => {
        const id = createPage('Inbox');

        expect(node(id)).toMatchObject({
            content: 'Inbox',
            parent_id: null,
            document_id: id,
        });
        expect(documents.store.latestSeq(id)).toBeGreaterThan(0);
    });

    it('stores and projects an editor update', () => {
        const pageId = createPage('Inbox');
        const window = editorWindow(pageId);
        const blockId = uuidv7();
        window.addBlock(blockId, 'hello');
        window.push('window-1');

        expect(node(blockId)).toMatchObject({
            content: 'hello',
            parent_id: pageId,
            document_id: pageId,
        });
    });

    it('merges concurrent edits from two windows', () => {
        const pageId = createPage('Inbox');
        const a = editorWindow(pageId);
        const b = editorWindow(pageId);
        a.addBlock(uuidv7(), 'from a');
        b.addBlock(uuidv7(), 'from b');
        a.push('window-a');
        b.push('window-b');

        const contents = db
            .all<{ content: string }>(
                'SELECT content FROM nodes WHERE parent_id = ? AND deleted_at IS NULL',
                [pageId],
            )
            .map((row) => row.content)
            .sort();
        expect(contents).toEqual(['from a', 'from b']);
    });

    it('ignores an update it has already stored', () => {
        const pageId = createPage('Inbox');
        const window = editorWindow(pageId);
        window.addBlock(uuidv7(), 'once');
        const update = {
            update_id: uuidv7(),
            client_id: 'window-1',
            bytes: window.doc.export({ mode: 'update' }),
        };

        const first = documents.applyUpdates(pageId, [update]);
        const second = documents.applyUpdates(pageId, [update]);

        expect(second).toBe(first);
    });

    it('soft-deletes removed blocks and keeps links in step with content', () => {
        const pageId = createPage('Inbox');
        const targetId = createPage('Target');
        const blockId = uuidv7();
        documents.applyChanges([
            {
                type: 'node.set',
                payload: {
                    id: blockId,
                    page_id: pageId,
                    fields: {
                        parent_id: pageId,
                        content: 'see [[Target]]',
                        tiptap_content: {
                            type: 'paragraph',
                            content: [
                                { type: 'text', text: 'see ' },
                                {
                                    type: 'mention',
                                    attrs: { id: targetId, label: 'Target' },
                                },
                            ],
                        },
                    },
                },
            },
        ]);

        expect(
            db.get(
                'SELECT 1 FROM node_links WHERE source_node_id = ? AND target_node_id = ?',
                [blockId, targetId],
            ),
        ).toBeDefined();

        documents.applyChanges([
            { type: 'node.delete', payload: { id: blockId, page_id: pageId } },
        ]);
        expect(node(blockId)!.deleted_at).not.toBeNull();
    });

    it('finds the real document when page_id names an intermediate ancestor', () => {
        const rootId = createPage('System root');
        const userRoot = uuidv7();
        const entry = uuidv7();
        documents.applyChanges([
            {
                ...block(rootId, userRoot, 'user root'),
                payload: { ...block(rootId, userRoot, '').payload },
            },
        ]);
        // A producer that passes the intermediate node as page_id
        documents.applyChanges([
            {
                type: 'node.set',
                payload: {
                    id: entry,
                    page_id: userRoot,
                    fields: {
                        parent_id: userRoot,
                        position: 'a0',
                        content: 'entry',
                    },
                },
            },
        ]);

        expect(node(entry)).toMatchObject({
            parent_id: userRoot,
            document_id: rootId,
        });
    });

    it('notifies listeners with the documents that changed', () => {
        const seen: string[][] = [];
        documents.onChange((ids) => seen.push(ids));
        const id = createPage('Inbox');

        expect(seen).toEqual([[id]]);
    });

    it('converts a workspace from the op-log engine', () => {
        const pageId = uuidv7();
        const parentId = uuidv7();
        const childId = uuidv7();
        const deletedId = uuidv7();

        for (const [id, parent, position, content, checked, deleted] of [
            [pageId, null, 'a0', 'Legacy page', null, null],
            [parentId, pageId, 'a0', 'parent', null, null],
            [childId, parentId, 'a0', 'child', 1, null],
            [deletedId, pageId, 'a1', 'gone', null, '2026-01-01 00:00:00'],
        ] as const) {
            db.run(
                `INSERT INTO nodes (id, parent_id, position, content, is_checked, deleted_at, modified_hlc, purged)
                 VALUES (?, ?, ?, ?, ?, ?, '', 0)`,
                [id, parent, position, content, checked, deleted],
            );
        }

        expect(legacyMigrationNeeded(db)).toBe(true);
        expect(runLegacyMigration(db, documents)).toBe(1);
        expect(legacyMigrationNeeded(db)).toBe(false);
        expect(node(childId)).toMatchObject({
            document_id: pageId,
            is_checked: 1,
        });
        expect(node(deletedId)!.deleted_at).not.toBeNull();
    });
});
