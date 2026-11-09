import { placeholders } from '../../db/database';
import type { Database } from '../../db/database';
import { abort, abortIf, invalid, json } from '../../http/http';
import type { Input } from '../../http/http';
import type { Router } from '../../http/router';
import { isUuid, uuidv7 } from '../../support/ids';
import { sqlTimestamp } from '../../support/time';
import type { AppContext } from '../context';
import {
    childrenOf,
    findNode,
    isReachable,
    isSystemNode,
    LIVE_PAGES_SQL,
    serializeNode,
} from '../nodes';
import type { NodeJson, NodeRow } from '../nodes';
import { loadBacklinks } from '../services/backlinks';
import { loadNodeTree } from '../services/nodeTree';
import { searchNodes } from '../services/search';

/** Pages, the node façade, search, recent pages and page visits. */
export function registerPageRoutes(router: Router, ctx: AppContext): void {
    router.get('/api/pages', () =>
        json(
            ctx
                .db()
                .all<NodeRow>(`SELECT * FROM nodes WHERE ${LIVE_PAGES_SQL} ORDER BY modified_hlc DESC, id DESC`)
                .map(serializeNode),
        ),
    );

    // Advisory duplicate-title check for the rename UI: sync can always merge
    // in same-titled pages from other devices, so the client only warns.
    // Before pages/{node} so "title-exists" isn't captured as a node id.
    router.get('/api/pages/title-exists', ({ input }) => {
        const title = requiredString(input, 'title');
        const except = nullableString(input, 'except');
        const row = ctx
            .db()
            .get(
                `SELECT 1 FROM nodes WHERE ${LIVE_PAGES_SQL}${except ? ' AND id != ?' : ''} AND LOWER(content) = ? LIMIT 1`,
                except ? [except, asciiLower(title)] : [asciiLower(title)],
            );

        return json({ exists: row !== undefined });
    });

    router.get('/api/pages/{node}', ({ params }) => {
        const node = boundNode(ctx.db(), params.node);
        abortIf(isSystemNode(ctx.db(), node), 404);

        return json(loadNodeTree(ctx.db(), node.id));
    });

    router.get('/api/pages/{node}/backlinks', ({ params }) => {
        const node = boundNode(ctx.db(), params.node);
        abortIf(isSystemNode(ctx.db(), node), 404);

        return json(loadBacklinks(ctx.db(), node.id));
    });

    router.get('/api/search', ({ input }) => {
        const q = requiredString(input, 'q');

        if (Array.from(q).length > 200) {
            invalid('q', 'The q field must not be greater than 200 characters.');
        }

        return json(searchNodes(ctx.db(), q));
    });

    router.get('/api/recent-pages', () => {
        const db = ctx.db();
        const recentIds = db
            .all<{ node_id: string }>(
                `SELECT node_id, MAX(visited_at) AS last_visit
                FROM page_visits
                GROUP BY node_id
                ORDER BY last_visit DESC
                LIMIT 10`,
            )
            .map((row) => row.node_id);

        if (recentIds.length === 0) {
            return json([]);
        }

        const pages = db
            .all<NodeRow>(
                `SELECT * FROM nodes WHERE id IN (${placeholders(recentIds.length)}) AND deleted_at IS NULL`,
                recentIds,
            )
            .sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id));

        return json(pages.map(serializeNode));
    });

    router.post('/api/page-visits', ({ input }) => {
        const nodeId = requiredString(input, 'node_id', 'node id');

        if (findNode(ctx.db(), nodeId, { withTrashed: true }) === null) {
            invalid('node_id', 'The selected node id is invalid.');
        }

        ctx.db().run('INSERT INTO page_visits (id, node_id, visited_at) VALUES (?, ?, ?)', [
            uuidv7(),
            nodeId,
            sqlTimestamp(),
        ]);

        return json({}, 201);
    });

    router.post('/api/open-external', ({ input }) => {
        const url = requiredString(input, 'url');

        if (!isUrl(url)) {
            invalid('url', 'The url field must be a valid URL.');
        }

        ctx.host.openExternal(url);

        return json({}, 200);
    });

    // Intent-level façade: callers (PageSearch, the wikilink popup, the
    // extension) ask for a node to exist; the change goes through the
    // document service like every other write.
    router.post('/api/nodes', ({ input }) => {
        const db = ctx.db();
        const fields = validateStore(db, input);
        const content = fields.content ?? '';
        const parentId = fields.parent_id ?? null;

        // For top-level pages, return the existing page with the same title
        // instead of creating a duplicate (create-page flows rely on this)
        if (parentId === null && content !== '') {
            const existing = db.get<NodeRow>(
                `SELECT * FROM nodes WHERE ${LIVE_PAGES_SQL} AND LOWER(content) = ? LIMIT 1`,
                [asciiLower(content)],
            );

            if (existing) {
                return json(withChildren(db, existing), 200);
            }
        }

        const id = fields.id ?? uuidv7();
        const wasKnown = findNode(db, id, { withTrashed: true }) !== null;

        ctx.documents().applyChanges([
            {
                type: 'node.set',
                payload: {
                    id,
                    page_id: rootPageId(db, id, parentId),
                    fields: {
                        parent_id: parentId,
                        position: fields.position ?? 'a0',
                        content,
                        tiptap_content: fields.tiptap_content ?? null,
                        is_checked: fields.is_checked ?? null,
                        page_type: fields.page_type ?? null,
                        daily_note_date: fields.daily_note_date ?? null,
                    },
                },
            },
        ]);

        const node = findNode(db, id);

        if (node === null) {
            abort(404);
        }

        return json(withChildren(db, node), wasKnown ? 200 : 201);
    });

    router.get('/api/nodes/{node}/reference', ({ params }) => {
        const db = ctx.db();
        const node = boundNode(db, params.node);
        abortIf(!isReachable(db, node) || isSystemNode(db, node), 404);

        let page = node;

        while (page.parent_id !== null) {
            const parent = findNode(db, page.parent_id);

            if (!parent) {
                break;
            }

            page = parent;
        }

        return json({
            id: node.id,
            content: node.content,
            tiptap_content: serializeNode(node).tiptap_content,
            page_id: page.id,
            children: childrenRecursive(db, node.id, new Set([node.id])),
        });
    });
}

