import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Meta } from '../../db/meta';
import {
    createPage,
    deletePage,
    inline,
    mention,
    setBlocks,
} from '../../documents/testing';
import { updatePageMeta } from '../../loro/pageMeta';
import { testContext } from '../testing';

import { loadBacklinks } from './backlinks';
import { CollapsedBlocks } from './collapsedBlocks';
import { Pins } from './pins';
import { Preferences } from './preferences';
import { search } from './search';
import {
    collapsedMap,
    LOCAL_USER_DOCUMENT_ID,
    pinsList,
    preferencesMap,
    UserDocument,
} from './userDocument';

let ctx: ReturnType<typeof testContext>;

beforeEach(() => {
    ctx = testContext();
});

afterEach(() => ctx.cleanup());

function page(title: string, blocks: string[] = []): string {
    return createPage(ctx.documents(), title, {
        blocks: blocks.map((text) => ({ text })),
    });
}

function rename(id: string, title: string): void {
    ctx.documents().edit(id, (doc) => updatePageMeta(doc, { title }));
}

function setUpdatedAt(id: string, updatedAt: number): void {
    ctx.db().run('UPDATE pages SET updated_at = ? WHERE id = ?', [
        updatedAt,
        id,
    ]);
}

const ids = (results: { id: string }[]) => results.map((result) => result.id);

describe('backlink loader', () => {
    it('returns the source page of a linking block once, with its title', () => {
        const target = page('Target page');
        const sourcePage = page('Source page');
        const [, first, second] = setBlocks(ctx.documents(), sourcePage, [
            {
                text: 'Parent block',
                children: [
                    {
                        text: 'Target page',
                        content: inline(mention(target, 'Target page')),
                    },
                    {
                        text: 'Target page',
                        content: inline(mention(target, 'Target page')),
                    },
                ],
            },
        ]);

        const links = ctx
            .db()
            .all<{ source_block_id: string }>(
                'SELECT source_block_id FROM links WHERE target_id = ? ORDER BY source_block_id',
                [target],
            );
        expect(links.map((link) => link.source_block_id)).toEqual(
            [first, second].sort(),
        );

        // One entry per page, carrying the lowest linking block id
        expect(loadBacklinks(ctx.db(), target)).toEqual([
            {
                id: [first, second].sort()[0],
                page_id: sourcePage,
                page_title: 'Source page',
            },
        ]);
    });

    it('orders pages by their latest change and labels untitled ones', () => {
        const target = page('Target');
        const older = page('Older');
        const untitled = page('');

        for (const source of [older, untitled]) {
            setBlocks(ctx.documents(), source, [
                { text: 'Target', content: inline(mention(target, 'Target')) },
            ]);
        }

        setUpdatedAt(older, 1);
        setUpdatedAt(untitled, 2);

        expect(
            loadBacklinks(ctx.db(), target).map((link) => link.page_title),
        ).toEqual(['[untitled]', 'Older']);
    });

    it('drops links when the source block or page goes away', () => {
        const target = page('Target');
        const source = page('Source');
        setBlocks(ctx.documents(), source, [
            { text: 'Target', content: inline(mention(target, 'Target')) },
        ]);
        expect(loadBacklinks(ctx.db(), target)).toHaveLength(1);

        setBlocks(ctx.documents(), source, [{ text: 'No link' }]);
        expect(loadBacklinks(ctx.db(), target)).toEqual([]);

        setBlocks(ctx.documents(), source, [
            { text: 'Target', content: inline(mention(target, 'Target')) },
        ]);
        deletePage(ctx.documents(), source);
        expect(loadBacklinks(ctx.db(), target)).toEqual([]);
        expect(
            ctx.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM links')!.n,
        ).toBe(0);
    });
});

describe('search', () => {
    it('ranks exact pages before blocks and prefix matches', () => {
        const container = page('Container', ['Research']);
        const prefixPage = page('Research Notes');
        const exactPage = page('Research');
        setUpdatedAt(prefixPage, 300);
        setUpdatedAt(container, 200);
        setUpdatedAt(exactPage, 100);

        const results = search(ctx.db(), 'Research');

        expect(results[0]).toEqual({
            kind: 'page',
            id: exactPage,
            page_id: exactPage,
            text: 'Research',
        });
        expect(results[1]).toMatchObject({
            kind: 'block',
            page_id: container,
            text: 'Research',
        });
        expect(results[2].id).toBe(prefixPage);
    });

    it('includes the page id of nested block results', () => {
        const pageId = page('Page');
        const [, match] = setBlocks(ctx.documents(), pageId, [
            {
                text: 'Parent',
                children: [{ text: 'Deep searchable result' }],
            },
        ]);

        const results = search(ctx.db(), 'searchable');

        expect(results[0]).toEqual({
            kind: 'block',
            id: match,
            page_id: pageId,
            text: 'Deep searchable result',
        });
    });

    it('finds long and short typographical errors', () => {
        const research = page('Research Projects');
        const cat = page('Cat');
        const the = page('The');
        const holder = page('Holder', ['Dog', 'Teh']);

        expect(search(ctx.db(), 'Reserch')[0].id).toBe(research);
        expect(search(ctx.db(), 'Cet')[0].id).toBe(cat);
        expect(search(ctx.db(), 'Teh')[0].page_id).toBe(holder);
        expect(ids(search(ctx.db(), 'Teh'))).toContain(the);
        expect(search(ctx.db(), 'Dgo')[0]).toMatchObject({
            kind: 'block',
            page_id: holder,
            text: 'Dog',
        });
    });

    it('matches sequential word prefixes', () => {
        const currentPriority = page('Current Priority');

        expect(search(ctx.db(), 'cur prio')[0].id).toBe(currentPriority);
    });

    it('tracks title and block changes and deleted pages', () => {
        const pageId = page('Original title', ['Original block']);
        expect(
            search(ctx.db(), 'Original')
                .map((r) => r.kind)
                .sort(),
        ).toEqual(['block', 'page']);

        rename(pageId, 'Replacement title');
        setBlocks(ctx.documents(), pageId, [{ text: 'Replacement block' }]);
        expect(search(ctx.db(), 'Original')).toEqual([]);
        expect(search(ctx.db(), 'Replacement')).toHaveLength(2);

        deletePage(ctx.documents(), pageId);
        expect(search(ctx.db(), 'Replacement')).toEqual([]);
    });

    it('finds the same blocks after rebuilding the read model', () => {
        const pageId = page('Page', ['Rebuilt searchable block']);
        const before = search(ctx.db(), 'searchable');

        ctx.documents().rebuildReadModel();

        expect(search(ctx.db(), 'searchable')).toEqual(before);
        expect(before[0].page_id).toBe(pageId);
    });

    it('returns nothing for punctuation-only queries', () => {
        page('Any page', ['Any block']);

        expect(search(ctx.db(), '---')).toEqual([]);
    });
});

