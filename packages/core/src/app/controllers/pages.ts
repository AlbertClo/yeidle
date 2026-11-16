import { abort, invalid, json } from '../../http/http';
import type { Input } from '../../http/http';
import type { Router } from '../../http/router';
import { readBlocks } from '../../loro/pageDoc';
import type { Block } from '../../loro/pageDoc';
import { updatePageMeta } from '../../loro/pageMeta';
import { uuidv7 } from '../../support/ids';
import type { AppContext } from '../context';
import { allPages, findBlock, findPage, findPageByTitle } from '../pages';
import type { Page } from '../pages';
import { loadBacklinks } from '../services/backlinks';
import { NavigationHistoryStore } from '../services/navigationHistory';
import { search } from '../services/search';

type BlockTree = {
    id: string;
    text: string;
    /** Rich text (TipTap JSON), for clients that render it. */
    content: unknown;
    children: BlockTree[];
};

/** Pages, blocks, search and recent pages. */
export function registerPageRoutes(router: Router, ctx: AppContext): void {
    const boundPage = (id: string): Page =>
        findPage(ctx.db(), id) ?? abort(404);

    router.get('/api/pages', () => json(allPages(ctx.db())));

    // Asks for a page with this title: the existing one (any letter case),
    // or a new one. Create-page flows rely on not getting duplicates.
    router.post('/api/pages', ({ input }) => {
        const title = requiredString(input, 'title');
        const existing = findPageByTitle(ctx.db(), title);

        if (existing) {
            return json(existing, 200);
        }

        const id = uuidv7();
        ctx.documents().edit(
            id,
            (doc) =>
                updatePageMeta(doc, {
                    title,
                    created_at: new Date().toISOString(),
                    deleted: false,
                }),
            'Create page',
        );

        return json(boundPage(id), 201);
    });

    // Advisory duplicate-title check for the rename UI: sync can always merge
    // in same-titled pages from other devices, so the client only warns.
    // Before pages/{page} so "title-exists" isn't captured as a page id.
    router.get('/api/pages/title-exists', ({ input }) => {
        const title = requiredString(input, 'title');
        const except = nullableString(input, 'except');

        return json({
            exists: findPageByTitle(ctx.db(), title, except) !== null,
        });
    });

    router.get('/api/pages/{page}', ({ params }) =>
        json(boundPage(params.page)),
    );

    router.get('/api/pages/{page}/backlinks', ({ params }) =>
        json(loadBacklinks(ctx.db(), boundPage(params.page).id)),
    );

    // A block with its children, for block references and embeds. A page
    // stands in with its title and top-level blocks.
    router.get('/api/blocks/{block}', ({ params }) => {
        const db = ctx.db();
        const block = findBlock(db, params.block);
        const page = block === null ? findPage(db, params.block) : null;

        if (block === null && page === null) {
            abort(404);
        }

        const pageId = block?.page_id ?? page!.id;
        const blocks = readBlocks(ctx.documents().read(pageId), pageId);
        const children =
            block === null
                ? blocks
                : (findSubtree(blocks, block.id)?.children ?? []);

        return json({
            id: block?.id ?? page!.id,
            page_id: pageId,
            text: block?.text ?? page!.title,
            children: children.map(toTree),
        });
    });

    router.get('/api/search', ({ input }) => {
        const q = requiredString(input, 'q');

        if (Array.from(q).length > 200) {
            invalid(
                'q',
                'The q field must not be greater than 200 characters.',
            );
        }

        return json(search(ctx.db(), q));
    });

    router.get('/api/recent-pages', () =>
        json(new NavigationHistoryStore(ctx).recentPages(10)),
    );

    router.post('/api/open-external', ({ input }) => {
        const url = requiredString(input, 'url');

        if (!isUrl(url)) {
            invalid('url', 'The url field must be a valid URL.');
        }

        ctx.host.openExternal(url);

        return json({}, 200);
    });
}

function findSubtree(blocks: Block[], id: string): Block | null {
    for (const block of blocks) {
        if (block.id === id) {
            return block;
        }

        const found = findSubtree(block.children ?? [], id);

        if (found) {
            return found;
        }
    }

    return null;
}

function toTree(block: Block): BlockTree {
    return {
        id: block.id,
        text: block.content,
        content: block.tiptap_content,
        children: (block.children ?? []).map(toTree),
    };
}

// Laravel converts empty strings to null before validation
function isBlank(value: unknown): boolean {
    return value === undefined || value === null || value === '';
}

function requiredString(input: Input, key: string, label = key): string {
    const value = input.raw(key);

    if (isBlank(value)) {
        invalid(key, `The ${label} field is required.`);
    }

    if (typeof value !== 'string') {
        invalid(key, `The ${label} field must be a string.`);
    }

    return value;
}

function nullableString(
    input: Input,
    key: string,
    label = key.replaceAll('_', ' '),
): string | null {
    const value = input.raw(key);

    if (isBlank(value)) {
        return null;
    }

    if (typeof value !== 'string') {
        invalid(key, `The ${label} field must be a string.`);
    }

    return value;
}

function isUrl(value: string): boolean {
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(value)) {
        return false;
    }

    try {
        new URL(value);

        return true;
    } catch {
        return false;
    }
}
