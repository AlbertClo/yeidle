import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../../db/schema';
import { uuidv7 } from '../../support/ids';
import { testContext } from '../testing';

import { loadBacklinks } from './backlinks';
import { loadNodeTree } from './nodeTree';
import { searchNodes } from './search';

let ctx: ReturnType<typeof testContext>;

beforeEach(() => {
    ctx = testContext();
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

function setContent(id: string, content: string): void {
    ctx.documents().applyChanges([{ type: 'node.set', payload: { id, page_id: id, fields: { content } } }]);
}

function remove(id: string): void {
    ctx.documents().applyChanges([{ type: 'node.delete', payload: { id, page_id: id } }]);
}

function setModified(id: string, hlc: string): void {
    ctx.db().run('UPDATE nodes SET modified_hlc = ? WHERE id = ?', [hlc, id]);
}

const ids = (results: { id: string }[]) => results.map((result) => result.id);

describe('node tree loader', () => {
    it('loads an ordered nested tree', () => {
        const page = node('Page', null, { id: '00000000-0000-7000-8000-000000000001' });
        const second = '00000000-0000-7000-8000-000000000002';
        const first = '00000000-0000-7000-8000-000000000003';
        // One batch: the engine regenerates stored positions, so later writes
        // would be placed relative to a0, a1, ...
        ctx.documents().applyChanges(
            [
                [second, 'b0'],
                [first, 'a0'],
            ].map(([id, position]) => ({
                type: 'node.set' as const,
                payload: { id, page_id: page, fields: { parent_id: page, position, content: id } },
            })),
        );
        const nested = node('nested', first, { id: '00000000-0000-7000-8000-000000000004' });

        const tree = loadNodeTree(ctx.db(), page);

        expect(tree.children.map((child) => child.id)).toEqual([first, second]);
        expect(tree.children[0].children[0].id).toBe(nested);
        expect(tree.children[0].children[0].children).toHaveLength(0);
        expect(tree.children[0]).not.toHaveProperty('created_at');
        expect(tree.children[0]).not.toHaveProperty('modified_hlc');
    });

    it('omits soft-deleted descendants', () => {
        const page = node('Page');
        const deleted = node('deleted', page);
        node('nested', deleted);
        ctx.documents().applyChanges([{ type: 'node.delete', payload: { id: deleted, page_id: page } }]);

        expect(loadNodeTree(ctx.db(), page).children).toHaveLength(0);
    });

    it('throws for a missing node', () => {
        expect(() => loadNodeTree(ctx.db(), uuidv7())).toThrow(/was not found/);
    });
});

describe('backlink loader', () => {
    it('returns the source page of a linking block once, with its title', () => {
        const target = node('Target page');
        const sourcePage = node('Source page');
        const sourceParent = node('Parent block', sourcePage);
        const mention = {
            type: 'paragraph',
            content: [{ type: 'mention', attrs: { id: target, label: 'Target page' } }],
        };
        const sourceBlock = node('Linked block', sourceParent, { tiptap_content: mention });
        node('Second link', sourceParent, { tiptap_content: mention, position: 'b0' });

        const links = ctx
            .db()
            .all<{ id: string; source_node_id: string }>(
                'SELECT id, source_node_id FROM node_links WHERE target_node_id = ? ORDER BY id',
                [target],
            );
        expect(links).toHaveLength(2);
        expect(links.map((link) => link.source_node_id)).toContain(sourceBlock);

        // One entry per page, carrying the lowest link id
        expect(loadBacklinks(ctx.db(), target)).toEqual([
            { id: links[0].id, page_id: sourcePage, page_title: 'Source page' },
        ]);
    });
});

describe('node search', () => {
    it('ranks exact pages before blocks and prefix matches', () => {
        const container = node('Container');
        const prefixPage = node('Research Notes');
        const exactBlock = node('Research', container);
        const exactPage = node('Research');
        setModified(prefixPage, '000000000000300-0000-a');
        setModified(exactBlock, '000000000000200-0000-a');
        setModified(exactPage, '000000000000100-0000-a');

        const results = searchNodes(ctx.db(), 'Research');

        expect(results[0].id).toBe(exactPage);
        expect(results[0].page_id).toBe(exactPage);
        expect(results[1].id).toBe(exactBlock);
        expect(results[1].page_id).toBe(container);
        expect(results[2].id).toBe(prefixPage);
    });

    it('includes the root page id of block results', () => {
        const page = node('Page');
        const parent = node('Parent', page);
        const match = node('Deep searchable result', parent);

        const results = searchNodes(ctx.db(), 'searchable');

        expect(results[0].id).toBe(match);
        expect(results[0].page_id).toBe(page);
    });

    it('finds long and short typographical errors', () => {
        const research = node('Research Projects');
        const cat = node('Cat');
        const the = node('The');

        expect(searchNodes(ctx.db(), 'Reserch')[0].id).toBe(research);
        expect(searchNodes(ctx.db(), 'Cet')[0].id).toBe(cat);
        expect(searchNodes(ctx.db(), 'Teh')[0].id).toBe(the);
    });

    it('matches sequential word prefixes', () => {
        const currentPriority = node('Current Priority');

        expect(searchNodes(ctx.db(), 'cur prio')[0].id).toBe(currentPriority);
    });

    it('tracks content updates, deletes and restores', () => {
        const page = node('Original title');
        expect(ids(searchNodes(ctx.db(), 'Original'))).toEqual([page]);

        setContent(page, 'Replacement title');
        expect(searchNodes(ctx.db(), 'Original')).toEqual([]);
        expect(ids(searchNodes(ctx.db(), 'Replacement'))).toEqual([page]);

        remove(page);
        expect(searchNodes(ctx.db(), 'Replacement')).toEqual([]);

        setContent(page, 'Replacement title');
        expect(ids(searchNodes(ctx.db(), 'Replacement'))).toEqual([page]);
    });

    it('backfills the index when migrating a database without one', () => {
        const db = ctx.db();
        db.exec(`
            DROP TRIGGER nodes_search_after_insert;
            DROP TRIGGER nodes_search_after_update;
            DROP TRIGGER nodes_search_after_delete;
            DROP TABLE node_search;
            PRAGMA user_version = 0;
        `);
        // A row written by the NativePHP app before the index existed
        const page = uuidv7();
        db.run(
            "INSERT INTO nodes (id, parent_id, position, content, modified_hlc) VALUES (?, NULL, 'a0', ?, '000000000000100-0000-a')",
            [page, 'Pre-existing searchable page'],
        );

        migrate(db);

        expect(searchNodes(db, 'existing')[0].id).toBe(page);
    });

    it('excludes matches inside deleted subtrees', () => {
        const page = node('Deleted page');
        node('Hidden searchable phrase', page);
        remove(page);

        expect(searchNodes(ctx.db(), 'searchable')).toEqual([]);
    });

    it('returns nothing for punctuation-only queries', () => {
        node('Any page');

        expect(searchNodes(ctx.db(), '---')).toEqual([]);
    });
});