describe('user document', () => {
    const signIn = (userId: string) =>
        new Meta(ctx.db()).set('cloud_user_id', userId);

    it('keeps pins, collapsed blocks and preferences in user:local before sign-in', () => {
        const pinned = page('Pinned');
        new Pins(ctx).add(pinned);
        new CollapsedBlocks(ctx).collapse(['block-a']);
        new Preferences(ctx).setTheme('nord');

        expect(new UserDocument(ctx).id()).toBe(LOCAL_USER_DOCUMENT_ID);
        const doc = ctx.documents().read(LOCAL_USER_DOCUMENT_ID);
        expect(pinsList(doc).toArray()).toEqual([pinned]);
        expect(collapsedMap(doc).toJSON()).toEqual({ 'block-a': true });
        expect(preferencesMap(doc).get('theme')).toBe('nord');
        // User documents have no read-model rows
        expect(
            ctx.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM pages')!.n,
        ).toBe(1);
    });

    it('merges user:local into the signed-in user document once', () => {
        const first = page('First');
        const second = page('Second');
        const pins = new Pins(ctx);
        pins.add(first);
        new CollapsedBlocks(ctx).collapse(['local-block']);
        const preferences = new Preferences(ctx);
        preferences.setTheme('nord');
        preferences.setTypography('jetbrains-mono', 14);
        preferences.setWorkspaceStorage('cloud');

        // The cloud user already chose a theme and pinned a page on another device
        ctx.documents().edit('user:42', (doc) => {
            preferencesMap(doc).set('theme', 'dark');
            pinsList(doc).push(second);
        });

        signIn('42');

        expect(new UserDocument(ctx).id()).toBe('user:42');
        expect(pins.listing().map((p) => p.id)).toEqual([second, first]);
        expect(new CollapsedBlocks(ctx).ids()).toEqual(['local-block']);
        expect(preferences.listing()).toEqual({
            theme: 'dark',
            font_family: 'jetbrains-mono',
            font_size: 14,
            // Stays with the device
            workspace_storage: null,
        });

        // user:local is emptied, apart from device-only preferences
        const local = ctx.documents().read(LOCAL_USER_DOCUMENT_ID);
        expect(pinsList(local).toArray()).toEqual([]);
        expect(collapsedMap(local).keys()).toEqual([]);
        expect(preferencesMap(local).toJSON()).toEqual({
            workspace_storage: 'cloud',
        });

        // Merging again changes nothing
        const updates = () =>
            ctx
                .db()
                .get<{ n: number }>(
                    'SELECT COUNT(*) AS n FROM document_updates',
                )!.n;
        const before = updates();
        new UserDocument(ctx).id();
        expect(updates()).toBe(before);
    });

    it('switches to another user document per signed-in user', () => {
        const pinned = page('Pinned');
        signIn('1');
        new Pins(ctx).add(pinned);

        signIn('2');
        expect(new Pins(ctx).listing()).toEqual([]);

        signIn('1');
        expect(new Pins(ctx).listing().map((p) => p.id)).toEqual([pinned]);
    });

    it('lists pins in order, skipping deleted pages, and reorders them', () => {
        const a = page('A');
        const b = page('B');
        const c = page('C');
        const pins = new Pins(ctx);
        pins.add(a);
        pins.add(b);
        pins.add(c);
        pins.add(a);

        expect(pins.listing().map((p) => p.id)).toEqual([a, b, c]);
        expect(pins.reorder([c, a, b])).toBe(true);
        expect(pins.listing().map((p) => p.id)).toEqual([c, a, b]);
        expect(pins.reorder([a, b])).toBe(false);

        deletePage(ctx.documents(), b);
        expect(pins.listing().map((p) => p.id)).toEqual([c, a]);
        expect(pins.isPinned(b)).toBe(true);

        pins.remove(a);
        expect(pins.listing().map((p) => p.id)).toEqual([c]);
    });

    it('expands collapsed blocks independently', () => {
        const collapsed = new CollapsedBlocks(ctx);
        collapsed.collapse(['b', 'a', 'c']);
        collapsed.expand(['b', 'missing']);

        expect(collapsed.ids()).toEqual(['a', 'c']);
    });
});