/** Laravel route-model binding: live nodes only. */
function boundNode(db: Database, id: string): NodeRow {
    return findNode(db, id) ?? abort(404);
}

function withChildren(db: Database, node: NodeRow): NodeJson {
    return { ...serializeNode(node), children: childrenOf(db, node.id).map(serializeNode) };
}

// Ancestors guard against parent cycles
function childrenRecursive(db: Database, parentId: string, ancestors: Set<string>): NodeJson[] {
    return childrenOf(db, parentId).map((child) => ({
        ...serializeNode(child),
        children: ancestors.has(child.id)
            ? []
            : childrenRecursive(db, child.id, new Set(ancestors).add(child.id)),
    }));
}

/** The top-level page a node belongs to: itself for pages, else the root of the parent chain. */
function rootPageId(db: Database, id: string, parentId: string | null): string {
    if (parentId === null) {
        return id;
    }

    const visited = new Set<string>();
    let node = findNode(db, parentId, { withTrashed: true });

    while (node && node.parent_id !== null && !visited.has(node.id)) {
        visited.add(node.id);
        node = findNode(db, node.parent_id, { withTrashed: true });
    }

    return node?.id ?? id;
}

type StoreFields = {
    id?: string;
    parent_id?: string;
    position?: string;
    content?: string;
    tiptap_content?: unknown;
    is_checked?: boolean;
    page_type?: string;
    daily_note_date?: string;
};

function validateStore(db: Database, input: Input): StoreFields {
    const fields: StoreFields = {};
    const id = nullableString(input, 'id');

    if (id !== null) {
        if (!isUuid(id)) {
            invalid('id', 'The id field must be a valid UUID.');
        }

        fields.id = id;
    }

    const parentId = input.raw('parent_id');

    if (!isBlank(parentId)) {
        if (typeof parentId !== 'string' || findNode(db, parentId, { withTrashed: true }) === null) {
            invalid('parent_id', 'The selected parent id is invalid.');
        }

        fields.parent_id = parentId;
    }

    for (const key of ['position', 'content'] as const) {
        const value = nullableString(input, key);

        if (value !== null) {
            fields[key] = value;
        }
    }

    if (!isBlank(input.raw('tiptap_content'))) {
        fields.tiptap_content = input.raw('tiptap_content');
    }

    const checked = input.raw('is_checked');

    if (!isBlank(checked)) {
        if (![true, false, 0, 1, '0', '1'].includes(checked as never)) {
            invalid('is_checked', 'The is checked field must be true or false.');
        }

        fields.is_checked = checked === true || checked === 1 || checked === '1';
    }

    const pageType = nullableString(input, 'page_type', 'page type');

    if (pageType !== null) {
        if (pageType !== 'daily_note') {
            invalid('page_type', 'The selected page type is invalid.');
        }

        fields.page_type = pageType;
    }

    const date = nullableString(input, 'daily_note_date', 'daily note date');

    if (date !== null) {
        if (!isDate(date)) {
            invalid('daily_note_date', 'The daily note date field must match the format Y-m-d.');
        }

        fields.daily_note_date = date;
    }

    return fields;
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

function nullableString(input: Input, key: string, label = key.replaceAll('_', ' ')): string | null {
    const value = input.raw(key);

    if (isBlank(value)) {
        return null;
    }

    if (typeof value !== 'string') {
        invalid(key, `The ${label} field must be a string.`);
    }

    return value;
}

function isDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

    if (!match) {
        return false;
    }

    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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

// PHP's strtolower and SQLite's LOWER() only fold ASCII
function asciiLower(value: string): string {
    return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
