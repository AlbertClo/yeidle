import { placeholders } from '../db/database';
import type { Database } from '../db/database';

/**
 * Read helpers for the read model's pages and blocks. Writes never go
 * through here: content changes go through the DocumentService.
 */

/** A page as the read model lists it (and as the frontend receives it). */
export type Page = {
    id: string;
    title: string;
    kind: 'page' | 'daily';
    /** YYYY-MM-DD for daily notes. */
    daily_date: string | null;
    /** Unix ms. */
    created_at: number;
    updated_at: number;
};

export type BlockRow = { id: string; page_id: string; text: string };

export const PAGE_COLUMNS =
    'pages.id, pages.title, pages.kind, pages.daily_date, pages.created_at, pages.updated_at';

export function findPage(db: Database, id: string): Page | null {
    return (
        db.get<Page>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, [id]) ??
        null
    );
}

/** A page by title, ignoring ASCII case (the column's NOCASE collation). */
export function findPageByTitle(
    db: Database,
    title: string,
    exceptId: string | null = null,
): Page | null {
    return (
        db.get<Page>(
            `SELECT ${PAGE_COLUMNS} FROM pages WHERE title = ? AND id IS NOT ? ORDER BY created_at, id LIMIT 1`,
            [title, exceptId],
        ) ?? null
    );
}

/** Pages by id, in the order of `ids`; missing ones are left out. */
export function pagesInOrder(db: Database, ids: string[]): Page[] {
    const found = new Map<string, Page>();

    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);

        for (const page of db.all<Page>(
            `SELECT ${PAGE_COLUMNS} FROM pages WHERE id IN (${placeholders(chunk.length)})`,
            chunk,
        )) {
            found.set(page.id, page);
        }
    }

    return ids.flatMap((id) => {
        const page = found.get(id);

        return page ? [page] : [];
    });
}

/** Every page, most recently changed first. */
export function allPages(db: Database): Page[] {
    return db.all<Page>(
        `SELECT ${PAGE_COLUMNS} FROM pages ORDER BY updated_at DESC, id DESC`,
    );
}

export function findBlock(db: Database, id: string): BlockRow | null {
    return (
        db.get<BlockRow>('SELECT id, page_id, text FROM blocks WHERE id = ?', [
            id,
        ]) ?? null
    );
}
